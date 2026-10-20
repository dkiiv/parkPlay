# TeslaTV

A remote Chrome for the Tesla in-car browser. Browse YouTube (or anything) on a real
desktop Chrome running on your own server, and watch it on the car screen as a canvas
video stream with touch and keyboard passthrough.

Built for a 2025 Model 3 (HW4 / AMD Ryzen MCU, 16" retrofit screen), but nothing in it is
car-specific: any browser with WebSocket + canvas + WebAudio works.

> **Safety:** for passengers, or while parked. Watching video while driving is dangerous
> and illegal in most places. The Drive-mode test below is a technical capability check,
> not an invitation.

## Why this exists

The Tesla browser pauses every `<video>` element at the OS level when the car is in
Drive, and it has no WebRTC or WebCodecs. Hosted services (TeslaPlay, etc.) get around
this by sending video as data and drawing it on a `<canvas>`. TeslaTV does the same, but
instead of a curated link list it streams **a whole browser**, so you get the real YouTube
UI, your account, subscriptions, search, comments, and everything else.

```
 Tesla browser                          your server (LXC / VM)
┌──────────────────────┐   WSS         ┌───────────────────────────────────────────┐
│ <canvas>  JSMpeg     │◄── MPEG-TS ───┤ ffmpeg: x11grab + pulse -> MPEG-1 + MP2   │
│ (WebGL + WASM decode)│               │   ▲ screen          ▲ audio               │
│ WebAudio (MP2 audio) │               │ Xvfb :99       PulseAudio null sink "tv"  │
│                      │               │   ▲                 ▲                     │
│ touch / keys ────────┼── WSS JSON ──►│ node: CDP Input.dispatchTouch/Key/Text ──►│ Chrome (kiosk)
└──────────────────────┘               └───────────────────────────────────────────┘
```

- **Video:** MPEG-1 in MPEG-TS over a WebSocket, decoded by [JSMpeg](https://github.com/phoboslab/jsmpeg)
  (WASM) and drawn with WebGL. MPEG-1 has inter-frame compression, so it's ~5x cheaper than
  MJPEG streaming.
- **Audio:** MP2 in the same TS stream, played through WebAudio and kept in sync by JSMpeg.
  Fallback: `?audio=element` uses a separate MP3 stream in an `<audio>` element.
- **Input:** taps/drags go to Chrome as real **touch events** over the DevTools Protocol
  (so YouTube scrolls and scrubs natively). A mouse mode is one tap away. When a text field
  gets focus in the remote page, a type bar pops up locally so the **car's on-screen
  keyboard** opens; what you type is mirrored into the remote page.
- **Bandwidth:** ffmpeg only runs while someone is watching. Presets: low ~0.7, med ~1.5,
  high ~3 Mbit/s (measured: med ≈ 1.2–1.6 Mbit/s on YouTube content).

## Repo layout

| Path | What |
|---|---|
| `server/` | Node server: auth, static files, `/ws/video`, `/ws/ctl`, `/audio.mp3`, `/probe` |
| `server/src/stream.js` | ffmpeg capture/encode pipeline + fan-out to viewers |
| `server/src/cdp.js` | Chrome DevTools Protocol bridge (touch, mouse, keys, nav, single-tab kiosk) |
| `server/src/auth.js` | scrypt password + HMAC session cookie (`node src/auth.js hash "<pw>"`) |
| `web/` | Car-side client (`index.html`, `app.js`), login page, capability probe |
| `web/vendor/jsmpeg.min.js` | JSMpeg (MIT, vendored) |
| `deploy/lxc/` | `install.sh`, `session.sh` (Xvfb + Pulse + Chrome), Caddyfile, env example |
| `deploy/systemd/` | `teslatv-session.service`, `teslatv-web.service` |
| `deploy/vps/` | WireGuard + nftables DNAT for a public front-door VPS |
| `docs/` | Architecture, networking/bandwidth, troubleshooting |
| `tools/` | `smoke.js` (end-to-end test), `push.sh` (deploy working tree) |

## Quick start

Requirements: Ubuntu 24.04+/Debian 13 host (an unprivileged LXC with `nesting=1` works),
~4–6 vCPU, 4–6 GB RAM, no GPU. A public hostname that reaches the host on TCP 80/443
(the car can't reach private IPs and needs a real domain).

```bash
sudo git clone <this repo> /opt/teslatv
cd /opt/teslatv
sudo TV_DOMAIN=tv.example.com TV_ACME_EMAIL=you@example.com ./deploy/lxc/install.sh
# prompts once for the login password (only the scrypt hash is stored)
```

Then on the car: open `https://tv.example.com/probe` (capability report), then
`https://tv.example.com`, log in, and tap **Tap to start**.

First-time YouTube sign-in: sign in inside the remote browser like on any PC. The Chrome
profile lives in `/var/lib/teslatv/chrome-profile` and persists across restarts.

Getting traffic to the host without exposing your home IP: see
[docs/networking.md](docs/networking.md) (VPS + WireGuard DNAT, and why not Tailscale or
Cloudflare Tunnel for this).

## Using it in the car

| Control | What it does |
|---|---|
| ‹ › ↻ ⌂ | Back, forward, reload, home (YouTube) |
| Address bar | Search YouTube, or type a URL |
| ⌨ | Open the type bar manually (opens the car keyboard) |
| ☝ / ↖ | Touch mode (drag scrolls) vs mouse mode (drag selects / scrubs precisely) |
| Low / Med / High | Stream quality (restarts the encoder) |
| ⤢ | Hide the toolbar (☰ brings it back) |

YouTube keyboard shortcuts work with a Bluetooth keyboard (k = play/pause, f = fullscreen, …).

## Security notes

- Single password, scrypt-hashed. Session cookie is HMAC-signed, `HttpOnly`, `Secure`, 90 days.
  Login is rate-limited (10 failures per 10 min, global).
- Chrome's DevTools port listens on `127.0.0.1` only. The node server and Chrome run as
  the unprivileged `teslatv` user, and node runs under systemd sandboxing.
- `/probe` is public on purpose (no data, needed before login). It stores reports in
  `/var/lib/teslatv/probe`.
- Anyone with the password controls a browser signed in to your Google account. Use a
  strong password; consider a dedicated Google account.

## License

MIT. JSMpeg is © Dominic Szablewski, MIT.
