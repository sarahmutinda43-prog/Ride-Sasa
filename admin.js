const byId = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function showAdminMessage(message, kind = "info") {
  const element = byId("admin-message");
  element.textContent = message;
  element.className = `portal-message ${kind}`;
  element.hidden = !message;
}

async function adminRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    if (!response.ok) {
      const error = new Error(`Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    throw new Error("The server returned an unreadable response.");
  }
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function formatAdminDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" });
}

function renderAdminOverview(data) {
  byId("admin-dealer-count").textContent = String(data.counts.dealers);
  byId("admin-listing-count").textContent = String(data.counts.activeListings);
  byId("admin-empty").hidden = data.dealers.length > 0;
  byId("admin-dealer-rows").innerHTML = data.dealers.map((dealer) => {
    return `<tr>
      <td>${escapeHtml(dealer.name)}</td>
      <td>${escapeHtml(dealer.email)}</td>
      <td>${escapeHtml(dealer.activeListings)}</td>
      <td>${escapeHtml(formatAdminDate(dealer.joinedAt))}</td>
    </tr>`;
  }).join("");
}

async function loadAdmin() {
  const query = new URLSearchParams(window.location.search);
  if (query.get("oauth") === "error") {
    const reason = query.get("reason");
    const messages = {
      google_unconfigured: "Google sign-in is not configured in Cloudflare yet.",
      google_cancelled: "Google sign-in was cancelled.",
      google_state: "This sign-in expired or could not be verified. Please try again.",
      google_failed: "Google sign-in could not be verified. Please try again."
    };
    showAdminMessage(messages[reason] || "Google sign-in failed.", "error");
  }

  try {
    const dashboard = await adminRequest("/api/me");
    if (dashboard.dealer.role !== "admin") {
      throw new Error("This Google account does not have administrator access.");
    }
    const overview = await adminRequest("/api/admin/overview");
    byId("admin-name").textContent = dashboard.dealer.name;
    byId("admin-email").textContent = dashboard.dealer.email;
    renderAdminOverview(overview);
    byId("admin-login").hidden = true;
    byId("admin-dashboard").hidden = false;
    byId("admin-logout").hidden = false;
    if (query.get("oauth") === "success") showAdminMessage("Signed in securely with Google.", "success");
  } catch (error) {
    if (error.status !== 401) showAdminMessage(error.message, "error");
  }
}

byId("admin-logout").addEventListener("click", async () => {
  try {
    await adminRequest("/api/auth/logout", { method: "POST", body: "{}" });
    window.location.assign("admin.html");
  } catch (error) {
    showAdminMessage(error.message, "error");
  }
});

loadAdmin();
