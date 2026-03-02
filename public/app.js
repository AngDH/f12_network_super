const rowsEl = document.getElementById("rows");
const qEl = document.getElementById("q");
const refreshBtn = document.getElementById("refreshBtn");
const autoBtn = document.getElementById("autoBtn");
const clearBtn = document.getElementById("clearBtn");
const detailEl = document.getElementById("detail");
const metaEl = document.getElementById("meta");
const filtersEl = document.getElementById("filters");
const targetsBarEl = document.getElementById("targetsBar");
const splitterEl = document.getElementById("splitter");
const rowMenuEl = document.getElementById("rowMenu");
const markSubmenuWrapEl = document.getElementById("markSubmenuWrap");

let state = {
  q: "",
  auto: true,
  activeFilter: "all",
  activeTab: "headers",
  selectedId: "",
  items: [],
  detail: null,
  latestSortMs: 0,
  targetsHiddenUntil: 0,
  rowMarks: {},
  contextRowId: "",
};

const DETAIL_HEIGHT_KEY = "network_super_detail_height";
const ROW_MARKS_KEY = "network_super_row_marks";

function loadRowMarks() {
  try {
    const raw = localStorage.getItem(ROW_MARKS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return {};
    return obj;
  } catch {
    return {};
  }
}

function saveRowMarks() {
  localStorage.setItem(ROW_MARKS_KEY, JSON.stringify(state.rowMarks));
}

state.rowMarks = loadRowMarks();

function esc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function fmtTime(s) {
  if (!s) return "";
  const d = new Date(s);
  return d.toLocaleTimeString();
}

function fmtSize(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function mimeToKind(x) {
  const mime = String(x.response_mime_type || "").toLowerCase();
  const rtype = String(x.resource_type || "").toLowerCase();
  if (rtype === "document" || mime.includes("text/html")) return "document";
  if (rtype === "xhr" || rtype === "fetch") return "xhr";
  if (mime.includes("javascript") || mime.includes("ecmascript")) return "js";
  if (mime.includes("text/css")) return "css";
  if (mime.startsWith("image/")) return "img";
  if (mime.startsWith("font/") || mime.includes("woff") || mime.includes("ttf")) return "font";
  return "other";
}

function statusClass(status) {
  if (typeof status !== "number") return "";
  if (status < 300) return "status-ok";
  if (status < 400) return "status-warn";
  return "status-bad";
}

function visibleItems() {
  return state.items.filter((x) => {
    const filterOk = state.activeFilter === "all" || mimeToKind(x) === state.activeFilter;
    return filterOk;
  });
}

function pickName(url) {
  return pickNameForRow({ request_url: url, request_method: "" });
}

function trimHead(str, max = 90) {
  const s = String(str || "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

function pickNameForRow(row) {
  const url = String(row.request_url || "");
  const method = String(row.request_method || "").toUpperCase();
  if (!url) return "(unknown)";

  if (url.startsWith("data:") || url.startsWith("blob:")) {
    return trimHead(url, 96);
  }

  try {
    const u = new URL(url);
    const path = u.pathname || "/";
    if (path === "/" && !u.search) {
      return trimHead(`${u.hostname}`, 96);
    }
    if (method === "GET" && u.search) {
      return trimHead(`${path}${u.search}`, 110);
    }
    const last = path.split("/").filter(Boolean).pop();
    return trimHead(last || path || u.hostname || url, 96);
  } catch {
    return trimHead(url, 96);
  }
}

function shortUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname || ""}`;
  } catch {
    return url;
  }
}

function renderTargets(items) {
  if (!items || items.length === 0) {
    targetsBarEl.innerHTML = "<b>Listening Tabs:</b> (none)";
    return;
  }
  const chips = items
    .map((t) => {
      const title = esc(t.title || "(untitled)");
      const url = esc(shortUrl(t.url || ""));
      return `<span class=\"target-chip\" title=\"${url}\">${title}</span>`;
    })
    .join("");
  targetsBarEl.innerHTML = `<b>Listening Tabs (${items.length}):</b> ${chips}`;
}

