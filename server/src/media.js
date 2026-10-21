'use strict';
// Byte-range proxy in front of googlevideo with a chunked disk cache and server-side read-ahead.
// googlevideo URLs are bound to the IP that resolved them, so the car can't fetch them directly;
// the server fetches in 1 MiB-aligned chunks (fast, never throttled) and keeps them on disk, so
// seeks and re-watches are instant and the car's preloading always hits warm cache.
const fs = require('fs');
const path = require('path');

const CHUNK = 1 << 20;            // 1 MiB cache granularity
const GROUP = 4;                  // chunks per upstream request
const READ_AHEAD = 48;            // chunks the server keeps fetched ahead of the car (~48 MiB)
const UPSTREAM_TIMEOUT_MS = 8000; // per attempt, until response headers only (the body read is not bounded).
                                  // A video's first range on a googlevideo edge routinely takes 2-4 s.
const UPSTREAM_TRIES = 4;

class Media {
  constructor({ yt, cacheDir, maxBytes = 4 * 1024 ** 3, log }) {
    this.yt = yt;
    this.dir = cacheDir;
    this.maxBytes = maxBytes;
    this.log = log;
    this.inflight = new Map();     // chunk-group key -> promise
    this.ahead = new Map();        // id/itag -> { want, running }
    fs.mkdirSync(this.dir, { recursive: true });
    this.prune();
    setInterval(() => this.prune(), 30 * 60e3).unref();
  }

  cdir(id, itag) { return path.join(this.dir, id, itag); }
  cfile(id, itag, ci) { return path.join(this.cdir(id, itag), String(ci)); }
  has(id, itag, ci) { return fs.existsSync(this.cfile(id, itag, ci)); }

