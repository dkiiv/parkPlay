/* Tesla browser capability probe: static API checks + live playback tests, POSTed to /probe/report. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const report = { label: 'park', caps: {}, live: {}, input: {}, screen: {} };
  const caps = report.caps;

  function row(name, val) {
    const tr = document.createElement('tr');
    const cls = val === true ? 'ok' : val === false ? 'no' : '';
    tr.innerHTML = '<td></td><td class="' + cls + '"></td>';
    tr.children[0].textContent = name;
    tr.children[1].textContent = typeof val === 'object' ? JSON.stringify(val) : String(val);
    $('caps').appendChild(tr);
  }
  function setCap(k, v) { caps[k] = v; row(k, v); }

  // ---- static capability checks ----
  function gl(kind) {
    try {
      const c = document.createElement('canvas').getContext(kind);
      if (!c) return false;
      const dbg = c.getExtension('WEBGL_debug_renderer_info');
      return dbg ? c.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : true;
    } catch (e) { return false; }
  }
  function mse(type) { try { return !!(window.MediaSource && MediaSource.isTypeSupported(type)); } catch (e) { return false; } }
  function canPlay(type) { const v = document.createElement('video'); return v.canPlayType(type) || 'no'; }

  setCap('userAgent', navigator.userAgent);
  const chromeVer = (navigator.userAgent.match(/Chrom(e|ium)\/([\d.]+)/) || [])[2] || 'unknown';
  setCap('chromeVersion', chromeVer);
  setCap('isSecureContext', window.isSecureContext);
  setCap('WebSocket', 'WebSocket' in window);
  setCap('WebAssembly', typeof WebAssembly === 'object');
  setCap('Canvas2D', !!document.createElement('canvas').getContext('2d'));
  setCap('WebGL', gl('webgl'));
  setCap('WebGL2', gl('webgl2'));
  setCap('OffscreenCanvas', 'OffscreenCanvas' in window);
  setCap('createImageBitmap', 'createImageBitmap' in window);
  setCap('AudioContext', !!(window.AudioContext || window.webkitAudioContext));
  setCap('AudioWorklet', !!(window.AudioWorkletNode));
  setCap('MediaSource', 'MediaSource' in window);
  setCap('ManagedMediaSource', 'ManagedMediaSource' in window);
  setCap('MSE h264 (avc1.42E01E)', mse('video/mp4; codecs="avc1.42E01E"'));
  setCap('MSE hevc (hvc1)', mse('video/mp4; codecs="hvc1.1.6.L93.B0"'));
  setCap('MSE vp9', mse('video/webm; codecs="vp9"'));
  setCap('MSE av1', mse('video/mp4; codecs="av01.0.05M.08"'));
  setCap('canPlay mp4/h264', canPlay('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'));
  setCap('VideoDecoder (WebCodecs)', 'VideoDecoder' in window);
  setCap('AudioDecoder (WebCodecs)', 'AudioDecoder' in window);
  setCap('RTCPeerConnection (WebRTC)', 'RTCPeerConnection' in window);
  setCap('RTCDataChannel', (function () {
    try { const pc = new RTCPeerConnection(); pc.createDataChannel('x'); pc.close(); return true; } catch (e) { return false; }
  })());
  setCap('WebTransport', 'WebTransport' in window);
  setCap('getUserMedia', !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
  setCap('ServiceWorker', 'serviceWorker' in navigator);
  setCap('Fullscreen API', !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen));
  setCap('PointerEvent', 'PointerEvent' in window);
  setCap('TouchEvent', 'ontouchstart' in window);
  setCap('maxTouchPoints', navigator.maxTouchPoints);
  setCap('Gamepad API', 'getGamepads' in navigator);
  setCap('hardwareConcurrency', navigator.hardwareConcurrency);
  setCap('deviceMemory', navigator.deviceMemory || 'n/a');
  setCap('connection', navigator.connection ? { type: navigator.connection.effectiveType, downlink: navigator.connection.downlink } : 'n/a');

  report.screen = {
    screen: screen.width + 'x' + screen.height,
    avail: screen.availWidth + 'x' + screen.availHeight,
    inner: innerWidth + 'x' + innerHeight,
    dpr: devicePixelRatio,
  };
  row('screen', report.screen);
  addEventListener('resize', () => { report.screen.inner = innerWidth + 'x' + innerHeight; });

  // ---- label ----
  document.querySelectorAll('.lbl').forEach((b) => b.addEventListener('click', () => {
    report.label = b.dataset.label;
    document.querySelectorAll('.lbl').forEach((x) => x.classList.toggle('primary', x === b));
  }));

  // ---- live tests ----
  const live = report.live;
  const say = (s) => { $('live').textContent = s; };
  let jsm = null, audioEl = null, toneCtx = null;

  $('t-video').onclick = () => {
    const v = $('vid');
    const t0 = performance.now();
    const st = { started: false, error: null, framesAdvanced: 0 };
    live.videoElement = st;
    let last = -1;
    v.currentTime = 0;
    v.play().then(() => { st.started = true; }).catch((e) => { st.error = e.name + ': ' + e.message; });
    const iv = setInterval(() => {
      if (v.currentTime !== last) { st.framesAdvanced++; last = v.currentTime; }
      st.currentTime = +v.currentTime.toFixed(2);
      st.paused = v.paused;
      st.elapsed = Math.round((performance.now() - t0) / 1000);
      say('<video>: paused=' + v.paused + ' t=' + st.currentTime + ' advances=' + st.framesAdvanced + (st.error ? ' err=' + st.error : ''));
      if (st.elapsed >= 12) clearInterval(iv);
    }, 500);
    v.addEventListener('pause', () => { st.pausedEvents = (st.pausedEvents || 0) + 1; });
  };

  $('t-canvas').onclick = () => {
    if (jsm) jsm.destroy();
    const st = { frames: 0, established: false, audio: null };
    live.canvasJsmpeg = st;
    const t0 = performance.now();
    jsm = new JSMpeg.Player('/probe-clip.ts', {
      canvas: $('cv'), loop: true, autoplay: true, audio: true,
      onSourceEstablished: () => { st.established = true; },
      onVideoDecode: () => { st.frames++; },
    });
    if (jsm.audioOut && jsm.audioOut.unlock) jsm.audioOut.unlock(() => { st.audioUnlocked = true; });
    const iv = setInterval(() => {
      st.elapsed = Math.round((performance.now() - t0) / 1000);
      st.fps = +(st.frames / Math.max(1, st.elapsed)).toFixed(1);
      st.audio = jsm && jsm.audioOut ? (jsm.audioOut.context ? jsm.audioOut.context.state : 'no-context') : 'disabled';
      st.wasm = !!(jsm && jsm.wasmModule);
      say('canvas: frames=' + st.frames + ' fps~' + st.fps + ' audioCtx=' + st.audio + ' wasm=' + st.wasm);
      if (st.elapsed >= 12) clearInterval(iv);
    }, 500);
  };

  $('t-audio').onclick = () => {
    if (audioEl) audioEl.pause();
    const st = { started: false, error: null };
    live.audioElement = st;
    audioEl = new Audio('/probe-tone.mp3');
    audioEl.loop = true;
    audioEl.play().then(() => { st.started = true; say('<audio> playing - can you hear a tone?'); })
      .catch((e) => { st.error = e.name + ': ' + e.message; say('<audio> error ' + st.error); });
    setTimeout(() => { st.currentTime = +audioEl.currentTime.toFixed(2); st.paused = audioEl.paused; }, 5000);
  };

  $('t-tone').onclick = () => {
    const st = {};
    live.webAudioTone = st;
    try {
      toneCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = toneCtx.createOscillator();
      const g = toneCtx.createGain();
      g.gain.value = 0.1;
      o.frequency.value = 440;
      o.connect(g).connect(toneCtx.destination);
      o.start();
      st.state = toneCtx.state;
      setTimeout(() => { st.stateAfter2s = toneCtx.state; st.time = +toneCtx.currentTime.toFixed(2); }, 2000);
      say('WebAudio tone: state=' + toneCtx.state);
    } catch (e) { st.error = e.message; }
  };

  $('t-stop').onclick = () => {
    $('vid').pause();
    if (jsm) { jsm.destroy(); jsm = null; }
    if (audioEl) audioEl.pause();
    if (toneCtx) toneCtx.close();
    say('stopped');
  };

  // ---- input tests ----
  const tp = $('touchpad');
  const tctx = tp.getContext('2d');
  tctx.fillStyle = '#1b1b1b'; tctx.fillRect(0, 0, tp.width, tp.height);
  const inp = report.input;
  inp.pointerTypes = {};
  tp.addEventListener('pointermove', (e) => {
    inp.pointerTypes[e.pointerType] = (inp.pointerTypes[e.pointerType] || 0) + 1;
    const r = tp.getBoundingClientRect();
    tctx.fillStyle = '#0d9488';
    tctx.fillRect((e.clientX - r.left) * tp.width / r.width - 2, (e.clientY - r.top) * tp.height / r.height - 2, 4, 4);
    $('touchinfo').textContent = 'pointer events: ' + JSON.stringify(inp.pointerTypes);
  });
  tp.addEventListener('touchstart', () => { inp.touchEvents = true; }, { passive: true });
  $('kbd').addEventListener('focus', () => { inp.kbdFocus = true; setTimeout(() => { inp.innerAfterFocus = innerWidth + 'x' + innerHeight; }, 800); });
  $('kbd').addEventListener('input', (e) => { inp.typed = $('kbd').value; inp.inputType = e.inputType; });
  $('kbd').addEventListener('compositionstart', () => { inp.composition = true; });

  // ---- send ----
  $('send').onclick = () => {
    report.sentAt = new Date().toISOString();
    fetch('/probe/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) })
      .then((r) => r.json()).then((j) => { $('sent').textContent = j.ok ? 'Saved (' + report.label + '). Thanks!' : 'Failed'; })
      .catch((e) => { $('sent').textContent = 'Failed: ' + e.message; });
  };
})();
