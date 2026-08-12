#!/usr/bin/env bash
# Deploy WireGuard Easy to a VPS.
#
# Ports (defaults for this project):
#   UDP 5000  — WireGuard / internet tunnel
#   TCP 5001  — VPN controls website
#
# Required:
#   VPS_HOST
# Auth (one of):
#   VPS_SSH_PRIVATE_KEY
#   VPS_SSH_PASSWORD   (needs sshpass)
#
# Optional overrides: WG_HOST, WG_PORT, UI_PORT, INIT_PASSWORD, VPS_USER, VPS_DEPLOY_PATH
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load local .env if present (does not override already-exported vars)
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

VPS_HOST="${VPS_HOST:?Set VPS_HOST}"
VPS_USER="${VPS_USER:-root}"
VPS_DEPLOY_PATH="${VPS_DEPLOY_PATH:-/opt/wireguard}"
WG_HOST="${WG_HOST:-$VPS_HOST}"
WG_PORT="${WG_PORT:-5000}"
UI_PORT="${UI_PORT:-5001}"
INSECURE="${INSECURE:-true}"
INIT_ENABLED="${INIT_ENABLED:-true}"
INIT_USERNAME="${INIT_USERNAME:-admin}"
INIT_PASSWORD="${INIT_PASSWORD:-ChangeMe-WireGuard-5001}"
INIT_DNS="${INIT_DNS:-1.1.1.1,8.8.8.8}"

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
echo "==> Deploying WireGuard to ${REMOTE}:${VPS_DEPLOY_PATH}"
echo "    Tunnel UDP ${WG_PORT}  |  Controls http://${WG_HOST}:${UI_PORT}"

"${SSH[@]}" "$REMOTE" "mkdir -p '${VPS_DEPLOY_PATH}/scripts'"

"${SCP[@]}" \
  "$ROOT/docker-compose.yml" \
  "$ROOT/.env.example" \
  "$ROOT/scripts/install-docker.sh" \
  "$ROOT/scripts/firewall.sh" \
  "$ROOT/scripts/Caddyfile.vpn.example" \
  "$REMOTE:${VPS_DEPLOY_PATH}/"

"${SSH[@]}" "$REMOTE" "mv -f '${VPS_DEPLOY_PATH}/install-docker.sh' '${VPS_DEPLOY_PATH}/scripts/' 2>/dev/null || true; mv -f '${VPS_DEPLOY_PATH}/firewall.sh' '${VPS_DEPLOY_PATH}/scripts/' 2>/dev/null || true; mv -f '${VPS_DEPLOY_PATH}/Caddyfile.vpn.example' '${VPS_DEPLOY_PATH}/scripts/' 2>/dev/null || true; chmod +x '${VPS_DEPLOY_PATH}/scripts/'*.sh"

# Write remote .env (always refresh connection settings for this deploy)
ENV_CONTENT=$(cat <<ENV
WG_HOST=${WG_HOST}
WG_PORT=${WG_PORT}
UI_PORT=${UI_PORT}
INSECURE=${INSECURE}
INIT_ENABLED=${INIT_ENABLED}
INIT_USERNAME=${INIT_USERNAME}
INIT_PASSWORD=${INIT_PASSWORD}
INIT_DNS=${INIT_DNS}
ENV
)

"${SSH[@]}" "$REMOTE" "cat > '${VPS_DEPLOY_PATH}/.env' <<'EOF'
${ENV_CONTENT}
EOF"

"${SSH[@]}" "$REMOTE" bash -s <<EOF
set -euo pipefail
cd '${VPS_DEPLOY_PATH}'
if ! command -v docker >/dev/null 2>&1; then
  sudo bash scripts/install-docker.sh
fi

# Stop legacy remote-desktop if it is still bound to 5000
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx remote-desktop; then
  echo "Stopping old remote-desktop container..."
  docker stop remote-desktop || true
  docker rm remote-desktop || true
fi
# Also stop anything published on our ports
for c in \$(docker ps -q --filter publish=${WG_PORT} --filter publish=${UI_PORT} 2>/dev/null); do
  name=\$(docker inspect -f '{{.Name}}' "\$c" | sed 's#^/##')
  if [[ "\$name" != "wg-easy" ]]; then
    echo "Stopping container \$name occupying ports..."
    docker stop "\$c" || true
  fi
done

sudo bash scripts/firewall.sh '${WG_PORT}' '${UI_PORT}' || true
sudo docker compose pull
sudo docker compose up -d --force-recreate
sudo docker compose ps
ss -ulnp | grep -E ':${WG_PORT}\\b' || true
ss -tlnp | grep -E ':${UI_PORT}\\b' || true
EOF

cat <<MSG

Deployed on ${VPS_HOST}

  Controls website:  http://${WG_HOST}:${UI_PORT}
  WireGuard tunnel:  UDP ${WG_PORT}  (Endpoint ${WG_HOST}:${WG_PORT})
  Admin login:       ${INIT_USERNAME} / (INIT_PASSWORD)

Open the site, add a client, scan the QR code in the WireGuard app.
Change the admin password after first login.
MSG
