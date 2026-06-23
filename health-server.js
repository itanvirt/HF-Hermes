"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");
const nodePath = require("path");

const filesLib = require("./lib/files");
const logsLib = require("./lib/logs");
const systemLib = require("./lib/system");

const PORT = Number(process.env.PORT || 7861);
const GATEWAY_PORT = Number(process.env.API_SERVER_PORT || 8642);
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 9119);
const TELEGRAM_WEBHOOK_PORT = Number(process.env.TELEGRAM_WEBHOOK_PORT || 8765);
const JUPYTER_PORT = 8888;
const GATEWAY_HOST = "127.0.0.1";
const TERMINAL_BASE = "/terminal";
const startTime = Date.now();
const API_SERVER_KEY = process.env.API_SERVER_KEY || "";
const APP_BASE = "/app";
const LOGIN_PATH = "/login";
const SESSION_COOKIE = "huggingmes_session";

// ── Private Space redirect support ──
const SPACE_ID = (process.env.SPACE_ID || "").trim();
function deriveHfSpaceUrl() {
  if (SPACE_ID) return `https://huggingface.co/spaces/${SPACE_ID}`;
  const host = (process.env.SPACE_HOST || "").replace(/\.hf\.space$/i, "");
  const author = (process.env.SPACE_AUTHOR_NAME || "").trim().toLowerCase();
  if (author && host.toLowerCase().startsWith(author + "-")) {
    const spaceName = host.slice(author.length + 1);
    return `https://huggingface.co/spaces/${process.env.SPACE_AUTHOR_NAME}/${spaceName}`;
  }
  return "";
}
const HF_SPACE_URL = deriveHfSpaceUrl();

// Privacy detection priority:
//   1. SPACE_PRIVACY env var ("public"/"private") — explicit override, skip API call
//   2. HF API auto-detect with retry
//   3. Fail-secure: treat as private if SPACE_ID set
const _spacPrivacyEnv = (process.env.SPACE_PRIVACY || "").trim().toLowerCase();
let SPACE_IS_PRIVATE;
let _privacyDetectionDone = false;
let _privacyDetectionResolve;
const privacyDetectionReady = new Promise((res) => { _privacyDetectionResolve = res; });

if (_spacPrivacyEnv === "public") {
  SPACE_IS_PRIVATE = false;
  _privacyDetectionDone = true;
  console.log("[health-server] Space privacy: public (SPACE_PRIVACY env override)");
  _privacyDetectionResolve();
} else if (_spacPrivacyEnv === "private") {
  SPACE_IS_PRIVATE = true;
  _privacyDetectionDone = true;
  console.log("[health-server] Space privacy: private (SPACE_PRIVACY env override)");
  _privacyDetectionResolve();
} else {
  // Fail-secure default until API call resolves
  SPACE_IS_PRIVATE = !!SPACE_ID;
}

async function detectSpacePrivacy() {
  if (_spacPrivacyEnv === "public" || _spacPrivacyEnv === "private") return;
  if (!SPACE_ID) {
    SPACE_IS_PRIVATE = false;
    _privacyDetectionDone = true;
    _privacyDetectionResolve();
    return;
  }
  const token = (process.env.HF_TOKEN || "").trim();
  const reqOptions = {
    hostname: "huggingface.co",
    path: `/api/spaces/${SPACE_ID}`,
    method: "GET",
    headers: Object.assign(
      { "User-Agent": "HuggingMes/health-server" },
      token ? { Authorization: `Bearer ${token}` } : {}
    ),
  };
  const MAX_ATTEMPTS = 5;
  let detected = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await new Promise((resolve) => {
        const r = https.request(reqOptions, (apiRes) => {
          let body = "";
          apiRes.on("data", (chunk) => { body += chunk; });
          apiRes.on("end", () => {
            try {
              if (apiRes.statusCode === 200) {
                SPACE_IS_PRIVATE = JSON.parse(body).private === true;
                resolve({ ok: true });
              } else if (apiRes.statusCode === 401 || apiRes.statusCode === 403) {
                SPACE_IS_PRIVATE = true;
                resolve({ ok: true });
              } else {
                resolve({ ok: false });
              }
            } catch { resolve({ ok: false }); }
          });
        });
        r.on("error", () => resolve({ ok: false }));
        r.setTimeout(8000, () => { r.destroy(); resolve({ ok: false }); });
        r.end();
      });
      console.log(`[health-server] Privacy detection attempt ${attempt}/${MAX_ATTEMPTS}: ok=${result.ok}`);
      if (result.ok) { detected = true; break; }
    } catch {}
    const delay = Math.min(2000 * attempt, 10000);
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, delay));
  }
  if (!detected) {
    console.warn(`[health-server] Privacy detection failed after ${MAX_ATTEMPTS} attempts — defaulting to ${SPACE_IS_PRIVATE ? "private" : "public"}. TIP: Set SPACE_PRIVACY=public in Space secrets to skip API detection.`);
  } else {
    console.log(`[health-server] Space privacy detected: ${SPACE_IS_PRIVATE ? "private" : "public"}`);
  }
  _privacyDetectionDone = true;
  _privacyDetectionResolve();
}

