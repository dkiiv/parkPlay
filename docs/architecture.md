# Architecture

TeslaTV has two parts:

- **v2 native player (the main app).** A local YouTube-style UI in the car that decodes YouTube's
  own H.264/AAC with WebCodecs. The server only supplies JSON and media bytes.
- **v1 remote browser (sign-in only).** A Chrome kiosk on the server, streamed to the car as
  MPEG-1 and controlled by touch. It is used once to sign in to Google/YouTube at `/signin`.

## Components

```text
car: index.html + app.js        local UI: rail (Home/Subs/History/Later/Account), search,
     (UI hostname, Access)      thumbnail grid, watch view with overlay controls. All navigation
                                and scrolling is local; only JSON + thumbnails come over.
     player.js + fmp4.js        fetches DASH fMP4 byte ranges (sidx index -> segments), demuxes,
                                VideoDecoder -> <canvas>, AudioDecoder -> Web Audio. The audio
                                clock is the master clock. Canvas + Web Audio keep playing in Drive.
        │ JSON: /api/* (Access)                         │ bytes: /media/<id>/<itag>?t=<ticket>
        ▼                                               ▼  (stream hostname, ticket + Origin)
server: yt.js    yt-dlp: feeds, search, resolve (H.264 video-only + AAC m4a formats), 3 h cache,
                 background prefetch of feed/search results and of the cards on screen
        media.js byte-range proxy to googlevideo (URLs are bound to the server IP), 1 MiB disk
                 chunks, ~48 MiB server read-ahead, retries on stalled upstream connects
        access.js Cloudflare Access JWT check (RS256 against https://<team>/cdn-cgi/access/certs)
                 + HMAC-SHA256 stream tickets
        stream.js, cdp.js   v1: ffmpeg screen/audio capture -> MPEG-TS; Chrome DevTools bridge
```

## Listeners and endpoints

The server (`server/src/index.js`) opens two listeners, both on localhost (the APP listener also
on `[::1]`, because cloudflared dials `localhost` as IPv6 first).

### APP: `127.0.0.1:8090` (`TV_PORT`), via Cloudflare Tunnel + Access

Every request except `/healthz` must carry a valid Access JWT (`Cf-Access-Jwt-Assertion` header
or `CF_Authorization` cookie); otherwise 403.

| Endpoint | Method | What |
|---|---|---|
| `/`, `/index.html` | GET | v2 UI. Served `no-store`; asset URLs get `?v=<content hash>` so edge caches never serve stale JS/CSS |
| `/api/feed?kind=home\|subs\|history\|later\|search\|channel&q=&fresh=1` | GET | Video list. `fresh=1` skips the cache and, for feeds, prefers videos not shown before |
| `/api/video/<id>` | GET | Public metadata + formats for the player; cancels queued prefetch and warms the first 8 MiB |
| `/api/prefetch` | POST `{ids}` | Cards currently on screen (at most 8); resolved and warmed server-side |
| `/api/account` | GET | `{signedIn, user}`; exports cookies from the kiosk Chrome when it is signed in |
| `/api/account/cookies` | POST | Upload a Netscape `cookies.txt` (alternative to `/signin`) |
| `/api/account/signout` | POST | Delete the exported cookies |
| `/api/ticket` | GET | Stream ticket (HMAC, `TV_TICKET_TTL_S`, default 12 h) and stream host |
| `/api/stats`, `/api/clientlog` | POST | Player stats and client JS errors, written to the server log |
| `/api/status` | GET | Kiosk + v1 encoder status |
| `/signin` | GET | v1 remote-browser client |
| `/ws/ctl` | WebSocket | v1 control channel (touch, keys, navigation, client hello/stats) |
| `/probe`, `/probe/report`, `/api/probes` | GET/POST | Browser capability probe and stored reports |
| `/healthz` | GET | Liveness, no auth |

### STREAM: `127.0.0.1:8091` (`TV_STREAM_PORT`), via Caddy on a direct hostname

| Endpoint | What |
|---|---|
| `/media/<id>/<itag>?t=<ticket>` | v2 media: `Range` requests answered 206 from the chunk cache; CORS for the UI origin only |
| `/ws/video?t=<ticket>` | v1 MPEG-TS video for the sign-in view |
| `/audio.mp3?t=<ticket>` | v1 fallback audio stream |
| `/healthz` | Liveness |

Requests without a valid ticket, or with an `Origin` other than `https://TV_PUBLIC_HOST`, get 403.
Caddy (`deploy/lxc/Caddyfile`) forwards only these paths; its `@media` matcher **must include
`/media/*`**, or every video 404s in the car while localhost tests still pass.

## Player

- Formats: H.264 (avc1) video-only DASH and AAC (mp4a, itag 140) DASH audio, both fragmented
  MP4. `fmp4.js` parses `moov`/`sidx` for the segment index and `moof`/`mdat` for samples.
- Prefers <= 30 fps (60 fps doubles decode and paint cost), 720p by default, user-selectable
  360p-1080p. If decoding falls behind, the app steps down one quality level for that video.
- Read-ahead about 120 s / 80 MB; audio is scheduled only ~3 s ahead so seek and pause stay cheap.
- `VideoDecoder` is configured with `prefer-hardware` when supported, otherwise software.
- The render loop stops at `ended` and restarts on seek/replay. `currentTime()` is clamped to the
  duration.

## Prefetch and cache

- Every feed/search response resolves its first 6 items and warms the first MiB of the formats
  the player will most likely pick.
- The car reports cards that are >= 60% visible once scrolling settles (`POST /api/prefetch`,
  IntersectionObserver, 0.7 s debounce, at most 8 ids). They are resolved 4 at a time.
- A tap (`/api/video/:id`) cancels the remaining prefetch queue.
- Media cache: `TV_STATE_DIR/media/<id>/<itag>/<chunk>`, 1 MiB chunks, LRU-pruned every 30 min to
  `TV_CACHE_GB` (default 6).
- Prefetch traffic is between the server and YouTube only; nothing extra goes to the car.

Typical tap-to-first-frame measured with `tools/ui-test.js` on a cold cache: about 1.2-1.4 s for
the first result after a few seconds of browsing, 2-5 s for a card scrolled into view, and
3-7 s fully cold (about 3 s of that is the yt-dlp resolve).

## Sign-in (v1 remote browser)

`teslatv-session.service` runs `deploy/lxc/session.sh`: Xvfb (`:99`, 1920x1200), a PulseAudio
null sink, and Google Chrome in kiosk mode with DevTools on `127.0.0.1:9222` and a persistent
profile in `/var/lib/teslatv/chrome-profile`. uBlock Origin Lite is loaded if present.

When the car opens `/signin`, ffmpeg captures the screen and sink and sends MPEG-1 + MP2 in
MPEG-TS over `/ws/video`; JSMpeg decodes it into a canvas. Taps and drags go back over `/ws/ctl`
and are injected as touch events via CDP. A local text field mirrors typing so the car's
on-screen keyboard can be used. The client holds incoming chunks in an adaptive jitter buffer
(250 ms-4 s). ffmpeg stops 30 s after the last viewer leaves.

After signing in, `/api/account` reads the youtube.com/google.com cookies from Chrome via CDP and
writes `TV_STATE_DIR/cookies.txt` (mode 600), which yt-dlp uses for personal feeds.

## Configuration

All settings are environment variables in `/etc/teslatv/teslatv.env`; see
`deploy/lxc/teslatv.env.example` for the full list with defaults.
