(() => {
  const shareBtn = document.getElementById("share-btn");
  const stopBtn = document.getElementById("stop-btn");
  const setupCodeInput = document.getElementById("setup-code");
  const hostMessage = document.getElementById("host-message");
  const agentStatus = document.getElementById("agent-status");
  const previewWrap = document.getElementById("preview-wrap");
  const preview = document.getElementById("preview");

  const AGENT_URL = "http://127.0.0.1:19780";
  let displayStream = null;
  let socket = null;
  let sharing = false;
  let hostInfo = null;
  let busy = false;
  let framesSent = 0;
  let tickWorker = null;
  let keepAliveAudio = null;
  let statusTimer = null;
  let agentOk = false;
  let screenWidth = 1920;
  let screenHeight = 1080;

  const captureVideo = document.createElement("video");
  captureVideo.muted = true;
  captureVideo.playsInline = true;
  captureVideo.setAttribute("playsinline", "true");
  captureVideo.setAttribute("webkit-playsinline", "true");
  captureVideo.autoplay = true;

  const captureCanvas = document.createElement("canvas");
  const captureCtx = captureCanvas.getContext("2d", {
    alpha: false,
    desynchronized: true,
  });

  shareBtn.addEventListener("click", startSharing);
  stopBtn.addEventListener("click", stopSharing);
  checkAgent();
  setInterval(checkAgent, 4000);

  document.addEventListener("visibilitychange", () => {
    if (!sharing) return;
    if (document.hidden) {
      setMessage(
        `Streaming in background… ${framesSent} frames sent. Leave this tab open on the host PC.`
      );
    } else {
      setMessage(`Online as “${hostInfo?.name || "host"}”. Frames sent: ${framesSent}`);
    }
  });

  async function startSharing() {
    const setupCode = setupCodeInput.value.trim();
    if (!setupCode) {
      setMessage("Enter the setup code from Admin.");
      return;
    }

    shareBtn.disabled = true;
    setMessage("Requesting screen capture…");

    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 8, max: 12 },
          width: { ideal: 1280, max: 1280 },
          height: { ideal: 720, max: 720 },
        },
        audio: false,
        preferCurrentTab: false,
      });
    } catch (err) {
      shareBtn.disabled = false;
      const insecure = !window.isSecureContext;
      if (insecure) {
        setMessage(
          "Screen capture needs HTTPS. Open https://74.208.54.132:5000/host and accept the certificate warning."
        );
      } else if (err.name === "NotAllowedError") {
        setMessage("Screen share permission denied. Click Allow, and choose Entire Screen.");
      } else if (!navigator.mediaDevices?.getDisplayMedia) {
        setMessage("Use Chrome or Edge on the host computer to share the screen.");
      } else {
        setMessage(`Could not start screen capture (${err.name || "error"}).`);
      }
      return;
    }

    displayStream.getVideoTracks()[0].addEventListener("ended", () => stopSharing());
    const trackSettings = displayStream.getVideoTracks()[0].getSettings?.() || {};
    screenWidth = trackSettings.width || screenWidth;
    screenHeight = trackSettings.height || screenHeight;
    preview.srcObject = displayStream;
    previewWrap.hidden = false;
    captureVideo.srcObject = displayStream;
    await captureVideo.play().catch(() => {});

    socket = io({
      transports: ["websocket", "polling"],
      upgrade: true,
      rememberUpgrade: true,
      reconnection: true,
      reconnectionAttempts: 20,
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 10000);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("connect_error", (err) => {
          clearTimeout(timer);
          reject(err || new Error("connect_error"));
        });
      });
    } catch {
      cleanupMedia();
      if (socket) socket.disconnect();
      socket = null;
      shareBtn.disabled = false;
      setMessage("Could not reach signaling server.");
      return;
    }

    const ack = await new Promise((resolve) => {
      socket.emit("host:register", { setupCode }, resolve);
    });

    if (!ack?.ok) {
      cleanupMedia();
      socket.disconnect();
      socket = null;
      shareBtn.disabled = false;
      setMessage(ack?.error || "Registration failed");
      return;
    }

    hostInfo = ack.host;
    sharing = true;
    framesSent = 0;
    shareBtn.hidden = true;
    stopBtn.hidden = false;
    setupCodeInput.disabled = true;
    setMessage(
      `Online as “${hostInfo.name}”. Keep this tab open, then connect from the other computer.`
    );

    socket.on("disconnect", () => {
      if (sharing) setMessage("Disconnected from server — reconnecting…");
    });
    socket.on("connect", () => {
      if (!sharing) return;
      socket.emit("host:register", { setupCode }, (again) => {
        if (again?.ok) {
          setMessage(`Reconnected as “${hostInfo.name}”. Streaming…`);
        }
      });
    });
    socket.on("host:replaced", () => {
      setMessage("Another session replaced this host.");
      stopSharing();
    });
    socket.on("host:removed", () => {
      setMessage("This host was removed in Admin.");
      stopSharing();
    });
    socket.on("client:joined", () => {
      setMessage(`Viewer connected — streaming (${framesSent} frames sent so far).`);
    });
    socket.on("input", (event) => {
      forwardInput(event);
    });

    startKeepAlive();
    startFrameLoop();
    statusTimer = setInterval(() => {
      if (!sharing) return;
      if (document.hidden) {
        setMessage(
          `Background streaming active — ${framesSent} frames sent. Do not close this tab.`
        );
      } else {
        setMessage(
          `Online as “${hostInfo.name}”. ${framesSent} frames sent. Connect from the other PC/phone.`
        );
      }
    }, 3000);
  }

  function startKeepAlive() {
    stopKeepAlive();
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      keepAliveAudio = new Ctx();
      const osc = keepAliveAudio.createOscillator();
      const gain = keepAliveAudio.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(keepAliveAudio.destination);
      osc.start();
      keepAliveAudio._osc = osc;
    } catch {
      /* ignore */
    }
  }

  function stopKeepAlive() {
    if (!keepAliveAudio) return;
    try {
      keepAliveAudio._osc?.stop();
      keepAliveAudio.close();
    } catch {
      /* ignore */
    }
    keepAliveAudio = null;
  }

  function startFrameLoop() {
    stopFrameLoop();
    // Web Workers are not heavily throttled when the tab is in the background,
    // so viewers on another computer keep receiving frames.
    const workerCode = `
      let timer = setInterval(() => postMessage("tick"), 120);
      onmessage = (e) => {
        if (e.data === "stop") clearInterval(timer);
      };
    `;
    const blob = new Blob([workerCode], { type: "application/javascript" });
    tickWorker = new Worker(URL.createObjectURL(blob));
    tickWorker.onmessage = () => {
      sendFrame();
    };
  }

  function stopFrameLoop() {
    if (tickWorker) {
      try {
        tickWorker.postMessage("stop");
        tickWorker.terminate();
      } catch {
        /* ignore */
      }
      tickWorker = null;
    }
  }

  function sendFrame() {
    if (!sharing || !socket || !socket.connected || busy) return;
    if (!captureVideo.videoWidth || !captureVideo.videoHeight) return;

    const maxW = 1024;
    const scale = Math.min(1, maxW / captureVideo.videoWidth);
    const w = Math.max(2, Math.round(captureVideo.videoWidth * scale));
    const h = Math.max(2, Math.round(captureVideo.videoHeight * scale));

    if (captureCanvas.width !== w || captureCanvas.height !== h) {
      captureCanvas.width = w;
      captureCanvas.height = h;
    }

    try {
      captureCtx.drawImage(captureVideo, 0, 0, w, h);
    } catch {
      return;
    }

    busy = true;
    let dataUrl;
    try {
      dataUrl = captureCanvas.toDataURL("image/jpeg", 0.45);
    } catch {
      busy = false;
      return;
    }

    socket.timeout(2000).emit("host:frame", dataUrl, (err) => {
      busy = false;
      if (!err) framesSent += 1;
    });
  }

  function stopSharing() {
    sharing = false;
    stopFrameLoop();
    stopKeepAlive();
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    cleanupMedia();
    shareBtn.hidden = false;
    shareBtn.disabled = false;
    stopBtn.hidden = true;
    setupCodeInput.disabled = false;
    setMessage("Sharing stopped.");
  }

  function cleanupMedia() {
    if (displayStream) {
      displayStream.getTracks().forEach((t) => t.stop());
      displayStream = null;
    }
    captureVideo.srcObject = null;
    preview.srcObject = null;
    previewWrap.hidden = true;
  }

  function setMessage(text) {
    hostMessage.textContent = text;
  }

  async function checkAgent() {
    if (!agentStatus) return;
    try {
      const res = await fetch(`${AGENT_URL}/health`, { cache: "no-store" });
      const data = await res.json();
      agentOk = !!data?.ok;
      agentStatus.textContent = agentOk
        ? `Input agent online (${data.platform}). Keyboard/mouse control enabled.`
        : "Input agent not running — keyboard/mouse will not control this PC.";
      agentStatus.style.color = agentOk ? "#9cf0c5" : "";
    } catch {
      agentOk = false;
      agentStatus.textContent =
        "Input agent not running. Download local-input-agent.js and run: node local-input-agent.js";
      agentStatus.style.color = "";
    }
  }

  function forwardInput(event) {
    if (!event) return;
    const payload = {
      ...event,
      screenWidth,
      screenHeight,
    };
    fetch(`${AGENT_URL}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      mode: "cors",
      keepalive: true,
    }).catch(() => {
      agentOk = false;
    });
  }
})();
