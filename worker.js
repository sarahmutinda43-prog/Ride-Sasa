const PASSWORD_ITERATIONS = 120000;
const SESSION_DAYS = 30;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PUBLIC_LISTING_PAGE_SIZE = 24;
const DEALER_LISTING_PAGE_SIZE = 30;
const ADMIN_EMAIL = "antoniokinyua4@gmail.com";
let googleJwksCache;
let googleJwksExpiresAt = 0;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders
    }
  });
}

function fail(message, status = 400) {
  return json({ error: message }, status);
}

function isoNow() {
  return new Date().toISOString();
}

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value) {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encodePageCursor(sort, value, id) {
  return base64Url(new TextEncoder().encode(JSON.stringify({ sort, value, id })));
}

function decodePageCursor(token, sort) {
  if (!token) return null;
  if (token.length > 512) return undefined;
  try {
    const cursor = JSON.parse(new TextDecoder().decode(decodeBase64Url(token)));
    if (
      !cursor ||
      cursor.sort !== sort ||
      typeof cursor.id !== "string" ||
      cursor.id.length === 0 ||
      cursor.id.length > 100 ||
      !(
        (typeof cursor.value === "string" && cursor.value.length > 0 && cursor.value.length <= 80) ||
        (typeof cursor.value === "number" && Number.isSafeInteger(cursor.value))
      )
    ) return undefined;
    return cursor;
  } catch {
    return undefined;
  }
}

function fullTextExpression(value) {
  const terms = value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return [...new Set(terms)].slice(0, 8).map((term) => `"${term}"*`).join(" AND ");
}

function parseJwtSegment(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function digestToken(token) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

async function hashPassword(password, saltHex, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations },
    key,
    256
  );
  return toHex(bits);
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function cookieValue(request, name) {
  const cookie = request.headers.get("cookie") || "";
  const entry = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : "";
}

function sessionCookie(token, maxAge) {
  return `ride_sasa_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return "ride_sasa_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

async function readJson(request) {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return { error: "Send this request as JSON." };
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 100000) return { error: "Request is too large." };
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { error: "Request body must be a JSON object." };
    }
    return body;
  } catch {
    return { error: "Request body must be valid JSON." };
  }
}

function requireDatabase(env) {
  return env.DB ? null : fail("Dealer services are not configured yet. Please try again later.", 503);
}

function readDatabase(env) {
  return typeof env.DB.withSession === "function"
    ? env.DB.withSession("first-unconstrained")
    : env.DB;
}

function safeDealer(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    publicPhone: Boolean(row.public_phone),
    createdAt: row.created_at,
    role: row.role || "dealer"
  };
}

async function currentDealer(request, env) {
  const token = cookieValue(request, "ride_sasa_session");
  if (!token) return null;
  const tokenHash = await digestToken(token);
  return env.DB.prepare(
    `SELECT d.* FROM sessions s
     JOIN dealers d ON d.id = s.dealer_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(tokenHash, isoNow()).first();
}

function dashboardData(dealer, activeListings) {
  return {
    dealer: safeDealer(dealer),
    activeListings
  };
}

function validEmail(value) {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizedText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 9 && digits.length <= 15;
}

function validImageUrls(value) {
  if (!Array.isArray(value) || value.length > 8) return false;
  return value.every((image) => {
    if (typeof image !== "string" || image.length > 2048) return false;
    try {
      return new URL(image).protocol === "https:";
    } catch {
      return false;
    }
  });
}

function normalizeListing(body) {
  const make = normalizedText(body.make, 60);
  const model = normalizedText(body.model, 80);
  const year = Number(body.year);
  const price = Number(body.priceKes);
  const mileage = Number(body.mileageKm);
  const engine = body.engineCc === "" || body.engineCc == null ? null : Number(body.engineCc);
  const fuel = normalizedText(body.fuel, 30);
  const transmission = normalizedText(body.transmission, 30);
  const bodyType = normalizedText(body.body, 40);
  const condition = normalizedText(body.condition, 40);
  const location = normalizedText(body.location, 60);
  const description = normalizedText(body.description, 2000);
  const imageUrls = body.imageUrls == null ? [] : body.imageUrls;

  if (!make || !model || !fuel || !transmission || !bodyType || !condition || !location) {
    return { error: "Complete all required vehicle details." };
  }
  if (!Number.isInteger(year) || year < 1950 || year > new Date().getUTCFullYear() + 1) {
    return { error: "Enter a valid vehicle year." };
  }
  if (!Number.isSafeInteger(price) || price < 1 || price > 1000000000) {
    return { error: "Enter a valid price in Kenyan shillings." };
  }
  if (!Number.isSafeInteger(mileage) || mileage < 0 || mileage > 5000000) {
    return { error: "Enter a valid mileage." };
  }
  if (engine !== null && (!Number.isSafeInteger(engine) || engine < 1 || engine > 20000)) {
    return { error: "Enter a valid engine size in cc." };
  }
  if (!validImageUrls(imageUrls)) {
    return { error: "Vehicle images must be HTTPS URLs (up to 8 images)." };
  }
  return {
    value: { make, model, year, price, mileage, engine, fuel, transmission, bodyType, condition, location, description, imageUrls }
  };
}

async function createSession(env, dealerId) {
  const token = randomToken();
  const now = Date.now();
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, dealer_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(await digestToken(token), dealerId, new Date(now + maxAge * 1000).toISOString(), new Date(now).toISOString()).run();
  return { token, maxAge };
}

async function register(request, env) {
  const body = await readJson(request);
  if (body.error) return fail(body.error);
  const name = normalizedText(body.name, 100);
  const email = normalizedText(body.email, 254).toLowerCase();
  const phone = normalizedText(body.phone, 30);
  const publicPhone = body.showPhone === true;
  const password = typeof body.password === "string" ? body.password : "";
  if (email === ADMIN_EMAIL) return fail("Use Google sign-in for the administrator account.", 403);
  if (name.length < 2 || !validEmail(email) || !validPhone(phone)) {
    return fail("Enter a dealer name, valid email address, and phone number.");
  }
  if (password.length < 12 || password.length > 128) {
    return fail("Use a password between 12 and 128 characters.");
  }
  const id = crypto.randomUUID();
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltHex = toHex(salt);
  const passwordHash = await hashPassword(password, saltHex);
  const createdAt = isoNow();
  try {
    await env.DB.prepare(
      `INSERT INTO dealers
       (id, email, name, phone, public_phone, password_salt, password_hash, password_iterations, created_at, trial_ends_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, email, name, phone, publicPhone ? 1 : 0, saltHex, passwordHash, PASSWORD_ITERATIONS, createdAt, createdAt).run();
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) return fail("An account already uses that email.", 409);
    throw error;
  }
  const session = await createSession(env, id);
  const dealer = await env.DB.prepare("SELECT * FROM dealers WHERE id = ?").bind(id).first();
  return json(
    { dealer: safeDealer(dealer) },
    201,
    { "set-cookie": sessionCookie(session.token, session.maxAge) }
  );
}

async function login(request, env) {
  const body = await readJson(request);
  if (body.error) return fail(body.error);
  const email = normalizedText(body.email, 254).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  if (email === ADMIN_EMAIL) return fail("Use Google sign-in for the administrator account.", 403);
  if (!validEmail(email) || !password) return fail("Enter your email and password.");
  const dealer = await env.DB.prepare("SELECT * FROM dealers WHERE email = ?").bind(email).first();
  if (!dealer) return fail("Email or password is incorrect.", 401);
  if (dealer.role === "admin") return fail("Use Google sign-in for the administrator account.", 403);
  const passwordHash = await hashPassword(password, dealer.password_salt, dealer.password_iterations);
  if (!constantTimeEqual(passwordHash, dealer.password_hash)) {
    return fail("Email or password is incorrect.", 401);
  }
  const session = await createSession(env, dealer.id);
  return json(
    { dealer: safeDealer(dealer) },
    200,
    { "set-cookie": sessionCookie(session.token, session.maxAge) }
  );
}

async function logout(request, env) {
  const token = cookieValue(request, "ride_sasa_session");
  if (token) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await digestToken(token)).run();
  }
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}

function googleRedirect(request, page, status, reason = "", cookies = []) {
  const destination = new URL(`/${page}`, new URL(request.url).origin);
  if (status) destination.searchParams.set("oauth", status);
  if (reason) destination.searchParams.set("reason", reason);
  const headers = new Headers({
    location: destination.toString(),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer"
  });
  (Array.isArray(cookies) ? cookies : [cookies]).filter(Boolean).forEach((cookie) => headers.append("set-cookie", cookie));
  return new Response(null, { status: 303, headers });
}

function clearOAuthStateCookie() {
  return "ride_sasa_oauth_state=; Path=/api/auth/google/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

async function consumeGoogleState(env, state) {
  const stateHash = await digestToken(state);
  const record = await env.DB.prepare(
    "SELECT nonce, code_verifier, next_page FROM oauth_states WHERE state_hash = ? AND expires_at > ?"
  ).bind(stateHash, isoNow()).first();
  if (!record) return null;
  await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(stateHash).run();
  return record;
}

async function startGoogleAuth(request, env) {
  const url = new URL(request.url);
  const nextPage = url.searchParams.get("next") === "admin.html" ? "admin.html" : "dealer.html";
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return googleRedirect(request, nextPage, "error", "google_unconfigured");
  }

  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const challenge = base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at <= ?").bind(createdAt).run();
  await env.DB.prepare(
    `INSERT INTO oauth_states (state_hash, nonce, code_verifier, next_page, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    await digestToken(state),
    nonce,
    verifier,
    nextPage,
    new Date(now + 10 * 60 * 1000).toISOString(),
    createdAt
  ).run();

  const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorization.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account"
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      location: authorization.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": `ride_sasa_oauth_state=${state}; Path=/api/auth/google/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
    }
  });
}

