/* TeslaTV app: local YouTube-style UI. Only data (JSON, thumbnails) and media bytes come from
 * the server; all navigation, scrolling and controls are local and instant. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };
  const fmtViews = (n) => !n ? '' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B views' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M views' : n >= 1e3 ? Math.round(n / 1e3) + 'K views' : n + ' views';
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let toastT = 0;
  function toast(msg, ms = 2500) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms); }

  // ---------- capability check ----------
  const CAN_PLAY = 'VideoDecoder' in window && 'AudioDecoder' in window;

  // ---------- stream ticket ----------
  let ticket = null;
  async function getTicket() {
    const r = await fetch('/api/ticket', { cache: 'no-store' });
    if (r.status === 403) { location.reload(); throw new Error('re-auth'); }
    ticket = await r.json();
    setTimeout(() => getTicket().catch(() => {}), Math.max(60, ticket.ttl - 600) * 1000);
    return ticket;
  }

  // Tell the server which cards are on screen once scrolling settles, so it can resolve them
  // before the tap (a cold resolve is ~3 s). Cheap: ids only, at most once per settle.
  let visIO = null, visTimer = 0, visItems = [], lastSent = '';
  const visible = new Set();
  function sendVisible() {
    const ids = [...visible].sort((x, y) => x - y).map((i) => visItems[i] && visItems[i].id).filter(Boolean).slice(0, 8);
    const key = ids.join(',');
    if (!ids.length || key === lastSent) return;
    lastSent = key;
    fetch('/api/prefetch', { method: 'POST', body: JSON.stringify({ ids }), keepalive: true }).catch(() => {});
  }
  function watchVisible(items) {
    visItems = items; visible.clear(); lastSent = '';
    if (!('IntersectionObserver' in window)) return;
    if (visIO) visIO.disconnect();
    visIO = new IntersectionObserver((ents) => {
      for (const en of ents) { const i = Number(en.target.dataset.i); if (en.isIntersecting) visible.add(i); else visible.delete(i); }
      clearTimeout(visTimer); visTimer = setTimeout(sendVisible, 700);
    }, { root: $('main'), threshold: 0.6 });
    document.querySelectorAll('#grid .card[data-i]').forEach((c) => visIO.observe(c));
  }

  // ---------- browse ----------
  const TITLES = { home: 'Home', subs: 'Subscriptions', history: 'History', later: 'Watch later', search: 'Search', channel: 'Channel' };
  const feedCache = new Map();
  let curFeed = null;

  async function loadFeed(kind, q) {
    const key = kind + '|' + (q || '');
    curFeed = key;
    document.querySelectorAll('.tab[data-kind]').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
    $('feed-title').textContent = kind === 'search' ? `Results for "${q}"` : kind === 'channel' ? (feedCache.get(key) || {}).title || 'Channel' : TITLES[kind];
    $('feed-msg').classList.add('hidden');
    const cached = feedCache.get(key);
    if (cached) render(cached, key); else { $('grid').innerHTML = skeleton(); }
    try {
      const r = await fetch('/api/feed?kind=' + encodeURIComponent(kind) + '&q=' + encodeURIComponent(q || ''), { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      feedCache.set(key, d);
      if (curFeed === key) render(d, key);
    } catch (e) {
      if (curFeed === key && !cached) { $('grid').innerHTML = ''; msg('Could not load: ' + e.message); }
    }
  }

  function skeleton() { let h = ''; for (let i = 0; i < 12; i++) h += '<div class="card sk"><div class="thumb"></div><div class="l1"></div><div class="l2"></div></div>'; return h; }
  function msg(t, html) { const m = $('feed-msg'); m.innerHTML = html || esc(t); m.classList.remove('hidden'); }

  function render(d, key) {
    if (key.startsWith('channel|') && d.title) $('feed-title').textContent = d.title;
    if (d.needsSignIn) { $('grid').innerHTML = ''; msg('', 'Sign in to see this. <a href="/signin" class="btn primary inline">Sign in with Google</a>'); return; }
    const items = d.items || [];
    if (!items.length) { $('grid').innerHTML = ''; msg('Nothing here.'); return; }
    $('grid').innerHTML = items.map((v, i) => `
      <div class="card" data-i="${i}">
        <div class="thumb"><img loading="lazy" decoding="async" src="${esc(v.thumb)}" alt="">${v.live ? '<span class="dur live">LIVE</span>' : v.duration ? `<span class="dur">${fmtTime(v.duration)}</span>` : ''}</div>
        <div class="title">${esc(v.title)}</div>
        <div class="meta"><span class="chan" data-ch="${esc(v.channelUrl)}">${esc(v.channel)}</span>${v.views ? ' · ' + fmtViews(v.views) : ''}</div>
      </div>`).join('');
    watchVisible(items);
    $('grid').onclick = (e) => {
      const ch = e.target.closest('.chan');
      if (ch && ch.dataset.ch) { loadFeed('channel', ch.dataset.ch); $('main').scrollTop = 0; return; }
      const card = e.target.closest('.card');
      if (!card || card.classList.contains('sk')) return;
      const v = items[Number(card.dataset.i)];
      if (v.live) { toast('Live streams are not supported yet'); return; }
      openWatch(v);
    };
  }

  document.querySelectorAll('.tab[data-kind]').forEach((b) => b.addEventListener('click', () => { loadFeed(b.dataset.kind); $('main').scrollTop = 0; }));
  $('searchbar').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('q').value.trim();
    $('q').blur();
    if (q) { loadFeed('search', q); $('main').scrollTop = 0; }
  });

  // ---------- account ----------
  async function refreshAccount() {
    try {
      const d = await (await fetch('/api/account', { cache: 'no-store' })).json();
      $('acct-label').textContent = d.signedIn ? 'Signed in' : 'Sign in';
      $('acct-state').textContent = d.signedIn ? 'Signed in to YouTube. Your feeds are personalised.' : 'Not signed in. Home shows generic recommendations; Subs/History/Later need sign-in.';
      $('b-signout').style.display = d.signedIn ? '' : 'none';
      return d.signedIn;
    } catch (e) { return false; }
  }
  $('b-account').onclick = () => { refreshAccount(); $('sheet').classList.remove('hidden'); };
  $('b-sheet-close').onclick = () => $('sheet').classList.add('hidden');
  $('b-signout').onclick = async () => { await fetch('/api/account/signout', { method: 'POST' }); feedCache.clear(); await refreshAccount(); toast('Signed out'); loadFeed('home'); };

  // ---------- watch ----------
  let player = null;
  let curVideo = null;
  let ovTimer = 0;
  let quality = Number(localStorage.getItem('tv.q') || 720);
  $('w-q').value = String(quality);

  function showOverlay(stay) {
    $('overlay').classList.add('show');
    clearTimeout(ovTimer);
    if (!stay) ovTimer = setTimeout(() => { if (player && player.state === 'playing') $('overlay').classList.remove('show'); }, 3500);
  }

  async function openWatch(v, at) {
    if (!CAN_PLAY) { toast('This browser lacks WebCodecs; cannot play'); return; }
    curVideo = v;
    $('browse').classList.add('hidden');
    $('watch').classList.remove('hidden');
    $('w-title').textContent = v.title;
    $('w-chan').textContent = v.channel || '';
    $('t-cur').textContent = '0:00'; $('t-dur').textContent = v.duration ? fmtTime(v.duration) : '';
    setFill(0, 0);
    spinner('Loading');
    showOverlay(true);
    history.pushState({ watch: v.id }, '', '#watch=' + v.id);
    try {
      if (!ticket) await getTicket();
      const r = await fetch('/api/video/' + v.id, { cache: 'no-store' });
      const meta = await r.json();
      if (!r.ok) throw new Error(meta.error || 'HTTP ' + r.status);
      if (curVideo !== v) return;
      $('w-title').textContent = meta.title;
      startPlayer(meta, at || 0);
    } catch (e) { spinner(null); toast('Could not play: ' + e.message, 5000); }
  }

  function startPlayer(meta, at) {
    if (player) player.destroy();
    const cv = $('screen');
    const fresh = cv.cloneNode(false); cv.parentNode.replaceChild(fresh, cv);
    player = new window.TVPlayer(fresh, {
      meta, mediaBase: ticket.audio, ticket: () => ticket.ticket,
      maxHeight: quality, aheadSec: 120,
      log: (m) => console.log('[player]', m),
      onState: (s) => {
        if (s === 'loading' || s === 'buffering') spinner(s === 'loading' ? 'Loading' : 'Buffering');
        else spinner(null);
        $('w-play-ic').setAttribute('href', s === 'paused' ? '#i-play' : '#i-pause');
        if (s === 'playing') showOverlay(false);
        if (s === 'paused' || s === 'ended') showOverlay(true);
      },
      onTime: (ct, dur, ahead) => {
        if (dragging) return;
        $('t-cur').textContent = fmtTime(ct); $('t-dur').textContent = fmtTime(dur);
        setFill(dur ? ct / dur : 0, dur ? Math.min(1, (ct + ahead) / dur) : 0);
        $('w-buf').textContent = ahead > 1 ? `${Math.round(ahead)} s buffered` : '';
      },
      onError: (m) => { spinner(null); toast('Playback error: ' + m, 6000); },
    });
    const me = player;
    player.start(at).catch((e) => { if (me.dead) return; spinner(null); toast('Playback error: ' + e.message, 6000); });
  }

  function closeWatch() {
    if (player) { reportStats(); player.destroy(); player = null; }
    curVideo = null;
    $('watch').classList.add('hidden');
    $('browse').classList.remove('hidden');
    document.body.classList.remove('full');
  }

  function spinner(text) {
    if (!text) { $('spinner').classList.add('hidden'); return; }
    $('spin-text').textContent = text; $('spinner').classList.remove('hidden');
  }
  function setFill(p, b) { $('seek-fill').style.width = (p * 100) + '%'; $('seek-knob').style.left = (p * 100) + '%'; $('seek-buf').style.width = (b * 100) + '%'; }

  $('w-back').onclick = () => { if (location.hash.startsWith('#watch')) history.back(); else closeWatch(); };
  window.addEventListener('popstate', () => { if (!location.hash.startsWith('#watch') && curVideo) closeWatch(); });
  $('w-play').onclick = (e) => { e.stopPropagation(); if (player) { if (player.state === 'ended') player.seek(0).then(() => player.play()); else player.togglePause(); } showOverlay(); };
  $('w-rew').onclick = (e) => { e.stopPropagation(); if (player) player.seek(player.currentTime() - 10); showOverlay(); };
  $('w-fwd').onclick = (e) => { e.stopPropagation(); if (player) player.seek(player.currentTime() + 10); showOverlay(); };
  $('w-full').onclick = (e) => { e.stopPropagation(); document.body.classList.toggle('full'); showOverlay(); };
  $('w-q').onchange = (e) => {
    quality = Number(e.target.value); localStorage.setItem('tv.q', quality);
    if (player && curVideo) { const at = player.currentTime(); const meta = player.meta; startPlayer(meta, at); }
  };
  // tap the video: toggle controls
  $('stage').addEventListener('click', (e) => {
    if (e.target.closest('button,select,#seek')) return;
    if ($('overlay').classList.contains('show') && player && player.state === 'playing') $('overlay').classList.remove('show'); else showOverlay();
  });

  // seek bar drag (local preview, one seek on release)
  let dragging = false;
  function seekFrac(e) { const r = $('seek').getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); }
  $('seek').addEventListener('pointerdown', (e) => { if (!player) return; dragging = true; $('seek').setPointerCapture(e.pointerId); const f = seekFrac(e); setFill(f, 0); $('t-cur').textContent = fmtTime(f * player.duration()); showOverlay(true); e.stopPropagation(); });
  $('seek').addEventListener('pointermove', (e) => { if (!dragging) return; const f = seekFrac(e); setFill(f, 0); $('t-cur').textContent = fmtTime(f * player.duration()); });
  $('seek').addEventListener('pointerup', (e) => { if (!dragging) return; dragging = false; player.seek(seekFrac(e) * player.duration()); showOverlay(); });

  // ---------- stats to server (diagnose lag without being in the car) ----------
  function reportStats() {
    if (!player) return;
    const s = player.stats;
    const body = JSON.stringify({ id: player.meta.id, q: player.vfmt && player.vfmt.height, state: player.state, t: Math.round(player.currentTime()), ahead: Math.round(player.bufferedAhead()), drawn: s.drawn, dropped: s.dropped, stalls: s.stalls, mb: +(s.fetched / 1e6).toFixed(1), startMs: s.startMs, indexMs: s.indexMs });
    try { navigator.sendBeacon('/api/stats', body); } catch (e) { /* ignore */ }
  }
  setInterval(reportStats, 15000);

  // ---------- boot ----------
  if (!CAN_PLAY) toast('This browser has no WebCodecs: browsing only', 6000);
  refreshAccount().then((signedIn) => loadFeed('home'));
})();
