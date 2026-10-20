#!/usr/bin/env node
// End-to-end smoke test against a running TeslaTV server (run ON the host).
//   node tools/smoke.js <password> [baseUrl]
// Logs in, opens /ws/ctl + /ws/video, sends a tap + a search, saves 6 s of stream to
// /tmp/teslatv-smoke.ts, and prints byte rate. Verify with ffprobe afterwards.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));

const [pw, base = 'http://127.0.0.1:8090'] = process.argv.slice(2);
if (!pw) { console.error('usage: smoke.js <password> [baseUrl]'); process.exit(1); }

function login() {
  return new Promise((resolve, reject) => {
    const body = 'password=' + encodeURIComponent(pw);
    const u = new URL('/login', base);
    const req = http.request(u, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length } }, (res) => {
      const c = (res.headers['set-cookie'] || [])[0];
      if (res.statusCode === 303 && c && res.headers.location === '/') resolve(c.split(';')[0]);
      else reject(new Error('login failed: ' + res.statusCode + ' ' + res.headers.location));
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  const cookie = await login();
  console.log('login ok');
  const wsBase = base.replace(/^http/, 'ws');
  const ctl = new WebSocket(wsBase + '/ws/ctl', { headers: { Cookie: cookie } });
  const msgs = [];
  ctl.on('message', (m) => { const o = JSON.parse(m); msgs.push(o); if (o.t !== 'pong') console.log('ctl <-', JSON.stringify(o).slice(0, 160)); });
  await new Promise((r, j) => { ctl.once('open', r); ctl.once('error', j); });

  const out = fs.createWriteStream('/tmp/teslatv-smoke.ts');
  let bytes = 0;
  const video = new WebSocket(wsBase + '/ws/video', { headers: { Cookie: cookie } });
  video.on('message', (d) => { bytes += d.length; out.write(d); });
  await new Promise((r, j) => { video.once('open', r); video.once('error', j); });
  console.log('video ws open');

  const t0 = Date.now();
  const target = process.env.SMOKE_URL || 'lofi hip hop';
  ctl.send(JSON.stringify({ t: 'nav', a: 'go', url: target }));
  await new Promise((r) => setTimeout(r, Number(process.env.SMOKE_WAIT_MS || 2500)));
  ctl.send(JSON.stringify({ t: 'touch', a: 'down', x: 960, y: 600 }));
  ctl.send(JSON.stringify({ t: 'touch', a: 'move', x: 960, y: 400 }));
  ctl.send(JSON.stringify({ t: 'touch', a: 'up', x: 960, y: 400 }));
  ctl.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
  await new Promise((r) => setTimeout(r, 3500));
  const secs = (Date.now() - t0) / 1000;
  console.log(`video bytes=${bytes} (${(bytes * 8 / secs / 1000).toFixed(0)} kbit/s over ${secs.toFixed(1)}s)`);
  console.log('ts packet aligned:', bytes % 188 === 0);
  video.close(); ctl.close(); out.end();
  setTimeout(() => process.exit(bytes > 0 ? 0 : 2), 300);
})().catch((e) => { console.error(e.message); process.exit(1); });
