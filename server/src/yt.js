'use strict';
// YouTube data via yt-dlp: feeds, search, channel lists, and stream-URL resolution.
// Cookies come from the kiosk Chrome profile (signed in once via /signin) or an uploaded
// cookies.txt, so Home / Subscriptions / History / Watch later are the user's own.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PREFETCH_CONCURRENCY = 4; // each yt-dlp resolve uses ~0.7 core for ~3 s; sized for a 4-6 vCPU host

const FEEDS = {
  home: ':ytrec',
  subs: ':ytsubs',
  history: ':ythistory',
  later: ':ytwatchlater',
  liked: 'https://www.youtube.com/playlist?list=LL',
};

class YT {
  constructor({ ytdlp = 'yt-dlp', stateDir, chrome, log }) {
    this.ytdlp = ytdlp;
    this.chrome = chrome;
    this.log = log;
    this.cookieFile = path.join(stateDir, 'cookies.txt');
    this.uploadedFile = path.join(stateDir, 'cookies.uploaded.txt');
    this.listCache = new Map(); // key -> {at, data}
    this.resolveCache = new Map(); // id -> {at, data}
    this.inflight = new Map();
    this.signedIn = false;
  }

  run(args, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      execFile(this.ytdlp, ['--no-warnings', '--ignore-config', ...args], { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, env: { ...process.env, HOME: process.env.HOME || '/var/lib/parkplay' } },
        (err, stdout, stderr) => {
          if (err) return reject(new Error((stderr || err.message).toString().split('\n').filter(Boolean).slice(-2).join(' | ')));
          try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('yt-dlp: bad JSON')); }
        });
    });
  }

  // ---- cookies ----
  async exportCookies() {
    // Prefer the live Chrome profile (the user signed in there via /signin).
    if (this.chrome && this.chrome.connected) {
      try {
        const { cookies } = await this.chrome.send('Storage.getCookies', {});
        const mine = cookies.filter((c) => /(^|\.)(youtube|google)\.com$/.test(c.domain.replace(/^\./, '')) || /youtube\.com|google\.com/.test(c.domain));
        const has = mine.some((c) => /^(SAPISID|__Secure-3PAPISID)$/.test(c.name) && c.domain.includes('youtube.com'));
        if (has) {
          const lines = ['# Netscape HTTP Cookie File'];
          for (const c of mine) {
            const dom = c.domain;
            lines.push([dom, dom.startsWith('.') ? 'TRUE' : 'FALSE', c.path, c.secure ? 'TRUE' : 'FALSE',
              c.expires > 0 ? Math.floor(c.expires) : 0, c.name, c.value].join('\t'));
          }
          fs.writeFileSync(this.cookieFile, lines.join('\n') + '\n', { mode: 0o600 });
          this.signedIn = true;
          return this.cookieFile;
        }
      } catch (e) { this.log('cookie export: ' + e.message); }
    }
    if (fs.existsSync(this.uploadedFile)) { this.signedIn = true; return this.uploadedFile; }
    // Chrome not reachable (restarting, or a test process): reuse the last export if it still has
    // a YouTube session. signOut() deletes it, so this never resurrects a signed-out account.
    try {
      if (/youtube\.com\t[^\n]*\t(SAPISID|__Secure-3PAPISID)\t/.test(fs.readFileSync(this.cookieFile, 'utf8'))) { this.signedIn = true; return this.cookieFile; }
    } catch { /* no export yet */ }
    this.signedIn = false;
    return null;
  }

  async cookieArgs() {
    const f = await this.exportCookies();
    return f ? ['--cookies', f] : [];
  }

  saveUploadedCookies(text) {
    if (!/\t/.test(text) || !/youtube\.com/.test(text)) throw new Error('not a Netscape cookies.txt with youtube.com cookies');
    fs.writeFileSync(this.uploadedFile, text, { mode: 0o600 });
    this.listCache.clear();
  }

  async signOut() {
    try { fs.unlinkSync(this.uploadedFile); } catch { /* none */ }
    try { fs.unlinkSync(this.cookieFile); } catch { /* none */ }
    if (this.chrome && this.chrome.connected) await this.chrome.send('Storage.clearCookies', {}).catch(() => {});
    this.listCache.clear();
    this.signedIn = false;
  }

  // ---- lists ----
  static mapEntry(e) {
    if (!e || !e.id || e.id.length !== 11) return null; // skip channels/playlists/shorts shelves
    const live = e.live_status === 'is_live' || e.live_status === 'is_upcoming' || (e.duration == null && /live/i.test(e.title || ''));
    return {
      id: e.id,
      title: e.title || '',
      channel: e.channel || e.uploader || '',
      channelUrl: e.channel_url || e.uploader_url || (e.channel_id ? `https://www.youtube.com/channel/${e.channel_id}` : ''),
      duration: e.duration || null,
      views: e.view_count || null,
      live,
      thumb: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
    };
  }

  // fresh: skip the cache. For feeds (home etc.) also hide videos already shown in earlier
  // pages, so "refresh" gives genuinely new suggestions when YouTube returns overlapping ones.
  async list(kind, q = '', limit = 36, { fresh = false } = {}) {
    let target;
    if (kind === 'search') { if (!q.trim()) return []; target = `ytsearch${limit}:${q.trim()}`; }
    else if (kind === 'channel') {
      if (!/^https:\/\/(www\.)?youtube\.com\//.test(q)) throw new Error('bad channel url');
      target = q.replace(/\/+$/, '').replace(/\/(videos|featured|streams|shorts)$/, '') + '/videos';
    } else if (FEEDS[kind]) target = FEEDS[kind];
    else throw new Error('unknown feed');
    const ck = await this.cookieArgs();
    if (FEEDS[kind] && !ck.length) return { needsSignIn: true, items: [] };
    const key = `${kind}|${q}|${ck.length}`;
    const ttl = kind === 'search' ? 30 * 60e3 : 5 * 60e3;
    const hit = this.listCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < ttl) return hit.data;
    if (!fresh && this.inflight.has(key)) return this.inflight.get(key);
    this.seen = this.seen || new Map(); // feed key -> Set of ids already shown
    const seen = this.seen.get(key) || new Set();
    const want = fresh && FEEDS[kind] ? limit * 2 : limit; // over-fetch so filtering still leaves a full page
    const p = this.run([...ck, '--flat-playlist', '-J', '--playlist-end', String(want), target])
      .then((d) => {
        let items = (d.entries || []).map(YT.mapEntry).filter(Boolean);
        if (fresh && FEEDS[kind]) {
          const unseen = items.filter((v) => !seen.has(v.id));
          // prefer unseen; top up with seen ones only if YouTube returned too few new ones
          items = unseen.length >= 12 ? unseen.slice(0, limit) : [...unseen, ...items.filter((v) => seen.has(v.id))].slice(0, limit);
        } else items = items.slice(0, limit);
        if (FEEDS[kind]) { for (const v of items) seen.add(v.id); if (seen.size > 2000) seen.clear(); this.seen.set(key, seen); }
        const data = { items, title: d.title || '' };
        this.listCache.set(key, { at: Date.now(), data });
        return data;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  // ---- resolve one video to direct stream URLs (H.264 video-only + AAC audio-only, progressive https) ----
  async resolve(id, { force = false } = {}) {
    if (!/^[\w-]{11}$/.test(id)) throw new Error('bad id');
    const hit = this.resolveCache.get(id);
    if (!force && hit && Date.now() - hit.at < 3 * 3600e3) return hit.data;
    const key = 'r|' + id;
    if (!force && this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      const ck = await this.cookieArgs();
      // skip=hls,translated_subs: we only use https DASH formats; saves ~0.4 s per resolve
      const d = await this.run([...ck, '-J', '--skip-download', '--extractor-args', 'youtube:skip=hls,translated_subs', `https://www.youtube.com/watch?v=${id}`], 60000);
      if (d.is_live) throw new Error('live streams are not supported yet');
      const ok = (f) => f.protocol === 'https' && f.url && f.filesize;
      const video = d.formats.filter((f) => ok(f) && /^avc1/.test(f.vcodec || '') && (f.acodec === 'none' || !f.acodec))
        .map((f) => ({ itag: f.format_id, height: f.height, fps: f.fps, size: f.filesize, codec: f.vcodec, url: f.url, headers: f.http_headers || {} }))
        .sort((a, b) => a.height - b.height || a.size - b.size);
      const audio = d.formats.filter((f) => ok(f) && f.ext === 'm4a' && f.vcodec === 'none' && /^mp4a/.test(f.acodec || '') && !/drc/.test(f.format_id))
        .map((f) => ({ itag: f.format_id, size: f.filesize, codec: f.acodec, abr: f.abr, lang: f.language || null,
          // YouTube auto-dubs share the itag (140-0, 140-1, ...) at near-identical bitrates; the original track
          // has language_preference 10 / "original" in format_note, dubs are -1. Prefer original, then bitrate.
          pref: (f.language_preference || 0) + (/original/i.test(f.format_note || '') ? 100 : 0),
          url: f.url, headers: f.http_headers || {} }))
        .sort((a, b) => (b.pref - a.pref) || ((b.abr || 0) - (a.abr || 0)));
      if (!video.length || !audio.length) throw new Error('no H.264/AAC formats for this video');
      const data = {
        id, title: d.title, channel: d.channel || d.uploader, channelUrl: d.channel_url || d.uploader_url,
        duration: d.duration, views: d.view_count, description: (d.description || '').slice(0, 2000),
        video, audio,
      };
      this.resolveCache.set(id, { at: Date.now(), data });
      return data;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  // Background resolve of what the user is about to tap, so a tap skips the ~3 s yt-dlp resolve.
  // Called with each feed's first items and with the cards the car reports as on screen. Newest
  // call wins (replaces the queue); PREFETCH_CONCURRENCY yt-dlp processes at a time (~2 CPU-s
  // each). `warm(d)` runs for the first `nWarm` ids of a call to pull their first media chunk,
  // hiding googlevideo's slow first byte.
  prefetch(items, n = 6, warm = null, nWarm = 2) {
    const ids = (items || []).map((v) => (typeof v === 'string' ? { id: v } : v))
      .filter((v) => v && v.id && !v.live && /^[\w-]{11}$/.test(v.id)).slice(0, n).map((v) => v.id);
    this.prefetchQueue = ids.map((id, i) => ({ id, warm: i < nWarm ? warm : null }));
    this.prefetchWorkers = this.prefetchWorkers || 0;
    while (this.prefetchWorkers < PREFETCH_CONCURRENCY && this.prefetchQueue.length) {
      this.prefetchWorkers++;
      (async () => {
        while (this.prefetchQueue.length) {
          const { id, warm: w } = this.prefetchQueue.shift();
          const hit = this.resolveCache.get(id);
          const fresh = hit && Date.now() - hit.at < 2 * 3600e3;
          if (fresh && !w) continue;
          try { const d = await this.resolve(id); if (w) w(d); } catch (e) { /* surfaced when the user actually taps it */ }
        }
      })().finally(() => { this.prefetchWorkers--; });
    }
  }

  // A real tap: stop starting background work so the tapped video gets the CPU and bandwidth.
  // In-flight resolves finish (and the tap joins its own if it was already running).
  cancelPrefetch() { this.prefetchQueue = []; }

  async format(id, itag) {
    const d = await this.resolve(id);
    return [...d.video, ...d.audio].find((f) => f.itag === itag) || null;
  }

  static publicMeta(d) {
    const strip = ({ url, headers, ...rest }) => rest;
    return { ...d, video: d.video.map(strip), audio: d.audio.map(strip) };
  }
}

module.exports = { YT };
