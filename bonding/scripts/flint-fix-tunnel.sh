#!/bin/sh
# Paste/run on the Flint while SSH'd in locally (192.168.8.1)
set -eu

echo "=== Flint VPN + SSH fix ==="

# WireGuard client iface
WG_IF=""
for n in wgclient1 wgclient0 wg0; do
  [ -d "/sys/class/net/$n" ] && WG_IF="$n" && break
done
if [ -z "$WG_IF" ]; then
  for d in /sys/class/net/wgclient*; do
    [ -e "$d" ] || continue
    WG_IF=$(basename "$d")
    break
  done
fi
if [ -z "$WG_IF" ]; then
  echo "ERROR: No WireGuard client interface. Re-import GL-MT6000 from https://vpn.vpstruelord.com"
  exit 1
fi
echo "WG interface: $WG_IF"

ip link set "$WG_IF" up
ip route replace 10.8.0.0/24 dev "$WG_IF"

# Persist route (OpenWrt UCI)
if command -v uci >/dev/null 2>&1; then
  while uci -q delete network.@route[0]; do :; done
  idx=$(uci add network route)
  uci set network.$idx.interface="$WG_IF"
  uci set network.$idx.target='10.8.0.0/24'
  uci commit network
fi

# SSH on all interfaces (including VPN IP 10.8.0.3)
if command -v uci >/dev/null 2>&1; then
  uci set dropbear.@dropbear[0].Interface=''
  uci set dropbear.@dropbear[0].PasswordAuth='on'
  uci set dropbear.@dropbear[0].RootPasswordAuth='on'
  uci commit dropbear
fi
/etc/init.d/dropbear enable 2>/dev/null || true
/etc/init.d/dropbear restart 2>/dev/null || true

# Firewall: accept from VPN
if command -v uci >/dev/null 2>&1; then
  if ! uci show firewall 2>/dev/null | grep -q "name='Allow-WG'"; then
    sec=$(uci add firewall rule)
    uci set firewall.$sec.name='Allow-WG'
    uci set firewall.$sec.src='*'
    uci set firewall.$sec.dest='*'
    uci set firewall.$sec.proto='all'
    uci set firewall.$sec.target='ACCEPT'
    uci add_list firewall.$sec.src_ip='10.8.0.0/24'
    uci commit firewall
    /etc/init.d/firewall reload 2>/dev/null || fw3 reload 2>/dev/null || true
  fi
fi

echo "--- wg ---"
wg show "$WG_IF" 2>/dev/null || wg show
echo "--- addr ---"
ip -4 addr show dev "$WG_IF"
echo "--- routes ---"
ip route | grep -E '10.8|default|wg'
echo "--- ssh listen ---"
ss -lnt 2>/dev/null | grep ':22 ' || netstat -lnt | grep ':22 '
echo "--- admin http ---"
ss -lnt 2>/dev/null | grep ':80 ' || netstat -lnt | grep ':80 '
echo "Done. VPS should reach 10.8.0.3 within ~30s."
