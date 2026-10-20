/* TeslaTV client: JSMpeg canvas video + touch/keyboard passthrough to the remote Chrome. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const qs = new URLSearchParams(location.search);
  const AUDIO_MODE = qs.get('audio') === 'element' ? 'element' : 'webaudio'; // ?audio=element fallback
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';

  const canvas = $('screen');
  let remote = { w: 1920, h: 1200 };
  let player = null;
  let audioEl = null;
  let ctl = null;
  let ctlBackoff = 500;
  let mode = localStorage.getItem('tv.mode') || 'touch'; // 'touch' | 'mouse'
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

  // ---------- stream ticket ----------
  // The video host is NOT behind Cloudflare Access; it accepts a short-lived HMAC ticket
  // which this (Access-protected) origin hands out.
  let ticket = null;
  async function getTicket() {
    const r = await fetch('/api/ticket', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error('ticket ' + r.status + ' (Access session expired? reload the page)');
    ticket = await r.json();
    setTimeout(() => getTicket().catch(() => {}), Math.max(60, ticket.ttl - 600) * 1000); // refresh before expiry
    return ticket;
  }

  // ---------- video ----------
  async function startPlayer() {
    if (player) { try { player.destroy(); } catch (e) { /* ignore */ } player = null; }
    if (!ticket) {
      try { await getTicket(); } catch (e) { toast(e.message, 6000); return; }
    }
    // JSMpeg destroy() removes the canvas' GL context; swap in a fresh canvas element.
    const fresh = canvas.cloneNode(false);
    canvas.parentNode.replaceChild(fresh, document.getElementById('screen'));
    bindPointer(fresh);
    // JSMpeg's WebSocket source re-uses the URL on reconnect, so give it a getter-backed URL
    // that always carries the current ticket.
    const VideoSource = function (url, opts) {
      JSMpeg.Source.WebSocket.call(this, url, opts);
    };
    VideoSource.prototype = Object.create(JSMpeg.Source.WebSocket.prototype);
    VideoSource.prototype.start = function () {
      this.url = ticket.stream + '/ws/video?t=' + encodeURIComponent(ticket.ticket);
      JSMpeg.Source.WebSocket.prototype.start.call(this);
    };
    player = new JSMpeg.Player(ticket.stream + '/ws/video', {
      source: VideoSource,
      canvas: fresh,
      audio: AUDIO_MODE === 'webaudio',
      videoBufferSize: 1024 * 1024,
      audioBufferSize: 128 * 1024,
      maxAudioLag: 0.3,
      reconnectInterval: 2,
      pauseWhenHidden: false,
      disableWebAssembly: false,
      onSourceEstablished: () => toast('Connected', 1200),
    });
    if (player.audioOut && player.audioOut.unlock) player.audioOut.unlock(() => {});
  }

  function startAudioElement() {
    if (AUDIO_MODE !== 'element' || !ticket) return;
    if (audioEl) { audioEl.pause(); audioEl.remove(); }
    audioEl = new Audio(ticket.audio + '/audio.mp3?t=' + encodeURIComponent(ticket.ticket) + '&n=' + Date.now());
    audioEl.preload = 'none';
    audioEl.play().catch((e) => toast('Audio blocked: ' + e.message));
    // keep latency bounded: if the element falls >1.5 s behind live, jump forward
    audioEl.addEventListener('timeupdate', () => {
      const b = audioEl.buffered;
      if (b.length && b.end(b.length - 1) - audioEl.currentTime > 1.5) audioEl.currentTime = b.end(b.length - 1) - 0.3;
    });
  }

  $('b-start').addEventListener('click', async () => {
    started = true;
    $('start').classList.add('hidden');
    await startPlayer();
    startAudioElement();
  });

  // ---------- control socket ----------
  function connectCtl() {
    ctl = new WebSocket(proto + location.host + '/ws/ctl');
    ctl.onopen = () => { ctlBackoff = 500; setNet('ok'); };
    ctl.onclose = () => {
      setNet('bad');
      // A 403 on the upgrade usually means the Access session expired: reload to re-auth.
      if (Date.now() - lastPong > 120000 && lastPong) { fetch('/api/ticket', { cache: 'no-store' }).then((r) => { if (r.status === 403) location.reload(); }).catch(() => {}); }
      setTimeout(connectCtl, ctlBackoff);
      ctlBackoff = Math.min(ctlBackoff * 2, 8000);
    };
    ctl.onerror = () => {};
    ctl.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'hello') {
        remote = m.screen;
        $('preset').value = m.preset;
        setUrl(m.url);
      } else if (m.t === 'page') {
        setUrl(m.url);
      } else if (m.t === 'focus') {
        if (m.editable) showTypebar(); else if (!typebarPinned) hideTypebar();
      } else if (m.t === 'preset') {
        $('preset').value = m.preset;
      } else if (m.t === 'stream-restart') {
        if (started) startPlayer();
      } else if (m.t === 'pong') {
        lastPong = Date.now();
        const rtt = Math.round(performance.now() - m.ts);
        $('net').title = 'Control RTT ' + rtt + ' ms';
        setNet(rtt > 400 ? 'slow' : 'ok');
      }
    };
  }
  function send(obj) { if (ctl && ctl.readyState === 1) ctl.send(JSON.stringify(obj)); }
  function setNet(s) { $('net').className = 'net-' + s; }
  setInterval(() => send({ t: 'ping', ts: performance.now() }), 5000);

  function setUrl(u) {
    const el = $('url');
    if (document.activeElement !== el) el.value = u || '';
  }

  // ---------- pointer -> remote coordinates ----------
  // The canvas is letterboxed with object-fit: contain; map into the remote screen space.
  function toRemote(cv, clientX, clientY) {
    const r = cv.getBoundingClientRect();
    const scale = Math.min(r.width / remote.w, r.height / remote.h);
    const dw = remote.w * scale, dh = remote.h * scale;
    const ox = r.left + (r.width - dw) / 2, oy = r.top + (r.height - dh) / 2;
    const x = (clientX - ox) / scale, y = (clientY - oy) / scale;
    if (x < 0 || y < 0 || x >= remote.w || y >= remote.h) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }

  let activeId = null;
  let pendingMove = null;
  let rafQueued = false;
  function flushMove() {
    rafQueued = false;
    if (pendingMove) { send(pendingMove); pendingMove = null; }
  }

  function bindPointer(cv) {
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      if (activeId !== null) return; // single-pointer for now
      const p = toRemote(cv, e.clientX, e.clientY);
      if (!p) return;
      activeId = e.pointerId;
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      send({ t: mode, a: 'down', x: p.x, y: p.y });
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      if (e.pointerId !== activeId && !(mode === 'mouse' && activeId === null && e.pointerType === 'mouse')) return;
      const p = toRemote(cv, e.clientX, e.clientY);
      if (!p) return;
      pendingMove = { t: mode, a: 'move', x: p.x, y: p.y };
      if (!rafQueued) { rafQueued = true; requestAnimationFrame(flushMove); }
    });
    const end = (e) => {
      if (e.pointerId !== activeId) return;
      flushMove();
      const p = toRemote(cv, e.clientX, e.clientY) || { x: 0, y: 0 };
      send({ t: mode, a: e.type === 'pointercancel' && mode === 'touch' ? 'cancel' : 'up', x: p.x, y: p.y });
      activeId = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', (e) => {
      const p = toRemote(cv, e.clientX, e.clientY);
      if (p) send({ t: 'wheel', x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY });
      e.preventDefault();
    }, { passive: false });
  }
  bindPointer(canvas);

  function applyMode() {
    $('b-mode').innerHTML = mode === 'touch' ? '&#x261D;' : '&#x2196;';
    $('b-mode').title = mode === 'touch' ? 'Touch input (tap to switch to mouse)' : 'Mouse input (tap to switch to touch)';
  }
  $('b-mode').addEventListener('click', () => {
    mode = mode === 'touch' ? 'mouse' : 'touch';
    localStorage.setItem('tv.mode', mode);
    applyMode();
    toast(mode === 'touch' ? 'Touch mode: drag scrolls' : 'Mouse mode: drag selects / scrubs');
  });
  applyMode();

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
  $('b-full').onclick = () => {
    document.body.classList.add('nobar');
    $('b-showbar').classList.remove('hidden');
  };
  $('b-showbar').onclick = () => {
    document.body.classList.remove('nobar');
    $('b-showbar').classList.add('hidden');
  };

  // ---------- typing ----------
  // A real <input> must receive the tap for the car's on-screen keyboard to open,
  // so the bar shows a visible field; whatever is typed is mirrored into the remote page.
  const typer = $('typer');
  let typebarPinned = false;
  let shadow = '';
  function showTypebar() { $('typebar').classList.remove('hidden'); document.body.classList.add('typing'); }
  function hideTypebar() {
    $('typebar').classList.add('hidden');
    document.body.classList.remove('typing');
    typebarPinned = false;
    typer.blur();
    typer.value = shadow = '';
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
    const passthrough = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (passthrough.includes(e.key)) {
      e.preventDefault();
      send({ t: 'key', k: e.key });
      if (e.key === 'Enter') typer.value = shadow = '';
    } else if (e.key === 'Backspace' && typer.value === '') {
      e.preventDefault();
      send({ t: 'key', k: 'Backspace' });
    }
  });

  // physical / BT keyboard on the main view (no field focused): forward keys as-is
  document.addEventListener('keydown', (e) => {
    if (e.target === typer || e.target === $('url')) return;
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { send({ t: 'key', k: e.key }); e.preventDefault(); }
    else if (['Backspace', 'Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Delete'].includes(e.key)) {
      send({ t: 'key', k: e.key }); e.preventDefault();
    }
  });

  // resume video when the tab returns to the foreground (car screen wakes, tab switch)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && started && (!player || !player.source || !player.source.established)) startPlayer();
  });

  connectCtl();
})();
