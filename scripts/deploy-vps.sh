#!/usr/bin/env bash
# Deploy Remote Desktop to a VPS using env secrets.
# Required: VPS_HOST, VPS_USER
# Optional: VPS_SSH_PRIVATE_KEY | VPS_SSH_PASSWORD, VPS_DEPLOY_PATH, VPS_APP_PORT, VPS_SSH_PORT
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${VPS_HOST:?VPS_HOST is required}"
USER_NAME="${VPS_USER:?VPS_USER is required}"
SSH_PORT="${VPS_SSH_PORT:-22}"
DEPLOY_PATH="${VPS_DEPLOY_PATH:-/opt/remote-desktop}"
APP_PORT="${VPS_APP_PORT:-5000}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -p "$SSH_PORT")

cleanup() {
  [[ -n "${KEY_FILE:-}" && -f "$KEY_FILE" ]] && rm -f "$KEY_FILE"
  [[ -n "${ASKPASS_FILE:-}" && -f "$ASKPASS_FILE" ]] && rm -f "$ASKPASS_FILE"
}
trap cleanup EXIT

if [[ -n "${VPS_SSH_PRIVATE_KEY:-}" ]]; then
  KEY_FILE="$(mktemp)"
  printf '%s\n' "$VPS_SSH_PRIVATE_KEY" >"$KEY_FILE"
  chmod 600 "$KEY_FILE"
  SSH_OPTS+=(-i "$KEY_FILE" -o IdentitiesOnly=yes)
elif [[ -n "${VPS_SSH_PASSWORD:-}" ]]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "sshpass is required for password auth" >&2
    exit 1
  fi
  export SSHPASS="$VPS_SSH_PASSWORD"
  ssh_cmd() { sshpass -e ssh "${SSH_OPTS[@]}" "$@"; }
  scp_cmd() { sshpass -e scp "${SSH_OPTS[@]}" "$@"; }
else
  echo "Provide VPS_SSH_PRIVATE_KEY or VPS_SSH_PASSWORD" >&2
  exit 1
fi

if [[ -z "${ssh_cmd:-}" ]]; then
  ssh_cmd() { ssh "${SSH_OPTS[@]}" "$@"; }
  scp_cmd() { scp -P "$SSH_PORT" "${SSH_OPTS[@]/i $KEY_FILE}" "$@"; }
fi

TARGET="${USER_NAME}@${HOST}"
ARCHIVE="$(mktemp -t remote-desktop-XXXXXX.tar.gz)"

tar -C "$ROOT" \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=data \
  --exclude='*.log' \
  -czf "$ARCHIVE" \
  package.json package-lock.json server.js public README.md scripts/remote-desktop.service scripts/Caddyfile.remote.example

echo "Connecting to ${TARGET}…"
ssh_cmd "$TARGET" "mkdir -p '$DEPLOY_PATH' && sudo mkdir -p /etc/systemd/system"

echo "Uploading…"
scp_cmd "$ARCHIVE" "${TARGET}:/tmp/remote-desktop.tar.gz"
rm -f "$ARCHIVE"

ssh_cmd "$TARGET" bash -s <<EOF
set -euo pipefail
DEPLOY_PATH='$DEPLOY_PATH'
APP_PORT='$APP_PORT'
sudo mkdir -p "\$DEPLOY_PATH"
sudo tar -xzf /tmp/remote-desktop.tar.gz -C "\$DEPLOY_PATH"
rm -f /tmp/remote-desktop.tar.gz
cd "\$DEPLOY_PATH"

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Screen capture / input tools used by server.js
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg xdotool xvfb || true

sudo npm install --omit=dev

if [[ -f scripts/remote-desktop.service ]]; then
  sed "s|__DEPLOY_PATH__|\$DEPLOY_PATH|g; s|__APP_PORT__|\$APP_PORT|g" scripts/remote-desktop.service \\
    | sudo tee /etc/systemd/system/remote-desktop.service >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now remote-desktop.service
  sudo systemctl restart remote-desktop.service
  sudo systemctl --no-pager --full status remote-desktop.service || true
fi

echo "Deployed. App should listen on port \$APP_PORT"
EOF

echo "Done. Try: http://${HOST}:${APP_PORT}"
