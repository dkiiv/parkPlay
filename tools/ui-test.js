#!/usr/bin/env node
// End-to-end test of the local car UI (web/index.html + app.js + player.js), run ON the host.
// Serves web/ on 127.0.0.1:8096 with the real server modules (yt.js + media.js in-process, as
// in index.js; TV_MEDIA_DEBUG=1 prints a server timeline), then drives a
// headless Chrome at the car's viewport with touch taps:
// API + media proxy run in this process with a fresh media cache (cold, like a new video).
//   home grid renders -> icons sit in their buttons -> search -> tap a result -> watch view
//   plays -> overlay controls toggle -> back returns to the grid. Screenshots to /tmp/ui-*.png.
//   sudo bash -c 'set -a; . /etc/parkplay/parkplay.env; set +a; node tools/ui-test.js [query]'
// Exit 1 on any FAIL. Access/Google login is not covered (needs a real browser session).
'use strict';
require('dns').setDefaultResultOrder('ipv4first'); require('net').setDefaultAutoSelectFamilyAttemptTimeout(2000); // same as server/src/index.js
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const S = (f) => require(path.join(__dirname, '..', 'server', 'src', f));
const { YT } = S('yt.js'); const { AccessAuth } = S('access.js'); const { Media } = S('media.js');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws'));
const auth = new AccessAuth({ teamDomain: process.env.TV_ACCESS_TEAM, aud: process.env.TV_ACCESS_AUD, secret: process.env.TV_SECRET });
const ORIGIN = `https://${process.env.TV_PUBLIC_HOST}`;
const QUERY = process.argv[2] || 'big buck bunny';
const [W, H] = [Number(process.env.VW || 1888), Number(process.env.VH || 1022)];
const WEB = path.join(__dirname, '..', 'web');
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.html': 'text/html', '.webmanifest': 'application/manifest+json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const slog = (m) => { if (process.env.TV_MEDIA_DEBUG) console.log(`  [srv +${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`); };
const yt = new YT({ stateDir: '/var/lib/parkplay', log: slog });
// Same process for API + media, as in production (index.js). Fresh cache per run = truly cold.
const MEDIA_DIR = fs.mkdtempSync('/tmp/uitest-media-');
const media = new Media({ yt, cacheDir: MEDIA_DIR, maxBytes: 2e9, log: slog });
const warmMedia = (d, chunks) => { // mirrors index.js warmMedia()
  const v = d.video.filter((f) => f.height <= 720 && (f.fps || 30) <= 31).pop() || d.video.filter((f) => f.height <= 720).pop() || d.video[0];
  media.readAhead(d.id, v.itag, 0, v.size, chunks); media.readAhead(d.id, d.audio[0].itag, 0, d.audio[0].size, chunks);
};
const beacons = []; const prefetchCalls = []; const feedCalls = [];

