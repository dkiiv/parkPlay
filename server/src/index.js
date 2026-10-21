'use strict';
// teslatv server. Two listeners:
//   APP    (TV_PORT, 127.0.0.1:8090)        reached ONLY via cloudflared -> Cloudflare Access.
//          Every request must carry a valid Access JWT. Serves the UI, /ws/ctl, /api/ticket, /probe.
//   STREAM (TV_STREAM_PORT, 127.0.0.1:8091) reached via Caddy on the direct (non-Cloudflare)
//          stream hostname. Only /ws/video and /audio.mp3, gated by a short-lived HMAC ticket
//          that the APP side hands out after Access auth. Video never touches Cloudflare.
const fs = require('fs');
// Outbound (googlevideo, YouTube): many hosts without a working IPv6 route still get AAAA
// answers, and Node's happy-eyeballs gives each address only 250 ms, so a slow-but-fine IPv4
// connect to a googlevideo edge fails with ETIMEDOUT. Prefer IPv4 and give each attempt 2 s.
require('dns').setDefaultResultOrder(process.env.TV_DNS_ORDER || 'ipv4first');
require('net').setDefaultAutoSelectFamilyAttemptTimeout(Number(process.env.TV_CONNECT_ATTEMPT_MS || 2000));
const path = require('path');
const http = require('http');
const { URL } = require('url');
const WebSocket = require('ws');
const { AccessAuth } = require('./access');
const { Streamer } = require('./stream');
const { Chrome } = require('./cdp');
const { YT } = require('./yt');
const { Media } = require('./media');

const env = process.env;
const cfg = {
  listen: env.TV_LISTEN || '127.0.0.1',
  port: Number(env.TV_PORT || 8090),
  streamPort: Number(env.TV_STREAM_PORT || 8091),
  publicHost: env.TV_PUBLIC_HOST || '',       // e.g. tv.example.com (behind Access)
  streamHost: env.TV_STREAM_HOST || '',       // e.g. tv-stream.example.com (direct)
  display: env.TV_DISPLAY || ':99',
  screenW: Number(env.TV_SCREEN_W || 1920),
  screenH: Number(env.TV_SCREEN_H || 1200),
  cdpPort: Number(env.TV_CDP_PORT || 9222),
  scale: Number(env.TV_SCALE || 1.25),
  homeUrl: env.TV_HOME_URL || 'https://www.youtube.com/',
  pulseServer: env.TV_PULSE_SERVER || 'unix:/run/teslatv/pulse/native',
  pulseSource: env.TV_PULSE_SOURCE || 'tv.monitor',
  ffmpeg: env.TV_FFMPEG || 'ffmpeg',
  preset: env.TV_PRESET || 'med',
  idleStopMs: Number(env.TV_IDLE_STOP_MS || 30000),
  probeDir: env.TV_PROBE_DIR || '/var/lib/teslatv/probe',
};
if (!cfg.publicHost || !cfg.streamHost) throw new Error('TV_PUBLIC_HOST and TV_STREAM_HOST are required');
const WEB = path.resolve(__dirname, '..', '..', 'web');

const log = (m) => console.log(new Date().toISOString(), m);
const auth = new AccessAuth({
  teamDomain: env.TV_ACCESS_TEAM, aud: env.TV_ACCESS_AUD, secret: env.TV_SECRET,
  ticketTtlS: Number(env.TV_TICKET_TTL_S || 12 * 3600), log,
});
auth.refreshKeys().catch((e) => log('access key fetch failed (will retry): ' + e.message));
const streamer = new Streamer(cfg, log);
const chrome = new Chrome({ port: cfg.cdpPort, homeUrl: cfg.homeUrl, log });
chrome.connect();
const yt = new YT({ ytdlp: env.TV_YTDLP || 'yt-dlp', stateDir: env.TV_STATE_DIR || '/var/lib/teslatv', chrome, log });
const media = new Media({ yt, cacheDir: path.join(env.TV_STATE_DIR || '/var/lib/teslatv', 'media'), maxBytes: Number(env.TV_CACHE_GB || 6) * 1e9, log });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
};

