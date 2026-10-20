#!/usr/bin/env node
// Evaluate a JS expression in the kiosk's active page (debug helper, run ON the host).
//   node tools/cdp-eval.js "document.title"
'use strict';
const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));
const port = process.env.TV_CDP_PORT || 9222;
const expr = process.argv[2] || 'document.title';
http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
  let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
    const page = JSON.parse(d).find((t) => t.type === 'page');
    if (!page) { console.error('no page'); process.exit(1); }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })));
    ws.on('message', (m) => { const o = JSON.parse(m); if (o.id === 1) { console.log(JSON.stringify(o.result.result.value !== undefined ? o.result.result.value : o.result)); process.exit(0); } });
  });
}).on('error', (e) => { console.error(e.message); process.exit(1); });
