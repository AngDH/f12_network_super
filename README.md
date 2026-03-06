# Network Super

[中文](./README.zh-CN.md)

`Network Super` is a Fiddler-like browser network inspector built with Chrome DevTools Protocol (CDP).
It captures requests and responses from Chrome tabs, persists them locally as files, supports full-text search across URL/headers/body, and provides interception hooks (`OnBeforeRequest` / `OnBeforeResponse`) for traffic rewriting.

## Features

- Persistent capture: store metadata in `meta.json` and bodies as files on disk
- Multi-tab listening: auto attach to browser tabs, with optional `devtools://` filtering
- Search everywhere: URL, request headers, response headers, request body, response body
- Rich viewer: headers/preview/response/meta panels, file-folder shortcut, row marking
- Traffic interception: mutate request and response through `interceptor-rules.js`
- File-based storage: easy to inspect, copy, archive, and diff

## Prerequisites

- Node.js 18+
- Chrome or Chromium

## Start Chrome With CDP

Use a dedicated browser profile for safety:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="D:\tmp\chrome-cdp-profile"
```

## Install And Run

```powershell
npm install
npm start
```

Open UI:

- `http://127.0.0.1:3100`

## Storage Layout

- Records: `data/records/{id}/meta.json`
- Body files: `data/records/{id}/request.<ext>` and `data/records/{id}/response.<ext>`

## Environment Variables

- `PORT` default `3100`
- `CDP_HOST` default `127.0.0.1`
- `CDP_PORT` default `9222`
- `CDP_TARGET` default empty (auto target attach)
- `CAPTURE_DEVTOOLS` default `0` (set `1` to include `devtools://` tabs)
- `CAPTURE_EXTRA_TARGET_TYPES` default empty (optional: `worker,shared_worker,service_worker,webview`)
- `DATA_DIR` default `./data`

### CAPTURE_EXTRA_TARGET_TYPES usage

By default, Network Super only auto-attaches stable targets: `page,iframe`.

If you also want worker-like targets, set env var before start:

```powershell
$env:CAPTURE_EXTRA_TARGET_TYPES="worker,shared_worker,service_worker,webview"
npm start
```

Only enable `worker`:

```powershell
$env:CAPTURE_EXTRA_TARGET_TYPES="worker"
npm start
```

## Interception Hooks

Edit `interceptor-rules.js` to modify traffic:

- `onBeforeRequest(ctx)`: mutate request URL, method, headers, or body before sending
- `onBeforeResponse(ctx)`: mutate response status, headers, or body before returning to browser

After editing rules, restart the server:

```powershell
npm start
```

## Notes

- Stability: default auto-attach is limited to `page` and `iframe` targets to reduce crash/disconnect risks.
- If you need extra target types, enable them with `CAPTURE_EXTRA_TARGET_TYPES`.
- Some special requests may still have body capture limitations depending on browser behavior.
- Existing records are file-based and are not backfilled when capture logic changes.
