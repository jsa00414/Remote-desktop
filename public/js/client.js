(() => {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

  const homeView = document.getElementById("home-view");
  const pinView = document.getElementById("pin-view");
  const sessionView = document.getElementById("session-view");
  const hostList = document.getElementById("host-list");
  const homeEmpty = document.getElementById("home-empty");
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

  let selectedHost = null;
  let socket = null;
  let pc = null;
  let connected = false;
  let mode = null;
  let frameUrl = null;
  let lastMoveSent = 0;
  const image = new Image();

  refreshHosts();
  setInterval(refreshHosts, 4000);

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
    if (!document.fullscreenElement) await stage.requestFullscreen?.();
    else await document.exitFullscreen?.();
  });

  const pointerTarget = () => (mode === "webrtc" ? video : canvas);
  stage.addEventListener("mousemove", (e) => sendPointer("mousemove", e));
  stage.addEventListener("mousedown", (e) => sendPointer("mousedown", e));
  stage.addEventListener("mouseup", (e) => sendPointer("mouseup", e));
  stage.addEventListener(
    "wheel",
    (e) => {
      if (!connected || !socket) return;
      e.preventDefault();
      socket.emit("input", { type: "wheel", deltaX: e.deltaX, deltaY: e.deltaY });
    },
    { passive: false }
  );
  stage.addEventListener("contextmenu", (e) => e.preventDefault());

  window.addEventListener("keydown", (e) => {
    if (!connected || !socket || !sessionView || sessionView.hidden) return;
    e.preventDefault();
    socket.emit("input", { type: "keydown", key: e.key, code: e.code });
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

  async function refreshHosts() {
    if (!homeView || homeView.hidden === false) {
      try {
        const res = await fetch("/api/hosts");
        const data = await res.json();
        renderHosts(data.hosts || []);
      } catch {
        /* ignore */
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

    const auth = await new Promise((resolve) => {
      socket.emit("client:auth", { hostId, pin }, resolve);
    });
    if (!auth?.ok) {
      socket.disconnect();
      socket = null;
      throw new Error(auth?.error || "Authentication failed");
    }

    mode = auth.mode;
    sessionHostName.textContent = auth.host?.name || "Connected host";
    showSession();
    setStageMessage("Receiving host screen…");

    canvas.hidden = mode !== "local";
    video.hidden = mode !== "webrtc";

    socket.on("host:disconnected", () => {
      teardown();
      showHome();
    });

    if (mode === "local") {
      socket.on("frame", (payload) => {
        const bytes = toBytes(payload);
        if (!bytes) return;
        if (frameUrl) URL.revokeObjectURL(frameUrl);
        frameUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
        image.src = frameUrl;
      });
      return;
    }

    pc = new RTCPeerConnection({ iceServers });
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("signal", { to: auth.agentSocketId, data: event.candidate.toJSON() });
      }
    };
    pc.ontrack = (event) => {
      video.srcObject = event.streams[0];
      connected = true;
      hideStageOverlay();
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        setStageMessage("Connection lost");
        connected = false;
      }
    };

    socket.on("signal", async ({ from, data }) => {
      if (!pc) return;
      try {
        if (data.type === "offer") {
          await pc.setRemoteDescription(data);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("signal", { to: from, data: pc.localDescription });
        } else if (data.candidate) {
          await pc.addIceCandidate(data);
        }
      } catch (err) {
        console.error(err);
      }
    });

    socket.emit("signal", {
      to: auth.agentSocketId,
      data: { type: "request-offer" },
    });
  }

  function sendPointer(type, e) {
    if (!connected || !socket) return;
    const el = pointerTarget();
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || y < 0 || x > 1 || y > 1) return;
    if (type === "mousemove") {
      const now = performance.now();
      if (now - lastMoveSent < 40) return;
      lastMoveSent = now;
    }
    socket.emit("input", { type, x, y, button: e.button });
  }

  function showHome() {
    selectedHost = null;
    pinView.hidden = true;
    sessionView.hidden = true;
    homeView.hidden = false;
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

  function teardown() {
    connected = false;
    mode = null;
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    if (pc) {
      pc.close();
      pc = null;
    }
    if (video.srcObject) {
      video.srcObject.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    }
    if (frameUrl) {
      URL.revokeObjectURL(frameUrl);
      frameUrl = null;
    }
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
