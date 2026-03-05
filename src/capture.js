const fs = require("fs");
const path = require("path");
const CDP = require("chrome-remote-interface");
const { getInterceptorHooks } = require("./interceptor");

const CAPTURE_TARGET_TYPES = new Set([
  "page",
  "iframe",
  "worker",
  "shared_worker",
  "service_worker",
  "webview",
]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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

function writeMeta(recordDir, meta) {
  fs.writeFileSync(path.join(recordDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
}

function writeBodyFile(recordDir, kind, buffer, ext) {
  const fileName = `${kind}.${sanitizeExt(ext)}`;
  const absPath = path.join(recordDir, fileName);
  fs.writeFileSync(absPath, buffer);
  return absPath;
}

function headersArrayToObject(headers) {
  const out = {};
  if (!Array.isArray(headers)) return out;
  for (const h of headers) {
    if (!h || !h.name) continue;
    const key = String(h.name);
    const value = h.value;
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

function headersToPairs(headers) {
  const out = [];
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (!h || !h.name) continue;
      out.push({ name: String(h.name), value: String(h.value ?? "") });
    }
    return out;
  }
  if (!headers || typeof headers !== "object") return out;
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        out.push({ name: String(k), value: String(item ?? "") });
      }
    } else {
      out.push({ name: String(k), value: String(v ?? "") });
    }
  }
  return out;
}

function headerPairsToObject(pairs) {
  const out = {};
  for (const p of pairs || []) {
    if (!p || !p.name) continue;
    setHeaderWithMerge(out, String(p.name), String(p.value ?? ""));
  }
  return out;
}

function mergeHeaderPairs(existing, incoming) {
  const base = Array.isArray(existing)
    ? existing.map((x) => ({ name: String(x.name || ""), value: String(x.value ?? "") }))
    : [];
  const incomingPairs = headersToPairs(incoming);
  for (const p of incomingPairs) {
    const lower = normalizeHeaderName(p.name);
    if (lower === "set-cookie") {
      base.push({ name: p.name, value: p.value });
      continue;
    }
    const idx = base.findIndex((x) => normalizeHeaderName(x.name) === lower);
    if (idx >= 0) {
      // Keep original relative position while updating latest value.
      base[idx] = { name: base[idx].name || p.name, value: p.value };
    } else {
      base.push({ name: p.name, value: p.value });
    }
  }
  return base;
}

function normalizeHeaderName(name) {
  return String(name || "").trim().toLowerCase();
}

function setHeaderWithMerge(target, key, value) {
  const existingKey = Object.keys(target).find((k) => normalizeHeaderName(k) === normalizeHeaderName(key));
  const useKey = existingKey || key;
  if (useKey.toLowerCase() === "set-cookie") {
    const prev = target[useKey];
    if (prev == null) {
      target[useKey] = value;
      return;
    }
    const arr = [];
    if (Array.isArray(prev)) arr.push(...prev);
    else arr.push(prev);
    if (Array.isArray(value)) arr.push(...value);
    else arr.push(value);
    target[useKey] = arr;
    return;
  }
  target[useKey] = value;
}

function mergeHeaders(target, incoming) {
  if (!incoming || typeof incoming !== "object") return target;
  for (const [k, v] of Object.entries(incoming)) {
    setHeaderWithMerge(target, k, v);
  }
  return target;
}

function headersObjectToArray(headersObj) {
  const out = [];
  for (const [k, v] of Object.entries(headersObj || {})) {
    if (Array.isArray(v)) {
      for (const item of v) {
        out.push({ name: k, value: String(item) });
      }
    } else {
      out.push({ name: k, value: String(v) });
    }
  }
  return out;
}

function toBuffer(data, opts = {}) {
  if (data == null) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data === "string") {
    if (opts.base64) return Buffer.from(data, "base64");
    return Buffer.from(data, "utf8");
  }
  return Buffer.from(String(data), "utf8");
}