function renderList() {
  const list = visibleItems();
  metaEl.textContent = `Total: ${state.items.length} | Visible: ${list.length}`;

  rowsEl.innerHTML = list
    .map((x) => {
      const cls = statusClass(x.response_status);
      const status = x.response_status ?? (x.failed ? "ERR" : "-");
      const selected = state.selectedId === x.id ? "selected" : "";
      const mark = String(state.rowMarks[x.id] || "");
      const markClass = mark ? `mark-${mark}` : "";
      const autoIntercepted =
        !mark && (x.request_intercepted === true || x.response_intercepted === true)
          ? "auto-intercepted"
          : "";
      return `
        <tr class="req-row ${selected} ${markClass} ${autoIntercepted}" data-id="${esc(x.id)}">
          <td class="name-cell" title="${esc(x.request_url)}">${esc(pickNameForRow(x))}</td>
          <td>${esc(x.request_method || "")}</td>
          <td class="${cls}">${esc(status)}</td>
          <td>${esc(x.response_mime_type || x.resource_type || "")}</td>
          <td>${esc(fmtSize(x.response_body_size))}</td>
          <td>${esc(fmtTime(x.sort_time || x.created_at))}</td>
        </tr>
      `;
    })
    .join("");

  for (const tr of rowsEl.querySelectorAll("tr[data-id]")) {
    tr.addEventListener("click", () => selectRequest(tr.dataset.id));
  }
}

function hideRowMenu() {
  if (!rowMenuEl) return;
  rowMenuEl.style.display = "none";
  if (markSubmenuWrapEl) markSubmenuWrapEl.classList.remove("open");
  document.body.classList.remove("row-menu-open");
}

function showRowMenu(rowId, x, y) {
  if (!rowMenuEl) return;
  state.contextRowId = rowId;
  rowMenuEl.style.display = "block";
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const mw = rowMenuEl.offsetWidth || 160;
  const mh = rowMenuEl.offsetHeight || 220;
  const left = Math.min(x, vw - mw - 8);
  const top = Math.min(y, vh - mh - 8);
  rowMenuEl.style.left = `${Math.max(8, left)}px`;
  rowMenuEl.style.top = `${Math.max(8, top)}px`;
  document.body.classList.add("row-menu-open");
}

function getItemSortMs(item) {
  const t = Date.parse(item.sort_time || item.created_at || 0);
  return Number.isFinite(t) ? t : 0;
}

function rebuildLatestSortMs() {
  let latest = 0;
  for (const x of state.items) {
    const t = getItemSortMs(x);
    if (t > latest) latest = t;
  }
  state.latestSortMs = latest;
}

async function loadListFull() {
  const url = new URL("/api/requests", location.origin);
  url.searchParams.set("limit", "2000");
  if (state.q) url.searchParams.set("q", state.q);
  const res = await fetch(url);
  const data = await res.json();
  state.items = data.items || [];
  rebuildLatestSortMs();

  if (state.selectedId && !state.items.find((x) => x.id === state.selectedId)) {
    state.selectedId = "";
    state.detail = null;
  }

  renderList();
}

async function loadListIncremental() {
  const url = new URL("/api/requests", location.origin);
  url.searchParams.set("limit", "1000");
  if (state.q) {
    url.searchParams.set("q", state.q);
  } else if (state.latestSortMs > 0) {
    url.searchParams.set("since_ms", String(state.latestSortMs));
  }
  const res = await fetch(url);
  const data = await res.json();
  const incoming = data.items || [];
  if (incoming.length === 0) return;

  const exists = new Set(state.items.map((x) => x.id));
  const append = incoming.filter((x) => !exists.has(x.id));
  if (append.length === 0) return;

  state.items = state.items.concat(append);
  rebuildLatestSortMs();
  renderList();
}

