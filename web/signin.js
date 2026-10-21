/* ParkPlay client: JSMpeg canvas video with an adaptive jitter buffer + tablet-style touch. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';

  let remote = { w: 1920, h: 1200 };
  let player = null;
  let ctl = null;
  let ctlBackoff = 500;
  let started = false;
  let lastPong = 0;

  // ---------- status toast ----------
  let toastTimer = 0;
  function toast(msg, ms = 2500) {
    const el = $('status');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  // ---------- stream ticket (video host is not behind Cloudflare Access) ----------
  let ticket = null;
  async function getTicket() {
    const r = await fetch('/api/ticket', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 403) { location.reload(); throw new Error('signing in again'); }
    if (!r.ok) throw new Error('ticket ' + r.status);
    ticket = await r.json();
    setTimeout(() => getTicket().catch(() => {}), Math.max(60, ticket.ttl - 600) * 1000);
    return ticket;
  }

  // ---------- jitter buffer ----------
  // Every WS message from the server is [8-byte float64 server send time in ms][MPEG-TS bytes].
  // LTE delivers data in bursts; playing it as it arrives makes video stutter and race.
  // Each chunk is held until (serverTime + clockOffset + delay), so chunks come out with the
  // same spacing the server sent them. `delay` adapts to the jitter actually seen.
  const JB = { min: 250, max: 4000, delay: 700, jitterHist: [], offset: null, offsetSeenAt: 0, underruns: 0, bytes: 0, frames: 0 };

  function BufferedSource(url, opts) {
    JSMpeg.Source.WebSocket.call(this, url, opts);
    this.queue = [];
    this.timer = null;
  }
  BufferedSource.prototype = Object.create(JSMpeg.Source.WebSocket.prototype);
  BufferedSource.prototype.start = function () {
    this.url = ticket.stream + '/ws/video?t=' + encodeURIComponent(ticket.ticket);
    JB.offset = null;
    this.queue = [];
    JSMpeg.Source.WebSocket.prototype.start.call(this);
    clearInterval(this.timer);
    this.timer = setInterval(this.pump.bind(this), 8);
  };
  BufferedSource.prototype.destroy = function () {
    clearInterval(this.timer);
    JSMpeg.Source.WebSocket.prototype.destroy.call(this);
  };
  BufferedSource.prototype.onMessage = function (ev) {
    const now = performance.now();
    const buf = ev.data;
    if (buf.byteLength <= 8) return;
    const sent = new DataView(buf, 0, 8).getFloat64(0);
    const transit = now - sent; // includes the clock difference; only relative values matter
    // offset = smallest transit seen recently (= fastest path); re-learned every 30 s for drift
    if (JB.offset === null || transit < JB.offset || now - JB.offsetSeenAt > 30000) {
      if (JB.offset !== null && now - JB.offsetSeenAt > 30000) JB.offset = Math.min(transit, JB.offset + 50);
      else JB.offset = transit;
      JB.offsetSeenAt = now;
    }
    const lateness = transit - JB.offset;
    JB.jitterHist.push([now, lateness]);
    JB.bytes += buf.byteLength - 8;
    const first = !this.established;
    this.established = true;
    if (first && this.onEstablishedCallback) this.onEstablishedCallback(this);
    this.queue.push({ due: sent + JB.offset, data: buf.slice(8) });
  };
  BufferedSource.prototype.pump = function () {
    const now = performance.now();
    while (this.queue.length && this.queue[0].due + JB.delay <= now) {
      const c = this.queue.shift();
      if (this.destination) this.destination.write(c.data);
    }
  };

  // Adapt the delay: cover the 98th percentile of lateness over the last 20 s, plus margin.
  // Grow fast, shrink slowly (and only by releasing a little earlier, which is smooth).
  setInterval(() => {
    const now = performance.now();
    JB.jitterHist = JB.jitterHist.filter((x) => now - x[0] < 20000);
    if (JB.jitterHist.length < 20) return;
    const s = JB.jitterHist.map((x) => x[1]).sort((a, b) => a - b);
    const p98 = s[Math.floor(s.length * 0.98)];
    const target = Math.min(JB.max, Math.max(JB.min, p98 * 1.15 + 120));
    if (target > JB.delay) JB.delay = target;                  // grow immediately
    else JB.delay = Math.max(target, JB.delay - 25);           // shrink ~25 ms per second
  }, 1000);

  // ---------- video ----------
  async function startPlayer() {
    if (player) { try { player.destroy(); } catch (e) { /* ignore */ } player = null; }
    if (!ticket) {
      try { await getTicket(); } catch (e) { toast(e.message, 6000); return; }
    }
    // JSMpeg destroy() drops the canvas context; use a fresh canvas each time.
    const old = $('screen');
    const fresh = old.cloneNode(false);
    old.parentNode.replaceChild(fresh, old);
    bindTouch(fresh);
    toast('Buffering…', 1500);
    player = new JSMpeg.Player(ticket.stream + '/ws/video', {
      source: BufferedSource,
      canvas: fresh,
      audio: true,
      videoBufferSize: 2 * 1024 * 1024,
      audioBufferSize: 256 * 1024,
      maxAudioLag: 0.5,
      reconnectInterval: 2,
      pauseWhenHidden: false,
      onVideoDecode: () => { JB.frames++; window.__tvFrames = JB.frames; },
    });
    if (player.audioOut && player.audioOut.unlock) player.audioOut.unlock(() => {});
  }

  $('b-start').addEventListener('click', async () => {
    started = true;
    $('start').classList.add('hidden');
    await startPlayer();
  });

  // ---------- control socket ----------
  function connectCtl() {
    ctl = new WebSocket(proto + location.host + '/ws/ctl');
    ctl.onopen = () => {
      ctlBackoff = 500; setNet('ok');
      const caps = { t: 'hello', ua: navigator.userAgent, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, pe: 'PointerEvent' in window, te: 'ontouchstart' in window,
        webcodecs: 'VideoDecoder' in window, webgl: !!document.createElement('canvas').getContext('webgl'), wasm: typeof WebAssembly === 'object', cores: navigator.hardwareConcurrency };
      if (caps.webcodecs && VideoDecoder.isConfigSupported) {
        VideoDecoder.isConfigSupported({ codec: 'avc1.42E01F', optimizeForLatency: true })
          .then((r) => { caps.h264 = !!r.supported; send(caps); }).catch(() => send(caps));
      } else send(caps);
    };
    ctl.onclose = () => {
      setNet('bad');
      if (lastPong && Date.now() - lastPong > 120000) fetch('/api/ticket', { cache: 'no-store' }).then((r) => { if (r.status === 403) location.reload(); }).catch(() => {});
      setTimeout(connectCtl, ctlBackoff);
      ctlBackoff = Math.min(ctlBackoff * 2, 8000);
    };
    ctl.onerror = () => {};
    ctl.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'hello') {
        remote = m.screen; $('preset').value = m.preset; setUrl(m.url);
        if (!/accounts\.google\.com|youtube\.com/.test(m.url || '')) send({ t: 'nav', a: 'go', url: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F' });
      }
      else if (m.t === 'page') setUrl(m.url);
      else if (m.t === 'focus') { if (m.editable) showTypebar(); else if (!typebarPinned) hideTypebar(); }
      else if (m.t === 'preset') $('preset').value = m.preset;
      else if (m.t === 'stream-restart') { if (started) startPlayer(); }
      else if (m.t === 'pong') {
        lastPong = Date.now();
        const rtt = Math.round(performance.now() - m.ts);
        setNet(rtt > 400 ? 'slow' : 'ok');
      }
    };
  }
  function send(obj) { if (ctl && ctl.readyState === 1) ctl.send(JSON.stringify(obj)); }
  function setNet(s) { $('net').className = 'net-' + s; }
  setInterval(() => send({ t: 'ping', ts: performance.now() }), 5000);

  // Playback stats -> server log, so lag can be diagnosed without being in the car.
  let lastStats = { t: performance.now(), bytes: 0, frames: 0 };
  setInterval(() => {
    if (!started) return;
    const now = performance.now(); const dt = (now - lastStats.t) / 1000;
    send({ t: 'stats', fps: +((JB.frames - lastStats.frames) / dt).toFixed(1), kbps: Math.round((JB.bytes - lastStats.bytes) * 8 / dt / 1000),
      delay: Math.round(JB.delay), queued: player && player.source && player.source.queue ? player.source.queue.length : 0 });
    lastStats = { t: now, bytes: JB.bytes, frames: JB.frames };
  }, 10000);

  function setUrl(u) { const el = $('url'); if (document.activeElement !== el) el.value = u || ''; }

  // ---------- touch: behaves like a tablet ----------
  // One finger, sent as real touch events: tap = click, drag = scroll, hold = long-press.
  function toRemote(cv, clientX, clientY) {
    const r = cv.getBoundingClientRect();
    const scale = Math.min(r.width / remote.w, r.height / remote.h);
    const ox = r.left + (r.width - remote.w * scale) / 2, oy = r.top + (r.height - remote.h * scale) / 2;
    const x = (clientX - ox) / scale, y = (clientY - oy) / scale;
    if (x < 0 || y < 0 || x >= remote.w || y >= remote.h) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }
  let activeId = null, pendingMove = null, rafQueued = false;
  function flushMove() { rafQueued = false; if (pendingMove) { send(pendingMove); pendingMove = null; } }

  function bindTouch(cv) {
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      if (activeId !== null) return;
      const p = toRemote(cv, e.clientX, e.clientY);
      if (!p) return;
      activeId = e.pointerId;
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      send({ t: 'touch', a: 'down', x: p.x, y: p.y });
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      if (e.pointerId !== activeId) return;
      const p = toRemote(cv, e.clientX, e.clientY);
      if (!p) return;
      pendingMove = { t: 'touch', a: 'move', x: p.x, y: p.y };
      if (!rafQueued) { rafQueued = true; requestAnimationFrame(flushMove); }
    });
    const end = (e) => {
      if (e.pointerId !== activeId) return;
      flushMove();
      const p = toRemote(cv, e.clientX, e.clientY) || { x: 0, y: 0 };
      send({ t: 'touch', a: e.type === 'pointercancel' ? 'cancel' : 'up', x: p.x, y: p.y });
      activeId = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }
  bindTouch($('screen'));

  // ---------- toolbar ----------
  $('b-back').onclick = () => send({ t: 'nav', a: 'back' });
  $('b-fwd').onclick = () => send({ t: 'nav', a: 'forward' });
  $('b-reload').onclick = () => send({ t: 'nav', a: 'reload' });
  $('b-home').onclick = () => send({ t: 'nav', a: 'home' });
  $('urlform').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('url').value.trim();
    if (v) send({ t: 'nav', a: 'go', url: v });
    $('url').blur();
  });
  $('url').addEventListener('focus', () => $('url').select());
  $('preset').addEventListener('change', (e) => { send({ t: 'preset', p: e.target.value }); toast('Quality: ' + e.target.value); });
  $('b-full').onclick = () => { document.body.classList.add('nobar'); $('b-showbar').classList.remove('hidden'); };
  $('b-showbar').onclick = () => { document.body.classList.remove('nobar'); $('b-showbar').classList.add('hidden'); };

  // ---------- typing ----------
  // The car keyboard only opens for a real local <input>, so a type bar appears whenever a
  // text field is focused in the remote page; what you type is mirrored into it.
  const typer = $('typer');
  let typebarPinned = false;
  let shadow = '';
  function showTypebar() { $('typebar').classList.remove('hidden'); document.body.classList.add('typing'); }
  function hideTypebar() {
    $('typebar').classList.add('hidden'); document.body.classList.remove('typing');
    typebarPinned = false; typer.blur(); typer.value = shadow = '';
  }
  $('b-kbd').onclick = () => {
    if ($('typebar').classList.contains('hidden')) { typebarPinned = true; showTypebar(); typer.focus(); } else hideTypebar();
  };
  $('t-close').onclick = hideTypebar;
  $('t-bksp').onclick = () => send({ t: 'key', k: 'Backspace' });
  $('t-enter').onclick = () => { send({ t: 'key', k: 'Enter' }); typer.value = shadow = ''; };
  function syncTyper() {
    const v = typer.value;
    let i = 0;
    while (i < v.length && i < shadow.length && v[i] === shadow[i]) i++;
    for (let k = shadow.length; k > i; k--) send({ t: 'key', k: 'Backspace' });
    if (v.length > i) send({ t: 'text', s: v.slice(i) });
    shadow = v;
  }
  let composing = false;
  typer.addEventListener('compositionstart', () => { composing = true; });
  typer.addEventListener('compositionend', () => { composing = false; syncTyper(); });
  typer.addEventListener('input', () => { if (!composing) syncTyper(); });
  typer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send({ t: 'key', k: 'Enter' }); typer.value = shadow = ''; }
    else if (e.key === 'Backspace' && typer.value === '') { e.preventDefault(); send({ t: 'key', k: 'Backspace' }); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && started && (!player || !player.source || !player.source.established)) startPlayer();
  });

  connectCtl();
})();
