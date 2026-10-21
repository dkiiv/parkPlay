# TeslaTV

A self-hosted YouTube player for the Tesla in-car browser.

The car runs a local, touch-first YouTube-style UI (Home, Subscriptions, History, Watch later,
search). Videos play at YouTube's own quality: the browser decodes YouTube's H.264 video and AAC
audio with **WebCodecs** and draws onto a `<canvas>` with Web Audio for sound, so playback is not
tied to a `<video>` element. Your server finds the videos with `yt-dlp` and proxies the media
bytes. A remote Chrome on the server (the original v1 design) is kept only for the one-time
Google/YouTube sign-in.

> **Safety:** for passengers, or while parked. Watching video while driving is dangerous and
> illegal in most places. Any Drive-mode test is a technical capability check, not an invitation.

TeslaTV is an independent hobby project. It is not affiliated with, endorsed by or sponsored by
Tesla, Inc., YouTube or Google. See [Legal](#legal-trademarks-and-disclaimer).

## Why this exists

The Tesla browser pauses every `<video>` element at the OS level when the car is in Drive.
Hosted services get around this by sending video as data and drawing it on a `<canvas>`.
TeslaTV does the same on your own server, with your own YouTube account.

## Features

- Local UI: rail (Home / Subscriptions / History / Watch later / Account), search, thumbnail grid,
  watch view with overlay controls (back, -10 s, play/pause, +10 s, seek bar, quality, fullscreen).
  All navigation and scrolling happen in the car; only JSON, thumbnails and media bytes are fetched.
- Native playback: DASH fMP4 demux in JavaScript, `VideoDecoder` to canvas, `AudioDecoder` to Web
  Audio, audio clock as master clock. Prefers <= 30 fps formats, 720p by default, selectable
  360p-1080p, about 120 s of read-ahead.
- Your account: Home, Subscriptions, History and Watch later are your own after signing in once.
- Fast start: the server pre-resolves the first results of every feed or search and the cards on
  screen, and warms the first MiB of each into a disk cache.
- Auth without app passwords: the UI sits behind Cloudflare Access; media is served from a second
  hostname with short-lived HMAC tickets, so video never goes through Cloudflare.
- Tablet-style input only: tap, drag to scroll, hold. Inline SVG icons (the Tesla browser lacks
  many Unicode symbol glyphs).

## Architecture

```
 Tesla browser                                 your server (LXC / VM)
┌───────────────────────────────┐            ┌───────────────────────────────────────────────┐
│ index.html + app.js (UI)      │── JSON ───►│ APP listener 127.0.0.1:8090  (Cloudflare       │
│                               │   Access   │   Tunnel + Access; JWT re-verified)            │
│                               │            │   /  /api/feed  /api/video/:id  /api/prefetch  │
│                               │            │   /api/account  /api/ticket  /api/stats ...    │
│                               │            │        │                                       │
│                               │            │        ▼ yt.js ── yt-dlp ──► YouTube           │
│ player.js + fmp4.js           │── bytes ──►│ STREAM listener 127.0.0.1:8091 (via Caddy on a │
│  fetch DASH byte ranges       │   ticket   │   direct, non-Cloudflare hostname)             │
│  VideoDecoder ─► <canvas>     │            │   /media/<id>/<itag>?t=<ticket>                │
│  AudioDecoder ─► Web Audio    │            │        │                                       │
│                               │            │        ▼ media.js: range proxy + 1 MiB chunk   │
└───────────────────────────────┘            │          disk cache ──► googlevideo            │
                                             │                                               │
   /signin (one time): v1 remote browser ───►│ Xvfb + PulseAudio + Chrome kiosk, ffmpeg      │
   JSMpeg canvas + touch passthrough         │ MPEG-1/MP2 ─► /ws/video; CDP input via /ws/ctl│
                                             └───────────────────────────────────────────────┘
```

- **Why a proxy:** googlevideo URLs are bound to the IP that resolved them, so the car can't fetch
  them directly. The server fetches 1 MiB-aligned chunks, keeps them on disk (LRU, `TV_CACHE_GB`,
  default 6 GB) and keeps about 48 MiB read ahead of the player.
- **Sign-in (v1 remote browser):** `/signin` streams a Chrome kiosk running on the server as
  MPEG-1 video into a canvas ([JSMpeg](https://github.com/phoboslab/jsmpeg)) and forwards taps
  and typing over the Chrome DevTools Protocol. You sign in to Google/YouTube there once; the
  server then exports the YouTube cookies from that Chrome profile for `yt-dlp`. Alternatively,
  POST a Netscape `cookies.txt` to `/api/account/cookies`.

Details: [docs/architecture.md](docs/architecture.md).

## Requirements

- **Car/browser:** WebCodecs (`VideoDecoder` + `AudioDecoder`) with H.264 and AAC support. It is
  detected at runtime; without it the UI says "browsing only". Tested on a 2025 Model 3 (AMD
  Ryzen MCU). Open `/probe` in the car to get a capability report.
- **Host:** Ubuntu 24.04+ or Debian 13 (an unprivileged LXC with `nesting=1` works), about
  4-6 vCPU, 4-6 GB RAM, ~10 GB disk for the media cache, no GPU. Node.js >= 20 and
  [yt-dlp](https://github.com/yt-dlp/yt-dlp) (keep it current; YouTube changes often).
- **Network:** a Cloudflare zone (Tunnel + Access, free plan is enough) for the UI hostname, and a
  second public hostname with a valid TLS certificate for media, reachable directly (a VPS
  forwarding to your host, or a port forward). The Tesla browser refuses raw IPs and private
  addresses. See [docs/networking.md](docs/networking.md).

## Quick start

1. Cloudflare: create a remotely-managed tunnel with ingress `tv.example.com -> http://localhost:8090`,
   a proxied DNS record for `tv.example.com`, and an Access application for it (Google as the
   identity provider works from the car). Note the team domain and the application
   **Audience (AUD) tag**, and save the tunnel token to a file.
2. DNS-only `A` record `tv-stream.example.com` -> your VPS (or your public IP). Forward TCP 80/443
   to the host ([docs/networking.md](docs/networking.md)).
3. Install yt-dlp (the installer does not):

   ```bash
   sudo curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp
   sudo chmod 755 /usr/local/bin/yt-dlp
   ```

4. Install TeslaTV:

   ```bash
   sudo git clone <this repo> /opt/teslatv && cd /opt/teslatv
   sudo TV_PUBLIC_HOST=tv.example.com TV_STREAM_HOST=tv-stream.example.com \
        TV_ACCESS_TEAM=yourteam.cloudflareaccess.com TV_ACCESS_AUD=<aud tag> \
        TV_ACME_EMAIL=you@example.com TV_TUNNEL_TOKEN_FILE=/root/tunnel.token \
        ./deploy/lxc/install.sh
   ```

   This installs the packages (including Google Chrome from Google's apt repository, Caddy and
   cloudflared), creates the `teslatv` user, writes `/etc/teslatv/teslatv.env` with a random
   `TV_SECRET`, and starts `teslatv-session`, `teslatv-web`, `cloudflared-teslatv` and Caddy.
   All settings: [deploy/lxc/teslatv.env.example](deploy/lxc/teslatv.env.example).
5. In the car: open `https://tv.example.com`, pass Cloudflare Access, then
   **Account -> Sign in with Google**. Sign in to YouTube in the remote browser and go back.
   Home, Subscriptions, History and Watch later now show your account.

Check that the stream hostname forwards `/media/*`: `curl -I https://tv-stream.example.com/media/x/1`
should return 403 (no ticket), not 404. A 404 means Caddy doesn't route that path.

## Using it in the car

- Tap a thumbnail to play. Tap the video to show or hide the controls.
- **Refresh** (next to the feed title, or tap the current rail tab again) reloads the feed; on
  Home/Subscriptions/History/Watch later it hides videos already shown, so you get new suggestions.
- Quality (360p-1080p) is remembered. If the car's decoder falls behind (frames decoded after
  their display time), the player steps down one level for that video and says so.
- Account: shows whether YouTube is signed in; Sign in opens `/signin`, Sign out deletes the
  exported cookies.
- On `/signin` the remote browser has its own toolbar (back, forward, reload, home, address bar,
  keyboard, hide bar). Tap a text field in the remote page and a local input appears so the car's
  on-screen keyboard opens.

## Bandwidth

v2 sends YouTube's own bitrates to the car. Measured: 480p30 about 0.4 Mbit/s, 720p25 about
0.85 Mbit/s, busy 720p content 1.5-2.5 Mbit/s. That is roughly 0.2-1.1 GB per hour. Prefetching
happens only between the server and YouTube; it adds no traffic to the car or the VPS.
More in [docs/networking.md](docs/networking.md).

## Repo layout

| Path | What |
|---|---|
| `web/index.html`, `app.js`, `style.css` | v2 car UI |
| `web/player.js`, `web/fmp4.js` | v2 player: fMP4 demux, WebCodecs decode, canvas + Web Audio output |
| `web/signin.html`, `web/signin.js` | v1 remote-browser client, used for sign-in |
| `web/probe.html`, `web/probe.js` | browser capability probe (`/probe`) |
| `web/vendor/jsmpeg.min.js` | JSMpeg (MIT, vendored unmodified) |
| `server/src/index.js` | HTTP/WebSocket server, both listeners |
| `server/src/yt.js` | yt-dlp wrapper: feeds, search, resolve, prefetch, cookie export |
| `server/src/media.js` | ticketed byte-range proxy to googlevideo with a disk chunk cache |
| `server/src/access.js` | Cloudflare Access JWT verification + HMAC stream tickets |
| `server/src/stream.js`, `server/src/cdp.js` | v1: ffmpeg capture/encode, Chrome DevTools bridge |
| `deploy/lxc/` | `install.sh`, `session.sh` (Xvfb + PulseAudio + Chrome), Caddyfile, env example, WireGuard example |
| `deploy/systemd/` | `teslatv-session`, `teslatv-web`, `cloudflared-teslatv` units |
| `deploy/vps/` | WireGuard + nftables port forward for a public VPS |
| `docs/` | architecture, networking/bandwidth, testing, troubleshooting |
| `tools/` | tests and helpers, see [docs/testing.md](docs/testing.md) |

## Testing

Run on the host with the env file loaded; each exits non-zero on failure:

```bash
sudo bash -c 'set -a; . /etc/teslatv/teslatv.env; set +a; node tools/api-test.js'   # player end to end
sudo bash -c 'set -a; . /etc/teslatv/teslatv.env; set +a; node tools/ui-test.js'    # whole UI by touch
```

Localhost tests bypass Caddy and Cloudflare; also check the public stream hostname. See
[docs/testing.md](docs/testing.md).

## Security notes

- No app password. Identity comes from Cloudflare Access, and the server re-verifies the Access
  JWT (RS256; `aud`, `iss`, `exp`) on every request and WebSocket upgrade, so a request that
  skips Access gets 403. The APP listener binds to localhost and is reached only via cloudflared.
- The stream hostname only serves `/media/*`, `/ws/video`, `/audio.mp3` and `/healthz`. All but
  `/healthz` need an HMAC ticket (12 h by default) and the UI origin; anything else is 404 at Caddy.
  A ticket cannot control the browser or call the API.
- Chrome's DevTools port listens on `127.0.0.1` only. The server and Chrome run as the
  unprivileged `teslatv` user; the server runs under systemd sandboxing.
- The server stores YouTube cookies in `/var/lib/teslatv/cookies.txt` (mode 600) and in the Chrome
  profile. Anyone allowed by your Access policy uses that YouTube account and can drive that
  browser. Keep the policy to your own identity; consider a dedicated Google account.
- `/probe` reports are stored in `/var/lib/teslatv/probe` together with the Access user's email.

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md). The car reports its user agent, codec
support, JS errors and player stats to the server log: `journalctl -u teslatv-web`.

## Legal, trademarks and disclaimer

- TeslaTV is an independent project. It is **not affiliated with, endorsed by or sponsored by
  Tesla, Inc., YouTube, Google LLC or Cloudflare, Inc.** "Tesla", "Model 3", "YouTube", "Google",
  "Chrome" and "Cloudflare" are trademarks of their respective owners and are used here only to
  describe what the software works with.
- TeslaTV contains no YouTube content and no code from Tesla or YouTube. It is software you run
  yourself, for personal use, with your own accounts. You are responsible for complying with
  YouTube's Terms of Service, Google's terms, Cloudflare's terms and the laws where you live.
  Do not use it to download, redistribute or publicly serve other people's content.
- The software is provided "as is", without warranty (see `LICENSE`). Do not watch video while
  driving.

## License

MIT, see [LICENSE](LICENSE). Third-party components (JSMpeg, Material Icons path data) and the
external software TeslaTV uses are listed with their licenses in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
