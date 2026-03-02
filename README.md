# Network Super

`Network Super` is a Fiddler-like browser network inspector built with Chrome DevTools Protocol (CDP).
It captures requests/responses from Chrome tabs, persists them locally as files, supports full-text search (URL/headers/body), and provides request/response interception hooks (`OnBeforeRequest` / `OnBeforeResponse`) for traffic rewriting.

## Features

- Persistent capture: store metadata in `meta.json` and bodies as files on disk
- Multi-tab listening: auto attach to browser tabs (with optional `devtools://` filtering)
- Search everywhere: URL, request headers, response headers, request body, response body
- Rich viewer: headers/preview/response/meta panels, cookie visibility in headers, response file folder shortcut
- Traffic interception: mutate request and response through `interceptor-rules.js`
- Request marking: right-click color marks for important rows (local persistence)

## 1) Prerequisites

- Node.js 18+
- Chrome (or Chromium)

## 2) Start Chrome with CDP

Use a dedicated browser profile for safety:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="D:\tmp\chrome-cdp-profile"
```

## 3) Install and run

```powershell
npm install
npm start
```

Open UI:

- `http://127.0.0.1:3100`

## 4) What gets stored

- Records: `data/records/{id}/meta.json`
- Body files: `data/records/{id}/request.<ext>` and `data/records/{id}/response.<ext>`

## 5) Environment variables (optional)

- `PORT` default `3100`
- `CDP_HOST` default `127.0.0.1`
- `CDP_PORT` default `9222`
- `CDP_TARGET` default empty (CDP auto target)
- `CAPTURE_DEVTOOLS` default `0` (set `1` to include `devtools://` tabs)
- `DATA_DIR` default `./data`

## Notes

- CDP may not return body for some requests (cache/service worker/special streams).
- Current version focuses on HTTP request/response capture and persistence.

## Interception Hooks (Fiddler-like)

You can edit `interceptor-rules.js` to modify traffic:

- `onBeforeRequest(ctx)`: mutate request URL/method/headers/body before sending.
- `onBeforeResponse(ctx)`: mutate response status/headers/body before returning to browser.

After editing, restart server:

```powershell
npm start
```