function extractSetCookieFromHeadersText(headersText) {
  if (typeof headersText !== "string" || !headersText.trim()) return [];
  const lines = headersText.split(/\r?\n/);
  const cookies = [];
  for (const line of lines) {
    const m = line.match(/^set-cookie\s*:\s*(.*)$/i);
    if (!m) continue;
    const v = String(m[1] || "").trim();
    if (v) cookies.push(v);
  }
  return cookies;
}

function parseHeadersTextToPairs(headersText) {
  if (typeof headersText !== "string" || !headersText.trim()) return [];
  const lines = headersText.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!name) continue;
    out.push({ name, value });
  }
  return out;
}

function decodeDataUrl(url) {
  if (!String(url || "").startsWith("data:")) return null;
  const raw = String(url);
  const commaIdx = raw.indexOf(",");
  if (commaIdx < 0) return null;

  const metaPart = raw.slice(5, commaIdx);
  const dataPart = raw.slice(commaIdx + 1);
  const isBase64 = /;base64/i.test(metaPart);
  const mime = (metaPart.split(";")[0] || "text/plain").trim().toLowerCase() || "text/plain";

  try {
    if (isBase64) {
      return {
        mime,
        isBase64: true,
        buffer: Buffer.from(dataPart, "base64"),
      };
    }
    const decoded = decodeURIComponent(dataPart);
    return {
      mime,
      isBase64: false,
      buffer: Buffer.from(decoded, "utf8"),
    };
  } catch {
    // Fallback for non-URI-encoded payload.
    return {
      mime,
      isBase64: false,
      buffer: Buffer.from(dataPart, "utf8"),
    };
  }
}

function buildBaseMeta({ id, params, requestBodyPath, targetInfo }) {
  const requestHeaderPairs = headersToPairs(params.request.headers || {});
  return {
    id,
    cdp_target_id: targetInfo.id || targetInfo.targetId || null,
    cdp_target_title: targetInfo.title || null,
    cdp_target_url: targetInfo.url || null,
    cdp_request_id: params.requestId,
    loader_id: params.loaderId || null,
    frame_id: params.frameId || null,
    request_url: params.request.url || "",
    request_method: params.request.method || "",
    request_headers: headerPairsToObject(requestHeaderPairs),
    request_headers_list: requestHeaderPairs,
    request_body_path: requestBodyPath,
    request_timestamp: typeof params.timestamp === "number" ? params.timestamp : null,
    wall_time: typeof params.wallTime === "number" ? params.wallTime : null,
    resource_type: params.type || null,
    initiator: params.initiator || {},
    redirect_from: params.redirectResponse ? params.redirectResponse.url || null : null,
    response_status: null,
    response_status_text: null,
    response_headers: {},
    response_headers_list: [],
    response_mime_type: null,
    response_protocol: null,
    response_remote_ip: null,
    response_remote_port: null,
    encoded_data_length: null,
    transfer_size: null,
    response_body_path: null,
    response_body_base64: 0,
    response_body_size: null,
    body_capture_error: null,
    request_intercepted: false,
    response_intercepted: false,
    failed: 0,
    error_text: null,
    created_at: new Date().toISOString(),
  };
}

