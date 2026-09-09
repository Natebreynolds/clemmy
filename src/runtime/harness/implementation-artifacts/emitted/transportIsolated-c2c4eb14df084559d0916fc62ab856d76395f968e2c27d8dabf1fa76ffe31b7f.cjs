var import_meta_url = require("node:url").pathToFileURL(__filename).href;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/runtime/harness/implementation-artifacts/transport-isolated-entry.ts
var transport_isolated_entry_exports = {};
__export(transport_isolated_entry_exports, {
  bindIsolatedTransportHandler: () => bindIsolatedTransportHandler,
  createAttestedTransport: () => createAttestedTransport,
  executeAttestedTransport: () => executeAttestedTransport,
  isolatedTransportCalls: () => isolatedTransportCalls,
  observeAttestedTransport: () => observeAttestedTransport,
  prepareAttestedComposioDispatch: () => prepareAttestedComposioDispatch,
  reconcileAttestedTransport: () => reconcileAttestedTransport,
  refreshAttestedTransportObservation: () => refreshAttestedTransportObservation,
  registerIsolatedObservation: () => registerIsolatedObservation
});
module.exports = __toCommonJS(transport_isolated_entry_exports);
var import_node_crypto5 = require("node:crypto");
var import_node_fs4 = require("node:fs");
var import_node_os2 = __toESM(require("node:os"), 1);
var import_node_path4 = __toESM(require("node:path"), 1);