// Asset versioning: index.html is served with ?v=<content hash> on every local asset so the
// Cloudflare edge (UI host is proxied) and the car's cache can never serve a stale app.js/css.
const crypto = require('crypto');
function assetVersion() {
  const h = crypto.createHash('sha1');
  for (const f of ['app.js', 'player.js', 'fmp4.js', 'signin.js', 'style.css', 'vendor/jsmpeg.min.js']) {
    try { h.update(fs.readFileSync(path.join(WEB, f))); } catch { /* missing */ }
  }
  return h.digest('hex').slice(0, 10);
}
function sendIndex(res, file = 'index.html') {
  const v = assetVersion();
  let html = fs.readFileSync(path.join(WEB, file), 'utf8');
  html = html.replace(/(href|src)="\/([\w/.-]+\.(?:js|css|svg|webmanifest))"/g, `$1="/$2?v=${v}"`);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', 'CDN-Cache-Control': 'no-store' });
  res.end(html);
}

function sendFile(res, rel) {
  const file = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      // Versioned URLs make long caching safe for assets; everything else is never cached.
      'Cache-Control': 'no-store, max-age=0',
      'CDN-Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(d));
  });
}

// Pull the first `chunks` MiB of the formats the player will most likely pick (<=720p H.264, best
// AAC) into the server cache. Same choice as player.js chooseFormats() with default options.
function warmMedia(d, chunks) {
  const v30 = d.video.filter((f) => f.height <= 720 && (f.fps || 30) <= 31);
  const v = v30.pop() || d.video.filter((f) => f.height <= 720).pop() || d.video[0];
  media.readAhead(d.id, v.itag, 0, v.size, chunks);
  media.readAhead(d.id, d.audio[0].itag, 0, d.audio[0].size, chunks);
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ======================= APP listener (behind Cloudflare Access) =======================
const app = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/healthz') return json(res, 200, { ok: true, chrome: chrome.connected });

    const who = await auth.verify(req);
    if (!who) return json(res, 403, { error: 'Cloudflare Access login required' });

    if (p === '/' || p === '/index.html') return sendIndex(res);
    if (p === '/signin') return sendIndex(res, 'signin.html');

    // ---- YouTube data (local UI) ----
    if (p === '/api/feed') {
      const kind = u.searchParams.get('kind') || 'home';
      try { const d = await yt.list(kind, u.searchParams.get('q') || '', 36, { fresh: u.searchParams.get('fresh') === '1' }); yt.prefetch(d.items, 6, (m) => warmMedia(m, 1)); return json(res, 200, d); }
      catch (e) { log(`feed ${kind}: ${e.message}`); return json(res, 502, { error: e.message }); }
    }
    if (p.startsWith('/api/video/')) {
      const id = p.slice('/api/video/'.length);
      yt.cancelPrefetch();
      try {
        const d = await yt.resolve(id);
        // warm the server cache so the first bytes are local by the time the car asks
        warmMedia(d, 8);
        return json(res, 200, YT.publicMeta(d));
      } catch (e) { log(`resolve ${id}: ${e.message}`); return json(res, 502, { error: e.message }); }
    }
    if (p === '/api/prefetch' && req.method === 'POST') { // ids of the cards currently on the car's screen
      let ids = [];
      try { ids = JSON.parse(await readBody(req, 4096)).ids || []; } catch { /* ignore */ }
      yt.prefetch(ids.slice(0, 8), 8, (m) => warmMedia(m, 1), 8); // warm all on-screen cards: ~2 MiB server-side download each, no car/VPS traffic
      res.writeHead(204); return res.end();
    }
    if (p === '/api/account') { await yt.exportCookies(); return json(res, 200, { signedIn: yt.signedIn, user: who }); }
    if (p === '/api/account/cookies' && req.method === 'POST') {
      try { yt.saveUploadedCookies(await readBody(req, 2 * 1024 * 1024)); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/account/signout' && req.method === 'POST') { await yt.signOut(); return json(res, 200, { ok: true }); }
    if (p === '/api/stats' && req.method === 'POST') {
      log('player stats: ' + (await readBody(req, 4096)).replace(/\s+/g, ' ').slice(0, 400));
      res.writeHead(204); return res.end();
    }
    if (p === '/api/ticket') {
      return json(res, 200, { ticket: auth.issueTicket(who), stream: `wss://${cfg.streamHost}`, audio: `https://${cfg.streamHost}`, ttl: auth.ticketTtlS, user: who });
    }
    if (p === '/api/clientlog' && req.method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      log('CLIENT ERROR (' + who + '): ' + body.replace(/\s+/g, ' ').slice(0, 600));
      res.writeHead(204); return res.end();
    }
    if (p === '/api/status') return json(res, 200, { user: who, chrome: chrome.status(), stream: streamer.status() });

    if (p === '/probe' || p === '/probe/') return sendFile(res, '/probe.html');
    if (['/probe-clip.ts', '/probe-clip.mp4', '/probe-tone.mp3'].includes(p)) return sendFile(res, '/generated' + p);
    if (p === '/probe/report' && req.method === 'POST') {
      const body = await readBody(req, 256 * 1024);
      let data;
      try { data = JSON.parse(body); } catch { return json(res, 400, { ok: false }); }
      data.receivedAt = new Date().toISOString();
      data.user = who;
      data.headers = { 'user-agent': req.headers['user-agent'] || '' };
      fs.mkdirSync(cfg.probeDir, { recursive: true });
      const name = `${data.receivedAt.replace(/[:.]/g, '-')}-${String(data.label || 'x').replace(/\W/g, '').slice(0, 20)}.json`;
      fs.writeFileSync(path.join(cfg.probeDir, name), JSON.stringify(data, null, 2));
      log('probe report saved: ' + name);
      return json(res, 200, { ok: true, saved: name });
    }
    if (p === '/api/probes') {
      const files = fs.existsSync(cfg.probeDir) ? fs.readdirSync(cfg.probeDir).sort().reverse().slice(0, 20) : [];
      return json(res, 200, files.map((f) => JSON.parse(fs.readFileSync(path.join(cfg.probeDir, f)))));
    }
    return sendFile(res, p);
  } catch (e) {
    log('http error: ' + e.stack);
    if (!res.headersSent) json(res, 500, { error: 'internal' });
  }
});

