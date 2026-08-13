const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 5050);
const USERS = JSON.parse(fs.readFileSync(path.join(__dirname, "users.json"), "utf8"));
const PUBLIC = path.join(__dirname, "public");
const DEFAULT_CONTINUE = "https://www.google.com";

const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".css": "text/css",
  ".js": "application/javascript",
};

function send(res, code, body, type = "text/html; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "public, max-age=86400",
    "Content-Length": data.length,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

function parseForm(raw) {
  const out = {};
  for (const part of raw.split("&")) {
    if (!part) continue;
    const [k, v = ""] = part.split("=");
    out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent(v.replace(/\+/g, " "));
  }
  return out;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function styles() {
  return `
  :root {
    --ink: #fff8ee;
    --muted: #f3e4cc;
    --gold: #e8c989;
    --danger: #ffb4a8;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }
  body {
    position: fixed;
    inset: 0;
    max-width: 100%;
    overscroll-behavior: none;
    touch-action: manipulation;
    font-family: "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif;
    color: var(--ink);
    background:
      radial-gradient(ellipse at 50% 18%, rgba(20,12,6,0.08) 0%, rgba(8,4,2,0.28) 72%, rgba(0,0,0,0.42) 100%),
      url("/bg.jpg") center center / cover no-repeat;
    display: flex;
    flex-direction: column;
  }
  .sheet {
    flex: 1 1 auto;
    width: 100%;
    max-width: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    text-align: center;
    padding:
      max(18px, env(safe-area-inset-top, 0px))
      max(18px, env(safe-area-inset-right, 0px))
      max(18px, env(safe-area-inset-bottom, 0px))
      max(18px, env(safe-area-inset-left, 0px));
    animation: rise 0.7s ease-out;
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: none; }
  }
  @keyframes shine {
    0%, 55% { transform: translateX(-130%); }
    80%, 100% { transform: translateX(130%); }
  }
  .hero, .actions, .fields {
    width: 100%;
    max-width: 100%;
  }
  .crest {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-bottom: 10px;
  }
  .crest .rule {
    width: 42px;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--gold), transparent);
  }
  .monogram {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-family: Georgia, serif;
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    color: var(--gold);
    border: 1px solid rgba(232, 201, 137, 0.72);
    box-shadow:
      0 0 0 4px rgba(20, 12, 6, 0.16),
      0 0 18px rgba(184, 137, 61, 0.28),
      inset 0 0 12px rgba(232, 201, 137, 0.14);
    background: rgba(12, 7, 4, 0.28);
  }
  .brand {
    letter-spacing: 0.42em;
    text-transform: uppercase;
    font-size: 0.68rem;
    color: var(--gold);
    font-family: system-ui, sans-serif;
    font-weight: 600;
    text-shadow: 0 1px 8px rgba(0,0,0,0.55);
  }
  h1 {
    margin: 8px 0 6px;
    font-size: 1.85rem;
    line-height: 1.12;
    font-weight: 700;
    letter-spacing: 0.01em;
    text-shadow: 0 2px 14px rgba(0,0,0,0.55);
  }
  .ornament {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin: 10px 0 4px;
    color: var(--gold);
    font-size: 0.55rem;
  }
  .ornament::before,
  .ornament::after {
    content: "";
    width: 54px;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(232,201,137,0.85), transparent);
  }
  .sub, .err {
    font-family: system-ui, sans-serif;
    font-size: 0.88rem;
    margin: 0;
    text-shadow: 0 1px 8px rgba(0,0,0,0.55);
  }
  .sub { color: var(--muted); }
  .err {
    color: var(--danger);
    margin: 10px 0 0;
    letter-spacing: 0.04em;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin: 16px auto 0;
    padding: 9px 16px;
    border-radius: 999px;
    border: 1px solid rgba(232, 201, 137, 0.55);
    background: rgba(12, 7, 4, 0.28);
    color: var(--gold);
    font-family: system-ui, sans-serif;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    box-shadow: 0 0 18px rgba(184, 137, 61, 0.18);
  }
  .fields {
    margin-top: 18px;
    display: grid;
    gap: 12px;
  }
  .field {
    position: relative;
    padding: 1px;
    border-radius: 16px;
    background: linear-gradient(180deg, rgba(245, 224, 180, 0.85), rgba(184, 137, 61, 0.38) 38%, rgba(255,248,238,0.16));
    box-shadow: 0 10px 24px rgba(0,0,0,0.18);
  }
  .field::after {
    content: "";
    position: absolute;
    inset: 1px;
    border-radius: 15px;
    pointer-events: none;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.18);
  }
  input {
    display: block;
    width: 100%;
    max-width: 100%;
    border: 0;
    border-radius: 15px;
    padding: 15px 16px;
    background: rgba(16, 9, 5, 0.42);
    color: var(--ink);
    font: inherit;
    font-size: 16px;
    line-height: 1.25;
    letter-spacing: 0.08em;
    text-align: center;
    text-shadow: none;
    -webkit-appearance: none;
    appearance: none;
  }
  input::placeholder {
    color: rgba(243, 228, 204, 0.78);
    opacity: 1;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    font-family: system-ui, sans-serif;
    font-size: 0.78rem;
    font-weight: 600;
  }
  input:focus {
    outline: none;
    background: rgba(16, 9, 5, 0.52);
  }
  .field:focus-within {
    background: linear-gradient(180deg, #f6e2b0, #c49a4a 45%, #f0d7a0);
    box-shadow: 0 0 0 3px rgba(232, 201, 137, 0.22), 0 12px 28px rgba(0,0,0,0.22);
  }
  .actions { text-align: center; }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0,0,0,0);
    white-space: nowrap;
    border: 0;
  }
  button, a.btn {
    position: relative;
    overflow: hidden;
    display: block;
    width: 100%;
    max-width: 100%;
    margin: 0;
    border: 0;
    border-radius: 16px;
    padding: 16px 18px;
    background: linear-gradient(180deg, #f4e0b4 0%, #d4b06a 42%, #9a6c2e 100%);
    color: #1a140c;
    font: 700 0.82rem system-ui, sans-serif;
    letter-spacing: 0.34em;
    text-transform: uppercase;
    text-decoration: none;
    text-align: center;
    cursor: pointer;
    text-shadow: 0 1px 0 rgba(255,255,255,0.35);
    box-shadow:
      0 12px 28px rgba(0,0,0,0.28),
      inset 0 1px 0 rgba(255,255,255,0.5),
      inset 0 -1px 0 rgba(80, 48, 12, 0.25);
    -webkit-appearance: none;
    appearance: none;
  }
  button::before, a.btn::before {
    content: "";
    position: absolute;
    inset: 1px;
    border-radius: 15px;
    border: 1px solid rgba(255,255,255,0.22);
    pointer-events: none;
  }
  button::after, a.btn::after {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    width: 42%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.38), transparent);
    animation: shine 3.4s ease-in-out infinite;
    pointer-events: none;
  }
  button:active, a.btn:active {
    transform: translateY(1px);
    filter: brightness(0.96);
  }
`;
}

function documentShell(inner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover"/>
<meta name="mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="format-detection" content="telephone=no"/>
<title>Filii Caprae — Guest Wi‑Fi</title>
<style>${styles()}</style>
<script>
(function () {
  document.addEventListener("gesturestart", function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener("gesturechange", function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener("gestureend", function (e) { e.preventDefault(); }, { passive: false });
  document.addEventListener("touchmove", function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });
})();
</script>
</head>
<body>
${inner}
</body>
</html>`;
}

function brandHeader(heading, sub, extra = "") {
  return `
    <header class="hero">
      <div class="crest">
        <span class="rule"></span>
        <span class="monogram">FC</span>
        <span class="rule"></span>
      </div>
      <div class="brand">Filii Caprae</div>
      <h1>${heading}</h1>
      <div class="ornament">◆</div>
      <p class="sub">${sub}</p>
      ${extra}
    </header>`;
}

function page(query, error = "") {
  const q = new URLSearchParams(query).toString();
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
  return documentShell(`
  <form class="sheet" method="POST" action="/login?${q}">
    ${brandHeader("Sign in to Wi‑Fi", "Sign in with the guest account provided at check-in.", `${err}
      <div class="fields">
        <label class="sr-only" for="username">Username</label>
        <div class="field">
          <input id="username" name="username" autocomplete="username" placeholder="USERNAME" required/>
        </div>
        <label class="sr-only" for="password">Password</label>
        <div class="field">
          <input id="password" name="password" type="password" autocomplete="current-password" placeholder="PASSWORD" required/>
        </div>
      </div>`)}
    <div class="actions">
      <button type="submit">Connect</button>
    </div>
  </form>`);
}

function successPage(user, continueUrl) {
  const safeUser = escapeHtml(user);
  const safeUrl = escapeHtml(continueUrl);
  return documentShell(`
  <div class="sheet">
    ${brandHeader(
      `Welcome, ${safeUser}`,
      "Complimentary guest Wi‑Fi is now active.",
      `<p class="badge">Connected</p>`
    )}
    <div class="actions">
      <a class="btn" href="${safeUrl}">Continue</a>
    </div>
  </div>`);
}

function continueUrlFrom(query) {
  const redir = query.get("redir") || query.get("userurl") || "";
  if (redir && redir !== "https://example.com") return redir;
  return DEFAULT_CONTINUE;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://portal.local");

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/bg.jpg") {
    const file = path.join(PUBLIC, "bg.jpg");
    if (!fs.existsSync(file)) return send(res, 404, "missing", "text/plain");
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
      return res.end();
    }
    return sendFile(res, file);
  }

  if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/" || url.pathname === "/login")) {
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end();
    }
    return send(res, 200, page(url.searchParams));
  }

  if (req.method === "POST" && url.pathname === "/login") {
    const form = parseForm(await readBody(req));
    const user = String(form.username || "").trim();
    const pass = String(form.password || "");
    if (!USERS[user] || USERS[user] !== pass) {
      return send(res, 401, page(url.searchParams, "Invalid username or password."));
    }

    const uamip = url.searchParams.get("uamip") || url.searchParams.get("gatewayaddress");
    const uamport = url.searchParams.get("uamport") || "3990";
    const tok = url.searchParams.get("tok") || url.searchParams.get("token");
    const linkLogin = url.searchParams.get("link-login") || url.searchParams.get("link_login");
    const continueUrl = continueUrlFrom(url.searchParams);

    if (linkLogin) {
      const dest = new URL(linkLogin);
      dest.searchParams.set("username", user);
      dest.searchParams.set("password", pass);
      res.writeHead(302, { Location: dest.toString() });
      return res.end();
    }
    if (uamip) {
      const dest = `http://${uamip}:${uamport}/logon?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
      res.writeHead(302, { Location: dest });
      return res.end();
    }
    if (tok) {
      return send(res, 200, successPage(user, continueUrl));
    }
    return send(res, 200, successPage(user, continueUrl));
  }

  if (url.pathname === "/health") return send(res, 200, "ok", "text/plain");
  return send(res, 404, "Not found", "text/plain");
});

server.listen(PORT, "0.0.0.0", () => console.log("portal on", PORT));