async function googleSigningKey(keyId, refresh = false) {
  if (refresh || !googleJwksCache || googleJwksExpiresAt <= Date.now()) {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!response.ok) throw new Error("Google signing keys could not be loaded.");
    const keySet = await response.json();
    googleJwksCache = keySet.keys || [];
    const maxAge = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1] || 3600);
    googleJwksExpiresAt = Date.now() + Math.min(maxAge, 3600) * 1000;
  }
  const key = googleJwksCache.find((candidate) => candidate.kid === keyId && candidate.use === "sig");
  if (!key && !refresh) return googleSigningKey(keyId, true);
  if (!key) throw new Error("Google signing key was not found.");
  return key;
}

async function verifyGoogleIdToken(token, expectedNonce, clientId) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Google returned an invalid identity token.");
  const header = parseJwtSegment(parts[0]);
  const claims = parseJwtSegment(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("Google used an unsupported identity token.");
  }
  const jwk = await googleSigningKey(header.kid);
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signatureValid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  const audienceMatches = claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId));
  const issuerMatches = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  const now = Math.floor(Date.now() / 1000);
  const expiration = Number(claims.exp);
  const issuedAt = Number(claims.iat);
  if (
    !signatureValid ||
    !audienceMatches ||
    !issuerMatches ||
    !Number.isFinite(expiration) ||
    expiration <= now ||
    !Number.isFinite(issuedAt) ||
    issuedAt > now + 60 ||
    claims.nonce !== expectedNonce ||
    claims.email_verified !== true ||
    !validEmail(claims.email) ||
    typeof claims.sub !== "string" ||
    claims.sub.length > 255
  ) {
    throw new Error("Google identity verification failed.");
  }
  if ((claims.azp && claims.azp !== clientId) || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId)) {
    throw new Error("Google identity audience did not match.");
  }
  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    name: normalizedText(claims.name, 100) || claims.email
  };
}

