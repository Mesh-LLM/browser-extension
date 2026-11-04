const $ = (id) => document.getElementById(id);
const API = "http://127.0.0.1:9337";
const CONSOLE = "http://127.0.0.1:3131";
const MAX_PAGE_CHARS = 16000;

let messages = [];      // OpenAI-style history (without page context blobs)
let controller = null;  // AbortController for the in-flight request

// ---- page access ------------------------------------------------------------------
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function ensureHostAccess(tab) {
  // activeTab covers the tab the user invoked us on (toolbar/context menu);
  // for any other tab, ask once for access to that site.
  const u = new URL(tab.url || "about:blank");
  if (!/^https?:$/.test(u.protocol)) throw new Error("This kind of page can't be read.");
  const origins = [`${u.origin}/*`];
  if (await chrome.permissions.contains({ origins })) return;
  try {
    await chrome.permissions.request({ origins });
  } catch {
    /* not in a user gesture (e.g. context-menu handoff): rely on activeTab */
  }
}

async function readPage(tab, { selectionOnly = false } = {}) {
  tab = tab || (await activeTab());
  await ensureHostAccess(tab);
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [selectionOnly, MAX_PAGE_CHARS],
    func: (selOnly, max) => {
      const sel = String(getSelection() || "").trim();
      if (selOnly) return { selection: sel };
      const main = document.querySelector("article, main, [role=main]") || document.body;
      return { selection: sel, text: (main?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, max) };
    },
  });
  return { title: tab.title, url: tab.url, ...(res?.result || {}) };
}

// ---- rendering -------------------------------------------------------------------
function bubble(role, text = "") {
  $("empty").hidden = true;
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  $("log").appendChild(el);
  $("log").scrollTop = $("log").scrollHeight;
  return el;
}

function note(text) {
  const el = bubble("note", text);
  return el;
}

// ---- models / status --------------------------------------------------------------
async function loadModels() {
  try {
    const r = await fetch(`${API}/v1/models`, { cache: "no-store" });
    const ids = ((await r.json()).data || []).map((m) => m.id);
    const sel = $("model");
    const { chatModel } = await chrome.storage.local.get("chatModel");
    const prev = sel.value || chatModel;
    sel.replaceChildren(...ids.map((id) => new Option(id.replace(/^local-gguf\/sha256-(.{8}).*/, "local $1").replace(/@[0-9a-f]{12,}/, ""), id)));
    sel.value = ids.includes(prev) ? prev : ids.includes("mesh") ? "mesh" : ids[0] || "";
    $("offline").hidden = true;
    $("send").disabled = false;
    return true;
  } catch {
    $("offline").hidden = false;
    $("send").disabled = true;
    return false;
  }
}

async function updatePageLabel() {
  const tab = await activeTab();
  $("pageTitle").textContent = tab?.title ? `— ${tab.title.slice(0, 60)}` : "";
}

// ---- chat ------------------------------------------------------------------------
async function ask(userText, { context = null, display = userText } = {}) {
  if (!userText.trim() || controller) return;
  bubble("user", display);
  const out = bubble("assistant");
  out.classList.add("streaming");

  const sys = [{ role: "system", content: "You are a helpful assistant running on a peer-to-peer mesh of local GPUs. Be concise. Use plain text or simple Markdown." }];
  const turn = context
    ? { role: "user", content: `${userText}\n\n---\nPage: ${context.title}\nURL: ${context.url}\n\n${context.text}` }
    : { role: "user", content: userText };
  const body = { model: $("model").value || "mesh", stream: true, messages: [...sys, ...messages, turn] };

  controller = new AbortController();
  $("send").hidden = true;
  $("stop").hidden = false;
  let answer = "";
  try {
    const r = await fetch(`${API}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const d = JSON.parse(data);
          const delta = d.choices?.[0]?.delta?.content ?? d.choices?.[0]?.message?.content ?? "";
          if (delta) {
            answer += delta;
            out.textContent = answer;
            $("log").scrollTop = $("log").scrollHeight;
          }
          if (d.model && !out.dataset.model) out.dataset.model = d.model;
        } catch { /* keepalive */ }
      }
    }
    if (!answer) out.textContent = "(empty response)";
    // Keep history compact: store the user's words, not the page dump.
    messages.push({ role: "user", content: context ? `${userText} (about the page "${context.title}")` : userText });
    messages.push({ role: "assistant", content: answer });
    if (out.dataset.model) out.title = `answered by ${out.dataset.model}`;
  } catch (e) {
    out.classList.add("error");
    out.textContent = e.name === "AbortError" ? (answer || "") + " [stopped]" : `Error: ${e.message}`;
  } finally {
    out.classList.remove("streaming");
    controller = null;
    $("send").hidden = false;
    $("stop").hidden = true;
  }
}

async function quick(act, tab) {
  try {
    if (act === "explain-sel") {
      const p = await readPage(tab, { selectionOnly: true });
      if (!p.selection) return note("Select some text on the page first.");
      return ask(`Explain this:\n\n${p.selection}`, { display: `Explain: “${p.selection.slice(0, 200)}${p.selection.length > 200 ? "…" : ""}”` });
    }
    const p = await readPage(tab);
    if (!p.text) return note("Couldn't find any text on this page.");
    const q = act === "keypoints" ? "List the key points of this page as short bullets." : "Summarise this page in a few sentences, then 3–5 bullet points.";
    return ask(q, { context: p, display: `${act === "keypoints" ? "Key points" : "Summarise"}: ${p.title}` });
  } catch (e) {
    note(`Can't read this page: ${e.message}`);
  }
}

// ---- wiring ------------------------------------------------------------------------
$("form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("prompt").value;
  if (!text.trim()) return;
  $("prompt").value = "";
  let context = null;
  if ($("usePage").checked) {
    try { context = await readPage(); } catch (err) { note(`Page not included: ${err.message}`); }
  }
  ask(text, { context });
};
$("prompt").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("form").requestSubmit(); }
};
$("stop").onclick = () => controller?.abort();
$("newChat").onclick = () => {
  controller?.abort();
  messages = [];
  document.querySelectorAll(".msg").forEach((m) => m.remove());
  $("empty").hidden = false;
};
$("model").onchange = () => chrome.storage.local.set({ chatModel: $("model").value });
document.querySelectorAll(".chips button").forEach((b) => (b.onclick = () => quick(b.dataset.act)));

// Tasks handed over from the context menu.
async function takePending() {
  const { pendingTask: t } = await chrome.storage.local.get("pendingTask");
  if (!t || Date.now() - t.at > 60000) return;
  await chrome.storage.local.remove("pendingTask");
  if (!(await loadModels())) return note("Mesh isn't running — start it from the toolbar icon.");
  if (t.kind === "selection") {
    ask(`Explain this:\n\n${t.text}`, { display: `Explain: “${t.text.slice(0, 200)}${t.text.length > 200 ? "…" : ""}”` });
  } else {
    const tab = await chrome.tabs.get(t.tabId).catch(() => null);
    quick("summarise", tab || undefined);
  }
}
chrome.storage.onChanged.addListener((ch) => { if (ch.pendingTask?.newValue) takePending(); });
chrome.tabs.onActivated.addListener(updatePageLabel);
chrome.tabs.onUpdated.addListener((_id, info) => info.title && updatePageLabel());

(async () => {
  await loadModels();
  updatePageLabel();
  takePending();
  setInterval(loadModels, 15000);
})();