// src/runtime/security.ts
function isPlaceholderSecret(value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return normalized === "changeme" || normalized === "change-me" || normalized === "placeholder" || normalized === "secret" || normalized === "webhook_secret" || normalized.includes("replace_me") || normalized.includes("your_") || normalized.includes("example");
}
function isStrongLocalSecret(value) {
  const trimmed = value.trim();
  if (trimmed.length < 24) return false;
  if (isPlaceholderSecret(trimmed)) return false;
  return /[A-Za-z]/.test(trimmed) && /[0-9_-]/.test(trimmed);
}
function isSecretLikeKey(input) {
  const normalized = String(input ?? "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) return false;
  const words = new Set(normalized.split("_").filter(Boolean));
  if (words.has("token") || words.has("tokens") || words.has("secret") || words.has("secrets") || words.has("password") || words.has("passwords") || words.has("passwd") || words.has("credential") || words.has("credentials") || words.has("authorization") || words.has("bearer") || words.has("jwt") || words.has("cookie") || normalized === "auth" || normalized === "proxy_authorization" || normalized === "set_cookie") {
    return true;
  }
  const joined = `_${normalized}_`;
  return joined.includes("_api_key_") || joined.includes("_private_key_") || joined.includes("_signing_key_") || joined.includes("_encryption_key_") || joined.includes("_access_key_") || normalized === "x_api_key" || normalized === "mcp_headers" || normalized === "mcp_env";
}
function redactSecretAssignments(input) {
  const redactQuoted = input.replace(
    /(["'])([^"'\r\n]{1,80})\1(\s*[:=]\s*)(["'])(.*?)\4/g,
    (match, keyQuote, key, separator, valueQuote) => isSecretLikeKey(key) ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}` : match
  );
  return redactQuoted.replace(
    /\b([A-Za-z][A-Za-z0-9_.-]{0,80})(\s*[:=]\s*)(?:(?:Bearer|Basic|Bot)\s+[A-Za-z0-9._~+/=-]+|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    (match, key, separator) => isSecretLikeKey(key) ? `${key}${separator}[REDACTED]` : match
  );
}
function redactSensitiveText(input) {
  let text = typeof input === "string" ? input : String(input ?? "");
  if (!text) return text;
  text = redactSecretAssignments(text);
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, (match) => `${match.slice(0, 10)}...REDACTED`);
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]");
  text = text.replace(/\bBot\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bot [REDACTED]");
  text = text.replace(/([?&](?:token|access_token|refresh_token|api_key|secret)=)[^&#\s"']+/gi, "$1[REDACTED]");
  text = text.replace(/((?:Authorization|authorization)\s*[:=]\s*)(?:Bearer|Bot)?\s*[A-Za-z0-9._~+/=-]{12,}/g, "$1[REDACTED]");
  text = text.replace(
    /((?:OPENAI|COMPOSIO|DISCORD|WEBHOOK|RECALL|CODEX|MCP|AUTH)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)\s*[=:]\s*)("[^"]+"|'[^']+'|\S+)/gi,
    "$1[REDACTED]"
  );
  text = text.replace(
    /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|password|token|headers?)"\s*:\s*)("[^"]+"|\{[^}]*\}|\[[^\]]*\])/gi,
    '$1"[REDACTED]"'
  );
  return text;
}

// src/runtime/harness/reviewed-cli-read-transport.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto4 = require("node:crypto");

// src/shared/closed-canonical-json.ts
var RESERVED_KEYS = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
var CLOSED_CANONICAL_JSON_DEFAULTS = Object.freeze({
  maxDepth: 32,
  maxNodes: 2e4,
  maxStringBytes: 64e3,
  maxTotalBytes: 512e3
});
var SEALED_CALL_CANONICAL_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 2e6,
  maxStringBytes: 8e6,
  maxTotalBytes: 8e6
});
var ClosedCanonicalJsonError = class extends Error {
  constructor(message, code, path5) {
    super(`${message} at ${path5}`);
    this.code = code;
    this.path = path5;
    this.name = "ClosedCanonicalJsonError";
  }
  code;
  path;
};
function positiveLimit(value, fallback) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
function closedCanonicalJson(value, options = {}) {
  const maxDepth = positiveLimit(options.maxDepth, CLOSED_CANONICAL_JSON_DEFAULTS.maxDepth);
  const maxNodes = positiveLimit(options.maxNodes, CLOSED_CANONICAL_JSON_DEFAULTS.maxNodes);
  const maxStringBytes = positiveLimit(
    options.maxStringBytes,
    CLOSED_CANONICAL_JSON_DEFAULTS.maxStringBytes
  );
  const maxTotalBytes = positiveLimit(
    options.maxTotalBytes,
    CLOSED_CANONICAL_JSON_DEFAULTS.maxTotalBytes
  );
  const seen = /* @__PURE__ */ new Set();
  let nodes = 0;
  let bytes = 0;
  const token = (text, path5) => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maxTotalBytes) {
      throw new ClosedCanonicalJsonError(
        "canonical JSON exceeds the total byte limit",
        "total_byte_limit",
        path5
      );
    }
    return text;
  };
  const encodeString = (text, path5) => {
    if (Buffer.byteLength(text, "utf8") > maxStringBytes) {
      throw new ClosedCanonicalJsonError(
        "string exceeds the canonical JSON string limit",
        "string_limit",
        path5
      );
    }
    return token(JSON.stringify(text), path5);
  };
  const visit = (input, path5, depth) => {
    nodes += 1;
    if (nodes > maxNodes) {
      throw new ClosedCanonicalJsonError("canonical JSON exceeds the node limit", "node_limit", path5);
    }
    if (depth > maxDepth) {
      throw new ClosedCanonicalJsonError("canonical JSON exceeds the depth limit", "depth_limit", path5);
    }
    if (input === null) return token("null", path5);
    if (typeof input === "string") return encodeString(input, path5);
    if (typeof input === "boolean") return token(input ? "true" : "false", path5);
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new ClosedCanonicalJsonError("number is not finite", "non_finite_number", path5);
      }
      return token(JSON.stringify(input), path5);
    }
    if (typeof input !== "object") {
      throw new ClosedCanonicalJsonError("value is outside the closed JSON domain", "unsupported_type", path5);
    }
    if (seen.has(input)) {
      throw new ClosedCanonicalJsonError("value is cyclic", "cyclic", path5);
    }
    if (Object.getOwnPropertySymbols(input).length > 0) {
      throw new ClosedCanonicalJsonError("symbol keys are not JSON data", "symbol_key", path5);
    }
    const prototype = Object.getPrototypeOf(input);
    if (Array.isArray(input)) {
      if (prototype !== Array.prototype) {
        throw new ClosedCanonicalJsonError("array has a foreign prototype", "non_plain_object", path5);
      }
      const descriptors2 = Object.getOwnPropertyDescriptors(input);
      const names = Object.getOwnPropertyNames(input);
      for (const name of names) {
        if (name === "length") continue;
        if (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= input.length) {
          throw new ClosedCanonicalJsonError(
            "array has an extra non-index property",
            "extra_array_property",
            `${path5}.${name}`
          );
        }
      }
      seen.add(input);
      try {
        token("[", path5);
        const children = [];
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = descriptors2[String(index)];
          if (!descriptor) {
            throw new ClosedCanonicalJsonError("array is sparse", "sparse_array", `${path5}[${index}]`);
          }
          if ("get" in descriptor || "set" in descriptor) {
            throw new ClosedCanonicalJsonError(
              "accessor properties are not canonical JSON",
              "accessor_property",
              `${path5}[${index}]`
            );
          }
          if (index > 0) token(",", path5);
          children.push(visit(descriptor.value, `${path5}[${index}]`, depth + 1));
        }
        token("]", path5);
        return `[${children.join(",")}]`;
      } finally {
        seen.delete(input);
      }
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ClosedCanonicalJsonError("object is not plain JSON", "non_plain_object", path5);
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.getOwnPropertyNames(input).sort();
    seen.add(input);
    try {
      token("{", path5);
      const fields = [];
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        const keyPath = `${path5}.${key}`;
        if (RESERVED_KEYS.has(key)) {
          throw new ClosedCanonicalJsonError("reserved prototype key is forbidden", "reserved_key", keyPath);
        }
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || "get" in descriptor || "set" in descriptor) {
          throw new ClosedCanonicalJsonError(
            "hidden or accessor properties are not canonical JSON",
            "accessor_property",
            keyPath
          );
        }
        if (options.omitUndefinedObjectMembers === true && descriptor.value === void 0) {
          nodes += 1;
          if (nodes > maxNodes) {
            throw new ClosedCanonicalJsonError("canonical JSON exceeds the node limit", "node_limit", keyPath);
          }
          if (Buffer.byteLength(key, "utf8") > maxStringBytes) {
            throw new ClosedCanonicalJsonError("string exceeds the canonical JSON string limit", "string_limit", keyPath);
          }
          continue;
        }
        if (fields.length > 0) token(",", path5);
        const encodedKey = encodeString(key, keyPath);
        token(":", keyPath);
        fields.push(`${encodedKey}:${visit(descriptor.value, keyPath, depth + 1)}`);
      }
      token("}", path5);
      return `{${fields.join(",")}}`;
    } finally {
      seen.delete(input);
    }
  };
  const encoded = visit(value, "$", 0);
  if (Buffer.byteLength(encoded, "utf8") > maxTotalBytes) {
    throw new ClosedCanonicalJsonError(
      "canonical JSON exceeds the total byte limit",
      "total_byte_limit",
      "$"
    );
  }
  return encoded;
}

// src/shared/stable-json-digest.ts
var import_node_crypto = require("node:crypto");
function stableJsonStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  const entries = Object.entries(value).filter(([, nested]) => nested !== void 0).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJsonStringify(nested)}`).join(",")}}`;
}
function stableJsonDigest(value) {
  return (0, import_node_crypto.createHash)("sha256").update(stableJsonStringify(value)).digest("hex");
}
function stableJsonFingerprint(value) {
  return stableJsonDigest(value).slice(0, 32);
}

// src/runtime/harness/reviewed-cli-read-config.ts
var import_node_crypto3 = require("node:crypto");
var import_node_fs3 = require("node:fs");
var import_node_path3 = __toESM(require("node:path"), 1);

// src/config.ts
var import_node_async_hooks = require("node:async_hooks");
var import_node_fs = require("node:fs");
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_node_url = require("node:url");
var __filename = (0, import_node_url.fileURLToPath)(import_meta_url);
var __dirname = import_node_path.default.dirname(__filename);
var PKG_DIR = import_node_path.default.resolve(__dirname, "..");
function realUserHome() {
  try {
    return import_node_os.default.userInfo().homedir;
  } catch {
    return import_node_os.default.homedir();
  }
}
var REAL_USER_HOME = process.env.CLEMMY_REAL_USER_HOME || realUserHome();
var REAL_DEFAULT_CLEMENTINE_HOME = import_node_path.default.resolve(import_node_path.default.join(REAL_USER_HOME, ".clementine-next"));
var DEFAULT_BASE_DIR = process.env.CLEMENTINE_HOME || REAL_DEFAULT_CLEMENTINE_HOME;
function isTestProcess() {
  return Boolean(
    process.env.NODE_TEST_CONTEXT || process.env.CLEMMY_TEST_ISOLATED_HOME === "1" || process.argv.includes("--test")
  );
}
if (isTestProcess() && import_node_path.default.resolve(DEFAULT_BASE_DIR) === REAL_DEFAULT_CLEMENTINE_HOME && process.env.CLEMMY_ALLOW_LIVE_HOME_TESTS !== "1") {
  throw new Error(
    "Refusing to bind BASE_DIR to the live Clementine home from a test process. Set CLEMENTINE_HOME to a unique temp directory before importing config, or set CLEMMY_ALLOW_LIVE_HOME_TESTS=1 for an explicit destructive test."
  );
}
var BASE_DIR = DEFAULT_BASE_DIR;
function parseEnvFile(envPath) {
  if (!(0, import_node_fs.existsSync)(envPath)) return {};
  const result = {};
  for (const rawLine of (0, import_node_fs.readFileSync)(envPath, "utf-8").split("\n")) {
    const line = rawLine.replace(/^\s+|\r+$/g, "");
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1);
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
function envSearchPaths() {
  if (process.env.CLEMMY_TEST_ISOLATED_HOME === "1") {
    return [import_node_path.default.join(BASE_DIR, ".env")];
  }
  return [
    import_node_path.default.join(PKG_DIR, ".env"),
    import_node_path.default.join(process.cwd(), ".env"),
    import_node_path.default.join(BASE_DIR, ".env")
  ];
}
var ACTIVE_ENV_FILES = envSearchPaths().filter((filePath, index, items) => (0, import_node_fs.existsSync)(filePath) && items.indexOf(filePath) === index);
var env = Object.assign({}, ...ACTIVE_ENV_FILES.map((filePath) => parseEnvFile(filePath)));
function getEnv(key, fallback = "") {
  return process.env[key] ?? env[key] ?? fallback;
}
function parseCsvEnv(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}
function normalizeWebhookHost(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "localhost") return "127.0.0.1";
  if (trimmed === "::1") return "::1";
  if (trimmed === "0.0.0.0" || trimmed === "::") return trimmed;
  if (/^[A-Za-z0-9.-]+$/.test(trimmed) || /^[0-9a-f:.]+$/i.test(trimmed)) return trimmed;
  return "127.0.0.1";
}
var runtimeEnvReadObserverForTest;
var runtimeConfigCaptureObserverForTest;
function captureRuntimeEnvironment() {
  const activeEnvFiles = envSearchPaths().filter((filePath, index, items) => (0, import_node_fs.existsSync)(filePath) && items.indexOf(filePath) === index);
  const currentEnv = Object.assign({}, ...activeEnvFiles.map((filePath) => parseEnvFile(filePath)));
  runtimeConfigCaptureObserverForTest?.("environment");
  return Object.freeze(currentEnv);
}
function captureSecretVault() {
  const vaultPath = import_node_path.default.join(BASE_DIR, "state", "secrets-vault.json");
  let entries = {};
  if ((0, import_node_fs.existsSync)(vaultPath)) {
    try {
      const parsed = JSON.parse((0, import_node_fs.readFileSync)(vaultPath, "utf-8"));
      if (parsed.version === "v1" && parsed.entries) entries = { ...parsed.entries };
    } catch {
      entries = {};
    }
  }
  runtimeConfigCaptureObserverForTest?.("secret_vault");
  return Object.freeze(entries);
}
var runtimeConfigRequestStorage = new import_node_async_hooks.AsyncLocalStorage();
function getRuntimeEnv(key, fallback = "") {
  runtimeEnvReadObserverForTest?.(key);
  const requestSnapshot = runtimeConfigRequestStorage.getStore();
  if (requestSnapshot) {
    return process.env[key] ?? requestSnapshot.environmentValue(key) ?? fallback;
  }
  return process.env[key] ?? captureRuntimeEnvironment()[key] ?? fallback;
}
function readSecretFromFileVaultSync(name) {
  const requestSnapshot = runtimeConfigRequestStorage.getStore();
  const value = requestSnapshot ? requestSnapshot.secretValue(name) : captureSecretVault()[name];
  return value && value.length > 0 ? value : void 0;
}
function getOpenAiApiKey() {
  const fromFile = readSecretFromFileVaultSync("openai_api_key");
  if (fromFile) return fromFile;
  const fromEnv = getRuntimeEnv("OPENAI_API_KEY", "");
  return fromEnv ?? "";
}
function resolveOpenAiAgentsTracingDisabled(configuredValue, apiKey) {
  const configured = configuredValue?.trim().toLowerCase() ?? "";
  if (configured === "1" || configured === "true" || configured === "on") return "1";
  if (configured) return void 0;
  return apiKey.trim() ? void 0 : "1";
}
var agentsTracingDisabled = resolveOpenAiAgentsTracingDisabled(
  getEnv("OPENAI_AGENTS_DISABLE_TRACING", ""),
  getOpenAiApiKey()
);
if (agentsTracingDisabled) process.env.OPENAI_AGENTS_DISABLE_TRACING = agentsTracingDisabled;
var ASSISTANT_NAME = getEnv("ASSISTANT_NAME", "Clementine");
var OWNER_NAME = getEnv("OWNER_NAME", "");
var OPENAI_API_KEY = getEnv("OPENAI_API_KEY", "");
var AUTH_MODE = (() => {
  const raw = getEnv("AUTH_MODE", "api_key");
  if (raw === "codex_oauth") return "codex_oauth";
  if (raw === "claude_oauth") return "claude_oauth";
  return "api_key";
})();
var CODEX_AUTH_SOURCE_FILE = getEnv("CODEX_AUTH_SOURCE_FILE", import_node_path.default.join(import_node_os.default.homedir(), ".codex", "auth.json"));
var CODEX_EXECUTABLE = getEnv("CODEX_EXECUTABLE", "codex");
var CODEX_INSTALL_PACKAGE = getEnv("CODEX_INSTALL_PACKAGE", "@openai/codex");
var CODEX_SANDBOX_MODE = getEnv("CODEX_SANDBOX_MODE", "workspace-write");
var CODEX_USE_FULL_AUTO = getEnv("CODEX_USE_FULL_AUTO", "true").toLowerCase() === "true";
var VAULT_DIR = import_node_path.default.join(BASE_DIR, "vault");
var WEBHOOK_ENABLED = getEnv("WEBHOOK_ENABLED", "false").toLowerCase() === "true";
var WEBHOOK_PORT = parseInt(getEnv("WEBHOOK_PORT", "8420"), 10);
var WEBHOOK_HOST = normalizeWebhookHost(getEnv("WEBHOOK_HOST", "127.0.0.1"));
var WEBHOOK_ALLOW_LAN = getEnv("WEBHOOK_ALLOW_LAN", "false").toLowerCase() === "true";
var MOBILE_APP_PORT = parseInt(getEnv("CLEMENTINE_MOBILE_APP_PORT", "8421"), 10);
var MOBILE_APP_LISTENER_ENABLED = getEnv("CLEMENTINE_MOBILE_APP_LISTENER", "on").toLowerCase() !== "off";
var WEBHOOK_SECRET = readSecretFromFileVaultSync("webhook_secret") || getEnv("WEBHOOK_SECRET", "") || "";
var WEBHOOK_SECRET_IS_STRONG = isStrongLocalSecret(WEBHOOK_SECRET);
var DISCORD_ENABLED_RAW = getEnv("DISCORD_ENABLED", "").toLowerCase();
var DISCORD_HARNESS_ENABLED = !["false", "0", "no", "off"].includes(
  getEnv("DISCORD_HARNESS_ENABLED", "true").toLowerCase()
);
var DISCORD_BOT_TOKEN = readSecretFromFileVaultSync("discord_bot_token") || getEnv("DISCORD_BOT_TOKEN", "") || "";
function resolveDiscordEnabled(rawEnabled, hasToken) {
  const raw = rawEnabled.trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return hasToken;
}
var DISCORD_ENABLED = resolveDiscordEnabled(DISCORD_ENABLED_RAW, DISCORD_BOT_TOKEN.length > 0);
var DISCORD_CLIENT_ID = getEnv("DISCORD_CLIENT_ID", "");
var DISCORD_REQUIRE_MENTION = getEnv("DISCORD_REQUIRE_MENTION", "true").toLowerCase() === "true";
var DISCORD_DM_ALLOWED_USERS = parseCsvEnv(getEnv("DISCORD_DM_ALLOWED_USERS", ""));
var DISCORD_ALLOWED_USERS = parseCsvEnv(
  getEnv("DISCORD_ALLOWED_USERS", getEnv("DISCORD_DM_ALLOWED_USERS", ""))
);
var DISCORD_DM_POLL_INTERVAL_MS = parseInt(getEnv("DISCORD_DM_POLL_INTERVAL_MS", "5000"), 10);
var DISCORD_ALLOWED_CHANNELS = parseCsvEnv(getEnv("DISCORD_ALLOWED_CHANNELS", ""));
var DISCORD_PUSH_PROACTIVE_BRIEFS = getEnv("DISCORD_PUSH_PROACTIVE_BRIEFS", "false").toLowerCase() === "true";
var SLACK_ENABLED_RAW = getEnv("SLACK_ENABLED", "").toLowerCase();
var SLACK_BOT_TOKEN = readSecretFromFileVaultSync("slack_bot_token") || getEnv("SLACK_BOT_TOKEN", "") || "";
var SLACK_APP_TOKEN = readSecretFromFileVaultSync("slack_app_token") || getEnv("SLACK_APP_TOKEN", "") || "";
var SLACK_ENABLED = resolveDiscordEnabled(
  SLACK_ENABLED_RAW,
  SLACK_BOT_TOKEN.length > 0 && SLACK_APP_TOKEN.length > 0
);
var SLACK_REQUIRE_MENTION = getEnv("SLACK_REQUIRE_MENTION", "true").toLowerCase() === "true";
var SLACK_ALLOWED_USERS = parseCsvEnv(getEnv("SLACK_ALLOWED_USERS", ""));
var SLACK_ALLOWED_CHANNELS = parseCsvEnv(getEnv("SLACK_ALLOWED_CHANNELS", ""));
var SLACK_PROACTIVE_CHANNEL = getEnv("SLACK_PROACTIVE_CHANNEL", "").trim();
var LOCAL_MCP_ENABLED = getEnv("LOCAL_MCP_ENABLED", "true").toLowerCase() === "true";
var MCP_AUTO_IMPORT_ENABLED = getEnv("MCP_AUTO_IMPORT_ENABLED", "false").toLowerCase() === "true";
var MCP_SERVERS_FILE = import_node_path.default.join(BASE_DIR, "mcp", "servers.json");
var COMPOSIO_API_KEY = getEnv("COMPOSIO_API_KEY", "");
var COMPOSIO_USER_ID = getEnv("COMPOSIO_USER_ID", "");

// src/runtime/atomic-json.ts
var import_node_async_hooks2 = require("node:async_hooks");
var heldFileLocks = new import_node_async_hooks2.AsyncLocalStorage();
var UUID_TOKEN_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
var OWNER_TOKEN_PATTERN = new RegExp(`^([1-9]\\d*):([1-9]\\d*)(?::(${UUID_TOKEN_PATTERN}))?$`, "i");

// src/runtime/harness/authority-argument-seal.ts
var import_node_crypto2 = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_node_path2 = __toESM(require("node:path"), 1);
var SEAL_VERSION = 2;
var AUTHORITY_ARGUMENT_MAX_PLAINTEXT_BYTES = SEALED_CALL_CANONICAL_LIMITS.maxTotalBytes;
var AUTHORITY_ARGUMENT_MAX_CIPHER_BYTES = Math.min(
  Math.ceil(AUTHORITY_ARGUMENT_MAX_PLAINTEXT_BYTES * 2) + 4096,
  // The durable lease column's CHECK (eventlog schema v75) is the outer wall.
  16777216
);
var AUTHORITY_SEAL_KEY_ID_V2 = "authority_seal_v2";
var AUTHORITY_SEAL_KEY_ID_V1 = "authority_seal_v1";
var VAULT_FILE = import_node_path2.default.join(BASE_DIR, "state", "secrets-vault.json");
var AuthoritySealKeyMissingError = class extends Error {
  code = "authority_seal_key_missing";
  constructor() {
    super("authority seal key is missing; reconnect the host vault before retrying this crossing");
    this.name = "AuthoritySealKeyMissingError";
  }
};
function hexKey(raw) {
  if (!raw || !/^[a-f0-9]{64}$/i.test(raw.trim())) return null;
  return Buffer.from(raw.trim(), "hex");
}
function readVaultEntry(name) {
  if (!(0, import_node_fs2.existsSync)(VAULT_FILE)) return void 0;
  try {
    const parsed = JSON.parse((0, import_node_fs2.readFileSync)(VAULT_FILE, "utf8"));
    if (parsed.version !== "v1" || !parsed.entries) return void 0;
    const value = parsed.entries[name];
    return value && value.length > 0 ? value : void 0;
  } catch {
    throw new AuthoritySealKeyMissingError();
  }
}
function keyForId(id) {
  if (id === AUTHORITY_SEAL_KEY_ID_V2) {
    return hexKey(process.env.CLEMMY_AUTHORITY_SEAL_KEY) ?? hexKey(readVaultEntry(AUTHORITY_SEAL_KEY_ID_V2));
  }
  if (id === AUTHORITY_SEAL_KEY_ID_V1) {
    return hexKey(process.env.CLEMMY_AUTHORITY_SEAL_KEY_PREVIOUS) ?? hexKey(readVaultEntry(AUTHORITY_SEAL_KEY_ID_V1));
  }
  return null;
}
function openCanonicalArguments(cipherText) {
  try {
    if (Buffer.byteLength(cipherText, "utf8") > AUTHORITY_ARGUMENT_MAX_CIPHER_BYTES) return null;
    const parsed = JSON.parse(Buffer.from(cipherText, "base64").toString("utf8"));
    if (parsed.v !== 1 && parsed.v !== SEAL_VERSION || !parsed.iv || !parsed.tag || !parsed.ct) return null;
    const candidates = parsed.kid ? [parsed.kid, AUTHORITY_SEAL_KEY_ID_V2, AUTHORITY_SEAL_KEY_ID_V1] : [AUTHORITY_SEAL_KEY_ID_V2, AUTHORITY_SEAL_KEY_ID_V1];
    let lastMissing = false;
    for (const id of candidates) {
      const key = keyForId(id);
      if (!key) {
        lastMissing = true;
        continue;
      }
      lastMissing = false;
      try {
        const decipher = (0, import_node_crypto2.createDecipheriv)("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
        decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
        const plain = Buffer.concat([
          decipher.update(Buffer.from(parsed.ct, "base64")),
          decipher.final()
        ]);
        if (plain.byteLength > AUTHORITY_ARGUMENT_MAX_PLAINTEXT_BYTES) return null;
        const args = JSON.parse(plain.toString("utf8"));
        if (!args || typeof args !== "object" || Array.isArray(args)) return null;
        return args;
      } catch {
        continue;
      }
    }
    if (lastMissing && !keyForId(AUTHORITY_SEAL_KEY_ID_V2)) throw new AuthoritySealKeyMissingError();
    return null;
  } catch (error) {
    if (error instanceof AuthoritySealKeyMissingError) throw error;
    return null;
  }
}

// src/runtime/harness/reviewed-cli-read-config.ts
var REVIEWED_CLI_READ_CONFIG_VERSION = 1;
var REVIEWED_CLI_READ_ACCOUNT = "reviewed_cli:host";
var REVIEWED_CLI_READ_CARRIER = "reviewed-cli-config";
var REVIEWED_CLI_ARGUMENT_COMPILER_ID = "host:reviewed-cli-structured-argv:v1";
var MAX_DESCRIPTORS = 1e3;
var MAX_ARGUMENTS = 128;
var MAX_PREFIX_TOKENS = 128;
var MAX_IDENTITY_BYTES = 512;
var MAX_DESCRIPTION_BYTES = 16384;
var MAX_TOKEN_BYTES = 65536;
var MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
var MAX_TIMEOUT_MS = 12e4;
var HASH_BUFFER_BYTES = 64 * 1024;
var CLOSED_OPTIONS = Object.freeze({
  maxDepth: 12,
  maxNodes: 25e3,
  maxStringBytes: MAX_TOKEN_BYTES,
  maxTotalBytes: 4 * 1024 * 1024
});
function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function boundedText(value, maxBytes = MAX_IDENTITY_BYTES) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}
function closedArray(value, max) {
  if (!Array.isArray(value) || value.length > max || Object.getOwnPropertySymbols(value).length > 0) {
    return null;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some((key) => key !== "length" && (!/^\d+$/.test(key) || Number(key) >= value.length))) return null;
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}
function closeArgument(value) {
  if (!plainRecord(value) || Object.getOwnPropertySymbols(value).length > 0 || !exactKeys(value, ["name", "kind", "token", "valueType", "required"]) || Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => entry.get || entry.set)) return null;
  const { name, kind, token, valueType, required } = value;
  if (!boundedText(name) || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name) || kind !== "option" && kind !== "positional" && kind !== "switch" || valueType !== "string" && valueType !== "number" && valueType !== "integer" && valueType !== "boolean" || typeof required !== "boolean" || (kind === "positional" ? token !== null : !boundedText(token, MAX_TOKEN_BYTES)) || kind === "switch" && valueType !== "boolean") return null;
  return Object.freeze({
    name,
    kind,
    token: kind === "positional" ? null : token,
    valueType,
    required
  });
}
function closeLimits(value) {
  if (!plainRecord(value) || Object.getOwnPropertySymbols(value).length > 0 || !exactKeys(value, ["timeoutMs", "maxStdoutBytes", "maxStderrBytes", "maxArgumentBytes"])) return null;
  const integer = (candidate, min, max) => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= min && candidate <= max;
  if (!integer(value.timeoutMs, 1, MAX_TIMEOUT_MS) || !integer(value.maxStdoutBytes, 1, MAX_OUTPUT_BYTES) || !integer(value.maxStderrBytes, 1, MAX_OUTPUT_BYTES) || !integer(value.maxArgumentBytes, 1, MAX_TOKEN_BYTES)) return null;
  return Object.freeze({
    timeoutMs: value.timeoutMs,
    maxStdoutBytes: value.maxStdoutBytes,
    maxStderrBytes: value.maxStderrBytes,
    maxArgumentBytes: value.maxArgumentBytes
  });
}
function closeReviewedCliReadDescriptor(value) {
  if (!plainRecord(value) || Object.getOwnPropertySymbols(value).length > 0 || !exactKeys(value, [
    "version",
    "descriptorId",
    "operationId",
    "displayName",
    "description",
    "effect",
    "accountId",
    "executableRealpath",
    "binarySha256",
    "argvPrefix",
    "arguments",
    "limits"
  ]) || Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => entry.get || entry.set)) return null;
  const prefix = closedArray(value.argvPrefix, MAX_PREFIX_TOKENS);
  const argumentRows = closedArray(value.arguments, MAX_ARGUMENTS);
  const limits = closeLimits(value.limits);
  if (value.version !== REVIEWED_CLI_READ_CONFIG_VERSION || !boundedText(value.descriptorId) || !boundedText(value.operationId) || !boundedText(value.displayName) || typeof value.description !== "string" || value.description !== value.description.trim() || Buffer.byteLength(value.description, "utf8") > MAX_DESCRIPTION_BYTES || value.effect !== "read" || value.accountId !== REVIEWED_CLI_READ_ACCOUNT || !boundedText(value.executableRealpath, MAX_TOKEN_BYTES) || !import_node_path3.default.isAbsolute(value.executableRealpath) || import_node_path3.default.resolve(value.executableRealpath) !== value.executableRealpath || typeof value.binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.binarySha256) || !prefix || prefix.some((token) => !boundedText(token, MAX_TOKEN_BYTES)) || !argumentRows || !limits) return null;
  const args = argumentRows.map(closeArgument);
  if (args.some((row) => !row) || new Set(args.map((row) => row.name)).size !== args.length) return null;
  const closed = {
    version: REVIEWED_CLI_READ_CONFIG_VERSION,
    descriptorId: value.descriptorId,
    operationId: value.operationId,
    displayName: value.displayName,
    description: value.description,
    effect: "read",
    accountId: REVIEWED_CLI_READ_ACCOUNT,
    executableRealpath: value.executableRealpath,
    binarySha256: value.binarySha256,
    argvPrefix: Object.freeze(prefix),
    arguments: Object.freeze(args),
    limits
  };
  try {
    return Object.freeze(JSON.parse(closedCanonicalJson(closed, CLOSED_OPTIONS)));
  } catch {
    return null;
  }
}
function closeSealedDescriptor(value) {
  if (!plainRecord(value) || !exactKeys(value, ["version", "descriptor", "authoritySeal"]) || value.version !== REVIEWED_CLI_READ_CONFIG_VERSION || typeof value.authoritySeal !== "string" || Buffer.byteLength(value.authoritySeal, "utf8") > 48e3) return null;
  const descriptor = closeReviewedCliReadDescriptor(value.descriptor);
  if (!descriptor) return null;
  let opened;
  try {
    opened = openCanonicalArguments(value.authoritySeal);
  } catch {
    return null;
  }
  if (!opened || !exactKeys(opened, ["domain", "descriptorDigest"]) || opened.domain !== "reviewed-cli-read-descriptor:v1" || opened.descriptorDigest !== reviewedCliDescriptorDigest(descriptor)) return null;
  return Object.freeze({
    version: REVIEWED_CLI_READ_CONFIG_VERSION,
    descriptor,
    authoritySeal: value.authoritySeal
  });
}
function closeConfigFile(value) {
  if (!plainRecord(value) || !exactKeys(value, ["version", "descriptors"])) return null;
  const rows = closedArray(value.descriptors, MAX_DESCRIPTORS);
  if (value.version !== REVIEWED_CLI_READ_CONFIG_VERSION || !rows) return null;
  const descriptors = rows.map(closeSealedDescriptor);
  if (descriptors.some((entry) => !entry) || new Set(descriptors.map((entry) => entry.descriptor.descriptorId)).size !== descriptors.length) return null;
  return {
    version: REVIEWED_CLI_READ_CONFIG_VERSION,
    descriptors: descriptors.sort((left, right) => left.descriptor.descriptorId.localeCompare(right.descriptor.descriptorId))
  };
}
function reviewedCliReadConfigPath() {
  return import_node_path3.default.join(BASE_DIR, "state", "reviewed-cli-read-descriptors.json");
}
function listReviewedCliReadDescriptors(filePath = reviewedCliReadConfigPath()) {
  let raw;
  try {
    raw = (0, import_node_fs3.readFileSync)(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("reviewed CLI descriptor registry is malformed");
  }
  const closed = closeConfigFile(parsed);
  if (!closed) throw new Error("reviewed CLI descriptor registry is not closed reviewed data");
  return Object.freeze(closed.descriptors.map((entry) => Object.freeze(entry.descriptor)));
}
function hashOpenFile(fd) {
  const hash = (0, import_node_crypto3.createHash)("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let position = 0;
  for (; ; ) {
    const count = (0, import_node_fs3.readSync)(fd, buffer, 0, buffer.length, position);
    if (count === 0) break;
    hash.update(buffer.subarray(0, count));
    position += count;
  }
  return hash.digest("hex");
}
function observeReviewedCliExecutable(executablePath) {
  if (!import_node_path3.default.isAbsolute(executablePath) || executablePath.includes("\0")) return null;
  let real;
  try {
    real = (0, import_node_fs3.realpathSync)(executablePath);
  } catch {
    return null;
  }
  let fd = -1;
  try {
    fd = (0, import_node_fs3.openSync)(real, "r");
    const before = (0, import_node_fs3.fstatSync)(fd, { bigint: true });
    if (!before.isFile() || (before.mode & 0o111n) === 0n) return null;
    const binarySha256 = hashOpenFile(fd);
    const after = (0, import_node_fs3.fstatSync)(fd, { bigint: true });
    const pathAfter = (0, import_node_fs3.realpathSync)(real);
    const pathStats = (0, import_node_fs3.statSync)(real, { bigint: true });
    if (pathAfter !== real || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || after.dev !== pathStats.dev || after.ino !== pathStats.ino || after.size !== pathStats.size || after.mtimeNs !== pathStats.mtimeNs) return null;
    return Object.freeze({
      executableRealpath: real,
      binarySha256,
      dev: after.dev,
      ino: after.ino,
      size: after.size
    });
  } catch {
    return null;
  } finally {
    if (fd >= 0) (0, import_node_fs3.closeSync)(fd);
  }
}
function reviewedCliDescriptorDigest(descriptor) {
  const closed = closeReviewedCliReadDescriptor(descriptor);
  if (!closed) throw new Error("reviewed CLI descriptor is invalid");
  return (0, import_node_crypto3.createHash)("sha256").update(closedCanonicalJson(closed, CLOSED_OPTIONS), "utf8").digest("hex");
}
function currentReviewedCliDescriptor(descriptor) {
  const closed = closeReviewedCliReadDescriptor(descriptor);
  if (!closed) return null;
  const executable = observeReviewedCliExecutable(closed.executableRealpath);
  if (!executable || executable.executableRealpath !== closed.executableRealpath || executable.binarySha256 !== closed.binarySha256) return null;
  return closed;
}
function reviewedCliInputSchema(descriptor) {
  const properties = {};
  const required = [];
  for (const argument of descriptor.arguments) {
    properties[argument.name] = Object.freeze({ type: argument.valueType === "integer" ? "integer" : argument.valueType });
    if (argument.required) required.push(argument.name);
  }
  return Object.freeze({
    type: "object",
    properties: Object.freeze(properties),
    required: Object.freeze(required),
    additionalProperties: false
  });
}
function encodeArgumentValue(value, type, maxBytes) {
  let encoded;
  if (type === "string") {
    if (typeof value !== "string") return null;
    encoded = value;
  } else if (type === "boolean") {
    if (typeof value !== "boolean") return null;
    encoded = value ? "true" : "false";
  } else {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    if (type === "integer" && !Number.isSafeInteger(value)) return null;
    encoded = String(value);
  }
  if (encoded.includes("\0") || Buffer.byteLength(encoded, "utf8") > maxBytes) return null;
  return encoded;
}
function compileReviewedCliArgv(descriptor, args) {
  if (!plainRecord(args) || Object.getOwnPropertySymbols(args).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(args);
  if (Object.values(descriptors).some((entry) => entry.get || entry.set || !("value" in entry))) return null;
  const declared = new Set(descriptor.arguments.map((argument) => argument.name));
  if (Object.keys(args).some((key) => !declared.has(key))) return null;
  const argv = [...descriptor.argvPrefix];
  for (const argument of descriptor.arguments) {
    const present = Object.hasOwn(args, argument.name);
    if (!present) {
      if (argument.required) return null;
      continue;
    }
    const value = descriptors[argument.name].value;
    if (argument.kind === "switch") {
      if (typeof value !== "boolean") return null;
      if (value) argv.push(argument.token);
      continue;
    }
    const encoded = encodeArgumentValue(value, argument.valueType, descriptor.limits.maxArgumentBytes);
    if (encoded === null) return null;
    if (argument.kind === "option") argv.push(argument.token);
    argv.push(encoded);
  }
  return Object.freeze(argv);
}

// src/runtime/harness/reviewed-cli-read-transport.ts
var REVIEWED_CLI_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({
    version: Object.freeze({ type: "integer", const: 1 }),
    status: Object.freeze({ type: "string", const: "exited" }),
    operationId: Object.freeze({ type: "string" }),
    executableRealpath: Object.freeze({ type: "string" }),
    argv: Object.freeze({ type: "array", items: Object.freeze({ type: "string" }) }),
    exitCode: Object.freeze({ type: "integer", const: 0 }),
    signal: Object.freeze({ type: "null" }),
    stdout: Object.freeze({ type: "string" }),
    stderr: Object.freeze({ type: "string" }),
    stdoutTruncated: Object.freeze({ type: "boolean", const: false }),
    stderrTruncated: Object.freeze({ type: "boolean", const: false })
  }),
  required: Object.freeze([
    "version",
    "status",
    "operationId",
    "executableRealpath",
    "argv",
    "exitCode",
    "signal",
    "stdout",
    "stderr",
    "stdoutTruncated",
    "stderrTruncated"
  ]),
  additionalProperties: false
});
var PROCESS_DIAGNOSTIC_MAX_CHARS = 240;
function stripAnsiText(text) {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}
function reviewedCliProcessDiagnostic(outcome) {
  const stdout = stripAnsiText(outcome.stdout ?? "").trim();
  const stderr = stripAnsiText(outcome.stderr ?? "").trim();
  let line = null;
  if (stdout.startsWith("{")) {
    try {
      const parsed = JSON.parse(stdout);
      const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
      const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
      if (message) line = name ? `${name}: ${message}` : message;
      else if (name) line = name;
    } catch {
    }
  }
  if (!line) {
    const informative = stderr.split("\n").map((entry) => entry.replace(/^\s*›\s*/, "").trim()).filter((entry) => entry.length > 0 && !/^warning:/i.test(entry));
    line = informative.at(-1) ?? null;
  }
  if (!line && stdout) line = stdout.split("\n").map((entry) => entry.trim()).filter(Boolean).at(-1) ?? null;
  if (!line) return null;
  const collapsed = redactSensitiveText(line.replace(/\s+/g, " ").trim());
  return collapsed.length > PROCESS_DIAGNOSTIC_MAX_CHARS ? `${collapsed.slice(0, PROCESS_DIAGNOSTIC_MAX_CHARS - 1)}\u2026` : collapsed;
}
var ReviewedCliProcessError = class extends Error {
  outcome;
  constructor(outcome) {
    const diagnostic = reviewedCliProcessDiagnostic(outcome);
    super(diagnostic ? `reviewed CLI process ${outcome.status}: ${diagnostic}` : `reviewed CLI process ${outcome.status}`);
    this.name = "ReviewedCliProcessError";
    this.outcome = Object.freeze(outcome);
  }
};
function currentDescriptorForOperation(operationId) {
  const matches = listReviewedCliReadDescriptors().filter((entry) => entry.operationId === operationId && entry.accountId === REVIEWED_CLI_READ_ACCOUNT);
  if (matches.length !== 1) return null;
  return currentReviewedCliDescriptor(matches[0]);
}
function currentTransportIdentity(descriptor) {
  const operationVersion = reviewedCliDescriptorDigest(descriptor);
  const inputSchema = reviewedCliInputSchema(descriptor);
  const schemaFingerprint = stableJsonFingerprint(inputSchema);
  const outputSchemaFingerprint = stableJsonFingerprint(REVIEWED_CLI_OUTPUT_SCHEMA);
  const invokePortId = `port:reviewed-cli:v1:${operationVersion}`;
  const definitionFingerprint = (0, import_node_crypto4.createHash)("sha256").update(closedCanonicalJson({
    domain: "live-read-capability-definition",
    version: 1,
    carrier: {
      kind: "cli",
      name: REVIEWED_CLI_READ_CARRIER.trim().toLowerCase()
    },
    provider: {
      kind: "reviewed_cli",
      identity: descriptor.executableRealpath,
      version: descriptor.binarySha256
    },
    operation: {
      id: descriptor.operationId,
      version: operationVersion
    },
    accountId: descriptor.accountId,
    effect: "read",
    effectAttestation: "host_reviewed",
    schemaFingerprint,
    inputSchema,
    outputSchema: REVIEWED_CLI_OUTPUT_SCHEMA,
    outputSchemaFingerprint,
    outputSchemaAttestation: "host_reviewed",
    invoke: {
      portId: invokePortId,
      argumentCompiler: {
        id: REVIEWED_CLI_ARGUMENT_COMPILER_ID,
        version: operationVersion
      }
    }
  }, {
    maxDepth: 24,
    maxNodes: 1e5,
    maxStringBytes: 1048576,
    maxTotalBytes: 1048576
  }), "utf8").digest("hex");
  return { descriptor, operationVersion, definitionFingerprint, invokePortId };
}
function observeReviewedCliReadTransport(operationId, accountId) {
  if (accountId !== REVIEWED_CLI_READ_ACCOUNT) return null;
  try {
    const descriptor = currentDescriptorForOperation(operationId);
    if (!descriptor) return null;
    const current = currentTransportIdentity(descriptor);
    return {
      operationId,
      accountId,
      definitionFingerprint: current.definitionFingerprint,
      providerVersion: descriptor.binarySha256,
      operationVersion: current.operationVersion,
      observedAt: Date.now()
    };
  } catch {
    return null;
  }
}
function exactExpectedIdentity(call, current) {
  const expected = call.expected;
  const descriptor = current.descriptor;
  return Boolean(
    expected && expected.manifestId.trim().length > 0 && expected.manifestId === expected.manifestId.trim() && /^[a-f0-9]{64}$/.test(expected.manifestDigest) && call.operationId === descriptor.operationId && call.accountId === REVIEWED_CLI_READ_ACCOUNT && expected.providerKind === "reviewed_cli" && expected.providerIdentity === descriptor.executableRealpath && expected.providerVersion === descriptor.binarySha256 && expected.operationVersion === current.operationVersion && expected.definitionFingerprint === current.definitionFingerprint && expected.invokePortId === current.invokePortId && expected.argumentCompiler.id === REVIEWED_CLI_ARGUMENT_COMPILER_ID && expected.argumentCompiler.version === current.operationVersion && expected.providerInputSchemaDigest === void 0 && expected.providerOutputSchemaObserved === void 0 && expected.providerOutputSchemaDigest === void 0
  );
}
function boundedOutput(value, maxBytes) {
  const source = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "", "utf8");
  if (source.length <= maxBytes) return { text: source.toString("utf8"), truncated: false };
  let end = maxBytes;
  let text = source.subarray(0, end).toString("utf8");
  while (Buffer.byteLength(text, "utf8") > maxBytes && end > 0) {
    end -= 1;
    text = source.subarray(0, end).toString("utf8");
  }
  return { text, truncated: true };
}
function processOutcome(input) {
  const stdout = boundedOutput(input.stdout, input.descriptor.limits.maxStdoutBytes);
  const stderr = boundedOutput(input.stderr, input.descriptor.limits.maxStderrBytes);
  const maxBufferMessage = input.status === "output_limit" ? String(input.error?.message ?? "") : "";
  return Object.freeze({
    version: 1,
    status: input.status,
    operationId: input.descriptor.operationId,
    executableRealpath: input.descriptor.executableRealpath,
    argv: Object.freeze([...input.argv]),
    exitCode: typeof input.error?.code === "number" ? input.error.code : input.status === "exited" ? 0 : null,
    signal: input.error?.signal ?? null,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated || /stdout maxBuffer/i.test(maxBufferMessage),
    stderrTruncated: stderr.truncated || /stderr maxBuffer/i.test(maxBufferMessage)
  });
}
function failureStatus(error) {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output_limit";
  if (error.killed) return "timed_out";
  if (typeof error.code === "number") return "nonzero_exit";
  return "spawn_failed";
}
async function executeReviewedCliRead(call) {
  let descriptor;
  try {
    descriptor = currentDescriptorForOperation(call.operationId);
  } catch {
    descriptor = null;
  }
  if (!descriptor) throw new Error("reviewed CLI descriptor is absent, ambiguous, or stale");
  const current = currentTransportIdentity(descriptor);
  if (!exactExpectedIdentity(call, current)) {
    throw new Error("reviewed CLI execution identity changed before dispatch");
  }
  const argv = compileReviewedCliArgv(descriptor, call.args);
  if (!argv) throw new Error("reviewed CLI arguments exceed the closed structured-argv schema");
  const before = observeReviewedCliExecutable(descriptor.executableRealpath);
  if (!before || before.binarySha256 !== descriptor.binarySha256) {
    throw new Error("reviewed CLI executable changed before dispatch");
  }
  const outcome = await new Promise((resolve, reject) => {
    (0, import_node_child_process.execFile)(
      descriptor.executableRealpath,
      [...argv],
      {
        encoding: "utf8",
        timeout: descriptor.limits.timeoutMs,
        maxBuffer: Math.max(
          descriptor.limits.maxStdoutBytes,
          descriptor.limits.maxStderrBytes
        ),
        killSignal: "SIGKILL",
        shell: false
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new ReviewedCliProcessError(processOutcome({
            status: failureStatus(error),
            descriptor,
            argv,
            error,
            stdout,
            stderr
          })));
          return;
        }
        const success = processOutcome({
          status: "exited",
          descriptor,
          argv,
          stdout,
          stderr
        });
        if (success.stdoutTruncated || success.stderrTruncated) {
          reject(new ReviewedCliProcessError({ ...success, status: "output_limit" }));
          return;
        }
        resolve(success);
      }
    );
  });
  let afterDescriptor = null;
  try {
    afterDescriptor = currentDescriptorForOperation(call.operationId);
  } catch {
  }
  if (!afterDescriptor || reviewedCliDescriptorDigest(afterDescriptor) !== reviewedCliDescriptorDigest(descriptor)) {
    throw new ReviewedCliProcessError({ ...outcome, status: "identity_changed" });
  }
  return outcome;
}

// src/runtime/harness/implementation-artifacts/transport-isolated-entry.ts
var isolatedHandler = null;
var observations = /* @__PURE__ */ new Map();
function homeDir() {
  return process.env.CLEMENTINE_HOME?.trim() || import_node_path4.default.join(import_node_os2.default.tmpdir(), "clem-isolated-transport");
}
function statePath() {
  return import_node_path4.default.join(homeDir(), "state", "attested-isolated-transport.json");
}
function loadState() {
  const file = statePath();
  if (!(0, import_node_fs4.existsSync)(file)) return { calls: [], creates: [], observations: {} };
  try {
    const parsed = JSON.parse((0, import_node_fs4.readFileSync)(file, "utf8"));
    return {
      observations: parsed.observations && typeof parsed.observations === "object" ? parsed.observations : {},
      calls: Array.isArray(parsed.calls) ? parsed.calls : [],
      creates: Array.isArray(parsed.creates) ? parsed.creates : []
    };
  } catch {
    return { calls: [], creates: [] };
  }
}
function saveState(state) {
  (0, import_node_fs4.mkdirSync)(import_node_path4.default.dirname(statePath()), { recursive: true });
  (0, import_node_fs4.writeFileSync)(statePath(), `${JSON.stringify(state)}
