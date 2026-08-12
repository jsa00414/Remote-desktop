const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 5000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "8112026";
const DISPLAY = process.env.DISPLAY || ":1";
const FRAME_FPS = Number(process.env.FRAME_FPS) || 8;
const FRAME_QUALITY = Number(process.env.FRAME_QUALITY) || 5;
const FRAME_SCALE = process.env.FRAME_SCALE || "1280:-1";
const SKIP_LOCAL_HOST = process.env.SKIP_LOCAL_HOST === "1";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 2e6,
});

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

/** @typedef {{ id: string, name: string, pin: string, setupCode: string, createdAt: string, lastSeenAt: string | null }} HostRecord */

/** @type {HostRecord[]} */
let hosts = [];

/** Runtime presence: hostId -> socket id / mode */
const onlineHosts = new Map();
/** client socket -> { hostId } */
const authedClients = new Map();
/** admin sessions */
const adminTokens = new Set();

let captureProc = null;
let displaySize = { width: 1280, height: 720 };
let lastFrame = null;
let localHostId = null;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadHosts() {
  ensureDataDir();
  if (!fs.existsSync(HOSTS_FILE)) {
    hosts = [];
    saveHosts();
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(HOSTS_FILE, "utf8"));
    hosts = Array.isArray(raw.hosts) ? raw.hosts : [];
  } catch {
    hosts = [];
  }
}

function saveHosts() {
  ensureDataDir();
  fs.writeFileSync(
    HOSTS_FILE,
    JSON.stringify({ hosts }, null, 2),
    "utf8"
  );
}

function randomCode(len = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function publicHost(h) {
  const online = onlineHosts.has(h.id);
  return {
    id: h.id,
    name: h.name,
    online,
    mode: onlineHosts.get(h.id)?.mode || null,
    createdAt: h.createdAt,
    lastSeenAt: h.lastSeenAt,
  };
}

function requireAdmin(req, res, next) {
  const token = String(req.headers["x-admin-token"] || "");
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ ok: false, error: "Admin login required" });
  }
  return next();
}

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    hostCount: hosts.length,
    onlineCount: onlineHosts.size,
  });
});

app.get("/api/hosts", (_req, res) => {
  res.json({
    ok: true,
    hosts: hosts.map(publicHost),
  });
});

app.post("/api/admin/login", (req, res) => {
  const password = String(req.body?.password ?? "");
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  const token = crypto.randomBytes(24).toString("base64url");
  adminTokens.add(token);
  return res.json({ ok: true, token });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  const token = String(req.headers["x-admin-token"] || "");
  adminTokens.delete(token);
  res.json({ ok: true });
});

app.get("/api/admin/hosts", requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    hosts: hosts.map((h) => ({
      ...publicHost(h),
      pin: h.pin,
      setupCode: h.setupCode,
    })),
  });
});

app.post("/api/admin/hosts", requireAdmin, (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 64);
  if (!name) {
    return res.status(400).json({ ok: false, error: "Host name is required" });
  }
  const pin = String(req.body?.pin || "").trim() || "8112026";
  if (!/^\d{4,12}$/.test(pin)) {
    return res.status(400).json({
      ok: false,
      error: "PIN must be 4–12 digits",
    });
  }

  const host = {
    id: crypto.randomUUID(),
    name,
    pin,
    setupCode: randomCode(10),
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
  };
  hosts.push(host);
  saveHosts();
  return res.status(201).json({
    ok: true,
    host: {
      ...publicHost(host),
      pin: host.pin,
      setupCode: host.setupCode,
    },
  });
});

app.patch("/api/admin/hosts/:id", requireAdmin, (req, res) => {
  const host = hosts.find((h) => h.id === req.params.id);
  if (!host) return res.status(404).json({ ok: false, error: "Host not found" });

  if (typeof req.body?.name === "string" && req.body.name.trim()) {
    host.name = req.body.name.trim().slice(0, 64);
  }
  if (typeof req.body?.pin === "string" && req.body.pin.trim()) {
    const pin = req.body.pin.trim();
    if (!/^\d{4,12}$/.test(pin)) {
      return res.status(400).json({ ok: false, error: "PIN must be 4–12 digits" });
    }
    host.pin = pin;
  }
  if (req.body?.rotateSetupCode) {
    host.setupCode = randomCode(10);
  }
  saveHosts();
  return res.json({
    ok: true,
    host: {
      ...publicHost(host),
      pin: host.pin,
      setupCode: host.setupCode,
    },
  });
});

app.delete("/api/admin/hosts/:id", requireAdmin, (req, res) => {
  const idx = hosts.findIndex((h) => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "Host not found" });
  const [removed] = hosts.splice(idx, 1);
  saveHosts();

  const runtime = onlineHosts.get(removed.id);
  if (runtime?.socketId) {
    io.to(runtime.socketId).emit("host:removed");
  }
  onlineHosts.delete(removed.id);
  io.emit("hosts:updated");
  return res.json({ ok: true });
});

