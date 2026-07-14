import { WORKER_URL, VAPID_PUBLIC_KEY, SUBSCRIBE_SECRET, EXPECTED_ACCOUNTS } from "./config.js";

const POLL_MS = 45_000;
const grid = document.getElementById("grid");
const syncDot = document.getElementById("sync-dot");
const syncLabel = document.getElementById("sync-label");

// account -> { data, el, refs } render state
const cards = new Map();
let lastGoodSync = null;

/* ---------------- provider theming ---------------- */
function accent(account) {
  const n = (account || "").toLowerCase();
  if (n.includes("claude")) return { c: "#ff9d57", soft: "rgba(255,157,87,0.16)", glyph: "C" };
  if (n.includes("chatgpt") || n.includes("codex") || n.includes("openai"))
    return { c: "#2fe6a8", soft: "rgba(47,230,168,0.16)", glyph: "G" };
  return { c: "#a583ff", soft: "rgba(165,131,255,0.16)", glyph: (account || "?")[0].toUpperCase() };
}

/* ---------------- time helpers ---------------- */
function fmtCountdownFine(ms) {
  if (ms <= 0) return "00:00:00";
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}
function fmtCountdownCoarse(ms) {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function fmtAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function pct(used, limit) {
  if (!limit || limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}
function barClass(p) {
  if (p > 95) return "danger";
  if (p > 80) return "warn";
  return "";
}

/* ---------------- card DOM ---------------- */
function buildCard(account) {
  const a = accent(account);
  const el = document.createElement("article");
  el.className = "card empty";
  el.style.setProperty("--c", a.c);
  el.style.setProperty("--c-soft", a.soft);
  el.innerHTML = `
    <div class="card-head">
      <div class="acct">
        <span class="acct-glyph">${a.glyph}</span>
        <span class="acct-name"><b data-name>${account}</b><small data-plan>—</small></span>
      </div>
      <span class="chip" data-chip hidden></span>
    </div>
    <div data-body>
      <div class="waiting"><span class="spinner"></span> waiting for first sync…</div>
      <div class="skeleton" style="width:70%"></div>
      <div class="skeleton" style="width:45%"></div>
    </div>`;
  grid.appendChild(el);
  return { el, account };
}

function bodyMarkup() {
  return `
    <div class="metric" data-metric="session">
      <div class="metric-top">
        <span class="metric-label">Session · 5h</span>
        <span class="metric-pct" data-pct>0%</span>
      </div>
      <div class="bar"><div class="bar-fill" data-fill role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div></div>
      <div class="metric-foot">
        <span class="count" data-count></span>
        <span class="countdown" data-reset title="resets in">—</span>
      </div>
    </div>
    <div class="metric" data-metric="weekly">
      <div class="metric-top">
        <span class="metric-label">Week</span>
        <span class="metric-pct" data-pct>0%</span>
      </div>
      <div class="bar"><div class="bar-fill" data-fill role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div></div>
      <div class="metric-foot">
        <span class="count" data-count></span>
        <span class="countdown" data-reset title="resets in">—</span>
      </div>
    </div>
    <div class="card-foot">
      <span data-updated>updated —</span>
      <span class="badge" data-badge hidden></span>
    </div>`;
}

function renderCard(entry, d) {
  const { el } = entry;
  el.classList.remove("empty");
  el.querySelector("[data-plan]").textContent = d.plan || "—";
  const chip = el.querySelector("[data-chip]");
  if (d.plan) { chip.textContent = d.plan; chip.hidden = false; }

  const body = el.querySelector("[data-body]");
  if (!entry.hydrated) { body.innerHTML = bodyMarkup(); entry.hydrated = true; }

  for (const key of ["session", "weekly"]) {
    const m = d[key] || {};
    const block = el.querySelector(`[data-metric="${key}"]`);
    const p = pct(m.used, m.limit);
    const fill = block.querySelector("[data-fill]");
    fill.style.width = p + "%";
    fill.className = "bar-fill " + barClass(p);
    fill.setAttribute("aria-valuenow", String(p));
    fill.setAttribute("aria-label", `${entry.account} ${key} usage ${p}%`);
    block.querySelector("[data-pct]").textContent = p + "%";
    const count = block.querySelector("[data-count]");
    if (m.limit) count.textContent = `${m.used ?? 0} / ${m.limit}`;
  }
  entry.data = d;
  tickCard(entry); // immediate countdown paint
}

/* ---------------- countdown tick (1s) ---------------- */
function tickCard(entry) {
  const d = entry.data;
  if (!d || !entry.hydrated) return;
  const now = Date.now();
  const sess = entry.el.querySelector('[data-metric="session"] [data-reset]');
  const wk = entry.el.querySelector('[data-metric="weekly"] [data-reset]');
  if (d.session?.resetsAt) {
    const ms = new Date(d.session.resetsAt).getTime() - now;
    sess.textContent = ms > 0 ? `resets ${fmtCountdownFine(ms)}` : "reset";
    sess.classList.toggle("spent", ms <= 0);
  }
  if (d.weekly?.resetsAt) {
    const ms = new Date(d.weekly.resetsAt).getTime() - now;
    wk.textContent = ms > 0 ? `resets ${fmtCountdownCoarse(ms)}` : "reset";
    wk.classList.toggle("spent", ms <= 0);
  }
  // freshness badge + updated label
  if (d.updatedAt) {
    const age = now - new Date(d.updatedAt).getTime();
    entry.el.querySelector("[data-updated]").textContent = "updated " + fmtAgo(age);
    const badge = entry.el.querySelector("[data-badge]");
    if (age > 2 * 3600_000) { badge.textContent = "offline"; badge.className = "badge off"; badge.hidden = false; }
    else if (age > 15 * 60_000) { badge.textContent = "stale"; badge.className = "badge stale"; badge.hidden = false; }
    else { badge.hidden = true; }
  }
}

setInterval(() => { for (const e of cards.values()) tickCard(e); }, 1000);

/* ---------------- data ---------------- */
function ensureExpected() {
  for (const name of EXPECTED_ACCOUNTS) {
    if (!cards.has(name)) cards.set(name, buildCard(name));
  }
}

function setSync(state, text) {
  syncDot.className = "sync-dot " + state;
  syncLabel.textContent = text;
}

async function fetchState() {
  if (!WORKER_URL || WORKER_URL.includes("__WORKER_URL__")) {
    setSync("off", "worker not configured");
    return;
  }
  try {
    const res = await fetch(`${WORKER_URL}/state`, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("bad payload");

    for (const d of rows) {
      const name = d.account;
      if (!name) continue;
      let entry = cards.get(name);
      if (!entry) { entry = buildCard(name); cards.set(name, entry); }
      renderCard(entry, d);
    }
    lastGoodSync = Date.now();
    setSync("live", "synced " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  } catch (err) {
    const stale = lastGoodSync && Date.now() - lastGoodSync < 5 * 60_000;
    setSync(stale ? "stale" : "off", stale ? "reconnecting…" : "offline");
    console.warn("[state] fetch failed:", err.message);
  }
}

/* ---------------- notifications ---------------- */
function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}
function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

const notifyBtn = document.getElementById("notify-btn");
const notifyLabel = document.getElementById("notify-label");
const iosBanner = document.getElementById("ios-banner");

function setNotifyState(text, cls) {
  notifyLabel.textContent = text;
  notifyBtn.classList.remove("ok", "err");
  if (cls) notifyBtn.classList.add(cls);
}

async function registerSW() {
  if (!("serviceWorker" in navigator)) return null;
  // Relative path keeps scope correct under the GitHub Pages subpath.
  return navigator.serviceWorker.register("./sw.js", { scope: "./" });
}

async function enableNotifications() {
  notifyBtn.disabled = true;
  try {
    const reg = await registerSW();
    if (!reg) throw new Error("Service workers unsupported");
    await navigator.serviceWorker.ready;

    const perm = await Notification.requestPermission();
    if (perm !== "granted") { setNotifyState("Notifications blocked", "err"); notifyBtn.disabled = false; return; }

    let sub = await reg.pushManager.getSubscription();
    const already = !!sub;
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const res = await fetch(`${WORKER_URL}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUBSCRIBE_SECRET}` },
      body: JSON.stringify(sub),
    });
    if (!res.ok) throw new Error("subscribe HTTP " + res.status);

    setNotifyState(already ? "Already subscribed" : "Notifications on", "ok");
  } catch (err) {
    console.error("[push]", err);
    setNotifyState("Couldn't enable — retry", "err");
    notifyBtn.disabled = false;
  }
}

function initNotifyUI() {
  const pushOK = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (isIOS() && !isStandalone()) {
    // iOS web push needs the installed PWA — show install guidance, hide button.
    iosBanner.hidden = false;
    notifyBtn.hidden = true;
    return;
  }
  if (!pushOK) { notifyBtn.hidden = true; return; }
  notifyBtn.hidden = false;
  if (Notification.permission === "granted") setNotifyState("Notifications on", "ok");
  notifyBtn.addEventListener("click", enableNotifications);
  // Pre-register SW so caching/offline works even before enabling push.
  registerSW().catch(() => {});
}

/* ---------------- boot ---------------- */
ensureExpected();
initNotifyUI();
fetchState();
setInterval(fetchState, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) fetchState(); });
