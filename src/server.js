const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
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
