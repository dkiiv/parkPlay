'use strict';
// Screen + audio capture -> MPEG-TS for the car.
//   codec 'mpeg1': MPEG-1 video + MP2 audio, decoded by JSMpeg (works everywhere)
//   codec 'h264' : H.264 baseline + MP2 audio, video decoded by WebCodecs VideoDecoder when the
//                  browser has it (far better quality per bit: no smearing/ghosting in motion)
// ffmpeg runs only while at least one viewer is connected.
const { spawn } = require('child_process');
const WebSocket = require('ws');

const TS_PACKET = 188;
const MAX_BUFFERED = 6 * 1024 * 1024; // the client buffers anyway; only drop if a viewer is hopelessly behind

// Output presets. The capture is always the full virtual screen; ffmpeg scales it down.
const PRESETS = {
  low: { width: 960, fps: 30, bitrate: 900, maxrate: 1400, h264: 700 },
  med: { width: 1280, fps: 30, bitrate: 2000, maxrate: 3000, h264: 1400 },
  high: { width: 1920, fps: 30, bitrate: 3500, maxrate: 5000, h264: 2600 },
};

class Streamer {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.clients = new Set();
    this.proc = null;
    this.preset = PRESETS[cfg.preset] ? cfg.preset : 'med';
    this.leftover = Buffer.alloc(0);
    this.stopTimer = null;
    this.restartTimer = null;
    this.stats = { bytesOut: 0, drops: 0, starts: 0 };
    this.onRestart = () => {};
    this.clockBase = 0; // timestamps only need to be monotonic; the client learns the offset
    this.codec = 'mpeg1';
  }

  outSize() {
    const p = PRESETS[this.preset];
    const w = Math.min(p.width, this.cfg.screenW);
    let h = Math.round((w * this.cfg.screenH) / this.cfg.screenW);
    return { w: w - (w % 2), h: h - (h % 2) }; // even dims for the encoder
  }

  args() {
    const p = PRESETS[this.preset];
    const { w, h } = this.outSize();
    return [
      '-hide_banner', '-loglevel', 'warning', '-nostats',
      '-thread_queue_size', '512',
      '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(p.fps),
      '-video_size', `${this.cfg.screenW}x${this.cfg.screenH}`, '-i', this.cfg.display,
      '-thread_queue_size', '1024',
      '-f', 'pulse', '-fragment_size', '2048', '-i', this.cfg.pulseSource,
      // Regenerate timestamps from frame/sample counts. x11grab (wallclock) + pulse
      // (latency-adjusted) timestamps disagree and ffmpeg drops ~90% of video frames
      // otherwise (measured: 3 fps instead of 30).
      '-vf', `setpts=N/${p.fps}/TB,scale=${w}:${h}:flags=bicubic`,
      '-af', 'asetpts=N/SR/TB',
      ...(this.codec === 'h264'
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'baseline',
          '-pix_fmt', 'yuv420p', '-b:v', `${p.h264}k`, '-maxrate', `${Math.round(p.h264 * 1.5)}k`,
          '-bufsize', `${p.h264}k`, '-g', String(p.fps), '-keyint_min', String(p.fps),
          '-x264-params', 'repeat-headers=1:scenecut=0']
        // MPEG-1: qmin/qmax keep motion from collapsing into blocks; 1 s GOP so any
        // corruption heals within a second.
        : ['-c:v', 'mpeg1video', '-b:v', `${p.bitrate}k`, '-maxrate', `${p.maxrate}k`,
          '-bufsize', `${p.maxrate}k`, '-qmin', '2', '-qmax', '20', '-bf', '0', '-g', String(p.fps)]),
      '-c:a', 'mp2', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-f', 'mpegts', '-muxdelay', '0.001', 'pipe:1',
    ];
  }

  setCodec(c) {
    c = c === 'h264' ? 'h264' : 'mpeg1';
    if (c === this.codec) return false;
    this.codec = c;
    if (this.proc) this.restart();
    return true;
  }

  setPreset(name) {
    if (!PRESETS[name] || name === this.preset) return false;
    this.preset = name;
    if (this.proc) this.restart();
    return true;
  }

  addClient(ws) {
    this.clients.add(ws);
    clearTimeout(this.stopTimer);
    this.start();
    ws.on('close', () => this.removeClient(ws));
  }

  removeClient(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) {
      clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => this.stop(), this.cfg.idleStopMs);
    }
  }

  start() {
    if (this.proc) return;
    const args = this.args();
    this.log(`ffmpeg start codec=${this.codec} preset=${this.preset} out=${JSON.stringify(this.outSize())}`);
    this.stats.starts++;
    this.leftover = Buffer.alloc(0);
    const proc = spawn(this.cfg.ffmpeg, args, {
      env: { ...process.env, DISPLAY: this.cfg.display, PULSE_SERVER: this.cfg.pulseServer },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stdout.on('data', (chunk) => this.broadcast(chunk));
    proc.stderr.on('data', (d) => this.log('ffmpeg: ' + d.toString().trim()));
    proc.on('exit', (code, sig) => {
      this.log(`ffmpeg exit code=${code} sig=${sig}`);
      if (this.proc === proc) this.proc = null;
      // unexpected exit while viewers are connected -> back off and retry
      if (this.clients.size > 0 && !this.restartTimer && !proc.killedOnPurpose) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.clients.size > 0) { this.start(); this.onRestart(); }
        }, 1500);
      }
    });
  }

  stop() {
    if (!this.proc) return;
    this.proc.killedOnPurpose = true;
    this.proc.kill('SIGTERM');
    this.proc = null;
  }

  restart() {
    this.stop();
    setTimeout(() => {
      if (this.clients.size > 0) { this.start(); this.onRestart(); }
    }, 300);
  }

  // Send only whole 188-byte TS packets so a dropped chunk never desyncs the demuxer.
  // Each message is prefixed with an 8-byte float64 send timestamp (ms, monotonic) so the
  // client's jitter buffer can re-space bursty LTE delivery.
  broadcast(chunk) {
    let buf = this.leftover.length ? Buffer.concat([this.leftover, chunk]) : chunk;
    const usable = buf.length - (buf.length % TS_PACKET);
    this.leftover = buf.subarray(usable);
    if (!usable) return;
    const hdr = Buffer.allocUnsafe(8);
    hdr.writeDoubleBE(performance.now() + this.clockBase, 0);
    const out = Buffer.concat([hdr, buf.subarray(0, usable)]);
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      // Never drop part of the stream (that smears video until the next keyframe). A viewer this
      // far behind is cut off and reconnects cleanly.
      if (ws.bufferedAmount > MAX_BUFFERED) { this.stats.drops++; ws.terminate(); continue; }
      ws.send(out, { binary: true });
      this.stats.bytesOut += out.length;
    }
  }

  // Standalone MP3 stream for the <audio>-element fallback (?audio=element).
  audioStream(res) {
    const proc = spawn(this.cfg.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostats',
      '-f', 'pulse', '-fragment_size', '2048', '-i', this.cfg.pulseSource,
      '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-flush_packets', '1', '-f', 'mp3', 'pipe:1',
    ], { env: { ...process.env, PULSE_SERVER: this.cfg.pulseServer }, stdio: ['ignore', 'pipe', 'ignore'] });
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    proc.stdout.pipe(res);
    res.on('close', () => proc.kill('SIGTERM'));
  }

  status() {
    return { running: !!this.proc, viewers: this.clients.size, preset: this.preset, codec: this.codec, out: this.outSize(), ...this.stats };
  }
}

module.exports = { Streamer, PRESETS };
