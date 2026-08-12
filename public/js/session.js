(() => {
  const SESSION_KEY = "rd-session";

  const sessionHostName = document.getElementById("session-host-name");
  const canvas = document.getElementById("remote-canvas");
  const ctx = canvas.getContext("2d");
  const video = document.getElementById("remote-video");
  const stage = document.getElementById("stage");
  const stageOverlay = document.getElementById("stage-overlay");
  const stageMessage = document.getElementById("stage-message");
  const disconnectBtn = document.getElementById("disconnect-btn");
  const fullscreenBtn = document.getElementById("fullscreen-btn");
  const keyboardBtn = document.getElementById("keyboard-btn");
  const inputModeBtn = document.getElementById("input-mode-btn");
  const touchIcon = document.getElementById("input-mode-icon-touch");
  const trackpadIcon = document.getElementById("input-mode-icon-trackpad");
  const menuBtn = document.getElementById("menu-btn");
  const sessionMenu = document.getElementById("session-menu");
  const menuHomeBtn = document.getElementById("menu-home-btn");
  const menuFullscreenBtn = document.getElementById("menu-fullscreen-btn");
  const menuDisconnectBtn = document.getElementById("menu-disconnect-btn");
  const osk = document.getElementById("osk");
  const sendTextForm = document.getElementById("send-text-form");
  const sendTextInput = document.getElementById("send-text-input");
  const sendTextKeyboardBtn = document.getElementById("send-text-keyboard-btn");

  let socket = null;
  let connected = false;
  let lastMoveSent = 0;
  let connectWatchdog = null;
  let shiftOn = false;
  let inputMode = "touch"; // touch | trackpad
  let trackpadX = 0.5;
  let trackpadY = 0.5;
  let trackpadTouch = null;
  const pressed = new Set();
  const image = new Image();
  image.decoding = "async";

  const params = new URLSearchParams(window.location.search);
  const stored = readSession();
  const hostId = params.get("hostId") || stored?.hostId || "";
  const pin = stored?.pin || "";
  const hostName = stored?.hostName || "Remote computer";

  if (!hostId || !pin) {
    window.location.replace("/");
    return;
  }

  sessionHostName.textContent = hostName;
  startSession(hostId, pin).catch((err) => {
    setStageMessage(err.message || "Could not connect");
    setTimeout(() => {
      clearSession();
      window.location.replace("/");
    }, 1800);
  });

  disconnectBtn.addEventListener("click", leaveSession);
  menuDisconnectBtn?.addEventListener("click", leaveSession);
  menuHomeBtn?.addEventListener("click", leaveSession);
  fullscreenBtn.addEventListener("click", toggleFullscreen);
  menuFullscreenBtn?.addEventListener("click", () => {
    closeMenu();
    toggleFullscreen();
  });

  menuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = sessionMenu.hidden;
    sessionMenu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  document.addEventListener("click", (e) => {
    if (!sessionMenu || sessionMenu.hidden) return;
    if (sessionMenu.contains(e.target) || menuBtn.contains(e.target)) return;
    closeMenu();
  });

  bindPointer(stage);
  buildOsk();
  keyboardBtn?.addEventListener("click", toggleOsk);
  sendTextKeyboardBtn?.addEventListener("click", toggleOsk);
  inputModeBtn?.addEventListener("click", toggleInputMode);
  updateInputModeUi();

  sendTextForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = sendTextInput.value;
    if (!text || !connected || !socket) return;
    for (const ch of text) {
      sendKey("keydown", ch, ch);
      sendKey("keyup", ch, ch);
    }
    sendTextInput.value = "";
    stage.focus();
  });

  window.addEventListener("keydown", (e) => {
    if (!connected || !socket) return;
    if (e.target && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
    e.preventDefault();
    if (pressed.has(e.code)) return;
    pressed.add(e.code);
    sendKey("keydown", e.key, e.code);
  });
  window.addEventListener("keyup", (e) => {
    if (!connected || !socket) return;
    if (e.target && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
    e.preventDefault();
    pressed.delete(e.code);
    sendKey("keyup", e.key, e.code);
  });
  window.addEventListener("blur", () => {
    pressed.clear();
  });

  function defaultImageOnload() {
    if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
    }
    ctx.drawImage(image, 0, 0);
    connected = true;
    clearTimeout(connectWatchdog);
    hideStageOverlay();
  }
  image.onload = defaultImageOnload;
  image.onerror = () => {
    setStageMessage("Received a bad frame. Waiting for next…");
  };

  async function startSession(id, accessPin) {
    teardown(false);
    socket = io({
      transports: ["websocket", "polling"],
      upgrade: true,
      rememberUpgrade: true,
      timeout: 12000,
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server timed out")), 12000);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("connect_error", () => {
        clearTimeout(timer);
        reject(
          new Error(
            "Could not reach server. On iPhone open https://74.208.54.132:5000 and continue past the certificate warning."
          )
        );
      });
    });

    const auth = await new Promise((resolve) => {
      socket.emit("client:auth", { hostId: id, pin: accessPin }, resolve);
    });
    if (!auth?.ok) {
      socket.disconnect();
      socket = null;
      throw new Error(auth?.error || "Authentication failed");
    }

    sessionHostName.textContent = auth.host?.name || hostName;
    setStageMessage("Connected — waiting for screen frames from the host…");
    canvas.hidden = false;
    if (video) video.hidden = true;
    setTimeout(() => stage.focus(), 50);

    connectWatchdog = setTimeout(() => {
      if (!connected) {
        setStageMessage(
          "Still waiting. On the computer keep https://…/host sharing, then reconnect."
        );
      }
    }, 10000);

    socket.on("host:disconnected", () => {
      setStageMessage("Host disconnected");
      setTimeout(leaveSession, 1200);
    });

    socket.on("frame", (payload) => {
      applyFrame(payload);
    });
  }

  function applyFrame(payload) {
    if (typeof payload === "string" && payload.length > 32) {
      const next = payload.startsWith("data:")
        ? payload
        : `data:image/jpeg;base64,${payload}`;
      if (image.src === next) {
        connected = true;
        clearTimeout(connectWatchdog);
        hideStageOverlay();
        return;
      }
      image.src = next;
      return;
    }

    const bytes = toBytes(payload);
    if (!bytes) return;
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);
    image.onload = () => {
      if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
      }
      ctx.drawImage(image, 0, 0);
      URL.revokeObjectURL(url);
      connected = true;
      clearTimeout(connectWatchdog);
      hideStageOverlay();
      image.onload = defaultImageOnload;
    };
    image.src = url;
  }

  function bindPointer(el) {
    const mapPoint = (point) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const x = (point.clientX - rect.left) / rect.width;
      const y = (point.clientY - rect.top) / rect.height;
      if (x < 0 || y < 0 || x > 1 || y > 1) return null;
      return { x, y };
    };

    const emitMove = (x, y, button = 0) => {
      const now = performance.now();
      if (now - lastMoveSent < 40) return;
      lastMoveSent = now;
      socket.emit("input", { type: "mousemove", x, y, button });
    };

    el.addEventListener("mousemove", (e) => {
      if (!connected || !socket || inputMode !== "touch") return;
      const p = mapPoint(e);
      if (!p) return;
      emitMove(p.x, p.y, e.button);
    });
    el.addEventListener("mousedown", (e) => {
      if (!connected || !socket) return;
      const p = mapPoint(e);
      if (!p) return;
      if (inputMode === "trackpad") {
        trackpadX = Math.min(1, Math.max(0, trackpadX));
        trackpadY = Math.min(1, Math.max(0, trackpadY));
        socket.emit("input", {
          type: "mousedown",
          x: trackpadX,
          y: trackpadY,
          button: e.button,
        });
        return;
      }
      socket.emit("input", { type: "mousedown", x: p.x, y: p.y, button: e.button });
    });
    el.addEventListener("mouseup", (e) => {
      if (!connected || !socket) return;
      const p = mapPoint(e);
      if (inputMode === "trackpad") {
        socket.emit("input", {
          type: "mouseup",
          x: trackpadX,
          y: trackpadY,
          button: e.button,
        });
        return;
      }
      if (!p) return;
      socket.emit("input", { type: "mouseup", x: p.x, y: p.y, button: e.button });
    });
    el.addEventListener(
      "wheel",
      (e) => {
        if (!connected || !socket) return;
        e.preventDefault();
        socket.emit("input", { type: "wheel", deltaX: e.deltaX, deltaY: e.deltaY });
      },
      { passive: false }
    );
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    el.addEventListener(
      "touchstart",
      (e) => {
        if (!e.touches[0] || !connected || !socket) return;
        e.preventDefault();
        const t = e.touches[0];
        if (inputMode === "trackpad") {
          trackpadTouch = { id: t.identifier, x: t.clientX, y: t.clientY, moved: false };
          return;
        }
        const p = mapPoint(t);
        if (!p) return;
        socket.emit("input", { type: "mousedown", x: p.x, y: p.y, button: 0 });
      },
      { passive: false }
    );
    el.addEventListener(
      "touchmove",
      (e) => {
        if (!e.touches[0] || !connected || !socket) return;
        e.preventDefault();
        const t = e.touches[0];
        if (inputMode === "trackpad") {
          if (!trackpadTouch || trackpadTouch.id !== t.identifier) return;
          const dx = (t.clientX - trackpadTouch.x) / (stage.clientWidth || 1);
          const dy = (t.clientY - trackpadTouch.y) / (stage.clientHeight || 1);
          if (Math.abs(dx) > 0.002 || Math.abs(dy) > 0.002) trackpadTouch.moved = true;
          trackpadX = Math.min(1, Math.max(0, trackpadX + dx * 1.4));
          trackpadY = Math.min(1, Math.max(0, trackpadY + dy * 1.4));
          trackpadTouch.x = t.clientX;
          trackpadTouch.y = t.clientY;
          emitMove(trackpadX, trackpadY);
          return;
        }
        const p = mapPoint(t);
        if (!p) return;
        emitMove(p.x, p.y);
      },
      { passive: false }
    );
    el.addEventListener(
      "touchend",
      (e) => {
        e.preventDefault();
        if (!connected || !socket) return;
        const t = e.changedTouches[0];
        if (inputMode === "trackpad") {
          if (trackpadTouch && t && trackpadTouch.id === t.identifier) {
            if (!trackpadTouch.moved) {
              socket.emit("input", {
                type: "mousedown",
                x: trackpadX,
                y: trackpadY,
                button: 0,
              });
              socket.emit("input", {
                type: "mouseup",
                x: trackpadX,
                y: trackpadY,
                button: 0,
              });
            }
          }
          trackpadTouch = null;
          return;
        }
        if (!t) return;
        const p = mapPoint(t);
        if (!p) return;
        socket.emit("input", { type: "mouseup", x: p.x, y: p.y, button: 0 });
      },
      { passive: false }
    );
  }

  function sendKey(type, key, code) {
    if (!connected || !socket) return;
    socket.emit("input", { type, key, code });
  }

  function buildOsk() {
    if (!osk) return;
    osk.querySelectorAll(".osk-row").forEach((row) => {
      let keys = [];
      try {
        keys = JSON.parse(row.getAttribute("data-keys") || "[]");
      } catch {
        keys = [];
      }
      row.innerHTML = "";
      keys.forEach((label) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "osk-key";
        if (["Space", "Enter", "Backspace", "Shift", "Tab", "Esc"].includes(label)) {
          btn.classList.add("wide");
        }
        btn.textContent = label === "Space" ? "␣" : label;
        btn.addEventListener("click", () => {
          if (label === "Shift") {
            shiftOn = !shiftOn;
            btn.classList.toggle("active", shiftOn);
            return;
          }
          let key = label;
          if (label === "Space") key = " ";
          if (label === "Esc") key = "Escape";
          if (label.length === 1) key = shiftOn ? label.toUpperCase() : label.toLowerCase();
          sendKey("keydown", key, key);
          sendKey("keyup", key, key);
          stage.focus();
        });
        row.appendChild(btn);
      });
    });
  }

  function toggleOsk() {
    if (!osk) return;
    osk.hidden = !osk.hidden;
    keyboardBtn?.setAttribute("aria-pressed", osk.hidden ? "false" : "true");
    keyboardBtn?.classList.toggle("active", !osk.hidden);
    if (!osk.hidden) stage.focus();
  }

  function toggleInputMode() {
    inputMode = inputMode === "touch" ? "trackpad" : "touch";
    updateInputModeUi();
  }

  function updateInputModeUi() {
    const isTrackpad = inputMode === "trackpad";
    inputModeBtn?.setAttribute("aria-pressed", isTrackpad ? "true" : "false");
    inputModeBtn?.classList.toggle("active", isTrackpad);
    inputModeBtn?.setAttribute("title", isTrackpad ? "Trackpad mode" : "Touch mode");
    if (touchIcon) touchIcon.classList.toggle("is-hidden", isTrackpad);
    if (trackpadIcon) trackpadIcon.classList.toggle("is-hidden", !isTrackpad);
  }

  async function toggleFullscreen() {
    try {
      const root = document.getElementById("session-view") || stage;
      if (!document.fullscreenElement) await root.requestFullscreen?.();
      else await document.exitFullscreen?.();
    } catch {
      /* iPhone often has no fullscreen API */
    }
    closeMenu();
  }

  function closeMenu() {
    if (!sessionMenu) return;
    sessionMenu.hidden = true;
    menuBtn?.setAttribute("aria-expanded", "false");
  }

  function setStageMessage(message) {
    stageOverlay.hidden = false;
    stageMessage.textContent = message;
  }

  function hideStageOverlay() {
    stageOverlay.hidden = true;
  }

  function teardown() {
    connected = false;
    clearTimeout(connectWatchdog);
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  }

  function leaveSession() {
    teardown();
    clearSession();
    window.location.href = "/";
  }

  function readSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function clearSession() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }

  function toBytes(payload) {
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (payload?.type === "Buffer") return new Uint8Array(payload.data);
    if (payload instanceof Uint8Array) return payload;
    return null;
  }
})();
