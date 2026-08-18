#!/bin/sh
# Undo leftover Tunnel 1 / DNS-leak firewall. Does not change WireGuard.
iptables -t mangle -D ROUTE_POLICY -m addrtype ! --dst-type LOCAL -j TUNNEL7267_ROUTE_POLICY 2>/dev/null || true
iptables -t mangle -F TUNNEL7267_ROUTE_POLICY 2>/dev/null || true
ip rule del prio 9920 2>/dev/null || true
ip rule del prio 9910 2>/dev/null || true
ip rule del prio 800 2>/dev/null || true
iptables -D zone_lan_input -p udp -m udp --dport 53 -m mark ! --mark 0x8000/0xf000 -m comment --comment "!fw3: lan_drop_leaked_dns" -j DROP 2>/dev/null || true
iptables -D zone_lan_input -p udp -m udp --dport 3053 -m mark --mark 0x0/0xf000 -m comment --comment "!fw3: lan_drop_leaked_adgdns" -j DROP 2>/dev/null || true
iptables -D zone_guest_input -p udp -m udp --dport 53 -m mark ! --mark 0x8000/0xf000 -m comment --comment "!fw3: guest_drop_leaked_dns" -j DROP 2>/dev/null || true
iptables -D zone_guest_input -p udp -m udp --dport 3053 -m mark --mark 0x0/0xf000 -m comment --comment "!fw3: guest_drop_leaked_adgdns" -j DROP 2>/dev/null || true
iptables -D OUTPUT -p tcp -m mark --mark 0x0/0xf000 -m owner --uid-owner 453 -m comment --comment "!fw3: tcp_dns_leak_drop" -j DROP 2>/dev/null || true
uci set firewall.lan_drop_leaked_dns.enabled='0' 2>/dev/null || true
uci set firewall.lan_drop_leaked_adgdns.enabled='0' 2>/dev/null || true
uci set firewall.guest_drop_leaked_dns.enabled='0' 2>/dev/null || true
uci set firewall.guest_drop_leaked_adgdns.enabled='0' 2>/dev/null || true
uci set firewall.tcp_dns_leak_drop.enabled='0' 2>/dev/null || true
uci commit firewall 2>/dev/null || true
