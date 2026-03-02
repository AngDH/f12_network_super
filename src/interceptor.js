const path = require("path");

const NOOP = async () => null;

function getInterceptorHooks() {
  const rulesPath = path.resolve(process.cwd(), "interceptor-rules.js");
  try {
    // Reload on each process start; user edits require restart.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(rulesPath);
    return {
      onBeforeRequest: typeof mod.onBeforeRequest === "function" ? mod.onBeforeRequest : NOOP,
      onBeforeResponse: typeof mod.onBeforeResponse === "function" ? mod.onBeforeResponse : NOOP,
    };
  } catch (err) {
    if (err && err.code !== "MODULE_NOT_FOUND") {
      console.error("Failed to load interceptor-rules.js:", err.message);
    }
    return {
      onBeforeRequest: NOOP,
      onBeforeResponse: NOOP,
    };
  }
}

module.exports = {
  getInterceptorHooks,
};