async function loadTargets() {
  if (Date.now() < state.targetsHiddenUntil) {
    renderTargets([]);
    return;
  }
  try {
    const res = await fetch("/api/targets", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    renderTargets(data.items || []);
  } catch {
  }
}

async function fetchDetail(id) {
  const res = await fetch(`/api/requests/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchResponseText(id, mime) {
  const likelyText =
    mime.includes("json") ||
    mime.startsWith("text/") ||
    mime.includes("javascript") ||
    mime.includes("xml") ||
    mime.includes("html");
  if (!likelyText) return null;

  const res = await fetch(`/api/requests/${encodeURIComponent(id)}/body/response`);
  if (!res.ok) return null;
  return res.text();
}

async function openBodyFolder(id, kind = "response") {
  const oldMeta = metaEl.textContent;
  try {
    const res = await fetch(
      `/api/requests/${encodeURIComponent(id)}/open-folder?kind=${encodeURIComponent(kind)}`,
      { method: "POST" },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Failed to open folder");
    }
    metaEl.textContent = "Opened response folder";
    setTimeout(() => {
      if (metaEl.textContent === "Opened response folder") {
        metaEl.textContent = oldMeta;
      }
    }, 1800);
  } catch (err) {
    alert(err.message || "Failed to open folder");
  }
}

function renderHeaders(detail) {
  const reqHeaders = detail.request_headers || {};
  const resHeaders = detail.response_headers || {};

  function formatHeadersForDisplay(headers) {
    const lines = [];
    for (const [k, v] of Object.entries(headers || {})) {
      if (Array.isArray(v)) {
        for (const item of v) {
          lines.push(`${k}: ${String(item)}`);
        }
      } else {
        lines.push(`${k}: ${String(v)}`);
      }
    }
    return lines.join("\n");
  }

  return `
    <div class="kvline"><b>Request URL:</b> ${esc(detail.request_url)}</div>
    <div class="kvline"><b>Request Method:</b> ${esc(detail.request_method)}</div>
    <div class="kvline"><b>Status Code:</b> ${esc(detail.response_status ?? "-")} ${esc(detail.response_status_text || "")}</div>
    <div class="kvline"><b>Remote Address:</b> ${esc(detail.response_remote_ip || "-")}:${esc(detail.response_remote_port || "-")}</div>
    <div class="kvline"><b>Type:</b> ${esc(detail.response_mime_type || "-")}</div>
    <div class="kvline"><b>Request Headers</b></div>
    <pre>${esc(formatHeadersForDisplay(reqHeaders))}</pre>
    <div class="kvline" style="margin-top:8px;"><b>Response Headers</b></div>
    <pre>${esc(formatHeadersForDisplay(resHeaders))}</pre>
  `;
}

function renderMeta(detail) {
  const data = {
    id: detail.id,
    created_at: detail.created_at,
    resource_type: detail.resource_type,
    request_timestamp: detail.request_timestamp,
    wall_time: detail.wall_time,
    encoded_data_length: detail.encoded_data_length,
    transfer_size: detail.transfer_size,
    failed: detail.failed,
    error_text: detail.error_text,
    body_capture_error: detail.body_capture_error,
    request_body_path: detail.request_body_path,
    response_body_path: detail.response_body_path,
  };
  return `<pre>${esc(JSON.stringify(data, null, 2))}</pre>`;
}

function isTextLikeMime(mime) {
  return (
    mime.includes("json") ||
    mime.startsWith("text/") ||
    mime.includes("javascript") ||
    mime.includes("xml") ||
    mime.includes("html")
  );
}

function isImageMime(mime) {
  return mime.startsWith("image/");
}

async function renderDetail() {
  if (!state.detail) {
    detailEl.innerHTML = '<span class="muted">Select one request from upper list.</span>';
    return;
  }

  const d = state.detail;
  const mime = String(d.response_mime_type || "").toLowerCase();

  if (state.activeTab === "headers") {
    detailEl.innerHTML = renderHeaders(d);
    return;
  }

  if (state.activeTab === "meta") {
    detailEl.innerHTML = renderMeta(d);
    return;
  }

  if (state.activeTab === "preview") {
    const txt = await fetchResponseText(d.id, mime);
    if (txt == null) {
      detailEl.innerHTML = `
        <div class="kvline muted">Binary or non-text response. Open raw body:</div>
        <div class="links">
          <a href="/api/requests/${encodeURIComponent(d.id)}/body/response" target="_blank">Open Response Body</a>
          <a href="/api/requests/${encodeURIComponent(d.id)}/body/request" target="_blank">Open Request Body</a>
        </div>
      `;
      return;
    }

    if (mime.includes("json")) {
      try {
        const j = JSON.parse(txt);
        detailEl.innerHTML = `<pre>${esc(JSON.stringify(j, null, 2))}</pre>`;
        return;
      } catch {
      }
    }

    detailEl.innerHTML = `<pre>${esc(txt.slice(0, 600000))}</pre>`;
    return;
  }

  if (state.activeTab === "response") {
    const topLinks = `
      <div class="links action-links">
        <a class="action-btn" href="#" data-open-folder="response" data-id="${esc(d.id)}">Open Response Folder</a>
      </div>
    `;

    if (isImageMime(mime)) {
      detailEl.innerHTML = `
        ${topLinks}
        <div class="kvline muted">Response MIME: ${esc(d.response_mime_type || "unknown")} | Size: ${esc(fmtSize(d.response_body_size))}</div>
        <div style="padding-top:8px;">
          <img src="/api/requests/${encodeURIComponent(d.id)}/body/response" alt="response-preview" style="max-width:100%; max-height:420px; border:1px solid #d9dee5;" />
        </div>
      `;
      return;
    }

    if (isTextLikeMime(mime)) {
      const txt = await fetchResponseText(d.id, mime);
      if (txt != null) {
        if (mime.includes("json")) {
          try {
            const j = JSON.parse(txt);
            detailEl.innerHTML = `${topLinks}<pre>${esc(JSON.stringify(j, null, 2))}</pre>`;
            return;
          } catch {
          }
        }
        detailEl.innerHTML = `${topLinks}<pre>${esc(txt)}</pre>`;
        return;
      }
    }

    detailEl.innerHTML = `
      ${topLinks}
      <div class="kvline muted">Response MIME: ${esc(d.response_mime_type || "unknown")}</div>
      <div class="kvline muted">Response size: ${esc(fmtSize(d.response_body_size))}</div>
      <div class="kvline muted">Binary response is not rendered inline. Open the response body with the link above.</div>
    `;
    return;
  }
}

async function selectRequest(id) {
  state.selectedId = id;
  const d = await fetchDetail(id);
  state.detail = d;
  renderList();
  await renderDetail();
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

filtersEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".pill");
  if (!btn) return;
  state.activeFilter = btn.dataset.filter;
  for (const p of filtersEl.querySelectorAll(".pill")) {
    p.classList.toggle("active", p === btn);
  }
  renderList();
});

refreshBtn.addEventListener("click", async () => {
  state.q = qEl.value.trim();
  state.latestSortMs = 0;
  await loadListFull();
});

async function applySearchFromInput() {
  state.q = qEl.value.trim();
  state.latestSortMs = 0;
  await loadListFull();
}

autoBtn.addEventListener("click", () => {
  state.auto = !state.auto;
  autoBtn.textContent = `Auto: ${state.auto ? "ON" : "OFF"}`;
});

clearBtn.addEventListener("click", async () => {
  const ok = confirm("Delete all captured records?");
  if (!ok) return;

  clearBtn.disabled = true;
  clearBtn.textContent = "Clearing...";
  try {
    const res = await fetch("/api/requests", { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to clear records");

    state.selectedId = "";
    state.detail = null;
    state.items = [];
    state.latestSortMs = 0;
    state.targetsHiddenUntil = Date.now() + 4000;
    renderList();
    renderTargets([]);
    await renderDetail();
    await loadListFull();
  } catch (err) {
    alert(err.message || "Failed to clear records");
  } finally {
    clearBtn.disabled = false;
    clearBtn.textContent = "Clear All";
  }
});

qEl.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    await applySearchFromInput();
  }
});

qEl.addEventListener("change", async () => {
  await applySearchFromInput();
});

setInterval(async () => {
  if (!state.auto) return;
  if (state.q) {
    await loadListFull();
    return;
  }
  await loadListIncremental();
}, 2500);

setInterval(loadTargets, 2000);

loadListFull();
loadTargets();

document.addEventListener("click", async (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const link = target.closest("[data-open-folder]");
  if (!link) return;
  e.preventDefault();
  const id = link.getAttribute("data-id");
  const kind = link.getAttribute("data-open-folder") || "response";
  if (!id) return;
  await openBodyFolder(id, kind);
});

rowsEl.addEventListener("contextmenu", (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const row = target.closest("tr[data-id]");
  if (!row) return;
  e.preventDefault();
  showRowMenu(row.getAttribute("data-id"), e.clientX, e.clientY);
});

document.addEventListener("click", (e) => {
  const target = e.target;
  if (!(target instanceof Element)) {
    hideRowMenu();
    return;
  }
  if (target.closest("#rowMenu")) return;
  hideRowMenu();
});

window.addEventListener("resize", hideRowMenu);
window.addEventListener("scroll", hideRowMenu, true);

if (rowMenuEl) {
  rowMenuEl.addEventListener("mousemove", (e) => {
    const target = e.target;
    if (!(target instanceof Element) || !markSubmenuWrapEl) return;
    if (target.closest("#markSubmenuWrap")) {
      markSubmenuWrapEl.classList.add("open");
    } else {
      markSubmenuWrapEl.classList.remove("open");
    }
  });

  rowMenuEl.addEventListener("mouseleave", () => {
    if (markSubmenuWrapEl) markSubmenuWrapEl.classList.remove("open");
  });

  rowMenuEl.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const item = target.closest("[data-mark]");
    if (!item) return;
    const mark = item.getAttribute("data-mark");
    const id = state.contextRowId;
    if (!id) return;
    if (mark === "clear") {
      delete state.rowMarks[id];
    } else if (mark) {
      state.rowMarks[id] = mark;
    }
    saveRowMarks();
    renderList();
    hideRowMenu();
  });
}

(function initResizablePanels() {
  if (!splitterEl) return;

  const saved = Number(localStorage.getItem(DETAIL_HEIGHT_KEY) || 0);
  if (Number.isFinite(saved) && saved > 120) {
    document.documentElement.style.setProperty("--detail-height", `${saved}px`);
  }

  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  const onMove = (ev) => {
    if (!dragging) return;
    const dy = startY - ev.clientY;
    const minH = 140;
    const maxH = Math.max(220, Math.floor(window.innerHeight * 0.8));
    let next = startHeight + dy;
    if (next < minH) next = minH;
    if (next > maxH) next = maxH;
    document.documentElement.style.setProperty("--detail-height", `${next}px`);
    localStorage.setItem(DETAIL_HEIGHT_KEY, String(next));
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  splitterEl.addEventListener("mousedown", (ev) => {
    dragging = true;
    startY = ev.clientY;
    const cssVal = getComputedStyle(document.documentElement).getPropertyValue("--detail-height").trim();
    startHeight = Number.parseInt(cssVal || "290", 10);
    if (!Number.isFinite(startHeight)) startHeight = 290;
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
})();
