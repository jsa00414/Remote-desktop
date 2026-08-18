#!/bin/sh
# Flint firewall only. Do not touch WireGuard (no wg set, no WG UCI).
# Fixes LAN internet: DNS leak drops, Tunnel 1 mark jump, kill-switch blackholes.

# Tunnel 1 leftover in iptables (UCI already disabled) — not the WG interface
iptables -t mangle -D ROUTE_POLICY -m addrtype ! --dst-type LOCAL -j TUNNEL7267_ROUTE_POLICY 2>/dev/null || true
iptables -t mangle -F TUNNEL7267_ROUTE_POLICY 2>/dev/null || true

# Kill-switch blackholes
ip rule del prio 9920 2>/dev/null || true
ip rule del prio 9910 2>/dev/null || true
ip rule del prio 800 2>/dev/null || true
ip rule add pref 8990 from all lookup main 2>/dev/null || true

# VPN DNS-leak DROPs (LAN DNS dies unless marked 0x8000)
iptables -D zone_lan_input -p udp -m udp --dport 53 -m mark ! --mark 0x8000/0xf000 -m comment --comment "!fw3: lan_drop_leaked_dns" -j DROP 2>/dev/null || true
iptables -D zone_lan_input -p udp -m udp --dport 3053 -m mark --mark 0x0/0xf000 -m comment --comment "!fw3: lan_drop_leaked_adgdns" -j DROP 2>/dev/null || true
iptables -D zone_guest_input -p udp -m udp --dport 53 -m mark ! --mark 0x8000/0xf000 -m comment --comment "!fw3: guest_drop_leaked_dns" -j DROP 2>/dev/null || true
iptables -D zone_guest_input -p udp -m udp --dport 3053 -m mark --mark 0x0/0xf000 -m comment --comment "!fw3: guest_drop_leaked_adgdns" -j DROP 2>/dev/null || true
iptables -D OUTPUT -p tcp -m mark --mark 0x0/0xf000 -m owner --uid-owner 453 -m comment --comment "!fw3: tcp_dns_leak_drop" -j DROP 2>/dev/null || true

# LAN out the repeater WAN
iptables -C FORWARD -i br-lan -o apcli0 -j ACCEPT 2>/dev/null \
  || iptables -I FORWARD 1 -i br-lan -o apcli0 -m comment --comment "sm: LAN-to-WAN" -j ACCEPT

# Stale bonding NAT only if smbond is down
if ! ip link show smbond 2>/dev/null | grep -q "UP"; then
  while iptables -t nat -C POSTROUTING -s 192.168.8.0/24 -o smbond -j MASQUERADE 2>/dev/null; do
    iptables -t nat -D POSTROUTING -s 192.168.8.0/24 -o smbond -j MASQUERADE
  done
fi

uci set firewall.lan_drop_leaked_dns.enabled='0' 2>/dev/null || true
uci set firewall.lan_drop_leaked_adgdns.enabled='0' 2>/dev/null || true
uci set firewall.guest_drop_leaked_dns.enabled='0' 2>/dev/null || true
uci set firewall.guest_drop_leaked_adgdns.enabled='0' 2>/dev/null || true
uci set firewall.tcp_dns_leak_drop.enabled='0' 2>/dev/null || true
uci commit firewall 2>/dev/null || true
