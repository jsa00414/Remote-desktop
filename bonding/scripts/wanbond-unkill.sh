#!/bin/sh
# GL.iNet Tunnel 1 (7267) can stay live in iptables after UCI disable.
# That marks all LAN with 0x1000 so only the VPS IP (portal) still works.
iptables -t mangle -D ROUTE_POLICY -m addrtype ! --dst-type LOCAL -j TUNNEL7267_ROUTE_POLICY 2>/dev/null || true
iptables -t mangle -F TUNNEL7267_ROUTE_POLICY 2>/dev/null || true
ip rule del prio 9920 2>/dev/null || true
ip rule del prio 9910 2>/dev/null || true
ip rule del prio 800 2>/dev/null || true
uci set route_policy.@rule[0].enabled='0' 2>/dev/null || true
uci set route_policy.global.killswitch='0' 2>/dev/null || true
uci set wireguard.global.global_proxy='0' 2>/dev/null || true
