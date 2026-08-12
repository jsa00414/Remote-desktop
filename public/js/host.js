(() => {
  const shareBtn = document.getElementById("share-btn");
  const stopBtn = document.getElementById("stop-btn");
  const setupCodeInput = document.getElementById("setup-code");
  const hostMessage = document.getElementById("host-message");
  const previewWrap = document.getElementById("preview-wrap");
  const preview = document.getElementById("preview");

  let displayStream = null;
  let socket = null;
  let sharing = false;
  let hostInfo = null;
  let frameTimer = null;
  let sending = false;

  const captureVideo = document.createElement("video");
  captureVideo.muted = true;
  captureVideo.playsInline = true;
  captureVideo.setAttribute("playsinline", "true");
  captureVideo.setAttribute("webkit-playsinline", "true");
  captureVideo.autoplay = true;

  const captureCanvas = document.createElement("canvas");
  const captureCtx = captureCanvas.getContext("2d", { alpha: false });

  shareBtn.addEventListener("click", startSharing);
  stopBtn.addEventListener("click", stopSharing);

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
          frameRate: 8,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
    } catch (err) {
      shareBtn.disabled = false;
      const insecure = !window.isSecureContext;
      if (insecure) {
        setMessage(
          "Screen capture needs HTTPS. Open https://74.208.54.132:5000/host (accept the certificate warning), then try again."
        );
      } else if (err.name === "NotAllowedError") {
        setMessage("Screen share permission denied. Click Allow in the browser prompt.");
      } else if (!navigator.mediaDevices?.getDisplayMedia) {
        setMessage("This browser does not support screen sharing. Use Chrome or Edge on a computer to share.");
      } else {
        setMessage(`Could not start screen capture (${err.name || "error"}).`);
      }
      return;
    }

    displayStream.getVideoTracks()[0].addEventListener("ended", () => stopSharing());
    preview.srcObject = displayStream;
    previewWrap.hidden = false;
    captureVideo.srcObject = displayStream;
    await captureVideo.play().catch(() => {});

    socket = io({
      transports: ["websocket", "polling"],
      upgrade: true,
      rememberUpgrade: true,
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
    shareBtn.hidden = true;
    stopBtn.hidden = false;
    setupCodeInput.disabled = true;
    setMessage(`Online as “${hostInfo.name}”. Open the site on iPhone to view.`);

    socket.on("host:replaced", () => {
      setMessage("Another session replaced this host.");
      stopSharing();
    });
    socket.on("host:removed", () => {
      setMessage("This host was removed in Admin.");
      stopSharing();
    });
    socket.on("client:joined", () => {
      setMessage("Viewer connected — streaming to phone/computer.");
    });

    startFrameLoop();
  }

  function startFrameLoop() {
    stopFrameLoop();
    frameTimer = setInterval(sendFrame, 150);
  }

  function stopFrameLoop() {
    if (frameTimer) {
      clearInterval(frameTimer);
      frameTimer = null;
    }
  }

  function sendFrame() {
    if (!sharing || !socket || sending) return;
    if (!captureVideo.videoWidth || !captureVideo.videoHeight) return;

    const maxW = 960;
    const scale = Math.min(1, maxW / captureVideo.videoWidth);
    const w = Math.max(2, Math.round(captureVideo.videoWidth * scale));
    const h = Math.max(2, Math.round(captureVideo.videoHeight * scale));

    if (captureCanvas.width !== w || captureCanvas.height !== h) {
      captureCanvas.width = w;
      captureCanvas.height = h;
    }

    captureCtx.drawImage(captureVideo, 0, 0, w, h);
    // Base64 data URL works reliably on iPhone Safari (binary sockets often do not).
    const dataUrl = captureCanvas.toDataURL("image/jpeg", 0.5);
    sending = true;
    socket.emit("host:frame", dataUrl, () => {
      sending = false;
    });
    // Fallback if server does not ack callbacks
    setTimeout(() => {
      sending = false;
    }, 80);
  }

  function stopSharing() {
    sharing = false;
    stopFrameLoop();
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
})();