app.post("/api/connect", (req, res) => {
  const hostId = String(req.body?.hostId || "");
  const pin = String(req.body?.pin || "");
  const host = hosts.find((h) => h.id === hostId);
  if (!host) return res.status(404).json({ ok: false, error: "Host not found" });
  if (host.pin !== pin) {
    return res.status(401).json({ ok: false, error: "Incorrect PIN" });
  }
  if (!onlineHosts.has(host.id)) {
    return res.status(503).json({
      ok: false,
      error: "That computer is offline. Open /host on it and enter the setup code.",
    });
  }
  return res.json({
    ok: true,
    host: publicHost(host),
  });
});

app.get(["/admin", "/admin.html"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get(["/host", "/host.html"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "host.html"));
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/socket.io")) {
    return next();
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function probeDisplaySize() {
  return new Promise((resolve) => {
    const proc = spawn(
      "bash",
      ["-lc", `DISPLAY=${DISPLAY} xdotool getdisplaygeometry`],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    proc.on("close", () => {
      const match = out.trim().match(/^(\d+)\s+(\d+)/);
      if (match) {
        displaySize = {
          width: Number(match[1]),
          height: Number(match[2]),
        };
      }
      resolve(displaySize);
    });
  });
}

function startCapture() {
  if (captureProc || !localHostId) return;

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-video_size",
    `${displaySize.width}x${displaySize.height}`,
    "-framerate",
    String(FRAME_FPS),
    "-i",
    DISPLAY,
    "-vf",
    `scale=${FRAME_SCALE}`,
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-q:v",
    String(FRAME_QUALITY),
    "pipe:1",
  ];

  try {
    captureProc = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DISPLAY },
    });
  } catch (err) {
    console.error("ffmpeg spawn failed:", err.message);
    captureProc = null;
    return;
  }

  let buffer = Buffer.alloc(0);
  const SOI = Buffer.from([0xff, 0xd8]);
  const EOI = Buffer.from([0xff, 0xd9]);

  captureProc.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const start = buffer.indexOf(SOI);
      if (start === -1) {
        buffer = Buffer.alloc(0);
        break;
      }
      if (start > 0) buffer = buffer.subarray(start);
      const end = buffer.indexOf(EOI, 2);
      if (end === -1) break;
      const frame = buffer.subarray(0, end + 2);
      buffer = buffer.subarray(end + 2);
      lastFrame = frame;
      io.to(`host:${localHostId}`).emit("frame", frame);
    }
  });

  captureProc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error("[ffmpeg]", text);
  });

  captureProc.on("error", (err) => {
    console.error("ffmpeg error:", err.message);
    captureProc = null;
  });

  captureProc.on("exit", () => {
    captureProc = null;
    setTimeout(() => startCapture(), 3000);
  });

  console.log(`Local screen capture on ${DISPLAY}`);
}

function runXdotool(args) {
  return new Promise((resolve) => {
    const proc = spawn("xdotool", args, {
      env: { ...process.env, DISPLAY },
      stdio: "ignore",
    });
    proc.on("close", () => resolve());
    proc.on("error", () => resolve());
  });
}

