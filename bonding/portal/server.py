#!/usr/bin/env python3
"""ServerManager panel — VPS forwards, GL.iNet router, domains, firewall."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shlex
import subprocess
import tempfile
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

CONF_PATH = Path(os.environ.get("FORWARDS_CONF", "/opt/servermanager/scripts/forwards.conf"))
APPLY_SCRIPT = Path(
    os.environ.get("APPLY_SCRIPT", "/opt/servermanager/scripts/apply-lan-forwards.sh")
)
STATIC_DIR = Path(__file__).resolve().parent / "static"
ROUTER_KNOWN_HOSTS = Path(
    os.environ.get(
        "ROUTER_KNOWN_HOSTS",
        str(Path(__file__).resolve().parent / "router_known_hosts"),
    )
)
HOST = os.environ.get("PF_HOST", "0.0.0.0")
PORT = int(os.environ.get("PF_PORT", "5002"))
AUTH_USER = os.environ.get("PF_USER", "admin")
AUTH_PASS = os.environ.get("PF_PASS", "")
PANEL_TITLE = os.environ.get("PANEL_TITLE", "ServerManager")
PANEL_TAGLINE = os.environ.get(
    "PANEL_TAGLINE",
    "Sign in to manage VPS forwards, GL.iNet, domains, and firewall.",
)
SESSION_HOURS = float(os.environ.get("SESSION_HOURS", "12"))
COOKIE_NAME = "sm_session"
ALLOW_BASIC_AUTH = os.environ.get("ALLOW_BASIC_AUTH", "0").strip().lower() in (
    "1",
    "true",
    "yes",
)

_sessions: dict[str, float] = {}
_sessions_lock = threading.Lock()

ROUTER_HOST = os.environ.get("ROUTER_HOST", "192.168.8.1")
ROUTER_HOSTS = [
    h.strip()
    for h in os.environ.get("ROUTER_HOSTS", "10.8.0.3,192.168.8.1").split(",")
    if h.strip()
]
if ROUTER_HOST not in ROUTER_HOSTS:
    ROUTER_HOSTS.insert(0, ROUTER_HOST)
ROUTER_USER = os.environ.get("ROUTER_USER", "root")
ROUTER_CONF = os.environ.get("ROUTER_CONF", "/etc/config/port_forward")


def _load_router_pass() -> str:
    raw = os.environ.get("ROUTER_PASS", "")
    b64 = os.environ.get("ROUTER_PASS_B64", "")
    if b64:
        try:
            return base64.b64decode(b64).decode("utf-8")
        except Exception as exc:  # noqa: BLE001
            raise SystemExit(f"Invalid ROUTER_PASS_B64: {exc}") from exc
    return raw


ROUTER_PASS = _load_router_pass()

# Optional: leave CADDYFILE_PATH empty to disable domain hookups
_caddy_raw = os.environ.get("CADDYFILE_PATH", "").strip()
CADDYFILE_PATH = Path(_caddy_raw) if _caddy_raw else Path("")
CADDY_CONTAINER = os.environ.get("CADDY_CONTAINER", "")
HOOKUPS_JSON = Path(
    os.environ.get("HOOKUPS_JSON", "/opt/servermanager/panel/hookups.json")
)
HOOKUPS_BEGIN = "# BEGIN PORT-FORWARD-HOOKUPS"
HOOKUPS_END = "# END PORT-FORWARD-HOOKUPS"
VPS_PUBLIC_IP = os.environ.get("VPS_PUBLIC_IP", "0.0.0.0")
DOCKER_HOST_GW = os.environ.get("DOCKER_HOST_GW", "172.18.0.1")
# Cloudflare DNS automation (optional)
CF_API_TOKEN = os.environ.get("CF_API_TOKEN", "").strip()
CF_ZONE_ID = os.environ.get("CF_ZONE_ID", "").strip()
CF_ZONE_NAME = os.environ.get("CF_ZONE_NAME", "").strip()
CF_PROXIED = os.environ.get("CF_PROXIED", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
# Source IPs allowed when a domain/port is marked VPN-only
VPN_CLIENT_CIDRS = os.environ.get(
    "VPN_CLIENT_CIDRS",
    "10.8.0.0/24 10.42.42.0/24 192.168.8.0/24 172.18.0.1/32",
)
VPN_UFW_FROM = os.environ.get("VPN_UFW_FROM", "10.8.0.0/24")

DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$"
)

LINE_RE = re.compile(
    r"^(?P<pub>\d+)\s+(?P<proto>tcp|udp|TCP|UDP)\s+"
    r"(?P<dest_ip>\S+)\s+(?P<dest_port>\d+)\s+(?P<name>\S+)\s*$"
)
IP_RE = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$")
NAME_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,40}$")
UCI_OPT_RE = re.compile(r"^\s*option\s+(\w+)\s+'([^']*)'\s*$")

_apply_lock = threading.Lock()


def require_auth_configured() -> None:
    if not AUTH_PASS:
        raise SystemExit("PF_PASS env var is required")
    if not ROUTER_PASS:
        raise SystemExit("ROUTER_PASS env var is required")


def parse_conf(text: str) -> dict:
    comments: list[str] = []
    rules: list[dict] = []
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            comments.append(stripped)
            continue
        m = LINE_RE.match(stripped)
        if not m:
            raise ValueError(f"Invalid forward line: {stripped}")
        rules.append(
            {
                "pub": int(m.group("pub")),
                "proto": m.group("proto").lower(),
                "dest_ip": m.group("dest_ip"),
                "dest_port": int(m.group("dest_port")),
                "name": m.group("name"),
                "external": False,
            }
        )
    return {"comments": comments, "rules": rules}


def validate_vps_rules(rules: list[dict]) -> list[dict]:
    if not isinstance(rules, list):
        raise ValueError("vps rules must be a list")
    cleaned: list[dict] = []
    seen: set[tuple[str, int]] = set()
    reserved = {22, 25, 80, 443, 465, 587, 993, 5000, 5001, 5002}
    protected_pubs = {8080, 8443}
    for i, rule in enumerate(rules):
        try:
            pub = int(rule["pub"])
            dest_port = int(rule["dest_port"])
            proto = str(rule["proto"]).lower().strip()
            dest_ip = str(rule["dest_ip"]).strip()
            name = str(rule["name"]).strip()
            external = bool(rule.get("external", False))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"VPS rule {i + 1}: missing/invalid fields") from exc
        if proto not in ("tcp", "udp"):
            raise ValueError(f"VPS rule {i + 1}: proto must be tcp or udp")
        if not (1 <= pub <= 65535 and 1 <= dest_port <= 65535):
            raise ValueError(f"VPS rule {i + 1}: ports must be 1-65535")
        if pub in reserved and not external:
            raise ValueError(f"VPS rule {i + 1}: public port {pub} is reserved")
        if not IP_RE.match(dest_ip):
            raise ValueError(f"VPS rule {i + 1}: invalid dest_ip")
        if not NAME_RE.match(name):
            raise ValueError(f"VPS rule {i + 1}: invalid name")
        # Keep protected admin HTTP/HTTPS public ports immutable
        if pub in protected_pubs and not external:
            expected = {
                8080: ("tcp", "192.168.8.1", 80, "flint-http"),
                8443: ("tcp", "192.168.8.1", 443, "flint-https"),
            }[pub]
            proto, dest_ip, dest_port, name = expected
        key = (proto, pub)
        if key in seen:
            raise ValueError(f"VPS rule {i + 1}: duplicate {proto}/{pub}")
        seen.add(key)
        cleaned.append(
            {
                "pub": pub,
                "proto": proto,
                "dest_ip": dest_ip,
                "dest_port": dest_port,
                "name": name,
                "external": external,
            }
        )
    return cleaned


def serialize_vps_conf(comments: list[str], rules: list[dict]) -> str:
    lines = comments or [
        "# Do NOT forward 80/443 — Caddy uses them on this VPS",
        "# Edited by port-forward UI",
    ]
    out = "\n".join(lines).rstrip() + "\n"
    for r in rules:
        if r.get("external"):
            continue
        out += (
            f"{r['pub']:<5} {r['proto']:<3} {r['dest_ip']:<15} "
            f"{r['dest_port']:<5} {r['name']}\n"
        )
    return out


def parse_live_dnat() -> list[dict]:
    """Import current iptables DNAT PREROUTING rules into the VPS list."""
    proc = subprocess.run(
        ["iptables", "-t", "nat", "-S", "PREROUTING"],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if proc.returncode != 0:
        return []
    dnat_re = re.compile(
        r"-A PREROUTING .*?-p (?P<proto>tcp|udp).*?--dport (?P<pub>\d+).*?"
        r"--to-destination (?P<dest_ip>[^:]+):(?P<dest_port>\d+)"
    )
    rules: list[dict] = []
    seen: set[tuple[str, int]] = set()
    for line in (proc.stdout or "").splitlines():
        if "DNAT" not in line:
            continue
        m = dnat_re.search(line)
        if not m:
            continue
        pub = int(m.group("pub"))
        proto = m.group("proto")
        key = (proto, pub)
        if key in seen:
            continue
        seen.add(key)
        rules.append(
            {
                "pub": pub,
                "proto": proto,
                "dest_ip": m.group("dest_ip"),
                "dest_port": int(m.group("dest_port")),
                "name": f"dnat-{pub}",
                "external": True,
            }
        )
    return rules


def parse_ufw_gl_forwards() -> list[dict]:
    """Import UFW 'GL forward*' allows that may not have DNAT yet."""
    proc = subprocess.run(
        ["ufw", "status"],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if proc.returncode != 0:
        return []
    row_re = re.compile(
        r"^(?P<port>\d+)(?:/(?P<proto>tcp|udp))?\s+ALLOW\s+Anywhere.*?#\s*(?P<comment>.+)$",
        re.I,
    )
    rules: list[dict] = []
    seen: set[tuple[str, int]] = set()
    for line in (proc.stdout or "").splitlines():
        if "GL forward" not in line and "RDP via GL" not in line:
            continue
        m = row_re.match(line.strip())
        if not m:
            continue
        pub = int(m.group("port"))
        proto = (m.group("proto") or "tcp").lower()
        key = (proto, pub)
        if key in seen:
            continue
        seen.add(key)
        comment = m.group("comment").strip().replace(" ", "-")[:40]
        rules.append(
            {
                "pub": pub,
                "proto": proto,
                "dest_ip": "0.0.0.0",
                "dest_port": pub,
                "name": comment or f"ufw-{pub}",
                "external": True,
                "ufw_only": True,
            }
        )
    return rules


def merge_vps_lists(managed: list[dict], existing: list[dict]) -> list[dict]:
    by_key: dict[tuple[str, int], dict] = {}
    for r in existing:
        by_key[(r["proto"], int(r["pub"]))] = dict(r)
    for r in managed:
        key = (r["proto"], int(r["pub"]))
        prev = by_key.get(key, {})
        by_key[key] = {**prev, **r, "external": False}
        by_key[key].pop("ufw_only", None)
    ordered: list[dict] = []
    seen: set[tuple[str, int]] = set()
    for r in existing + managed:
        key = (r["proto"], int(r["pub"]))
        if key in seen:
            continue
        ordered.append(by_key[key])
        seen.add(key)
    return ordered


def validate_router(dmz_ip: str, rules: list[dict]) -> tuple[str, list[dict]]:
    dmz_ip = str(dmz_ip or "").strip()
    if not IP_RE.match(dmz_ip):
        raise ValueError("Router DMZ IP is invalid")
    if not isinstance(rules, list):
        raise ValueError("router rules must be a list")
    cleaned: list[dict] = []
    for i, rule in enumerate(rules):
        try:
            enabled = bool(rule.get("enabled", True))
            proto = str(rule.get("proto", "tcp")).lower().strip()
            src = str(rule.get("src", "wgclient1")).strip()
            src_dport = str(rule.get("src_dport", "")).strip()
            dest_ip = str(rule["dest_ip"]).strip()
            dest_port = str(rule.get("dest_port", "")).strip()
            name = str(rule.get("name", f"rule{i+1}")).strip() or f"rule{i+1}"
            external = bool(rule.get("external", False))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"Router rule {i + 1}: missing/invalid fields") from exc
        if name == "GL-DMZ":
            # DMZ is edited via dmz_ip field; keep out of redirect rows on write
            continue
        if src not in ("wan", "wgclient1", "lan"):
            raise ValueError(f"Router rule {i + 1}: src must be wan or wgclient1")
        if proto not in ("tcp", "udp", "tcp udp", "all"):
            raise ValueError(f"Router rule {i + 1}: invalid proto")
        if not IP_RE.match(dest_ip):
            raise ValueError(f"Router rule {i + 1}: invalid dest_ip")
        if not NAME_RE.match(name):
            raise ValueError(f"Router rule {i + 1}: invalid name")
        if proto != "all":
            if not src_dport.isdigit() or not (1 <= int(src_dport) <= 65535):
                raise ValueError(f"Router rule {i + 1}: invalid src_dport")
            if not dest_port.isdigit() or not (1 <= int(dest_port) <= 65535):
                raise ValueError(f"Router rule {i + 1}: invalid dest_port")
        cleaned.append(
            {
                "enabled": enabled,
                "proto": proto,
                "src": src,
                "src_dport": src_dport,
                "dest_ip": dest_ip,
                "dest_port": dest_port,
                "name": name,
                "external": external,
            }
        )
    return dmz_ip, cleaned


def serialize_router_conf(dmz_ip: str, rules: list[dict]) -> str:
    lines = [
        "config redirect",
        "\toption enabled '1'",
        "\toption src 'wan'",
        "\toption name 'GL-DMZ'",
        "\toption dest 'lan'",
        f"\toption dest_ip '{dmz_ip}'",
        "\toption proto 'all'",
        "",
    ]
    for r in rules:
        if r.get("external"):
            continue
        enabled = "1" if r.get("enabled", True) else "0"
        lines.extend(
            [
                "config redirect",
                f"\toption enabled '{enabled}'",
                f"\toption proto '{r['proto']}'",
                f"\toption src '{r['src']}'",
                f"\toption name '{r['name']}'",
                "\toption dest 'lan'",
                f"\toption dest_ip '{r['dest_ip']}'",
            ]
        )
        if r["proto"] != "all":
            lines.append(f"\toption src_dport '{r['src_dport']}'")
            lines.append(f"\toption dest_port '{r['dest_port']}'")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def parse_router_conf(text: str) -> dict:
    blocks: list[dict] = []
    current: dict | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("config "):
            if current is not None:
                blocks.append(current)
            current = {}
            continue
        m = UCI_OPT_RE.match(raw)
        if m and current is not None:
            current[m.group(1)] = m.group(2)
    if current is not None:
        blocks.append(current)

    dmz_ip = "192.168.8.243"
    rules: list[dict] = []
    for b in blocks:
        name = b.get("name", "")
        if name == "GL-DMZ" or (
            b.get("src") == "wan" and b.get("proto") == "all" and "src_dport" not in b
        ):
            dmz_ip = b.get("dest_ip", dmz_ip)
            # Also expose DMZ as a visible existing row in the list
            rules.append(
                {
                    "enabled": b.get("enabled", "1") != "0",
                    "proto": "all",
                    "src": "wan",
                    "src_dport": "",
                    "dest_ip": dmz_ip,
                    "dest_port": "",
                    "name": "GL-DMZ",
                    "external": True,
                }
            )
            continue
        rules.append(
            {
                "enabled": b.get("enabled", "1") != "0",
                "proto": b.get("proto", "tcp"),
                "src": b.get("src", "wgclient1"),
                "src_dport": b.get("src_dport", ""),
                "dest_ip": b.get("dest_ip", ""),
                "dest_port": b.get("dest_port", ""),
                "name": name or "rule",
                "external": False,
            }
        )
    return {"dmz_ip": dmz_ip, "rules": rules}


def _router_host_in_use() -> str:
    return globals().get("_active_router_host") or ROUTER_HOSTS[0]


def router_ssh(
    remote_cmd: str,
    input_text: str | None = None,
    timeout: int = 45,
) -> subprocess.CompletedProcess:
    """Run a command on the Flint router via sshpass (tries ROUTER_HOSTS in order)."""
    global _active_router_host
    ROUTER_KNOWN_HOSTS.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["SSHPASS"] = ROUTER_PASS
    per_host = max(3, min(6, timeout // max(1, len(ROUTER_HOSTS))))
    last: subprocess.CompletedProcess | None = None
    for host in ROUTER_HOSTS:
        cmd = [
            "sshpass",
            "-e",
            "ssh",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            f"UserKnownHostsFile={ROUTER_KNOWN_HOSTS}",
            "-o",
            "PreferredAuthentications=password",
            "-o",
            "PubkeyAuthentication=no",
            "-o",
            f"ConnectTimeout={per_host}",
            f"{ROUTER_USER}@{host}",
            remote_cmd,
        ]
        last = subprocess.run(
            cmd,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env=env,
        )
        if last.returncode == 0:
            _active_router_host = host
            return last
        err = (last.stderr or last.stdout or "").lower()
        if "connection timed out" in err or "connection refused" in err or "no route" in err:
            continue
        _active_router_host = host
        return last
    return last or subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="router ssh failed")


_active_router_host = ROUTER_HOSTS[0]


WANBOND_PORT = int(os.environ.get("WANBOND_PORT", "8443"))
WANBOND_PORTS = os.environ.get("WANBOND_PORTS", "8443,51820,4410")
WANBOND_SCRIPT = Path(
    os.environ.get("WANBOND_SCRIPT", "/opt/wireguard/scripts/wanbond.py")
)
WANBOND_KEY_FILE = Path(os.environ.get("WANBOND_KEY_FILE", "/opt/wireguard/wanbond.key"))
WANBOND_STATUS = Path("/tmp/wanbond-status.json")
_bond_lock = threading.Lock()

UNKILL_SH = r"""#!/bin/sh
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
"""


def _wanbond_script() -> Path:
    if WANBOND_SCRIPT.is_file():
        return WANBOND_SCRIPT
    alt = Path(__file__).resolve().parent.parent / "scripts" / "wanbond.py"
    if alt.is_file():
        return alt
    return WANBOND_SCRIPT


def wanbond_key() -> str:
    env_key = os.environ.get("WANBOND_KEY", "").strip()
    if env_key:
        return env_key
    WANBOND_KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    if WANBOND_KEY_FILE.is_file():
        return WANBOND_KEY_FILE.read_text(encoding="utf-8").strip()
    key = secrets.token_hex(24)
    WANBOND_KEY_FILE.write_text(key + "\n", encoding="utf-8")
    try:
        os.chmod(WANBOND_KEY_FILE, 0o600)
    except OSError:
        pass
    return key


def _read_status_file(path: Path) -> dict:
    try:
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def read_bond_state() -> dict:
    vps_active = (
        subprocess.run(
            ["systemctl", "is-active", "wanbond"],
            capture_output=True,
            text=True,
        ).stdout.strip()
        == "active"
    )
    vps_status = _read_status_file(WANBOND_STATUS)
    proc = router_ssh(
        "echo '---IF---'; ip -o -4 addr show up; echo '---PID---'; "
        "(pgrep -f '[p]ython3 /usr/share/wanbond.py' || true); echo '---ST---'; "
        "(cat /tmp/wanbond-status.json 2>/dev/null || true)"
    )
    out = proc.stdout or ""
    router_status = {}
    if "---ST---" in out:
        router_status = _json_from_cli(out.split("---ST---", 1)[-1]) or {}
        if not isinstance(router_status, dict):
            router_status = {}
    running_router = bool(re.search(r"---PID---\s*\n\s*\d+", out))
    links = []
    if "---IF---" in out:
        body = out.split("---IF---", 1)[-1].split("---PID---", 1)[0]
        for line in body.splitlines():
            parts = line.split()
            if len(parts) < 4:
                continue
            iface = parts[1].rstrip(":")
            ip = parts[3].split("/")[0]
            if iface in ("lo", "br-lan") or iface.startswith(("wg", "docker", "smbond")):
                continue
            if ip.startswith(("127.", "10.8.", "10.9.", "192.168.8.")):
                continue
            links.append({"iface": iface, "ip": ip, "up": True})
    if router_status.get("paths"):
        links = router_status["paths"]
    connected = bool(vps_active and running_router and router_status.get("policy_active"))
    return {
        "ok": True,
        "installed": _wanbond_script().is_file(),
        "state": "CONNECTED" if connected else ("READY" if vps_active else "STOPPED"),
        "vps_active": vps_active,
        "router_active": running_router,
        "port": router_status.get("port") or vps_status.get("port") or WANBOND_PORT,
        "ports": router_status.get("ports") or vps_status.get("ports") or [
            int(p) for p in WANBOND_PORTS.split(",") if p.strip().isdigit()
        ],
        "host": VPS_PUBLIC_IP,
        "links": links,
        "vps": vps_status,
        "router": router_status,
        "needs_license": False,
    }


def _write_wanbond_unit() -> None:
    script = _wanbond_script()
    unit = f"""[Unit]
