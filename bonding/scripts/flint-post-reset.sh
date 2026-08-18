#!/bin/sh
# Run on the Flint (GL-MT6000) after factory reset — restores VPN tunnel routing for ServerManager.
set -eu

echo "=== Flint post-reset VPN fix ==="

# Find WireGuard client interface (GL.iNet usually wgclient1)
WG_IF=""
for d in /sys/class/net/wgclient* /sys/class/net/wg*; do
  [ -e "$d" ] || continue
  n=$(basename "$d")
  case "$n" in wg0) continue ;; esac
  WG_IF="$n"
  break
done
if [ -z "$WG_IF" ]; then
  echo "No WireGuard client interface found. Import the GL-MT6000 profile from https://vpn.vpstruelord.com first."
  exit 1
fi
echo "Using interface: $WG_IF"

# Ensure tunnel IP and return route to VPS
ip link set "$WG_IF" up 2>/dev/null || true
ip route replace 10.8.0.0/24 dev "$WG_IF" 2>/dev/null || true

# Persist route in UCI when available
if command -v uci >/dev/null 2>&1; then
  uci -q delete network.@route[-1] 2>/dev/null || true
  idx=$(uci add network route)
  uci set network.$idx.interface="$WG_IF"
  uci set network.$idx.target='10.8.0.0/24'
  uci commit network
fi

# Enable SSH (dropbear) if disabled
if [ -x /etc/init.d/dropbear ]; then
  /etc/init.d/dropbear enable 2>/dev/null || true
  /etc/init.d/dropbear start 2>/dev/null || true
fi

# Show status
echo "--- wg ---"
wg show "$WG_IF" 2>/dev/null || wg show
echo "--- routes ---"
ip route | grep -E "10.8|wg|default" || true
echo "--- listen ---"
netstat -lnt 2>/dev/null | grep -E ":22|:80 " || ss -lnt | grep -E ":22|:80 " || true
echo "Done. From the VPS you should be able to: ping 10.8.0.3 and open https://router.vpstruelord.com"
