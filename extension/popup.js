const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const CONSOLE = "http://127.0.0.1:3131";
const API = "http://127.0.0.1:9337";
const DEFAULTS = { connection: "public", share: true, model: "", invite: "", autoStart: true };

let S = { ...DEFAULTS };
let applied = null;   // opts the extension last launched with
let status = null;    // /api/status
let host = null;      // native host status
let busy = "";        // "", "starting", "restarting", "stopping"

const save = (patch) => { Object.assign(S, patch); return chrome.storage.local.set(patch); };

// ---- helpers ---------------------------------------------------------------------
function pill(text, cls) { $("pill").textContent = text; $("pill").className = `pill ${cls}`; }
function shortModel(id) { return id.replace(/^.*\//, "").replace(/-GGUF.*:/i, " ").replace(/@[0-9a-f]{8,}/, ""); }
function wantedOpts() {
  return { connection: S.connection, share: !!S.share, model: S.share ? S.model || "" : "",
           invite: S.connection === "private" && S.invite ? "set" : "" };
}
function sameOpts(a, b) { return a && b && ["connection", "share", "model", "invite"].every((k) => (a[k] || "") === (b[k] || "")); }
const isManaged = () => !!(host?.ok && host.managed_pid && status);
// Public meshes are found via Nostr discovery; a private mesh turns it off
// (the desktop app uses the same signal).
const isPrivate = (st) => st?.nostr_discovery === false;
const runningPid = () => status?.local_instances?.find((i) => i.is_self)?.pid;

function showError(r) {
  $("err").hidden = false;
  $("errMsg").textContent = r.error;
  const log = r.log || "";
  $("errLog").textContent = log;
  $("errLog").hidden = !log;
  const m = log.match(/Required plugin '([^']+)' failed to start/);
  $("errHint").hidden = !m;
  if (m) $("errHint").textContent = `A plugin in ~/.mesh-llm (${m[1]}) is required but won't start. Run: mesh-llm plugins disable ${m[1]}`;
}
const clearError = () => ($("err").hidden = true);

// ---- render ----------------------------------------------------------------------
function renderSettings() {
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.conn === S.connection)));
  const priv = S.connection === "private";
  $("privateBox").hidden = !priv;
  $("joinedBox").hidden = !(priv && S.invite);
  $("connHelp").textContent = priv
    ? (S.invite
        ? "Your own mesh, joined with an invite. Everyone in it is trusted."
        : "Your own mesh. Others join with an invite you share. Invites last 24 hours and can be forwarded, so share them only with people you trust.")
    : "The open mesh. Anyone can find it, and there's nothing to share.";
  $("share").checked = !!S.share;
  $("model").hidden = !S.share;
  $("model").value = S.model;
  $("autoStart").checked = !!S.autoStart;
}

const PLAN_TEXT = {
  automatic: (m) => `Automatic: ${shortModel(m)} (picked to fit this Mac)`,
  chosen: (m) => `Serving ${shortModel(m)} (your choice)`,
  "config.toml": () => "Models come from your ~/.mesh-llm/config.toml",
  "no fit": () => "No model fits this Mac's free memory, so it joins on standby",
  "not sharing": () => "Not sharing: this Mac only uses the mesh",
};
async function renderPlan() {
  const r = await send({ type: "plan" });
  $("plan").textContent = r?.ok ? (PLAN_TEXT[r.source]?.(r.model) ?? "") : "";
}

function renderControls() {
  const hostOk = host?.ok;
  const canLaunch = hostOk && host.installed;
  $("setup").hidden = !!(canLaunch || status);
  $("chat").disabled = !status;
  $("copyInvite").disabled = !status || !isPrivate(status);

  const running = !!status;
  const external = running && !isManaged();
  $("start").hidden = running || !canLaunch;
  $("start").disabled = !!busy;
  $("start").textContent = busy === "starting" ? "Starting…" : "Start Mesh";
  $("stop").hidden = !running || !canLaunch;
  $("stop").textContent = busy === "stopping" ? "Stopping…" : "Stop";
  // Pending changes: only meaningful when running.
  const pending = running && canLaunch && (external ? false : !sameOpts(applied, wantedOpts()));
  $("apply").hidden = !(pending || busy === "restarting");
  $("apply").disabled = !!busy;
  $("apply").textContent = busy === "restarting" ? "Restarting…" : "Restart to apply";

  $("external").hidden = !external;
  if (external) {
    $("external").textContent = `Running outside the extension (pid ${runningPid() ?? "?"}). ` +
      (canLaunch ? "Settings here apply when the extension starts Mesh; Stop takes it over." : "");
  }
}

function renderStatus() {
  if (busy) {
    pill(busy + "…", "wait");
  } else if (status) {
    const priv = isPrivate(status);
    pill(status.node_status || "Ready", priv ? "priv" : "on");
  } else {
    pill(host?.crashed ? "failed" : "off", "off");
  }

  if (!status) {
    $("headline").textContent = busy ? "Getting ready…" : host?.ok ? (host.installed ? `Not running · ${host.version}` : "Not installed") : "Not running";
    return;
  }
  const priv = isPrivate(status);
  const peers = (status.peers || []).length;
  const serving = status.serving_models || [];
  $("headline").textContent = `${priv ? "Private" : "Public"} mesh · ${peers} peer${peers === 1 ? "" : "s"}` +
    (serving.length ? ` · serving ${shortModel(serving[0])}`
      : status.is_client ? " · using the mesh (not sharing)"
      : status.node_state === "loading" ? " · loading a model…"
      : " · standby, GPU offered");
  $("headline").title = {
    client: "Client: uses the mesh, never shares this Mac's GPU.",
    standby: "Standby: offering this Mac's GPU, no model loaded yet. It loads one when the mesh needs it.",
    loading: "Loading: downloading or loading a model to serve.",
    serving: "Serving: a model is loaded and answering requests from the mesh.",
  }[status.node_state] || "";
}