Description=ServerManager WAN bond server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 {script} server --key {wanbond_key()} --port {WANBOND_PORT} --ports {WANBOND_PORTS} --mode speed --egress vps
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
"""
    Path("/etc/systemd/system/wanbond.service").write_text(unit, encoding="utf-8")
    subprocess.run(["systemctl", "daemon-reload"], capture_output=True)


def install_bond() -> dict:
    logs: list[str] = []
    src = _wanbond_script()
    dest = Path("/opt/wireguard/scripts/wanbond.py")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src.is_file() and src.resolve() != dest.resolve():
        dest.write_bytes(src.read_bytes())
    dest.chmod(0o755)
    logs.append(f"script {dest}")
    _write_wanbond_unit()
    subprocess.run(
        ["ufw", "allow", "8443/udp", "comment", "WAN bond"], capture_output=True)
    subprocess.run(
        ["ufw", "allow", "51820/udp", "comment", "WAN bond"], capture_output=True)
    subprocess.run(
        ["ufw", "allow", "4410/udp", "comment", "WAN bond"],
        capture_output=True,
        text=True,
    )
    logs.append(f"ufw {WANBOND_PORT}/udp")
    subprocess.run(["systemctl", "enable", "wanbond"], capture_output=True)
    start = subprocess.run(
        ["systemctl", "restart", "wanbond"], capture_output=True, text=True
    )
    logs.append(start.stdout or start.stderr or "vps service restarted")
    py = router_ssh(
        "modprobe tun 2>/dev/null || true; "
        "mkdir -p /dev/net; "
        "[ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200 2>/dev/null || true; "
        "(command -v python3 && echo HAS_PY) || "
        "(opkg update >/dev/null 2>&1; opkg install python3 kmod-tun >/dev/null 2>&1; command -v python3 && echo HAS_PY) || "
        "(apk add python3 >/dev/null 2>&1; command -v python3 && echo HAS_PY) || echo NO_PY; "
        "ls -l /dev/net/tun 2>/dev/null || true",
        timeout=120,
    )
    logs.append((py.stdout or py.stderr or "").strip()[-400:])
    if "HAS_PY" not in (py.stdout or ""):
        return {
            "ok": False,
            "error": "Could not install python3 on the Flint",
            "stdout": "\n".join(logs),
            **read_bond_state(),
        }
    text = dest.read_text(encoding="utf-8")
    up = router_ssh("cat > /usr/share/wanbond.py", input_text=text, timeout=30)
    if up.returncode != 0:
        return {
            "ok": False,
            "error": "Could not copy bonder onto the Flint",
            "stdout": "\n".join(logs),
            "stderr": up.stderr or up.stdout,
            **read_bond_state(),
        }
    init = f"""#!/bin/sh /etc/rc.common