async function googleDealer(user, env) {
  const role = user.email === ADMIN_EMAIL ? "admin" : "dealer";
  let dealer = await env.DB.prepare("SELECT * FROM dealers WHERE google_sub = ?").bind(user.sub).first();
  if (dealer) {
    const conflict = await env.DB.prepare("SELECT id FROM dealers WHERE email = ? AND id != ?")
      .bind(user.email, dealer.id).first();
    if (conflict) throw new Error("That Google email is already attached to another dealer account.");
    await env.DB.prepare("UPDATE dealers SET email = ?, role = ? WHERE id = ?")
      .bind(user.email, role, dealer.id).run();
    return env.DB.prepare("SELECT * FROM dealers WHERE id = ?").bind(dealer.id).first();
  }

  dealer = await env.DB.prepare("SELECT * FROM dealers WHERE email = ?").bind(user.email).first();
  if (dealer) {
    if (dealer.google_sub && dealer.google_sub !== user.sub) {
      throw new Error("This email is already linked to a different Google account.");
    }
    await env.DB.prepare("UPDATE dealers SET google_sub = ?, role = ? WHERE id = ?")
      .bind(user.sub, role, dealer.id).run();
    return env.DB.prepare("SELECT * FROM dealers WHERE id = ?").bind(dealer.id).first();
  }

  const salt = new Uint8Array(16);
  const placeholderHash = new Uint8Array(32);
  crypto.getRandomValues(salt);
  crypto.getRandomValues(placeholderHash);
  const createdAt = isoNow();
  const dealerId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO dealers
     (id, email, name, phone, public_phone, password_salt, password_hash, password_iterations,
      created_at, trial_ends_at, google_sub, role)
     VALUES (?, ?, ?, '', 0, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    dealerId,
    user.email,
    user.name,
    toHex(salt),
    toHex(placeholderHash),
    PASSWORD_ITERATIONS,
    createdAt,
    createdAt,
    user.sub,
    role
  ).run();
  return env.DB.prepare("SELECT * FROM dealers WHERE id = ?").bind(dealerId).first();
}