if (_spacPrivacyEnv !== "public" && _spacPrivacyEnv !== "private") {
  detectSpacePrivacy();
  setInterval(detectSpacePrivacy, 5 * 60 * 1000);
}

const SYNC_STATUS_FILE = "/tmp/huggingmes-sync-status.json";
const CLOUDFLARE_KEEPALIVE_STATUS_FILE =
  "/tmp/huggingmes-cloudflare-keepalive-status.json";
const HERMES_HOME = nodePath.resolve(process.env.HERMES_HOME || "/opt/data");

function canConnect(port, host = GATEWAY_HOST, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function readJson(path, fallback = null) {
  try {
    if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {}
  return fallback;
}

function timingSafeEqualString(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function expectedSessionValue() {
  if (!API_SERVER_KEY) return "";
  return crypto
    .createHmac("sha256", API_SERVER_KEY)
    .update("huggingmes-session-v1")
    .digest("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function isHttpsRequest(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function buildSessionCookie(req) {
  const secure = isHttpsRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(expectedSessionValue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`;
}

function getBearerToken(req) {
  const value = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1] : "";
}

function isAuthorized(req) {
  if (!API_SERVER_KEY) return true;
  return (
    timingSafeEqualString(getBearerToken(req), API_SERVER_KEY) ||
    timingSafeEqualString(
      parseCookies(req)[SESSION_COOKIE],
      expectedSessionValue(),
    )
  );
}

function sanitizeNext(value) {
  if (!value || typeof value !== "string") return `${APP_BASE}/`;
  if (!value.startsWith("/") || value.startsWith("//")) return `${APP_BASE}/`;
  return value;
}

function loginUrl(nextPath) {
  return `${LOGIN_PATH}?next=${encodeURIComponent(sanitizeNext(nextPath))}`;
}

function renderLoginPage(nextPath, errorMessage = "") {
  const safeNext = sanitizeNext(nextPath);
  return `<!doctype html><html lang="en"><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>HuggingMes</title>
  <style>
    :root{color-scheme:dark;--bg:#08080f;--panel:#12111b;--line:#26243a;--text:#f6f4ff;--muted:#7f7a9e;--bad:#fb7185}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);padding:24px}
    .card{border:1px solid var(--line);background:var(--panel);border-radius:14px;padding:36px 32px;max-width:400px;width:100%;text-align:center}
    h1{margin:0 0 8px;font-size:1.4rem}
    .sub{color:var(--muted);font-size:.82rem;margin:0 0 24px}
    .row{display:flex;gap:8px;margin-top:16px}
    input{flex:1;background:#0d0c18;border:1px solid var(--line);border-radius:7px;padding:10px 12px;color:var(--text);font-size:.95rem;outline:none;transition:border-color .15s}
    input:focus{border-color:#6366f1}
    button{background:#fff;color:#000;border:none;border-radius:7px;padding:10px 20px;font-weight:700;font-size:.95rem;cursor:pointer;transition:opacity .15s;white-space:nowrap}
    button:hover{opacity:.85}
    .err{color:var(--bad);font-size:.82rem;margin-top:10px}
    code{background:#232234;border:1px solid #34324c;border-radius:5px;padding:2px 6px;font-size:.88em}
  </style></head><body>
  <div class="card">
    <h1>🪽 HuggingMes</h1>
    <p class="sub">Enter your <code>GATEWAY_TOKEN</code> to continue</p>
    <form method="post" action="${LOGIN_PATH}">
      <input type="hidden" name="next" value="${escapeHtml(safeNext)}" />
      <div class="row">
        <input type="password" name="token" placeholder="GATEWAY_TOKEN" autofocus autocomplete="current-password" required>
        <button type="submit">Unlock</button>
      </div>
      ${errorMessage ? `<p class="err">Invalid token — try again</p>` : ""}
    </form>
  </div>
</body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readRequestBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return true;
  const parsed = new URL(req.url, "http://localhost");
  redirect(res, loginUrl(`${parsed.pathname}${parsed.search}`));
  return false;
}

// Same gate as requireAuth, but for the hm-api/* JSON endpoints — a 401
// body instead of a login-page redirect, since these are fetch() calls.
function requireApiAuth(req, res) {
  if (isAuthorized(req)) return true;
  res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: "unauthorized" }));
  return false;
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/html");
}

async function handleLogin(req, res, parsed) {
  const nextPath = sanitizeNext(
    parsed.searchParams.get("next") || `${APP_BASE}/`,
  );

  if (!API_SERVER_KEY) {
    redirect(res, nextPath);
    return;
  }

  if (req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(renderLoginPage(nextPath));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" });
    res.end("Method not allowed");
    return;
  }

  try {
    const body = await readRequestBody(req);
    const params = new URLSearchParams(body);
    const submittedToken = params.get("token") || "";
    const submittedNext = sanitizeNext(params.get("next") || nextPath);

    if (!timingSafeEqualString(submittedToken, API_SERVER_KEY)) {
      res.writeHead(401, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(
        renderLoginPage(
          submittedNext,
          "That token did not match GATEWAY_TOKEN.",
        ),
      );
      return;
    }

    res.writeHead(302, {
      location: submittedNext,
      "set-cookie": buildSessionCookie(req),
      "cache-control": "no-store",
    });
    res.end();
  } catch (error) {
    res.writeHead(400, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(error.message || "Invalid login request.");
  }
}

function proxyRequest(
  req,
  res,
  targetPort,
  rewritePath = (path) => path,
  headerOverrides = {},
) {
  const parsed = new URL(req.url, "http://localhost");
  const targetPath = rewritePath(parsed.pathname) + parsed.search;
  const headers = {
    ...req.headers,
    ...headerOverrides,
    host: `${GATEWAY_HOST}:${targetPort}`,
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-proto": req.headers["x-forwarded-proto"] || "https",
  };

  const proxy = http.request(
    {
      hostname: GATEWAY_HOST,
      port: targetPort,
      method: req.method,
      path: targetPath,
      headers,
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    },
  );

  proxy.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
  });

  req.pipe(proxy);
}

function redirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, { location });
  res.end();
}

function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function statusPayload() {
  const gateway = await canConnect(GATEWAY_PORT);
  const dashboard = await canConnect(DASHBOARD_PORT);
  const telegramWebhook =
    !!process.env.TELEGRAM_WEBHOOK_URL &&
    (await canConnect(TELEGRAM_WEBHOOK_PORT));
  const sync = readJson(
    SYNC_STATUS_FILE,
    process.env.HF_TOKEN
      ? {
          status: "configured",
          message: "Backup is enabled; waiting for the first sync.",
        }
      : { status: "disabled", message: "HF_TOKEN is not configured." },
  );

  return {
    ok: gateway,
    uptime: formatUptime(Date.now() - startTime),
    startedAt: new Date(startTime).toISOString(),
    gateway,
    dashboard,
    authConfigured: !!API_SERVER_KEY,
    ports: {
      public: PORT,
      gateway: GATEWAY_PORT,
      dashboard: DASHBOARD_PORT,
      telegramWebhook: TELEGRAM_WEBHOOK_PORT,
    },
    telegram: {
      configured: !!process.env.TELEGRAM_BOT_TOKEN,
      webhook: !!process.env.TELEGRAM_WEBHOOK_URL,
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || "",
      webhookListening: telegramWebhook,
      proxy: process.env.CLOUDFLARE_PROXY_URL || "",
    },
    model:
      process.env.MODEL_FOR_CONFIG ||
      process.env.HERMES_MODEL ||
      process.env.LLM_MODEL ||
      "",
    provider:
      process.env.PROVIDER_FOR_CONFIG ||
      process.env.HERMES_INFERENCE_PROVIDER ||
      "auto",
    backup: sync,
    keepalive: readJson(CLOUDFLARE_KEEPALIVE_STATUS_FILE, null),
  };
}

function renderPrivateRedirect(targetUrl) {
  const safeUrl = escapeHtml(targetUrl);
  return `<!doctype html><html lang="en"><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta http-equiv="refresh" content="3;url=${safeUrl}"/>
  <title>HuggingMes — Private Space</title>
  <style>
    :root{color-scheme:dark}
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
         font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;
         background:#08080f;color:#f6f4ff;text-align:center;padding:24px}
    .card{border:1px solid #26243a;background:#12111b;border-radius:14px;padding:36px 32px;max-width:440px}
    h1{margin:0 0 12px;font-size:1.5rem}
    p{color:#b8b3d7;line-height:1.6;margin:0 0 24px}
    .btn{display:inline-flex;align-items:center;justify-content:center;
         background:#fff;color:#000;font-weight:850;font-size:.95rem;
         border-radius:8px;padding:12px 28px;text-decoration:none;transition:opacity .15s}
    .btn:hover{opacity:.85}
    .sub{color:#7f7a9e;font-size:.78rem;margin-top:16px}
  </style></head><body>
  <div class="card">
    <h1>🔒 Private Space</h1>
    <p>This HuggingFace Space is private. You need to be logged in to <strong>huggingface.co</strong> to access it.<br><br>Redirecting you now&hellip;</p>
    <a class="btn" href="${safeUrl}">Open on Hugging Face →</a>
    <div class="sub">Redirecting in 3 seconds&hellip;</div>
  </div>
  <script>
    // Only auto-redirect when NOT inside an iframe — navigating an iframe to
    // huggingface.co is blocked by X-Frame-Options and causes "refused to connect".
    const _inFrame = (() => { try { return window.top !== window.self; } catch { return true; } })();
    if (!_inFrame) {
      setTimeout(() => { window.location.replace(${JSON.stringify(targetUrl)}); }, 100);
    }
  </script>
</body></html>`;
}

function badge(label, state) {
  return `<span class="badge ${state ? "ok" : "off"}">${escapeHtml(label)}</span>`;
}

function toneBadge(label, tone = "neutral") {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function valueOrUnset(value, fallback = "Not set") {
  return value
    ? escapeHtml(value)
    : `<span class="muted">${escapeHtml(fallback)}</span>`;
}

function renderTile({
  title,
  value,
  detail = "",
  tone = "neutral",
  meta = "",
}) {
  return `<article class="tile ${tone}">
    <div class="tile-head">
      <span class="tile-title">${escapeHtml(title)}</span>
      <span class="tile-dot"></span>
    </div>
    <div class="tile-value">${value}</div>
    ${detail ? `<div class="tile-detail">${detail}</div>` : ""}
    ${meta ? `<div class="tile-meta">${meta}</div>` : ""}
  </article>`;
}

function renderDashboard(data) {
  const syncStatus = String(data.backup?.status || "unknown");
  const syncTone = ["success", "restored", "synced", "configured"].includes(
    syncStatus,
  )
    ? "ok"
    : syncStatus === "disabled"
      ? "warn"
      : "neutral";
  const telegramTone = data.telegram.configured
    ? data.telegram.webhookListening || !data.telegram.webhook
      ? "ok"
      : "warn"
    : "warn";
  const keepaliveConfigured = data.keepalive?.configured === true;
  const keepaliveStatus = String(
    data.keepalive?.status ||
      (process.env.CLOUDFLARE_WORKERS_TOKEN ? "pending" : "not configured"),
  );
  const keepAliveTone = keepaliveConfigured
    ? "ok"
    : process.env.CLOUDFLARE_WORKERS_TOKEN
      ? "warn"
      : "neutral";
  const telegramDetail = data.telegram.configured
    ? `${data.telegram.webhook ? "Webhook" : "Polling"}${data.telegram.proxy ? " via CF proxy" : ""}`
    : "Not configured";
  const backupDetail = data.backup?.message
    ? escapeHtml(data.backup.message)
    : "No status yet";
  const keepAliveDetail = keepaliveConfigured
    ? `Pinging <code>${escapeHtml(data.keepalive.targetUrl || "/health")}</code>`
    : keepaliveStatus === "error" && data.keepalive?.message
      ? escapeHtml(data.keepalive.message)
      : process.env.CLOUDFLARE_WORKERS_TOKEN
        ? "Worker pending or failed"
        : "Not configured";
  const serviceOk = data.gateway && data.dashboard;

  const tiles = [
    renderTile({
      title: "Gateway",
      value: toneBadge(
        data.gateway ? "Online" : "Offline",
        data.gateway ? "ok" : "off",
      ),
      detail: data.gateway
        ? `API on port ${data.ports.gateway}`
        : `Unreachable`,
      tone: data.gateway ? "ok" : "off",
      meta: data.authConfigured ? "Protected" : "Unprotected",
    }),
    renderTile({
      title: "Model",
      value: `<code>${valueOrUnset(data.model)}</code>`,
      detail: `Provider: ${valueOrUnset(data.provider || "auto")}`,
      tone: data.model ? "ok" : "warn",
    }),
    renderTile({
      title: "Runtime",
      value: escapeHtml(data.uptime),
      detail: `Port ${data.ports.public}`,
      tone: "neutral",
    }),
    renderTile({
      title: "Telegram",
      value: toneBadge(
        data.telegram.configured ? "Configured" : "Disabled",
        telegramTone,
      ),
      detail: telegramDetail,
      tone: telegramTone,
    }),
    renderTile({
      title: "Backup",
      value: toneBadge(syncStatus.toUpperCase(), syncTone),
      detail: backupDetail,
      tone: syncTone,
      meta: data.backup?.timestamp
        ? `<span class="local-time" data-iso="${data.backup.timestamp}"></span>`
        : "",
    }),
    renderTile({
      title: "Keep Awake",
      value: toneBadge(
        keepaliveConfigured ? "CF Cron" : keepaliveStatus.toUpperCase(),
        keepAliveTone,
      ),
      detail: keepAliveDetail,
      tone: keepAliveTone,
    }),
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HuggingMes</title>
  <style>
    :root { color-scheme: dark; --bg:#08080f; --panel:#12111b; --panel2:#151421; --line:#26243a; --text:#f6f4ff; --muted:#7f7a9e; --soft:#b8b3d7; --good:#22c55e; --warn:#f5c542; --bad:#fb7185; --accent:#6557df; --accent2:#7c6cf2; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); font-size:13px; }
    main { width:min(720px, calc(100% - 32px)); margin:0 auto; padding:36px 0 44px; }
    header { text-align:center; margin-bottom:22px; }
    h1 { margin:0; font-size:1.65rem; line-height:1; letter-spacing:0; }
    .subtitle { margin-top:12px; color:var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.14em; font-weight:800; }
    .hero-buttons { display:flex; gap:10px; margin:24px 0 20px; }
    .hero-action { display:flex; flex:1; min-height:46px; align-items:center; justify-content:center; border-radius:8px; background:#ffffff; color:#000000; text-decoration:none; font-weight:850; font-size:.98rem; transition:background 0.15s ease; }
    .hero-action:hover { background:#e5e5e5; }
    .hero-action.secondary { background:var(--panel); color:var(--text); border:1px solid var(--line); }
    .hero-action.secondary:hover { background:var(--panel2); }
    .overview { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; margin-bottom:10px; }
    .tile { border:1px solid var(--line); background:var(--panel); border-radius:11px; padding:18px; min-height:124px; display:flex; flex-direction:column; gap:10px; position:relative; }
    .tile.ok { border-color:rgba(34,197,94,.22); }
    .tile.warn { border-color:rgba(245,197,66,.24); }
    .tile.off { border-color:rgba(251,113,133,.28); }
    .tile-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .tile-title { color:var(--muted); font-size:.67rem; letter-spacing:.18em; text-transform:uppercase; font-weight:850; }
    .tile-dot { width:7px; height:7px; border-radius:50%; background:var(--line); }
    .tile.ok .tile-dot { background:var(--good); }
    .tile.warn .tile-dot { background:var(--warn); }
    .tile.off .tile-dot { background:var(--bad); }
    .tile-value { font-size:1.12rem; font-weight:850; overflow-wrap:anywhere; }
    .tile-detail { color:var(--soft); line-height:1.45; font-size:.83rem; }
    .tile-meta { color:var(--muted); line-height:1.4; font-size:.75rem; margin-top:auto; overflow-wrap:anywhere; }

    code { background:#232234; border:1px solid #34324c; border-radius:6px; padding:2px 6px; color:var(--text); font-size:.9em; }
    pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; background:#0d0d0d; border:1px solid var(--line); border-radius:7px; padding:10px; color:var(--soft); font-size:.82rem; line-height:1.45; }
    .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    .badge { display:inline-flex; align-items:center; width:max-content; border:1px solid var(--line); border-radius:999px; padding:5px 10px; font-size:.72rem; font-weight:850; line-height:1; text-transform:uppercase; }
    .badge.ok { color:var(--good); border-color:rgba(34,197,94,.34); background:rgba(34,197,94,.11); }
    .badge.warn { color:var(--warn); border-color:rgba(245,197,66,.34); background:rgba(245,197,66,.11); }
    .badge.off { color:var(--bad); border-color:rgba(251,113,133,.34); background:rgba(251,113,133,.11); }
    .badge.neutral { color:var(--soft); }
    .muted { color:var(--muted); }
    .button { display:inline-flex; align-items:center; justify-content:center; min-height:40px; padding:0 16px; border-radius:8px; color:#fff; background:var(--accent); text-decoration:none; font-weight:850; font-size:.9rem; }
    .button.secondary { color:var(--text); background:#242424; border:1px solid var(--line); }
    footer { color:var(--muted); text-align:center; font-size:.74rem; margin-top:18px; }
    footer .live { color:var(--good); }
    .warn-banner { background:rgba(245,197,66,.1); border:1px solid rgba(245,197,66,.35); border-radius:8px; padding:10px 14px; margin-bottom:16px; color:var(--warn); font-size:.82rem; line-height:1.5; }
    .warn-banner strong { font-weight:700; }
    .admin-links { display:flex; gap:8px; margin-bottom:20px; }
    .admin-links a { flex:1; display:flex; align-items:center; justify-content:center; min-height:38px; border-radius:8px; background:var(--panel); border:1px solid var(--line); color:var(--soft); text-decoration:none; font-size:.82rem; font-weight:700; }
    .admin-links a:hover { background:var(--panel2); color:var(--text); }
    @media (max-width: 700px) { .overview { grid-template-columns:1fr; } main { width:min(100% - 22px, 720px); padding-top:28px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>HuggingMes</h1>
      <div class="subtitle">Self-hosted - Hermes Agent</div>
    </header>
    <div class="hero-buttons">
      <a class="hero-action" data-space-link="app" href="${APP_BASE}/">Open Hermes Agent →</a>
      <a class="hero-action secondary" data-space-link="terminal" href="/terminal/">💻 Open Terminal →</a>
      <a class="hero-action secondary" data-space-link="env-builder" href="/env-builder">⚙️ ENV Builder →</a>
    </div>
    <div class="admin-links">
      <a data-space-link="files" href="/files">📁 Files</a>
      <a data-space-link="host-logs" href="/host-logs">🪵 Host Logs</a>
      <a data-space-link="system" href="/system">📊 System</a>
    </div>
    ${syncStatus === "disabled" ? `<div class="warn-banner">⚠️ <strong>Backup is disabled.</strong> HF Spaces storage is ephemeral — all Hermes data (chats, config, memory) will be lost on every Space restart. Set <code>HF_TOKEN</code> in Space secrets to enable automatic backup.</div>` : ""}
    <section class="overview">
      ${tiles}
    </section>
    <footer>Built by <a href="https://github.com/somratpro" target="_blank" rel="noopener noreferrer" style="color: var(--accent); text-decoration: none;">@somratpro</a></footer>
  </main>
  <script>
    document.querySelectorAll('.local-time').forEach(el => {
      const date = new Date(el.getAttribute('data-iso'));
      if (!isNaN(date)) {
        el.textContent = 'At ' + date.toLocaleTimeString();
      }
    });
    const inEmbeddedApp = (() => { try { return window.top !== window.self; } catch { return true; } })();
    const isDirectHfSpaceHost = /\.hf\.space$/i.test(window.location.hostname);
    const HF_SPACE_URL = ${JSON.stringify(HF_SPACE_URL)};
    // Server-side value may be stale if privacy detection raced — syncPrivacy() corrects it.
    let SPACE_IS_PRIVATE = ${JSON.stringify(SPACE_IS_PRIVATE)};

    function applyLinkTargets() {
      const openInNewTab = !SPACE_IS_PRIVATE && (inEmbeddedApp || isDirectHfSpaceHost);
      document.querySelectorAll('a[data-space-link]').forEach((a) => {
        if (openInNewTab) {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        } else {
          a.removeAttribute('target');
          a.removeAttribute('rel');
        }
      });
    }
    applyLinkTargets();

    function syncPrivacy() {
      return fetch('/api/is-private', { cache: 'no-store' })
        .then(r => r.json())
        .then(d => {
          if (d.isPrivate !== SPACE_IS_PRIVATE) {
            SPACE_IS_PRIVATE = d.isPrivate;
            applyLinkTargets();
          }
          return d.isPrivate;
        })
        .catch(() => SPACE_IS_PRIVATE);
    }

    if (isDirectHfSpaceHost) {
      syncPrivacy().then(isPrivate => {
        if (isPrivate) {
          setTimeout(syncPrivacy, 8000);
          setTimeout(syncPrivacy, 16000);
        }
      });
    }

    // Private redirect — only when NOT in iframe (huggingface.co has X-Frame-Options: DENY)
    if (SPACE_IS_PRIVATE && isDirectHfSpaceHost && !inEmbeddedApp && HF_SPACE_URL) {
      const notice = document.createElement('div');
      notice.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#08080f;color:#f6f4ff;font-family:sans-serif;flex-direction:column;gap:16px;z-index:9999';
      notice.innerHTML = '<span style="font-size:1.1rem">🔒 Private Space &mdash; Redirecting&hellip;</span><a href="' + HF_SPACE_URL + '" style="color:#a5b4fc;font-size:.85rem">Click here if not redirected</a>';
      document.body.appendChild(notice);
      setTimeout(() => { window.location.replace(HF_SPACE_URL); }, 300);
    }
  </script>
</body>
</html>`;
}

// ── New dashboard pages' JSON backend: files browser, host logs, system info,
// gateway start/stop/restart, and the active-model switcher. Namespaced under
// /hm-api/ so it can never collide with the Hermes dashboard's own /api/* routes,
// which health-server.js proxies straight through to DASHBOARD_PORT.
async function handleHmApi(req, res, pathname, parsedUrl) {
  if (pathname === "/hm-api/files/list" && req.method === "GET") {
    return sendJson(res, 200, filesLib.listDir(parsedUrl.searchParams.get("path") || "/"));
  }
  if (pathname === "/hm-api/files/mkdir" && req.method === "POST") {
    const body = JSON.parse((await readRequestBody(req)) || "{}");
    filesLib.mkdir(body.path || "/", body.name || "");
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === "/hm-api/files/upload" && req.method === "POST") {
    const result = await filesLib.uploadFile(
      parsedUrl.searchParams.get("path") || "/",
      parsedUrl.searchParams.get("name") || "",
      req,
    );
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (pathname === "/hm-api/files/download" && req.method === "GET") {
    const { absPath, size, name } = filesLib.statForDownload(parsedUrl.searchParams.get("path") || "");
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": size,
      "content-disposition": `attachment; filename="${name.replace(/[\\"]/g, "")}"`,
    });
    fs.createReadStream(absPath).pipe(res);
    return;
  }

  if (pathname === "/hm-api/logs" && req.method === "GET") {
    return sendJson(
      res,
      200,
      logsLib.tail(parsedUrl.searchParams.get("file") || "gateway", parsedUrl.searchParams.get("lines") || "200"),
    );
  }

  if (pathname === "/hm-api/system" && req.method === "GET") {
    return sendJson(res, 200, systemLib.hostInfo(startTime));
  }

  const gatewayMatch = /^\/hm-api\/gateway\/(start|stop|restart)$/.exec(pathname);
  if (gatewayMatch && req.method === "POST") {
    return sendJson(res, 200, systemLib.gatewayAction(gatewayMatch[1]));
  }

  if (pathname === "/hm-api/model" && req.method === "GET") {
    return sendJson(res, 200, systemLib.readModel());
  }
  if (pathname === "/hm-api/model" && req.method === "POST") {
    const body = JSON.parse((await readRequestBody(req)) || "{}");
    systemLib.writeModel({ model: body.model, provider: body.provider, apiKey: body.apiKey });
    systemLib.gatewayAction("restart");
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const path = parsed.pathname;

  // Lightweight endpoint for client-side privacy fallback.
  // Called by dashboard JS to correct stale server-rendered SPACE_IS_PRIVATE value.
  // No auth required — not sensitive.
  if (path === "/api/is-private") {
    if (!_privacyDetectionDone) await privacyDetectionReady;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ isPrivate: SPACE_IS_PRIVATE }));
  }

  if (path === LOGIN_PATH) {
    await handleLogin(req, res, parsed);
    return;
  }

  // ── Private Space Guard (server-side) ──
  // Intercepts browser HTML requests from raw .hf.space hosts when the Space is private.
  // /health and /status are always exempt so uptime monitors keep working.
  const isHtmlReq = (req.headers.accept || "").includes("text/html");

  // RACE CONDITION FIX: await privacy detection before computing redirect logic.
  // Without this, the fail-secure default (SPACE_IS_PRIVATE=true when SPACE_ID is set)
  // causes public spaces to redirect during the brief window before API detection completes.
  if (isHtmlReq && !_privacyDetectionDone) {
    await Promise.race([
      privacyDetectionReady,
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  }

  // In-app navigation from same origin or HF App iframe — skip private redirect.
  const referer = req.headers.referer || req.headers.referrer || "";
  const isSameOriginNav = !!(referer && typeof req.headers.host === "string" &&
    referer.startsWith(`https://${req.headers.host}`));
  const isFromHFApp = !!(referer && (
    referer.startsWith("https://huggingface.co") ||
    referer.startsWith("https://hf.co")
  ));

  const isDirectHfSpaceReq = SPACE_IS_PRIVATE &&
    HF_SPACE_URL &&
    isHtmlReq &&
    !isSameOriginNav &&
    !isFromHFApp &&
    typeof req.headers.host === "string" &&
    req.headers.host.endsWith(".hf.space");

  if (path === "/hf-redirect" || path === "/hf-redirect/") {
    if (HF_SPACE_URL) {
      res.writeHead(302, { location: HF_SPACE_URL, "cache-control": "no-store" });
      return res.end();
    }
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("SPACE_ID not configured.");
  }

  if (path === "/health" || path === `${APP_BASE}/health`) {
    const data = await statusPayload();
    // Always 200 — health server up means the app is running.
    // Gateway readiness is in the JSON body (gateway: true/false).
    // Returning 503 here caused Docker HEALTHCHECK to fail during gateway
    // startup, keeping HF Space stuck in RUNNING_APP_STARTING indefinitely.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: data.ok,
        gateway: data.gateway,
        uptime: data.uptime,
      }),
    );
    return;
  }

  if (path === "/status" || path === `${APP_BASE}/status`) {
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  if (path === "/env-builder" || path === "/env-builder/") {
    if (!requireAuth(req, res)) return;
    try {
      const html = fs.readFileSync(nodePath.join(__dirname, "env-builder.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("env-builder.html not found");
    }
    return;
  }

  if (path === "/env-builder.js") {
    if (!requireAuth(req, res)) return;
    try {
      const js = fs.readFileSync(nodePath.join(__dirname, "env-builder.js"), "utf8");
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(js);
    } catch (e) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("env-builder.js not found");
    }
    return;
  }

  if (path === "/files" || path === "/host-logs" || path === "/system") {
    if (!requireAuth(req, res)) return;
    const viewName = `${path.slice(1)}.html`;
    try {
      const html = fs.readFileSync(nodePath.join(__dirname, "views", viewName), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`${viewName} not found`);
    }
    return;
  }

  if (path.startsWith("/hm-api/")) {
    if (!requireApiAuth(req, res)) return;
    try {
      await handleHmApi(req, res, path, parsed);
    } catch (err) {
      const status = err && err.code === "ENOENT" ? 404 : 400;
      sendJson(res, status, { error: String((err && err.message) || err) });
    }
    return;
  }

  if (path === "/") {
    if (isDirectHfSpaceReq) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(renderPrivateRedirect(HF_SPACE_URL));
    }
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDashboard(data));
    return;
  }

  if (path === "/dashboard" || path === "/dashboard/") {
    redirect(res, `${APP_BASE}/${parsed.search}`);
    return;
  }

  if (path === "/telegram" || path.startsWith("/telegram/")) {
    proxyRequest(req, res, TELEGRAM_WEBHOOK_PORT);
    return;
  }

  if (path === APP_BASE || path.startsWith(`${APP_BASE}/`)) {
    if (!requireAuth(req, res)) return;
    proxyRequest(
      req,
      res,
      DASHBOARD_PORT,
      (p) => p.replace(/^\/app/, "") || "/",
    );
    return;
  }

  if (
    path === "/favicon.ico" ||
    path.startsWith("/assets/") ||
    path.startsWith("/api/") ||
    path.startsWith("/dashboard-plugins/") ||
    path.startsWith("/ds-assets/")
  ) {
    if (!requireAuth(req, res)) return;
    proxyRequest(req, res, DASHBOARD_PORT);
    return;
  }

  if (
    [
      "/analytics",
      "/chat",
      "/config",
      "/cron",
      "/docs",
      "/env",
      "/logs",
      "/models",
      "/plugins",
      "/profiles",
      "/sessions",
      "/skills",
    ].some((route) => path === route || path.startsWith(`${route}/`))
  ) {
    redirect(res, `${APP_BASE}${path}${parsed.search}`);
    return;
  }

  if (path === "/v1" || path.startsWith("/v1/")) {
    if (!isAuthorized(req)) {
      if (wantsHtml(req)) {
        redirect(res, loginUrl(`${path}${parsed.search}`));
        return;
      }
      res.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({
          error: "unauthorized",
          message: "Use Authorization: Bearer <GATEWAY_TOKEN>.",
        }),
      );
      return;
    }
    const upstreamHeaders =
      getBearerToken(req) || !API_SERVER_KEY
        ? {}
        : { authorization: `Bearer ${API_SERVER_KEY}` };
    proxyRequest(req, res, GATEWAY_PORT, (p) => p, upstreamHeaders);
    return;
  }

  if (path === TERMINAL_BASE || path.startsWith(`${TERMINAL_BASE}/`)) {
    if (!requireAuth(req, res)) return;
    canConnect(JUPYTER_PORT).then((up) => {
      if (!up) {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        res.end("JupyterLab is not running. GATEWAY_TOKEN must be set, and DEV_MODE must not be false.");
        return;
      }
      // Inject the Jupyter token so JupyterLab skips its own login screen.
      // User already authenticated via GATEWAY_TOKEN — no second prompt needed.
      // JUPYTER_TOKEN env may be empty in this process (health-server starts before
      // start_jupyter() exports it), so fall back to API_SERVER_KEY (== GATEWAY_TOKEN),
      // which is what JupyterLab was actually started with.
      const rawJToken = (process.env.JUPYTER_TOKEN || "").trim();
      const jToken = rawJToken || API_SERVER_KEY;
      // JupyterLab 4.x ignores the Authorization header for HTML page loads and
      // shows its own login screen. The reliable fix is to inject ?token= into the
      // URL for the initial HTML request — Jupyter reads it, sets the auth cookie,
      // then redirects to the clean URL. All subsequent requests use the cookie.
      if (jToken && isHtmlReq) {
        const parsed2 = new URL(req.url, "http://localhost");
        if (!parsed2.searchParams.has("token")) {
          const sep = parsed2.search ? "&" : "?";
          redirect(res, `${parsed2.pathname}${parsed2.search}${sep}token=${encodeURIComponent(jToken)}`);
          return;
        }
      }
      const overrides = jToken ? { authorization: `token ${jToken}` } : {};
      proxyRequest(req, res, JUPYTER_PORT, (p) => p, overrides);
    });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

// ── WebSocket upgrade (JupyterLab terminals + Hermes dashboard PTY/events) ──
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const isJupyter = pathname === TERMINAL_BASE || pathname.startsWith(`${TERMINAL_BASE}/`);
  const isDashboardWs =
      pathname === "/api/pty" ||
      pathname === "/api/events" ||
      pathname === "/api/ws";
  const targetPort = isJupyter
      ? JUPYTER_PORT
      : isDashboardWs
          ? DASHBOARD_PORT
          : GATEWAY_PORT;
  const ps = net.createConnection(targetPort, GATEWAY_HOST, () => {
    ps.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    ps.write(`Host: ${GATEWAY_HOST}:${targetPort}\r\n`);
    ps.write(`X-Forwarded-Host: ${req.headers.host || ""}\r\n`);
    ps.write("X-Forwarded-Proto: https\r\n");
    // Dashboard refuses WS if Origin-Host != Loopback-Bind
    // Rewrite Origin to Loopback for accepting PTY/events
    const skip = ["host", "x-forwarded-host", "x-forwarded-proto"];
    if (isDashboardWs) {
      ps.write(`Origin: http://${GATEWAY_HOST}:${targetPort}\r\n`);
      skip.push("origin");
    }
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const lower = req.rawHeaders[i].toLowerCase();
      if (skip.includes(lower)) continue;
      ps.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
    }
    ps.write("\r\n");
    if (head && head.length) ps.write(head);
    ps.pipe(socket).pipe(ps);
  });
  ps.on("error", () => socket.destroy());
  ps.on("close", () => socket.destroy());
  socket.on("error", () => ps.destroy());
  socket.on("close", () => ps.destroy());
});

server.timeout = 0;
server.keepAliveTimeout = 65000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`HuggingMes dashboard listening on 0.0.0.0:${PORT}`);
});