const wssCtl = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
app.on('upgrade', async (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  const who = p === '/ws/ctl' ? await auth.verify(req) : null;
  if (!who) { log(`ctl upgrade rejected path=${p} jwt=${!!auth.tokenFrom(req)}`); socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  log('ctl connected: ' + who);
  wssCtl.handleUpgrade(req, socket, head, (ws) => wssCtl.emit('connection', ws, req));
});

// ======================= STREAM listener (direct, ticket-gated) =======================
function streamAllowed(req) {
  const u = new URL(req.url, 'http://x');
  // Origin check (browsers always send it on WebSocket/CORS); ticket is the real gate.
  const origin = req.headers.origin;
  if (origin && origin !== `https://${cfg.publicHost}`) return false;
  return auth.checkTicket(u.searchParams.get('t'));
}

async function serveMedia(req, res, p) {
  res.setHeader('Access-Control-Allow-Origin', `https://${cfg.publicHost}`);
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!streamAllowed(req)) { res.writeHead(403); return res.end(); }
  const [, , id, itag] = p.split('/');
  const f = await yt.format(id, itag).catch(() => null);
  if (!f) { res.writeHead(404); return res.end(); }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = m ? Number(m[1]) : 0;
  // open-ended ranges (the <audio> element) get 2 MiB at a time so playback starts fast
  const end = m && m[2] ? Number(m[2]) : start + 2 * 1024 * 1024 - 1;
  if (start >= f.size) { res.writeHead(416, { 'Content-Range': `bytes */${f.size}` }); return res.end(); }
  const { buf, size } = await media.read(id, itag, start, end);
  res.writeHead(206, {
    'Content-Type': /^mp4a/.test(f.codec || '') ? 'audio/mp4' : 'video/mp4',
    'Content-Range': `bytes ${start}-${start + buf.length - 1}/${size}`,
    'Content-Length': buf.length, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600',
  });
  res.end(buf);
}

const stream = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/healthz') return json(res, 200, { ok: true });
  if (p.startsWith('/media/')) {
    try { return await serveMedia(req, res, p); }
    catch (e) { log(`media ${p}: ${e.message}${e.cause ? ' (' + (e.cause.code || e.cause.message) + ')' : ''}`); if (!res.headersSent) res.writeHead(502); return res.end(); }
  }
  if (p === '/audio.mp3' && streamAllowed(req)) return streamer.audioStream(res);
  res.writeHead(403); res.end();
});

const wssVideo = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
stream.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p !== '/ws/video' || !streamAllowed(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  wssVideo.handleUpgrade(req, socket, head, (ws) => wssVideo.emit('connection', ws, req));
});

