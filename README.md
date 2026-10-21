# TeslaTV

YouTube for the Tesla in-car browser, self-hosted. A local, touch-first YouTube-style UI
(home, subscriptions, history, watch later, search) that plays videos at YouTube's own
quality by decoding H.264/AAC in the browser with **WebCodecs** onto a `<canvas>`, so it keeps
playing in Drive. Your server resolves and proxies the media. A remote Chrome (the original
v1 design, described below) is kept for the one-time Google sign-in.

**v2 native player (current):** `web/index.html` + `app.js` (UI), `web/player.js` +
`web/fmp4.js` (DASH fMP4 demux, VideoDecoder → canvas, AudioDecoder → Web Audio, audio-clock
sync), `server/src/yt.js` (yt-dlp feeds/search/resolve), `server/src/media.js` (ticketed
byte-range proxy with a disk cache). The browser must support WebCodecs (it is detected at runtime).
Tests: `tools/api-test.js` (player) and `tools/ui-test.js` (whole UI by touch).

Built for a 2025 Model 3 (HW4 / AMD Ryzen MCU, 16" retrofit screen), but nothing in it is
car-specific: any browser with WebSocket + canvas + WebAudio works.

> **Safety:** for passengers, or while parked. Watching video while driving is dangerous
> and illegal in most places. The Drive-mode test below is a technical capability check,
> not an invitation.

## Why this exists

The Tesla browser pauses every `<video>` element at the OS level when the car is in
Drive. WebRTC and WebCodecs support varies by MCU and firmware (newer AMD cars have WebCodecs). Hosted services (TeslaPlay, etc.) get around
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
- **Input:** works like a tablet. Taps and drags go to Chrome as real **touch events** over the
  DevTools Protocol: tap = click, drag = scroll, hold = long-press. When a text field
  gets focus in the remote page, a type bar pops up locally so the **car's on-screen
  keyboard** opens; what you type is mirrored into the remote page.
- **Smooth playback over LTE:** each video message carries the server's send timestamp, and
  the client holds chunks in an **adaptive jitter buffer** (250 ms–4 s, sized to the 98th
  percentile of measured network jitter), releasing them with their original spacing. Bursty
  cellular delivery then plays smoothly instead of stuttering. This is the same idea as the
  "loading" pause on hosted services.
- **Bandwidth:** ffmpeg only runs while someone is watching. Presets: low ~0.7, med ~1.5,
  high ~3 Mbit/s (measured: med ≈ 1.2–1.6 Mbit/s on YouTube content).

## Repo layout

| Path | What |
|---|---|
| `server/` | Node server: two localhost listeners. APP (`:8090`, behind Access): UI, `/api/*`, `/ws/ctl`, `/probe`. STREAM (`:8091`, direct): `/media/*`, `/ws/video`, `/audio.mp3` |
| `server/src/stream.js` | ffmpeg capture/encode pipeline + fan-out to viewers |
| `server/src/cdp.js` | Chrome DevTools Protocol bridge (touch, mouse, keys, nav, single-tab kiosk) |
| `server/src/access.js` | Cloudflare Access JWT verification (RS256 against your team's certs) + HMAC stream tickets |
| `web/` | v2 car UI (`index.html`, `app.js`, `player.js`, `fmp4.js`); v1 remote-browser client used for sign-in (`signin.html`, `signin.js`); capability probe |
| `server/src/yt.js`, `server/src/media.js` | v2: yt-dlp data/resolve; media byte-range proxy + 1 MiB chunk cache (`/media/<id>/<itag>?t=` on the STREAM listener) |
| `web/vendor/jsmpeg.min.js` | JSMpeg (MIT, vendored) |
| `deploy/lxc/` | `install.sh`, `session.sh` (Xvfb + Pulse + Chrome), Caddyfile, env example |
| `deploy/systemd/` | `teslatv-session.service`, `teslatv-web.service`, `cloudflared-teslatv.service` |
| `deploy/vps/` | WireGuard + nftables DNAT for a public front-door VPS |
| `docs/` | Architecture, networking/bandwidth, troubleshooting |
| `tools/` | `api-test.js` (v2 player end-to-end), `ui-test.js` (v2 UI by touch), `e2e-access.js` (end-to-end test with an Access service token), `client-test.js` (headless client: fps / kbit/s / buffer), `measure.sh` (kiosk dropped-frame check), `push.sh` (deploy), `cdp-eval.js` (debug) |

## Authentication: Cloudflare Access, with video kept off Cloudflare

There is no password. Two hostnames:

| Hostname | Path | Auth |
|---|---|---|
| `tv.example.com` (UI, control channel) | Cloudflare Tunnel → `127.0.0.1:8090` | **Cloudflare Access** (Google / email OTP). The server also verifies the `Cf-Access-Jwt-Assertion` JWT on every request and WebSocket upgrade (RS256, `aud` + `iss` + `exp`). |
| `tv-stream.example.com` (video, audio) | DNS-only → VPS → WireGuard → Caddy → `127.0.0.1:8091` | Short-lived **HMAC ticket** from `GET /api/ticket` on the UI host (12 h default, auto-refreshed), plus an `Origin` check. |

Why split: Cloudflare's free plan restricts video streaming through its proxy, and
~1–3 Mbit/s of continuous video is exactly that. The UI is tiny, so it goes through
Access; the stream never touches Cloudflare. Requests to the stream host without a valid
ticket get 403. Anything else on that host gets 404.

Car notes: set the Access session to something long (e.g. 720 h) so the car rarely
re-authenticates. Google sign-in works from the Tesla browser (tested on a 2025 Model 3), so Google can be the only
identity provider, with auto-redirect on.

## Quick start

Requirements: Ubuntu 24.04+/Debian 13 host (an unprivileged LXC with `nesting=1` works),
~4–6 vCPU, 4–6 GB RAM, no GPU. A Cloudflare zone, plus a public VPS (or port forward) for the
stream hostname. The car can't reach private IPs.

1. Cloudflare: create a remotely-managed tunnel with ingress `tv.example.com → http://localhost:8090`,
   a proxied CNAME for `tv.example.com`, and an Access application for it. Note the team domain
   and the application **Audience (AUD) tag**.
2. DNS-only `A` record `tv-stream.example.com` → your VPS. Forward TCP 80/443 to the host
   (see [docs/networking.md](docs/networking.md)).
3. Install:

```bash
sudo git clone <this repo> /opt/teslatv && cd /opt/teslatv
sudo TV_PUBLIC_HOST=tv.example.com TV_STREAM_HOST=tv-stream.example.com \
     TV_ACCESS_TEAM=yourteam.cloudflareaccess.com TV_ACCESS_AUD=<aud tag> \
     TV_ACME_EMAIL=you@example.com TV_TUNNEL_TOKEN_FILE=/root/tunnel.token \
     ./deploy/lxc/install.sh
```

Then on the car: open `https://tv.example.com/probe` (capability report), then
`https://tv.example.com`, sign in through Access, and tap **Tap to start**.

First-time YouTube sign-in: sign in inside the remote browser like on any PC. The Chrome
profile lives in `/var/lib/teslatv/chrome-profile` and persists across restarts.

Getting the stream to the host without exposing your home IP: see
[docs/networking.md](docs/networking.md) (VPS + WireGuard DNAT, and why not Tailscale or a
Cloudflare Tunnel for the video).

## Using it in the car

v2: tap a thumbnail to play it. Tap the video to show the controls (back, −10 s, play/pause,
+10 s, seek bar, quality, fullscreen). Account → Sign in with Google opens the v1 remote browser
once, so your feeds become personal.

v1 remote browser (sign-in page):

| Control | What it does |
|---|---|
| ‹ › ↻ ⌂ | Back, forward, reload, home (YouTube) |
| Address bar | Search YouTube, or type a URL |
| ⌨ | Open the type bar manually (opens the car keyboard) |
| Low / Med / High | Stream quality (restarts the encoder) |
| ⤢ | Hide the toolbar (☰ brings it back) |

YouTube keyboard shortcuts work with a Bluetooth keyboard (k = play/pause, f = fullscreen, …).

## Security notes

- No app password: identity comes from Cloudflare Access, and the origin re-verifies the
  Access JWT itself, so a misrouted request that skips Access still gets 403. The UI listener
  binds to `127.0.0.1` and is only reachable through cloudflared.
- The stream host only serves `/media/*`, `/ws/video` and `/audio.mp3`, all gated by an HMAC ticket that
  expires (default 12 h). The ticket can't be used to control the browser.
- Chrome's DevTools port listens on `127.0.0.1` only. The node server and Chrome run as
  the unprivileged `teslatv` user, and node runs under systemd sandboxing.
- `/probe` sits behind Access too. Reports are stored in `/var/lib/teslatv/probe` with the user's email.
- Anyone allowed by your Access policy controls a browser signed in to your Google account.
  Keep the policy to your own email; consider a dedicated Google account for the kiosk.

## License

MIT. JSMpeg is © Dominic Szablewski, MIT.
