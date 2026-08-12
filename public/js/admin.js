(() => {
  const TOKEN_KEY = "rd_admin_token";

  const loginView = document.getElementById("login-view");
  const adminView = document.getElementById("admin-view");
  const loginForm = document.getElementById("admin-login-form");
  const passwordInput = document.getElementById("admin-password");
  const loginError = document.getElementById("admin-login-error");
  const logoutBtn = document.getElementById("logout-btn");
  const addForm = document.getElementById("add-host-form");
  const nameInput = document.getElementById("new-host-name");
  const pinInput = document.getElementById("new-host-pin");
  const addError = document.getElementById("add-host-error");
  const listEl = document.getElementById("admin-host-list");
  const emptyEl = document.getElementById("admin-empty");

  let token = localStorage.getItem(TOKEN_KEY) || "";

  if (token) {
    bootAdmin();
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: passwordInput.value }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Login failed");
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      passwordInput.value = "";
      showAdmin();
      await loadHosts();
    } catch (err) {
      loginError.hidden = false;
      loginError.textContent = err.message;
    }
  });

  logoutBtn.addEventListener("click", async () => {
    try {
      await api("/api/admin/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    token = "";
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
  });

  addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    addError.hidden = true;
    try {
      const data = await api("/api/admin/hosts", {
        method: "POST",
        body: JSON.stringify({
          name: nameInput.value.trim(),
          pin: pinInput.value.trim(),
        }),
      });
      if (!data.ok) throw new Error(data.error || "Could not add host");
      nameInput.value = "";
      pinInput.value = "8112026";
      await loadHosts();
    } catch (err) {
      addError.hidden = false;
      addError.textContent = err.message;
    }
  });

  async function bootAdmin() {
    try {
      await loadHosts();
      showAdmin();
    } catch {
      token = "";
      localStorage.removeItem(TOKEN_KEY);
      showLogin();
    }
  }

  async function loadHosts() {
    const data = await api("/api/admin/hosts");
    renderHosts(data.hosts || []);
  }

  function renderHosts(hosts) {
    listEl.innerHTML = "";
    emptyEl.hidden = hosts.length > 0;

    for (const host of hosts) {
      const card = document.createElement("article");
      card.className = "admin-host-card";
      card.innerHTML = `
        <div class="admin-host-top">
          <div>
            <h3>${escapeHtml(host.name)}</h3>
            <span class="status-pill ${host.online ? "online" : "offline"}">
              ${host.online ? "Online" : "Offline"}
              ${host.mode ? `· ${host.mode}` : ""}
            </span>
          </div>
          <div class="row-actions">
            <button type="button" class="btn ghost" data-action="rotate">New setup code</button>
            <button type="button" class="btn danger" data-action="delete">Remove</button>
          </div>
        </div>
        <dl class="admin-meta">
          <div><dt>PIN</dt><dd><code>${escapeHtml(host.pin)}</code></dd></div>
          <div><dt>Setup code</dt><dd><code>${escapeHtml(host.setupCode)}</code></dd></div>
        </dl>
        <p class="admin-help">
          On that computer open <code>/host</code>, enter setup code
          <code>${escapeHtml(host.setupCode)}</code>, then share the screen.
        </p>
      `;

      card.querySelector('[data-action="rotate"]').addEventListener("click", async () => {
        await api(`/api/admin/hosts/${host.id}`, {
          method: "PATCH",
          body: JSON.stringify({ rotateSetupCode: true }),
        });
        await loadHosts();
      });

      card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
        if (!confirm(`Remove “${host.name}”?`)) return;
        await api(`/api/admin/hosts/${host.id}`, { method: "DELETE" });
        await loadHosts();
      });

      listEl.appendChild(card);
    }
  }

  async function api(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": token,
        ...(options.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      token = "";
      localStorage.removeItem(TOKEN_KEY);
      showLogin();
      throw new Error(data.error || "Admin login required");
    }
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  function showAdmin() {
    loginView.hidden = true;
    adminView.hidden = false;
  }

  function showLogin() {
    adminView.hidden = true;
    loginView.hidden = false;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  setInterval(() => {
    if (!adminView.hidden && token) loadHosts().catch(() => {});
  }, 5000);
})();