async function googleCallback(request, env) {
  const url = new URL(request.url);
  const code = normalizedText(url.searchParams.get("code"), 2048);
  const state = normalizedText(url.searchParams.get("state"), 200);
  let failurePage = "dealer.html";
  if (!state || !constantTimeEqual(cookieValue(request, "ride_sasa_oauth_state"), state)) {
    return googleRedirect(request, "dealer.html", "error", "google_state", clearOAuthStateCookie());
  }
  if (url.searchParams.get("error")) {
    const stateRecord = await consumeGoogleState(env, state);
    return googleRedirect(request, stateRecord?.next_page || "dealer.html", "error", "google_cancelled", clearOAuthStateCookie());
  }
  if (!code || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    await consumeGoogleState(env, state);
    return googleRedirect(request, "dealer.html", "error", "google_unconfigured", clearOAuthStateCookie());
  }

  try {
    const stateRecord = await consumeGoogleState(env, state);
    if (!stateRecord) return googleRedirect(request, "dealer.html", "error", "google_state", clearOAuthStateCookie());
    failurePage = stateRecord.next_page;

    const redirectUri = `${url.origin}/api/auth/google/callback`;
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: stateRecord.code_verifier
      })
    });
    const tokenPayload = await tokenResponse.json();
    if (!tokenResponse.ok || typeof tokenPayload.id_token !== "string") {
      throw new Error("Google authorization could not be completed.");
    }
    const user = await verifyGoogleIdToken(tokenPayload.id_token, stateRecord.nonce, env.GOOGLE_CLIENT_ID);
    const dealer = await googleDealer(user, env);
    const session = await createSession(env, dealer.id);
    const destination = dealer.role === "admin" ? "admin.html" : stateRecord.next_page;
    return googleRedirect(
      request,
      destination,
      "success",
      "",
      [sessionCookie(session.token, session.maxAge), clearOAuthStateCookie()]
    );
  } catch (error) {
    console.error("Google OAuth callback failed:", error instanceof Error ? error.message : "unknown error");
    return googleRedirect(request, failurePage, "error", "google_failed", clearOAuthStateCookie());
  }
}

