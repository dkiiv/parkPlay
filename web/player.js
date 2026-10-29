/* ParkPlay player: plays YouTube's own H.264 + AAC without a <video> element.
 *
 *   video: DASH fMP4 segments --fetch--> FMP4.parseSegment --> WebCodecs VideoDecoder --> canvas
 *   audio: progressive m4a     --fetch--> FMP4.parseAudioMoov --> WebCodecs AudioDecoder --> WebAudio
 *
 * The audio clock (AudioContext) is the master clock; decoded frames are drawn when their pts
 * comes due. Both tracks are fetched ahead aggressively (default 120 s of video) with retries,
 * so LTE dropouts are absorbed instead of stalling.
 *
 * new Player(canvas, { mediaBase, ticket, meta, maxHeight, aheadSec, onState, onTime, log })
 */
(function () {
  'use strict';

  // A request is only abandoned when NO bytes arrive for STALL_TIMEOUT (or no headers for
  // HEAD_TIMEOUT). Bytes already received are kept and the retry resumes from there: on a slow
  // LTE link a hard total timeout discarded every partial segment and re-requested it from byte 0
  // forever (no progress at all while ~0.3 Mbit/s was still arriving).
  const HEAD_TIMEOUT = 20000;
  const STALL_TIMEOUT = 12000;

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  class Player {
    constructor(canvas, o) {
      this.canvas = canvas;
      this.ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
      // maxQueued: decoded VideoFrames held before drawing. Keep this small: hardware decoders own a
      // small pool of output surfaces and stall while the app holds them, then deliver late bursts.
      this.o = Object.assign({ maxHeight: 720, aheadSec: 120, aheadBytes: 80 * 1024 * 1024, allow60: false, maxQueued: 8 }, o);
      this.meta = o.meta;
      this.state = 'idle';
      this.gen = 0;              // bumps on every seek/destroy; stale async work checks it
      this.vq = [];              // decoded VideoFrames waiting to be drawn (sorted by ts)
      this.paused = false;
      this.rate = 1;
      this.stats = { netBytes: 0, netBusyMs: 0, fetched: 0, dropped: 0, drawn: 0, stalls: 0, startMs: 0, decoded: 0, late: 0, drawMs: 0, rafs: 0, rafGapMax: 0, vqMax: 0,
        clkStepMax: 0, clkSteps: 0, freezeMs: 0 }; // clk*: how coarsely AudioContext.currentTime advances; freezeMs: rAF gaps > 1 s (renderer frozen)
      this.clk = { raw: null, at: 0 }; // last distinct AudioContext.currentTime and when it was seen
      this.raf = 0;
      this.audioCtx = null;
      this.gain = null;
      this.volume = 1;
    }

    // ---------- public API ----------
    async start(atSec) {
      this.chooseFormats();
      // o.audioCtx: reuse the previous player's context on a quality switch (a new context created
      // without a user gesture may stay suspended under the autoplay policy)
      this.audioCtx = this.audioCtx || this.o.audioCtx || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
      if (this.audioCtx.state === 'suspended') await this.audioCtx.resume().catch(() => {});
      this.gain = this.gain || this.audioCtx.createGain();
      this.gain.connect(this.audioCtx.destination);
      this.gain.gain.value = this.volume;
      this.setState('loading');
      const t0 = performance.now(); this.stats.t0 = t0;
      await Promise.all([this.loadVideoIndex(), this.loadAudioIndex()]);
      this.stats.indexMs = Math.round(performance.now() - t0);
      await this.seek(atSec || 0);
      this.loop();
    }

    async seek(sec) {
      const g = ++this.gen;
      sec = Math.max(0, Math.min(sec, this.duration() - 0.5));
      this.flushVideo();
      this.stopAudio();
      this.seekTarget = sec;
      this.anchor = null; // (audioCtx.currentTime, mediaTime) set when audio starts
      this.setState('buffering');
      // video: decode from the segment containing `sec`, discard frames before sec
      const vi = this.segIndexAt(sec);
      this.vNext = vi;           // next segment to fetch
      this.vDecodeFrom = sec;
      // Keep segments already downloaded (or in flight) that are still useful from `sec`: a
      // rebuffer used to throw the whole buffer away and download it again over the car's LTE.
      const inWin = (seg) => seg.t + seg.dur > sec && seg.t - sec < this.o.aheadSec;
      const oldV = this.vSegs;
      this.vSegs = new Map();    // idx -> Promise<samples> (fetch cache, also prefetch)
      if (oldV) for (const [i, p] of oldV) if (i >= vi && inWin(this.vIndex.segments[i])) this.vSegs.set(i, p);
      if (this.vLast && this.vLast.i === vi && !this.vSegs.has(vi)) this.vSegs.set(vi, this.vLast.p);
      // after a stall, wait for a real cushion before restarting the clock (else it stalls again at once)
      this.needAhead = this.rebuffering ? Math.min(30, 10 + 5 * Math.max(0, this.stats.stalls - 1)) : 0;
      this.rebuffering = false;
      this.vdec && this.vdec.state !== 'closed' && this.vdec.close();
      this.makeVideoDecoder();
      // audio: start from the AAC frame at sec
      this.aNext = this.aSegIndexAt(sec);
      this.aKeep = new Map();
      if (this.aSegs) for (const [i, ent] of this.aSegs) if (i >= this.aNext && inWin(this.aIndex.segments[i])) this.aKeep.set(i, ent);
      // decoded-but-unplayed audio is dropped by stopAudio(); its downloaded bytes are kept in aDone
      if (this.aDone) for (const [i, ent] of this.aDone) if (i >= this.aNext && inWin(this.aIndex.segments[i]) && !this.aKeep.has(i)) this.aKeep.set(i, ent);
      this.aEnded = false;
      this.adec && this.adec.state !== 'closed' && this.adec.close();
      this.makeAudioDecoder();
      this.vEnded = false; this.vDecodedEnd = 0; this.vFetchedEnd = 0;
      this.pumpVideo(g);
      this.pumpAudio(g);
      if (!this.looping && !this.dead) this.loop(); // (re)start the render loop; it stops at 'ended'
    }

    togglePause() { this.paused ? this.play() : this.pause(); }
    pause() { if (this.paused) return; this.paused = true; this.audioCtx && this.audioCtx.suspend(); this.setState('paused'); }
    play() {
      if (!this.paused) return; this.paused = false;
      this.audioCtx && this.audioCtx.resume();
      this.setState(this.anchor ? 'playing' : 'buffering');
    }
    setVolume(v) { this.volume = v; if (this.gain) this.gain.gain.value = v; }
    // Observe how AudioContext.currentTime advances. The car updates it in coarse steps (see the
    // clockStepMs beacon field); desktop Chrome every 128 samples.
    ctxTime() {
      const ctx = this.audioCtx; if (!ctx) return 0;
      const raw = ctx.currentTime, now = performance.now();
      if (raw !== this.clk.raw) {
        if (this.clk.raw !== null && raw > this.clk.raw) { const step = raw - this.clk.raw; if (step > this.stats.clkStepMax) this.stats.clkStepMax = step; this.stats.clkSteps++; }
        this.clk.raw = raw; this.clk.at = now;
      }
      return raw;
    }
    currentTime() {
      if (!this.anchor) return this.seekTarget || 0;
      const t = this.anchor.media + (this.ctxTime() - this.anchor.ctx);
      const d = this.duration();
      return d ? Math.min(t, d) : t; // the audio clock keeps running after the last sample
    }
    duration() { return (this.meta && this.meta.duration) || (this.vIndex && this.vIndex.duration) || 0; }
    bufferedAhead() {
      // seconds of decodable video+audio available past the playhead (min of the two)
      const ct = this.currentTime();
      const v = this.vIndex ? Math.max(this.vFetchedEnd || 0, this.vDecodedEnd || 0, ct) - ct : 0;
      const a = (this.aFetchedTo || ct) - ct;
      return Math.max(0, Math.min(v, a));
    }

    // Seamless quality switch. `next` is a new, not yet started Player (sharing this audioCtx). It
    // starts at the end of this player's buffer and holds there while this one plays out what it
    // already downloaded (no more fetching here, so the link is all next's). At the boundary, or
    // if this player stalls first, onSwap() runs and next takes over. With little buffered it
    // just cuts over at the current time.
    handoff(next, onSwap) {
      const ct = this.currentTime(), ahead = this.bufferedAhead();
      this.keepCtx = true;
      if (ahead < 6 || this.state !== 'playing') {
        this.destroy(); onSwap && onSwap(); return next.start(ct);
      }
      this.noFetch = true;
      // Abort this player's in-flight downloads: they are past the switch point (B is the end of the
      // contiguous buffer) and would otherwise hog a slow link for a minute while `next` starves.
      for (const ac of this.acs || []) ac.abort();
      const B = ct + ahead - 1;
      // same audio track in both: hand over the audio already downloaded (it runs far past B)
      // instead of fetching it again; seek() in next keeps the entries from B on
      next.aSegs = new Map([...(this.aDone || []), ...(this.aSegs || [])].filter(([, e]) => !e.loading));
      next.hold = true;
      const started = next.start(B);
      return new Promise((resolve) => {
        const iv = setInterval(() => {
          if (next.dead) { clearInterval(iv); resolve(); return; }
          if (this.dead || this.currentTime() >= B - 0.05 || this.state === 'buffering' || this.state === 'error') {
            clearInterval(iv);
            if (!this.dead) this.destroy();
            onSwap && onSwap();
            next.hold = false;
            resolve(started);
          }
        }, 40);
      });
    }

    destroy() {
      this.gen++; this.dead = true;
      cancelAnimationFrame(this.raf);
      this.flushVideo();
      this.stopAudio();
      try { this.vdec && this.vdec.state !== 'closed' && this.vdec.close(); } catch (e) { /* closed */ }
      try { this.adec && this.adec.state !== 'closed' && this.adec.close(); } catch (e) { /* closed */ }
      try { this.gain && this.gain.disconnect(); } catch (e) { /* gone */ }
      try { if (this.audioCtx && !this.keepCtx) this.audioCtx.close(); } catch (e) { /* closed */ }
    }

    // ---------- formats ----------
    chooseFormats() {
      const vids = this.meta.video.filter((f) => f.height <= this.o.maxHeight);
      // 60 fps formats cost 2x decode + paint on the car for little gain on a car screen:
      // take the best <=30 fps format, unless the 60 fps one is the only way to reach >=720p.
      const by = (a, b) => (b.height - a.height) || ((a.fps || 30) - (b.fps || 30));
      const v30 = vids.filter((f) => (f.fps || 30) <= 31).sort(by);
      const vAll = vids.slice().sort(by);
      this.vfmt = (v30[0] && (v30[0].height >= Math.min(720, this.o.maxHeight) || !this.o.allow60)) ? v30[0] : (vAll[0] || this.meta.video[0]);
      if (this.o.allow60 && vAll[0] && vAll[0].height > (v30[0] ? v30[0].height : 0)) this.vfmt = vAll[0];
      this.afmt = this.meta.audio[0];
      this.o.log && this.o.log(`formats video ${this.vfmt.itag} ${this.vfmt.height}p${this.vfmt.fps} ${this.vfmt.codec} audio ${this.afmt.itag}`);
    }

    // Goodput accounting: bytes received / wall time with at least one request open, so idle time
    // while the buffer is full doesn't count as a slow network. Read via netSample().
    netBegin() { if (!this.netActive) this.netT0 = performance.now(); this.netActive = (this.netActive || 0) + 1; }
    netEnd() { this.netActive--; if (!this.netActive) this.stats.netBusyMs += performance.now() - this.netT0; }
    netSample() { return { bytes: this.stats.netBytes, busyMs: this.stats.netBusyMs + (this.netActive ? performance.now() - this.netT0 : 0) }; }
    // Recent goodput (kbit/s over the last ~6 s of busy time), null until there is enough data.
    netKbpsRecent() {
      const now = performance.now(), n = this.netSample();
      const h = this.netHist || (this.netHist = []);
      if (!h.length || now - h[h.length - 1].t > 250) h.push({ t: now, bytes: n.bytes, busyMs: n.busyMs });
      while (h.length > 2 && now - h[1].t > 6000) h.shift();
      const a = h[0], dB = n.busyMs - a.busyMs;
      return dB > 1500 ? (n.bytes - a.bytes) * 8 / dB : null;
    }
    // Parallel video requests. Normally 3 (hides the per-request round trip on high-latency LTE).
    // On a link slower than the stream with a short buffer, 1: parallel requests would split the
    // link so the segment needed next arrives last.
    videoParallel() {
      const k = this.netKbpsRecent();
      return k != null && k < this.mediaKbps() * 1.3 && this.bufferedAhead() < 30 ? 1 : 3;
    }
    // Called every stats window (15 s) with that window's goodput and stall count. Returns the
    // height to step down to, or 0. A window is bad when the link is slower than 1.25x the stream
    // AND the buffer, at the drain rate measured since the last window, runs out within 90 s (or
    // a stall happened). Step down after 2 bad windows, or at once on a stall with the buffer
    // empty. Using the measured drain (not just kbps vs the average bitrate) avoids dropping to a
    // lower quality on a link that is a bit slow but still leaves minutes of buffer; deciding while
    // there is buffer left lets handoff() switch without a gap.
    netStepDown(kbps, stalls, levels) {
      const ahead = this.bufferedAhead(), prev = this.prevAhead;
      this.prevAhead = ahead;
      if (kbps == null || (this.state !== 'playing' && this.state !== 'buffering')) { this.netBad = 0; return 0; }
      const slow = kbps < this.mediaKbps() * 1.25;
      const drain = prev != null ? (prev - ahead) / 15 : 0; // buffer seconds lost per second
      const runsOut = drain > 0.05 && ahead / drain < 90;
      this.netBad = slow && (stalls > 0 || runsOut) ? (this.netBad || 0) + 1 : 0;
      if (!(this.netBad >= 2 || (slow && stalls > 0 && ahead < 5))) return 0;
      this.netBad = 0;
      const cur = this.vfmt.height;
      return levels.filter((h) => h < cur && this.meta.video.some((f) => f.height === h)).pop() || 0;
    }
    // average bitrate of the chosen video + audio formats, kbit/s
    mediaKbps() { const d = this.duration() || 1; return ((this.vfmt && this.vfmt.size || 0) + (this.afmt && this.afmt.size || 0)) * 8 / d / 1000; }

    url(f) { return `${this.o.mediaBase}/media/${this.meta.id}/${f.itag}?t=${encodeURIComponent(this.o.ticket())}`; }

    async range(f, start, end, tries = 6) {
      const total = end - start + 1;
      const out = new Uint8Array(total);
      let got = 0, fails = 0;
      while (got < total) {
        if (this.dead) throw new Error('destroyed');
        const ac = new AbortController();
        let to = setTimeout(() => ac.abort(), HEAD_TIMEOUT);
        const kick = () => { clearTimeout(to); to = setTimeout(() => ac.abort(), STALL_TIMEOUT); };
        const before = got;
        (this.acs || (this.acs = new Set())).add(ac);
        this.netBegin();
        try {
          const r = await fetch(this.url(f), { headers: { Range: `bytes=${start + got}-${end}` }, signal: ac.signal, cache: 'no-store' });
          if (r.status !== 206 && !(r.status === 200 && start + got === 0)) throw new Error('HTTP ' + r.status);
          kick();
          const take = (v) => { const n = Math.min(v.byteLength, total - got); out.set(n === v.byteLength ? v : v.subarray(0, n), got); got += n; this.stats.fetched += n; this.stats.netBytes += n; };
          if (r.body && r.body.getReader) {
            const rd = r.body.getReader();
            while (got < total) { const { done, value } = await rd.read(); if (done) break; kick(); take(value); }
            if (got >= total) rd.cancel().catch(() => {});
          } else take(new Uint8Array(await r.arrayBuffer()));
          if (got < total) throw new Error('short read');
        } catch (e) {
          if (this.noFetch) throw new Error('handoff'); // aborted by handoff(): bytes past the switch point are useless
          fails = got > before ? 0 : fails + 1; // progress resets the retry budget
          this.o.log && this.o.log(`fetch ${f.itag} ${start}-${end} interrupted at ${got}/${total} (${e.message}), retry ${fails}`);
          if (this.dead) throw new Error('destroyed');
          if (fails >= tries) throw new Error('network: gave up fetching media');
          if (fails) await sleep(Math.min(8000, 500 * 2 ** (fails - 1)));
        } finally { clearTimeout(to); this.acs.delete(ac); this.netEnd(); }
      }
      return out;
    }

    // ---------- video ----------
    async loadVideoIndex() {
      let n = 64 * 1024;
      for (;;) {
        const head = await this.range(this.vfmt, 0, n - 1);
        const init = FMP4.parseInit(head);
        if (init) {
          this.vIndex = init;
          const base = { codec: init.codec, description: init.description, codedWidth: init.width, codedHeight: init.height };
          // hardware if the car has it (it does: AMD Ryzen MCU), otherwise software; never fail on "prefer-hardware"
          for (const hw of ['no-preference', 'prefer-software']) {
            const cfg = Object.assign({ hardwareAcceleration: hw }, base);
            try { const r = await VideoDecoder.isConfigSupported(cfg); if (r.supported) { this.vConfig = cfg; break; } } catch (e) { /* try next */ }
          }
          if (!this.vConfig) throw new Error('this browser cannot decode ' + init.codec);
          this.stats.hw = this.vConfig.hardwareAcceleration;
          return;
        }
        n *= 4;
        if (n > 8 * 1024 * 1024) throw new Error('could not find video index');
      }
    }

    segIndexAt(t) {
      const s = this.vIndex.segments; let i = 0;
      while (i + 1 < s.length && s[i + 1].t <= t) i++;
      return i;
    }

    makeVideoDecoder() {
      const g = this.gen;
      this.vdec = new VideoDecoder({
        output: (frame) => {
          if (g !== this.gen) { frame.close(); return; }
          const ts = frame.timestamp / 1e6;
          if (ts + 0.001 < this.vDecodeFrom) { frame.close(); return; } // pre-roll after seek
          this.stats.decoded++;
          if (this.anchor && ts < this.currentTime() - 0.05) this.stats.late++; // decoder fell behind the clock
          this.vq.push(frame);
          if (this.vq.length > this.stats.vqMax) this.stats.vqMax = this.vq.length;
        },
        error: (e) => { this.o.log && this.o.log('VideoDecoder error: ' + e.message); this.fatal('video decode error: ' + e.message); },
      });
      this.vdec.configure(this.vConfig);
      this.canvas.width = this.vIndex.width; this.canvas.height = this.vIndex.height;
    }

    fetchSeg(i) {
      if (!this.vSegs.has(i)) {
        const s = this.vIndex.segments[i];
        this.vSegs.set(i, this.range(this.vfmt, s.offset, s.offset + s.size - 1).then((b) => FMP4.parseSegment(b, this.vIndex, s.offset)));
      }
      return this.vSegs.get(i);
    }

    // Network side: keep segments up to aheadSec past the playhead fetched (3 in flight).
    async prefetchVideo(g) {
      const segs = this.vIndex.segments;
      while (g === this.gen && !this.dead) {
        if (this.noFetch) { await sleep(300); continue; }
        const ct = this.currentTime();
        let inflight = 0, i = this.vNext, contiguousEnd = null;
        for (; i < segs.length && segs[i].t - ct < this.o.aheadSec && segs[i].offset - segs[this.vNext].offset < this.o.aheadBytes; i++) {
          const st = this.vSegState.get(i);
          if (st === 'done') { if (contiguousEnd === i - 1 || contiguousEnd === null && i === this.vNext) contiguousEnd = i; continue; }
          if (st === 'loading') { inflight++; continue; }
          if (inflight >= this.videoParallel()) break;
          inflight++;
          const k = i; // own binding: `i` is shared across iterations (declared outside the loop)
          this.vSegState.set(k, 'loading');
          this.fetchSeg(k).then(() => { if (g === this.gen && this.vSegState.has(k)) this.vSegState.set(k, 'done'); },
            () => { if (g === this.gen) { this.vSegState.delete(k); this.vSegs.delete(k); } });
        }
        // contiguous fetched range from the decode point (the segment being decoded counts)
        let j = this.vNext + 1; while (this.vSegState.get(j) === 'done') j++;
        this.vFetchedEnd = segs[Math.min(j - 1, segs.length - 1)].t + segs[Math.min(j - 1, segs.length - 1)].dur;
        await sleep(300);
      }
    }

    // Decode side: feed segments in order, keeping only ~1.5 s of decoded frames in memory.
    async pumpVideo(g) {
      const segs = this.vIndex.segments;
      this.vSegState = new Map();
      for (const [k, p] of this.vSegs) { // kept across a rebuffer/seek: re-track under this generation
        this.vSegState.set(k, 'loading');
        p.then(() => { if (g === this.gen && this.vSegState.has(k)) this.vSegState.set(k, 'done'); },
          () => { if (g === this.gen) { this.vSegState.delete(k); this.vSegs.delete(k); } });
      }
      this.prefetchVideo(g);
      while (g === this.gen && this.vNext < segs.length) {
        if (this.vq.length >= this.o.maxQueued || (this.vdec.decodeQueueSize || 0) > 10) { await sleep(30); continue; }
        let samples;
        try { samples = await this.fetchSeg(this.vNext); } catch (e) { if (g === this.gen && !this.noFetch) this.fatal(e.message); return; } // handoff: run dry quietly
        if (g !== this.gen) return;
        const idx = this.vNext;
        const s = segs[idx];
        for (const smp of samples) {
          if (g !== this.gen) return;
          this.vdec.decode(new EncodedVideoChunk({ type: smp.key ? 'key' : 'delta', timestamp: Math.round(smp.pts * 1e6), duration: Math.round(smp.dur * 1e6), data: smp.data }));
          while (g === this.gen && (this.vq.length >= this.o.maxQueued || this.vdec.decodeQueueSize > 10)) await sleep(15);
        }
        this.vDecodedEnd = s.t + s.dur;
        this.vLast = { i: idx, p: this.vSegs.get(idx) }; // reused if a stall restarts in this segment
        this.vSegs.delete(idx); this.vSegState.delete(idx); // encoded bytes no longer needed
        this.vNext++;
      }
      if (g === this.gen && this.vNext >= segs.length) { try { await this.vdec.flush(); } catch (e) { /* reset */ } this.vEnded = true; }
    }

    flushVideo() { for (const f of this.vq) f.close(); this.vq = []; }

    // ---------- audio ----------
    async loadAudioIndex() {
      let n = 64 * 1024;
      for (;;) {
        const head = await this.range(this.afmt, 0, n - 1);
        let init = null;
        try { init = FMP4.parseInit(head); } catch (e) { init = null; }
        if (init && init.kind === 'audio') { this.aIndex = init; this.audio = init; return; }
        n *= 4;
        if (n > 8 * 1024 * 1024) throw new Error('could not find audio index');
      }
    }

    aSegIndexAt(t) {
      const s = this.aIndex.segments; let i = 0;
      while (i + 1 < s.length && s[i + 1].t <= t) i++;
      return i;
    }

    makeAudioDecoder() {
      const g = this.gen;
      this.aPending = [];
      this.adec = new AudioDecoder({
        output: (ad) => { if (g !== this.gen) { ad.close(); return; } this.scheduleAudio(ad, g); },
        error: (e) => { this.o.log && this.o.log('AudioDecoder error: ' + e.message); this.fatal('audio decode error: ' + e.message); },
      });
      this.adec.configure({ codec: this.audio.codec, sampleRate: this.audio.sampleRate, numberOfChannels: this.audio.channels, description: this.audio.description });
      this.aSources = [];
    }

    scheduleAudio(ad, g) {
      const ctx = this.audioCtx;
      const buf = ctx.createBuffer(ad.numberOfChannels, ad.numberOfFrames, ad.sampleRate);
      for (let c = 0; c < ad.numberOfChannels; c++) {
        const plane = new Float32Array(ad.numberOfFrames);
        ad.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        buf.copyToChannel(plane, c);
      }
      const mediaT = ad.timestamp / 1e6;
      ad.close();
      if (mediaT + buf.duration < this.seekTarget) return; // pre-roll
      this.aPending.push({ buf, mediaT });
      this.aFetchedEnd = Math.max(this.aFetchedEnd || 0, mediaT + buf.duration);
      this.maybeStartPlayback(g);
      this.drainAudio(g);
    }

    // Start the clock once both tracks have a cushion (2 s audio decoded + first video frame).
    maybeStartPlayback(g) {
      if (this.anchor || g !== this.gen || this.hold) return;
      const aReady = this.aPending.length && (this.aFetchedEnd - this.aPending[0].mediaT) >= 2;
      const vReady = this.vq.length > 0 || this.vEnded;
      if (!aReady || !vReady) return;
      if (this.needAhead) {
        const need = Math.min(this.needAhead, this.duration() - this.seekTarget - 1);
        if (need > 0 && this.bufferedAhead() < need) return;
      }
      const ctx = this.audioCtx;
      const startMedia = Math.max(this.aPending[0].mediaT, this.seekTarget);
      this.anchor = { ctx: ctx.currentTime + 0.15, media: startMedia };
      this.aSched = this.anchor.ctx;
      if (!this.stats.startMs) this.stats.startMs = Math.round(performance.now() - (this.stats.t0 || performance.now()));
      this.setState(this.paused ? 'paused' : 'playing');
      this.drainAudio(g);
    }

    drainAudio(g) {
      if (!this.anchor || g !== this.gen) return;
      const ctx = this.audioCtx;
      while (this.aPending.length) {
        const { buf, mediaT } = this.aPending[0];
        if (this.anchor.ctx + (mediaT - this.anchor.media) > ctx.currentTime + 3) break;
        this.aPending.shift();
        const when = this.anchor.ctx + (mediaT - this.anchor.media);
        const end = when + buf.duration;
        if (end <= ctx.currentTime) continue; // too late (after a stall)
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.gain);
        const offset = Math.max(0, ctx.currentTime - when);
        src.start(Math.max(when, ctx.currentTime), offset);
        this.aSources.push(src);
        src.onended = () => { const i = this.aSources.indexOf(src); if (i >= 0) this.aSources.splice(i, 1); };
      }
    }

    stopAudio() {
      if (this.aSources) for (const s of this.aSources) { try { s.stop(); } catch (e) { /* done */ } }
      this.aSources = []; this.aPending = []; this.aFetchedEnd = 0;
    }

    // Network side: fetch audio segments up to aheadSec ahead (audio is tiny: ~1 MB/min).
    async prefetchAudio(g) {
      const segs = this.aIndex.segments;
      while (g === this.gen && !this.dead) {
        if (this.noFetch) { await sleep(300); continue; }
        const ct = this.currentTime();
        let inflight = 0;
        for (let i = this.aNext; i < segs.length && segs[i].t - ct < this.o.aheadSec; i++) {
          if (this.aSegs.has(i)) { if (this.aSegs.get(i).loading) inflight++; continue; }
          if (inflight >= 2) break;
          inflight++;
          const s = segs[i];
          const ent = { loading: true };
          ent.p = this.range(this.afmt, s.offset, s.offset + s.size - 1).then((b) => { ent.loading = false; return FMP4.parseSegment(b, this.aIndex, s.offset); });
          ent.p.catch(() => { if (g === this.gen) this.aSegs.delete(i); });
          this.aSegs.set(i, ent);
        }
        let j = this.aNext; while (this.aSegs.has(j) && !this.aSegs.get(j).loading) j++;
        this.aFetchedTo = j > this.aNext ? segs[j - 1].t + segs[j - 1].dur : (this.aFetchedEnd || ct);
        await sleep(300);
      }
    }

    // Decode side: decode segments in order while decoded audio is < 15 s ahead of the playhead.
    async pumpAudio(g) {
      const segs = this.aIndex.segments;
      this.aSegs = this.aKeep || new Map();
      this.aKeep = null;
      for (const [k, ent] of this.aSegs) ent.p.catch(() => { if (g === this.gen) this.aSegs.delete(k); });
      this.aFetchedTo = 0;
      this.prefetchAudio(g);
      while (g === this.gen && !this.dead && this.aNext < segs.length) {
        if (this.anchor && (this.aFetchedEnd - this.currentTime()) > 15) { await sleep(200); continue; }
        if (!this.aSegs.has(this.aNext)) { await sleep(50); continue; }
        let samples;
        try { samples = await this.aSegs.get(this.aNext).p; } catch (e) { await sleep(200); continue; }
        if (g !== this.gen) return;
        for (const smp of samples) {
          if (smp.pts + smp.dur < this.seekTarget - 0.1) continue;
          this.adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(smp.pts * 1e6), duration: Math.round(smp.dur * 1e6), data: smp.data }));
        }
        // keep the bytes until the audio has played: a stall or handoff re-decodes from here
        const done = this.aDone || (this.aDone = new Map());
        done.set(this.aNext, this.aSegs.get(this.aNext));
        const played = this.currentTime() - 2;
        for (const k of done.keys()) { const sg = segs[k]; if (sg.t + sg.dur < played) done.delete(k); }
        this.aSegs.delete(this.aNext);
        this.aNext++;
        await sleep(0);
      }
      if (g === this.gen && this.aNext >= segs.length) this.aEnded = true;
    }

    // ---------- render loop ----------
    loop() {
      if (this.looping) return;
      this.looping = true;
      const tick = () => {
        if (this.dead) return;
        this.raf = requestAnimationFrame(tick);
        const now = performance.now();
        if (this.lastRaf) { const gap = now - this.lastRaf; if (gap > this.stats.rafGapMax) this.stats.rafGapMax = Math.round(gap); if (gap > 1000) this.stats.freezeMs += Math.round(gap); }
        this.lastRaf = now; this.stats.rafs++;
        if (!this.anchor) { this.maybeStartPlayback(this.gen); return; }
        const ct = this.currentTime();
        this.drainAudio(this.gen);
        // stall detection: audio ran out -> pause the clock and rebuffer
        const audioDry = this.aFetchedEnd && ct > this.aFetchedEnd - 0.05 && !this.aEnded;
        const videoDry = !this.vEnded && !this.vq.length && this.vDecodedEnd && ct > this.vDecodedEnd + 0.5;
        if (!this.paused && (audioDry || videoDry)) {
          this.stats.stalls++;
          this.rebuffer();
          return;
        }
        // draw the newest frame whose time has come; drop older ones
        let frame = null;
        while (this.vq.length && this.vq[0].timestamp / 1e6 <= ct + 0.008) {
          if (frame) { frame.close(); this.stats.dropped++; }
          frame = this.vq.shift();
        }
        if (frame) {
          const d0 = performance.now();
          this.ctx2d.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
          this.stats.drawMs += performance.now() - d0;
          this.stats.lastFrameT = frame.timestamp / 1e6; // A/V sync check: compare with currentTime()
          frame.close();
          this.stats.drawn++;
        }
        this.o.onTime && this.o.onTime(ct, this.duration(), this.bufferedAhead());
        // meta.duration is rounded: frames stamped just past it would never come due once the clock
        // is clamped, so at the end treat anything still queued as done.
        if (this.vEnded && ct >= this.duration() - 0.3 && this.vq.length && this.vq[0].timestamp / 1e6 > ct) this.flushVideo();
        if (this.vEnded && !this.vq.length && ct >= this.duration() - 0.3) {
          this.setState('ended'); cancelAnimationFrame(this.raf); this.looping = false;
          this.o.onTime && this.o.onTime(this.duration(), this.duration(), 0);
        }
      };
      this.raf = requestAnimationFrame(tick);
    }

    rebuffer() {
      // Ran dry (network slower than playback). Restart decoding from the current position,
      // reusing every segment already downloaded or in flight.
      this.o.log && this.o.log(`stall at ${this.currentTime().toFixed(1)}s, rebuffering`);
      this.rebuffering = true; // seek() keeps the downloaded segments and sets the restart cushion
      this.seek(this.currentTime());
    }

    stopAudioSourcesOnly() { for (const s of this.aSources || []) { try { s.stop(); } catch (e) { /* done */ } } this.aSources = []; }

    setState(s) { if (s === this.state) return; this.state = s; this.o.onState && this.o.onState(s); }
    fatal(msg) { if (this.dead) return; this.setState('error'); this.o.onError && this.o.onError(msg); } // a destroyed player's in-flight work is not an error
  }

  window.TVPlayer = Player;
})();
