#!/usr/bin/env bash
# Install Docker Engine + Compose plugin on Debian/Ubuntu.
set -euo pipefail

if command -v docker >/dev/null 2>&1; then
  echo "Docker already installed: $(docker --version)"
  docker compose version
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
docker --version
docker compose version
echo "Docker install complete."
