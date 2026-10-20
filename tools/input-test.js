#!/usr/bin/env node
// Input test against the live kiosk (run ON the host): uses the same Chrome bridge as the
// server, taps YouTube's search box and drags to scroll, and reports what happened.
'use strict';
const path = require('path');
const { Chrome } = require(path.join(__dirname, '..', 'server', 'src', 'cdp.js'));
const scale = Number(process.env.TV_SCALE || 1.25);
const c = new Chrome({ port: Number(process.env.TV_CDP_PORT || 9222), homeUrl: 'https://www.youtube.com/', log: () => {} });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expr) => (await c.send('Runtime.evaluate', { expression: expr, returnByValue: true }, c.sid())).result.value;

(async () => {
  await c.connect();
  await sleep(1500);
  await c.nav('go', 'https://www.youtube.com/results?search_query=lofi');
  await sleep(4000);
  // 1) drag up = scroll down
  const y0 = await ev('scrollY');
  const X = 960 / scale;
  await c.touch('down', X, 900 / scale);
  for (let i = 1; i <= 10; i++) { await c.touch('move', X, (900 - i * 50) / scale); await sleep(16); }
  await c.touch('up', X, 400 / scale);
  await sleep(1200);
  const y1 = await ev('scrollY');
  console.log(`drag-scroll: scrollY ${y0} -> ${y1} ${y1 > y0 ? 'OK' : 'FAIL'}`);
  // 2) tap the search box
  const r = await ev(`(()=>{const e=document.querySelector('input[name=search_query]');if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
  if (r) {
    await c.touch('down', r.x, r.y); await sleep(60); await c.touch('up', r.x, r.y); await sleep(500);
    const ok = await ev(`document.activeElement && document.activeElement.name === 'search_query'`);
    console.log(`tap search box at css(${Math.round(r.x)},${Math.round(r.y)}): focused=${ok} ${ok ? 'OK' : 'FAIL'}`);
    console.log('editableFocused():', await c.editableFocused());
  } else console.log('search box not found');
  // 3) tap first video
  const v = await ev(`(()=>{const e=document.querySelector('ytd-video-renderer a#thumbnail');if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`);
  if (v) {
    await c.touch('down', v.x, v.y); await sleep(60); await c.touch('up', v.x, v.y); await sleep(3000);
    const u = await ev('location.pathname');
    console.log(`tap video: now at ${u} ${u === '/watch' ? 'OK' : 'FAIL'}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