function clamp01(n) {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

async function handleLocalInput(event) {
  if (!event || typeof event !== "object") return;
  const w = displaySize.width;
  const h = displaySize.height;

  switch (event.type) {
    case "mousemove": {
      const x = Math.round(clamp01(event.x) * (w - 1));
      const y = Math.round(clamp01(event.y) * (h - 1));
      await runXdotool(["mousemove", "--sync", String(x), String(y)]);
      break;
    }
    case "mousedown":
    case "mouseup": {
      const x = Math.round(clamp01(event.x) * (w - 1));
      const y = Math.round(clamp01(event.y) * (h - 1));
      await runXdotool(["mousemove", "--sync", String(x), String(y)]);
      const button = event.button === 2 ? "3" : event.button === 1 ? "2" : "1";
      await runXdotool([event.type, button]);
      break;
    }
    case "wheel": {
      const steps = Math.min(8, Math.max(1, Math.round(Math.abs(event.deltaY) / 40)));
      const button = event.deltaY > 0 ? "5" : "4";
      for (let i = 0; i < steps; i += 1) await runXdotool(["click", button]);
      break;
    }
    case "keydown": {
      const key = mapKey(event);
      if (key) await runXdotool(["key", key]);
      break;
    }
    default:
      break;
  }
}

function mapKey(event) {
  const special = {
    Enter: "Return",
    Escape: "Escape",
    Backspace: "BackSpace",
    Tab: "Tab",
    " ": "space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "Page_Up",
    PageDown: "Page_Down",
  };
  if (special[event.key]) return special[event.key];
  if (event.key && event.key.length === 1) {
    const ch = event.key;
    if (/[a-zA-Z0-9]/.test(ch)) return ch;
  }
  return null;
}

function ensureLocalHost() {
  let local = hosts.find((h) => h.name === "This server");
  if (!local) {
    local = {
      id: crypto.randomUUID(),
      name: "This server",
      pin: "8112026",
      setupCode: randomCode(10),
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    hosts.push(local);
    saveHosts();
  }
  localHostId = local.id;
  onlineHosts.set(local.id, { mode: "local", socketId: null });
  local.lastSeenAt = new Date().toISOString();
  saveHosts();
}

io.on("connection", (socket) => {
  socket.on("host:register", (payload, ack) => {
    const setupCode = String(payload?.setupCode || "").trim().toUpperCase();
    const host = hosts.find((h) => h.setupCode === setupCode);
    if (!host) {
      if (typeof ack === "function") {
        ack({ ok: false, error: "Invalid setup code" });
      }
      return;
    }

    const prev = onlineHosts.get(host.id);
    if (prev?.socketId && prev.socketId !== socket.id) {
      io.to(prev.socketId).emit("host:replaced");
    }

    onlineHosts.set(host.id, { mode: "webrtc", socketId: socket.id });
    host.lastSeenAt = new Date().toISOString();
    saveHosts();
    socket.data.hostId = host.id;
    socket.join(`agent:${host.id}`);
    io.emit("hosts:updated");

    if (typeof ack === "function") {
      ack({ ok: true, host: publicHost(host) });
    }
  });

  socket.on("client:auth", (payload, ack) => {
    const hostId = String(payload?.hostId || "");
    const pin = String(payload?.pin || "");
    const host = hosts.find((h) => h.id === hostId);
    if (!host) {
      if (typeof ack === "function") ack({ ok: false, error: "Host not found" });
      return;
    }
    if (host.pin !== pin) {
      if (typeof ack === "function") ack({ ok: false, error: "Incorrect PIN" });
      return;
    }
    const runtime = onlineHosts.get(host.id);
    if (!runtime) {
      if (typeof ack === "function") {
        ack({ ok: false, error: "Host is offline" });
      }
      return;
    }

    authedClients.set(socket.id, { hostId: host.id });
    socket.join(`host:${host.id}`);
    socket.data.hostId = host.id;

    if (typeof ack === "function") {
      ack({
        ok: true,
        host: publicHost(host),
        mode: runtime.mode,
        agentSocketId: runtime.socketId,
        size: displaySize,
      });
    }

    if (runtime.mode === "local" && lastFrame) {
      socket.emit("frame", lastFrame);
    }

    if (runtime.mode === "webrtc" && runtime.socketId) {
      io.to(runtime.socketId).emit("client:joined", { clientId: socket.id });
    }
  });

  socket.on("signal", (msg) => {
    if (!msg || typeof msg !== "object") return;
    const { to, data } = msg;
    const hostId = socket.data.hostId;
    if (!hostId) return;

    const runtime = onlineHosts.get(hostId);
    const client = authedClients.get(socket.id);

    if (runtime?.socketId === socket.id) {
      if (to && authedClients.has(to) && authedClients.get(to).hostId === hostId) {
        io.to(to).emit("signal", { from: socket.id, data });
      }
      return;
    }

    if (client && runtime?.socketId) {
      io.to(runtime.socketId).emit("signal", { from: socket.id, data });
    }
  });

  socket.on("input", (event) => {
    const client = authedClients.get(socket.id);
    if (!client) return;
    const runtime = onlineHosts.get(client.hostId);
    if (!runtime) return;

    if (runtime.mode === "local") {
      handleLocalInput(event);
      return;
    }
    if (runtime.socketId) {
      io.to(runtime.socketId).emit("input", event);
    }
  });

  socket.on("disconnect", () => {
    authedClients.delete(socket.id);

    const hostId = socket.data.hostId;
    if (hostId) {
      const runtime = onlineHosts.get(hostId);
      if (runtime?.socketId === socket.id) {
        onlineHosts.delete(hostId);
        io.to(`host:${hostId}`).emit("host:disconnected");
        io.emit("hosts:updated");
      }
    }
  });
});

async function main() {
  loadHosts();
  if (!SKIP_LOCAL_HOST) {
    await probeDisplaySize();
    ensureLocalHost();
    startCapture();
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Remote desktop on http://0.0.0.0:${PORT}`);
    console.log(`Admin password: ${ADMIN_PASSWORD}`);
    console.log(`Separate from True Mail — bind port ${PORT} only`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