`);
}
function bindIsolatedTransportHandler(handler) {
  isolatedHandler = handler;
}
function registerIsolatedObservation(observation) {
  const key = `${observation.operationId}\0${observation.accountId}`;
  observations.set(key, observation);
  const state = loadState();
  state.observations = { ...state.observations ?? {}, [key]: observation };
  saveState(state);
}
async function prepareAttestedComposioDispatch(input) {
  const operationId = input.operationId.trim();
  const accountId = input.accountId.trim();
  const current = operationId && accountId ? observeAttestedTransport({ operationId, accountId }) : null;
  if (!current || current.operationId !== operationId || current.accountId !== accountId) {
    throw new Error(
      `${operationId || "unknown operation"} sealed connected account ${accountId || "unknown"} is missing_or_changed`
    );
  }
}
function isolatedTransportCalls() {
  return [...loadState().calls];
}
async function executeAttestedTransport(call) {
  const state = loadState();
  state.calls.push(call);
  if (call.expected?.providerKind === "reviewed_cli") {
    saveState(state);
    return executeReviewedCliRead(call);
  }
  if (!isolatedHandler) {
    saveState(state);
    throw new Error(`${call.operationId} isolated transport has no handler`);
  }
  const result = await isolatedHandler(call);
  const record = result && typeof result === "object" ? result : {};
  const createdId = String(record.spreadsheet_id ?? record.spreadsheetId ?? record.id ?? "").trim();
  if (createdId && (call.operationId.includes("SHEET_FROM_JSON") || call.operationId === "host_create")) {
    const handle = String(record.spreadsheet_url ?? record.handle ?? `https://docs.google.com/spreadsheets/d/${createdId}`);
    const receipt = String(record.receipt ?? `receipt:${createdId}`);
    state.creates.push({
      artifactId: createdId,
      handle,
      accountId: call.accountId,
      operationId: call.operationId,
      contentDigest: (0, import_node_crypto5.createHash)("sha256").update(JSON.stringify(record), "utf8").digest("hex"),
      receipt
    });
  }
  saveState(state);
  return result;
}
function observeAttestedTransport(input) {
  const key = `${input.operationId}\0${input.accountId}`;
  const prior = observations.get(key) ?? loadState().observations?.[key];
  if (!prior) return null;
  return { ...prior };
}
async function refreshAttestedTransportObservation(input) {
  if (input.accountId === "reviewed_cli:host") {
    const observation = observeReviewedCliReadTransport(input.operationId, input.accountId);
    if (!observation) return null;
    registerIsolatedObservation(observation);
    return observation;
  }
  return observeAttestedTransport(input);
}
async function reconcileAttestedTransport(input) {
  const id = input.artifactId.trim();
  if (!id) return { exists: false };
  const created = loadState().creates.find((row) => row.artifactId === id && row.accountId === input.accountId);
  if (!created) return { exists: false };
  return {
    exists: true,
    artifactId: created.artifactId,
    handle: created.handle,
    contentDigest: created.contentDigest,
    receipt: created.receipt
  };
}
function createAttestedTransport(digest) {
  return {
    digest,
    execute: executeAttestedTransport,
    observe: observeAttestedTransport,
    refreshObservation: refreshAttestedTransportObservation,
    reconcile: reconcileAttestedTransport
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  bindIsolatedTransportHandler,
  createAttestedTransport,
  executeAttestedTransport,
  isolatedTransportCalls,
  observeAttestedTransport,
  prepareAttestedComposioDispatch,
  reconcileAttestedTransport,
  refreshAttestedTransportObservation,
  registerIsolatedObservation
});
