# WireGuard VPN Server

WireGuard VPN with a web control panel ([wg-easy](https://github.com/wg-easy/wg-easy)).

| Service | Port | Purpose |
|---------|------|---------|
| **WireGuard** | **UDP 5000** | Internet / VPN tunnel |
| **Controls website** | **TCP 5001** | Admin UI — clients, QR codes, configs |

## Public controls URL

On the IONOS VPS, Caddy serves the admin UI at:

**https://vpn.vpstruelord.com/**

(proxies to WireGuard Easy on TCP 5001)

DNS: Cloudflare A record `vpn` → `74.208.54.132` (proxied). No Origin Rule to port 5001 is required — Caddy terminates HTTPS on 443.

## Quick start on the VPS

```bash
cp .env.example .env
# Set WG_HOST to this server's public IP and set INIT_PASSWORD

sudo bash scripts/install-docker.sh
sudo bash scripts/firewall.sh 5000 5001
docker compose up -d
```

Open **http://YOUR_IP:5001** → log in (`admin` / your `INIT_PASSWORD`) → add a client → scan QR in the WireGuard app.

## Deploy from your laptop / CI

```bash
export VPS_HOST=74.208.54.132
export VPS_USER=root
export VPS_SSH_PRIVATE_KEY="$(cat ~/.ssh/id_rsa)"   # or VPS_SSH_PASSWORD
export WG_HOST=74.208.54.132
export WG_PORT=5000
export UI_PORT=5001
export INIT_PASSWORD='your-strong-password'
./scripts/deploy-vps.sh
```

## Client apps

Install [WireGuard](https://www.wireguard.com/install/) on phone/PC, then import the QR / config from the controls site.

## Security

- Open **UDP 5000** to the internet (VPN).
- Prefer restricting **TCP 5001** to your IP after setup.
- Change `INIT_PASSWORD` immediately; remove `INIT_*` from `.env` after first boot if you like (settings persist in the Docker volume).
- Optional HTTPS: `scripts/Caddyfile.vpn.example`, then set `INSECURE=false`.

## Commands

```bash
docker compose ps
docker compose logs -f wg-easy
docker compose pull && docker compose up -d
```
