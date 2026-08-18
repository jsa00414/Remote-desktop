# Speedify-style WAN bonding — complete blank copy

This folder is the **full working stack** with **no passwords, keys, or tokens**.
Copy these files onto the VPS / Flint and fill in the local secret files that are
not in git.

## What this is

Combines every live WAN on the Flint (Wi‑Fi repeater, USB LTE, phone tether,
ethernet) into one encrypted tunnel to the VPS. LAN devices share that pipe.
Traffic **exits from the VPS public IP** while connected — same model as
Speedify, not a home-IP loop.

| File | Goes on |
|------|---------|
| `wanbond.py` | VPS `/opt/wireguard/scripts/wanbond.py` and Flint `/usr/share/wanbond.py` |
| `portal/server.py` | VPS `/opt/wireguard/port-forward-ui/server.py` |
| `portal/static/*` | VPS `/opt/wireguard/port-forward-ui/static/` |
| `portal/port-forward-ui.service` | VPS `/etc/systemd/system/port-forward-ui.service` |
| `portal/port-forward-ui.env.example` | VPS `/opt/wireguard/port-forward-ui.env` (fill in secrets) |
| `systemd/wanbond.service` | VPS `/etc/systemd/system/wanbond.service` |
| `openwrt/wanbond.init` | Flint `/etc/init.d/wanbond` |
| `scripts/flint-post-reset.sh` | Flint after a factory reset |
| `scripts/flint-fix-tunnel.sh` | Flint if WG SSH breaks |
| `scripts/apply-lan-forwards.sh` | VPS port-forward apply script |
| `scripts/forwards.conf.example` | VPS `/opt/wireguard/scripts/forwards.conf` |

**Not in git (create on the machine):**

- `/opt/wireguard/wanbond.key` — HMAC key, same on VPS and Flint
- `/opt/wireguard/port-forward-ui.env` — portal password and router SSH
- `/etc/wanbond.key` on the Flint — same HMAC key

## Ports

The VPS listens on UDP **8443**, **51820**, and **4410**. The Flint probes those
ports and locks onto whichever one the VPS answers on. IONOS (and similar cloud
panels) often block unused UDP ports even when UFW allows them — 4410 is a
common miss; 8443 usually works. Allow at least one of those UDP ports in the
cloud firewall as well as UFW:

```
ufw allow 8443/udp
ufw allow 51820/udp
ufw allow 4410/udp
```

Do not use TCP 8443 for bonding; that port is already forwarded to Flint HTTPS.

## Commands

VPS:

```bash
python3 /opt/wireguard/scripts/wanbond.py server --key <key> --port 8443 --ports 8443,51820,4410 --mode speed
```

Flint:

```bash
python3 /usr/share/wanbond.py client --key <key> --host <vps-ip> --port 8443 --ports 8443,51820,4410 --mode speed --lan-bond
```

`--lan-bond` only steers `192.168.8.0/24` after the tunnel is healthy. LAN then
exits as the VPS public IP. Disconnect removes the policy route so Wi‑Fi uses
the home ISP again.

Keep GL.iNet Tunnel 1 **off**, `global_proxy=0`, and WireGuard AllowedIPs
`10.8.0.0/24` only. Do not set AllowedIPs to `0.0.0.0/0`.

If phones can open the portal but nothing else, Tunnel 1 is still marking LAN
for WireGuard. Run `scripts/wanbond-unkill.sh` on the Flint (the portal
Connect/Disconnect buttons do this automatically).
