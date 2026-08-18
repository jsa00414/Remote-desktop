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

VPS:

```bash
python3 /opt/wireguard/scripts/wanbond.py server --key <key> --port 4410 --mode speed
```

Flint:

```bash
python3 /usr/share/wanbond.py client --key <key> --host <vps-ip> --port 4410 --mode speed --lan-bond
```

`--lan-bond` only steers `192.168.8.0/24` after three successful pings to `10.9.0.1` through `smbond`.
