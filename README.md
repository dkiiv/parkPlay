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
| `server/` | Node server: two localhost listeners. APP (`:8090`, behind Access): UI, `/ws/ctl`, `/api/ticket`, `/probe`. STREAM (`:8091`, direct): `/ws/video`, `/audio.mp3` |
| `server/src/stream.js` | ffmpeg capture/encode pipeline + fan-out to viewers |
| `server/src/cdp.js` | Chrome DevTools Protocol bridge (touch, mouse, keys, nav, single-tab kiosk) |
| `server/src/access.js` | Cloudflare Access JWT verification (RS256 against your team's certs) + HMAC stream tickets |
| `web/` | Car-side client (`index.html`, `app.js`), capability probe |
| `web/vendor/jsmpeg.min.js` | JSMpeg (MIT, vendored) |
| `deploy/lxc/` | `install.sh`, `session.sh` (Xvfb + Pulse + Chrome), Caddyfile, env example |
| `deploy/systemd/` | `teslatv-session.service`, `teslatv-web.service`, `cloudflared-teslatv.service` |
| `deploy/vps/` | WireGuard + nftables DNAT for a public front-door VPS |
| `docs/` | Architecture, networking/bandwidth, troubleshooting |
| `tools/` | `e2e-access.js` (end-to-end test with an Access service token), `push.sh` (deploy), `cdp-eval.js` (debug) |

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
re-authenticates. Enable the **One-time PIN** login method next to Google in case Google
treats the car's browser as embedded and blocks the sign-in.

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

- No app password: identity comes from Cloudflare Access, and the origin re-verifies the
  Access JWT itself, so a misrouted request that skips Access still gets 403. The UI listener
  binds to `127.0.0.1` and is only reachable through cloudflared.
- The stream host only serves `/ws/video` and `/audio.mp3`, both gated by an HMAC ticket that
  expires (default 12 h). The ticket can't be used to control the browser.
- Chrome's DevTools port listens on `127.0.0.1` only. The node server and Chrome run as
  the unprivileged `teslatv` user, and node runs under systemd sandboxing.
- `/probe` sits behind Access too. Reports are stored in `/var/lib/teslatv/probe` with the user's email.
- Anyone allowed by your Access policy controls a browser signed in to your Google account.
  Keep the policy to your own email; consider a dedicated Google account for the kiosk.

## License

MIT. JSMpeg is © Dominic Szablewski, MIT.
