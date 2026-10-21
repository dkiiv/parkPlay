# Troubleshooting

Start with the server log: `journalctl -u teslatv-web -f`. The car sends a `client hello`
(user agent, viewport, codec support), `CLIENT ERROR` lines and `player stats` there.

## v2 player

| Symptom | Check / fix |
|---|---|
| "browsing only" / "This browser lacks WebCodecs" | The browser has no `VideoDecoder`/`AudioDecoder`. Open `/probe` for a full capability report. |
| Grid loads but every video fails to start | Is `/media/*` routed by Caddy? `curl -sI https://<stream host>/media/x/1` must return 403, not 404. Add `/media/*` to the `@media` matcher in `/etc/caddy/Caddyfile`. |
| Video 403 | Ticket expired or the page wasn't loaded from `TV_PUBLIC_HOST` (Origin check). Reload the page. |
| `resolve <id>: ...` / feed errors in the log | yt-dlp failed. Update it first (`yt-dlp -U` or re-download); YouTube changes often. Run `yt-dlp -F <id>` as the `teslatv` user to see the error. |
| Home says "Sign in" after signing in | The kiosk Chrome isn't signed in to YouTube, or `/var/lib/teslatv/cookies.txt` lacks `SAPISID`. Open `/signin`, check you're signed in on youtube.com, then reload. |
| Taps take 10-20 s, `fetch failed (ETIMEDOUT)` in the log | Slow googlevideo connects. The server prefers IPv4 (`TV_DNS_ORDER=ipv4first`) and allows 2 s per connect attempt (`TV_CONNECT_ATTEMPT_MS`); check the host's outbound IPv4/IPv6 routing. |
| Stutter at 1080p | Pick 720p; 60 fps and 1080p formats cost much more to decode in the car. |
| Disk filling up | The media cache is pruned to `TV_CACHE_GB` (default 6) every 30 min, in `TV_STATE_DIR/media`. |
| UI looks broken in the car but fine on the server | Usually stale JS/CSS from the Cloudflare edge cache. `index.html` is `no-store` and asset URLs carry `?v=<hash>`; keep that when adding assets. |
| Icons show as boxes | The Tesla browser lacks many Unicode symbol glyphs. Use inline SVG, never emoji or symbol characters. |

## Access / network

| Symptom | Check / fix |
|---|---|
| `{"error":"Cloudflare Access login required"}` | The request reached the server without a valid Access JWT. Check that the app's AUD tag matches `TV_ACCESS_AUD` and the team domain matches `TV_ACCESS_TEAM`. The log shows `access verify error` details. |
| Intermittent 502 from the UI hostname | cloudflared dials `localhost` as `[::1]` first; the server listens on both. Check nothing else holds port 8090. |
| `wg-quick` segfaults in the LXC | See [networking.md](networking.md), use the bash drop-in. |
| `caddy validate` fails on `encode` | Use a named matcher (`@compressible not path ...`). The `match` sub-block is for response matchers only. |

## v1 sign-in view

| Symptom | Check / fix |
|---|---|
| Black canvas, toolbar works | `/ws/video` not connecting. Look for `video viewer connected` in the log, and make sure Caddy isn't compressing `/ws/*`. |
| Video at ~3 fps | ffmpeg timestamp mismatch between x11grab and pulse. `stream.js` regenerates PTS (`setpts`/`asetpts`); don't remove those filters. |
| Silent | `pactl list short sink-inputs` (as `teslatv`, `PULSE_SERVER=unix:/run/teslatv/pulse/native`) should list `chrome`. |
| Choppy | Run `tools/measure.sh`; the kiosk should drop <15% of frames. Keep `TV_GPU_MODE=off` (software compositor); SwiftShader GL dropped ~60% on 6 vCPU. |
| Page cut off / taps land in the wrong place | `--window-size` is in DIPs; `session.sh` divides the screen size by `TV_SCALE`. Check `xwininfo -root -tree`. |
| Car keyboard doesn't open | Tap the local type bar's field itself; the keyboard only opens for a real local `<input>`. |

## Useful commands (on the host)

```bash
systemctl status teslatv-session teslatv-web cloudflared-teslatv caddy
journalctl -u teslatv-web -f
curl -s localhost:8090/healthz; curl -s localhost:8091/healthz
du -sh /var/lib/teslatv/media
# what the kiosk shows right now
sudo -u teslatv env DISPLAY=:99 ffmpeg -v error -y -f x11grab -video_size 1920x1200 -i :99 -frames:v 1 /tmp/screen.png
sudo ls /var/lib/teslatv/probe/
```
