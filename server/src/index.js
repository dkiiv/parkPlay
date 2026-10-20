'use strict';
// teslatv server. Two listeners:
//   APP    (TV_PORT, 127.0.0.1:8090)        reached ONLY via cloudflared -> Cloudflare Access.
//          Every request must carry a valid Access JWT. Serves the UI, /ws/ctl, /api/ticket, /probe.
//   STREAM (TV_STREAM_PORT, 127.0.0.1:8091) reached via Caddy on the direct (non-Cloudflare)
//          stream hostname. Only /ws/video and /audio.mp3, gated by a short-lived HMAC ticket
//          that the APP side hands out after Access auth. Video never touches Cloudflare.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const WebSocket = require('ws');
const { AccessAuth } = require('./access');
const { Streamer } = require('./stream');
const { Chrome } = require('./cdp');

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

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
};

function sendFile(res, rel) {
  const file = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': rel.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
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

    if (p === '/' || p === '/index.html') return sendFile(res, '/index.html');
    if (p === '/api/ticket') {
      return json(res, 200, { ticket: auth.issueTicket(who), stream: `wss://${cfg.streamHost}`, audio: `https://${cfg.streamHost}`, ttl: auth.ticketTtlS, user: who });
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
  if (p !== '/ws/ctl' || !(await auth.verify(req))) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
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

const stream = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/healthz') return json(res, 200, { ok: true });
  if (p === '/audio.mp3' && streamAllowed(req)) return streamer.audioStream(res);
  res.writeHead(403); res.end();
});

const wssVideo = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
stream.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p !== '/ws/video' || !streamAllowed(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  wssVideo.handleUpgrade(req, socket, head, (ws) => wssVideo.emit('connection', ws, req));
});

wssVideo.on('connection', (ws) => {
  log(`video viewer connected (${streamer.clients.size + 1})`);
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
stream.listen(cfg.streamPort, cfg.listen, () => log(`stream (ticket) listening on ${cfg.listen}:${cfg.streamPort} for ${cfg.streamHost}`));
process.on('SIGTERM', () => { streamer.stop(); process.exit(0); });
