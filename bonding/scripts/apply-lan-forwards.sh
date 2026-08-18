#!/usr/bin/env bash
# VPS public ports -> Flint 2 WireGuard (10.8.0.3) -> Flint Port Forward -> LAN
set -euo pipefail

CONF="/opt/wireguard/scripts/forwards.conf"
WG_GW="10.42.42.42"
ROUTER_WG="10.8.0.3"
LAN_CIDR="10.0.0.0/24"
WG_CIDR="10.8.0.0/24"
ROUTER_PUBKEY="${ROUTER_WG_PUBKEY:-YOUR_FLINT_WG_PUBKEY}"
VPS_IP="${VPS_PUBLIC_IP:-YOUR.VPS.IP}"
CHAIN="SERVERMANAGER_DNAT"

docker exec wg-easy wg set wg0 peer "$ROUTER_PUBKEY" \
  allowed-ips "${ROUTER_WG}/32,${LAN_CIDR},192.168.8.0/24,fdcc:ad94:bacf:61a4::cafe:3/128" 2>/dev/null || true

ip route replace "${WG_CIDR}" via "${WG_GW}"
ip route replace "${LAN_CIDR}" via "${WG_GW}"
ip route replace "192.168.8.0/24" via "${WG_GW}" 2>/dev/null || true

iptables -C FORWARD -d "${WG_CIDR}" -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -d "${WG_CIDR}" -j ACCEPT
iptables -C FORWARD -s "${WG_CIDR}" -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -s "${WG_CIDR}" -j ACCEPT
iptables -C FORWARD -d "${LAN_CIDR}" -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -d "${LAN_CIDR}" -j ACCEPT
iptables -C FORWARD -s "${LAN_CIDR}" -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -s "${LAN_CIDR}" -j ACCEPT
iptables -C FORWARD -d "192.168.8.0/24" -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -d "192.168.8.0/24" -j ACCEPT
iptables -C FORWARD -s "192.168.8.0/24" -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -s "192.168.8.0/24" -j ACCEPT

docker exec wg-easy sh -c "
  ip route replace 10.0.0.0/24 dev wg0
  ip route replace 192.168.8.0/24 dev wg0 2>/dev/null || true
  iptables -C FORWARD -i eth0 -o wg0 -j ACCEPT 2>/dev/null || iptables -A FORWARD -i eth0 -o wg0 -j ACCEPT
  iptables -C FORWARD -i wg0 -o eth0 -j ACCEPT 2>/dev/null || iptables -A FORWARD -i wg0 -o eth0 -j ACCEPT
  iptables -t nat -C POSTROUTING -o wg0 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -o wg0 -j MASQUERADE
" || true

# Dedicated DNAT chain so we do not hijack Docker->LAN proxies (Caddy etc.)
iptables -t nat -N "$CHAIN" 2>/dev/null || iptables -t nat -F "$CHAIN"
if ! iptables -t nat -C PREROUTING -j "$CHAIN" 2>/dev/null; then
  iptables -t nat -I PREROUTING 1 -j "$CHAIN"
fi

# Remove legacy unscoped DNAT rules for ports we manage (they steal Caddy upstreams)
while read -r pub proto dest_ip dest_port name; do
  [[ -z "${pub:-}" || "$pub" =~ ^# ]] && continue
  # delete any old PREROUTING DNAT for this dport (may exist multiple times)
  for _ in 1 2 3 4 5 6 7 8; do
    line=$(iptables -t nat -S PREROUTING | grep -E -- "--dport ${pub} .*-j DNAT" | grep -v "$CHAIN" | head -n 1 || true)
    [[ -z "$line" ]] && break
    eval "iptables -t nat ${line/-A/-D}" 2>/dev/null || break
  done
done < "$CONF"

iptables -t nat -F "$CHAIN"

apply_one() {
  local pub="$1" proto="$2" dest_ip="$3" dest_port="$4" name="$5"
  echo "forward ${pub}/${proto} -> ${dest_ip}:${dest_port} (${name}) [only ${VPS_IP}]"
  # ONLY traffic destined to the VPS public IP (not Docker/LAN hairpins)
  iptables -t nat -A "$CHAIN" -d "$VPS_IP" -p "$proto" --dport "$pub" -j DNAT --to-destination "${dest_ip}:${dest_port}"

  iptables -t nat -C POSTROUTING -p "$proto" -d "$dest_ip" --dport "$dest_port" -j MASQUERADE 2>/dev/null \
    || iptables -t nat -A POSTROUTING -p "$proto" -d "$dest_ip" --dport "$dest_port" -j MASQUERADE

  iptables -C FORWARD -p "$proto" -d "$dest_ip" --dport "$dest_port" -j ACCEPT 2>/dev/null \
    || iptables -A FORWARD -p "$proto" -d "$dest_ip" --dport "$dest_port" -j ACCEPT
  iptables -C FORWARD -p "$proto" -s "$dest_ip" --sport "$dest_port" -j ACCEPT 2>/dev/null \
    || iptables -A FORWARD -p "$proto" -s "$dest_ip" --sport "$dest_port" -j ACCEPT

  if command -v ufw >/dev/null 2>&1; then
    ufw status | grep -q "${pub}/${proto}" || ufw allow "${pub}/${proto}" comment "GL forward ${name}" >/dev/null
  fi
}

while read -r pub proto dest_ip dest_port name; do
  [[ -z "${pub:-}" || "$pub" =~ ^# ]] && continue
  apply_one "$pub" "$proto" "$dest_ip" "$dest_port" "${name:-fwd}"
done < "$CONF"

echo "OK: routes and forwards applied"
ip route | grep -E "10.8.0.|10.0.0.|192.168.8." || true