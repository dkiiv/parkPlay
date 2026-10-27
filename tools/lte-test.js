#!/usr/bin/env node
// Bad-LTE playback test, run ON the host. Serves the player through a throttling proxy that
// follows a bandwidth schedule (shared across all requests, like one LTE link) plus per-request
// latency, then plays a video in headless Chrome and reports stalls, time spent stalled, and how
// many bytes were sent twice (re-downloads of data the player already had).
//   sudo bash -c 'set -a; . /etc/parkplay/parkplay.env; set +a; node tools/lte-test.js [videoId]'
//   env: PHASES="10000:25,300:90,10000:45" (kbit/s:seconds, ...), RTT_MS=300, MAXH=720,
//        WEB=<dir with player.js/fmp4.js> (compare an old player), START=30.
// PASS bar: no bytes re-sent more than 3%, the player keeps making progress (fetched bytes grow)
// during the slow phase, and it recovers to 'playing' after the slow phase.
'use strict';
require('dns').setDefaultResultOrder('ipv4first'); require('net').setDefaultAutoSelectFamilyAttemptTimeout(2000);
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const S = (f) => require(path.join(__dirname, '..', 'server', 'src', f));
const { YT } = S('yt.js'); const { AccessAuth } = S('access.js');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));
const auth = new AccessAuth({ teamDomain: process.env.TV_ACCESS_TEAM, aud: process.env.TV_ACCESS_AUD, secret: process.env.TV_SECRET });
const ID = process.argv[2] || 'dQw4w9WgXcQ';
const ORIGIN = `https://${process.env.TV_PUBLIC_HOST}`;
const WEB = process.env.WEB || path.join(__dirname, '..', 'web');
const PHASES = (process.env.PHASES || '10000:25,300:90,10000:45').split(',').map((x) => { const [k, s] = x.split(':').map(Number); return { kbps: k, sec: s }; });
const RTT = Number(process.env.RTT_MS || 300);
const MAXH = Number(process.env.MAXH || 720);
const START = Number(process.env.START || 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- one shared link: token bucket refilled at the current phase's rate ----
let t0 = 0;
const phaseAt = (t) => { let a = 0; for (const p of PHASES) { if (t < a + p.sec) return p; a += p.sec; } return PHASES[PHASES.length - 1]; };
const queue = []; // { buf, res, off }
let tokens = 0, lastRefill = Date.now();
const served = new Map(); // itag -> sorted, merged [start, end) byte intervals already sent
// bytes of [a, b) already covered, then add it (exact byte ranges: block granularity over-counts
// neighbouring requests that share a block)
function cover(iv, a, b) {
  let dup = 0;
  for (const [s, e] of iv) { if (e <= a) continue; if (s >= b) break; dup += Math.min(b, e) - Math.max(a, s); }
  iv.push([a, b]); iv.sort((p, q) => p[0] - q[0]);
  const m = [];
  for (const r of iv) { if (m.length && r[0] <= m[m.length - 1][1]) m[m.length - 1][1] = Math.max(m[m.length - 1][1], r[1]); else m.push(r); }
  iv.length = 0; iv.push(...m);
  return dup;
}
let sentBytes = 0, dupBytes = 0;
setInterval(() => {
  const now = Date.now(); const p = phaseAt((now - t0) / 1000);
  tokens = Math.min(tokens + p.kbps * 125 * (now - lastRefill) / 1000, p.kbps * 125 * 0.2); lastRefill = now;
  // round-robin 4 KiB slices across open responses (HTTP/2-like sharing of one TCP link)
  let progressed = true;
  while (tokens >= 4096 && queue.length && progressed) {
    progressed = false;
    for (let i = 0; i < queue.length && tokens >= 4096; i++) {
      const q = queue[i];
      if (q.res.destroyed) { queue.splice(i--, 1); continue; }
      const n = Math.min(4096, q.buf.length - q.off);
      const dd = cover(q.cov, q.start + q.off, q.start + q.off + n); dupBytes += dd; q.dup = (q.dup || 0) + dd;
      q.res.write(q.buf.subarray(q.off, q.off + n)); q.off += n; tokens -= n; sentBytes += n; progressed = true;
      if (q.off >= q.buf.length) { q.res.end(); queue.splice(i--, 1); if (process.env.DUPLOG && q.dup) console.log(`  dup ${((Date.now() - t0) / 1000).toFixed(0)}s itag ${q.itag} @${q.start} len ${q.buf.length} dup ${q.dup}`); }
    }
  }
}, 10);

(async () => {
  const yt = new YT({ stateDir: '/var/lib/parkplay', log: () => {} });
  const tk = auth.issueTicket('test');
  const meta = await yt.resolve(ID);
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/meta') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(YT.publicMeta(meta))); }
    if (p.startsWith('/media/')) {
      const itag = p.split('/')[3];
      const q = http.request({ host: '127.0.0.1', port: 8091, path: req.url, headers: { Range: req.headers.range || '', Origin: ORIGIN } }, (up) => {
        const parts = []; up.on('data', (d) => parts.push(d)); up.on('end', async () => {
          await sleep(RTT);
          if (res.destroyed) return;
          res.writeHead(up.statusCode, { 'Content-Type': 'application/octet-stream', 'Content-Range': up.headers['content-range'] || '' });
          const start = Number(((req.headers.range || '').match(/bytes=(\d+)/) || [0, 0])[1]);
          if (!served.has(itag)) served.set(itag, []);
          queue.push({ buf: Buffer.concat(parts), res, off: 0, start, cov: served.get(itag), itag });
        });
      });
      q.on('error', () => { res.writeHead(502); res.end(); }); return q.end();
    }
    if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<canvas id=c></canvas><script src=/fmp4.js></script><script src=/player.js></script>'); }
    fs.readFile(path.join(WEB, p), (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(d); });
  }).listen(8098, '127.0.0.1');
  // warm the server cache so the test measures the car link, not googlevideo
  const v = meta.video.filter((f) => f.height <= MAXH).sort((a, b) => b.height - a.height)[0];
  for (const f of [v, meta.audio[0]]) {
    await fetch(`http://127.0.0.1:8091/media/${ID}/${f.itag}?t=${encodeURIComponent(tk)}`, { headers: { Range: `bytes=0-${Math.min(f.size, 60e6) - 1}`, Origin: ORIGIN } }).then((r) => r.arrayBuffer()).catch(() => {});
  }
  const prof = fs.mkdtempSync('/tmp/ltetest-');
  const ch = spawn('google-chrome-stable', ['--headless=new', '--no-sandbox', `--user-data-dir=${prof}`, '--remote-debugging-port=9336', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  await sleep(2500);
  const page = (await (await fetch('http://127.0.0.1:9336/json/list')).json()).find((x) => x.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const logs = [];
  ws.on('message', (m) => { const o = JSON.parse(m); if (pend.has(o.id)) { pend.get(o.id)(o.result); pend.delete(o.id); } if (o.method === 'Runtime.consoleAPICalled') logs.push(o.params.args.map((x) => x.value).join(' ')); });
  await new Promise((r) => ws.once('open', r));
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => { const x = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return x.exceptionDetails ? 'EXC ' + JSON.stringify(x.exceptionDetails.exception && x.exceptionDetails.exception.description) : x.result.value; };
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: 'http://127.0.0.1:8098/' });
  await sleep(1500);
  t0 = Date.now();
  await ev(`(async()=>{const meta=await (await fetch('/meta')).json();window.P=new TVPlayer(document.getElementById('c'),{meta,mediaBase:'',ticket:()=>${JSON.stringify(tk)},maxHeight:${MAXH},aheadSec:120,log:(m)=>console.log(m),onError:(m)=>console.log('ERROR '+m)});P.start(${START});return 1})()`);
  const total = PHASES.reduce((a, p) => a + p.sec, 0);
  let stalledMs = 0, last = Date.now(), firstPlay = null; const rows = [];
  let slowStartMb = null, slowEndMb = null; const slowFrom = PHASES[0].sec, slowTo = PHASES[0].sec + (PHASES[1] ? PHASES[1].sec : 0);
  // ABR=1: run the app's 15 s stats window + Player.netStepDown, switching like app.js does
  const ABR = process.env.ABR === '1'; let lastWin = Date.now(); const switches = [];
  await ev(`window.W={bytes:0,busyMs:0,stalls:0}`);
  while ((Date.now() - t0) / 1000 < total) {
    await sleep(1000);
    if (ABR && Date.now() - lastWin >= 15000) {
      lastWin = Date.now();
      const h = await ev(`(()=>{const n=P.netSample(),dB=n.busyMs-W.busyMs,kbps=dB>500?(n.bytes-W.bytes)*8/dB:null,st=P.stats.stalls-W.stalls;W={bytes:n.bytes,busyMs:n.busyMs,stalls:P.stats.stalls};const h=P.netStepDown(kbps,st,[360,480,720,1080]);if(h&&!window.NX){const old=P;const nx=window.NX=new TVPlayer(document.createElement('canvas'),{meta:old.meta,mediaBase:'',ticket:()=>${JSON.stringify(tk)},maxHeight:h,aheadSec:120,audioCtx:old.audioCtx,log:(m)=>console.log(m)});old.handoff(nx,()=>{window.PREV=(window.PREV||0)+old.stats.fetched;window.P=nx;window.NX=null;W={bytes:0,busyMs:0,stalls:0};console.log('handoff to '+h+'p')})}return h})()`);
      if (h) switches.push(`${((Date.now() - t0) / 1000).toFixed(0)}s->${h}p`);
    }
    const s = await ev(`({state:P.state,ct:+P.currentTime().toFixed(1),ahead:Math.round(P.bufferedAhead()),stalls:P.stats.stalls,mb:+((P.stats.fetched+(window.PREV||0))/1e6).toFixed(2),q:P.vfmt&&P.vfmt.height})`);
    const el = (Date.now() - t0) / 1000; const now = Date.now();
    if (s.state === 'playing' && firstPlay == null) firstPlay = el;
    if (firstPlay != null && (s.state === 'buffering' || s.state === 'loading')) stalledMs += now - last;
    last = now;
    if (slowStartMb == null && el >= slowFrom) slowStartMb = s.mb;
    if (slowEndMb == null && el >= slowTo) slowEndMb = s.mb;
    if (process.env.DEBUG) console.log('  dbg', el.toFixed(0), 'sent='+(sentBytes/1e6).toFixed(2), 'q='+queue.length, await ev(`JSON.stringify({ct:+P.currentTime().toFixed(1),v:+((P.vFetchedEnd||0)-P.currentTime()).toFixed(1),a:+((P.aFetchedTo||0)-P.currentTime()).toFixed(1),vNext:P.vNext,vLoading:P.vSegState?[...P.vSegState].filter(e=>e[1]==='loading').map(e=>e[0]):null,vDone:P.vSegState?[...P.vSegState].filter(e=>e[1]==='done').length:null,aLoading:P.aSegs?[...P.aSegs].filter(e=>e[1].loading).map(e=>e[0]):null,aNext:P.aNext,par:P.videoParallel?P.videoParallel():3,kbps:P.netKbpsRecent?Math.round(P.netKbpsRecent()||0):null,need:P.mediaKbps?Math.round(P.mediaKbps()):null})`));
    if (Math.round(el) % 5 === 0) rows.push(`  t=${el.toFixed(0).padStart(3)}s ${String(phaseAt(el).kbps).padStart(5)}kbps ${s.state.padEnd(9)} ct=${s.ct} ahead=${s.ahead} stalls=${s.stalls} got=${s.mb}MB`);
  }
  const fin = await ev(`({state:P.state,stalls:P.stats.stalls,ct:+P.currentTime().toFixed(1)})`);
  rows.forEach((r) => console.log(r));
  const dupPct = sentBytes ? 100 * dupBytes / sentBytes : 0;
  const slowGain = slowEndMb != null && slowStartMb != null ? slowEndMb - slowStartMb : null;
  const slowExpect = PHASES[1] ? PHASES[1].kbps * PHASES[1].sec / 8000 : 0;
  console.log(`player ${WEB}`);
  console.log(`first play ${firstPlay}s, stalls ${fin.stalls}, stalled ${(stalledMs / 1000).toFixed(0)}s, played to ${fin.ct}s (from ${START}), final ${fin.state}`);
  if (ABR) console.log(`step-downs: ${switches.join(' ') || 'none'}`);
  console.log(`link sent ${(sentBytes / 1e6).toFixed(1)} MB, re-sent ${(dupBytes / 1e6).toFixed(1)} MB (${dupPct.toFixed(1)}%), slow phase useful ${slowGain == null ? '?' : slowGain.toFixed(2)} MB of ~${slowExpect.toFixed(2)} MB the link carried`);
  const results = [
    ['re-sent bytes <= 3%', dupPct <= 3],
    ['progress during slow phase (>= 50% of link)', slowGain != null && slowGain >= slowExpect * 0.5],
    ['recovers to playing', fin.state === 'playing'],
  ];
  for (const [n, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${n}`);
  const failed = results.filter((r) => !r[1]);
  console.log(failed.length ? `RESULT: FAIL` : `RESULT: PASS (${results.length} checks)`);
  if (process.env.LOGS) logs.slice(-40).forEach((l) => console.log('  [page]', l));
  ch.kill('SIGKILL'); srv.close();
  setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* */ } process.exit(failed.length ? 1 : 0); }, 500);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