async function getDashboard(dealer, env) {
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM listings WHERE dealer_id = ? AND status = 'published'"
  ).bind(dealer.id).first();
  return dashboardData(dealer, Number(count?.count || 0));
}

async function getAdminOverview(env) {
  const [dealerCounts, listingCounts, dealerRows] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM dealers WHERE role = 'dealer'").first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM listings WHERE status = 'published'").first(),
    env.DB.prepare(
      `SELECT d.id, d.name, d.email, d.created_at AS joinedAt,
              COUNT(l.id) AS activeListings
       FROM dealers d
       LEFT JOIN listings l ON l.dealer_id = d.id AND l.status = 'published'
       WHERE d.role = 'dealer'
       GROUP BY d.id
       ORDER BY d.created_at DESC
       LIMIT 100`
    ).all()
  ]);
  return json({
    counts: {
      dealers: Number(dealerCounts?.count || 0),
      activeListings: Number(listingCounts?.count || 0)
    },
    dealers: dealerRows.results || []
  });
}

async function listPublic(request, env) {
  const url = new URL(request.url);
  const requestedIds = url.searchParams.get("ids");
  if (requestedIds !== null) {
    const ids = [...new Set(requestedIds.split(",").map((id) => id.trim()).filter(Boolean))];
    if (ids.length > 50 || ids.some((id) => !/^[a-zA-Z0-9-]{1,100}$/.test(id))) {
      return fail("Request up to 50 valid saved listing IDs at a time.");
    }
    if (!ids.length) return json({ listings: [], hasMore: false, nextCursor: null });
    const result = await readDatabase(env).prepare(
      `SELECT l.id, l.dealer_id AS dealerId, d.name AS dealerName,
              CASE WHEN d.public_phone = 1 THEN d.phone ELSE '' END AS phone, l.make, l.model, l.year,
              l.price_kes AS priceKes, l.mileage_km AS mileageKm, l.engine_cc AS engineCc,
              l.fuel, l.transmission, l.body, l.condition, l.location, l.description,
              l.image_urls_json AS imageUrls, l.created_at AS createdAt
       FROM listings l
       JOIN dealers d ON d.id = l.dealer_id
       WHERE l.status = 'published' AND l.id IN (${ids.map(() => "?").join(",")})
       ORDER BY l.created_at DESC
       LIMIT ?`
    ).bind(...ids, ids.length).all();
    return json({
      listings: (result.results || []).map((row) => ({ ...row, imageUrls: JSON.parse(row.imageUrls || "[]") })),
      hasMore: false,
      nextCursor: null
    }, 200, { "cache-control": "public, max-age=30, stale-while-revalidate=120" });
  }
  const query = normalizedText(url.searchParams.get("q"), 100).toLowerCase();
  const location = normalizedText(url.searchParams.get("location"), 60);
  const body = normalizedText(url.searchParams.get("body"), 40);
  const transmission = normalizedText(url.searchParams.get("transmission"), 40);
  const rawMaxPrice = url.searchParams.get("maxPrice") || "";
  const maxPrice = rawMaxPrice ? Number(rawMaxPrice) : 0;
  const rawYearFrom = url.searchParams.get("yearFrom") || "";
  const yearFrom = rawYearFrom ? Number(rawYearFrom) : 0;
  const sortOptions = {
    recommended: { column: "created_at", direction: "DESC" },
    "price-low": { column: "price_kes", direction: "ASC" },
    "price-high": { column: "price_kes", direction: "DESC" },
    "year-new": { column: "year", direction: "DESC" },
    "mileage-low": { column: "mileage_km", direction: "ASC" }
  };
  const sortKey = url.searchParams.get("sort") || "recommended";
  const sort = Object.prototype.hasOwnProperty.call(sortOptions, sortKey) ? sortOptions[sortKey] : null;
  if (!sort) return fail("Choose a supported listing sort order.");
  if (rawMaxPrice && (!Number.isSafeInteger(maxPrice) || maxPrice < 1)) {
    return fail("Enter a valid maximum price.");
  }
  if (rawYearFrom && (!Number.isInteger(yearFrom) || yearFrom < 1950 || yearFrom > new Date().getUTCFullYear() + 1)) {
    return fail("Enter a valid minimum vehicle year.");
  }
  const cursor = decodePageCursor(url.searchParams.get("cursor"), sortKey);
  if (cursor === undefined) return fail("The listing page cursor is invalid. Refresh your search.");
  const expression = fullTextExpression(query);
  const conditions = ["l.status = 'published'"];
  const bindings = [];
  if (expression) {
    conditions.push("listings_fts.search_text MATCH ?");
    bindings.push(expression);
  }
  if (location) {
    conditions.push("l.location = ? COLLATE NOCASE");
    bindings.push(location);
  }
  if (body) {
    conditions.push("l.body = ? COLLATE NOCASE");
    bindings.push(body);
  }
  if (transmission) {
    conditions.push("l.transmission = ? COLLATE NOCASE");
    bindings.push(transmission);
  }
  if (maxPrice) {
    conditions.push("l.price_kes <= ?");
    bindings.push(maxPrice);
  }
  if (yearFrom) {
    conditions.push("l.year >= ?");
    bindings.push(yearFrom);
  }
  const idDirection = sort.direction;
  if (cursor) {
    const comparison = sort.direction === "DESC" ? "<" : ">";
    conditions.push(
      `(l.${sort.column} ${comparison} ? OR (l.${sort.column} = ? AND l.id ${comparison} ?))`
    );
    bindings.push(cursor.value, cursor.value, cursor.id);
  }
  const joins = expression ? "JOIN listings_fts ON listings_fts.rowid = l.rowid" : "";
  const statement = readDatabase(env).prepare(
    `SELECT l.id, l.dealer_id AS dealerId, d.name AS dealerName,
            CASE WHEN d.public_phone = 1 THEN d.phone ELSE '' END AS phone, l.make, l.model, l.year,
            l.price_kes AS priceKes, l.mileage_km AS mileageKm, l.engine_cc AS engineCc,
            l.fuel, l.transmission, l.body, l.condition, l.location, l.description,
            l.image_urls_json AS imageUrls, l.created_at AS createdAt,
            l.${sort.column} AS cursorValue
     FROM listings l
     JOIN dealers d ON d.id = l.dealer_id
     ${joins}
     WHERE ${conditions.join(" AND ")}
     ORDER BY l.${sort.column} ${sort.direction}, l.id ${idDirection}
     LIMIT ?`
  ).bind(...bindings, PUBLIC_LISTING_PAGE_SIZE + 1);
  const result = await statement.all();
  const rows = result.results || [];
  const hasMore = rows.length > PUBLIC_LISTING_PAGE_SIZE;
  const page = rows.slice(0, PUBLIC_LISTING_PAGE_SIZE);
  const last = page[page.length - 1];
  const listings = page.map(({ cursorValue, ...row }) => ({
    ...row,
    imageUrls: JSON.parse(row.imageUrls || "[]")
  }));
  return json({
    listings,
    hasMore,
    nextCursor: hasMore && last ? encodePageCursor(sortKey, last.cursorValue, last.id) : null
  }, 200, { "cache-control": "public, max-age=30, stale-while-revalidate=120" });
}

