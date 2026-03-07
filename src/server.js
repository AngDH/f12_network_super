const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const CDP = require("chrome-remote-interface");
const express = require("express");
const { captureToStore, ensureDir } = require("./capture");

const PORT = Number(process.env.PORT || 3100);
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const CDP_TARGET = process.env.CDP_TARGET || "";
const CAPTURE_DEVTOOLS = process.env.CAPTURE_DEVTOOLS === "1";
const DATA_DIR = path.resolve(process.cwd(), process.env.DATA_DIR || "data");
const RECORDS_DIR = path.join(DATA_DIR, "records");
const SEARCH_BODY_MAX_BYTES = 2 * 1024 * 1024;

ensureDir(DATA_DIR);
ensureDir(RECORDS_DIR);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
let liveTargets = [];
let hideTargetsUntilMs = 0;
let replayLastMs = 0;
let replaySeq = 0;

function readMetaById(id) {
  const metaPath = path.join(RECORDS_DIR, id, "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

function listAllMeta() {
  const dirs = fs
    .readdirSync(RECORDS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const rows = [];
  for (const id of dirs) {
    const row = readMetaById(id);
    if (row) rows.push(row);
  }
  return rows;
}

function clearAllRecords() {
  const dirs = fs
    .readdirSync(RECORDS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let deleted = 0;
  for (const id of dirs) {
    const recordPath = path.join(RECORDS_DIR, id);
    fs.rmSync(recordPath, { recursive: true, force: true });
    deleted += 1;
  }
  return deleted;
}

function getRowSortMs(row) {
  if (typeof row.wall_time === "number" && Number.isFinite(row.wall_time) && row.wall_time > 0) {
    return row.wall_time * 1000;
  }
  const t = Date.parse(row.created_at || 0);
  return Number.isFinite(t) ? t : 0;
}

function toIsoFromMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function safeLower(v) {
  return String(v || "").toLowerCase();
}

function fileContainsText(filePath, qLower) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    const readSize = Math.min(stat.size, SEARCH_BODY_MAX_BYTES);
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, 0);
      // Binary heuristic: many zero bytes usually indicate non-text.
      let zeroCount = 0;
      for (let i = 0; i < buf.length; i += 1) {
        if (buf[i] === 0) zeroCount += 1;
      }
      if (buf.length > 0 && zeroCount / buf.length > 0.1) return false;
      return buf.toString("utf8").toLowerCase().includes(qLower);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function matchRowByQuery(row, qLower) {
  if (!qLower) return true;
  if (safeLower(row.request_url).includes(qLower)) return true;
  if (safeLower(row.request_method).includes(qLower)) return true;
  if (safeLower(row.response_mime_type).includes(qLower)) return true;
  if (safeLower(row.resource_type).includes(qLower)) return true;
  if (safeLower(JSON.stringify(row.request_headers || {})).includes(qLower)) return true;
  if (safeLower(JSON.stringify(row.response_headers || {})).includes(qLower)) return true;
  if (fileContainsText(row.request_body_path, qLower)) return true;
  if (fileContainsText(row.response_body_path, qLower)) return true;
  return false;
}

function nextRecordId() {
  const nowMs = Date.now();
  if (nowMs === replayLastMs) replaySeq += 1;
  else {
    replayLastMs = nowMs;
    replaySeq = 0;
  }
  return `${String(nowMs).padStart(13, "0")}-${String(replaySeq).padStart(4, "0")}`;
}

function sanitizeExt(ext) {
  if (!ext) return "bin";
  return String(ext).replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
}

function pickExtFromUrl(urlStr) {
  if (!urlStr) return null;
  try {
    const u = new URL(urlStr);
    const ext = path.extname(u.pathname || "").replace(".", "").toLowerCase();
    if (!ext || ext.length > 8) return null;
    return ext;
  } catch {
    return null;
  }
}

function pickExtFromMime(mimeType) {
  if (!mimeType) return null;
  const m = String(mimeType).split(";")[0].trim().toLowerCase();
  const map = {
    "text/html": "html",
    "text/javascript": "js",
    "application/javascript": "js",
    "application/x-javascript": "js",
    "application/json": "json",
    "text/css": "css",
    "text/plain": "txt",
    "application/xml": "xml",
    "text/xml": "xml",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "font/woff": "woff",
    "font/woff2": "woff2",
    "application/pdf": "pdf",
    "application/wasm": "wasm",
    "application/octet-stream": "bin",
  };
  return map[m] || null;
}

function writeBodyFile(recordDir, kind, buffer, ext) {
  const fileName = `${kind}.${sanitizeExt(ext)}`;
  const absPath = path.join(recordDir, fileName);
  fs.writeFileSync(absPath, buffer);
  return absPath;
}

function normalizeHeaderName(name) {
  return String(name || "").trim().toLowerCase();
}

function headerPairsToObject(pairs) {
  const out = {};
  for (const p of pairs || []) {
    if (!p || !p.name) continue;
    const key = String(p.name);
    const value = String(p.value ?? "");
    if (normalizeHeaderName(key) === "set-cookie") {
      const prev = out[key];
      if (prev == null) out[key] = [value];
      else if (Array.isArray(prev)) prev.push(value);
      else out[key] = [prev, value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

function headersToPairs(headersObj) {
  const out = [];
  for (const [k, v] of Object.entries(headersObj || {})) {
    if (Array.isArray(v)) {
      for (const item of v) out.push({ name: String(k), value: String(item ?? "") });
    } else {
      out.push({ name: String(k), value: String(v ?? "") });
    }
  }
  return out;
}

function getHeaderValue(headersObj, name) {
  const target = normalizeHeaderName(name);
  for (const [k, v] of Object.entries(headersObj || {})) {
    if (normalizeHeaderName(k) !== target) continue;
    if (Array.isArray(v)) return String(v[0] || "");
    return String(v || "");
  }
  return "";
}

function isLikelyTextContentType(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (!ct) return true;
  if (ct.startsWith("text/")) return true;
  if (ct.includes("json")) return true;
  if (ct.includes("xml")) return true;
  if (ct.includes("javascript")) return true;
  if (ct.includes("x-www-form-urlencoded")) return true;
  if (ct.includes("graphql")) return true;
  if (ct.includes("multipart/form-data")) return false;
  if (ct.includes("octet-stream")) return false;
  if (ct.startsWith("image/") || ct.startsWith("audio/") || ct.startsWith("video/")) return false;
  return true;
}

function readBodyBufferSafe(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

function parseHeadersText(headersText) {
  const out = [];
  for (const line of String(headersText || "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!name) continue;
    out.push({ name, value });
  }
  return out;
}

function headerPairsToText(pairs) {
  return (pairs || []).map((x) => `${x.name}: ${x.value}`).join("\n");
}

function headerPairsToFetchHeadersObject(pairs) {
  const out = {};
  for (const p of pairs || []) {
    if (!p || !p.name) continue;
    const k = String(p.name);
    const lower = normalizeHeaderName(k);
    if (lower === "host" || lower === "content-length") continue;
    if (!(k in out)) out[k] = String(p.value ?? "");
  }
  return out;
}

function getHeaderFromPairs(pairs, name) {
  const target = normalizeHeaderName(name);
  const values = [];
  for (const p of pairs || []) {
    if (!p || !p.name) continue;
    if (normalizeHeaderName(p.name) !== target) continue;
    values.push(String(p.value ?? ""));
  }
  if (values.length === 0) return "";
  if (target === "cookie") return values.join("; ");
  return values[0];
}

function removeHeaderFromPairs(pairs, name) {
  const target = normalizeHeaderName(name);
  return (pairs || []).filter((p) => p && p.name && normalizeHeaderName(p.name) !== target);
}

function objectHeadersToPairs(headersObj) {
  const out = [];
  for (const [k, v] of Object.entries(headersObj || {})) {
    out.push({ name: String(k), value: String(v ?? "") });
  }
  return out;
}

function normalizeReplayRequestPairs(meta, pairsMaybe) {
  if (Array.isArray(pairsMaybe) && pairsMaybe.length > 0) {
    return pairsMaybe
      .filter((x) => x && x.name)
      .map((x) => ({ name: String(x.name), value: String(x.value ?? "") }));
  }
  if (Array.isArray(meta.request_headers_list) && meta.request_headers_list.length > 0) {
    return meta.request_headers_list
      .filter((x) => x && x.name)
      .map((x) => ({ name: String(x.name), value: String(x.value ?? "") }));
  }
  return headersToPairs(meta.request_headers || {});
}

function buildStoredRecordMeta({
  id,
  title,
  sourceId,
  method,
  requestUrl,
  requestHeaderPairs,
  requestBodyPath,
  startedAt,
  responseStatus,
  responseStatusText,
  responseHeaderPairs,
  responseMime,
  responseProtocol,
  responseBodyPath,
  responseBodySize,
  failed,
  errorText,
  targetInfo = null,
}) {
  const nowIso = new Date().toISOString();
  return {
    id,
    cdp_target_id: targetInfo?.id || null,
    cdp_target_title: targetInfo?.title || title,
    cdp_target_url: targetInfo?.url || null,
    cdp_request_id: null,
    loader_id: null,
    frame_id: null,
    request_url: requestUrl,
    request_method: method,
    request_headers: headerPairsToObject(requestHeaderPairs),
    request_headers_list: requestHeaderPairs,
    request_headers_extra_info_list: requestHeaderPairs,
    request_body_path: requestBodyPath,
    request_timestamp: null,
    wall_time: startedAt / 1000,
    resource_type: title,
    initiator: { type: "manual-send", source_id: sourceId },
    redirect_from: null,
    response_status: responseStatus,
    response_status_text: responseStatusText,
    response_headers: headerPairsToObject(responseHeaderPairs),
    response_headers_list: responseHeaderPairs,
    response_mime_type: responseMime,
    response_protocol: responseProtocol,
    response_remote_ip: null,
    response_remote_port: null,
    encoded_data_length: responseBodySize,
    transfer_size: responseBodySize,
    response_body_path: responseBodyPath,
    response_body_base64: responseBodyPath ? 1 : 0,
    response_body_size: responseBodySize,
    body_capture_error: null,
    request_intercepted: false,
    response_intercepted: false,
    header_stages: {
      request: [{ stage: `${title}.finalRequestHeaders`, at: nowIso, headers_list: requestHeaderPairs }],
      response: responseHeaderPairs.length
        ? [{ stage: `${title}.finalResponseHeaders`, at: nowIso, headers_list: responseHeaderPairs }]
        : [],
    },
    failed,
    error_text: errorText,
    replay: title === "Replay",
    replay_from_id: sourceId,
    replay_elapsed_ms: Math.max(0, Date.now() - startedAt),
    created_at: nowIso,
  };
}

function persistManualRecord({
  title,
  sourceId = null,
  method,
  requestUrl,
  requestHeaderPairs,
  requestBodyBuf,
  responseStatus = null,
  responseStatusText = null,
  responseHeaderPairs = [],
  responseMime = null,
  responseProtocol = null,
  responseBodyBuf = null,
  failed = 0,
  errorText = null,
  startedAt,
  targetInfo = null,
}) {
  const id = nextRecordId();
  const recordDir = path.join(RECORDS_DIR, id);
  ensureDir(recordDir);

  const requestHeadersObj = headerPairsToObject(requestHeaderPairs);
  const requestContentType = getHeaderValue(requestHeadersObj, "content-type");
  const requestExt = pickExtFromMime(requestContentType) || "bin";
  const requestBodyPath =
    requestBodyBuf && requestBodyBuf.length > 0
      ? writeBodyFile(recordDir, "request", requestBodyBuf, requestExt)
      : null;

  let responseBodyPath = null;
  let responseBodySize = null;
  if (responseBodyBuf && responseBodyBuf.length > 0) {
    const responseExt = pickExtFromMime(responseMime) || pickExtFromUrl(requestUrl) || "bin";
    responseBodyPath = writeBodyFile(recordDir, "response", responseBodyBuf, responseExt);
    responseBodySize = responseBodyBuf.length;
  }

  const meta = buildStoredRecordMeta({
    id,
    title,
    sourceId,
    method,
    requestUrl,
    requestHeaderPairs,
    requestBodyPath,
    startedAt,
    responseStatus,
    responseStatusText,
    responseHeaderPairs,
    responseMime,
    responseProtocol,
    responseBodyPath,
    responseBodySize,
    failed,
    errorText,
    targetInfo,
  });
  fs.writeFileSync(path.join(recordDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  return { id, meta };
}

async function executeManualRequest({
  method,
  url,
  requestHeaderPairs,
  requestBodyBuf,
  title,
  sourceId = null,
}) {
  const startedAt = Date.now();

  try {
    const fetchHeaders = headerPairsToFetchHeadersObject(requestHeaderPairs);
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: ["GET", "HEAD"].includes(method) ? undefined : requestBodyBuf,
      redirect: "follow",
    });

    const responseBuf = Buffer.from(await resp.arrayBuffer());
    const responseHeaderPairs = [];
    for (const [k, v] of resp.headers.entries()) {
      responseHeaderPairs.push({ name: k, value: v });
    }
    if (typeof resp.headers.getSetCookie === "function") {
      for (const v of resp.headers.getSetCookie()) {
        responseHeaderPairs.push({ name: "Set-Cookie", value: String(v) });
      }
    }
    const responseMime =
      String(resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() || null;
    const u = new URL(url);
    const persisted = persistManualRecord({
      title,
      sourceId,
      method,
      requestUrl: url,
      requestHeaderPairs,
      requestBodyBuf,
      responseStatus: resp.status,
      responseStatusText: resp.statusText || null,
      responseHeaderPairs,
      responseMime,
      responseProtocol: u.protocol.replace(":", ""),
      responseBodyBuf: responseBuf,
      failed: 0,
      errorText: null,
      startedAt,
    });
    return { ok: true, id: persisted.id, status: resp.status, elapsed_ms: persisted.meta.replay_elapsed_ms };
  } catch (err) {
    const targetUrl = (() => {
      try {
        return new URL(url);
      } catch {
        return null;
      }
    })();
    const persisted = persistManualRecord({
      title,
      sourceId,
      method,
      requestUrl: url,
      requestHeaderPairs,
      requestBodyBuf,
      responseStatus: null,
      responseStatusText: null,
      responseHeaderPairs: [],
      responseMime: null,
      responseProtocol: targetUrl ? targetUrl.protocol.replace(":", "") : null,
      responseBodyBuf: null,
      failed: 1,
      errorText: err?.message || `${title} failed`,
      startedAt,
    });
    return { ok: false, id: persisted.id, error: persisted.meta.error_text };
  }
}

async function executeBrowserSend({
  targetId,
  method,
  url,
  requestHeaderPairs,
  requestBodyBuf,
  timeoutMs,
}) {
  const targetInfo = liveTargets.find((x) => x.id === targetId) || null;
  if (!targetInfo) {
    return { ok: false, error: "Browser target is not available" };
  }

  const startedAt = Date.now();
  let client = null;
  let fetchDomainEnabled = false;
  try {
    client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    const { Runtime, Fetch } = client;
    await Runtime.enable();
    const markerHeader = "x-network-super-send-id";
    const markerValue = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const cookieOverride = getHeaderFromPairs(requestHeaderPairs, "cookie");
    const requestPairsNoCookie = removeHeaderFromPairs(requestHeaderPairs, "cookie");

    let cookieOverrideApplied = false;
    if (cookieOverride) {
      await Fetch.enable({
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });
      fetchDomainEnabled = true;
      Fetch.requestPaused(async (params) => {
        try {
          const reqHeadersObj = params.request?.headers || {};
          const markerSeen =
            reqHeadersObj[markerHeader] ||
            reqHeadersObj[markerHeader.toLowerCase()] ||
            reqHeadersObj[markerHeader.toUpperCase()];
          if (String(markerSeen || "") !== markerValue) {
            await Fetch.continueRequest({ requestId: params.requestId });
            return;
          }

          let pairs = objectHeadersToPairs(reqHeadersObj);
          pairs = removeHeaderFromPairs(pairs, markerHeader);
          pairs = removeHeaderFromPairs(pairs, "cookie");
          pairs.push({ name: "Cookie", value: cookieOverride });
          await Fetch.continueRequest({
            requestId: params.requestId,
            headers: pairs,
          });
          cookieOverrideApplied = true;
        } catch {
          try {
            await Fetch.continueRequest({ requestId: params.requestId });
          } catch {
          }
        }
      });
    }

    const payload = {
      method,
      url,
      headers: cookieOverride
        ? [...requestPairsNoCookie, { name: markerHeader, value: markerValue }]
        : requestHeaderPairs,
      bodyText: requestBodyBuf ? requestBodyBuf.toString("utf8") : "",
      hasBody: Boolean(requestBodyBuf && requestBodyBuf.length > 0 && !["GET", "HEAD"].includes(method)),
      timeoutMs,
    };
    const expression = `(() => {
      const payload = ${JSON.stringify(payload)};
      function toBase64(uint8) {
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < uint8.length; i += chunk) {
          binary += String.fromCharCode(...uint8.subarray(i, i + chunk));
        }
        return btoa(binary);
      }
      return (async () => {
        try {
          const headers = {};
          for (const item of payload.headers || []) {
            if (!item || !item.name) continue;
            headers[item.name] = String(item.value ?? "");
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), payload.timeoutMs);
          const init = {
            method: payload.method,
            headers,
            credentials: "include",
            signal: controller.signal,
          };
          if (payload.hasBody) init.body = payload.bodyText;
          const started = Date.now();
          const resp = await fetch(payload.url, init);
          const buf = new Uint8Array(await resp.arrayBuffer());
          clearTimeout(timer);
          return {
            ok: true,
            finalUrl: resp.url || payload.url,
            status: resp.status,
            statusText: resp.statusText || "",
            headersList: Array.from(resp.headers.entries()).map(([name, value]) => ({ name, value })),
            mime: resp.headers.get("content-type") || "",
            protocol: (() => { try { return new URL(resp.url || payload.url).protocol.replace(":", ""); } catch { return null; } })(),
            bodyBase64: toBase64(buf),
            elapsedMs: Date.now() - started,
          };
        } catch (err) {
          return {
            ok: false,
            error: String((err && err.message) || err || "Browser send failed"),
          };
        }
      })();
    })()`;
    const result = await Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const value = result?.result?.value || null;
    if (!value || !value.ok) {
      const persisted = persistManualRecord({
        title: "Browser Send",
        sourceId: null,
        method,
        requestUrl: url,
        requestHeaderPairs,
        requestBodyBuf,
        responseStatus: null,
        responseStatusText: null,
        responseHeaderPairs: [],
        responseMime: null,
        responseProtocol: null,
        responseBodyBuf: null,
        failed: 1,
        errorText: value?.error || "Browser send failed",
        startedAt,
        targetInfo,
      });
      return { ok: false, id: persisted.id, error: persisted.meta.error_text };
    }
    if (cookieOverride && !cookieOverrideApplied) {
      const persisted = persistManualRecord({
        title: "Browser Send",
        sourceId: null,
        method,
        requestUrl: url,
        requestHeaderPairs,
        requestBodyBuf,
        responseStatus: null,
        responseStatusText: null,
        responseHeaderPairs: [],
        responseMime: null,
        responseProtocol: null,
        responseBodyBuf: null,
        failed: 1,
        errorText: "Cookie override was not applied on browser request",
        startedAt,
        targetInfo,
      });
      return { ok: false, id: persisted.id, error: persisted.meta.error_text };
    }
    const responseBodyBuf = Buffer.from(String(value.bodyBase64 || ""), "base64");
    const responseHeaderPairs = Array.isArray(value.headersList)
      ? value.headersList
          .filter((x) => x && x.name)
          .map((x) => ({ name: String(x.name), value: String(x.value ?? "") }))
      : [];
    const responseMime = String(value.mime || "").split(";")[0].trim().toLowerCase() || null;
    const persisted = persistManualRecord({
      title: "Browser Send",
      sourceId: null,
      method,
      requestUrl: String(value.finalUrl || url),
      requestHeaderPairs,
      requestBodyBuf,
      responseStatus: Number(value.status) || null,
      responseStatusText: String(value.statusText || ""),
      responseHeaderPairs,
      responseMime,
      responseProtocol: value.protocol || null,
      responseBodyBuf,
      failed: 0,
      errorText: null,
      startedAt,
      targetInfo,
    });
    return {
      ok: true,
      id: persisted.id,
      status: persisted.meta.response_status,
      elapsed_ms: Number(value.elapsedMs) || persisted.meta.replay_elapsed_ms,
    };
  } catch (err) {
    const persisted = persistManualRecord({
      title: "Browser Send",
      sourceId: null,
      method,
      requestUrl: url,
      requestHeaderPairs,
      requestBodyBuf,
      responseStatus: null,
      responseStatusText: null,
      responseHeaderPairs: [],
      responseMime: null,
      responseProtocol: null,
      responseBodyBuf: null,
      failed: 1,
      errorText: err?.message || "Browser send failed",
      startedAt,
      targetInfo,
    });
    return { ok: false, id: persisted.id, error: persisted.meta.error_text };
  } finally {
    if (fetchDomainEnabled && client?.Fetch) {
      try {
        await client.Fetch.disable();
      } catch {
      }
    }
    if (client) {
      try {
        await client.close();
      } catch {
      }
    }
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    cdp: `${CDP_HOST}:${CDP_PORT}`,
    captureDevtools: CAPTURE_DEVTOOLS,
    recordsDir: RECORDS_DIR,
    now: new Date().toISOString(),
  });
});

app.get("/api/targets", (_req, res) => {
  if (Date.now() < hideTargetsUntilMs) {
    res.json({ total: 0, items: [] });
    return;
  }
  res.json({
    total: liveTargets.length,
    items: liveTargets,
  });
});

app.get("/api/browser-send/status", (_req, res) => {
  res.json({
    ok: true,
    connected: liveTargets.length > 0,
    total: liveTargets.length,
    items: liveTargets.map((x) => ({
      id: x.id,
      title: x.title || "(untitled)",
      url: x.url || "",
      type: x.type || "",
    })),
  });
});

app.get("/api/requests", (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  const q = String(req.query.q || "").trim().toLowerCase();
  const sinceMs = Math.max(0, Number(req.query.since_ms || 0));

  let rows = listAllMeta();
  if (sinceMs > 0) {
    rows = rows.filter((x) => getRowSortMs(x) > sinceMs);
  }
  if (q) rows = rows.filter((x) => matchRowByQuery(x, q));

  rows.sort((a, b) => {
    const ta = getRowSortMs(a);
    const tb = getRowSortMs(b);
    return ta - tb;
  });

  const total = rows.length;
  const items = rows.slice(offset, offset + limit).map((x) => ({
    id: x.id,
    request_method: x.request_method,
    request_url: x.request_url,
    response_status: x.response_status,
    response_protocol: x.response_protocol,
    response_mime_type: x.response_mime_type,
    resource_type: x.resource_type,
    response_body_size: x.response_body_size,
    failed: x.failed,
    error_text: x.error_text,
    request_intercepted: Boolean(x.request_intercepted),
    response_intercepted: Boolean(x.response_intercepted),
    sort_time: toIsoFromMs(getRowSortMs(x)),
    created_at: x.created_at,
  }));

  res.json({ total, limit, offset, items });
});

app.get("/api/requests/:id", (req, res) => {
  const row = readMetaById(req.params.id);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(row);
});

app.get("/api/requests/:id/replay-template", (req, res) => {
  const row = readMetaById(req.params.id);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const headersList = normalizeReplayRequestPairs(row);
  const headersObj = headerPairsToObject(headersList);
  const contentType = getHeaderValue(headersObj, "content-type");
  const bodyBuf = readBodyBufferSafe(row.request_body_path);
  let bodyText = "";
  let bodyBinary = false;
  if (bodyBuf && bodyBuf.length > 0) {
    if (isLikelyTextContentType(contentType)) {
      bodyText = bodyBuf.toString("utf8");
    } else {
      bodyBinary = true;
    }
  }

  res.json({
    id: row.id,
    method: String(row.request_method || "GET").toUpperCase(),
    url: row.request_url || "",
    headers_list: headersList,
    headers_text: headerPairsToText(headersList),
    body_text: bodyText,
    body_binary: bodyBinary,
    content_type: contentType || "",
  });
});

app.get("/api/requests/:id/body/:kind", (req, res) => {
  const row = readMetaById(req.params.id);
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const kind = req.params.kind;
  const filePath = kind === "request" ? row.request_body_path : row.response_body_path;
  if (!filePath) {
    res.status(404).json({ error: "No body file for this record" });
    return;
  }

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Body file missing on disk" });
    return;
  }

  const mime = row.response_mime_type || "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `inline; filename=\"${req.params.id}-${kind}\"`);
  fs.createReadStream(filePath).pipe(res);
});

app.post("/api/requests/:id/replay", async (req, res) => {
  const row = readMetaById(req.params.id);
  if (!row) {
    res.status(404).json({ ok: false, error: "Not found" });
    return;
  }

  const method = String(req.body?.method || row.request_method || "GET").toUpperCase();
  const url = String(req.body?.url || row.request_url || "");
  if (!url) {
    res.status(400).json({ ok: false, error: "Replay URL is empty" });
    return;
  }

  let requestHeaderPairs;
  if (typeof req.body?.headers_text === "string") {
    requestHeaderPairs = parseHeadersText(req.body.headers_text);
  } else if (Array.isArray(req.body?.headers_list)) {
    requestHeaderPairs = normalizeReplayRequestPairs(row, req.body.headers_list);
  } else {
    requestHeaderPairs = normalizeReplayRequestPairs(row);
  }

  const timeoutMs = Math.max(1000, Math.min(120000, Number(req.body?.timeout_ms || 30000)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const needsBody = !["GET", "HEAD"].includes(method);
  let requestBodyBuf = null;
  if (needsBody) {
    if (typeof req.body?.body_text === "string") {
      requestBodyBuf = Buffer.from(req.body.body_text, "utf8");
    } else {
      requestBodyBuf = readBodyBufferSafe(row.request_body_path);
    }
  }

  try {
    const result = await Promise.race([
      executeManualRequest({
        method,
        url,
        requestHeaderPairs,
        requestBodyBuf,
        title: "Replay",
        sourceId: row.id,
      }),
      new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("Replay timed out")), { once: true });
      }),
    ]);
    clearTimeout(timer);
    if (!result.ok) {
      res.status(500).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    clearTimeout(timer);
    res.status(500).json({ ok: false, error: err?.message || "Replay failed" });
  }
});

app.post("/api/send-request", async (req, res) => {
  const method = String(req.body?.method || "GET").toUpperCase();
  const url = String(req.body?.url || "");
  if (!url) {
    res.status(400).json({ ok: false, error: "Request URL is empty" });
    return;
  }

  let requestHeaderPairs = [];
  if (typeof req.body?.headers_text === "string") {
    requestHeaderPairs = parseHeadersText(req.body.headers_text);
  } else if (Array.isArray(req.body?.headers_list)) {
    requestHeaderPairs = req.body.headers_list
      .filter((x) => x && x.name)
      .map((x) => ({ name: String(x.name), value: String(x.value ?? "") }));
  }

  const needsBody = !["GET", "HEAD"].includes(method);
  const requestBodyBuf =
    needsBody && typeof req.body?.body_text === "string" ? Buffer.from(req.body.body_text, "utf8") : null;

  const timeoutMs = Math.max(1000, Math.min(120000, Number(req.body?.timeout_ms || 30000)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await Promise.race([
      executeManualRequest({
        method,
        url,
        requestHeaderPairs,
        requestBodyBuf,
        title: "Send Request",
      }),
      new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("Send Request timed out")), { once: true });
      }),
    ]);
    clearTimeout(timer);
    if (!result.ok) {
      res.status(500).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    clearTimeout(timer);
    res.status(500).json({ ok: false, error: err?.message || "Send Request failed" });
  }
});

app.post("/api/browser-send", async (req, res) => {
  const method = String(req.body?.method || "GET").toUpperCase();
  const url = String(req.body?.url || "");
  if (!url) {
    res.status(400).json({ ok: false, error: "Request URL is empty" });
    return;
  }
  if (liveTargets.length === 0) {
    res.status(400).json({ ok: false, error: "Browser is not connected. Start Chrome with CDP first." });
    return;
  }

  const targetId = String(req.body?.target_id || liveTargets[0]?.id || "");
  const targetExists = liveTargets.some((x) => x.id === targetId);
  if (!targetExists) {
    res.status(400).json({ ok: false, error: "Selected browser tab is not available" });
    return;
  }

  const requestHeaderPairs =
    typeof req.body?.headers_text === "string" ? parseHeadersText(req.body.headers_text) : [];
  const requestBodyBuf =
    !["GET", "HEAD"].includes(method) && typeof req.body?.body_text === "string"
      ? Buffer.from(req.body.body_text, "utf8")
      : null;
  const timeoutMs = Math.max(1000, Math.min(120000, Number(req.body?.timeout_ms || 30000)));

  const result = await executeBrowserSend({
    targetId,
    method,
    url,
    requestHeaderPairs,
    requestBodyBuf,
    timeoutMs,
  });
  if (!result.ok) {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

app.post("/api/requests/:id/open-folder", (req, res) => {
  const row = readMetaById(req.params.id);
  if (!row) {
    res.status(404).json({ ok: false, error: "Not found" });
    return;
  }

  const kind = String(req.query.kind || "response").toLowerCase();
  const targetPath = kind === "request" ? row.request_body_path : row.response_body_path;
  if (!targetPath) {
    res.status(404).json({ ok: false, error: "No body file for this record" });
    return;
  }
  if (!fs.existsSync(targetPath)) {
    res.status(404).json({ ok: false, error: "Body file missing on disk" });
    return;
  }

  const folder = path.dirname(targetPath);
  if (process.platform !== "win32") {
    res.status(400).json({ ok: false, error: "Open folder is only implemented for Windows." });
    return;
  }

  const openSelect = () => {
    const child = spawn(
      "cmd.exe",
      ["/c", "start", "", "explorer.exe", `/select,${targetPath}`],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();
    return child;
  };
  const openFolder = () => {
    const child = spawn("cmd.exe", ["/c", "start", "", folder], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return child;
  };

  try {
    // Prefer selecting the exact file; fallback to opening folder.
    const child = openSelect();
    child.on("error", () => {
      try {
        openFolder();
      } catch {
      }
    });
    res.json({ ok: true, folder, file: targetPath });
  } catch (err) {
    try {
      openFolder();
      res.json({ ok: true, folder, file: targetPath, fallback: true });
    } catch (err2) {
      res.status(500).json({ ok: false, error: err2.message || err.message || "Failed to open folder" });
    }
  }
});

app.delete("/api/requests", (_req, res) => {
  try {
    const deleted = clearAllRecords();
    hideTargetsUntilMs = Date.now() + 4000;
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "Failed to clear records" });
  }
});

app.listen(PORT, async () => {
  console.log(`Network Super UI: http://127.0.0.1:${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Records dir: ${RECORDS_DIR}`);
  try {
    await captureToStore({
      recordsDir: RECORDS_DIR,
      cdpHost: CDP_HOST,
      cdpPort: CDP_PORT,
      cdpTarget: CDP_TARGET,
      includeDevtools: CAPTURE_DEVTOOLS,
      onTargetsUpdate: (targets) => {
        liveTargets = targets;
      },
    });
  } catch (err) {
    console.error("Failed to connect CDP:", err.message);
    console.error("Make sure Chrome is running with --remote-debugging-port=9222");
  }
});
