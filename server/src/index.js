'use strict';
// teslatv server: login, static web client, /ws/video (MPEG-TS), /ws/ctl (input + status),
// /audio.mp3 (fallback audio), /probe (browser capability report).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const WebSocket = require('ws');
const { Auth } = require('./auth');
const { Streamer } = require('./stream');
const { Chrome } = require('./cdp');

const env = process.env;
const cfg = {
  listen: env.TV_LISTEN || '127.0.0.1',
  port: Number(env.TV_PORT || 8090),
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
  secureCookie: env.TV_SECURE_COOKIE !== '0',
};
const WEB = path.resolve(__dirname, '..', '..', 'web');

const log = (m) => console.log(new Date().toISOString(), m);
const auth = new Auth({ secret: env.TV_SECRET, passwordHash: env.TV_PASSWORD_HASH });
const streamer = new Streamer(cfg, log);
const chrome = new Chrome({ port: cfg.cdpPort, homeUrl: cfg.homeUrl, log });
chrome.connect();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const PUBLIC = new Set(['/login.html', '/style.css', '/favicon.svg', '/manifest.webmanifest']);

function sendFile(res, rel) {
  const file = path.join(WEB, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }
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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/healthz') return json(res, 200, { ok: true, chrome: chrome.connected });

    if (p === '/login' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      const r = auth.login(body.get('password') || '');
      if (r.ok) {
        res.writeHead(303, { 'Set-Cookie': auth.cookieHeader(auth.issue(), cfg.secureCookie), Location: '/' });
        return res.end();
      }
      res.writeHead(303, { Location: '/login.html?e=' + (r.locked ? 'locked' : 'bad') });
      return res.end();
    }
    if (p === '/logout') {
      res.writeHead(303, { 'Set-Cookie': auth.clearCookieHeader(), Location: '/login.html' });
      return res.end();
    }
    if (PUBLIC.has(p)) return sendFile(res, p);

    // Capability probe is public on purpose: it holds no data and must work before login.
    if (p === '/probe' || p === '/probe/') return sendFile(res, '/probe.html');
    if (p === '/probe.js') return sendFile(res, '/probe.js');
    if (['/probe-clip.ts', '/probe-clip.mp4', '/probe-tone.mp3'].includes(p)) return sendFile(res, '/generated' + p);
    if (p === '/probe/report' && req.method === 'POST') {
      const body = await readBody(req, 256 * 1024);
      let data;
      try { data = JSON.parse(body); } catch { return json(res, 400, { ok: false }); }
      data.receivedAt = new Date().toISOString();
      data.headers = { 'user-agent': req.headers['user-agent'] || '' };
      fs.mkdirSync(cfg.probeDir, { recursive: true });
      const name = `${data.receivedAt.replace(/[:.]/g, '-')}-${String(data.label || 'x').replace(/\W/g, '').slice(0, 20)}.json`;
      fs.writeFileSync(path.join(cfg.probeDir, name), JSON.stringify(data, null, 2));
      log('probe report saved: ' + name);
      return json(res, 200, { ok: true, saved: name });
    }
    if (p.startsWith('/vendor/jsmpeg')) return sendFile(res, p); // probe needs it pre-login

    if (!auth.check(req)) {
      if (p === '/' || p.endsWith('.html')) { res.writeHead(303, { Location: '/login.html' }); return res.end(); }
      return json(res, 401, { error: 'login required' });
    }

    if (p === '/' || p === '/index.html') return sendFile(res, '/index.html');
    if (p === '/audio.mp3') return streamer.audioStream(res);
    if (p === '/api/status') return json(res, 200, { chrome: chrome.status(), stream: streamer.status() });
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

// ---- WebSockets ----
const wssVideo = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
const wssCtl = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (!auth.check(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  if (p === '/ws/video') return wssVideo.handleUpgrade(req, socket, head, (ws) => wssVideo.emit('connection', ws, req));
  if (p === '/ws/ctl') return wssCtl.handleUpgrade(req, socket, head, (ws) => wssCtl.emit('connection', ws, req));
  socket.destroy();
});

wssVideo.on('connection', (ws) => {
  log(`video viewer connected (${streamer.clients.size + 1})`);
  streamer.addClient(ws);
  ws.on('close', () => log('video viewer left'));
});

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

server.listen(cfg.port, cfg.listen, () => log(`teslatv listening on ${cfg.listen}:${cfg.port} screen=${cfg.screenW}x${cfg.screenH}`));
process.on('SIGTERM', () => { streamer.stop(); process.exit(0); });