async function listDealerListings(request, dealer, env) {
  const cursor = decodePageCursor(new URL(request.url).searchParams.get("cursor"), "dealer-newest");
  if (cursor === undefined) return fail("The inventory page cursor is invalid. Refresh your inventory.");
  const cursorClause = cursor
    ? "AND (created_at < ? OR (created_at = ? AND id < ?))"
    : "";
  const bindings = cursor
    ? [dealer.id, cursor.value, cursor.value, cursor.id, DEALER_LISTING_PAGE_SIZE + 1]
    : [dealer.id, DEALER_LISTING_PAGE_SIZE + 1];
  const result = await env.DB.prepare(
    `SELECT id, make, model, year, price_kes AS priceKes, mileage_km AS mileageKm,
            engine_cc AS engineCc, fuel, transmission, body, condition, location,
            description, image_urls_json AS imageUrls, status, created_at AS createdAt,
            updated_at AS updatedAt
     FROM listings WHERE dealer_id = ? ${cursorClause}
     ORDER BY created_at DESC, id DESC LIMIT ?`
  ).bind(...bindings).all();
  const rows = result.results || [];
  const hasMore = rows.length > DEALER_LISTING_PAGE_SIZE;
  const page = rows.slice(0, DEALER_LISTING_PAGE_SIZE);
  const last = page[page.length - 1];
  return json({
    listings: page.map((row) => ({ ...row, imageUrls: JSON.parse(row.imageUrls || "[]") })),
    hasMore,
    nextCursor: hasMore && last ? encodePageCursor("dealer-newest", last.createdAt, last.id) : null
  });
}

