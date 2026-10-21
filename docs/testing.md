# Testing

You can't see the car, so every check is a script that prints PASS/FAIL and exits non-zero on
failure. Run them on the host after every player, UI or server change, then test in the car.

Most tools need the server's env file loaded:

```bash
sudo bash -c 'set -a; . /etc/parkplay/parkplay.env; set +a; node tools/<tool>.js [args]'
```

## v2 (main app)

| Tool | What it checks |
|---|---|
| `tools/api-test.js [videoId]` | yt-dlp search/resolve through the server modules, ticketed `/media` range reads through the STREAM listener (with cache timing), and the real player in headless Chrome: start time, dropped frames, A/V sync, seek, quality switch, end of video, replay. `MAXH=720` caps quality; `SOAK=<s>` adds a long-play drift/stall check. |
| `tools/ui-test.js [query]` | The whole UI in headless Chrome at the car's viewport (1888x1022), driven by touch events, with `yt.js` and `media.js` running in-process on a fresh cache: home grid, icons inside their buttons, search, drag scroll, tap to play, overlay toggle, pause, back, prefetch beacon, no client JS errors, and a grid layout check (no card overlap, no horizontal scroll) at several viewports. Screenshots go to `/tmp/ui-*.png`. `TV_MEDIA_DEBUG=1` prints a server timeline, `NO_PREFETCH=1` measures without prefetch, `TAP=deep` taps a card scrolled into view. |

Localhost tests bypass Caddy and Cloudflare. After a change to routes, also check the public
stream hostname:

```bash
curl -sI https://tv-stream.example.com/media/x/1      # expect 403 (no ticket), not 404
curl -sI https://tv-stream.example.com/anything       # expect 404
```

For latency work, measure before changing anything: run with `NO_PREFETCH=1` and without, on
several different videos with a fresh cache. One warm run proves nothing.

## v1 (sign-in browser) and helpers

| Tool | What it does |
|---|---|
| `tools/input-test.js` | Drives the kiosk through the same CDP bridge as the server: tap the search box, drag to scroll. |
| `tools/client-test.js [secs]` | Headless client against the live `/ws/video`: decoded fps, kbit/s and jitter-buffer delay. `BURST_MS=600` simulates bursty LTE. |
| `tools/measure.sh [url]` | Dropped-frame rate of YouTube inside the kiosk itself. |
| `tools/e2e-access.js <ui-host>` | Split deployment end to end with a Cloudflare Access service token (`CF_ID`, `CF_SECRET`). Delete the token afterwards. |
| `tools/ui-shot.js [out.png] [w h]` | Screenshot of the UI at a given viewport. |
| `tools/cdp-eval.js "<expr>"` | Evaluate JS in the kiosk's page. |
| `tools/push.sh [ssh-host]` | Copy the working tree to `/opt/parkplay` on the host and restart `parkplay-web`. |

## After a car test

The client reports to the server log: `client hello` (user agent, viewport, codec support),
`CLIENT ERROR` lines, and `player stats`. Read them first:

```bash
journalctl -u parkplay-web | grep -E "client hello|CLIENT ERROR|player stats"
```
