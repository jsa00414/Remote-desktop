#!/usr/bin/env node
/**
 * Local input agent — run on the HOST computer (the one sharing its screen).
 * Allows remote keyboard/mouse from viewers.
 *
 *   node local-input-agent.js
 *
 * Listens on http://127.0.0.1:19780
 */
const http = require("http");
const { spawn } = require("child_process");
const os = require("os");

const PORT = Number(process.env.INPUT_AGENT_PORT) || 19780;
const HOST = "127.0.0.1";
const platform = os.platform();

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

function runShell(command) {
  if (platform === "win32") {
    return run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ]);
  }
  return run("bash", ["-lc", command]);
}

function escapePS(str) {
  return String(str).replace(/'/g, "''");
}

function mapSendKeys(event) {
  const special = {
    Enter: "{ENTER}",
    Escape: "{ESC}",
    Backspace: "{BACKSPACE}",
    Tab: "{TAB}",
    " ": " ",
    ArrowUp: "{UP}",
    ArrowDown: "{DOWN}",
    ArrowLeft: "{LEFT}",
    ArrowRight: "{RIGHT}",
    Delete: "{DELETE}",
    Home: "{HOME}",
    End: "{END}",
    PageUp: "{PGUP}",
    PageDown: "{PGDN}",
  };
  if (special[event.key]) return special[event.key];
  if (event.key && event.key.length === 1) {
    const ch = event.key;
    if (ch === "+") return "{+}";
    if (ch === "^") return "{^}";
    if (ch === "%") return "{%}";
    if (ch === "~") return "{~}";
    if (ch === "(") return "{(}";
    if (ch === ")") return "{)}";
    if (ch === "{") return "{{}";
    if (ch === "}") return "{}}";
    return ch;
  }
  return null;
}

function mapXdoKey(event) {
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

async function handleInput(event) {
  if (!event || typeof event !== "object") return;

  if (platform === "win32") {
    if (event.type === "keydown") {
      const seq = mapSendKeys(event);
      if (!seq) return;
      await runShell(
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escapePS(seq)}')`
      );
      return;
    }
    if (event.type === "mousemove" || event.type === "mousedown" || event.type === "mouseup") {
      // Absolute move needs screen size; use relative click at normalized coords.
      const screenW = Number(event.screenWidth) || 1920;
      const screenH = Number(event.screenHeight) || 1080;
      const x = Math.round(Math.min(1, Math.max(0, Number(event.x) || 0)) * (screenW - 1));
      const y = Math.round(Math.min(1, Math.max(0, Number(event.y) || 0)) * (screenH - 1));
      const down = event.type === "mousedown";
      const up = event.type === "mouseup";
      const move = event.type === "mousemove";
      await runShell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RDMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra);
}
"@
[RDMouse]::SetCursorPos(${x}, ${y})
${move ? "" : down ? "[RDMouse]::mouse_event(0x0002, 0, 0, 0, 0)" : ""}
${up ? "[RDMouse]::mouse_event(0x0004, 0, 0, 0, 0)" : ""}
`);
      return;
    }
    if (event.type === "wheel") {
      const amount = Math.sign(event.deltaY || 0) * -120;
      await runShell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RDWheel {
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra);
}
"@
[RDWheel]::mouse_event(0x0800, 0, 0, ${amount}, 0)
`);
    }
    return;
  }

  // Linux / macOS via xdotool or cliclick/osascript
  if (platform === "darwin") {
    if (event.type === "keydown") {
      const key = event.key;
      if (!key) return;
      if (key.length === 1) {
        await runShell(`osascript -e 'tell application "System Events" to keystroke "${key.replace(/"/g, '\\"')}"'`);
      } else {
        const map = {
          Enter: "return",
          Escape: "escape",
          Backspace: "delete",
          Tab: "tab",
          ArrowUp: "up arrow",
          ArrowDown: "down arrow",
          ArrowLeft: "left arrow",
          ArrowRight: "right arrow",
        };
        const k = map[key];
        if (k) {
          await runShell(`osascript -e 'tell application "System Events" to key code ${keyCodeMac(key)}'`);
        }
      }
    }
    return;
  }

  // Linux xdotool
  const screenW = Number(event.screenWidth) || 1920;
  const screenH = Number(event.screenHeight) || 1080;
  if (event.type === "mousemove" || event.type === "mousedown" || event.type === "mouseup") {
    const x = Math.round(Math.min(1, Math.max(0, Number(event.x) || 0)) * (screenW - 1));
    const y = Math.round(Math.min(1, Math.max(0, Number(event.y) || 0)) * (screenH - 1));
    await run("xdotool", ["mousemove", "--sync", String(x), String(y)]);
    if (event.type === "mousedown" || event.type === "mouseup") {
      const button = event.button === 2 ? "3" : event.button === 1 ? "2" : "1";
      await run("xdotool", [event.type, button]);
    }
    return;
  }
  if (event.type === "wheel") {
    const button = event.deltaY > 0 ? "5" : "4";
    await run("xdotool", ["click", button]);
    return;
  }
  if (event.type === "keydown") {
    const key = mapXdoKey(event);
    if (key) await run("xdotool", ["key", key]);
  }
}

function keyCodeMac(key) {
  const map = {
    Enter: 36,
    Escape: 53,
    Backspace: 51,
    Tab: 48,
    ArrowUp: 126,
    ArrowDown: 125,
    ArrowLeft: 123,
    ArrowRight: 124,
  };
  return map[key] || 0;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, platform }));
    return;
  }

  if (req.method === "POST" && req.url === "/input") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const event = JSON.parse(body || "{}");
        await handleInput(event);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`Remote Desktop input agent on http://${HOST}:${PORT}`);
  console.log(`Platform: ${platform}`);
  console.log("Keep this running while sharing your screen in the browser.");
});
