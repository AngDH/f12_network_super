const targetSelectEl = document.getElementById("targetSelect");
const methodEl = document.getElementById("method");
const urlEl = document.getElementById("url");
const headersTextEl = document.getElementById("headersText");
const bodyTextEl = document.getElementById("bodyText");
const sendBtn = document.getElementById("sendBtn");
const clearBtn = document.getElementById("clearBtn");
const metaEl = document.getElementById("meta");
const detailEl = document.getElementById("detail");

const state = {
  activeTab: "summary",
  resultId: "",
  detail: null,
  responseText: null,
  browserConnected: false,
  targets: [],
  sourceId: "",
};

function esc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fmtSize(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isTextLikeMime(mime) {
  const x = String(mime || "").toLowerCase();
  return (
    x.includes("json") ||
    x.startsWith("text/") ||
    x.includes("javascript") ||
    x.includes("xml") ||
    x.includes("html")
  );
}

async function fetchDetail(id) {
  const res = await fetch(`/api/requests/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error("Failed to load request detail");
  return res.json();
}

async function loadBrowserStatus() {
  const res = await fetch("/api/browser-send/status", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load browser status");
  return res.json();
}

async function fetchReplayTemplate(id) {
  const res = await fetch(`/api/requests/${encodeURIComponent(id)}/replay-template`);
  if (!res.ok) throw new Error("Failed to load request template");
  return res.json();
}

async function fetchResponseText(id, mime) {
  if (!isTextLikeMime(mime)) return null;
  const res = await fetch(`/api/requests/${encodeURIComponent(id)}/body/response`);
  if (!res.ok) return null;
  return res.text();
}

function formatHeaders(headersObj, headersList) {
  if (Array.isArray(headersList) && headersList.length > 0) {
    return headersList
      .filter((x) => x && x.name)
      .map((x) => `${String(x.name)}: ${String(x.value ?? "")}`)
      .join("\n");
  }
  const lines = [];
  for (const [k, v] of Object.entries(headersObj || {})) {
    if (Array.isArray(v)) {
      for (const item of v) lines.push(`${k}: ${String(item)}`);
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  return lines.join("\n");
}

async function renderDetail() {
  if (!state.detail) {
    detailEl.innerHTML = "Send a request to see the response.";
    return;
  }
  const d = state.detail;

  if (state.activeTab === "summary") {
    detailEl.innerHTML = `
      <div class="kvline"><b>Record ID:</b> ${esc(d.id)}</div>
      <div class="kvline"><b>Status:</b> ${esc(d.response_status ?? "-")} ${esc(d.response_status_text || "")}</div>
      <div class="kvline"><b>URL:</b> ${esc(d.request_url || "")}</div>
      <div class="kvline"><b>Method:</b> ${esc(d.request_method || "")}</div>
      <div class="kvline"><b>Type:</b> ${esc(d.response_mime_type || d.resource_type || "-")}</div>
      <div class="kvline"><b>Response Size:</b> ${esc(fmtSize(d.response_body_size))}</div>
      <div class="kvline"><b>Error:</b> ${esc(d.error_text || "-")}</div>
    `;
    return;
  }

  if (state.activeTab === "headers") {
    detailEl.innerHTML = `
      <div class="kvline"><b>Request Headers</b></div>
      <pre>${esc(formatHeaders(d.request_headers || {}, d.request_headers_list || []))}</pre>
      <div class="kvline" style="margin-top:8px;"><b>Response Headers</b></div>
      <pre>${esc(formatHeaders(d.response_headers || {}, d.response_headers_list || []))}</pre>
    `;
    return;
  }

  if (state.activeTab === "meta") {
    detailEl.innerHTML = `<pre>${esc(JSON.stringify(d, null, 2))}</pre>`;
    return;
  }

  const mime = String(d.response_mime_type || "").toLowerCase();
  if (state.activeTab === "response") {
    if (mime.startsWith("image/")) {
      detailEl.innerHTML = `
        <div class="kvline"><b>Image Response</b></div>
        <img src="/api/requests/${encodeURIComponent(d.id)}/body/response" style="max-width:100%;max-height:260px;border:1px solid #d9dee5;" />
      `;
      return;
    }
    if (state.responseText == null) {
      state.responseText = await fetchResponseText(d.id, mime);
    }
    if (state.responseText == null) {
      detailEl.innerHTML = `<div class="kvline">Binary response is not rendered inline.</div>`;
      return;
    }
    let txt = state.responseText;
    if (mime.includes("json")) {
      try {
        txt = JSON.stringify(JSON.parse(txt), null, 2);
      } catch {
      }
    }
    detailEl.innerHTML = `<pre>${esc(txt)}</pre>`;
  }
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", async () => {
    state.activeTab = tab.dataset.tab;
    for (const t of document.querySelectorAll(".tab")) {
      t.classList.toggle("active", t === tab);
    }
    await renderDetail();
  });
}

function renderTargets(items) {
  const current = targetSelectEl.value;
  targetSelectEl.innerHTML = "";
  if (!items || items.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No Browser Tabs";
    targetSelectEl.appendChild(opt);
    targetSelectEl.disabled = true;
    return;
  }
  for (const item of items) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = `${item.title || "(untitled)"} | ${item.url || item.type || ""}`;
    targetSelectEl.appendChild(opt);
  }
  targetSelectEl.disabled = false;
  if (items.some((x) => x.id === current)) {
    targetSelectEl.value = current;
  }
}

function updateSendAvailability() {
  sendBtn.disabled = !state.browserConnected;
  if (!state.browserConnected) {
    metaEl.textContent = "Browser not connected. Start Chrome with CDP first.";
    metaEl.className = "meta status-warn";
  } else if (state.sourceId) {
    metaEl.textContent = `Loaded request ${state.sourceId}. Browser tabs: ${state.targets.length}`;
    metaEl.className = "meta";
  } else if (!state.detail) {
    metaEl.textContent = `Browser connected. Tabs: ${state.targets.length}`;
    metaEl.className = "meta";
  }
}

async function refreshBrowserStatus() {
  try {
    const data = await loadBrowserStatus();
    state.targets = data.items || [];
    state.browserConnected = Boolean(data.connected && state.targets.length > 0);
    renderTargets(state.targets);
    updateSendAvailability();
  } catch {
    state.targets = [];
    state.browserConnected = false;
    renderTargets([]);
    updateSendAvailability();
  }
}

async function loadSourceTemplateFromQuery() {
  const from = new URLSearchParams(location.search).get("from") || "";
  if (!from) return;
  state.sourceId = from;
  try {
    const tpl = await fetchReplayTemplate(from);
    methodEl.value = String(tpl.method || "GET").toUpperCase();
    urlEl.value = String(tpl.url || "");
    headersTextEl.value = String(tpl.headers_text || "");
    bodyTextEl.value = String(tpl.body_text || "");
  } catch (err) {
    metaEl.textContent = err.message || "Failed to load source request";
    metaEl.className = "meta status-bad";
  }
}

sendBtn.addEventListener("click", async () => {
  if (!state.browserConnected) {
    metaEl.textContent = "Browser not connected. Start Chrome with CDP first.";
    metaEl.className = "meta status-bad";
    return;
  }
  const method = String(methodEl.value || "GET").toUpperCase();
  const url = String(urlEl.value || "").trim();
  if (!url) {
    metaEl.textContent = "URL is empty";
    metaEl.className = "meta status-bad";
    return;
  }

  sendBtn.disabled = true;
  sendBtn.textContent = "Sending...";
  metaEl.textContent = "Sending request in browser...";
  metaEl.className = "meta";

  try {
    const res = await fetch("/api/browser-send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_id: targetSelectEl.value || "",
        method,
        url,
        headers_text: headersTextEl.value || "",
        body_text: bodyTextEl.value || "",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Send Request failed");
    }
    state.resultId = data.id;
    state.detail = await fetchDetail(data.id);
    state.responseText = null;
    metaEl.textContent = `Browser send success: ${data.id} (status ${data.status}, ${data.elapsed_ms} ms)`;
    metaEl.className = "meta status-ok";
    await renderDetail();
  } catch (err) {
    metaEl.textContent = err.message || "Browser Send failed";
    metaEl.className = "meta status-bad";
    state.detail = null;
    state.responseText = null;
    await renderDetail();
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Send";
  }
});

clearBtn.addEventListener("click", async () => {
  methodEl.value = "GET";
  urlEl.value = "";
  headersTextEl.value = "";
  bodyTextEl.value = "";
  state.sourceId = "";
  state.resultId = "";
  state.detail = null;
  state.responseText = null;
  updateSendAvailability();
  state.activeTab = "summary";
  for (const t of document.querySelectorAll(".tab")) {
    t.classList.toggle("active", t.dataset.tab === "summary");
  }
  await renderDetail();
});

loadSourceTemplateFromQuery().finally(() => {
  refreshBrowserStatus();
});
setInterval(refreshBrowserStatus, 2000);
renderDetail();
