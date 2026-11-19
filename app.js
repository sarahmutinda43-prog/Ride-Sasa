let listings = [];
let savedListings = [];

const storageKeys = { saved: "ridesasa:saved" };
const currency = new Intl.NumberFormat("en-KE", { style: "currency", currency: "KES", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("en-KE");
const byId = (id) => document.getElementById(id);
const catalogState = { nextCursor: null, hasMore: false, loading: true, error: false, requestId: 0 };
let savedIds = readStorage(storageKeys.saved, []);
let savedOnly = false;
let toastTimer;
let searchTimer;

function readStorage(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    if (!saved) return fallback;
    const value = JSON.parse(saved);
    if (Array.isArray(value)) return value;
    showToast("Saved browser data was invalid and has been ignored.");
  } catch (error) {
    showToast("Saved browser data could not be loaded. Check your browser storage settings.");
  }
  return fallback;
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    showToast("Your browser couldn't save this change. Check your storage settings.");
    return false;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function allListings() {
  return listings;
}

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3000);
}

function getFilters() {
  const searchTerms = [
    byId("search-query").value,
    byId("filter-make").value,
    byId("filter-dealer").value
  ].map((value) => value.trim()).filter(Boolean);
  return {
    query: searchTerms.join(" "),
    location: byId("filter-location").value.trim(),
    maxPrice: Number(byId("filter-max-price").value) || 0,
    body: byId("filter-body").value,
    yearFrom: Number(byId("filter-year").value) || 0,
    transmission: byId("filter-transmission").value,
    sort: byId("sort-order").value
  };
}

function getVisibleListings() {
  return savedOnly ? savedListings : allListings();
}

function normalizeListing(car) {
  return {
    ...car,
    price: Number(car.priceKes),
    mileage: Number(car.mileageKm),
    image: car.imageUrls?.[0] || "",
    badge: "Dealer listed"
  };
}

function cardMarkup(car) {
  const isSaved = savedIds.includes(car.id);
  const image = car.image || car.imageUrls?.[0] || "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=900&q=82";
  const mileage = Number(car.mileage ?? car.mileageKm ?? 0);
  const engine = car.engineCc ? `<span>${escapeHtml(number.format(car.engineCc))} cc</span><span class="spec-dot"></span>` : "";
  return `<article class="car-card">
    <div class="car-image-wrap">
      <img class="car-image" src="${escapeHtml(image)}" alt="${escapeHtml(`${car.year} ${car.make} ${car.model}`)}" loading="lazy">
      <span class="car-badge">${escapeHtml(car.condition || car.badge || "Dealer listed")}</span>
      <button class="favorite-button${isSaved ? " saved" : ""}" type="button" data-action="toggle-saved" data-id="${escapeHtml(car.id)}" aria-label="${isSaved ? "Remove from" : "Add to"} saved cars" aria-pressed="${isSaved}">${isSaved ? "♥" : "♡"}</button>
    </div>
    <div class="car-card-body">
      <h3 class="car-title">${escapeHtml(car.make)} ${escapeHtml(car.model)}</h3>
      <p class="car-subtitle">${escapeHtml(String(car.year))} · ${escapeHtml(car.body)} · ${escapeHtml(car.transmission)}</p>
      <div class="car-specs"><span>${escapeHtml(number.format(mileage))} km</span><span class="spec-dot"></span>${engine}<span>${escapeHtml(car.fuel)}</span></div>
      <p class="dealer-name">${escapeHtml(car.dealerName || "Ride Sasa dealer")}</p>
      <div class="car-card-footer"><div><div class="car-price">${escapeHtml(currency.format(car.price))}</div><div class="car-location">⌖ ${escapeHtml(car.location)}</div></div><button class="details-button" type="button" data-action="show-details" data-id="${escapeHtml(car.id)}">View details <span aria-hidden="true">→</span></button></div>
    </div>
  </article>`;
}

function renderListings() {
  const visible = getVisibleListings();
  byId("listing-grid").innerHTML = visible.map(cardMarkup).join("");
  byId("empty-state").hidden = visible.length > 0 || catalogState.loading || catalogState.error;
  byId("inventory-notice").hidden = !catalogState.error;
  byId("load-more-listings").hidden = !catalogState.hasMore || savedOnly;
  byId("load-more-listings").disabled = catalogState.loading;
  byId("results-summary").textContent = savedOnly
    ? catalogState.loading
      ? "Loading saved cars..."
      : `${visible.length} saved ${visible.length === 1 ? "car" : "cars"}`
    : catalogState.loading
      ? "Loading listings..."
      : catalogState.error
        ? "Listings temporarily unavailable"
        : `${visible.length} ${visible.length === 1 ? "listing" : "listings"} loaded${catalogState.hasMore ? " — more available" : ""}`;
  byId("saved-count").textContent = String(savedIds.length);
  byId("listings").querySelector("h2").innerHTML = savedOnly
    ? `Your saved cars<span class="heading-period">.</span>`
    : `Cars worth a closer look<span class="heading-period">.</span>`;
}

