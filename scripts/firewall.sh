#!/usr/bin/env bash
# Open WireGuard + admin UI ports (ufw if present).
set -euo pipefail

WG_PORT="${1:-51820}"
UI_PORT="${2:-51821}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo $0 [wg_port] [ui_port]" >&2
  exit 1
fi

if command -v ufw >/dev/null 2>&1; then
  ufw allow "${WG_PORT}/udp" comment 'WireGuard' || true
  ufw allow "${UI_PORT}/tcp" comment 'WireGuard Easy UI' || true
  ufw status || true
  echo "ufw rules applied for UDP/${WG_PORT} and TCP/${UI_PORT}"
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="${WG_PORT}/udp" || true
  firewall-cmd --permanent --add-port="${UI_PORT}/tcp" || true
  firewall-cmd --reload || true
  echo "firewalld rules applied for UDP/${WG_PORT} and TCP/${UI_PORT}"
else
  echo "No ufw/firewalld found — open UDP/${WG_PORT} and TCP/${UI_PORT} in your cloud security group."
fi
