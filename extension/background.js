// Mesh LLM extension — background worker.
// Polls the local mesh-llm management API, keeps the toolbar badge current,
// starts/stops/restarts mesh-llm via the native host, and wires context menus.

const HOST = "ai.meshllm.host";
const CONSOLE = "http://127.0.0.1:3131";
const DEFAULTS = {
  connection: "public", // public | private
  share: true,          // share this machine's compute (serve) vs client only
  model: "",            // optional --model when sharing
  invite: "",           // private: invite token to join with ("" = create my own)
  autoStart: true,
  chatModel: "",
};

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

function launchOpts(s) {
  return {
    connection: s.connection,
    share: !!s.share,
    model: s.share ? s.model || "" : "",
    invite: s.connection === "private" ? s.invite || "" : "",
  };
}

async function fetchJson(url, ms = 2500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function nodeStatus() {
  try {
    return await fetchJson(`${CONSOLE}/api/status`);
  } catch {
    return null;
  }
}

function native(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(HOST, msg, (reply) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, hostMissing: true, error: err.message });
        else resolve(reply || { ok: false, error: "empty reply" });
      });
    } catch (e) {
      resolve({ ok: false, hostMissing: true, error: String(e) });
    }
  });
}

async function setBadge(st) {
  if (!st) {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Mesh LLM: not running" });
    return;
  }
  const peers = (st.peers || []).length;
  const priv = st.nostr_discovery === false;
  await chrome.action.setBadgeText({ text: String(peers) });
  await chrome.action.setBadgeBackgroundColor({ color: priv ? "#6366f1" : "#10b981" });
  await chrome.action.setTitle({
    title: `Mesh LLM ${st.version} — ${priv ? "private" : "public"} mesh, ${st.node_status}, ${peers} peer(s)`,
  });
}

async function refresh() {
  const st = await nodeStatus();
  await setBadge(st);
  return st;
}

// Wait for :3131 after a launch; bail out with the log tail if the process dies.
async function waitUp(r) {
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    if (await refresh()) return { ...r, up: true };
    const h = await native({ cmd: "status" });
    if (h.ok && h.crashed) return { ok: false, crashed: true, error: "mesh-llm exited during startup", log: h.log_tail };
  }
  return { ok: false, error: "mesh-llm started but its API didn't come up within 90s — check Logs" };
}

async function startMesh() {
  const s = await settings();
  const opts = launchOpts(s);
  const r = await native({ cmd: "start", opts });
  if (!r.ok || r.already_running) return r;
  await chrome.storage.local.set({ applied: { ...opts, invite: opts.invite ? "set" : "" } });
  return waitUp(r);
}

async function restartMesh(pid) {
  const s = await settings();
  const opts = launchOpts(s);
  await chrome.action.setBadgeText({ text: "…" });
  const r = await native({ cmd: "restart", opts, pid });
  if (!r.ok || r.already_running) return r;
  await chrome.storage.local.set({ applied: { ...opts, invite: opts.invite ? "set" : "" } });
  return waitUp(r);
}

async function maybeAutoStart() {
  const s = await settings();
  if (!s.autoStart || (await nodeStatus())) return;
  const h = await native({ cmd: "status" });
  if (h.ok && h.installed && !h.managed_pid) await startMesh();
}

// ---- side panel ----------------------------------------------------------------
async function openPanel(tab) {
  try {
    if (chrome.sidePanel?.open) await chrome.sidePanel.open({ windowId: tab.windowId });
    else if (globalThis.browser?.sidebarAction) await browser.sidebarAction.open();
  } catch (e) {
    console.warn("side panel", e);
  }
}

// ---- lifecycle -------------------------------------------------------------------
function setup() {
  chrome.alarms.create("poll", { periodInMinutes: 0.5 });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "ask-sel", title: 'Ask the mesh about "%s"', contexts: ["selection"] });
    chrome.contextMenus.create({ id: "sum-page", title: "Summarise this page with the mesh", contexts: ["page"] });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  setup();
  await maybeAutoStart();
  await refresh();
});
chrome.runtime.onStartup.addListener(async () => {
  setup();
  await maybeAutoStart();
  await refresh();
});
chrome.alarms.onAlarm.addListener((a) => a.name === "poll" && refresh());

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Open first: sidePanel.open must run inside the user gesture.
  openPanel(tab);
  const task =
    info.menuItemId === "ask-sel"
      ? { kind: "selection", text: info.selectionText, title: tab.title, url: tab.url }
      : { kind: "page", tabId: tab.id, title: tab.title, url: tab.url };
  await chrome.storage.local.set({ pendingTask: { ...task, at: Date.now() } });
});

// ---- messages from popup / side panel ----------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "refresh":
        return { status: await refresh(), host: await native({ cmd: "status" }) };
      case "start":
        return startMesh();
      case "restart":
        return restartMesh(msg.pid);
      case "stop": {
        const r = await native({ cmd: "stop", pid: msg.pid });
        await chrome.storage.local.remove("applied");
        await refresh();
        return r;
      }
      case "logs":
        return native({ cmd: "logs", lines: 150 });
      case "update":
        return native({ cmd: "update" });
      case "openPanel": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await openPanel(tab);
        return { ok: true };
      }
      default:
        return { ok: false, error: "unknown message" };
    }
  })().then(sendResponse);
  return true;
});
