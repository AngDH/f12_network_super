# Network Super

[English](./README.md)

`Network Super` 是一个基于 Chrome DevTools Protocol（CDP）实现的浏览器抓包与改包工具，定位类似 Fiddler 的浏览器侧网络调试器。
它可以抓取 Chrome 标签页中的请求与响应，并将数据持久化保存到本地文件中，同时支持全文搜索、请求/响应拦截改写，以及 **Browser Send**（通过 CDP 控制浏览器发请求，而不是仅用 Node fetch）。

## 功能特性

- 持久化抓包：元数据保存为 `meta.json`，请求体和响应体保存为文件
- 多标签页监听：自动附加多个 Chrome 页面，可选择排除 `devtools://`
- 默认稳定监听：默认只附加 `page/iframe`，降低崩溃和断连风险
- 全局搜索：支持 URL、请求头、响应头、请求体、响应体全文检索
- 可视化查看：支持 Headers / Preview / Response / Meta 面板
- 请求标记：支持右键颜色标记，并保存在浏览器本地
- 拦截改写：通过 `interceptor-rules.js` 实现 `OnBeforeRequest` / `OnBeforeResponse`
- Browser Send 与 Replay：可把抓包记录一键带入 Send 页面，编辑后通过已连接的 Chrome 标签页（CDP）发送
- 文件化存储：便于直接查看、复制、归档和比对

## 运行要求

- Node.js 18+
- Chrome / Chromium

## 启动 Chrome（开启 CDP）

建议使用独立浏览器目录：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="D:\tmp\chrome-cdp-profile"
```

## 安装与启动

```powershell
npm install
npm start
```

打开界面：

- `http://127.0.0.1:3100`

## 数据存储结构

- 记录目录：`data/records/{id}/meta.json`
- Body 文件：`data/records/{id}/request.<ext>` 和 `data/records/{id}/response.<ext>`

## 环境变量

- `PORT` 默认 `3100`
- `CDP_HOST` 默认 `127.0.0.1`
- `CDP_PORT` 默认 `9222`
- `CDP_TARGET` 默认空（自动附加 target）
- `CAPTURE_DEVTOOLS` 默认 `0`（设置为 `1` 时包含 `devtools://` 标签页）
- `CAPTURE_EXTRA_TARGET_TYPES` 默认空（可选：`worker,shared_worker,service_worker,webview`）
- `DATA_DIR` 默认 `./data`

### CAPTURE_EXTRA_TARGET_TYPES 使用方式

默认情况下，Network Super 只自动附加更稳定的 target：`page,iframe`。

如果你也要抓 worker 等类型，可在启动前设置环境变量：

```powershell
$env:CAPTURE_EXTRA_TARGET_TYPES="worker,shared_worker,service_worker,webview"
npm start
```

只开启 `worker` 示例：

```powershell
$env:CAPTURE_EXTRA_TARGET_TYPES="worker"
npm start
```

## 拦截规则

你可以编辑 `interceptor-rules.js` 来修改流量：

- `onBeforeRequest(ctx)`：在请求发出前修改 URL、方法、请求头、请求体
- `onBeforeResponse(ctx)`：在响应返回前修改状态码、响应头、响应体

修改规则后，重启服务：

```powershell
npm start
```

## 说明

- 稳定性优化：默认只自动附加 `page/iframe`，避免不稳定 target 导致的反复 attach/断连。
- 如需监听更多类型，可通过 `CAPTURE_EXTRA_TARGET_TYPES` 按需开启。
- 某些特殊请求是否能抓到完整 body 仍受浏览器行为限制。
- 抓包记录是文件化保存的，采集逻辑更新后不会自动补写旧记录。
