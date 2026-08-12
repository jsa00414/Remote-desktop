(() => {
  const homeView = document.getElementById("home-view");
  const pinView = document.getElementById("pin-view");
  const sessionView = document.getElementById("session-view");
  const hostList = document.getElementById("host-list");
  const homeEmpty = document.getElementById("home-empty");
  const homeError = document.getElementById("home-error");
  const pinForm = document.getElementById("pin-form");
  const pinInput = document.getElementById("pin-input");
  const pinHostName = document.getElementById("pin-host-name");
  const pinError = document.getElementById("pin-error");
  const pinBackBtn = document.getElementById("pin-back-btn");
  const pinConnectBtn = document.getElementById("pin-connect-btn");
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
  const osk = document.getElementById("osk");

  let selectedHost = null;
  let socket = null;
  let connected = false;
  let lastMoveSent = 0;
  let connectWatchdog = null;
  let shiftOn = false;
  const pressed = new Set();
  const image = new Image();
  image.decoding = "async";

  refreshHosts();
  setInterval(refreshHosts, 3000);

  // Live presence updates help iPhone see Online quickly.
  const presence = io({ transports: ["websocket", "polling"] });
  presence.on("hosts:updated", () => refreshHosts());
  presence.on("connect_error", () => {
    if (homeError) {
      homeError.hidden = false;
      homeError.textContent =
        "Cannot reach server. On iPhone open https://74.208.54.132:5000 and tap Allow/Continue for the certificate.";
    }
  });

  pinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selectedHost) return;
    pinError.hidden = true;
    pinConnectBtn.disabled = true;
    pinConnectBtn.textContent = "Connecting…";
    try {
      await startSession(selectedHost.id, pinInput.value.trim());
    } catch (err) {
      pinError.hidden = false;
      pinError.textContent = err.message || "Could not connect";
      pinConnectBtn.disabled = false;
      pinConnectBtn.textContent = "Connect";
    }
  });

  pinBackBtn.addEventListener("click", () => showHome());
  disconnectBtn.addEventListener("click", () => {
    teardown();
    showHome();
  });
  fullscreenBtn.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) await stage.requestFullscreen?.();
      else await document.exitFullscreen?.();
    } catch {
      /* iPhone often has no fullscreen API */
    }
  });

  bindPointer(stage);
  buildOsk();
  keyboardBtn?.addEventListener("click", () => {
    if (!osk) return;
    osk.hidden = !osk.hidden;
    if (!osk.hidden) stage.focus();
  });

  window.addEventListener("keydown", (e) => {
    if (!connected || !socket || sessionView.hidden) return;
    if (e.target && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
    e.preventDefault();
    if (pressed.has(e.code)) return;
    pressed.add(e.code);
    sendKey("keydown", e.key, e.code);
  });
  window.addEventListener("keyup", (e) => {
    if (!connected || !socket || sessionView.hidden) return;
    if (e.target && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
    e.preventDefault();
    pressed.delete(e.code);
    sendKey("keyup", e.key, e.code);
  });
  window.addEventListener("blur", () => {
    pressed.clear();
  });

  image.onload = () => {
    if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
    }
    ctx.drawImage(image, 0, 0);
    connected = true;
    clearTimeout(connectWatchdog);
    hideStageOverlay();
  };
  image.onerror = () => {
    setStageMessage("Received a bad frame. Waiting for next…");
  };

  async function refreshHosts() {
    if (homeView.hidden) return;
    try {
      const res = await fetch("/api/hosts", { cache: "no-store" });
      if (!res.ok) throw new Error("bad status");
      const data = await res.json();
      if (homeError) homeError.hidden = true;
      renderHosts(data.hosts || []);
    } catch {
      if (homeError) {
        homeError.hidden = false;
        homeError.textContent =
          "Could not load computers. On iPhone use https://74.208.54.132:5000 and accept the security warning first.";
      }
    }
  }

  function renderHosts(hosts) {
    hostList.innerHTML = "";
    homeEmpty.hidden = hosts.length > 0;
    for (const host of hosts) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "device-row";
      btn.innerHTML = `
        <span class="device-icon" aria-hidden="true"></span>
        <span class="device-meta">
          <strong>${escapeHtml(host.name)}</strong>
          <span class="device-status ${host.online ? "online" : "offline"}">
            ${host.online ? "Online" : "Offline"}
          </span>
        </span>
        <span class="device-cta">${host.online ? "Connect" : "Offline"}</span>
      `;
      btn.disabled = !host.online;
      btn.addEventListener("click", () => openPin(host));
      hostList.appendChild(btn);
    }
  }

  function openPin(host) {
    selectedHost = host;
    pinHostName.textContent = host.name;
    pinInput.value = "";
    pinError.hidden = true;
    pinConnectBtn.disabled = false;
    pinConnectBtn.textContent = "Connect";
    homeView.hidden = true;
    sessionView.hidden = true;
    pinView.hidden = false;
    pinInput.focus();
  }

  async function startSession(hostId, pin) {
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
      socket.emit("client:auth", { hostId, pin }, resolve);
    });
    if (!auth?.ok) {
      socket.disconnect();
      socket = null;
      throw new Error(auth?.error || "Authentication failed");
    }

    sessionHostName.textContent = auth.host?.name || "Connected host";
    showSession();
    setStageMessage("Connected — waiting for screen frames from the host…");
    canvas.hidden = false;
    video.hidden = true;
    // Focus stage so physical keyboard is captured immediately.
    setTimeout(() => stage.focus(), 50);

    connectWatchdog = setTimeout(() => {
      if (!connected) {
        setStageMessage(
          "Still waiting. On the computer keep https://…/host sharing, then reconnect from iPhone."
        );
      }
    }, 10000);

    socket.on("host:disconnected", () => {
      teardown();
      showHome();
    });

    socket.on("frame", (payload) => {
      applyFrame(payload);
    });

    // Ask host to know a viewer is waiting (already notified via client:joined).
    setStageMessage("Connected — waiting for screen frames from the host…");
  }

  function applyFrame(payload) {
    if (typeof payload === "string" && payload.length > 32) {
      // Assigning a new data URL each time; force decode for other PCs/Safari.
      const next = payload.startsWith("data:")
        ? payload
        : `data:image/jpeg;base64,${payload}`;
      if (image.src === next) {
        // identical frame — still count as connected
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
    // Fallback binary path
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

  function bindPointer(el) {
    const forward = (type, e, touch) => {
      if (!connected || !socket) return;
      const point = touch || e;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = (point.clientX - rect.left) / rect.width;
      const y = (point.clientY - rect.top) / rect.height;
      if (x < 0 || y < 0 || x > 1 || y > 1) return;
      if (type === "mousemove") {
        const now = performance.now();
        if (now - lastMoveSent < 50) return;
        lastMoveSent = now;
      }
      socket.emit("input", {
        type,
        x,
        y,
        button: typeof e.button === "number" ? e.button : 0,
      });
    };

    el.addEventListener("mousemove", (e) => forward("mousemove", e));
    el.addEventListener("mousedown", (e) => forward("mousedown", e));
    el.addEventListener("mouseup", (e) => forward("mouseup", e));
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
        if (!e.touches[0]) return;
        e.preventDefault();
        forward("mousedown", e, e.touches[0]);
      },
      { passive: false }
    );
    el.addEventListener(
      "touchmove",
      (e) => {
        if (!e.touches[0]) return;
        e.preventDefault();
        forward("mousemove", e, e.touches[0]);
      },
      { passive: false }
    );
    el.addEventListener(
      "touchend",
      (e) => {
        e.preventDefault();
        const t = e.changedTouches[0];
        if (t) forward("mouseup", e, t);
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

  function showHome() {
    selectedHost = null;
    pinView.hidden = true;
    sessionView.hidden = true;
    homeView.hidden = false;
    if (osk) osk.hidden = true;
    refreshHosts();
  }

  function showSession() {
    homeView.hidden = true;
    pinView.hidden = true;
    sessionView.hidden = false;
  }

  function setStageMessage(message) {
    stageOverlay.hidden = false;
    stageMessage.textContent = message;
  }

  function hideStageOverlay() {
    stageOverlay.hidden = true;
  }

  function teardown(resetPresence = true) {
    connected = false;
    clearTimeout(connectWatchdog);
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    void resetPresence;
  }

  function toBytes(payload) {
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (payload?.type === "Buffer") return new Uint8Array(payload.data);
    if (payload instanceof Uint8Array) return payload;
    return null;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }
})();