function captureToStore({
  recordsDir,
  cdpHost,
  cdpPort,
  cdpTarget,
  onTargetsUpdate,
  includeDevtools = false,
}) {
  ensureDir(recordsDir);
  const requestMap = new Map();
  const pendingRequestIntercepted = new Map();
  const pendingRequestHeaders = new Map();
  const targetClients = new Map();
  const attachedTargets = new Map();
  const hooks = getInterceptorHooks();
  let browserClient = null;
  let reconnectTimer = null;
  let lastConnectErrorMessage = "";
  let lastMs = 0;
  let seq = 0;

  function nextRecordId() {
    const nowMs = Date.now();
    if (nowMs === lastMs) seq += 1;
    else {
      lastMs = nowMs;
      seq = 0;
    }
    return `${String(nowMs).padStart(13, "0")}-${String(seq).padStart(4, "0")}`;
  }

  function reqKey(targetId, requestId) {
    return `${targetId}:${requestId}`;
  }

  function getTargetId(targetInfo) {
    return targetInfo && (targetInfo.id || targetInfo.targetId) ? targetInfo.id || targetInfo.targetId : null;
  }

  function normalizeTargetInfo(targetInfo) {
    if (!targetInfo) return null;
    return {
      id: getTargetId(targetInfo),
      targetId: getTargetId(targetInfo),
      title: targetInfo.title || "",
      url: targetInfo.url || "",
      type: targetInfo.type || "",
    };
  }

  function emitTargetsUpdate() {
    if (typeof onTargetsUpdate !== "function") return;
    const targets = Array.from(attachedTargets.values())
      .sort((a, b) => (a.title || "").localeCompare(b.title || ""))
      .map((x) => ({ ...x }));
    onTargetsUpdate(targets);
  }

  function isEligibleTarget(targetInfo) {
    const t = normalizeTargetInfo(targetInfo);
    if (!t || !t.id) return false;
    if (!CAPTURE_TARGET_TYPES.has(String(t.type || ""))) return false;
    if (cdpTarget) return t.id === cdpTarget;
    if (includeDevtools) return true;
    return !String(t.url || "").startsWith("devtools://");
  }

  function ensureReqStateForPaused(targetInfo, params) {
    const netId = params.networkId || params.requestId;
    const key = reqKey(targetInfo.id, netId);
    let reqState = requestMap.get(key);
    if (reqState) return { key, reqState };

    const id = nextRecordId();
    const recordDir = path.join(recordsDir, id);
    ensureDir(recordDir);
    const base = buildBaseMeta({
      id,
      params: {
        requestId: netId,
        loaderId: null,
        frameId: params.frameId || null,
        request: params.request || {},
        timestamp: null,
        wallTime: null,
        type: null,
        initiator: {},
        redirectResponse: null,
      },
      requestBodyPath: null,
      targetInfo,
    });
    const pendingHeaders = pendingRequestHeaders.get(key);
    if (pendingHeaders && typeof pendingHeaders === "object") {
      base.request_headers_list = mergeHeaderPairs(base.request_headers_list, pendingHeaders);
      base.request_headers = headerPairsToObject(base.request_headers_list);
    }
    writeMeta(recordDir, base);
    reqState = {
      id,
      recordDir,
      requestUrl: base.request_url,
      responseMimeType: null,
    };
    requestMap.set(key, reqState);
    return { key, reqState };
  }

  async function attachTarget(targetInfo) {
    const t = normalizeTargetInfo(targetInfo);
    if (!t || !t.id) return;
    if (targetClients.has(t.id)) return;

    try {
      const client = await CDP({
        host: cdpHost,
        port: cdpPort,
        target: t.id,
      });
      targetClients.set(t.id, client);
      attachedTargets.set(t.id, {
        id: t.id,
        title: t.title || "",
        url: t.url || "",
        type: t.type || "page",
        attached_at: new Date().toISOString(),
      });
      emitTargetsUpdate();

      const { Network, Fetch } = client;
        /**
         * 
         * maxTotalBufferSize：DevTools/Inspector 给“所有请求体缓存”分配的总内存上限（整个 target 级别）。
            maxResourceBufferSize：单个请求体最多能在缓存里占用的上限（单条请求级别）。
         */
      await Network.enable({
        maxTotalBufferSize: 100 * 1024 * 1024,
        maxResourceBufferSize: 10 * 1024 * 1024,
      });
      await Fetch.enable({
        patterns: [
          { urlPattern: "*", requestStage: "Request" },
          { urlPattern: "*", requestStage: "Response" },
        ],
      });
      try {
        await Network.setCacheDisabled({ cacheDisabled: true });
      } catch {
      }
      try {
        await Network.setBypassServiceWorker({ bypass: true });
      } catch {
      }

      Network.requestWillBeSent((params) => {
        try {
          const key = reqKey(t.id, params.requestId);
          const id = nextRecordId();
          const recordDir = path.join(recordsDir, id);
          ensureDir(recordDir);

          const requestContentType =
            params.request && params.request.headers
              ? params.request.headers["Content-Type"] || params.request.headers["content-type"]
              : "";
          const requestExt = pickExtFromMime(requestContentType) || "bin";
          const requestBodyPath = params.request.postData
            ? writeBodyFile(recordDir, "request", Buffer.from(params.request.postData, "utf8"), requestExt)
            : null;

          const meta = buildBaseMeta({ id, params, requestBodyPath, targetInfo: t });
          const pendingHeaders = pendingRequestHeaders.get(key);
          if (pendingHeaders && typeof pendingHeaders === "object") {
            meta.request_headers_list = mergeHeaderPairs(meta.request_headers_list, pendingHeaders);
            meta.request_headers = headerPairsToObject(meta.request_headers_list);
          }
          if (pendingRequestIntercepted.get(key) === true) {
            meta.request_intercepted = true;
            pendingRequestIntercepted.delete(key);
          }
          pendingRequestHeaders.delete(key);
          const dataUrlBody = decodeDataUrl(meta.request_url);
          if (dataUrlBody) {
            const ext = pickExtFromMime(dataUrlBody.mime) || "bin";
            meta.response_body_path = writeBodyFile(recordDir, "response", dataUrlBody.buffer, ext);
            meta.response_body_size = dataUrlBody.buffer.length;
            meta.response_body_base64 = dataUrlBody.isBase64 ? 1 : 0;
            meta.response_mime_type = dataUrlBody.mime;
            meta.response_protocol = "data";
            if (meta.response_status == null) meta.response_status = 200;
            if (!meta.response_status_text) meta.response_status_text = "OK";
            meta.response_headers = {
              ...meta.response_headers,
              "Content-Type": dataUrlBody.mime,
            };
            meta.body_capture_error = null;
          }
          writeMeta(recordDir, meta);

          requestMap.set(key, {
            id,
            recordDir,
            requestUrl: meta.request_url,
            responseMimeType: null,
          });
        } catch (err) {
          console.error("requestWillBeSent error:", err.message);
        }
      });

      Network.requestWillBeSentExtraInfo((params) => {
        try {
          const key = reqKey(t.id, params.requestId);
          const reqState = requestMap.get(key);
          if (!reqState) return;
          const metaPath = path.join(reqState.recordDir, "meta.json");
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          meta.request_headers_list = mergeHeaderPairs(meta.request_headers_list, params.headers || {});
          meta.request_headers = headerPairsToObject(meta.request_headers_list);
          writeMeta(reqState.recordDir, meta);
        } catch (err) {
          console.error("requestWillBeSentExtraInfo error:", err.message);
        }
      });

      Network.responseReceived((params) => {
        try {
          const key = reqKey(t.id, params.requestId);
          const reqState = requestMap.get(key);
          if (!reqState) return;

          const metaPath = path.join(reqState.recordDir, "meta.json");
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          const r = params.response || {};

          meta.response_status = typeof r.status === "number" ? Math.floor(r.status) : null;
          meta.response_status_text = r.statusText || null;
          meta.response_headers_list = mergeHeaderPairs(meta.response_headers_list, r.headers || {});
          meta.response_headers = headerPairsToObject(meta.response_headers_list);
          meta.response_mime_type = r.mimeType || null;
          meta.response_protocol = r.protocol || null;
          meta.response_remote_ip = r.remoteIPAddress || null;
          meta.response_remote_port = typeof r.remotePort === "number" ? r.remotePort : null;

          reqState.responseMimeType = meta.response_mime_type;
          if (!reqState.requestUrl && r.url) reqState.requestUrl = r.url;
          writeMeta(reqState.recordDir, meta);
        } catch (err) {
          console.error("responseReceived error:", err.message);
        }
      });

      Network.responseReceivedExtraInfo((params) => {
        try {
          const key = reqKey(t.id, params.requestId);
          const reqState = requestMap.get(key);
          if (!reqState) return;
          const metaPath = path.join(reqState.recordDir, "meta.json");
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          const fromText = parseHeadersTextToPairs(params.headersText);
          if (fromText.length > 0) {
            meta.response_headers_list = mergeHeaderPairs(meta.response_headers_list, fromText);
          } else {
            meta.response_headers_list = mergeHeaderPairs(meta.response_headers_list, params.headers || {});
          }
          meta.response_headers = headerPairsToObject(meta.response_headers_list);
          const setCookieFromText = extractSetCookieFromHeadersText(params.headersText);
          if (setCookieFromText.length > 0) {
            setHeaderWithMerge(meta.response_headers, "Set-Cookie", setCookieFromText);
          }
          if (typeof params.statusCode === "number" && meta.response_status == null) {
            meta.response_status = params.statusCode;
          }
          writeMeta(reqState.recordDir, meta);
        } catch (err) {
          console.error("responseReceivedExtraInfo error:", err.message);
        }
      });

      Network.loadingFinished((params) => {
        try {
          const key = reqKey(t.id, params.requestId);
          const reqState = requestMap.get(key);
          if (!reqState) return;
          const metaPath = path.join(reqState.recordDir, "meta.json");
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          meta.encoded_data_length =
            typeof params.encodedDataLength === "number" ? params.encodedDataLength : null;
          meta.transfer_size =
            typeof params.encodedDataLength === "number" ? params.encodedDataLength : null;
          writeMeta(reqState.recordDir, meta);
          requestMap.delete(key);
          pendingRequestHeaders.delete(key);
        } catch (err) {
          console.error("loadingFinished update error:", err.message);
        }
      });

      Network.loadingFailed((params) => {
        try {
          const key = reqKey(t.id, params.requestId);
          const reqState = requestMap.get(key);
          if (!reqState) return;
          const metaPath = path.join(reqState.recordDir, "meta.json");
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          meta.failed = 1;
          meta.error_text = params.errorText || "Unknown network failure";
          writeMeta(reqState.recordDir, meta);
          requestMap.delete(key);
          pendingRequestHeaders.delete(key);
        } catch (err) {
          console.error("loadingFailed error:", err.message);
        }
      });

      Fetch.requestPaused(async (params) => {
        try {
          const netId = params.networkId || params.requestId;
          const key = reqKey(t.id, netId);

          if (!params.responseStatusCode) {
            if (params.request && params.request.headers) {
              pendingRequestHeaders.set(key, { ...params.request.headers });
              const reqState = requestMap.get(key);
              if (reqState) {
                try {
                  const metaPath = path.join(reqState.recordDir, "meta.json");
                  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
                  meta.request_headers_list = mergeHeaderPairs(meta.request_headers_list, params.request.headers);
                  meta.request_headers = headerPairsToObject(meta.request_headers_list);
                  writeMeta(reqState.recordDir, meta);
                } catch {
                }
              }
            }
            // OnBeforeRequest: allow request mutation before sending.
            if (typeof hooks.onBeforeRequest === "function") {
              try {
                const decision = await hooks.onBeforeRequest({
                  url: params.request?.url || "",
                  method: params.request?.method || "GET",
                  headers: { ...(params.request?.headers || {}) },
                  postData: params.request?.postData || "",
                  resourceType: params.resourceType || "",
                  frameId: params.frameId || "",
                  requestId: netId,
                  target: t,
                });
                if (decision && typeof decision === "object") {
                  const requestModified =
                    decision.url != null ||
                    decision.method != null ||
                    decision.headers != null ||
                    decision.postData != null;
                  const continueArgs = { requestId: params.requestId };
                  if (decision.url) continueArgs.url = String(decision.url);
                  if (decision.method) continueArgs.method = String(decision.method).toUpperCase();
                  if (decision.headers && typeof decision.headers === "object") {
                    continueArgs.headers = headersObjectToArray(decision.headers);
                    pendingRequestHeaders.set(key, { ...decision.headers });
                  }
                  if (decision.postData != null) {
                    const postBuf = toBuffer(decision.postData, { base64: Boolean(decision.postDataBase64) });
                    continueArgs.postData = postBuf.toString("base64");
                  }
                  if (requestModified) {
                    pendingRequestIntercepted.set(key, true);
                    const reqState = requestMap.get(key);
                    if (reqState) {
                      try {
                        const metaPath = path.join(reqState.recordDir, "meta.json");
                        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
                        meta.request_intercepted = true;
                        writeMeta(reqState.recordDir, meta);
                      } catch {
                      }
                    }
                  }
                  await Fetch.continueRequest(continueArgs);
                  return;
                }
              } catch (err) {
                console.error("onBeforeRequest hook error:", err.message);
              }
            }
            await Fetch.continueRequest({ requestId: params.requestId });
            return;
          }

          // OnBeforeResponse: allow response/header/body mutation.
          const { reqState } = ensureReqStateForPaused(t, params);
          const metaPath = path.join(reqState.recordDir, "meta.json");
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          const pausedHeaders = headersArrayToObject(params.responseHeaders);
          meta.response_headers_list = mergeHeaderPairs(meta.response_headers_list, params.responseHeaders);
          meta.response_headers = headerPairsToObject(meta.response_headers_list);
          const contentType =
            pausedHeaders["content-type"] ||
            pausedHeaders["Content-Type"] ||
            meta.response_mime_type ||
            null;
          if (contentType) {
            meta.response_mime_type = String(contentType).split(";")[0].trim().toLowerCase();
          }
          if (typeof params.responseStatusCode === "number") meta.response_status = params.responseStatusCode;
          if (typeof params.responseStatusText === "string") meta.response_status_text = params.responseStatusText;

          let rawBodyBuf = null;
          let rawBodyBase64 = false;
          try {
            const bodyResult = await Fetch.getResponseBody({ requestId: params.requestId });
            if (bodyResult && typeof bodyResult.body === "string") {
              rawBodyBase64 = Boolean(bodyResult.base64Encoded);
              rawBodyBuf = toBuffer(bodyResult.body, { base64: rawBodyBase64 });
            }
          } catch (err) {
            meta.body_capture_error = err && err.message ? err.message : "Fetch.getResponseBody failed";
          }

          let finalStatusCode = meta.response_status || 200;
          let finalHeaders = { ...(meta.response_headers || {}) };
          let finalBodyBuf = rawBodyBuf;
          let modified = false;

          if (typeof hooks.onBeforeResponse === "function") {
            try {
              const decision = await hooks.onBeforeResponse({
                url: reqState.requestUrl || params.request?.url || "",
                method: meta.request_method || params.request?.method || "GET",
                statusCode: finalStatusCode,
                headers: { ...finalHeaders },
                body: finalBodyBuf,
                bodyText: finalBodyBuf ? finalBodyBuf.toString("utf8") : "",
                resourceType: params.resourceType || "",
                frameId: params.frameId || "",
                requestId: netId,
                target: t,
              });
              if (decision && typeof decision === "object") {
                if (decision.statusCode != null) {
                  finalStatusCode = Number(decision.statusCode) || finalStatusCode;
                  modified = true;
                }
                if (decision.headers && typeof decision.headers === "object") {
                  finalHeaders = { ...decision.headers };
                  modified = true;
                }
                if (decision.body != null) {
                  finalBodyBuf = toBuffer(decision.body, { base64: Boolean(decision.bodyBase64) });
                  modified = true;
                } else if (decision.bodyText != null) {
                  finalBodyBuf = Buffer.from(String(decision.bodyText), "utf8");
                  modified = true;
                }
              }
            } catch (err) {
              console.error("onBeforeResponse hook error:", err.message);
            }
          }

          if (finalBodyBuf) {
            const ext =
              pickExtFromMime(meta.response_mime_type) ||
              pickExtFromUrl(reqState.requestUrl) ||
              "bin";
            meta.response_body_path = writeBodyFile(reqState.recordDir, "response", finalBodyBuf, ext);
            meta.response_body_size = finalBodyBuf.length;
            meta.response_body_base64 = 1;
            meta.body_capture_error = null;
          }

          meta.response_status = finalStatusCode;
          meta.response_headers = finalHeaders;
          if (modified) {
            meta.response_intercepted = true;
          }
          writeMeta(reqState.recordDir, meta);

          if (modified) {
            if (finalBodyBuf) {
              setHeaderWithMerge(finalHeaders, "Content-Length", String(finalBodyBuf.length));
            }
            await Fetch.fulfillRequest({
              requestId: params.requestId,
              responseCode: finalStatusCode,
              responseHeaders: headersObjectToArray(finalHeaders),
              body: finalBodyBuf ? finalBodyBuf.toString("base64") : undefined,
            });
          } else {
            await Fetch.continueRequest({ requestId: params.requestId });
          }
          return;
        } catch (err) {
          console.error("Fetch.requestPaused error:", err.message);
          try {
            await Fetch.continueRequest({ requestId: params.requestId });
          } catch (e2) {
            console.error("Fetch.continueRequest error:", e2.message);
          }
        }
      });

      client.on("disconnect", () => {
        targetClients.delete(t.id);
        attachedTargets.delete(t.id);
        emitTargetsUpdate();
      });

      console.log(`CDP attached target: ${t.id} ${t.title || ""}`);
    } catch (err) {
      console.error(`Attach target failed (${t.id}):`, err.message);
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectBrowser().catch(() => {
        // connectBrowser logs and reschedules itself.
      });
    }, 1500);
  }

  async function connectBrowser() {
    try {
      if (browserClient) return browserClient;
      const client = await CDP({ host: cdpHost, port: cdpPort });
      browserClient = client;

      const { Target } = client;
      await Target.setDiscoverTargets({ discover: true });

      const onTargetInfo = (targetInfo) => {
        const t = normalizeTargetInfo(targetInfo);
        if (!t || !t.id) return;
        if (attachedTargets.has(t.id)) {
          const prev = attachedTargets.get(t.id);
          attachedTargets.set(t.id, {
            ...prev,
            title: t.title || prev.title || "",
            url: t.url || prev.url || "",
            type: t.type || prev.type || "page",
          });
          emitTargetsUpdate();
        }
        if (isEligibleTarget(t)) {
          attachTarget(t).catch((err) => {
            console.error(`Auto-attach failed (${t.id}):`, err.message);
          });
        }
      };

      Target.targetCreated(({ targetInfo }) => {
        onTargetInfo(targetInfo);
      });

      Target.targetInfoChanged(({ targetInfo }) => {
        onTargetInfo(targetInfo);
      });

      Target.targetDestroyed(({ targetId }) => {
        attachedTargets.delete(targetId);
        targetClients.delete(targetId);
        emitTargetsUpdate();
      });

      const { targetInfos } = await Target.getTargets();
      await Promise.all((targetInfos || []).filter(isEligibleTarget).map((t) => attachTarget(t)));

      client.on("disconnect", () => {
        browserClient = null;
        const msg = "browser connection disconnected";
        if (msg !== lastConnectErrorMessage) {
          console.error(`CDP browser connection lost: ${msg}`);
          lastConnectErrorMessage = msg;
        }
        scheduleReconnect();
      });

      lastConnectErrorMessage = "";
      return client;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (msg !== lastConnectErrorMessage) {
        console.error(`CDP browser connect failed: ${msg}`);
        console.error("Waiting for Chrome CDP to become available...");
        lastConnectErrorMessage = msg;
      }
      scheduleReconnect();
      return null;
    }
  }

  const start = async () => {
    await connectBrowser();
    console.log(`CDP multi-target watcher running at ${cdpHost}:${cdpPort}`);
    return {
      stop() {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (browserClient) {
          try {
            browserClient.close();
          } catch {
          }
          browserClient = null;
        }
      },
    };
  };

  return start();
}

module.exports = {
  captureToStore,
  ensureDir,
};