START=99
USE_PROCD=1
start_service() {{
  modprobe tun 2>/dev/null || true
  mkdir -p /dev/net
  [ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200 2>/dev/null || true
  sh /usr/share/wanbond-unkill.sh 2>/dev/null || true
  procd_open_instance
  procd_set_param command python3 /usr/share/wanbond.py client --key {wanbond_key()} --host {VPS_PUBLIC_IP} --port 8443 --ports 8443,51820,4410 --mode speed --egress vps --lan-bond
  procd_set_param respawn
  procd_close_instance
}}
stop_service() {{
  ip rule del from 192.168.8.0/24 lookup 80 2>/dev/null || true
  ip rule del from 192.168.8.0/24 to 192.168.8.0/24 lookup main 2>/dev/null || true
  ip route flush table 80 2>/dev/null || true
  ip link set smbond down 2>/dev/null || true
  kill $(pgrep -f '[p]ython3 /usr/share/wanbond.py') 2>/dev/null || true
  sh /usr/share/wanbond-unkill.sh 2>/dev/null || true
}}
"""
    router_ssh("cat > /usr/share/wanbond-unkill.sh", input_text=UNKILL_SH)
    router_ssh("chmod +x /usr/share/wanbond-unkill.sh")
    router_ssh(
        "cat > /etc/hotplug.d/iface/99-wanbond-unkill",
        input_text='#!/bin/sh\n[ "$ACTION" = ifup ] || exit 0\nsh /usr/share/wanbond-unkill.sh\n',
    )
    router_ssh("cat > /etc/init.d/wanbond", input_text=init)
    router_ssh("chmod +x /etc/init.d/wanbond /usr/share/wanbond.py && /etc/init.d/wanbond enable")
    router_ssh("sh /usr/share/wanbond-unkill.sh")
    return {"ok": True, "stdout": "\n".join(logs), **read_bond_state()}


def apply_bond_action(payload: dict) -> dict:
    action = str(payload.get("action") or "").strip().lower()
    with _bond_lock:
        if action in ("status", ""):
            return {"ok": True, **read_bond_state()}
        if action == "install":
            result = install_bond()
            return {"ok": result.get("ok"), "stdout": result.get("stdout"), "bond": result}
        if action in ("connect", "start"):
            install_bond()
            subprocess.run(["systemctl", "restart", "wanbond"], capture_output=True)
            r = router_ssh("/etc/init.d/wanbond restart || /etc/init.d/wanbond start")
            state = read_bond_state()
            return {
                "ok": True,
                "stdout": r.stdout or "started",
                "stderr": r.stderr,
                "bond": state,
                **state,
            }
        if action in ("disconnect", "stop"):
            r = router_ssh(
                "/etc/init.d/wanbond stop; "
                "kill $(pgrep -f '[p]ython3 /usr/share/wanbond.py') 2>/dev/null || true; "
                "ip rule del from 192.168.8.0/24 lookup 80 2>/dev/null || true; "
                "ip route flush table 80 2>/dev/null || true; ip link set smbond down 2>/dev/null || true; "
                "sh /usr/share/wanbond-unkill.sh 2>/dev/null || true"
            )
            state = read_bond_state()
            return {"ok": True, "stdout": r.stdout or "stopped", "bond": state, **state}
        raise ValueError("Unknown bond action")


def _json_from_cli(text: str):
    raw = (text or "").strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    for start_ch, end_ch in (("{", "}"), ("[", "]")):
        start = raw.find(start_ch)
        end = raw.rfind(end_ch)
        if start >= 0 and end > start:
            try:
                return json.loads(raw[start : end + 1])
            except json.JSONDecodeError:
                continue
    return None


LEASE_LINE_RE = re.compile(
    r"^\d+\s+"
    r"(?P<mac>(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})\s+"
    r"(?P<ip>\d{1,3}(?:\.\d{1,3}){3})\s+"
    r"(?P<hostname>\S+)"
)
ARP_LINE_RE = re.compile(
    r"^(?P<ip>\d{1,3}(?:\.\d{1,3}){3})\s+\S+\s+\S+\s+"
    r"(?P<mac>(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})\s+"
)
NEIGH_LINE_RE = re.compile(
    r"^(?P<ip>\d{1,3}(?:\.\d{1,3}){3})\s+dev\s+\S+\s+lladdr\s+"
    r"(?P<mac>(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})"
)


def parse_lan_devices(text: str) -> list[dict]:
    """Parse Flint DHCP leases + ARP/neigh into a UI-friendly device list."""
    by_ip: dict[str, dict] = {}

    def upsert(ip: str, *, mac: str = "", hostname: str = "", source: str = "") -> None:
        if not IP_RE.match(ip):
            return
        # Skip broadcast / weird
        if ip.endswith(".255") or ip.endswith(".0"):
            return
        cur = by_ip.get(ip)
        if not cur:
            by_ip[ip] = {
                "ip": ip,
                "mac": (mac or "").lower(),
                "hostname": "" if hostname in ("*", "-", "") else hostname,
                "source": source,
            }
            return
        if mac and not cur.get("mac"):
            cur["mac"] = mac.lower()
        if hostname and hostname not in ("*", "-", "") and not cur.get("hostname"):
            cur["hostname"] = hostname
        if source and source not in (cur.get("source") or ""):
            cur["source"] = f"{cur.get('source')}+{source}" if cur.get("source") else source

    section = "leases"
    for raw in text.splitlines():
        line = raw.strip()
        if line == "---LEASES---":
            section = "leases"
            continue
        if line == "---NEIGH---":
            section = "neigh"
            continue
        if section == "leases":
            m = LEASE_LINE_RE.match(line)
            if m:
                upsert(
                    m.group("ip"),
                    mac=m.group("mac"),
                    hostname=m.group("hostname"),
                    source="dhcp",
                )
            continue
        m = NEIGH_LINE_RE.match(line) or ARP_LINE_RE.match(line)
        if m:
            upsert(m.group("ip"), mac=m.group("mac"), source="arp")

    devices = list(by_ip.values())
    devices.sort(
        key=lambda d: (
            0 if str(d.get("hostname") or "").upper().startswith("WIN-") else 1,
            [int(x) for x in d["ip"].split(".")],
            str(d.get("hostname") or "").lower(),
        )
    )
    return devices


def read_lan_devices() -> dict:
    """Return GL.iNet LAN clients from DHCP leases (+ ARP when available)."""
    if not ROUTER_PASS:
        return {
            "ok": False,
            "error": "Router password not configured",
            "host": ROUTER_HOST,
            "devices": [],
        }
    proc = router_ssh(
        "echo '---LEASES---'; "
        "(cat /tmp/dhcp.leases 2>/dev/null || cat /var/dhcp.leases 2>/dev/null || true); "
        "echo '---NEIGH---'; "
        "(ip -4 neigh show 2>/dev/null || cat /proc/net/arp 2>/dev/null || true)",
        timeout=14,
    )
    if proc.returncode != 0:
        return {
            "ok": False,
            "error": (proc.stderr or proc.stdout or "router ssh failed").strip()[-500:],
            "host": ROUTER_HOST,
            "devices": [],
        }
    devices = parse_lan_devices(proc.stdout or "")
    return {
        "ok": True,
        "host": ROUTER_HOST,
        "count": len(devices),
        "devices": devices,
    }


def read_router_state() -> dict:
    proc = router_ssh(f"cat {ROUTER_CONF}", timeout=14)
    host = _router_host_in_use()
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "router ssh failed").strip()
        return {
            "ok": False,
            "error": err[-500:],
            "host": host,
            "path": ROUTER_CONF,
            "dmz_ip": "",
            "rules": [],
        }
    parsed = parse_router_conf(proc.stdout)
    return {
        "ok": True,
        "host": host,
        "path": ROUTER_CONF,
        "dmz_ip": parsed["dmz_ip"],
        "rules": parsed["rules"],
    }


def write_router_state(dmz_ip: str, rules: list[dict]) -> dict:
    dmz_ip, cleaned = validate_router(dmz_ip, rules)
    text = serialize_router_conf(dmz_ip, cleaned)
    # 1) Stream file over SSH stdin (GL.iNet ash has no base64)
    upload = router_ssh(f"cat > {ROUTER_CONF}.tmp", input_text=text)
    if upload.returncode != 0:
        return {
            "ok": False,
            "returncode": upload.returncode,
            "stdout": (upload.stdout or "")[-2000:],
            "stderr": (upload.stderr or "upload failed")[-2000:],
            "dmz_ip": dmz_ip,
            "rules": cleaned,
        }
    # 2) Activate config; reload firewall in background so SSH cannot hang
    remote = (
        f"mv {ROUTER_CONF}.tmp {ROUTER_CONF} && "
        f"( (/etc/init.d/firewall reload >/dev/null 2>&1 || fw3 reload >/dev/null 2>&1 || true) & ) && "
        f"(ubus call port_forward sync_config '{{}}' >/dev/null 2>&1 || true) && "
        f"echo OK && cat {ROUTER_CONF}"
    )
    proc = router_ssh(remote)
    ok = proc.returncode == 0 and "OK" in (proc.stdout or "")
    parsed = parse_router_conf(proc.stdout.split("OK\n", 1)[-1] if ok else text)
    return {
        "ok": ok,
        "returncode": proc.returncode,
        "stdout": ((upload.stdout or "") + "\n" + (proc.stdout or ""))[-4000:],
        "stderr": ((upload.stderr or "") + "\n" + (proc.stderr or ""))[-2000:],
        "dmz_ip": parsed["dmz_ip"],
        "rules": parsed["rules"],
    }


def read_vps_state() -> dict:
    text = CONF_PATH.read_text(encoding="utf-8") if CONF_PATH.exists() else ""
    parsed = parse_conf(text) if text.strip() else {"comments": [], "rules": []}
    managed = validate_vps_rules(parsed["rules"])
    existing = parse_live_dnat()
    # Add UFW GL allows that are not already covered by DNAT/managed
    covered = {(r["proto"], int(r["pub"])) for r in managed + existing}
    for r in parse_ufw_gl_forwards():
        key = (r["proto"], int(r["pub"]))
        if key not in covered:
            existing.append(r)
            covered.add(key)
    rules = merge_vps_lists(managed, existing)
    return {
        "path": str(CONF_PATH),
        "comments": parsed["comments"],
        "rules": rules,
    }


def write_vps_state(rules: list[dict], comments: list[str] | None = None) -> dict:
    cleaned = validate_vps_rules(rules)
    managed = [r for r in cleaned if not r.get("external")]
    # Always keep protected Flint admin HTTP/HTTPS forwards
    by_pub = {int(r["pub"]): r for r in managed}
    by_pub[8080] = {
        "pub": 8080,
        "proto": "tcp",
        "dest_ip": "192.168.8.1",
        "dest_port": 80,
        "name": "flint-http",
        "external": False,
    }
    by_pub[8443] = {
        "pub": 8443,
        "proto": "tcp",
        "dest_ip": "192.168.8.1",
        "dest_port": 443,
        "name": "flint-https",
        "external": False,
    }
    managed = list(by_pub.values())
    if comments is None:
        # Avoid recursion through live merge when reading comments only
        text = CONF_PATH.read_text(encoding="utf-8") if CONF_PATH.exists() else ""
        comments = parse_conf(text)["comments"] if text.strip() else []
    text = serialize_vps_conf(comments, managed)
    CONF_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONF_PATH.with_suffix(".conf.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(CONF_PATH)
    proc = subprocess.run(
        ["bash", str(APPLY_SCRIPT)],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    # Return merged live view again
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "stdout": (proc.stdout or "")[-4000:],
        "stderr": (proc.stderr or "")[-2000:],
        "rules": read_vps_state()["rules"] if proc.returncode == 0 else cleaned,
    }


def resolve_mail_hostname() -> str:
    candidates = []
    raw = os.environ.get("MAIL_ENV_PATH", "").strip()
    if raw:
        candidates.append(Path(raw))
    candidates.append(Path("/opt/truemail/.env"))
    for env_path in candidates:
        if not env_path.is_file():
            continue
        for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("MAIL_HOSTNAME="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.environ.get("MAIL_HOSTNAME", "mail.example.com")


def parse_caddy_existing_sites(caddy_text: str) -> list[dict]:
    """Parse non-managed site blocks into simple domain→proxy entries for the UI list."""
    # Strip managed hookups block so we only import "current" hand-written sites
    begin = caddy_text.find(HOOKUPS_BEGIN)
    end = caddy_text.find(HOOKUPS_END)
    if begin != -1 and end != -1 and end > begin:
        caddy_text = caddy_text[:begin] + caddy_text[end + len(HOOKUPS_END) :]

    sites: list[dict] = []
    # Match site openers like: domain {   or  domain1, domain2 {
    site_re = re.compile(
        r"(?m)^(?P<label>\{\$[A-Za-z0-9_]+\}|[A-Za-z0-9][A-Za-z0-9._*, -]*?)\s*\{\s*$"
    )
    proxy_re = re.compile(
        r"reverse_proxy\s+(?P<host>[^\s:]+)(?::(?P<port>\d+))?"
    )
    lines = caddy_text.splitlines()
    i = 0
    while i < len(lines):
        m = site_re.match(lines[i])
        if not m:
            i += 1
            continue
        label = m.group("label").strip()
        # skip snippets and raw IP listeners; keep {$ENV} site labels
        if label.startswith("(") or label.startswith("http://") or label.startswith("https://"):
            i += 1
            continue
        if label.startswith("{") and not label.startswith("{$"):
            i += 1
            continue
        # collect block body
        depth = 1
        body: list[str] = []
        i += 1
        while i < len(lines) and depth > 0:
            line = lines[i]
            depth += line.count("{") - line.count("}")
            if depth > 0:
                body.append(line)
            i += 1
        body_text = "\n".join(body)
        if "import " in body_text and "reverse_proxy" not in body_text:
            # e.g. portal.vpstruelord.com { import vpn_portal }
            target_host, target_port, name = DOCKER_HOST_GW, 5050, "vpn-portal"
        else:
            pm = proxy_re.search(body_text)
            if not pm:
                continue
            target_host = pm.group("host")
            target_port = int(pm.group("port") or "80")
            name = "existing"
        # support comma-separated site addresses
        for raw_domain in label.split(","):
            domain = raw_domain.strip()
            if domain.startswith("{$MAIL_HOSTNAME}"):
                domain = resolve_mail_hostname()
            domain = domain.lower()
            if not DOMAIN_RE.match(domain):
                continue
            if name == "existing":
                name = domain.split(".")[0][:40]
            vpn_only = bool(
                re.search(r"client_ip[^\n]*10\.8\.0\.0/24", body_text)
                or re.search(r"@vpn(?:_clients)?\s+client_ip", body_text)
            )
            sites.append(
                {
                    "enabled": True,
                    "domain": domain,
                    "target_host": target_host,
                    "target_port": target_port,
                    "name": name,
                    "external": True,
                    "vpn_only": vpn_only,
                }
            )
    return sites


def default_hookups() -> list[dict]:
    return []


def validate_hookups(rules: list[dict], *, allow_external: bool = True) -> list[dict]:
    if not isinstance(rules, list):
        raise ValueError("hookups must be a list")
    cleaned: list[dict] = []
    seen: set[str] = set()
    for i, rule in enumerate(rules):
        try:
            enabled = bool(rule.get("enabled", True))
            domain = str(rule["domain"]).strip().lower()
            target_host = str(rule["target_host"]).strip()
            target_port = int(rule["target_port"])
            name = str(rule.get("name", f"hook{i+1}")).strip() or f"hook{i+1}"
            external = bool(rule.get("external", False))
            vpn_only = _as_bool(rule.get("vpn_only", False))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"Hookup {i + 1}: missing/invalid fields") from exc
        if not DOMAIN_RE.match(domain):
            raise ValueError(f"Hookup {i + 1}: invalid domain")
        # docker service names like webmail / facesearch are allowed
        if not IP_RE.match(target_host) and not DOMAIN_RE.match(target_host) and not re.match(
            r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$", target_host
        ):
            raise ValueError(f"Hookup {i + 1}: invalid target_host")
        if not (1 <= target_port <= 65535):
            raise ValueError(f"Hookup {i + 1}: invalid target_port")
        if not NAME_RE.match(name):
            raise ValueError(f"Hookup {i + 1}: invalid name")
        if domain in seen:
            raise ValueError(f"Hookup {i + 1}: duplicate domain {domain}")
        seen.add(domain)
        if external and not allow_external:
            continue
        cleaned.append(
            {
                "enabled": enabled,
                "domain": domain,
                "target_host": target_host,
                "target_port": target_port,
                "name": name,
                "external": external,
                "vpn_only": vpn_only,
            }
        )
    return cleaned


def _as_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def serialize_hookups_caddy(rules: list[dict]) -> str:
    lines = [
        HOOKUPS_BEGIN,
        "# managed by ServerManager — do not edit by hand",
        f"# vpn_only allows: {VPN_CLIENT_CIDRS}",
    ]
    # Never rewrite external/pre-existing Caddy sites into this block
    active = [r for r in rules if r.get("enabled", True) and not r.get("external")]
    if not active:
        lines.append("# (no managed domain hookups enabled)")
    for r in active:
        lines.append(f"{r['domain']} {{")
        lines.append("\tencode gzip")
        if r.get("vpn_only"):
            # Explicit allow-list; everyone else gets a blank closed connection
            # (looks like nothing is hosted — no "VPN required" page).
            lines.append(f"\t@vpn_clients client_ip {VPN_CLIENT_CIDRS}")
            lines.append("\thandle @vpn_clients {")
            lines.append(f"\t\treverse_proxy {r['target_host']}:{r['target_port']}")
            lines.append("\t}")
            lines.append("\thandle {")
            lines.append("\t\tabort")
            lines.append("\t}")
        else:
            # Public: plain reverse_proxy only — no client_ip matcher residue.
            lines.append(f"\treverse_proxy {r['target_host']}:{r['target_port']}")
        lines.extend(
            [
                "\theader {",
                '\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains; preload"',
                "\t\tX-Content-Type-Options nosniff",
                "\t\tReferrer-Policy strict-origin-when-cross-origin",
                '\t\tContent-Security-Policy "frame-ancestors *"',
                "\t}",
                "}",
                "",
            ]
        )
    lines.append(HOOKUPS_END)
    return "\n".join(lines).rstrip() + "\n"


def upsert_caddy_hookups_block(caddy_text: str, block: str) -> str:
    begin = caddy_text.find(HOOKUPS_BEGIN)
    end = caddy_text.find(HOOKUPS_END)
    if begin != -1 and end != -1 and end > begin:
        end = end + len(HOOKUPS_END)
        return caddy_text[:begin].rstrip() + "\n\n" + block + "\n" + caddy_text[end:].lstrip("\n")
    return caddy_text.rstrip() + "\n\n" + block + "\n"


def merge_hookup_lists(managed: list[dict], existing: list[dict]) -> list[dict]:
    by_domain = {r["domain"]: dict(r) for r in existing}
    for r in managed:
        # managed entries win / overlay for same domain
        by_domain[r["domain"]] = {**by_domain.get(r["domain"], {}), **r, "external": False}
    # stable-ish order: existing first, then managed-only
    ordered: list[dict] = []
    seen: set[str] = set()
    for r in existing + managed:
        if r["domain"] in seen:
            continue
        ordered.append(by_domain[r["domain"]])
        seen.add(r["domain"])
    return ordered


def read_hookups_state() -> dict:
    managed: list[dict]
    if HOOKUPS_JSON.is_file():
        data = json.loads(HOOKUPS_JSON.read_text(encoding="utf-8"))
        managed = validate_hookups(data.get("rules", []))
    else:
        managed = default_hookups()

    existing: list[dict] = []
    if str(CADDYFILE_PATH) and CADDYFILE_PATH.is_file():
        try:
            existing = parse_caddy_existing_sites(
                CADDYFILE_PATH.read_text(encoding="utf-8")
            )
        except Exception:
            existing = []

    rules = merge_hookup_lists(managed, existing)
    return {
        "path": str(HOOKUPS_JSON),
        "caddyfile": str(CADDYFILE_PATH),
        "dns_hint": (
            (
                f"Cloudflare API configured — Save & Apply auto-creates A records → {VPS_PUBLIC_IP} "
                f"({'proxied' if CF_PROXIED else 'DNS only / grey cloud'}). "
            )
            if CF_API_TOKEN
            else (
                f"Create Cloudflare A records (DNS only / grey cloud) → {VPS_PUBLIC_IP}. "
            )
        )
        + f"VPN only = WireGuard/LAN clients ({VPN_CLIENT_CIDRS})",
        "vpn_cidrs": VPN_CLIENT_CIDRS,
        "rules": rules,
    }


def _cf_api(method: str, path: str, body: dict | None = None) -> tuple[bool, dict, str]:
    if not CF_API_TOKEN:
        return False, {}, "CF_API_TOKEN not set"
    import urllib.error
    import urllib.request

    url = path if path.startswith("http") else f"https://api.cloudflare.com/client/v4{path}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {CF_API_TOKEN}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="ignore")
        try:
            payload = json.loads(raw or "{}")
        except Exception:
            payload = {"errors": [{"message": raw[:300]}]}
        msgs = "; ".join(
            str(e.get("message") or e) for e in (payload.get("errors") or [])
        ) or f"HTTP {exc.code}"
        return False, payload, msgs
    except Exception as exc:
        return False, {}, str(exc)
    if not payload.get("success", False):
        msgs = "; ".join(
            str(e.get("message") or e) for e in (payload.get("errors") or [])
        ) or "Cloudflare API error"
        return False, payload, msgs
    return True, payload, ""


def resolve_cloudflare_zone_id() -> tuple[str, str]:
    """Return (zone_id, zone_name). Uses env or looks up CF_ZONE_NAME / parent of domains."""
    global CF_ZONE_ID, CF_ZONE_NAME
    if CF_ZONE_ID:
        return CF_ZONE_ID, CF_ZONE_NAME
    name = CF_ZONE_NAME.strip()
    if not name:
        return "", ""
    ok, payload, err = _cf_api("GET", f"/zones?name={name}")
    if not ok:
        raise RuntimeError(f"Cloudflare zone lookup failed: {err}")
    results = payload.get("result") or []
    if not results:
        raise RuntimeError(f"Cloudflare zone not found: {name}")
    CF_ZONE_ID = str(results[0].get("id") or "")
    CF_ZONE_NAME = str(results[0].get("name") or name)
    return CF_ZONE_ID, CF_ZONE_NAME


def ensure_cloudflare_dns_records(
    want_domains: list[str],
    remove_domains: list[str] | None = None,
) -> tuple[bool, str, str]:
    """Create/update Cloudflare A records for active domains; delete removed/disabled ones.

    Only deletes A records that currently point at VPS_PUBLIC_IP (safe).
    """
    want_domains = [d.strip().lower() for d in want_domains if d and "." in d]
    remove_domains = [
        d.strip().lower()
        for d in (remove_domains or [])
        if d and "." in d and d.strip().lower() not in set(want_domains)
    ]
    if not want_domains and not remove_domains:
        return True, "Cloudflare DNS: nothing to do", ""
    if not CF_API_TOKEN:
        return True, "Cloudflare DNS skipped (no CF_API_TOKEN)", ""
    try:
        zone_id, zone_name = resolve_cloudflare_zone_id()
    except Exception as exc:
        return False, "", str(exc)
    if not zone_id:
        # Infer zone from longest matching domain suffix by listing zones
        ok, payload, err = _cf_api("GET", "/zones?per_page=50")
        if not ok:
            return False, "", f"Cloudflare zones list failed: {err}"
        zones = payload.get("result") or []
        probe = (want_domains or remove_domains)[0]
        for z in zones:
            zname = str(z.get("name") or "").lower()
            if probe == zname or probe.endswith("." + zname):
                zone_id = str(z.get("id") or "")
                zone_name = zname
                break
        if not zone_id:
            return False, "", "Could not resolve Cloudflare zone for domains"

    def in_zone(domain: str) -> bool:
        if not zone_name:
            return True
        return domain == zone_name or domain.endswith("." + zone_name)

    logs: list[str] = []
    warnings: list[str] = []
    ok_all = True

    for domain in remove_domains:
        if not in_zone(domain):
            warnings.append(f"{domain}: outside zone {zone_name} (delete skipped)")
            continue
        ok, listed, err = _cf_api(
            "GET",
            f"/zones/{zone_id}/dns_records?type=A&name={domain}",
        )
        if not ok:
            ok_all = False
            warnings.append(f"{domain}: delete list failed ({err})")
            continue
        records = listed.get("result") or []
        if not records:
            logs.append(f"{domain}: no A record to delete")
            continue
        deleted_any = False
        for rec in records:
            if str(rec.get("content") or "") != VPS_PUBLIC_IP:
                warnings.append(
                    f"{domain}: left A {rec.get('content')} (not our VPS IP)"
                )
                continue
            rid = rec.get("id")
            if not rid:
                continue
            ok, _, err = _cf_api("DELETE", f"/zones/{zone_id}/dns_records/{rid}")
            if ok:
                deleted_any = True
                logs.append(f"{domain}: deleted A {VPS_PUBLIC_IP}")
            else:
                ok_all = False
                warnings.append(f"{domain}: delete failed ({err})")
        if not deleted_any and records:
            logs.append(f"{domain}: nothing deleted")

    for domain in want_domains:
        if not in_zone(domain):
            warnings.append(f"{domain}: outside zone {zone_name} (skipped)")
            continue
        ok, listed, err = _cf_api(
            "GET",
            f"/zones/{zone_id}/dns_records?type=A&name={domain}",
        )
        if not ok:
            ok_all = False
            warnings.append(f"{domain}: list failed ({err})")
            continue
        records = listed.get("result") or []
        payload = {
            "type": "A",
            "name": domain,
            "content": VPS_PUBLIC_IP,
            "ttl": 120,
            "proxied": CF_PROXIED,
        }
        if records:
            rid = records[0]["id"]
            same = (
                str(records[0].get("content") or "") == VPS_PUBLIC_IP
                and bool(records[0].get("proxied")) == CF_PROXIED
            )
            if same:
                logs.append(f"{domain}: A {VPS_PUBLIC_IP} already OK")
                continue
            ok, _, err = _cf_api(
                "PUT", f"/zones/{zone_id}/dns_records/{rid}", payload
            )
            if ok:
                mode = "proxied" if CF_PROXIED else "DNS-only"
                logs.append(f"{domain}: updated A → {VPS_PUBLIC_IP} ({mode})")
            else:
                ok_all = False
                warnings.append(f"{domain}: update failed ({err})")
        else:
            ok, _, err = _cf_api(
                "POST", f"/zones/{zone_id}/dns_records", payload
            )
            if ok:
                mode = "proxied" if CF_PROXIED else "DNS-only"
                logs.append(f"{domain}: created A → {VPS_PUBLIC_IP} ({mode})")
            else:
                ok_all = False
                warnings.append(f"{domain}: create failed ({err})")
    msg = "Cloudflare DNS: " + ("; ".join(logs) if logs else "no changes")
    if warnings:
        msg += " | WARN: " + "; ".join(warnings)
    return ok_all, msg, "\n".join(warnings)


def _dns_a_records(domain: str) -> list[str]:
    ips: list[str] = []
    queries = [
        ["getent", "ahostsv4", domain],
        ["dig", "+short", "A", domain],
        ["dig", "+short", "A", domain, "@1.1.1.1"],
        ["dig", "+short", "A", domain, "@8.8.8.8"],
    ]
    for cmd in queries:
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=10, check=False
            )
        except Exception:
            continue
        for line in (proc.stdout or "").splitlines():
            parts = line.split()
            cand = (parts[0] if parts else "").strip()
            if re.match(r"^\d+\.\d+\.\d+\.\d+$", cand):
                ips.append(cand)
        if ips:
            break
    return sorted(set(ips))


def _caddy_domain_has_cert(domain: str) -> bool:
    if not CADDY_CONTAINER:
        return False
    proc = subprocess.run(
        [
            "docker",
            "exec",
            CADDY_CONTAINER,
            "sh",
            "-c",
            f"find /data/caddy/certificates -type d -name '{domain}' 2>/dev/null | head -n 1",
        ],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    return bool((proc.stdout or "").strip())


def _https_probe_ok(domain: str) -> bool:
    proc = subprocess.run(
        [
            "curl",
            "-sS",
            "-m",
            "12",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            f"https://{domain}/",
        ],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    code = (proc.stdout or "").strip()
    return code.isdigit() and code != "000"


def ensure_hookup_certificates(domains: list[str]) -> tuple[bool, str, str]:
    """Make sure Caddy has issued TLS certs for managed domains (DNS must already point here)."""
    domains = [d.strip().lower() for d in domains if d and "." in d]
    if not domains or not CADDY_CONTAINER:
        return True, "No domains needing certs", ""

    logs: list[str] = []
    warnings: list[str] = []
    need: list[str] = []
    for domain in domains:
        ips = _dns_a_records(domain)
        if VPS_PUBLIC_IP not in ips:
            warnings.append(
                f"{domain}: DNS A record missing/incorrect (have {ips or ['none']}; need {VPS_PUBLIC_IP})"
            )
            continue
        if _caddy_domain_has_cert(domain) and _https_probe_ok(domain):
            logs.append(f"{domain}: certificate ready")
            continue
        need.append(domain)

    if not need:
        msg = "TLS: " + ("; ".join(logs) if logs else "nothing to do")
        if warnings:
            msg += " | WARN: " + "; ".join(warnings)
        return True, msg, "\n".join(warnings)

    logs.append(f"Requesting certificates for: {', '.join(need)}")
    # Reload first (picks up new site blocks), then restart if certs still missing.
    subprocess.run(
        [
            "docker",
            "exec",
            CADDY_CONTAINER,
            "caddy",
            "reload",
            "--config",
            "/etc/caddy/Caddyfile",
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    time.sleep(2)
    still = [d for d in need if not _caddy_domain_has_cert(d)]
    if still:
        logs.append(f"Restarting {CADDY_CONTAINER} to force ACME for: {', '.join(still)}")
        subprocess.run(
            ["docker", "restart", CADDY_CONTAINER],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        time.sleep(3)

    deadline = time.time() + 90
    pending = list(need)
    while pending and time.time() < deadline:
        pending = [d for d in pending if not _caddy_domain_has_cert(d)]
        if not pending:
            break
        time.sleep(3)

    ok = True
    for domain in need:
        if _caddy_domain_has_cert(domain):
            probe = "https ok" if _https_probe_ok(domain) else "cert present (https still warming)"
            logs.append(f"{domain}: {probe}")
        else:
            ok = False
            logs.append(f"{domain}: certificate not issued yet — check DNS and Caddy logs")

    if warnings:
        logs.extend(f"WARN: {w}" for w in warnings)
    return ok, "\n".join(logs), "\n".join(warnings)


def _write_text_inplace(path: Path, text: str) -> None:
    """Overwrite file bytes without replacing the inode.

    Docker bind-mounts pin the inode at container start. Atomic replace
    (tempfile + rename) leaves the container reading a stale Caddyfile, so
    disabling a domain in the panel would not take effect until restart.
    """
    data = text.encode("utf-8")
    if not path.exists():
        path.write_bytes(data)
        return
    with path.open("r+b") as fh:
        fh.seek(0)
        fh.write(data)
        fh.truncate(len(data))


def write_hookups_state(rules: list[dict]) -> dict:
    cleaned = validate_hookups(rules)
    # Persist only managed (non-external) rules; external stay in main Caddyfile
    managed = [r for r in cleaned if not r.get("external")]
    prev_domains: set[str] = set()
    if HOOKUPS_JSON.is_file():
        try:
            prev_data = json.loads(HOOKUPS_JSON.read_text(encoding="utf-8"))
            for r in validate_hookups(prev_data.get("rules", [])):
                if not r.get("external"):
                    prev_domains.add(r["domain"])
        except Exception:
            prev_domains = set()
    dns_hint = (
        (
            f"Cloudflare API on — Save & Apply creates/updates A records → {VPS_PUBLIC_IP} "
            f"({'proxied' if CF_PROXIED else 'DNS only'}); "
            "disabling or deleting a domain removes that A record. "
        )
        if CF_API_TOKEN
        else f"Point each domain A record to {VPS_PUBLIC_IP} (DNS only / grey cloud). "
    ) + "VPN unchecked = public HTTPS; VPN checked = WireGuard/LAN clients only."
    if not str(CADDYFILE_PATH) or not CADDYFILE_PATH.is_file():
        HOOKUPS_JSON.parent.mkdir(parents=True, exist_ok=True)
        HOOKUPS_JSON.write_text(
            json.dumps({"rules": managed}, indent=2) + "\n", encoding="utf-8"
        )
        return {
            "ok": True,
            "returncode": 0,
            "stdout": "Saved hookups.json (Caddy not configured — skipped reload)",
            "stderr": "",
            "rules": cleaned,
            "dns_hint": dns_hint,
        }
    if not CADDY_CONTAINER:
        return {
            "ok": False,
            "returncode": 1,
            "stdout": "",
            "stderr": "CADDY_CONTAINER env var required when CADDYFILE_PATH is set",
            "rules": cleaned,
            "dns_hint": dns_hint,
        }
    original = CADDYFILE_PATH.read_text(encoding="utf-8")
    new_block = serialize_hookups_caddy(managed)
    updated = upsert_caddy_hookups_block(original, new_block)
    block_changed = original != updated
    _write_text_inplace(CADDYFILE_PATH, updated)
    validate = subprocess.run(
        [
            "docker",
            "exec",
            CADDY_CONTAINER,
            "caddy",
            "validate",
            "--config",
            "/etc/caddy/Caddyfile",
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if validate.returncode != 0:
        _write_text_inplace(CADDYFILE_PATH, original)
        return {
            "ok": False,
            "returncode": validate.returncode,
            "stdout": (validate.stdout or "")[-4000:],
            "stderr": (validate.stderr or "")[-2000:] or "Caddy validate failed; rolled back",
            "rules": cleaned,
            "dns_hint": dns_hint,
        }

    reload = subprocess.run(
        [
            "docker",
            "exec",
            CADDY_CONTAINER,
            "caddy",
            "reload",
            "--config",
            "/etc/caddy/Caddyfile",
        ],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    restart_out = ""
    # VPN on/off and enable toggles must not leave stale client_ip routes.
    # Restart whenever the managed block changed, or whenever reload failed.
    if block_changed or reload.returncode != 0:
        rst = subprocess.run(
            ["docker", "restart", CADDY_CONTAINER],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        restart_out = (rst.stdout or "") + (rst.stderr or "")
        time.sleep(3)
        # Confirm container is up; reload is optional after restart (config loaded at start)
        alive = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", CADDY_CONTAINER],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if (alive.stdout or "").strip().lower() == "true":
            reload = subprocess.CompletedProcess(
                args=reload.args,
                returncode=0,
                stdout=(reload.stdout or "") + "\nCaddy restarted to apply VPN/public mode\n",
                stderr=reload.stderr or "",
            )
        else:
            reload = subprocess.CompletedProcess(
                args=reload.args,
                returncode=1,
                stdout=reload.stdout or "",
                stderr=(reload.stderr or "") + "\nCaddy restart failed\n" + restart_out,
            )

    # Persist JSON only after Caddy accepted the new config (keeps UI in sync)
    if reload.returncode == 0:
        HOOKUPS_JSON.parent.mkdir(parents=True, exist_ok=True)
        HOOKUPS_JSON.write_text(
            json.dumps({"rules": managed}, indent=2) + "\n", encoding="utf-8"
        )

    cert_ok = True
    cert_out = ""
    cert_err = ""
    dns_ok = True
    dns_out = ""
    dns_err = ""
    if reload.returncode == 0:
        active_domains = [
            r["domain"] for r in managed if r.get("enabled", True) and not r.get("vpn_only")
        ]
        # Also issue certs for VPN-only domains (needed so TLS works for VPN clients)
        active_domains += [
            r["domain"] for r in managed if r.get("enabled", True) and r.get("vpn_only")
        ]
        # unique preserve order
        seen: set[str] = set()
        ordered: list[str] = []
        for d in active_domains:
            if d not in seen:
                seen.add(d)
                ordered.append(d)
        remove_domains = sorted(prev_domains - set(ordered))
        dns_ok, dns_out, dns_err = ensure_cloudflare_dns_records(
            ordered, remove_domains=remove_domains
        )
        cert_ok, cert_out, cert_err = ensure_hookup_certificates(ordered)

    merged = merge_hookup_lists(managed, parse_caddy_existing_sites(updated if reload.returncode == 0 else original))
    ok = reload.returncode == 0 and cert_ok and dns_ok
    return {
        "ok": ok,
        "returncode": 0 if ok else (reload.returncode or 1),
        "stdout": (
            (
                (validate.stdout or "")
                + "\n"
                + (reload.stdout or "")
                + "\n"
                + dns_out
                + "\n"
                + cert_out
            )
        )[-4000:],
        "stderr": ((reload.stderr or "") + "\n" + dns_err + "\n" + cert_err)[-2000:],
        "rules": merged,
        "dns_hint": dns_hint,
    }


def read_state() -> dict:
    lan = {"ok": False, "devices": [], "error": "skipped"}
    try:
        lan = read_lan_devices()
    except Exception as exc:
        lan = {"ok": False, "devices": [], "error": str(exc), "host": ROUTER_HOST}
    return {
        "vps": read_vps_state(),
        "router": read_router_state(),
        "hookups": read_hookups_state(),
        "firewall": read_firewall_state(),
        "lan_devices": lan,
    }


def write_and_apply(payload: dict) -> dict:
    vps_in = payload.get("vps") or {}
    router_in = payload.get("router") or {}
    hookups_in = payload.get("hookups") or {}
    firewall_in = payload.get("firewall") or {}
    with _apply_lock:
        vps_result = write_vps_state(vps_in.get("rules", []), vps_in.get("comments"))
        router_result = write_router_state(
            router_in.get("dmz_ip", ""), router_in.get("rules", [])
        )
        if "rules" in hookups_in:
            hookups_result = write_hookups_state(hookups_in.get("rules", []))
        else:
            hookups_result = {"ok": True, "skipped": True, **read_hookups_state()}
        if "rules" in firewall_in:
            firewall_result = write_firewall_state(firewall_in.get("rules", []))
        else:
            firewall_result = {"ok": True, "skipped": True, **read_firewall_state()}
    return {
        "ok": bool(
            vps_result.get("ok")
            and router_result.get("ok")
            and hookups_result.get("ok")
            and firewall_result.get("ok")
        ),
        "vps": vps_result,
        "router": router_result,
        "hookups": hookups_result,
        "firewall": firewall_result,
    }


UFW_PROTECTED = {
    (22, "tcp"),  # SSH
    (5002, "tcp"),  # this admin UI
    (5000, "udp"),  # WireGuard tunnel
}

UFW_ROW_RE = re.compile(
    r"^\[\s*(?P<num>\d+)\]\s+(?P<to>.+?)\s{2,}(?P<action>ALLOW IN|DENY IN|REJECT IN)\s{2,}"
    r"(?P<frm>.+?)(?:\s+#\s*(?P<comment>.*))?$"
)


def _parse_ufw_to(to_field: str) -> tuple[int | None, str, str]:
    """Return (port, proto, display_to)."""
    raw = to_field.strip()
    ipv6 = "(v6)" in raw
    cleaned = raw.replace("(v6)", "").strip()
    # OpenSSH app profile
    if cleaned.lower().startswith("openssh"):
        return 22, "tcp", cleaned
    m = re.match(r"^(\d+)(?:/(tcp|udp))?$", cleaned, re.I)
    if m:
        return int(m.group(1)), (m.group(2) or "tcp").lower(), cleaned
    return None, "tcp", cleaned


def _is_vpn_ufw_from(frm: str) -> bool:
    f = (frm or "").lower().replace(" ", "")
    if f.startswith("anywhere"):
        return False
    return VPN_UFW_FROM.replace(" ", "") in f or f.startswith("10.8.0.")


def read_firewall_state() -> dict:
    verbose = subprocess.run(
        ["ufw", "status", "verbose"],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    numbered = subprocess.run(
        ["ufw", "status", "numbered"],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    active = False
    default_in = "deny"
    default_out = "allow"
    default_routed = "deny"
    for line in (verbose.stdout or "").splitlines():
        if line.startswith("Status:"):
            active = "active" in line.lower()
        if line.startswith("Default:"):
            # Default: deny (incoming), allow (outgoing), deny (routed)
            parts = line.lower()
            if "allow (incoming)" in parts:
                default_in = "allow"
            if "deny (incoming)" in parts:
                default_in = "deny"
            if "allow (outgoing)" in parts:
                default_out = "allow"
            if "deny (outgoing)" in parts:
                default_out = "deny"
            if "allow (routed)" in parts:
                default_routed = "allow"
            if "deny (routed)" in parts:
                default_routed = "deny"

    rules: list[dict] = []
    seen: set[tuple[int, str]] = set()
    for line in (numbered.stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("["):
            continue
        m = UFW_ROW_RE.match(line)
        if not m:
            continue
        frm = m.group("frm").strip()
        to_raw = m.group("to")
        if "(v6)" in to_raw or "(v6)" in frm.lower():
            continue  # manage IPv4 rules; ufw allow adds v6 twin
        if "ALLOW" not in m.group("action"):
            continue
        port, proto, to_disp = _parse_ufw_to(to_raw)
        if port is None:
            continue
        key = (port, proto)
        if key in seen:
            continue
        seen.add(key)
        comment = (m.group("comment") or "").strip() or f"port-{port}"
        locked = key in UFW_PROTECTED
        vpn_only = (not locked) and _is_vpn_ufw_from(frm)
        rules.append(
            {
                "id": int(m.group("num")),
                "port": port,
                "proto": proto,
                "action": "allow",
                "from": "Anywhere" if frm.lower().startswith("anywhere") else frm,
                "comment": comment,
                "to": to_disp,
                "locked": locked,
                "vpn_only": vpn_only,
            }
        )
    return {
        "active": active,
        "default_incoming": default_in,
        "default_outgoing": default_out,
        "default_routed": default_routed,
        "vpn_from": VPN_UFW_FROM,
        "rules": rules,
    }


def validate_firewall_rules(rules: list[dict]) -> list[dict]:
    if not isinstance(rules, list):
        raise ValueError("firewall rules must be a list")
    cleaned: list[dict] = []
    seen: set[tuple[int, str]] = set()
    for i, rule in enumerate(rules):
        try:
            port = int(rule["port"])
            proto = str(rule.get("proto", "tcp")).lower().strip()
            action = str(rule.get("action", "allow")).lower().strip()
            comment = str(rule.get("comment", f"port-{port}")).strip() or f"port-{port}"
            vpn_only = bool(rule.get("vpn_only", False))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"Firewall rule {i + 1}: invalid fields") from exc
        if proto not in ("tcp", "udp"):
            raise ValueError(f"Firewall rule {i + 1}: proto must be tcp or udp")
        if action not in ("allow",):
            raise ValueError(f"Firewall rule {i + 1}: only allow rules are supported")
        if not (1 <= port <= 65535):
            raise ValueError(f"Firewall rule {i + 1}: invalid port")
        if not re.match(r"^[A-Za-z0-9 _.:/-]{1,60}$", comment):
            raise ValueError(f"Firewall rule {i + 1}: invalid comment")
        key = (port, proto)
        if key in seen:
            raise ValueError(f"Firewall rule {i + 1}: duplicate {port}/{proto}")
        seen.add(key)
        locked = key in UFW_PROTECTED
        if locked:
            vpn_only = False  # never VPN-restrict SSH / UI / WG listen
        cleaned.append(
            {
                "port": port,
                "proto": proto,
                "action": action,
                "comment": comment,
                "locked": locked,
                "vpn_only": vpn_only,
            }
        )
    # Ensure protected rules always remain (public)
    for port, proto in UFW_PROTECTED:
        if (port, proto) not in seen:
            labels = {
                (22, "tcp"): "SSH",
                (5002, "tcp"): "Port forward UI",
                (5000, "udp"): "WireGuard VPN tunnel",
            }
            cleaned.append(
                {
                    "port": port,
                    "proto": proto,
                    "action": "allow",
                    "comment": labels.get((port, proto), f"protected-{port}"),
                    "locked": True,
                    "vpn_only": False,
                }
            )
    return cleaned


def _ufw_allow_cmd(rule: dict) -> list[str]:
    port = rule["port"]
    proto = rule["proto"]
    comment = rule["comment"]
    if rule.get("vpn_only") and (port, proto) not in UFW_PROTECTED:
        return [
            "ufw",
            "allow",
            "from",
            VPN_UFW_FROM,
            "to",
            "any",
            "port",
            str(port),
            "proto",
            proto,
            "comment",
            comment,
        ]
    return ["ufw", "allow", f"{port}/{proto}", "comment", comment]


def write_firewall_state(rules: list[dict]) -> dict:
    desired = validate_firewall_rules(rules)
    desired_keys = {(r["port"], r["proto"]): r for r in desired}
    logs: list[str] = []

    # Delete current IPv4/v6 rules that are unwanted or need recreate (vpn_only change)
    numbered = subprocess.run(
        ["ufw", "status", "numbered"],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    rows: list[tuple[int, int, str, bool, bool]] = []
    for line in (numbered.stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("["):
            continue
        m = UFW_ROW_RE.match(line)
        if not m:
            continue
        port, proto, _ = _parse_ufw_to(m.group("to"))
        if port is None:
            continue
        frm = m.group("frm").strip()
        ipv6 = "v6" in frm.lower() or "(v6)" in m.group("to")
        vpn_only = _is_vpn_ufw_from(frm)
        rows.append((int(m.group("num")), port, proto, ipv6, vpn_only))

    # Delete from highest number so indices stay stable
    for num, port, proto, _ipv6, cur_vpn in sorted(rows, key=lambda x: x[0], reverse=True):
        if (port, proto) in UFW_PROTECTED:
            continue
        want = desired_keys.get((port, proto))
        if want is None:
            pass  # delete
        elif bool(want.get("vpn_only")) == bool(cur_vpn):
            continue  # keep matching rule
        # else recreate (vpn_only flipped)
        proc = subprocess.run(
            ["ufw", "--force", "delete", str(num)],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        logs.append(
            f"delete {num} {port}/{proto}: rc={proc.returncode} {(proc.stdout or proc.stderr or '').strip()}"
        )

    # Refresh and add missing / recreated
    after = read_firewall_state()
    have = {
        (r["port"], r["proto"]): bool(r.get("vpn_only")) for r in after["rules"]
    }
    for key, rule in desired_keys.items():
        if key in have and have[key] == bool(rule.get("vpn_only")):
            continue
        proc = subprocess.run(
            _ufw_allow_cmd(rule),
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        scope = "vpn" if rule.get("vpn_only") else "public"
        logs.append(
            f"allow {rule['port']}/{rule['proto']} ({scope}): rc={proc.returncode} {(proc.stdout or proc.stderr or '').strip()}"
        )

    # Ensure ufw enabled with deny incoming
    subprocess.run(["ufw", "--force", "enable"], capture_output=True, text=True, timeout=20)
    final = read_firewall_state()
    return {
        "ok": True,
        "stdout": "\n".join(logs)[-4000:],
        "stderr": "",
        **final,
    }


def _cookie_clear_header() -> str:
    return (
        f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; "
        "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
    )


def _cookie_set_header(token: str) -> str:
    return (
        f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; "
        f"Max-Age={int(SESSION_HOURS * 3600)}"
    )


def check_basic_auth(header: str | None) -> bool:
    if not ALLOW_BASIC_AUTH:
        return False
    if not header or not header.startswith("Basic "):
        return False
    try:
        decoded = base64.b64decode(header.split(" ", 1)[1]).decode("utf-8")
        user, _, password = decoded.partition(":")
    except Exception:
        return False
    return hmac.compare_digest(user, AUTH_USER) and hmac.compare_digest(
        password, AUTH_PASS
    )


def _purge_sessions(now: float | None = None) -> None:
    now = time.time() if now is None else now
    dead = [k for k, exp in _sessions.items() if exp <= now]
    for k in dead:
        _sessions.pop(k, None)


def create_session() -> str:
    token = secrets.token_urlsafe(32)
    with _sessions_lock:
        _purge_sessions()
        _sessions[token] = time.time() + SESSION_HOURS * 3600
    return token


def destroy_session(token: str | None) -> None:
    if not token:
        return
    with _sessions_lock:
        _sessions.pop(token, None)


def session_valid(token: str | None) -> bool:
    if not token:
        return False
    now = time.time()
    with _sessions_lock:
        _purge_sessions(now)
        exp = _sessions.get(token)
        return bool(exp and exp > now)


def parse_session_cookie(header: str | None) -> str | None:
    if not header:
        return None
    jar = SimpleCookie()
    try:
        jar.load(header)
    except Exception:
        return None
    morsel = jar.get(COOKIE_NAME)
    return morsel.value if morsel else None


def check_credentials(username: str, password: str) -> bool:
    return hmac.compare_digest(username, AUTH_USER) and hmac.compare_digest(
        password, AUTH_PASS
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "ServerManager/1.2"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {self.address_string()} {fmt % args}")

    def _unauthorized(self, *, api: bool = True) -> None:
        if api:
            self._json(401, {"error": "unauthorized"})
            return
        self.send_response(302)
        self.send_header("Location", "/login.html")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _json(self, code: int, payload: dict, *, set_cookie: str | None = None, clear_cookie: bool = False) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if set_cookie:
            self.send_header("Set-Cookie", _cookie_set_header(set_cookie))
        if clear_cookie:
            self.send_header("Set-Cookie", _cookie_clear_header())
        self.end_headers()
        self.wfile.write(body)

    def _is_authed(self) -> bool:
        if check_basic_auth(self.headers.get("Authorization")):
            return True
        return session_valid(parse_session_cookie(self.headers.get("Cookie")))

    def _require_auth(self, *, api: bool = True) -> bool:
        if self._is_authed():
            return True
        self._unauthorized(api=api)
        return False

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/logout":
            destroy_session(parse_session_cookie(self.headers.get("Cookie")))
            body = (
                b"<!DOCTYPE html><html><head>"
                b'<meta charset="utf-8" />'
                b'<meta http-equiv="refresh" content="0;url=/login.html" />'
                b"<title>Signing out</title>"
                b"<script>location.replace('/login.html');</script>"
                b"</head><body>Signed out. <a href='/login.html'>Continue</a></body></html>"
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Set-Cookie", _cookie_clear_header())
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path in ("/login.html", "/api/branding", "/api/health") or path.startswith("/static/"):
            pass  # public
        elif not self._is_authed():
            if path.startswith("/api/"):
                self._unauthorized(api=True)
            else:
                self._unauthorized(api=False)
            return

        if path == "/api/branding":
            self._json(
                200,
                {
                    "title": PANEL_TITLE,
                    "tagline": PANEL_TAGLINE,
                },
            )
            return
        if path == "/api/me":
            self._json(200, {"ok": True, "user": AUTH_USER, "title": PANEL_TITLE})
            return
        if path == "/api/forwards":
            try:
                self._json(200, read_state())
            except Exception as exc:
                self._json(500, {"error": str(exc)})
            return
        if path == "/api/lan-devices":
            try:
                self._json(200, read_lan_devices())
            except Exception as exc:
                self._json(500, {"error": str(exc), "devices": []})
            return
        if path == "/api/bond":
            try:
                self._json(200, read_bond_state())
            except Exception as exc:
                self._json(500, {"ok": False, "error": str(exc), "installed": False})
            return
        if path == "/api/health":
            self._json(200, {"ok": True})
            return
        if path in ("/", "/index.html"):
            return self._serve_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
        if path == "/login.html":
            # Always clear any stale session display path; if still authed, go home
            if self._is_authed():
                self.send_response(302)
                self.send_header("Location", "/")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            return self._serve_file(STATIC_DIR / "login.html", "text/html; charset=utf-8")
        if path.startswith("/static/"):
            rel = path[len("/static/") :]
            target = (STATIC_DIR / rel).resolve()
            if not str(target).startswith(str(STATIC_DIR.resolve())):
                self._json(404, {"error": "not found"})
                return
            ctype = "text/css" if target.suffix == ".css" else "application/javascript"
            if target.suffix == ".html":
                ctype = "text/html; charset=utf-8"
            return self._serve_file(target, ctype)
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/login":
            try:
                payload = self._read_json()
                user = str(payload.get("username", "")).strip()
                password = str(payload.get("password", ""))
            except Exception:
                self._json(400, {"error": "invalid json"})
                return
            if not check_credentials(user, password):
                time.sleep(0.35)
                self._json(401, {"error": "Invalid username or password"})
                return
            token = create_session()
            self._json(200, {"ok": True, "user": AUTH_USER}, set_cookie=token)
            return
        if path == "/api/logout":
            destroy_session(parse_session_cookie(self.headers.get("Cookie")))
            self._json(200, {"ok": True}, clear_cookie=True)
            return
        if not self._require_auth(api=True):
            return
        if path == "/api/bond":
            try:
                payload = self._read_json()
                result = apply_bond_action(payload if isinstance(payload, dict) else {})
                self._json(200 if result.get("ok") else 400, result)
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            except Exception as exc:
                self._json(500, {"error": str(exc)})
            return
        self._json(404, {"error": "not found"})

    def do_PUT(self) -> None:  # noqa: N802
        if not self._require_auth(api=True):
            return
        path = urlparse(self.path).path
        if path != "/api/forwards":
            self._json(404, {"error": "not found"})
            return
        try:
            payload = self._read_json()
            # Backward compatible: flat {rules} => vps only payload shape
            if "vps" not in payload and "rules" in payload:
                payload = {
                    "vps": {"rules": payload.get("rules"), "comments": payload.get("comments")},
                    "router": payload.get("router") or {},
                }
            result = write_and_apply(payload)
            # Ensure JSON-serializable summary always includes a top-level error hint
            if not result.get("ok"):
                bits = []
                for key in ("vps", "router", "hookups", "firewall"):
                    part = result.get(key) or {}
                    if part.get("ok") is False:
                        bits.append(
                            f"{key}: {(part.get('stderr') or part.get('stdout') or 'failed')[-500:]}"
                        )
                if bits and not result.get("error"):
                    result["error"] = " | ".join(bits)
            self._json(200 if result["ok"] else 500, result)
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except Exception as exc:
            self._json(500, {"error": str(exc)})

    def _serve_file(self, path: Path, content_type: str) -> None:
        if not path.is_file():
            self._json(404, {"error": "not found"})
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    require_auth_configured()
    if not APPLY_SCRIPT.is_file():
        raise SystemExit(f"Apply script missing: {APPLY_SCRIPT}")
    # Ensure sshpass exists
    if subprocess.run(["bash", "-lc", "command -v sshpass"], capture_output=True).returncode != 0:
        raise SystemExit("sshpass is required on the VPS (apt install sshpass)")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"ServerManager panel on http://{HOST}:{PORT}")
    print(f"  title:    {PANEL_TITLE}")
    print(f"  vps conf: {CONF_PATH}")
    print(f"  router:   {ROUTER_USER}@{ROUTER_HOST}:{ROUTER_CONF}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