const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  try {
    if (p === '/api/feed') { const d = await yt.list(u.searchParams.get('kind') || 'home', u.searchParams.get('q') || '', 36, { fresh: u.searchParams.get('fresh') === '1' }); feedCalls.push(u.search); if (!process.env.NO_PREFETCH) yt.prefetch(d.items, 6, (m) => warmMedia(m, 1)); return json(res, 200, d); }
    if (p.startsWith('/api/video/')) { slog('api/video ' + p.slice(11)); yt.cancelPrefetch(); const d = await yt.resolve(p.slice(11)); slog('resolved'); warmMedia(d, 8); return json(res, 200, YT.publicMeta(d)); }
    if (p === '/api/prefetch') { const b = await body(req); prefetchCalls.push(b); if (!process.env.NO_PREFETCH) { try { yt.prefetch((JSON.parse(b).ids || []).slice(0, 8), 8, (m) => warmMedia(m, 1), 8); } catch { /* */ } } res.writeHead(204); return res.end(); }
    if (p === '/api/account') return json(res, 200, { signedIn: yt.signedIn, user: 'test' });
    if (p === '/api/ticket') return json(res, 200, { ticket: auth.issueTicket('test'), audio: '', ttl: 3600, user: 'test' });
    if (p === '/api/stats' || p === '/api/clientlog') { beacons.push([p, await body(req)]); res.writeHead(204); return res.end(); }
    if (p.startsWith('/media/')) { // same semantics as index.js serveMedia() (minus ticket/Origin, covered by api-test)
      const [, , id, itag] = p.split('/');
      const f = await yt.format(id, itag);
      if (!f) { res.writeHead(404); return res.end(); }
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const start = m ? Number(m[1]) : 0; const end = m && m[2] ? Number(m[2]) : start + 2 * 1024 * 1024 - 1;
      const t1 = Date.now();
      const { buf, size } = await media.read(id, itag, start, end);
      slog(`media ${id}/${itag} ${start}-${end} -> ${buf.length} B in ${Date.now() - t1} ms`);
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${start + buf.length - 1}/${size}`, 'Content-Length': buf.length });
      return res.end(buf);
    }
    const f = path.join(WEB, p === '/' ? 'index.html' : path.normalize(p));
    if (!f.startsWith(WEB)) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(d); });
  } catch (e) { json(res, 502, { error: e.message }); }
}).listen(8096, '127.0.0.1');

(async () => {
  const prof = fs.mkdtempSync('/tmp/uitest-');
  const ch = spawn('google-chrome-stable', ['--headless=new', '--no-sandbox', `--user-data-dir=${prof}`, '--remote-debugging-port=9336', '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
  await sleep(2500);
  const page = (await (await fetch('http://127.0.0.1:9336/json/list')).json()).find((x) => x.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const errors = [];
  ws.on('message', (m) => {
    const o = JSON.parse(m);
    if (pend.has(o.id)) { pend.get(o.id)(o.result); pend.delete(o.id); }
    if (o.method === 'Runtime.exceptionThrown') errors.push(o.params.exceptionDetails.exception ? o.params.exceptionDetails.exception.description : o.params.exceptionDetails.text);
    if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') errors.push(o.params.args.map((x) => x.value || x.description).join(' '));
  });
  await new Promise((r) => ws.once('open', r));
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => { const x = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return x.exceptionDetails ? 'EXC ' + JSON.stringify(x.exceptionDetails.exception && x.exceptionDetails.exception.description) : x.result.value; };
  const results = [];
  const check = (name, ok, detail) => { results.push([name, !!ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); };
  const until = async (expr, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await ev(`(()=>{try{return !!(${expr})}catch(e){return false}})()`)) === true) return Date.now() - t0; await sleep(150); } return -1; };
  // a finger tap at the element's centre (the car delivers touch events, not mouse)
  const tap = async (sel) => {
    const c = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`);
    if (!c) return false;
    await sleep(100);
    await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c[0], y: c[1] }] });
    await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return true;
  };
  const shot = async (name) => { const s = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`/tmp/ui-${name}.png`, Buffer.from(s.data, 'base64')); };

  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:8096/' });
  await until(`document.readyState==='complete' && !!document.getElementById('grid')`, 10000);

  // 1) home feed
  let t = await until(`document.querySelectorAll('#grid .card:not(.sk)').length>0 || !document.getElementById('feed-msg').classList.contains('hidden')`, 30000);
  const home = await ev(`({cards:document.querySelectorAll('#grid .card:not(.sk)').length,msg:document.getElementById('feed-msg').textContent.trim().slice(0,80)})`);
  check('home feed', t >= 0 && (home.cards > 0 || /sign in/i.test(home.msg)), `${home.cards} cards${home.msg ? ', msg: ' + home.msg : ''} in ${t} ms`);

  // 1b) when signed in: refreshing Home returns mostly videos not shown before
  if (home.cards > 0) {
    const ids0 = await ev(`[...document.querySelectorAll('#grid .card:not(.sk) .thumb img')].map(i=>i.src.split('/vi/')[1].split('/')[0])`);
    await tap('#b-refresh');
    await until(`document.querySelectorAll('#grid .card:not(.sk)').length>0 && !document.getElementById('toast').classList.contains('hidden')`, 40000);
    await sleep(300);
    const ids1 = await ev(`[...document.querySelectorAll('#grid .card:not(.sk) .thumb img')].map(i=>i.src.split('/vi/')[1].split('/')[0])`);
    const fresh = ids1.filter((x) => !ids0.includes(x)).length;
    check('home refresh gives new videos', ids1.length >= 12 && fresh >= ids1.length * 0.5, `${fresh}/${ids1.length} new after refresh (was ${ids0.length})`);
  }

  // 2) icons are sized and sit inside their buttons (Tesla has no symbol glyphs; CSS-less fallback)
  const icons = await ev(`[...document.querySelectorAll('#rail .tab')].map(b=>{const s=b.querySelector('svg');const bb=b.getBoundingClientRect(),sb=s.getBoundingClientRect();return {w:sb.width|0,inside:sb.left>=bb.left&&sb.right<=bb.right&&sb.top>=bb.top&&sb.bottom<=bb.bottom}})`);
  check('rail icons', icons.length >= 5 && icons.every((x) => x.inside && x.w >= 20), JSON.stringify(icons));
  await shot('home');

  // 3) search via the local input (the car keyboard only opens for a real <input>)
  await tap('#q');
  const focused = await ev(`document.activeElement && document.activeElement.id`);
  check('search box focus on tap', focused === 'q', `activeElement=${focused}`);
  await cdp('Input.insertText', { text: QUERY });
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  t = await until(`document.getElementById('feed-title').textContent.includes('Results') && document.querySelectorAll('#grid .card:not(.sk)').length>0`, 30000);
  const nres = await ev(`document.querySelectorAll('#grid .card:not(.sk)').length`);
  check('search results', t >= 0 && nres > 0, `${nres} results for "${QUERY}" in ${t} ms`);

  await sleep(Number(process.env.BROWSE_MS || 6000)); // a person looks at the results before tapping
  // 3a) refresh button re-queries (fresh=1) and re-renders; tapping the active tab does too
  const firstIds = await ev(`[...document.querySelectorAll('#grid .card:not(.sk) .thumb img')].slice(0,3).map(i=>i.src).join()`);
  const nFeed = feedCalls.length;
  await tap('#b-refresh');
  t = await until(`document.querySelectorAll('#grid .card:not(.sk)').length>0`, 20000);
  await sleep(300);
  const refreshIcon = await ev(`(()=>{const b=document.getElementById('b-refresh'),s=b.querySelector('svg');const bb=b.getBoundingClientRect(),sb=s.getBoundingClientRect();return sb.width>=20&&sb.left>=bb.left&&sb.right<=bb.right&&bb.height>=44})()`);
  const freshCall = feedCalls.slice(nFeed).find((q) => q.includes('fresh=1'));
  check('refresh button', freshCall && t >= 0 && refreshIcon, `request ${freshCall || 'none'}, grid back in ${t} ms, icon ok ${refreshIcon}, first thumbs changed ${firstIds !== (await ev(`[...document.querySelectorAll('#grid .card:not(.sk) .thumb img')].slice(0,3).map(i=>i.src).join()`))}`);

  // 3b) grid layout: no two cards overlap, and each card's thumb/title/meta stays inside it, at
  // the car viewport and at common desktop widths (regression: the probe page's global .card
  // rule gave grid cards a fixed width + margins, so they overlapped).
  const layout = async () => ev(`(()=>{const cs=[...document.querySelectorAll('#grid .card:not(.sk)')].slice(0,24).map(c=>({c,b:c.getBoundingClientRect()}));let ov=0,out=0;
    for(let i=0;i<cs.length;i++){for(let j=i+1;j<cs.length;j++){const a=cs[i].b,b=cs[j].b;if(a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1)ov++;}
      for(const k of cs[i].c.children){const r=k.getBoundingClientRect();if(r.width&&(r.left<cs[i].b.left-1||r.right>cs[i].b.right+1))out++;}}
    const g=document.getElementById('grid').getBoundingClientRect();const cols=new Set(cs.map(x=>Math.round(x.b.left))).size;
    return {n:cs.length,overlaps:ov,childOverflow:out,cols,cardW:Math.round(cs[0]?cs[0].b.width:0),gridW:Math.round(g.width),hScroll:document.getElementById('main').scrollWidth>document.getElementById('main').clientWidth+1}})()`);
  const sizes = [[W, H], [1280, 720], [1920, 1080], [2560, 1300], [900, 700]];
  const lay = [];
  for (const [vw, vh] of sizes) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const L = await layout(); lay.push(`${vw}x${vh}: ${L.cols} cols ${L.cardW}px ov=${L.overlaps} out=${L.childOverflow}${L.hScroll ? ' HSCROLL' : ''}`);
    if (vw === 1920) await shot('grid-1920');
    lay.ok = (lay.ok !== false) && L.n > 0 && L.overlaps === 0 && L.childOverflow === 0 && !L.hScroll;
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  check('grid layout (no overlap)', lay.ok, lay.join(' | '));

  // 4) drag scrolls the grid
  const y0 = await ev(`document.getElementById('main').scrollTop`);
  await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: W / 2, y: H * 0.8 }] });
  for (let i = 1; i <= 10; i++) { await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: W / 2, y: H * 0.8 - i * 40 }] }); await sleep(16); }
  await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(600);
  const y1 = await ev(`document.getElementById('main').scrollTop`);
  check('drag scrolls', y1 > y0 + 100, `scrollTop ${y0} -> ${y1}`);
  // TAP=deep: tap a card scrolled into view past the feed prefetch (index >= 8), the case the
  // visible-card beacon is for. Default: the first card (covered by the feed prefetch).
  if (process.env.TAP !== 'deep') await ev(`document.getElementById('main').scrollTop=0`);
  await sleep(Number(process.env.BROWSE_MS || 6000) / 2);

  // 5) tap the first non-live result -> watch view plays
  const idx = await ev(`(()=>{const cs=[...document.querySelectorAll('#grid .card:not(.sk)')];const vh=document.getElementById('main').getBoundingClientRect();const vis=(c)=>{const b=c.getBoundingClientRect();return b.top>=vh.top&&b.bottom<=vh.bottom};const ok=(c)=>!c.querySelector('.dur.live');${process.env.TAP === 'deep' ? "const d=cs.findIndex(c=>Number(c.dataset.i)>=8&&vis(c)&&ok(c));if(d>=0)return d;" : ''}return cs.findIndex(ok)})()`);
  console.log('  tapping card', idx);
  await ev(`(()=>{window.__tt={};const of=window.fetch;window.fetch=function(u,o){const s=String(u),t0=performance.now();return of.apply(this,arguments).then(r=>{if(s.includes('/api/video/'))__tt.videoApi=Math.round(performance.now()-t0);if(s.includes('/media/')&&!__tt.firstMedia)__tt.firstMedia=Math.round(performance.now()-t0);return r})};__tt.tap=performance.now()})()`);
  slog('--- TAP ---');
  await tap(`#grid .card[data-i="${idx}"] .thumb`);
  t = await until(`!document.getElementById('watch').classList.contains('hidden')`, 3000);
  check('tap opens watch view', t >= 0, `${t} ms, hash ${await ev('location.hash')}`);
  const t0 = Date.now();
  t = await until(`document.getElementById('spinner').classList.contains('hidden') && document.getElementById('t-cur').textContent!=='0:00'`, 30000);
  const ttfp = Date.now() - t0;
  console.log('  time to play', JSON.stringify(await ev(`({videoApiMs:__tt.videoApi,firstMediaMs:__tt.firstMedia,uiToTickMs:${ttfp}})`)));
  await sleep(4000);
  const w = await ev(`({title:document.getElementById('w-title').textContent.slice(0,60),cur:document.getElementById('t-cur').textContent,dur:document.getElementById('t-dur').textContent,buf:document.getElementById('w-buf').textContent,toast:document.getElementById('toast').classList.contains('hidden')?'':document.getElementById('toast').textContent})`);
  check('video plays in UI', t >= 0 && w.cur !== '0:00' && !w.toast, JSON.stringify(w));
  await shot('watch');

  // 6) overlay: controls fade while playing, a tap on the video brings them back
  await sleep(4000);
  const hidden = await ev(`!document.getElementById('overlay').classList.contains('show')`);
  await tap('#screen');
  await sleep(300);
  const shown = await ev(`document.getElementById('overlay').classList.contains('show')`);
  check('overlay auto-hide + tap to show', hidden && shown, `hidden after idle=${hidden}, shown after tap=${shown}`);
  const ctl = await ev(`['w-back','w-rew','w-play','w-fwd','w-full'].map(i=>{const b=document.getElementById(i),s=b.querySelector('svg');const bb=b.getBoundingClientRect(),sb=s.getBoundingClientRect();return sb.width>=20&&sb.left>=bb.left-1&&sb.right<=bb.right+1})`);
  check('control icons', ctl.every(Boolean), JSON.stringify(ctl));

  // 7) pause button
  await tap('#w-play'); await sleep(400);
  const c0 = await ev(`document.getElementById('t-cur').textContent`);
  await sleep(2500);
  const c1 = await ev(`document.getElementById('t-cur').textContent`);
  const icon = await ev(`document.getElementById('w-play-ic').getAttribute('href')`);
  check('pause button', c0 === c1 && icon === '#i-play', `time ${c0} -> ${c1}, icon ${icon}`);
  await tap('#w-play'); await sleep(300);

  // 8) back returns to the results grid, player torn down
  await tap('#w-back');
  t = await until(`document.getElementById('watch').classList.contains('hidden') && !document.getElementById('browse').classList.contains('hidden')`, 3000);
  check('back to grid', t >= 0 && (await ev(`document.querySelectorAll('#grid .card:not(.sk)').length`)) > 0, `${t} ms`);

  const clientErrs = beacons.filter((b) => b[0] === '/api/clientlog').map((b) => b[1]);
  check('no client errors', !errors.length && !clientErrs.length, [...errors, ...clientErrs].join(' | ').slice(0, 400));
  check('visible-card prefetch beacon', prefetchCalls.length > 0 && prefetchCalls.every((b) => { try { const x = JSON.parse(b).ids; return x.length > 0 && x.length <= 8; } catch { return false; } }), `${prefetchCalls.length} calls, last ${prefetchCalls[prefetchCalls.length - 1] || ''}`);
  console.log(`stats beacons: ${beacons.filter((b) => b[0] === '/api/stats').length}; screenshots /tmp/ui-home.png /tmp/ui-watch.png`);
  const failed = results.filter((r) => !r[1]).map((r) => r[0]);
  console.log(failed.length ? `RESULT: FAIL (${failed.join(', ')})` : `RESULT: PASS (${results.length} checks)`);
  ch.kill('SIGKILL'); srv.close();
  setTimeout(() => { try { fs.rmSync(MEDIA_DIR, { recursive: true, force: true }); fs.rmSync(prof, { recursive: true, force: true }); } catch { /* */ } process.exit(failed.length ? 1 : 0); }, 500);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
