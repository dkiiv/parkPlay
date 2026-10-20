#!/usr/bin/env node
// Headless client test (run ON the host as root/teslatv): serves web/ on 127.0.0.1:8099 with a
// stub /api/ticket (signed with the real TV_SECRET) and a stub /ws/ctl, opens it in a separate
// headless Chrome, clicks Start, and reports decoded fps, kbit/s and the jitter-buffer delay.
// The real stream listener (:8091) is used, so this exercises framing + buffering end to end.
//   sudo -u teslatv env $(cat /etc/teslatv/teslatv.env | xargs) node tools/client-test.js [secs]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));
const { AccessAuth } = require(path.join(__dirname, '..', 'server', 'src', 'access.js'));

const SECS = Number(process.argv[2] || 20);
const WEB = path.join(__dirname, '..', 'web');
const auth = new AccessAuth({ teamDomain: 'x.invalid', aud: 'x', secret: process.env.TV_SECRET });
const PORT = 8099;

const srv = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/api/ticket') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ticket: auth.issueTicket('test'), stream: `ws://127.0.0.1:${PORT}`, ttl: 3600 }));
  }
  const f = path.join(WEB, p === '/' ? 'index.html' : p);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'application/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(d); });
});
const wss = new WebSocket.Server({ noServer: true });
const wssVid = new WebSocket.Server({ noServer: true });
srv.on('upgrade', (req, sock, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/ws/ctl') return wss.handleUpgrade(req, sock, head, (w) => wss.emit('connection', w));
  if (p === '/ws/video') return wssVid.handleUpgrade(req, sock, head, (w) => wssVid.emit('connection', w, req));
  sock.destroy();
});
// Proxy the video WS to the real stream listener with the production Origin (the stream
// listener rejects any other Origin by design).
wssVid.on('connection', (client, req) => {
  const up = new WebSocket('ws://127.0.0.1:8091' + req.url, { headers: { Origin: `https://${process.env.TV_PUBLIC_HOST}` } });
  // BURST_MS>0 simulates LTE: hold messages and release them in clumps every BURST_MS ms
  const BURST = Number(process.env.BURST_MS || 0);
  let held = [];
  if (BURST) setInterval(() => { for (const d of held) if (client.readyState === 1) client.send(d, { binary: true }); held = []; }, BURST);
  up.on('message', (d) => { if (BURST) held.push(d); else if (client.readyState === 1) client.send(d, { binary: true }); });
  up.on('close', () => client.close());
  up.on('error', (e) => { console.log('upstream error', e.message); client.close(); });
  client.on('close', () => up.close());
});
const stats = [];
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'hello', screen: { w: 1920, h: 1200 }, preset: 'med', url: '' }));
  ws.on('message', (m) => { const o = JSON.parse(m); if (o.t === 'stats') stats.push(o); if (o.t === 'ping') ws.send(JSON.stringify({ t: 'pong', ts: o.ts })); });
});

srv.listen(PORT, '127.0.0.1', async () => {
  const prof = fs.mkdtempSync('/tmp/tvtest-');
  const chrome = spawn('google-chrome-stable', ['--headless=new', '--no-sandbox', `--user-data-dir=${prof}`, '--remote-debugging-port=9333',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.on('message', (m) => { const o = JSON.parse(m); if (pend.has(o.id)) { pend.get(o.id)(o.result); pend.delete(o.id); } });
  await new Promise((r) => ws.once('open', r));
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await new Promise((r) => setTimeout(r, 2000));
  console.log('icons rendered as svg:', await ev(`document.querySelectorAll('#bar button svg use').length`));
  await ev(`document.getElementById('b-start').click(), true`);
  const samples = [];
  let lastF = 0;
  for (let i = 0; i < SECS / 2; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const f = await ev(`(window.__tvFrames||0)`);
    samples.push(+((f - lastF) / 2).toFixed(1)); lastF = f;
  }
  console.log('fps per 2s window:', JSON.stringify(samples.slice(2)));
  // stats are posted every 10 s by the client
  console.log('client stats:', JSON.stringify(stats));
  chrome.kill('SIGKILL');
  setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* chrome still exiting */ } process.exit(stats.some((s) => s.fps > 5) ? 0 : 2); }, 500);
});
