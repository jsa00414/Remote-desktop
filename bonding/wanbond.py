#!/usr/bin/env python3
"""Speedify-style WAN bonding: stripe/failover multiple links through the VPS."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import json
import os
import select
import socket
import struct
import subprocess
import sys
import threading
import time
from collections import OrderedDict
from typing import Dict, List, Optional, Tuple

MAGIC = b"SMB2"
TUNSETIFF = 0x400454CA
IFF_TUN = 0x0001
IFF_NO_PI = 0x1000
HDR = 4 + 4 + 1 + 1 + 16
MAX_PAY = 1180
FLAG_KA = 0x01
FLAG_DUP = 0x02
STATUS_PATH = os.environ.get("WANBOND_STATUS", "/tmp/wanbond-status.json")
LAN_CIDR = os.environ.get("WANBOND_LAN_CIDR", "192.168.8.0/24")
POLICY_TABLE = os.environ.get("WANBOND_POLICY_TABLE", "80")
REMOTE_TUN_IP = os.environ.get("WANBOND_REMOTE_TUN_IP", "10.9.0.1")
SKIP_IFACE = ("lo", "br-lan", "docker", "wg", "smbond", "tun", "sit", "dummy", "virbr")
SKIP_NET = ("127.", "10.8.", "10.9.")


def run(cmd: List[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return (p.stdout or "") + (p.stderr or "")


def open_tun(name: str) -> Tuple[int, str]:
    fd = os.open("/dev/net/tun", os.O_RDWR)
    ifr = struct.pack("16sH", name.encode(), IFF_TUN | IFF_NO_PI)
    fcntl.ioctl(fd, TUNSETIFF, ifr)
    return fd, name


def hmac16(key: bytes, blob: bytes) -> bytes:
    return hmac.new(key, blob, hashlib.sha256).digest()[:16]


def pack(key: bytes, seq: int, path: int, payload: bytes, flags: int = 0) -> bytes:
    body = MAGIC + struct.pack("!IBB", seq & 0xFFFFFFFF, path & 0xFF, flags & 0xFF) + payload
    return body + hmac16(key, body)


def unpack(key: bytes, pkt: bytes):
    if len(pkt) < HDR or pkt[:4] != MAGIC:
        return None
    seq, path, flags = struct.unpack("!IBB", pkt[4:10])
    mac, payload = pkt[-16:], pkt[10:-16]
    if not hmac.compare_digest(mac, hmac16(key, pkt[:-16])):
        return None
    return seq, path, flags, payload


def discover_wans() -> List[dict]:
    found: List[dict] = []
    raw = run(["ip", "-o", "-4", "addr", "show", "up"])
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        iface = parts[1].rstrip(":")
        if any(iface == s or iface.startswith(s) for s in SKIP_IFACE):
            continue
        cidr = parts[3]
        ip = cidr.split("/")[0]
        if ip.startswith(SKIP_NET) or ip.startswith("192.168.8."):
            continue
        found.append({"iface": iface, "ip": ip})
    by: Dict[str, dict] = {}
    for row in found:
        by[row["iface"]] = row
    return list(by.values())


def remove_client_policy_route(tun: str, vps_ip: str = "") -> None:
    run(["ip", "rule", "del", "from", LAN_CIDR, "lookup", POLICY_TABLE])
    run(["ip", "rule", "del", "from", LAN_CIDR, "to", LAN_CIDR, "lookup", "main"])
    if vps_ip:
        run(["ip", "rule", "del", "from", LAN_CIDR, "to", vps_ip, "lookup", "main"])
    run(["ip", "rule", "del", "from", LAN_CIDR, "to", "10.8.0.0/24", "lookup", "main"])
    run(["ip", "route", "flush", "table", POLICY_TABLE])
    while subprocess.run(
        ["iptables", "-t", "nat", "-C", "POSTROUTING", "-s", LAN_CIDR, "-o", tun, "-j", "MASQUERADE"],
        capture_output=True,
    ).returncode == 0:
        run(["iptables", "-t", "nat", "-D", "POSTROUTING", "-s", LAN_CIDR, "-o", tun, "-j", "MASQUERADE"])


def apply_client_policy_route(tun: str, vps_ip: str) -> None:
    run(["ip", "route", "replace", LAN_CIDR, "dev", "br-lan", "table", POLICY_TABLE])
    run(["ip", "route", "replace", "default", "dev", tun, "table", POLICY_TABLE])
    run(["ip", "rule", "del", "from", LAN_CIDR, "to", LAN_CIDR, "lookup", "main"])
    run(["ip", "rule", "add", "from", LAN_CIDR, "to", LAN_CIDR, "lookup", "main", "prio", "70"])
    run(["ip", "rule", "del", "from", LAN_CIDR, "to", "10.8.0.0/24", "lookup", "main"])
    run(["ip", "rule", "add", "from", LAN_CIDR, "to", "10.8.0.0/24", "lookup", "main", "prio", "71"])
    if vps_ip:
        run(["ip", "rule", "del", "from", LAN_CIDR, "to", vps_ip, "lookup", "main"])
        run(["ip", "rule", "add", "from", LAN_CIDR, "to", vps_ip, "lookup", "main", "prio", "72"])
    run(["ip", "rule", "del", "from", LAN_CIDR, "lookup", POLICY_TABLE])
    run(["ip", "rule", "add", "from", LAN_CIDR, "lookup", POLICY_TABLE, "prio", "80"])
    chk = subprocess.run(
        ["iptables", "-t", "nat", "-C", "POSTROUTING", "-s", LAN_CIDR, "-o", tun, "-j", "MASQUERADE"],
        capture_output=True,
    )
    if chk.returncode != 0:
        run(["iptables", "-t", "nat", "-A", "POSTROUTING", "-s", LAN_CIDR, "-o", tun, "-j", "MASQUERADE"])


def tunnel_health_ok(tun: str, remote: str = REMOTE_TUN_IP) -> bool:
    chk = subprocess.run(
        ["ping", "-c", "1", "-W", "1", remote],
        capture_output=True,
        text=True,
        timeout=4,
        check=False,
    )
    return chk.returncode == 0


class Bond:
    def __init__(self, role: str, key: bytes, tun: str, host: str, port: int, mode: str, lan_bond: bool):
        self.role = role
        self.key = key
        self.tun_name = tun
        self.host = host
        self.port = port
        self.mode = mode
        self.lan_bond = lan_bond
        self.seq = 0
        self.lock = threading.Lock()
        self.paths: List[dict] = []
        self.peer_addrs: List[Tuple[str, int]] = []
        self.peer_last: Dict[Tuple[str, int], float] = {}
        self.seen: OrderedDict = OrderedDict()
        self.expect = None
        self.reorder: OrderedDict = OrderedDict()
        self.ok = 0
        self.drop = 0
        self.bytes_up = 0
        self.bytes_down = 0
        self.last = time.time()
        self.running = True
        self.policy_active = False
        self.health_ok = 0
        self.health_fail = 0
        self.last_health = 0.0
        self.fd, _ = open_tun(tun)
        self.socks: List[socket.socket] = []

    def add_sock(self, sock: socket.socket, meta: dict) -> None:
        sock.setblocking(False)
        self.socks.append(sock)
        self.paths.append({**meta, "sock": sock, "last": time.time(), "up": 0, "down": 0})

    def next_seq(self) -> int:
        with self.lock:
            self.seq += 1
            return self.seq

    def write_status(self) -> None:
        live = []
        now = time.time()
        for p in self.paths:
            live.append(
                {
                    "iface": p.get("iface") or p.get("ip") or "path",
                    "ip": p.get("ip", ""),
                    "up": bool(now - p["last"] < 8),
                    "bytes_up": p["up"],
                    "bytes_down": p["down"],
                }
            )
        if self.role == "client":
            if self.policy_active:
                state = "CONNECTED"
            elif any(x["up"] for x in live) and self.health_ok >= 1:
                state = "CONNECTING"
            elif any(x["up"] for x in live):
                state = "READY"
            else:
                state = "WAITING"
        else:
            state = "CONNECTED" if self.peer_addrs else "WAITING"
        data = {
            "role": self.role,
            "state": state,
            "mode": self.mode,
            "egress": "vps",
            "policy_active": self.policy_active,
            "paths": live,
            "ok": self.ok,
            "drop": self.drop,
            "bytes_up": self.bytes_up,
            "bytes_down": self.bytes_down,
            "ts": int(now),
        }
        tmp = STATUS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        os.replace(tmp, STATUS_PATH)
        if self.role == "client" and self.lan_bond:
            self.manage_policy_route(now, live)

    def manage_policy_route(self, now: float, live: list) -> None:
        if self.role != "client" or not self.lan_bond:
            return
        path_up = any(x.get("up") for x in live)
        if now - self.last_health >= 4:
            self.last_health = now
            threading.Thread(
                target=lambda: subprocess.run(
                    ["ping", "-c", "1", "-W", "1", REMOTE_TUN_IP],
                    capture_output=True,
                    timeout=4,
                    check=False,
                ),
                daemon=True,
            ).start()
        if path_up and self.ok >= 1:
            self.health_ok += 1
            self.health_fail = 0
            if self.health_ok >= 3 and not self.policy_active:
                apply_client_policy_route(self.tun_name, self.host)
                self.policy_active = True
                print("wanbond: CONNECTED (LAN → VPS, Speedify-style)", flush=True)
        else:
            self.health_fail += 1
            self.health_ok = 0
            if self.policy_active and (self.health_fail >= 3 or not path_up):
                remove_client_policy_route(self.tun_name, self.host)
                self.policy_active = False
                print("wanbond: bypass (tunnel down, WiFi uses local WAN)", flush=True)

    def send_keepalive(self) -> None:
        pkt = pack(self.key, 0, 0, b"", FLAG_KA)
        if self.role == "client":
            for p in self.paths:
                try:
                    p["sock"].sendto(pkt, (self.host, self.port))
                    p["last"] = time.time()
                except OSError:
                    pass
            return
        if not self.socks:
            return
        sock = self.socks[0]
        for addr in self.live_peers():
            try:
                sock.sendto(pkt, addr)
            except OSError:
                pass

    def send_payload(self, payload: bytes) -> None:
        if not payload:
            return
        seq = self.next_seq()
        duplicate = self.mode == "redundant"
        flags = FLAG_DUP if duplicate else 0
        pkt = pack(self.key, seq, 0, payload[:MAX_PAY], flags)
        if self.role == "client":
            targets = [(p["sock"], None, i) for i, p in enumerate(self.paths)]
            if not duplicate and targets:
                i = seq % len(targets)
                targets = [targets[i]]
        else:
            if not self.socks:
                return
            sock = self.socks[0]
            addrs = self.live_peers()
            if not addrs:
                return
            if duplicate:
                targets = [(sock, addr, 0) for addr in addrs]
            else:
                addr = addrs[seq % len(addrs)]
                targets = [(sock, addr, 0)]
        for sock, addr, idx in targets:
            try:
                if addr:
                    sock.sendto(pkt, addr)
                else:
                    sock.sendto(pkt, (self.host, self.port))
                self.bytes_up += len(payload)
                if idx < len(self.paths):
                    self.paths[idx]["up"] += len(payload)
            except OSError:
                pass

    def ingest(self, seq: int, payload: bytes, flags: int) -> None:
        if not payload:
            return
        if flags & FLAG_DUP:
            if seq in self.seen:
                return
            self.seen[seq] = True
            while len(self.seen) > 4096:
                self.seen.popitem(last=False)
            try:
                os.write(self.fd, payload)
                self.ok += 1
                self.bytes_down += len(payload)
            except OSError:
                pass
            return
        if self.expect is None:
            self.expect = seq
        if seq < self.expect:
            if seq < 16 or self.expect - seq > 8:
                self.expect = seq
                self.reorder.clear()
            else:
                self.drop += 1
                return
        self.reorder[seq] = payload
        while self.expect in self.reorder:
            blob = self.reorder.pop(self.expect)
            try:
                os.write(self.fd, blob)
                self.ok += 1
                self.bytes_down += len(blob)
            except OSError:
                pass
            self.expect += 1
        while len(self.reorder) > 64:
            first = next(iter(self.reorder))
            self.reorder.pop(first)
            self.drop += 1
            if self.expect <= first:
                self.expect = first + 1

    def live_peers(self) -> List[Tuple[str, int]]:
        now = time.time()
        with self.lock:
            live = [a for a, ts in self.peer_last.items() if now - ts < 10]
            self.peer_addrs = live
            return list(live)

    def note_peer(self, addr: Tuple[str, int], sock: socket.socket, now: float, n: int) -> None:
        with self.lock:
            self.peer_last[addr] = now
            if addr not in self.peer_addrs:
                self.peer_addrs.append(addr)
                self.paths.append(
                    {"iface": addr[0], "ip": addr[0], "sock": sock, "last": now, "up": 0, "down": n}
                )
                return
        for p in self.paths:
            if p.get("ip") == addr[0]:
                p["last"] = now
                p["down"] += n

    def loop(self) -> None:
        last_ka = 0.0
        last_st = 0.0
        try:
            while self.running:
                rlist = [self.fd] + self.socks
                try:
                    ready, _, _ = select.select(rlist, [], [], 0.4)
                except (ValueError, OSError):
                    time.sleep(0.2)
                    continue
                now = time.time()
                if now - last_ka > 2:
                    self.send_keepalive()
                    last_ka = now
                if now - last_st > 1:
                    self.write_status()
                    last_st = now
                for item in ready:
                    if item == self.fd:
                        try:
                            payload = os.read(self.fd, MAX_PAY)
                        except OSError:
                            continue
                        if payload:
                            self.send_payload(payload)
                        continue
                    try:
                        data, addr = item.recvfrom(2048)
                    except OSError:
                        continue
                    parsed = unpack(self.key, data)
                    if not parsed:
                        continue
                    seq, path, flags, payload = parsed
                    self.last = now
                    if self.role == "server":
                        self.note_peer(addr, item, now, len(payload))
                    else:
                        for p in self.paths:
                            if p["sock"] is item:
                                p["last"] = now
                                p["down"] += len(payload)
                    if flags & FLAG_KA:
                        self.expect = None
                        self.reorder.clear()
                        continue
                    if payload:
                        self.ingest(seq, payload, flags)
        finally:
            if self.role == "client":
                remove_client_policy_route(self.tun_name, self.host)


def setup_tun_addr(name: str, cidr: str) -> None:
    run(["ip", "link", "set", name, "mtu", "1200"])
    run(["ip", "link", "set", name, "up"])
    run(["ip", "addr", "flush", "dev", name])
    run(["ip", "addr", "add", cidr, "dev", name])
    run(["sysctl", "-w", f"net.ipv4.conf.{name}.rp_filter=0"])


def setup_server_nat(tun: str) -> None:
    run(["sysctl", "-w", "net.ipv4.ip_forward=1"])
    run(["sysctl", "-w", f"net.ipv4.conf.{tun}.rp_filter=0"])
    chk = subprocess.run(
        ["iptables", "-t", "nat", "-C", "POSTROUTING", "-s", "10.9.0.0/24", "-j", "MASQUERADE"],
        capture_output=True,
    )
    if chk.returncode != 0:
        run(["iptables", "-t", "nat", "-A", "POSTROUTING", "-s", "10.9.0.0/24", "-j", "MASQUERADE"])
    for flag in ("-i", "-o"):
        chk = subprocess.run(["iptables", "-C", "FORWARD", flag, tun, "-j", "ACCEPT"], capture_output=True)
        if chk.returncode != 0:
            run(["iptables", "-I", "FORWARD", "1", flag, tun, "-j", "ACCEPT"])
    chk = subprocess.run(["iptables", "-C", "INPUT", "-i", tun, "-j", "ACCEPT"], capture_output=True)
    if chk.returncode != 0:
        run(["iptables", "-I", "INPUT", "1", "-i", tun, "-j", "ACCEPT"])
    chk = subprocess.run(["iptables", "-C", "INPUT", "-p", "udp", "--dport", "4410", "-j", "ACCEPT"], capture_output=True)
    if chk.returncode != 0:
        run(["iptables", "-I", "INPUT", "1", "-p", "udp", "--dport", "4410", "-j", "ACCEPT"])


def setup_client_base(tun: str, vps_ip: str) -> None:
    remove_client_policy_route(tun, vps_ip)
    default = run(["ip", "-4", "route", "show", "default"]).strip().splitlines()
    via = ""
    dev = ""
    if default:
        bits = default[0].split()
        if "via" in bits:
            via = bits[bits.index("via") + 1]
        if "dev" in bits:
            dev = bits[bits.index("dev") + 1]
    if via and dev:
        run(["ip", "route", "replace", vps_ip + "/32", "via", via, "dev", dev])
    elif dev:
        run(["ip", "route", "replace", vps_ip + "/32", "dev", dev])
    run(["sysctl", "-w", "net.ipv4.ip_forward=1"])
    run(["sysctl", "-w", f"net.ipv4.conf.{tun}.rp_filter=0"])


def main() -> int:
    ap = argparse.ArgumentParser(description="Speedify-style WAN bonder")
    ap.add_argument("role", choices=["server", "client"])
    ap.add_argument("--key", required=True)
    ap.add_argument("--tun", default="smbond")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=4410)
    ap.add_argument("--ifaces", default="")
    ap.add_argument("--mode", choices=["speed", "redundant", "auto"], default="speed")
    ap.add_argument("--lan-bond", action="store_true", help="Steer LAN through tunnel after health checks")
    ap.add_argument("--egress", choices=["vps", "host"], default="vps")
    args = ap.parse_args()
    if args.egress != "vps":
        print("wanbond: Speedify mode uses VPS egress; ignoring --egress host", flush=True)
    key = hashlib.sha256(args.key.encode()).digest()
    mode = "speed" if args.mode == "auto" else args.mode
    bond = Bond(args.role, key, args.tun, args.host, args.port, mode, args.lan_bond)

    if args.role == "server":
        setup_tun_addr(args.tun, "10.9.0.1/24")
        setup_server_nat(args.tun)
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("0.0.0.0", args.port))
        bond.add_sock(sock, {"iface": "udp", "ip": "0.0.0.0"})
    else:
        setup_tun_addr(args.tun, "10.9.0.2/24")
        setup_client_base(args.tun, args.host)
        wans = discover_wans()
        if args.ifaces:
            want = {x.strip() for x in args.ifaces.split(",") if x.strip()}
            wans = [w for w in wans if w["iface"] in want] or wans
        if not wans:
            print("No WAN interfaces found", file=sys.stderr)
            return 2
        for w in wans:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                sock.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_BINDTODEVICE", 25), w["iface"].encode() + b"\0")
            except OSError:
                sock.bind((w["ip"], 0))
            else:
                try:
                    sock.bind((w["ip"], 0))
                except OSError:
                    sock.bind(("0.0.0.0", 0))
            bond.add_sock(sock, w)
        print("paths", ",".join(w["iface"] for w in wans), flush=True)
        print("mode", mode, "lan_bond", args.lan_bond, flush=True)

    print(f"wanbond {args.role} tun={args.tun} port={args.port} egress=vps", flush=True)
    try:
        bond.loop()
    except KeyboardInterrupt:
        bond.running = False
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
