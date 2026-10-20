# Networking and bandwidth

The car needs a **public hostname with a valid TLS cert**. The Tesla browser refuses raw
IPs and private ranges. This doc covers how to get there without exposing a home IP.

## Topology used here

The UI hostname (`tv.`) goes through a Cloudflare Tunnel + Access (see README). Only the
**stream** hostname uses the path below:

```
Tesla (LTE / Wi-Fi)
   │ https://tv-stream.<domain>  (DNS-only A record -> VPS public IP)
   ▼
Public VPS (cloud firewall: TCP 80, 443, UDP 51820 open)
   │ nftables: DNAT eth0:80,443 -> 10.77.0.2, SNAT -> 10.77.0.1
   ▼ WireGuard wg-home (UDP 51820, home side dials out, keepalive 25 s)
TeslaTV host 10.77.0.2  (home LAN, behind NAT, no port forwards)
   └── Caddy :80/:443 (Let's Encrypt) -> node 127.0.0.1:8090
```

- TLS terminates on the **home host**. The VPS forwards raw TCP and only sees ciphertext.
- The home side initiates the tunnel (`Endpoint = <vps>:51820`, `PersistentKeepalive = 25`),
  so the home router needs no inbound rules.
- SNAT to the VPS tunnel IP means replies go back through `wg-home` without policy routing
  at home. The home host's default route stays the home ISP.
- Files: `deploy/vps/wg-home.conf.example`, `deploy/vps/teslatv.nft`,
  `deploy/lxc/wg-tv.conf.example`.

## Why WireGuard and not Tailscale or Cloudflare Tunnel

**Tailscale (free Personal plan):** Tailscale doesn't meter or cap traffic on direct
peer-to-peer paths. The risk is **DERP relays**: when a direct path can't be punched, traffic
goes through Tailscale's shared relays, which are rate-limited and fair-queued. They're meant
as a fallback, not for sustained video. On the homelab this was built on, the VPS reached one
home node directly but two others only `via DERP(sea)`. A video stream that silently
falls back to DERP would stutter and lean on a free shared service. Plain WireGuard has no
relay: it either works directly or it doesn't, and it costs nothing beyond the VPS.

**Cloudflare Tunnel (for the video):** works technically, but Cloudflare's terms restrict
serving video or large non-HTML content through the free CDN/tunnel, and a continuous
1–3 Mbit/s stream is exactly what that clause is about. So only the lightweight UI and
control channel go through Cloudflare (for Access); the video uses the direct path.

## Bandwidth math

Measured on YouTube content (1280x800 output, `med` preset): **1.2–1.6 Mbit/s**, so call it
~0.7 GB per hour of viewing. Presets:

| Preset | Output | Target | GB / hour (approx) |
|---|---|---|---|
| low | 960x600 @ 24 | 0.7 Mbit/s (+128k audio) | ~0.4 |
| med | 1280x800 @ 30 | 1.5 Mbit/s (+128k audio) | ~0.7 |
| high | 1920x1200 @ 30 | 3 Mbit/s (+128k audio) | ~1.4 |

Where it costs money:

- **VPS egress.** Azure's first 100 GB/month of internet egress is free, then ~$0.087/GB
  (North America). At `med`, 100 GB ≈ 140 hours/month. Ingress (home → VPS) is free.
- **Car data.** Tesla Premium Connectivity has no published cap; on Wi-Fi it doesn't matter.
- **Home upload** carries the same bitrate.

ffmpeg stops 30 s after the last viewer leaves, so an idle tab costs nothing.

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
