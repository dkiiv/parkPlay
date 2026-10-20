#!/usr/bin/env node
// Render the car UI headless at the car's viewport and screenshot it (run ON the host).
//   node tools/ui-shot.js /tmp/ui.png [width height]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));
const [out = '/tmp/ui.png', W = '1888', H = '1022'] = process.argv.slice(2);
const WEB = path.join(__dirname, '..', 'web');
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const f = path.join(WEB, p === '/' ? 'index.html' : p);
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'application/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.svg') ? 'image/svg+xml' : 'text/html' }); res.end(d); });
}).listen(8098, '127.0.0.1', async () => {
  const prof = fs.mkdtempSync('/tmp/uishot-');
  const ch = spawn('google-chrome-stable', ['--headless=new', '--no-sandbox', `--user-data-dir=${prof}`, '--remote-debugging-port=9334', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  const page = (await (await fetch('http://127.0.0.1:9334/json/list')).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.on('message', (m) => { const o = JSON.parse(m); if (pend.has(o.id)) { pend.get(o.id)(o.result); pend.delete(o.id); } });
  await new Promise((r) => ws.once('open', r));
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await cdp('Emulation.setDeviceMetricsOverride', { width: Number(W), height: Number(H), deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:8098/' });
  await new Promise((r) => setTimeout(r, 2000));
  const geo = await cdp('Runtime.evaluate', { returnByValue: true, expression: `[...document.querySelectorAll('#bar button')].map(b=>{const s=b.querySelector('svg');const bb=b.getBoundingClientRect(),sb=s?s.getBoundingClientRect():null;return {id:b.id,btn:[bb.x|0,bb.y|0,bb.width|0,bb.height|0],svg:sb?[sb.x|0,sb.y|0,sb.width|0,sb.height|0]:null,inside:sb?(sb.left>=bb.left&&sb.right<=bb.right&&sb.top>=bb.top&&sb.bottom<=bb.bottom):null}})` });
  console.log(JSON.stringify(geo.result.value));
  const shot = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: Number(W), height: 120, scale: 1 } });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  ch.kill('SIGKILL'); srv.close();
  setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} process.exit(0); }, 500);
});