async function createListing(request, dealer, env) {
  const body = await readJson(request);
  if (body.error) return fail(body.error);
  const normalized = normalizeListing(body);
  if (normalized.error) return fail(normalized.error);
  const value = normalized.value;
  const id = crypto.randomUUID();
  const now = isoNow();
  await env.DB.prepare(
    `INSERT INTO listings
     (id, dealer_id, make, model, year, price_kes, mileage_km, engine_cc, fuel, transmission,
      body, condition, location, description, image_urls_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)`
  ).bind(
    id, dealer.id, value.make, value.model, value.year, value.price, value.mileage, value.engine,
    value.fuel, value.transmission, value.bodyType, value.condition, value.location,
    value.description, JSON.stringify(value.imageUrls), now, now
  ).run();
  return json({ id }, 201);
}

async function updateListing(request, dealer, env, listingId) {
  const body = await readJson(request);
  if (body.error) return fail(body.error);
  const normalized = normalizeListing(body);
  if (normalized.error) return fail(normalized.error);
  const value = normalized.value;
  const result = await env.DB.prepare(
    `UPDATE listings SET make = ?, model = ?, year = ?, price_kes = ?, mileage_km = ?, engine_cc = ?,
       fuel = ?, transmission = ?, body = ?, condition = ?, location = ?, description = ?,
       image_urls_json = ?, updated_at = ?
     WHERE id = ? AND dealer_id = ? AND status = 'published'`
  ).bind(
    value.make, value.model, value.year, value.price, value.mileage, value.engine, value.fuel,
    value.transmission, value.bodyType, value.condition, value.location, value.description,
    JSON.stringify(value.imageUrls), isoNow(), listingId, dealer.id
  ).run();
  if (!result.meta?.changes) return fail("Listing not found.", 404);
  return json({ ok: true });
}

