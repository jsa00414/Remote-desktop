const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const ACCESS_PASSWORD = "8112026";
const HOST_NAME = process.env.HOST_NAME || "Connected host";
const DISPLAY = process.env.DISPLAY || ":1";
const FRAME_FPS = Number(process.env.FRAME_FPS) || 8;
const FRAME_QUALITY = Number(process.env.FRAME_QUALITY) || 5;
const FRAME_SCALE = process.env.FRAME_SCALE || "1280:-1";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 2e6,
});

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

/** @type {Set<string>} */
const authedClients = new Set();

/** @type {import('child_process').ChildProcess | null} */
let captureProc = null;
let displaySize = { width: 1280, height: 720 };
let lastFrame = null;
let frameSeq = 0;

app.get("/api/status", (_req, res) => {
  res.json({
    hostOnline: true,
    hostName: HOST_NAME,
    display: DISPLAY,
    size: displaySize,
  });
});

app.post("/api/auth", (req, res) => {
  const password = String(req.body?.password ?? "");
  if (password !== ACCESS_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Incorrect password" });
  }
  return res.json({
    ok: true,
    hostName: HOST_NAME,
    size: displaySize,
  });
});

app.get("*", (_req, res) => {
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
  if (captureProc) return;

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

  captureProc = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DISPLAY },
  });

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
      frameSeq += 1;

      if (authedClients.size > 0) {
        io.to("clients").emit("frame", frame);
      }
    }
  });

  captureProc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error("[ffmpeg]", text);
  });

  captureProc.on("exit", (code) => {
    console.error(`ffmpeg exited (${code}); restarting in 1s`);
    captureProc = null;
    setTimeout(() => {
      startCapture();
    }, 1000);
  });

  console.log(
    `Screen capture started on ${DISPLAY} (${displaySize.width}x${displaySize.height})`
  );
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

async function handleInput(event) {
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
      const action = event.type === "mousedown" ? "mousedown" : "mouseup";
      await runXdotool([action, button]);
      break;
    }
    case "wheel": {
      const steps = Math.min(8, Math.max(1, Math.round(Math.abs(event.deltaY) / 40)));
      const button = event.deltaY > 0 ? "5" : "4";
      for (let i = 0; i < steps; i += 1) {
        await runXdotool(["click", button]);
      }
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
    const punct = {
      "-": "minus",
      "=": "equal",
      "[": "bracketleft",
      "]": "bracketright",
      ";": "semicolon",
      "'": "apostrophe",
      ",": "comma",
      ".": "period",
      "/": "slash",
      "\\": "backslash",
      "`": "grave",
    };
    return punct[ch] || null;
  }

  return null;
}

io.on("connection", (socket) => {
  socket.on("client:auth", (payload, ack) => {
    const password = String(payload?.password ?? "");
    if (password !== ACCESS_PASSWORD) {
      if (typeof ack === "function") {
        ack({ ok: false, error: "Incorrect password" });
      }
      return;
    }

    authedClients.add(socket.id);
    socket.join("clients");

    if (typeof ack === "function") {
      ack({
        ok: true,
        hostName: HOST_NAME,
        size: displaySize,
      });
    }

    if (lastFrame) {
      socket.emit("frame", lastFrame);
    }
  });

  socket.on("input", (event) => {
    if (!authedClients.has(socket.id)) return;
    handleInput(event);
  });

  socket.on("disconnect", () => {
    authedClients.delete(socket.id);
  });
});

async function main() {
  await probeDisplaySize();
  startCapture();

  server.listen(PORT, () => {
    console.log(`Remote desktop running at http://localhost:${PORT}`);
    console.log(`Access password: ${ACCESS_PASSWORD}`);
    console.log(`Streaming host display ${DISPLAY}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
