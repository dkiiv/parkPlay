#!/usr/bin/env node
// End-to-end test of the split deployment (run anywhere with node + ws):
//   CF_ID=.. CF_SECRET=.. node tools/e2e-access.js tv.example.com
// Uses a Cloudflare Access service token for the UI host, gets a stream ticket,
// then checks: ctl WS via Access, video WS with bad origin (403), no ticket (403), real (bytes).
'use strict';
const https = require('https');
const WebSocket = require(process.env.WS_PATH || 'ws');
const host = process.argv[2];
const H = { 'CF-Access-Client-Id': process.env.CF_ID, 'CF-Access-Client-Secret': process.env.CF_SECRET };

function get(path) {
  return new Promise((res, rej) => https.get({ host, path, headers: H }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ status: r.statusCode, body: d, cookie: r.headers['set-cookie'] }));
  }).on('error', rej));
}
function wsTry(url, headers, ms = 4000) {
  return new Promise((res) => {
    let bytes = 0; let msgs = [];
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_q, r) => res({ ok: false, status: r.statusCode }));
    ws.on('error', (e) => res({ ok: false, err: e.message }));
    ws.on('message', (d) => { bytes += d.length; if (msgs.length < 2) msgs.push(String(d).slice(0, 80)); });
    ws.on('open', () => setTimeout(() => { ws.close(); res({ ok: true, bytes, msgs }); }, ms));
  });
}
(async () => {
  const t = await get('/api/ticket');
  console.log('ticket', t.status);
  const tk = JSON.parse(t.body);
  const ctl = await wsTry(`wss://${host}/ws/ctl`, H, 1500);
  console.log('ctl via Access:', ctl.ok, ctl.status || '', (ctl.msgs || [])[0] || '');
  const ctlNo = await wsTry(`wss://${host}/ws/ctl`, {}, 500);
  console.log('ctl without Access:', ctlNo.ok, ctlNo.status || ctlNo.err || '');
  const origin = `https://${host}`;
  const v = (q, o) => wsTry(`${tk.stream}/ws/video${q}`, o ? { Origin: o } : {}, 5000);
  const r1 = await v('', origin); console.log('video no ticket:', r1.ok, r1.status || '');
  const r2 = await v(`?t=${encodeURIComponent(tk.ticket)}`, 'https://evil.example'); console.log('video bad origin:', r2.ok, r2.status || '');
  const r3 = await v(`?t=${encodeURIComponent(tk.ticket)}`, origin);
  console.log('video real:', r3.ok, `${r3.bytes} bytes in 5s (${Math.round(r3.bytes * 8 / 5 / 1000)} kbit/s)`, 'aligned', r3.bytes % 188 === 0);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