  async upstream(id, itag, start, end, retry = true) {
    const f = await this.yt.format(id, itag);
    if (!f) throw new Error('unknown format');
    // Bound each attempt and retry: an occasional googlevideo edge stalls the connect, and a fresh
    // attempt almost always connects in <1 s (see the IPv4/attempt-timeout note in index.js).
    let r;
    for (let attempt = 1; ; attempt++) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new Error('connect timeout')), UPSTREAM_TIMEOUT_MS);
        const t0 = Date.now();
        try { r = await fetch(f.url, { headers: { ...f.headers, Range: `bytes=${start}-${end}` }, signal: ac.signal }); }
        finally { clearTimeout(timer); }
        if (process.env.TV_MEDIA_DEBUG) this.log(`media: upstream ${id}/${itag} ${new URL(f.url).host.split('.')[0]} ${start}-${end} headers ${Date.now() - t0} ms (inflight ${this.inflight.size})`);
        break;
      } catch (e) {
        if (attempt >= UPSTREAM_TRIES) throw e;
        this.log(`media: upstream ${id}/${itag} ${new URL(f.url).host.split('.')[0]} attempt ${attempt} failed (${(e.cause && e.cause.code) || e.message}, inflight ${this.inflight.size}), retrying`);
        await new Promise((ok) => setTimeout(ok, 200 * attempt));
      }
    }
    if ((r.status === 403 || r.status === 410) && retry) {
      this.log(`media: upstream ${r.status} for ${id}/${itag}, re-resolving`);
      await this.yt.resolve(id, { force: true });
      return this.upstream(id, itag, start, end, false);
    }
    if (r.status !== 206 && r.status !== 200) throw new Error('upstream HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }

  // Ensure chunks [c0..c1] exist on disk (fetching missing ones in groups).
  async ensure(id, itag, c0, c1, size) {
    const missing = [];
    for (let c = c0; c <= c1; c++) if (!this.has(id, itag, c)) missing.push(c);
    if (!missing.length) return;
    fs.mkdirSync(this.cdir(id, itag), { recursive: true });
    const groups = [];
    for (const c of missing) {
      const g = groups[groups.length - 1];
      if (g && c === g[1] + 1 && c - g[0] < GROUP) g[1] = c; else groups.push([c, c]);
    }
    await Promise.all(groups.map(([a, b]) => {
      const key = `${id}/${itag}/${a}-${b}`;
      if (this.inflight.has(key)) return this.inflight.get(key);
      const p = (async () => {
        const s = a * CHUNK;
        const e = Math.min((b + 1) * CHUNK, size) - 1;
        const buf = await this.upstream(id, itag, s, e);
        for (let c = a; c <= b; c++) {
          const part = buf.subarray((c - a) * CHUNK, Math.min((c - a + 1) * CHUNK, buf.length));
          const tmp = this.cfile(id, itag, c) + '.tmp';
          fs.writeFileSync(tmp, part);
          fs.renameSync(tmp, this.cfile(id, itag, c));
        }
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
      return p;
    }));
  }

  async read(id, itag, start, end) {
    const f = await this.yt.format(id, itag);
    if (!f) throw new Error('unknown format');
    const size = f.size;
    if (start >= size) return { buf: Buffer.alloc(0), size };
    end = Math.min(end, size - 1, start + 16 * CHUNK - 1);
    const c0 = Math.floor(start / CHUNK);
    const c1 = Math.floor(end / CHUNK);
    await this.ensure(id, itag, c0, c1, size);
    const parts = [];
    for (let c = c0; c <= c1; c++) parts.push(fs.readFileSync(this.cfile(id, itag, c)));
    const all = Buffer.concat(parts);
    const off = start - c0 * CHUNK;
    this.readAhead(id, itag, c1 + 1, size);
    this.touch(id);
    return { buf: all.subarray(off, off + (end - start + 1)), size };
  }

  // Keep READ_AHEAD chunks fetched past the furthest point the car has asked for.
  readAhead(id, itag, fromChunk, size, count = READ_AHEAD) {
    const key = `${id}/${itag}`;
    const last = Math.ceil(size / CHUNK) - 1;
    const st = this.ahead.get(key) || { want: 0, next: fromChunk, running: false };
    st.want = Math.min(last, Math.max(st.want, fromChunk + count - 1));
    st.next = Math.min(st.next, fromChunk);
    this.ahead.set(key, st);
    if (st.running) return;
    st.running = true;
    (async () => {
      try {
        while (st.next <= st.want) {
          const a = st.next;
          const b = Math.min(st.want, a + GROUP - 1);
          await this.ensure(id, itag, a, b, size);
          st.next = b + 1;
        }
      } catch (e) { this.log(`media read-ahead ${key}: ${e.message}${e.cause ? ' (' + (e.cause.code || e.cause.message) + ')' : ''}`); }
      finally { st.running = false; }
    })();
  }

  warm(id, itag, size) { if (size) this.readAhead(id, itag, 0, size, 8); }

  touch(id) { const d = path.join(this.dir, id); const t = new Date(); try { fs.utimesSync(d, t, t); } catch { /* gone */ } }

  prune() {
    try {
      const vids = fs.readdirSync(this.dir).map((id) => {
        const d = path.join(this.dir, id);
        let bytes = 0;
        for (const itag of fs.readdirSync(d)) for (const c of fs.readdirSync(path.join(d, itag))) bytes += fs.statSync(path.join(d, itag, c)).size;
        return { id, d, bytes, mtime: fs.statSync(d).mtimeMs };
      }).sort((a, b) => a.mtime - b.mtime);
      let total = vids.reduce((s, v) => s + v.bytes, 0);
      for (const v of vids) {
        if (total <= this.maxBytes) break;
        fs.rmSync(v.d, { recursive: true, force: true });
        total -= v.bytes;
        this.log(`media cache: evicted ${v.id} (${(v.bytes / 1e6).toFixed(0)} MB)`);
      }
    } catch (e) { this.log('media prune: ' + e.message); }
  }
}

module.exports = { Media, CHUNK };
