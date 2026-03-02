// Edit this file to implement request/response interception rules.
// Restart the server after changes.
//
// Hook input:
// - onBeforeRequest(ctx): { url, method, headers, postData, resourceType, frameId, requestId, target }
// - onBeforeResponse(ctx): { url, method, statusCode, headers, body(Buffer|null), bodyText, resourceType, frameId, requestId, target }
//
// Hook return (optional):
// onBeforeRequest:
//   { url?, method?, headers?, postData?, postDataBase64? }
// onBeforeResponse:
//   { statusCode?, headers?, body?, bodyBase64?, bodyText? }

module.exports = {
  async onBeforeRequest(ctx) {
    // Example:
    // if (ctx.method === "GET" && ctx.url.includes("jquery.min.js")) {
    //   const h = { ...ctx.headers, "x-debug": "1" };
    //   return { headers: h };
    // }
    //
    // if (ctx.method === "POST" && ctx.url.includes("/api/test")) {
    //   const h = { ...ctx.headers, "x-debug": "1" };
    //   // ctx.postData is original request body (string)
    //   return { headers: h, postData: ctx.postData };
    // }
    return null;
  },

  async onBeforeResponse(ctx) {
    // Example:
    // if (
    //   (ctx.method === "GET" || ctx.method === "POST") &&
    //   ctx.url.includes("/api/test") &&
    //   ctx.headers["content-type"]?.includes("application/json")
    // ) {
    //   const body = JSON.parse(ctx.bodyText || "{}");
    //   body.injected = true;
    //   return { bodyText: JSON.stringify(body), headers: { ...ctx.headers, "content-type": "application/json" } };
    // }
    return null;
  },
};
