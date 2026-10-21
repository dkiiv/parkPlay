# Networking and bandwidth

The car needs a **public hostname with a valid TLS cert**. The Tesla browser refuses raw
IPs and private ranges. This doc covers how to get there without exposing a home IP.

## Two hostnames

| Hostname | Carries | Path |
|---|---|---|
| UI, e.g. `tv.example.com` | UI, JSON API, v1 control channel | Cloudflare Tunnel + Access -> `127.0.0.1:8090` |
| Stream, e.g. `tv-stream.example.com` | v2 media (`/media/*`), v1 video/audio (`/ws/video`, `/audio.mp3`) | DNS-only record -> VPS -> WireGuard -> Caddy -> `127.0.0.1:8091` |

Caddy on the host must forward `/media/*`, `/ws/video`, `/audio.mp3` and `/healthz` to the STREAM
listener (see `deploy/lxc/Caddyfile`). If `/media/*` is missing, the UI works but every video
fails with 404, and tests on localhost won't notice.

## Stream path used here

```
Tesla (LTE / Wi-Fi)
   │ https://tv-stream.example.com  (DNS-only A record -> VPS public IP)
   ▼
Public VPS (cloud firewall: TCP 80, 443, UDP 51820 open)
   │ nftables: DNAT eth0:80,443 -> 10.77.0.2, SNAT -> 10.77.0.1
   ▼ WireGuard wg-home (UDP 51820, home side dials out, keepalive 25 s)
TeslaTV host 10.77.0.2  (home LAN, behind NAT, no port forwards)
   └── Caddy :80/:443 (Let's Encrypt) -> node 127.0.0.1:8091
```

`10.77.0.0/24` is just the example tunnel subnet used in the config files; pick any private
range that doesn't collide with yours.

- TLS terminates on the **home host**. The VPS forwards raw TCP and only sees ciphertext.
- The home side initiates the tunnel (`Endpoint = <vps>:51820`, `PersistentKeepalive = 25`),
  so the home router needs no inbound rules.
- SNAT to the VPS tunnel IP means replies go back through `wg-home` without policy routing
  at home. The home host's default route stays the home ISP.
- Files: `deploy/vps/wg-home.conf.example`, `deploy/vps/teslatv.nft`,
  `deploy/lxc/wg-tv.conf.example`.
- If you have a public IP and don't mind exposing it, a plain port forward of 80/443 to the
  host works too.

## Why WireGuard and not Tailscale or Cloudflare Tunnel

**Tailscale (free Personal plan):** Tailscale doesn't meter or cap traffic on direct
peer-to-peer paths. The risk is **DERP relays**: when a direct path can't be punched, traffic
goes through Tailscale's shared relays, which are rate-limited and fair-queued. They're meant
as a fallback, not for sustained video. In the setup this was built on, some peers only reached
the VPS via DERP. A video stream that silently
falls back to DERP would stutter and lean on a free shared service. Plain WireGuard has no
relay: it either works directly or it doesn't, and it costs nothing beyond the VPS.

**Cloudflare Tunnel (for the video):** works technically, but Cloudflare's terms restrict
serving video or large non-HTML content through the free CDN/tunnel, and continuous video
traffic is exactly what that clause is about. So only the lightweight UI and
control channel go through Cloudflare (for Access); the video uses the direct path.

## Bandwidth

**v2 player:** the car receives YouTube's own encodes, so the rate depends on the video and the
chosen quality (default cap 720p, <= 30 fps preferred). Measured:

| Quality | Mbit/s | GB / hour (approx) |
|---|---|---|
| 480p30 | ~0.4 | ~0.2 |
| 720p25-30, typical | ~0.85 | ~0.4 |
| 720p, busy content | 1.5-2.5 | 0.7-1.1 |
| 1080p | higher; depends on the video | |

The player reads ahead about 120 s, so after a seek or quality change you briefly pull faster
than real time. Prefetching (feed results and cards on screen) only moves data between YouTube
and the server; it adds nothing on the VPS or car link.

The server's own traffic from googlevideo is somewhat higher than what the car receives, because
it warms the start of videos you may not watch (~1 MiB per prefetched video, 8 MiB per tapped one).

**v1 sign-in view:** ffmpeg encodes MPEG-1 only while `/signin` is open and stops 30 s after the
last viewer leaves. Presets (`TV_PRESET`): low ~0.9, med ~2, high ~3.5 Mbit/s, plus 128 kbit/s
audio.

Where it costs money:

- **VPS egress.** Check your provider's free egress allowance and per-GB price; ingress
  (home -> VPS) is usually free. At ~0.85 Mbit/s, 100 GB covers about 250 hours.
- **Car data.** Depends on your connectivity plan; on Wi-Fi it doesn't matter.
- **Home upload** carries the same bitrate as the car receives.

## Cloud firewall

Open on the VPS (provider-level firewall/NSG, not just nftables):

| Port | Why |
|---|---|
| UDP 51820 | WireGuard from home |
| TCP 443 | HTTPS + WebSockets |
| TCP 80 | ACME HTTP-01 + redirect to HTTPS (Caddy can also use TLS-ALPN on 443) |

## LXC gotcha: wg-quick segfault

On Ubuntu 26.04 in an unprivileged LXC, `wg-quick` segfaulted when systemd exec'd it
directly, but ran fine as `bash /usr/bin/wg-quick`. Fix (drop-in, shipped in
`deploy/lxc/wg-quick-bash.conf`):

```ini
# /etc/systemd/system/wg-quick@.service.d/bash.conf
[Service]
ExecStart=
ExecStart=/bin/bash /usr/bin/wg-quick up %i
ExecStop=
ExecStop=/bin/bash /usr/bin/wg-quick down %i
```

The LXC also needs `/dev/net/tun` passed through (`lxc.cgroup2.devices.allow: c 10:200 rwm`
plus the mount entry), and the WireGuard kernel module must be loaded on the **host**.
