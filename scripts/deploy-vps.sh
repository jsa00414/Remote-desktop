#!/usr/bin/env bash
# Deploy WireGuard Easy (wg-easy) to a remote VPS over SSH.
#
# Required:
#   VPS_HOST          e.g. 74.208.54.132
#   VPS_USER          e.g. root
# Auth (one of):
#   VPS_SSH_PRIVATE_KEY   private key contents
#   VPS_SSH_PASSWORD      password (needs sshpass)
#
# Optional:
#   VPS_DEPLOY_PATH=/opt/wireguard
#   WG_HOST             public IP/DNS advertised to clients (defaults to VPS_HOST)
#   WG_PORT=51820
#   UI_PORT=51821
#   INSECURE=true
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VPS_HOST="${VPS_HOST:?Set VPS_HOST}"
VPS_USER="${VPS_USER:-root}"
VPS_DEPLOY_PATH="${VPS_DEPLOY_PATH:-/opt/wireguard}"
WG_HOST="${WG_HOST:-$VPS_HOST}"
WG_PORT="${WG_PORT:-51820}"
UI_PORT="${UI_PORT:-51821}"
INSECURE="${INSECURE:-true}"

TMP_KEY=""
cleanup() {
  [[ -n "${TMP_KEY}" && -f "${TMP_KEY}" ]] && rm -f "${TMP_KEY}"
}
trap cleanup EXIT

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)

if [[ -n "${VPS_SSH_PRIVATE_KEY:-}" ]]; then
  TMP_KEY="$(mktemp)"
  printf '%s\n' "$VPS_SSH_PRIVATE_KEY" >"$TMP_KEY"
  chmod 600 "$TMP_KEY"
  SSH_OPTS+=(-i "$TMP_KEY")
  SCP=(scp "${SSH_OPTS[@]}")
  SSH=(ssh "${SSH_OPTS[@]}")
elif [[ -n "${VPS_SSH_PASSWORD:-}" ]]; then
  command -v sshpass >/dev/null || {
    echo "sshpass is required when using VPS_SSH_PASSWORD" >&2
    exit 1
  }
  export SSHPASS="$VPS_SSH_PASSWORD"
  SCP=(sshpass -e scp "${SSH_OPTS[@]}")
  SSH=(sshpass -e ssh "${SSH_OPTS[@]}")
else
  SCP=(scp "${SSH_OPTS[@]}")
  SSH=(ssh "${SSH_OPTS[@]}")
fi

REMOTE="${VPS_USER}@${VPS_HOST}"
echo "==> Preparing ${REMOTE}:${VPS_DEPLOY_PATH}"

"${SSH[@]}" "$REMOTE" "mkdir -p '${VPS_DEPLOY_PATH}/scripts'"

"${SCP[@]}" \
  "$ROOT/docker-compose.yml" \
  "$ROOT/.env.example" \
  "$ROOT/scripts/install-docker.sh" \
  "$ROOT/scripts/firewall.sh" \
  "$ROOT/scripts/Caddyfile.vpn.example" \
  "$REMOTE:${VPS_DEPLOY_PATH}/"

"${SSH[@]}" "$REMOTE" "mv '${VPS_DEPLOY_PATH}/install-docker.sh' '${VPS_DEPLOY_PATH}/scripts/' && mv '${VPS_DEPLOY_PATH}/firewall.sh' '${VPS_DEPLOY_PATH}/scripts/' && chmod +x '${VPS_DEPLOY_PATH}/scripts/'*.sh"

"${SSH[@]}" "$REMOTE" bash -s <<EOF
set -euo pipefail
cd '${VPS_DEPLOY_PATH}'
if ! command -v docker >/dev/null 2>&1; then
  sudo bash scripts/install-docker.sh
fi
if [[ ! -f .env ]]; then
  cp .env.example .env
fi
# Keep existing secrets; refresh connection settings.
sed -i 's|^WG_HOST=.*|WG_HOST=${WG_HOST}|' .env
sed -i 's|^WG_PORT=.*|WG_PORT=${WG_PORT}|' .env
sed -i 's|^UI_PORT=.*|UI_PORT=${UI_PORT}|' .env
sed -i 's|^INSECURE=.*|INSECURE=${INSECURE}|' .env
sudo bash scripts/firewall.sh '${WG_PORT}' '${UI_PORT}' || true
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
EOF

cat <<MSG

Deployed WireGuard Easy on ${VPS_HOST}

  Admin UI:    http://${VPS_HOST}:${UI_PORT}
  WireGuard:   UDP ${WG_PORT}  (set host to ${WG_HOST} in the UI if prompted)

Open the UI, create an admin account, add a client, scan the QR code
from the WireGuard app on your phone.

Firewall tip: restrict TCP ${UI_PORT} to your IP after first login.
MSG