wssVideo.on('connection', (ws, req) => {
  const codec = new URL(req.url, 'http://x').searchParams.get('c');
  if (streamer.clients.size === 0) streamer.setCodec(codec);
  log(`video viewer connected (${streamer.clients.size + 1}) codec=${streamer.codec}`);
  streamer.addClient(ws);
  ws.on('close', () => log('video viewer left'));
});

// ======================= control channel =======================
const ctlClients = new Set();
function broadcastCtl(obj) {
  const s = JSON.stringify(obj);
  for (const c of ctlClients) if (c.readyState === WebSocket.OPEN) c.send(s);
}
chrome.on('status', (st) => broadcastCtl({ t: 'page', ...st }));
streamer.onRestart = () => broadcastCtl({ t: 'stream-restart', preset: streamer.preset });

// Keyboard auto-show: after a tap, check whether an editable element got focus.
async function checkFocus(ws) {
  try {
    const v = await chrome.editableFocused();
    ws.send(JSON.stringify({ t: 'focus', editable: v === true || v === 'frame' }));
  } catch { /* page navigating */ }
}

wssCtl.on('connection', (ws) => {
  ctlClients.add(ws);
  ws.send(JSON.stringify({ t: 'hello', screen: { w: cfg.screenW, h: cfg.screenH }, preset: streamer.preset, ...chrome.status() }));
  ws.on('close', () => ctlClients.delete(ws));
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try {
      switch (m.t) {
        case 'touch':
          await chrome.touch(m.a, clampX(m.x), clampY(m.y));
          if (m.a === 'up') setTimeout(() => checkFocus(ws), 250);
          break;
        case 'mouse':
          await chrome.mouse(m.a, clampX(m.x), clampY(m.y));
          if (m.a === 'up') setTimeout(() => checkFocus(ws), 250);
          break;
        case 'wheel': await chrome.wheel(clampX(m.x), clampY(m.y), Number(m.dx) || 0, Number(m.dy) || 0); break;
        case 'text': await chrome.text(m.s); break;
        case 'key': await chrome.key(m.k); break;
        case 'nav': await chrome.nav(m.a, m.url); break;
        case 'preset': if (streamer.setPreset(m.p)) broadcastCtl({ t: 'preset', preset: streamer.preset }); break;
        case 'ping': ws.send(JSON.stringify({ t: 'pong', ts: m.ts })); break;
        case 'hello': log('client hello ' + JSON.stringify(m).slice(0, 400)); break;
        case 'stats': log(`client stats fps=${m.fps} kbps=${m.kbps} bufferMs=${m.delay} queued=${m.queued}`); break;
      }
    } catch (e) {
      if (!/no active page|not connected/.test(e.message)) log(`ctl ${m.t} error: ${e.message}`);
    }
  });
});

// Client sends screen pixels; CDP Input.* wants CSS pixels (screen px / device scale factor).
const clampX = (x) => Math.max(0, Math.min(cfg.screenW - 1, Number(x) || 0)) / cfg.scale;
const clampY = (y) => Math.max(0, Math.min(cfg.screenH - 1, Number(y) || 0)) / cfg.scale;

// keep idle WebSockets alive through NAT/LTE middleboxes
setInterval(() => {
  for (const wss of [wssVideo, wssCtl]) for (const ws of wss.clients) { if (ws.readyState === WebSocket.OPEN) ws.ping(); }
}, 20000);

app.listen(cfg.port, cfg.listen, () => log(`app (Access) listening on ${cfg.listen}:${cfg.port} for ${cfg.publicHost}`));
// cloudflared's ingress says "localhost", which it may dial as [::1] first: listen there too.
if (cfg.listen === '127.0.0.1') {
  const app6 = http.createServer((q, r) => app.emit('request', q, r));
  app6.on('upgrade', (q, so, h) => app.emit('upgrade', q, so, h));
  app6.on('error', (e) => log('app [::1] listener: ' + e.message));
  app6.listen(cfg.port, '::1');
}
stream.listen(cfg.streamPort, cfg.listen, () => log(`stream (ticket) listening on ${cfg.listen}:${cfg.streamPort} for ${cfg.streamHost}`));
process.on('SIGTERM', () => { streamer.stop(); process.exit(0); });