async function render() {
  const r = await send({ type: "refresh" });
  status = r.status;
  host = r.host;
  ({ applied = null } = await chrome.storage.local.get("applied"));
  renderStatus();
  renderControls();
  if (!busy && !status && host?.crashed) showError({ error: "Mesh stopped unexpectedly (last launch).", log: host.log_tail });
  if (status) clearError();
}

// ---- actions ---------------------------------------------------------------------
async function run(kind, msg) {
  busy = kind;
  clearError();
  renderStatus(); renderControls();
  const r = await send(msg);
  busy = "";
  if (!r.ok) showError({ error: `${kind === "stopping" ? "Stop" : "Start"} failed: ${r.error}`, log: r.log });
  else if (r.already_running && r.external) showError({ error: `Mesh is already running outside the extension (pid ${r.pid}, port ${r.port}).` });
  await render();
}

$("start").onclick = () => run("starting", { type: "start" });
$("apply").onclick = () => run("restarting", { type: "restart", pid: isManaged() ? undefined : runningPid() });
$("stop").onclick = () => {
  if (!isManaged() && !confirm("This Mesh was started outside the extension. Stop it anyway?")) return;
  run("stopping", { type: "stop", pid: isManaged() ? undefined : runningPid() });
};

document.querySelectorAll(".seg button").forEach((b) => (b.onclick = async () => {
  await save({ connection: b.dataset.conn });
  renderSettings(); renderControls();
}));
$("share").onchange = async () => { await save({ share: $("share").checked }); renderSettings(); renderControls(); renderPlan(); };
$("model").onchange = async () => { await save({ model: $("model").value.trim() }); renderControls(); renderPlan(); };
$("autoStart").onchange = () => save({ autoStart: $("autoStart").checked });

$("join").onclick = async () => {
  const tok = $("invite").value.trim();
  if (!/^[A-Za-z0-9_-]{16,32768}$/.test(tok)) {
    showError({ error: "Paste the complete Mesh invite, without spaces or a command." });
    return;
  }
  await save({ connection: "private", invite: tok });
  $("invite").value = "";
  renderSettings();
  if (status) run("restarting", { type: "restart", pid: isManaged() ? undefined : runningPid() });
  else run("starting", { type: "start" });
};
$("leave").onclick = async (e) => {
  e.preventDefault();
  await save({ invite: "" });
  renderSettings(); renderControls();
};

$("copyInvite").onclick = async () => {
  const msg = $("inviteMsg");
  try {
    const st = await (await fetch(`${CONSOLE}/api/status`, { cache: "no-store" })).json();
    if (!isPrivate(st)) throw new Error("Invites belong to a private Mesh. Choose Private and restart first.");
    if (!st.owner?.verified) throw new Error("Mesh is still getting ready. Try again when it says Ready.");
    if (!st.token) throw new Error("This invite has expired. Ask the person who invited you for a new one — only the node that started this Mesh can make one.");
    await navigator.clipboard.writeText(st.token);
    msg.textContent = "Copied — valid 24 hours.";
  } catch (e) {
    msg.textContent = e.message;
  }
  setTimeout(() => (msg.textContent = ""), 6000);
};

$("chat").onclick = () => chrome.tabs.create({ url: `${CONSOLE}/chat` });
$("console").onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: `${CONSOLE}/` }); };
let windowId = null;
chrome.windows.getCurrent().then((w) => (windowId = w.id));
$("panel").onclick = async () => {
  // sidePanel.open must be the first async call inside the click (user gesture).
  try {
    if (chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ windowId });
    } else if (globalThis.browser?.sidebarAction) {
      await browser.sidebarAction.open();
    }
    window.close();
  } catch (e) {
    showError({ error: `Couldn't open side panel: ${e.message}` });
  }
};

$("copyInstall").onclick = async () => {
  await navigator.clipboard.writeText($("installCmd").textContent);
  $("copyInstall").textContent = "Copied";
};
$("showLogs").onclick = async (e) => {
  e.preventDefault();
  const el = $("logs");
  if (!el.hidden) { el.hidden = true; return; }
  const r = await send({ type: "logs" });
  el.textContent = r.ok ? r.text || "(empty)" : `Launcher not available: ${r.error}`;
  el.hidden = false;
  el.scrollTop = el.scrollHeight;
};
$("update").onclick = async (e) => {
  e.preventDefault();
  busy = "updating"; renderStatus();
  const r = await send({ type: "update" });
  busy = "";
  $("logs").hidden = false;
  $("logs").textContent = r.ok ? `Updated to ${r.version} (${r.tag})${r.restarted ? " and restarted" : ""}` : `Update failed: ${r.error}`;
  if (r.ok && r.extension_updated) {
    $("logs").textContent += " — reloading extension…";
    setTimeout(() => chrome.runtime.reload(), 1200);
    return;
  }
  await render();
};

(async () => {
  S = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  renderSettings();
  renderPlan();
  await render();
  setInterval(() => { if (!busy) render(); }, 4000);
})();
