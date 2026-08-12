(() => {
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

  const shareBtn = document.getElementById("share-btn");
  const stopBtn = document.getElementById("stop-btn");
  const setupCodeInput = document.getElementById("setup-code");
  const hostMessage = document.getElementById("host-message");
  const previewWrap = document.getElementById("preview-wrap");
  const preview = document.getElementById("preview");

  let displayStream = null;
  const peers = new Map();
  let socket = null;
  let sharing = false;
  let hostInfo = null;

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
        video: { frameRate: 30, width: { ideal: 1920 }, height: { ideal: 1080 } },
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
        setMessage("This browser does not support screen sharing. Use Chrome or Edge on desktop.");
      } else {
        setMessage(`Could not start screen capture (${err.name || "error"}).`);
      }
      return;
    }

    displayStream.getVideoTracks()[0].addEventListener("ended", () => stopSharing());
    preview.srcObject = displayStream;
    previewWrap.hidden = false;

    socket = io({ transports: ["websocket", "polling"] });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 8000);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("connect_error", () => {
          clearTimeout(timer);
          reject(new Error("connect_error"));
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
    setMessage(`Online as “${hostInfo.name}”. Waiting for clients…`);

    socket.on("host:replaced", () => {
      setMessage("Another session replaced this host.");
      stopSharing();
    });
    socket.on("host:removed", () => {
      setMessage("This host was removed in Admin.");
      stopSharing();
    });

    socket.on("client:joined", async ({ clientId }) => {
      await createOfferForClient(clientId);
    });

    socket.on("signal", async ({ from, data }) => {
      if (!sharing || !displayStream) return;
      try {
        if (data?.type === "request-offer") {
          await createOfferForClient(from);
          return;
        }
        const pc = peers.get(from);
        if (!pc) return;
        if (data.type === "answer") await pc.setRemoteDescription(data);
        else if (data.candidate) await pc.addIceCandidate(data);
      } catch (err) {
        console.error(err);
      }
    });
  }

  async function createOfferForClient(clientId) {
    closePeer(clientId);
    const pc = new RTCPeerConnection({ iceServers });
    peers.set(clientId, pc);
    displayStream.getTracks().forEach((track) => pc.addTrack(track, displayStream));

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("signal", { to: clientId, data: event.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        closePeer(clientId);
        if (sharing) setMessage(`Online as “${hostInfo?.name || "host"}”. Waiting for clients…`);
      } else if (pc.connectionState === "connected") {
        setMessage("Client connected — streaming.");
      }
    };

    const offer = await pc.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false,
    });
    await pc.setLocalDescription(offer);
    socket.emit("signal", { to: clientId, data: pc.localDescription });
  }

  function stopSharing() {
    sharing = false;
    for (const id of [...peers.keys()]) closePeer(id);
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
    preview.srcObject = null;
    previewWrap.hidden = true;
  }

  function closePeer(id) {
    const pc = peers.get(id);
    if (!pc) return;
    pc.close();
    peers.delete(id);
  }

  function setMessage(text) {
    hostMessage.textContent = text;
  }
})();