function toggleSaved(id) {
  const next = savedIds.includes(id) ? savedIds.filter((savedId) => savedId !== id) : [...savedIds, id];
  if (writeStorage(storageKeys.saved, next)) {
    savedIds = next;
    if (savedOnly) loadSavedListings();
    else renderListings();
    showToast(savedIds.includes(id) ? "Saved for later." : "Removed from saved cars.");
  }
}

async function loadSavedListings() {
  const requestId = ++catalogState.requestId;
  catalogState.loading = true;
  catalogState.error = false;
  savedListings = [];
  renderListings();
  try {
    for (let index = 0; index < savedIds.length; index += 50) {
      const batch = savedIds.slice(index, index + 50);
      const response = await fetch(`/api/listings?ids=${encodeURIComponent(batch.join(","))}`);
      if (!response.ok) throw new Error(`Saved listings API returned ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.listings)) throw new Error("Saved listings response was invalid.");
      if (requestId !== catalogState.requestId) return;
      savedListings = [...savedListings, ...payload.listings.map(normalizeListing)];
      renderListings();
    }
  } catch (error) {
    if (requestId !== catalogState.requestId) return;
    console.warn("Saved vehicle listings could not be loaded.", error);
    catalogState.error = true;
    byId("inventory-notice").textContent = "Saved listings are temporarily unavailable. Please try again later.";
  } finally {
    if (requestId === catalogState.requestId) {
      catalogState.loading = false;
      renderListings();
    }
  }
}

function showDetails(id) {
  const car = allListings().find((item) => item.id === id);
  if (!car) return;
  const phone = car.phone ? car.phone.replace(/[^\d+]/g, "") : "";
  const contactAction = phone
    ? `<a class="button button-coral contact-button" href="https://wa.me/${encodeURIComponent(phone.replace(/^\+/, ""))}?text=${encodeURIComponent(`Hi, I'm interested in the ${car.year} ${car.make} ${car.model} listed on Ride Sasa.`)}" target="_blank" rel="noopener noreferrer">WhatsApp seller <span aria-hidden="true">↗</span></a>`
    : `<p class="contact-unavailable">Seller contact details will appear on verified listings.</p>`;
  const content = byId("dialog-content");
  content.innerHTML = `<div class="dialog-layout">
    <div class="dialog-image"><img src="${escapeHtml(car.image || car.imageUrls?.[0] || "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=900&q=82")}" alt="${escapeHtml(`${car.year} ${car.make} ${car.model}`)}"></div>
    <div class="dialog-copy">
      <button class="dialog-close" type="button" aria-label="Close details" data-action="close-details">×</button>
      <span class="car-badge">${escapeHtml(car.condition || car.badge || "Dealer listed")}</span>
      <h2>${escapeHtml(car.make)} ${escapeHtml(car.model)}</h2>
      <p class="dialog-subtitle">${escapeHtml(String(car.year))} · ${escapeHtml(car.body)} · ${escapeHtml(car.location)}</p>
      <p class="dealer-name">${escapeHtml(car.dealerName || "Ride Sasa dealer")}</p>
      <p class="dialog-price">${escapeHtml(currency.format(car.price))}</p>
      <div class="dialog-specs">
        <span>Mileage<strong>${escapeHtml(number.format(car.mileage))} km</strong></span>
        <span>Engine<strong>${car.engineCc ? `${escapeHtml(number.format(car.engineCc))} cc` : "Not listed"}</strong></span>
        <span>Transmission<strong>${escapeHtml(car.transmission)}</strong></span>
        <span>Fuel<strong>${escapeHtml(car.fuel)}</strong></span>
        <span>Location<strong>${escapeHtml(car.location)}, Kenya</strong></span>
      </div>
      <p class="seller-note">${escapeHtml(car.description || "Contact the seller for more information and to arrange a viewing.")}</p>
      ${contactAction}
    </div>
  </div>`;
  byId("listing-dialog").showModal();
}

function syncQuickSearch() {
  byId("filter-location").value = byId("search-location").value;
  byId("filter-max-price").value = byId("search-price").value;
  savedOnly = false;
  window.clearTimeout(searchTimer);
  loadPublicListings(true);
  byId("listings").scrollIntoView({ behavior: "smooth" });
}

function clearFilters() {
  ["search-query", "filter-make", "filter-dealer"].forEach((id) => { byId(id).value = ""; });
  ["search-location", "search-price", "filter-location", "filter-max-price", "filter-body", "filter-year", "filter-transmission"].forEach((id) => { byId(id).value = ""; });
  savedOnly = false;
  window.clearTimeout(searchTimer);
  loadPublicListings(true);
}

function scheduleCatalogSearch() {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    savedOnly = false;
    loadPublicListings(true);
  }, 250);
}

document.addEventListener("input", (event) => {
  if (event.target.id === "search-location") byId("filter-location").value = event.target.value;
  if (event.target.closest("#filter-panel") || ["search-query", "search-location"].includes(event.target.id)) {
    scheduleCatalogSearch();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "search-location") byId("filter-location").value = event.target.value;
  if (event.target.id === "search-price") byId("filter-max-price").value = event.target.value;
  if (event.target.matches("#filter-panel select, #search-location, #search-price, #sort-order")) {
    savedOnly = false;
    window.clearTimeout(searchTimer);
    loadPublicListings(true);
  }
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  switch (button.dataset.action) {
    case "toggle-saved":
      toggleSaved(button.dataset.id);
      break;
    case "show-details":
      showDetails(button.dataset.id);
      break;
    case "close-details":
      byId("listing-dialog").close();
      break;
    case "clear-filters":
      clearFilters();
      break;
    case "show-saved":
      savedOnly = !savedOnly;
      if (savedOnly) loadSavedListings();
      else loadPublicListings(true);
      byId("listings").scrollIntoView({ behavior: "smooth" });
      break;
    case "toggle-filters": {
      const panel = byId("filter-panel");
      const isOpen = panel.classList.toggle("open");
      button.setAttribute("aria-expanded", String(isOpen));
      break;
    }
  }
});

byId("quick-search").addEventListener("submit", (event) => {
  event.preventDefault();
  syncQuickSearch();
});
byId("load-more-listings").addEventListener("click", () => loadPublicListings(false));
byId("menu-toggle").addEventListener("click", (event) => {
  const nav = byId("primary-nav");
  const isOpen = nav.classList.toggle("open");
  event.currentTarget.setAttribute("aria-expanded", String(isOpen));
});
byId("primary-nav").addEventListener("click", (event) => {
  if (!event.target.closest("a")) return;
  byId("primary-nav").classList.remove("open");
  byId("menu-toggle").setAttribute("aria-expanded", "false");
});

renderListings();
loadPublicListings(true);

async function loadPublicListings(reset = true) {
  const requestId = ++catalogState.requestId;
  if (reset) {
    listings = [];
    catalogState.nextCursor = null;
    catalogState.hasMore = false;
  }
  catalogState.error = false;
  catalogState.loading = true;
  renderListings();
  const filters = getFilters();
  const params = new URLSearchParams({ sort: filters.sort });
  if (filters.query) params.set("q", filters.query);
  if (filters.location) params.set("location", filters.location);
  if (filters.maxPrice) params.set("maxPrice", String(filters.maxPrice));
  if (filters.body) params.set("body", filters.body);
  if (filters.yearFrom) params.set("yearFrom", String(filters.yearFrom));
  if (filters.transmission) params.set("transmission", filters.transmission);
  if (!reset && catalogState.nextCursor) params.set("cursor", catalogState.nextCursor);
  try {
    const response = await fetch(`/api/listings?${params}`);
    if (!response.ok) throw new Error(`Listings API returned ${response.status}`);
    const payload = await response.json();
    if (
      !Array.isArray(payload.listings) ||
      typeof payload.hasMore !== "boolean" ||
      (payload.hasMore && typeof payload.nextCursor !== "string")
    ) throw new Error("Listings API response was invalid.");
    if (requestId !== catalogState.requestId) return;
    const page = payload.listings.map(normalizeListing);
    listings = reset ? page : [...listings, ...page];
    catalogState.nextCursor = payload.nextCursor;
    catalogState.hasMore = payload.hasMore;
  } catch (error) {
    if (requestId !== catalogState.requestId) return;
    console.warn("Live vehicle listings could not be loaded.", error);
    catalogState.error = true;
    catalogState.hasMore = false;
    byId("inventory-notice").textContent = "Live listings are temporarily unavailable. Please try again later.";
  } finally {
    if (requestId === catalogState.requestId) {
      catalogState.loading = false;
      renderListings();
    }
  }
}
