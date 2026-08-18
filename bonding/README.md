# Speedify-style WAN bonding (ServerManager)

Combines every live WAN on the Flint (Wi‑Fi repeater, USB LTE, phone tether, ethernet) into one encrypted tunnel to the VPS. LAN devices share that pipe. Traffic **exits from the VPS public IP** while connected — same model as Speedify, not a home-IP loop.

## Behavior

| Speedify | This app |
|----------|----------|
| Connect | Start bonding — tunnel must ping before LAN is steered |
| Disconnect | Stop — LAN immediately uses local WAN again |
| Channel bonding | `--mode speed` stripes packets across WAN sockets |
| Redundant | `--mode redundant` duplicates packets on every path |
| Failover | If the tunnel dies, policy route is removed (WiFi keeps working) |
| Shared exit IP | VPS NAT (`74.208.54.132`) |
| No account | HMAC key in `/opt/wireguard/wanbond.key` |

## Commands

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
