#!/usr/bin/env node
// Backend + player end-to-end test, run ON the host. The APP listener needs a real Cloudflare
// Access identity, so this exercises the pieces directly instead:
//   1) YT search / resolve via the server modules
//   2) media byte-range reads through the STREAM listener with a real ticket (+ cache timing)
//   3) player in a headless Chrome page served locally, decoding real video+audio
//   sudo bash -c 'set -a; . /etc/teslatv/teslatv.env; set +a; node tools/api-test.js [videoId]'
//   env: MAXH=720 (quality cap), SOAK=<seconds> (long-play drift/stall check). Exit 1 on any FAIL.
'use strict';
require('dns').setDefaultResultOrder('ipv4first'); require('net').setDefaultAutoSelectFamilyAttemptTimeout(2000); // same as server/src/index.js
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const S = (f) => require(path.join(__dirname, '..', 'server', 'src', f));
const { YT } = S('yt.js'); const { AccessAuth } = S('access.js');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));
const log = (m) => console.log('  [srv]', m);
const auth = new AccessAuth({ teamDomain: process.env.TV_ACCESS_TEAM, aud: process.env.TV_ACCESS_AUD, secret: process.env.TV_SECRET });
const ID = process.argv[2] || 'aqz-KE-bpKQ';
const ORIGIN = `https://${process.env.TV_PUBLIC_HOST}`;

async function get(url, headers = {}) {
  const t = Date.now(); const r = await fetch(url, { headers }); const b = Buffer.from(await r.arrayBuffer());
  return { status: r.status, ms: Date.now() - t, len: b.length, headers: r.headers, body: b };
}

