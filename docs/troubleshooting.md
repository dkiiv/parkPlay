# Troubleshooting

| Symptom | Check / fix |
|---|---|
| Video plays at ~3 fps | ffmpeg timestamp mismatch between x11grab and pulse. `stream.js` regenerates PTS (`setpts=N/FPS/TB`, `asetpts=N/SR/TB`). Don't remove those filters. |
| Stream is silent | Is the video actually playing? Run `node tools/smoke.js` and `ffmpeg -i /tmp/teslatv-smoke.ts -af volumedetect -f null -`. Some YouTube live streams don't start until clicked; on-demand videos autoplay. `pactl list short sink-inputs` (as teslatv, `PULSE_SERVER=unix:/run/teslatv/pulse/native`) should list `chrome`. |
| Page is cut off / tap lands in the wrong place | Chrome's `--window-size` is in DIPs. `session.sh` divides the screen size by `TV_SCALE`. Confirm `xwininfo -root -tree` shows the window at the screen size, e.g. 1919x1199. |
| Black canvas, toolbar works | `/ws/video` not connecting. Check `journalctl -u teslatv-web` for `video viewer connected`, and that Caddy isn't compressing `/ws/*`. |
| Car keyboard doesn't open | Tap the type bar's field itself. The keyboard only opens for a real local `<input>`. Use ⌨ to open it manually. |
| `{"error":"Cloudflare Access login required"}` | Request reached the origin without a valid Access JWT. Check the app's AUD tag matches `TV_ACCESS_AUD` and the team domain matches `TV_ACCESS_TEAM`. `journalctl -u teslatv-web` shows `access verify error` details. |
| Toast "ticket 403" / video won't connect | Access session expired. Reload the page to re-authenticate. A video WS 403 can also mean the page wasn't loaded from `TV_PUBLIC_HOST` (Origin check). |
| Google sign-in blocked in the car | Use the Access **One-time PIN** (email code) option on the login page. |
| `wg-quick` segfaults in the LXC | See networking.md, use the bash drop-in. |
| `caddy validate` fails on `encode` | Use a named matcher (`@compressible not path ...`). The `match` sub-block is for response matchers only. |

## Useful commands (on the host)

```bash
systemctl status teslatv-session teslatv-web caddy
journalctl -u teslatv-web -f
curl -s localhost:8090/healthz
# what the remote browser sees right now
sudo -u teslatv env DISPLAY=:99 ffmpeg -v error -y -f x11grab -video_size 1920x1200 -i :99 -frames:v 1 /tmp/screen.png
# list probe reports from the car
sudo ls /var/lib/teslatv/probe/
```
