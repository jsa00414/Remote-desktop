# WireGuard VPN Server

This repo runs a **WireGuard VPN server** with a web admin UI via [wg-easy](https://github.com/wg-easy/wg-easy) (Docker).

The previous remote-desktop app has been removed.

## What you get

| Piece | Detail |
|-------|--------|
| VPN | WireGuard on **UDP 51820** |
| Admin UI | Create clients, QR codes, download configs on **TCP 51821** |
| Persist | Keys/clients stored in the `etc_wireguard` Docker volume |

## Quick start (on the VPN host)

```bash
# 1. Install Docker (Ubuntu/Debian)
sudo bash scripts/install-docker.sh

# 2. Configure
cp .env.example .env
# Edit WG_HOST to this machine's public IP or DNS name

# 3. Open firewall ports
sudo bash scripts/firewall.sh

# 4. Start
docker compose up -d
```

Open **http://YOUR_PUBLIC_IP:51821**, create the admin account, then add a client and scan the QR code in the official WireGuard app.

### Client apps

- iPhone / Android: [WireGuard](https://www.wireguard.com/install/)
- Windows / macOS / Linux: same site

## Deploy to a VPS

From a machine that can SSH to the VPS:

```bash
export VPS_HOST=74.208.54.132
export VPS_USER=root
export VPS_SSH_PRIVATE_KEY="$(cat ~/.ssh/id_rsa)"   # or use VPS_SSH_PASSWORD
export WG_HOST=74.208.54.132                         # public address clients dial
./scripts/deploy-vps.sh
```

Then open `http://VPS_HOST:51821`.

## Security notes

- **UDP 51820** must be reachable from the internet for the VPN.
- **TCP 51821** is the admin UI — restrict it to your IP (cloud firewall / `ufw`) after setup.
- Prefer HTTPS: put Caddy in front (`scripts/Caddyfile.vpn.example`) and set `INSECURE=false` in `.env`.
- `INSECURE=true` allows HTTP UI for first-time setup only.

## Useful commands

```bash
docker compose ps
docker compose logs -f wg-easy
docker compose pull && docker compose up -d   # update
docker compose down                           # stop (keeps volume / clients)
```

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 51820 | UDP | WireGuard tunnel |
| 51821 | TCP | Admin web UI |

Docs: https://wg-easy.github.io/wg-easy/latest/
