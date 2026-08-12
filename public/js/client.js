(() => {
  const SESSION_KEY = "rd-session";
  const homeView = document.getElementById("home-view");
  const pinView = document.getElementById("pin-view");
  const hostList = document.getElementById("host-list");
  const homeEmpty = document.getElementById("home-empty");
  const homeError = document.getElementById("home-error");
  const pinForm = document.getElementById("pin-form");
  const pinInput = document.getElementById("pin-input");
  const pinHostName = document.getElementById("pin-host-name");
  const pinError = document.getElementById("pin-error");
  const pinBackBtn = document.getElementById("pin-back-btn");
  const pinConnectBtn = document.getElementById("pin-connect-btn");

  let selectedHost = null;

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
    const pin = pinInput.value.trim();
    try {
      const res = await fetch("/api/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId: selectedHost.id, pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Could not connect");
      }

      const hostName = data.host?.name || selectedHost.name || "Remote computer";
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          hostId: selectedHost.id,
          pin,
          hostName,
        })
      );
      // Navigate to the dedicated remote-control page (Chrome Remote Desktop style).
      window.location.href = `/session?hostId=${encodeURIComponent(selectedHost.id)}`;
    } catch (err) {
      pinError.hidden = false;
      pinError.textContent = err.message || "Could not connect";
      pinConnectBtn.disabled = false;
      pinConnectBtn.textContent = "Connect";
    }
  });

  pinBackBtn.addEventListener("click", () => showHome());

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
    pinView.hidden = false;
    pinInput.focus();
  }

  function showHome() {
    selectedHost = null;
    pinView.hidden = true;
    homeView.hidden = false;
    refreshHosts();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }
})();