(async () => {
  const yt = new YT({ stateDir: '/var/lib/teslatv', log });
  let t = Date.now();
  const s = await yt.list('search', 'big buck bunny');
  console.log(`search: ${s.items.length} items in ${Date.now() - t} ms; first: ${s.items[0] && s.items[0].title}`);
  t = Date.now();
  const home = await yt.list('home');
  console.log(`home feed: ${home.needsSignIn ? 'needs sign-in' : (home.items || []).length + ' items'} in ${Date.now() - t} ms`);

  const tk = auth.issueTicket('test');
  const base = 'http://127.0.0.1:8091';
  // resolve through the server so its cache has the formats (stream listener needs them)
  t = Date.now();
  const meta = await yt.resolve(ID);
  console.log(`resolve(${ID}) local module: ${Date.now() - t} ms, video itags ${meta.video.map((v) => v.itag + ':' + v.height + 'p' + v.fps).join(' ')}, audio ${meta.audio.map((a) => a.itag).join(' ')}`);
  // the server process has its own cache: hit /api/video via the APP listener is Access-gated, so
  // warm it by asking the stream listener for a format (it resolves on demand).
  const v = meta.video.filter((f) => f.height <= 720).pop();
  const a = meta.audio[0];
  const u = (f) => `${base}/media/${ID}/${f.itag}?t=${encodeURIComponent(tk)}`;
  let r = await get(u(v), { Range: 'bytes=0-65535', Origin: ORIGIN });
  console.log(`media video head: ${r.status} ${r.len} B in ${r.ms} ms, content-range ${r.headers.get('content-range')}`);
  r = await get(u(v), { Range: 'bytes=0-65535', Origin: ORIGIN });
  console.log(`media video head (cached): ${r.status} in ${r.ms} ms`);
  r = await get(u(v), { Range: `bytes=50000000-54194303`, Origin: ORIGIN });
  console.log(`media video 4 MiB @50MB (cold): ${r.status} ${(r.len / 1e6).toFixed(1)} MB in ${r.ms} ms = ${(r.len * 8 / r.ms / 1000).toFixed(0)} Mbit/s`);
  r = await get(u(v), { Range: `bytes=50000000-54194303`, Origin: ORIGIN });
  console.log(`media video 4 MiB @50MB (warm): ${r.status} in ${r.ms} ms = ${(r.len * 8 / r.ms / 1000).toFixed(0)} Mbit/s`);
  r = await get(u(a), { Range: 'bytes=0-262143', Origin: ORIGIN });
  console.log(`media audio head: ${r.status} ${r.len} B in ${r.ms} ms`);
  r = await get(u(v), { Range: 'bytes=0-100', Origin: 'https://evil.example' });
  console.log(`bad origin: ${r.status}`);
  r = await get(`${base}/media/${ID}/${v.itag}?t=bogus`, { Range: 'bytes=0-100' });
  console.log(`bad ticket: ${r.status}`);
  r = await get(u(v), { Origin: ORIGIN, 'Access-Control-Request-Headers': 'range' });
  console.log(`cors header on media: ${r.headers.get('access-control-allow-origin')}`);

  // ---- 3) headless player test ----
  const WEB = path.join(__dirname, '..', 'web');
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/meta') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(YT.publicMeta(meta))); }
    if (p.startsWith('/media/')) { // proxy to the stream listener with the production Origin
      const q = http.request({ host: '127.0.0.1', port: 8091, path: req.url, headers: { Range: req.headers.range || '', Origin: ORIGIN } }, (up) => {
        res.writeHead(up.statusCode, { 'Content-Type': up.headers['content-type'] || 'application/octet-stream', 'Content-Range': up.headers['content-range'] || '' }); up.pipe(res);
      });
      q.on('error', () => { res.writeHead(502); res.end(); }); return q.end();
    }
    if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<canvas id=c></canvas><script>window.addEventListener("unhandledrejection",e=>console.log("UNHANDLED "+(e.reason&&e.reason.stack||e.reason)));window.addEventListener("error",e=>console.log("ERR "+e.message))</script><script src=/fmp4.js></script><script src=/player.js></script>'); }
    fs.readFile(path.join(WEB, p), (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(d); });
  }).listen(8097, '127.0.0.1');
  const prof = fs.mkdtempSync('/tmp/ptest-');
  const ch = spawn('google-chrome-stable', ['--headless=new', '--no-sandbox', `--user-data-dir=${prof}`, '--remote-debugging-port=9335', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  await new Promise((r2) => setTimeout(r2, 2500));
  const page = (await (await fetch('http://127.0.0.1:9335/json/list')).json()).find((x) => x.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  ws.on('message', (m) => { const o = JSON.parse(m); if (pend.has(o.id)) { pend.get(o.id)(o.result); pend.delete(o.id); } if (o.method === 'Runtime.consoleAPICalled') console.log('  [page]', o.params.args.map((x) => x.value).join(' ')); });
  await new Promise((r2) => ws.once('open', r2));
  const cdp = (method, params = {}) => new Promise((r2) => { const i = ++id; pend.set(i, r2); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => { const x = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return x.exceptionDetails ? 'EXC ' + JSON.stringify(x.exceptionDetails.exception && x.exceptionDetails.exception.description) : x.result.value; };
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: 'http://127.0.0.1:8097/' });
  await new Promise((r2) => setTimeout(r2, 1500));
  console.log('page has WebCodecs:', await ev(`'VideoDecoder' in window && 'AudioDecoder' in window`));
  const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
  const results = [];
  const check = (name, ok, detail) => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); };
  const snap = () => ev(`({state:P.state,ct:+P.currentTime().toFixed(2),ahead:Math.round(P.bufferedAhead()),drawn:P.stats.drawn,dropped:P.stats.dropped,stalls:P.stats.stalls,startMs:P.stats.startMs,mb:+(P.stats.fetched/1e6).toFixed(1),sync:P.stats.lastFrameT==null?null:+(P.stats.lastFrameT-P.currentTime()).toFixed(3),q:P.vfmt&&(P.vfmt.height+'p'+P.vfmt.fps)})`);
  const waitState = async (want, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await ev('P.state')) === want) return Date.now() - t0; await sleep(100); } return -1; };
  const mkPlayer = (maxH, at) => ev(`(async()=>{if(window.P)P.destroy();const meta=window.META||(window.META=await (await fetch('/meta')).json());window.P=new TVPlayer(document.getElementById('c'),{meta,mediaBase:'',ticket:()=>${JSON.stringify(tk)},maxHeight:${maxH},aheadSec:120,log:(m)=>console.log(m),onError:(m)=>console.log('ERROR '+m)});P.start(${at});return 1})()`);
  const MAXH = Number(process.env.MAXH || 720);

  // A) start + steady play
  await mkPlayer(MAXH, 30);
  const tStart = await waitState('playing', 15000);
  let s0 = await snap();
  check('start', tStart >= 0, `${s0.q} playing after ${tStart} ms, startMs ${s0.startMs}`);
  for (let i = 0; i < 4; i++) { await sleep(2500); console.log('  t+' + (i + 1) * 2.5 + 's', JSON.stringify(await snap())); }
  let s1 = await snap();
  const adv = s1.ct - s0.ct, drawn = s1.drawn - s0.drawn, drop = s1.dropped - s0.dropped;
  check('steady play', s1.state === 'playing' && adv > 9 && s1.stalls === 0 && drop <= Math.max(2, drawn * 0.02), `ct +${adv.toFixed(1)}s in 10s, drawn ${drawn}, dropped ${drop}, stalls ${s1.stalls}`);
  check('a/v sync', s1.sync != null && Math.abs(s1.sync) < 0.1, `lastFrame - clock = ${s1.sync}s`);

  // B) pause / resume
  await ev('P.pause()'); await sleep(300); const p0 = await snap(); await sleep(3000); const p1 = await snap();
  check('pause holds', p1.state === 'paused' && Math.abs(p1.ct - p0.ct) < 0.1, `ct ${p0.ct} -> ${p1.ct}`);
  await ev('P.play()'); await sleep(2000); const p2 = await snap();
  check('resume', p2.state === 'playing' && p2.ct - p1.ct > 1.5 && Math.abs(p2.sync) < 0.1, `ct ${p1.ct} -> ${p2.ct}, sync ${p2.sync}`);

  // C) seek
  const dur = await ev('P.duration()');
  const SEEK = Math.round(Math.min(400, dur * 0.6));
  let ts = Date.now(); await ev(`P.seek(${SEEK})`);
  const tSeek = await waitState('playing', 10000); await sleep(3000); const k1 = await snap();
  check(`seek ${SEEK}s`, tSeek >= 0 && tSeek < 2000 && k1.ct > SEEK + 1 && Math.abs(k1.sync) < 0.1, `playing in ${tSeek} ms, ct ${k1.ct}, sync ${k1.sync}`);

  // D) quality switch (what app.js does: new player at current time)
  const at = k1.ct;
  ts = Date.now(); await mkPlayer(360, at);
  const tQ = await waitState('playing', 10000); await sleep(2000); const q1 = await snap();
  check('quality switch', tQ >= 0 && q1.q.startsWith('360') && Math.abs(q1.ct - at) < 4, `${q1.q} playing in ${tQ} ms at ${q1.ct} (from ${at.toFixed(1)})`);

  // E) end of video (clock must stop at the duration)
  await ev(`P.seek(${Math.max(0, dur - 6)})`);
  const tEnd = await waitState('ended', 15000);
  await sleep(2000); const e1 = await snap();
  check('reaches end', tEnd >= 0 && e1.ct <= dur + 0.01, `ended ${tEnd} ms after seeking to dur-6, clock ${e1.ct} / dur ${dur.toFixed(1)}`);

  // E2) replay after end (what the play button does in 'ended')
  await ev('P.seek(0).then(()=>P.play())');
  const tR = await waitState('playing', 10000); await sleep(2000); const r1 = await snap();
  check('replay', tR >= 0 && r1.ct > 1 && r1.ct < 5, `playing in ${tR} ms, ct ${r1.ct}`);

  // F) optional soak for drift / stalls: SOAK=<seconds>
  const SOAK = Math.min(Number(process.env.SOAK || 0), Math.floor(dur - 90));
  if (SOAK > 0) {
    await mkPlayer(MAXH, 60); await waitState('playing', 15000);
    const f0 = await snap(); let worst = 0;
    for (let el = 0; el < SOAK; el += 15) { await sleep(15000); const x = await snap(); worst = Math.max(worst, Math.abs(x.sync || 0)); console.log('  soak', JSON.stringify(x)); }
    const f1 = await snap();
    check(`soak ${SOAK}s`, f1.state === 'playing' && f1.stalls === 0 && worst < 0.1 && Math.abs((f1.ct - f0.ct) - SOAK) < SOAK * 0.05 + 3, `ct +${(f1.ct - f0.ct).toFixed(1)}s, worst sync ${worst}, dropped ${f1.dropped - f0.dropped}/${f1.drawn - f0.drawn}, stalls ${f1.stalls}`);
  }
  const failed = results.filter((r3) => !r3[1]).map((r3) => r3[0]);
  console.log(failed.length ? `RESULT: FAIL (${failed.join(', ')})` : `RESULT: PASS (${results.length} checks)`);
  process.exitCode = failed.length ? 1 : 0;
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/player.png', Buffer.from(shot.data, 'base64'));
  ch.kill('SIGKILL'); srv.close();
  setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* */ } process.exit(process.exitCode || 0); }, 500);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
