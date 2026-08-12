(() => {
  const authView = document.getElementById("auth-view");
  const sessionView = document.getElementById("session-view");
  const authForm = document.getElementById("auth-form");
  const passwordInput = document.getElementById("password-input");
  const authError = document.getElementById("auth-error");
  const connectBtn = document.getElementById("connect-btn");
  const hostStatusLabel = document.getElementById("host-status-label");
  const sessionHostName = document.getElementById("session-host-name");
  const canvas = document.getElementById("remote-canvas");
  const ctx = canvas.getContext("2d");
  const stage = document.getElementById("stage");
  const stageOverlay = document.getElementById("stage-overlay");
  const stageMessage = document.getElementById("stage-message");
  const disconnectBtn = document.getElementById("disconnect-btn");
  const fullscreenBtn = document.getElementById("fullscreen-btn");

  let socket = null;
  let connected = false;
  let frameUrl = null;
  let lastMoveSent = 0;
  const image = new Image();

  refreshHostStatus();
  setInterval(refreshHostStatus, 5000);

  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    authError.hidden = true;
    connectBtn.disabled = true;
    connectBtn.textContent = "Connecting…";

    try {
      await startSession(passwordInput.value.trim());
    } catch (err) {
      showAuthError(err.message || "Could not connect");
      connectBtn.disabled = false;
      connectBtn.textContent = "Connect";
    }
  });

  disconnectBtn.addEventListener("click", () => {
    teardown();
    showAuth();
  });

  fullscreenBtn.addEventListener("click", async () => {
    if (!document.fullscreenElement) {
      await stage.requestFullscreen?.();
    } else {
      await document.exitFullscreen?.();
    }
  });

  canvas.addEventListener("mousemove", (e) => sendPointer("mousemove", e));
  canvas.addEventListener("mousedown", (e) => {
    canvas.focus();
    sendPointer("mousedown", e);
  });
  canvas.addEventListener("mouseup", (e) => sendPointer("mouseup", e));
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!connected || !socket) return;
      e.preventDefault();
      socket.emit("input", {
        type: "wheel",
        deltaX: e.deltaX,
        deltaY: e.deltaY,
      });
    },
    { passive: false }
  );
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.tabIndex = 0;

  window.addEventListener("keydown", (e) => {
    if (!connected || !socket) return;
    if (authView.hidden === false) return;
    e.preventDefault();
    socket.emit("input", {
      type: "keydown",
      key: e.key,
      code: e.code,
    });
  });

  image.onload = () => {
    if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
    }
    ctx.drawImage(image, 0, 0);
    if (frameUrl) URL.revokeObjectURL(frameUrl);
    frameUrl = null;
    connected = true;
    hideStageOverlay();
  };

  async function refreshHostStatus() {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      const online = !!data.hostOnline;
      hostStatusLabel.textContent = online ? "Online" : "Offline";
      hostStatusLabel.classList.toggle("online", online);
      hostStatusLabel.classList.toggle("offline", !online);
    } catch {
      hostStatusLabel.textContent = "Unknown";
      hostStatusLabel.classList.add("offline");
      hostStatusLabel.classList.remove("online");
    }
  }

  async function startSession(password) {
    teardown();

    socket = io({ transports: ["websocket", "polling"] });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server timed out")), 8000);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("connect_error", () => {
        clearTimeout(timer);
        reject(new Error("Could not reach server"));
      });
    });

    const authResult = await new Promise((resolve) => {
      socket.emit("client:auth", { password }, resolve);
    });

    if (!authResult?.ok) {
      socket.disconnect();
      socket = null;
      throw new Error(authResult?.error || "Authentication failed");
    }

    sessionHostName.textContent = authResult.hostName || "Connected host";
    showSession();
    setStageMessage("Receiving host screen…");

    socket.on("frame", (payload) => {
      const bytes =
        payload instanceof ArrayBuffer
          ? new Uint8Array(payload)
          : payload?.type === "Buffer"
            ? new Uint8Array(payload.data)
            : payload instanceof Uint8Array
              ? payload
              : null;

      if (!bytes) return;

      if (frameUrl) URL.revokeObjectURL(frameUrl);
      const blob = new Blob([bytes], { type: "image/jpeg" });
      frameUrl = URL.createObjectURL(blob);
      image.src = frameUrl;
    });

    socket.on("disconnect", () => {
      connected = false;
      setStageMessage("Disconnected from host");
    });
  }

  function sendPointer(type, e) {
    if (!connected || !socket) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || y < 0 || x > 1 || y > 1) return;

    socket.emit("input", {
      type,
      x,
      y,
      button: e.button,
    });
  }

  function showSession() {
    authView.hidden = true;
    sessionView.hidden = false;
  }

  function showAuth() {
    sessionView.hidden = true;
    authView.hidden = false;
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect";
    refreshHostStatus();
  }

  function showAuthError(message) {
    authError.hidden = false;
    authError.textContent = message;
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
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    if (frameUrl) {
      URL.revokeObjectURL(frameUrl);
      frameUrl = null;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
})();