async function updateDealerProfile(request, dealer, env) {
  const body = await readJson(request);
  if (body.error) return fail(body.error);
  const name = normalizedText(body.name, 100);
  const phone = normalizedText(body.phone, 30);
  const publicPhone = body.showPhone === true;
  if (name.length < 2) return fail("Enter a dealer or business name.");
  if (phone && !validPhone(phone)) return fail("Enter a valid phone number or leave it blank.");
  if (publicPhone && !phone) return fail("Add a phone number before showing it on public listings.");
  await env.DB.prepare("UPDATE dealers SET name = ?, phone = ?, public_phone = ? WHERE id = ?")
    .bind(name, phone, publicPhone ? 1 : 0, dealer.id).run();
  const updated = await env.DB.prepare("SELECT * FROM dealers WHERE id = ?").bind(dealer.id).first();
  return json({ dealer: safeDealer(updated) });
}

async function archiveListing(dealer, env, listingId) {
  const result = await env.DB.prepare(
    "UPDATE listings SET status = 'archived', updated_at = ? WHERE id = ? AND dealer_id = ? AND status = 'published'"
  ).bind(isoNow(), listingId, dealer.id).run();
  if (!result.meta?.changes) return fail("Listing not found.", 404);
  return json({ ok: true });
}

function securityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (method === "GET" && path === "/api/health") {
    const databaseConfigured = Boolean(env.DB);
    const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
    const ok = databaseConfigured && googleConfigured;
    return json({ ok, databaseConfigured, googleConfigured }, ok ? 200 : 503);
  }
  const dbError = requireDatabase(env);
  if (dbError) return dbError;
  if (method === "POST" && path.startsWith("/api/")) {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return fail("Cross-origin requests are not allowed.", 403);
  }

  if (method === "GET" && path === "/api/listings") return listPublic(request, env);
  if (method === "GET" && path === "/api/auth/google/start") return startGoogleAuth(request, env);
  if (method === "GET" && path === "/api/auth/google/callback") return googleCallback(request, env);
  if (method === "POST" && path === "/api/auth/register") return register(request, env);
  if (method === "POST" && path === "/api/auth/login") return login(request, env);
  if (method === "POST" && path === "/api/auth/logout") return logout(request, env);
  const dealer = await currentDealer(request, env);
  if (!dealer && (
    path.startsWith("/api/dealer/") ||
    path.startsWith("/api/admin/") ||
    path === "/api/me"
  )) {
    return fail("Sign in to your dealer account.", 401);
  }
  if (path.startsWith("/api/admin/") && dealer.role !== "admin") {
    return fail("Administrator access is required.", 403);
  }
  if (method === "GET" && path === "/api/me") {
    return dealer ? json(await getDashboard(dealer, env)) : fail("Not signed in.", 401);
  }
  if (method === "GET" && path === "/api/admin/overview") return getAdminOverview(env);
  if (path === "/api/dealer/profile" && method === "PATCH") return updateDealerProfile(request, dealer, env);
  if (path === "/api/dealer/listings" && method === "GET") return listDealerListings(request, dealer, env);
  if (path === "/api/dealer/listings" && method === "POST") return createListing(request, dealer, env);

  const listingMatch = path.match(/^\/api\/dealer\/listings\/([0-9a-f-]{36})(?:\/(archive))?$/i);
  if (listingMatch && method === "PATCH" && !listingMatch[2]) {
    return updateListing(request, dealer, env, listingMatch[1]);
  }
  if (listingMatch && method === "POST" && listingMatch[2] === "archive") {
    return archiveListing(dealer, env, listingMatch[1]);
  }
  return fail("API route not found.", 404);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        return securityHeaders(await handleApi(request, env));
      }
      if (["/worker.js", "/wrangler.toml", "/migrations/0001_init.sql"].includes(url.pathname)) {
        return new Response("Not found", { status: 404 });
      }
      const assets = env.ASSETS ? await env.ASSETS.fetch(request) : new Response("Static assets are not configured.", { status: 503 });
      return securityHeaders(assets);
    } catch (error) {
      console.error("Ride Sasa request failed", error);
      return json({ error: "The request could not be completed. Please try again." }, 500);
    }
  }
};
