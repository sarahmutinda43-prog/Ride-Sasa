const byId = (id) => document.getElementById(id);
const currency = new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", maximumFractionDigits: 0 });
const state = { dashboard: null, listings: [], listingsCursor: null, listingsHasMore: false, editingId: null };
let toastTimer;

function showMessage(message, kind = "info") {
  const element = byId("portal-message");
  element.textContent = message;
  element.className = `portal-message ${kind}`;
  element.hidden = !message;
}

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3500);
}

async function apiRequest(path, options = {}) {
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
    throw new Error("The server returned an unreadable response. Please try again.");
  }
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setAuthView(view) {
  const signup = view === "signup";
  byId("login-form").hidden = signup;
  byId("signup-form").hidden = !signup;
  byId("auth-title").textContent = signup ? "Create your dealer account" : "Sign in to your account";
  document.querySelectorAll("[data-auth-view]").forEach((button) => {
    const active = button.dataset.authView === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (!byId("dealer-dashboard").hidden) return;
  showMessage("");
}

function setAuthenticated(dealer) {
  byId("auth-card").hidden = Boolean(dealer);
  byId("dealer-dashboard").hidden = !dealer;
}

function updateDashboardSummary() {
  const dashboard = state.dashboard;
  if (!dashboard) return;
  byId("plan-status").textContent = "Free";
  byId("plan-detail").textContent = "No listing fees or expiry dates";
  const activeCount = Number(dashboard.activeListings || 0);
  byId("listing-count").textContent = String(activeCount);
  byId("listing-capacity").textContent = "Unlimited active listings";
  byId("dealer-name").textContent = dashboard.dealer.name;
  byId("dealer-email").textContent = dashboard.dealer.email;
  byId("profile-email").textContent = dashboard.dealer.email;
  const profileForm = byId("profile-form");
  profileForm.elements.namedItem("name").value = dashboard.dealer.name || "";
  profileForm.elements.namedItem("phone").value = dashboard.dealer.phone || "";
  profileForm.elements.namedItem("showPhone").checked = Boolean(dashboard.dealer.publicPhone);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function renderDealerListings() {
  byId("listing-form-help").textContent = state.editingId
    ? "Update this unit's details."
    : "Add complete, accurate details so buyers can compare your unit.";
  const container = byId("dealer-listings");
  byId("empty-inventory").hidden = state.listings.length > 0;
  byId("load-older-listings").hidden = !state.listingsHasMore;
  container.innerHTML = state.listings.map((listing) => {
    const archived = listing.status !== "published";
    const image = listing.imageUrls?.[0];
    return `<article class="dealer-listing">
      <div class="dealer-listing-image">${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy">` : `<span aria-hidden="true">▰</span>`}</div>
      <div class="dealer-listing-copy">
        <div class="dealer-listing-title-row"><h3>${escapeHtml(listing.year)} ${escapeHtml(listing.make)} ${escapeHtml(listing.model)}</h3><span class="listing-status${archived ? " archived" : ""}">${archived ? "Archived" : "Published"}</span></div>
        <p>${escapeHtml(listing.body)} · ${escapeHtml(listing.location)} · ${escapeHtml(listing.mileageKm)} km</p>
        <strong>${escapeHtml(currency.format(Number(listing.priceKes)))}</strong>
        <div class="dealer-listing-actions">
          ${archived ? "" : `<button class="text-button" type="button" data-listing-action="edit" data-id="${escapeHtml(listing.id)}">Edit</button><button class="text-button archive-action" type="button" data-listing-action="archive" data-id="${escapeHtml(listing.id)}">Archive</button>`}
        </div>
      </div>
    </article>`;
  }).join("");
}

async function refreshDashboard() {
  const dashboard = await apiRequest("/api/me");
  state.dashboard = dashboard;
  const result = await apiRequest("/api/dealer/listings");
  state.listings = result.listings || [];
  state.listingsCursor = result.nextCursor;
  state.listingsHasMore = Boolean(result.hasMore);
  setAuthenticated(dashboard.dealer);
  updateDashboardSummary();
  renderDealerListings();
}

async function loadOlderDealerListings() {
  if (!state.listingsHasMore || !state.listingsCursor) return;
  const button = byId("load-older-listings");
  button.disabled = true;
  try {
    const result = await apiRequest(`/api/dealer/listings?cursor=${encodeURIComponent(state.listingsCursor)}`);
    state.listings = [...state.listings, ...(result.listings || [])];
    state.listingsCursor = result.nextCursor;
    state.listingsHasMore = Boolean(result.hasMore);
    renderDealerListings();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function loadPortal() {
  try {
    await refreshDashboard();
    showMessage("");
  } catch (error) {
    if (error.status === 401) {
      setAuthenticated(null);
      showMessage("");
      return;
    }
    setAuthenticated(null);
    showMessage(`${error.message} Dealer services are not available until the Cloudflare database is configured.`, "error");
  }
}

function formListingData(form) {
  const data = new FormData(form);
  const imageUrls = String(data.get("imageUrls") || "")
    .split(/\r?\n|\s*\|\s*/)
    .map((url) => url.trim())
    .filter(Boolean);
  return {
    make: String(data.get("make") || "").trim(),
    model: String(data.get("model") || "").trim(),
    year: Number(data.get("year")),
    priceKes: Number(data.get("priceKes")),
    mileageKm: Number(data.get("mileageKm")),
    engineCc: String(data.get("engineCc") || "").trim() ? Number(data.get("engineCc")) : null,
    fuel: String(data.get("fuel") || ""),
    transmission: String(data.get("transmission") || ""),
    body: String(data.get("body") || ""),
    condition: String(data.get("condition") || ""),
    location: String(data.get("location") || "").trim(),
    description: String(data.get("description") || "").trim(),
    imageUrls
  };
}

function populateListingForm(listing) {
  const form = byId("listing-form");
  for (const [key, value] of Object.entries(listing)) {
    if (!form.elements.namedItem(key)) continue;
    if (key === "imageUrls") form.elements.namedItem(key).value = (value || []).join("\n");
    else if (value != null) form.elements.namedItem(key).value = value;
  }
  state.editingId = listing.id;
  byId("listing-form-title").textContent = "Edit unit";
  byId("save-listing-button").innerHTML = 'Save changes <span aria-hidden="true">→</span>';
  byId("cancel-edit-button").hidden = false;
  renderDealerListings();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetListingForm() {
  state.editingId = null;
  byId("listing-form").reset();
  byId("listing-form-title").textContent = "Add a unit";
  byId("save-listing-button").innerHTML = 'Publish unit <span aria-hidden="true">→</span>';
  byId("cancel-edit-button").hidden = true;
  if (state.dashboard) renderDealerListings();
}

async function submitListing(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const editingId = state.editingId;
  const path = editingId ? `/api/dealer/listings/${encodeURIComponent(editingId)}` : "/api/dealer/listings";
  try {
    await apiRequest(path, {
      method: editingId ? "PATCH" : "POST",
      body: JSON.stringify(formListingData(form))
    });
    resetListingForm();
    await refreshDashboard();
    showMessage(editingId ? "Listing updated." : "Your unit is now published.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function submitProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const values = {
    name: form.elements.namedItem("name").value.trim(),
    phone: form.elements.namedItem("phone").value.trim(),
    showPhone: form.elements.namedItem("showPhone").checked
  };
  try {
    await apiRequest("/api/dealer/profile", { method: "PATCH", body: JSON.stringify(values) });
    await refreshDashboard();
    showMessage("Dealer profile saved.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function handleDealerListingAction(event) {
  const button = event.target.closest("[data-listing-action]");
  if (!button) return;
  const listing = state.listings.find((item) => item.id === button.dataset.id);
  if (!listing) return;
  if (button.dataset.listingAction === "edit") {
    populateListingForm(listing);
    return;
  }
  if (!window.confirm(`Archive ${listing.year} ${listing.make} ${listing.model}? It will no longer appear in public search.`)) return;
  try {
    await apiRequest(`/api/dealer/listings/${encodeURIComponent(listing.id)}/archive`, { method: "POST" });
    if (state.editingId === listing.id) resetListingForm();
    await refreshDashboard();
    showMessage("Listing archived. It is no longer visible to buyers.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function handleAuthSubmit(event, route) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  if (route.endsWith("register")) {
    values.showPhone = form.elements.namedItem("showPhone").checked;
  }
  try {
    await apiRequest(route, { method: "POST", body: JSON.stringify(values) });
    form.reset();
    await refreshDashboard();
    showMessage(route.endsWith("register") ? "Your dealer account is ready. Listings are free and unlimited." : "You are signed in.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
}

byId("login-form").addEventListener("submit", (event) => handleAuthSubmit(event, "/api/auth/login"));
byId("signup-form").addEventListener("submit", (event) => handleAuthSubmit(event, "/api/auth/register"));
byId("listing-form").addEventListener("submit", submitListing);
byId("profile-form").addEventListener("submit", submitProfile);
byId("dealer-listings").addEventListener("click", handleDealerListingAction);
byId("load-older-listings").addEventListener("click", loadOlderDealerListings);
byId("cancel-edit-button").addEventListener("click", resetListingForm);
byId("logout-button").addEventListener("click", async () => {
  try {
    await apiRequest("/api/auth/logout", { method: "POST", body: "{}" });
    state.dashboard = null;
    state.listings = [];
    resetListingForm();
    setAuthenticated(null);
    showMessage("You have signed out.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});
document.querySelectorAll("[data-auth-view]").forEach((button) => {
  button.addEventListener("click", () => {
    setAuthView(button.dataset.authView);
    history.replaceState(null, "", button.dataset.authView === "signup" ? "#signup" : "#login");
  });
});
document.querySelectorAll(".sidebar-link").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".sidebar-link").forEach((item) => item.classList.toggle("active", item === link));
  });
});
byId("listing-form").elements.namedItem("year").max = String(new Date().getFullYear() + 1);

const initialView = window.location.hash === "#signup" ? "signup" : "login";
setAuthView(initialView);

const query = new URLSearchParams(window.location.search);
const oauthResult = query.get("oauth");
const oauthReason = query.get("reason");
const oauthErrors = {
  google_unconfigured: "Google sign-in is not configured in Cloudflare yet.",
  google_cancelled: "Google sign-in was cancelled.",
  google_state: "This Google sign-in expired or could not be verified. Please try again.",
  google_failed: "Google sign-in could not be verified. Please try again."
};
loadPortal().then(() => {
  if (oauthResult === "success") {
    showMessage(
      state.dashboard ? "Signed in securely with Google." : "Google sign-in did not complete. Please try again.",
      state.dashboard ? "success" : "error"
    );
  } else if (oauthResult === "error") {
    showMessage(oauthErrors[oauthReason] || "Google sign-in failed.", "error");
  }
});
