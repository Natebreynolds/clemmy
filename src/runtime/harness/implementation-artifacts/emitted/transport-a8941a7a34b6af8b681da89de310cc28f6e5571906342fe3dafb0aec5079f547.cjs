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

// src/runtime/harness/implementation-artifacts/transport-entry.ts
var transport_entry_exports = {};
__export(transport_entry_exports, {
  createAttestedTransport: () => createAttestedTransport,
  executeAttestedTransport: () => executeAttestedTransport,
  observeAttestedTransport: () => observeAttestedTransport,
  prepareAttestedComposioDispatch: () => prepareAttestedComposioDispatch,
  reconcileAttestedTransport: () => reconcileAttestedTransport,
  refreshAttestedTransportObservation: () => refreshAttestedTransportObservation,
  registerIsolatedObservation: () => registerIsolatedObservation
});
module.exports = __toCommonJS(transport_entry_exports);
var import_node_module = require("node:module");
var import_node_fs5 = require("node:fs");
var import_node_path7 = __toESM(require("node:path"), 1);
var import_node_url2 = require("node:url");

// src/integrations/composio/provider-definition-identity.ts
var import_node_crypto2 = require("node:crypto");

// src/tools/tool-contract-store.ts
var import_node_path3 = __toESM(require("node:path"), 1);

// src/config.ts
var import_node_async_hooks = require("node:async_hooks");
var import_node_fs = require("node:fs");
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_node_url = require("node:url");

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

// src/config.ts
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

// src/runtime/machine-id.ts
var import_node_path2 = __toESM(require("node:path"), 1);
var MACHINE_ID_FILE = import_node_path2.default.join(BASE_DIR, "state", "machine-id");

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

// src/tools/tool-contract-store.ts
var CONTRACTS_ROOT = import_node_path3.default.join(BASE_DIR, "memory", "tool-contracts");
var CONTRACT_TTL_MS = 30 * 24 * 60 * 6e4;
var MAX_CONTRACT_CACHE_BYTES = 64 * 1024 * 1024;
function digestSchema(schema) {
  return stableJsonDigest(schema);
}

// src/integrations/composio/provider-definition-identity.ts
var COMPOSIO_PROVIDER_SURFACE_VERSION = "composio-tool-router-v1";
function boundedIdentity(value) {
  const normalized = value.trim();
  return normalized && normalized.length <= 512 ? normalized : null;
}
function fingerprintComposioProviderDefinition(input) {
  const operationId = boundedIdentity(input.operationId);
  const operationVersion = boundedIdentity(input.operationVersion);
  const accountId = boundedIdentity(input.accountId);
  const invokePortId = boundedIdentity(input.invokePortId);
  if (!operationId || !operationVersion || !accountId || !invokePortId) return null;
  if (!input.inputSchema || typeof input.inputSchema !== "object" || Array.isArray(input.inputSchema)) {
    return null;
  }
  if (input.outputSchema === void 0) return null;
  if (input.outputSchema !== null && (!input.outputSchema || typeof input.outputSchema !== "object" || Array.isArray(input.outputSchema))) return null;
  return (0, import_node_crypto2.createHash)("sha256").update(JSON.stringify({
    domain: "composio-prepared-provider-definition",
    version: 1,
    providerIdentity: "composio",
    providerVersion: COMPOSIO_PROVIDER_SURFACE_VERSION,
    operationId,
    operationVersion,
    accountId,
    invokePortId,
    providerInputSchemaDigest: digestSchema(input.inputSchema),
    providerOutputSchemaDigest: input.outputSchema ? digestSchema(input.outputSchema) : null
  }), "utf8").digest("hex");
}

// src/runtime/harness/reviewed-local-tool-transport.ts
var import_zod4 = require("zod");

// src/runtime/schema-normalizer.ts
var import_zod = require("zod");
function withDescription(source, target) {
  return source.description ? target.describe(source.description) : target;
}
function normalizeZodForDeferredJson(schema) {
  const def = schema._def;
  switch (def?.type) {
    case "optional":
      return withDescription(
        schema,
        normalizeZodForDeferredJson(def.innerType).nullish()
      );
    case "nullable":
      return withDescription(
        schema,
        // On the args_json transport a nullable tool field is the strict-mode
        // representation of "optional"; accept omission as well as null.
        normalizeZodForDeferredJson(def.innerType).nullish()
      );
    case "object": {
      const anySchema = schema;
      const shape = typeof anySchema.shape === "function" ? anySchema.shape() : anySchema.shape;
      const normalizedShape = Object.fromEntries(
        Object.entries(shape).map(([key, value]) => [
          key,
          normalizeZodForDeferredJson(value)
        ])
      );
      return withDescription(schema, import_zod.z.strictObject(normalizedShape));
    }
    case "array":
      return withDescription(schema, import_zod.z.array(normalizeZodForDeferredJson(def.element)));
    case "record": {
      const keyType = def.keyType ?? import_zod.z.string();
      const valueType = def.valueType ? normalizeZodForDeferredJson(def.valueType) : import_zod.z.json();
      return withDescription(schema, import_zod.z.record(keyType, valueType));
    }
    case "any":
    case "unknown":
      return withDescription(schema, import_zod.z.json());
    case "union": {
      const options = Array.isArray(def.options) ? def.options.map((item) => normalizeZodForDeferredJson(item)) : [];
      if (options.length === 0) return withDescription(schema, import_zod.z.string());
      if (options.length === 1) return withDescription(schema, options[0]);
      return withDescription(
        schema,
        import_zod.z.union(options)
      );
    }
    default:
      return schema;
  }
}
function normalizeShapeForDeferredJson(shape) {
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [
      key,
      normalizeZodForDeferredJson(value)
    ])
  );
}
function jsonSchemaAllowsNull(schemaValue) {
  if (!schemaValue || typeof schemaValue !== "object" || Array.isArray(schemaValue)) return false;
  const schema = schemaValue;
  if (schema.nullable === true || schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  for (const branch of [schema.anyOf, schema.oneOf]) {
    if (Array.isArray(branch) && branch.some(jsonSchemaAllowsNull)) return true;
  }
  return false;
}
function relaxJsonSchemaForDeferred(schemaValue) {
  if (Array.isArray(schemaValue)) return schemaValue.map(relaxJsonSchemaForDeferred);
  if (!schemaValue || typeof schemaValue !== "object") return schemaValue;
  const source = schemaValue;
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = relaxJsonSchemaForDeferred(value);
  }
  if (Array.isArray(source.required) && source.properties && typeof source.properties === "object") {
    const properties = source.properties;
    const required = source.required.filter(
      (key) => typeof key === "string" && !jsonSchemaAllowsNull(properties[key])
    );
    if (required.length > 0) out.required = required;
    else delete out.required;
  }
  return out;
}

// src/runtime/harness/capability-manifest.ts
var import_node_crypto3 = require("node:crypto");

// src/runtime/harness/mutation-verification-contract.ts
function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, required, optional = []) {
  const permitted = /* @__PURE__ */ new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every((key) => permitted.has(key));
}
function boundedIdentity2(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:@/+-]+$/.test(value);
}
function isRfc6901Pointer(value) {
  if (typeof value !== "string" || value.length < 2 || value.length > 512 || value[0] !== "/") return false;
  return !/~(?:[^01]|$)/.test(value);
}
function onePointer(value) {
  return Array.isArray(value) && value.length === 1 && isRfc6901Pointer(value[0]);
}
function parseRangeProjection(value) {
  if (!record(value) || !exactKeys(value, [
    "version",
    "kind",
    "entriesPointer",
    "rangePointer",
    "valuesPointer"
  ])) return null;
  if (value.version !== 1 || value.kind !== "exact_range_values_v1" || !isRfc6901Pointer(value.entriesPointer) || !isRfc6901Pointer(value.rangePointer) || !isRfc6901Pointer(value.valuesPointer)) return null;
  return {
    version: 1,
    kind: "exact_range_values_v1",
    entriesPointer: value.entriesPointer,
    rangePointer: value.rangePointer,
    valuesPointer: value.valuesPointer
  };
}
function parseSingleRangeProjection(value) {
  if (!record(value) || !exactKeys(value, [
    "version",
    "kind",
    "rangePointer",
    "valuesPointer"
  ])) return null;
  if (value.version !== 1 || value.kind !== "exact_single_range_values_v1" || !isRfc6901Pointer(value.rangePointer) || !isRfc6901Pointer(value.valuesPointer)) return null;
  return {
    version: 1,
    kind: "exact_single_range_values_v1",
    rangePointer: value.rangePointer,
    valuesPointer: value.valuesPointer
  };
}
function parseContentProjection(value) {
  return parseRangeProjection(value) ?? parseSingleRangeProjection(value);
}
function parseMutationVerificationContract(value) {
  if (!record(value) || !exactKeys(value, [
    "version",
    "resourceFamily",
    "producedHandleKind",
    "proof",
    "target"
  ], ["resultEnvelope", "expectedContent"])) return null;
  if (value.version !== 1 || !boundedIdentity2(value.resourceFamily) || !boundedIdentity2(value.producedHandleKind) || value.proof !== "resource_identity_v1" && value.proof !== "exact_content_v1" || !record(value.target) || !exactKeys(value.target, ["source", "pointers"]) || value.target.source !== "authoritative_result" && value.target.source !== "provider_arguments" || !onePointer(value.target.pointers) || value.resultEnvelope !== void 0 && value.resultEnvelope !== "successful_data_envelope_v1") return null;
  let expectedContent;
  if (value.expectedContent !== void 0) {
    if (!record(value.expectedContent) || !exactKeys(value.expectedContent, [
      "projection",
      "verifierRequestRangePointer"
    ])) return null;
    const projection = parseContentProjection(value.expectedContent.projection);
    if (!projection || !isRfc6901Pointer(value.expectedContent.verifierRequestRangePointer)) return null;
    expectedContent = {
      projection,
      verifierRequestRangePointer: value.expectedContent.verifierRequestRangePointer
    };
  }
  if (value.proof === "exact_content_v1" !== Boolean(expectedContent)) return null;
  return {
    version: 1,
    resourceFamily: value.resourceFamily,
    producedHandleKind: value.producedHandleKind,
    proof: value.proof,
    target: { source: value.target.source, pointers: [value.target.pointers[0]] },
    ...value.resultEnvelope === "successful_data_envelope_v1" ? { resultEnvelope: value.resultEnvelope } : {},
    ...expectedContent ? { expectedContent } : {}
  };
}
function parseReadbackVerificationContract(value) {
  if (!record(value) || !exactKeys(value, [
    "version",
    "resourceFamily",
    "acceptedHandleKind",
    "requestTargetPointers"
  ], ["responseTargetPointers", "responseTarget", "resultEnvelope", "observedContent"])) return null;
  const responseTarget = record(value.responseTarget) && exactKeys(value.responseTarget, ["version", "kind"]) && value.responseTarget.version === 1 && value.responseTarget.kind === "request_bound_success_v1" ? { version: 1, kind: "request_bound_success_v1" } : null;
  const responsePointers = onePointer(value.responseTargetPointers) ? value.responseTargetPointers : null;
  if (value.version !== 1 || !boundedIdentity2(value.resourceFamily) || !boundedIdentity2(value.acceptedHandleKind) || !onePointer(value.requestTargetPointers) || Boolean(responsePointers) === Boolean(responseTarget) || value.resultEnvelope !== void 0 && value.resultEnvelope !== "successful_data_envelope_v1" || responseTarget && value.resultEnvelope !== "successful_data_envelope_v1") return null;
  let observedContent;
  if (value.observedContent !== void 0) {
    if (!record(value.observedContent) || !exactKeys(value.observedContent, [
      "projection",
      "requestRangePointer"
    ])) return null;
    const projection = parseContentProjection(value.observedContent.projection);
    if (!projection || !isRfc6901Pointer(value.observedContent.requestRangePointer)) return null;
    observedContent = {
      projection,
      requestRangePointer: value.observedContent.requestRangePointer
    };
  }
  return {
    version: 1,
    resourceFamily: value.resourceFamily,
    acceptedHandleKind: value.acceptedHandleKind,
    requestTargetPointers: [value.requestTargetPointers[0]],
    ...responsePointers ? { responseTargetPointers: [responsePointers[0]] } : {},
    ...responseTarget ? { responseTarget } : {},
    ...value.resultEnvelope === "successful_data_envelope_v1" ? { resultEnvelope: value.resultEnvelope } : {},
    ...observedContent ? { observedContent } : {}
  };
}
function parseOperationVerificationContract(value) {
  if (!record(value)) return null;
  if (exactKeys(value, ["mutation"])) {
    const mutation = parseMutationVerificationContract(value.mutation);
    return mutation ? { mutation } : null;
  }
  if (exactKeys(value, ["readback"])) {
    const readback = parseReadbackVerificationContract(value.readback);
    return readback ? { readback } : null;
  }
  return null;
}

// src/shared/closed-canonical-json.ts
var RESERVED_KEYS = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
var CLOSED_CANONICAL_JSON_DEFAULTS = Object.freeze({
  maxDepth: 32,
  maxNodes: 2e4,
  maxStringBytes: 64e3,
  maxTotalBytes: 512e3
});
var ClosedCanonicalJsonError = class extends Error {
  constructor(message, code, path8) {
    super(`${message} at ${path8}`);
    this.code = code;
    this.path = path8;
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
  const token = (text, path8) => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maxTotalBytes) {
      throw new ClosedCanonicalJsonError(
        "canonical JSON exceeds the total byte limit",
        "total_byte_limit",
        path8
      );
    }
    return text;
  };
  const encodeString = (text, path8) => {
    if (Buffer.byteLength(text, "utf8") > maxStringBytes) {
      throw new ClosedCanonicalJsonError(
        "string exceeds the canonical JSON string limit",
        "string_limit",
        path8
      );
    }
    return token(JSON.stringify(text), path8);
  };
  const visit = (input, path8, depth) => {
    nodes += 1;
    if (nodes > maxNodes) {
      throw new ClosedCanonicalJsonError("canonical JSON exceeds the node limit", "node_limit", path8);
    }
    if (depth > maxDepth) {
      throw new ClosedCanonicalJsonError("canonical JSON exceeds the depth limit", "depth_limit", path8);
    }
    if (input === null) return token("null", path8);
    if (typeof input === "string") return encodeString(input, path8);
    if (typeof input === "boolean") return token(input ? "true" : "false", path8);
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new ClosedCanonicalJsonError("number is not finite", "non_finite_number", path8);
      }
      return token(JSON.stringify(input), path8);
    }
    if (typeof input !== "object") {
      throw new ClosedCanonicalJsonError("value is outside the closed JSON domain", "unsupported_type", path8);
    }
    if (seen.has(input)) {
      throw new ClosedCanonicalJsonError("value is cyclic", "cyclic", path8);
    }
    if (Object.getOwnPropertySymbols(input).length > 0) {
      throw new ClosedCanonicalJsonError("symbol keys are not JSON data", "symbol_key", path8);
    }
    const prototype = Object.getPrototypeOf(input);
    if (Array.isArray(input)) {
      if (prototype !== Array.prototype) {
        throw new ClosedCanonicalJsonError("array has a foreign prototype", "non_plain_object", path8);
      }
      const descriptors2 = Object.getOwnPropertyDescriptors(input);
      const names = Object.getOwnPropertyNames(input);
      for (const name of names) {
        if (name === "length") continue;
        if (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= input.length) {
          throw new ClosedCanonicalJsonError(
            "array has an extra non-index property",
            "extra_array_property",
            `${path8}.${name}`
          );
        }
      }
      seen.add(input);
      try {
        token("[", path8);
        const children = [];
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = descriptors2[String(index)];
          if (!descriptor) {
            throw new ClosedCanonicalJsonError("array is sparse", "sparse_array", `${path8}[${index}]`);
          }
          if ("get" in descriptor || "set" in descriptor) {
            throw new ClosedCanonicalJsonError(
              "accessor properties are not canonical JSON",
              "accessor_property",
              `${path8}[${index}]`
            );
          }
          if (index > 0) token(",", path8);
          children.push(visit(descriptor.value, `${path8}[${index}]`, depth + 1));
        }
        token("]", path8);
        return `[${children.join(",")}]`;
      } finally {
        seen.delete(input);
      }
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ClosedCanonicalJsonError("object is not plain JSON", "non_plain_object", path8);
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.getOwnPropertyNames(input).sort();
    seen.add(input);
    try {
      token("{", path8);
      const fields = [];
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        const keyPath = `${path8}.${key}`;
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
        if (index > 0) token(",", path8);
        const encodedKey = encodeString(key, keyPath);
        token(":", keyPath);
        fields.push(`${encodedKey}:${visit(descriptor.value, keyPath, depth + 1)}`);
      }
      token("}", path8);
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

// src/runtime/harness/atomic-input-content-contract.ts
function record2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactKeys2(value, keys) {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function pointerList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32 || !value.every(isRfc6901Pointer) || new Set(value).size !== value.length) return null;
  return [...value];
}
function parseAtomicResultIdentityProjection(value) {
  if (!record2(value) || !exactKeys2(value, [
    "version",
    "kind",
    "idPointers",
    "handlePointers",
    "handleTemplate"
  ]) || value.version !== 1 || value.kind !== "pointer_resource_identity_v1" || !record2(value.handleTemplate) || !exactKeys2(value.handleTemplate, ["version", "kind", "prefix", "suffix"]) || value.handleTemplate.version !== 1 || value.handleTemplate.kind !== "prefix_suffix_v1" || typeof value.handleTemplate.prefix !== "string" || !value.handleTemplate.prefix || value.handleTemplate.prefix.length > 2048 || typeof value.handleTemplate.suffix !== "string" || value.handleTemplate.suffix.length > 1024) return null;
  const idPointers = pointerList(value.idPointers);
  const handlePointers = pointerList(value.handlePointers);
  if (!idPointers || !handlePointers || [...idPointers, ...handlePointers].length !== (/* @__PURE__ */ new Set([...idPointers, ...handlePointers])).size) return null;
  return {
    version: 1,
    kind: "pointer_resource_identity_v1",
    idPointers,
    handlePointers,
    handleTemplate: {
      version: 1,
      kind: "prefix_suffix_v1",
      prefix: value.handleTemplate.prefix,
      suffix: value.handleTemplate.suffix
    }
  };
}
function parseAtomicInputContentCommitDeclaration(value) {
  if (!record2(value) || value.version !== 1 || !record2(value.compiler)) return null;
  if (Object.keys(value).length !== 4 || !Object.hasOwn(value, "compiler") || !Object.hasOwn(value, "resultIdentity") || !Object.hasOwn(value, "evidence") || Object.keys(value.compiler).length !== 6 || value.compiler.version !== 1 || value.compiler.kind !== "tabular_record_set_v1" || !isRfc6901Pointer(value.compiler.namePointer) || !isRfc6901Pointer(value.compiler.recordsPointer) || value.compiler.namePointer === value.compiler.recordsPointer || value.compiler.recordsEncoding !== "json_or_value" || value.compiler.selector !== "a1_grid_v1" || !Array.isArray(value.evidence) || value.evidence.length !== 2 || value.evidence[0] !== "receipt" || value.evidence[1] !== "content_commit") return null;
  const resultIdentity = parseAtomicResultIdentityProjection(value.resultIdentity);
  if (!resultIdentity) return null;
  return {
    version: 1,
    compiler: {
      version: 1,
      kind: "tabular_record_set_v1",
      namePointer: value.compiler.namePointer,
      recordsPointer: value.compiler.recordsPointer,
      recordsEncoding: "json_or_value",
      selector: "a1_grid_v1"
    },
    resultIdentity,
    evidence: ["receipt", "content_commit"]
  };
}

// src/runtime/harness/capability-manifest.ts
var CAPABILITY_MANIFEST_VERSION = 1;
var PROVIDER_KINDS = /* @__PURE__ */ new Set([
  "local_registry",
  "composio",
  "native_mcp",
  "reviewed_cli"
]);
var EFFECTS = /* @__PURE__ */ new Set([
  "none",
  "read",
  "compute",
  "host_only",
  "unknown",
  "local_write",
  "external_write",
  "admin"
]);
var MAX_MANIFEST_PURPOSE_CHARS = 256;
var MAX_MANIFEST_KIND_CHARS = 64;
var MAX_MANIFEST_KIND_COUNT = 8;
function boundKinds(kinds) {
  return kinds.slice(0, MAX_MANIFEST_KIND_COUNT).map((kind) => kind.slice(0, MAX_MANIFEST_KIND_CHARS)).filter((kind) => kind.trim().length > 0);
}
function boundManifestDescriptorFields(manifest) {
  return {
    ...manifest,
    purpose: manifest.purpose.slice(0, MAX_MANIFEST_PURPOSE_CHARS),
    acceptedInputKinds: boundKinds(manifest.acceptedInputKinds),
    producedOutputKinds: boundKinds(manifest.producedOutputKinds),
    applicableDeliverableKinds: boundKinds(manifest.applicableDeliverableKinds)
  };
}
function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}
function canonicalManifestBytes(manifest) {
  return JSON.stringify({
    version: manifest.version,
    manifestId: manifest.manifestId,
    providerKind: manifest.providerKind,
    operationId: manifest.operationId,
    providerIdentity: manifest.providerIdentity,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    definitionFingerprint: manifest.definitionFingerprint,
    // Preserve byte compatibility for already-installed manifests: absence is
    // omitted rather than encoded as null. New external manifests bind these
    // facts into their digest.
    ...manifest.externalDefinition ? {
      externalDefinition: {
        version: manifest.externalDefinition.version,
        providerInputSchemaDigest: manifest.externalDefinition.providerInputSchemaDigest,
        ...manifest.externalDefinition.providerOutputSchemaObserved === true ? { providerOutputSchemaObserved: true } : {},
        ...manifest.externalDefinition.providerOutputSchemaDigest ? { providerOutputSchemaDigest: manifest.externalDefinition.providerOutputSchemaDigest } : {},
        semanticName: manifest.externalDefinition.semanticName,
        ...manifest.externalDefinition.verification ? { verification: manifest.externalDefinition.verification } : {},
        behaviorHints: { ...manifest.externalDefinition.behaviorHints }
      }
    } : {},
    effect: manifest.effect,
    ...manifest.operationSemantics ? { operationSemantics: manifest.operationSemantics } : {},
    destination: manifest.destination ?? null,
    accountId: manifest.accountId,
    idempotency: manifest.idempotency,
    reconciliation: manifest.reconciliation,
    outputContract: manifest.outputContract,
    purpose: manifest.purpose,
    acceptedInputKinds: [...manifest.acceptedInputKinds],
    producedOutputKinds: [...manifest.producedOutputKinds],
    applicableDeliverableKinds: [...manifest.applicableDeliverableKinds],
    evidenceContract: {
      kinds: [...manifest.evidenceContract.kinds],
      readbackRequired: manifest.evidenceContract.readbackRequired
    },
    continuationContract: manifest.continuationContract ?? null,
    readbackContract: manifest.readbackContract ?? null,
    provenance: manifest.provenance,
    lifecycle: manifest.lifecycle,
    delegatedFrom: manifest.delegatedFrom ?? null,
    argumentCompiler: manifest.argumentCompiler,
    invokePortId: manifest.invokePortId,
    reconcilePortId: manifest.reconcilePortId ?? null
  });
}
function capabilityManifestDigest(manifest) {
  return (0, import_node_crypto3.createHash)("sha256").update(canonicalManifestBytes(manifest), "utf8").digest("hex");
}
function validateCapabilityManifestV1(manifest) {
  if (!manifest || manifest.version !== CAPABILITY_MANIFEST_VERSION) {
    return { ok: false, reason: "incomplete" };
  }
  if (!nonBlank(manifest.manifestId) || !nonBlank(manifest.operationId) || !nonBlank(manifest.providerIdentity) || !nonBlank(manifest.providerVersion) || !nonBlank(manifest.operationVersion) || !nonBlank(manifest.definitionFingerprint) || !nonBlank(manifest.accountId) || !nonBlank(manifest.outputContract?.kind) || !nonBlank(manifest.purpose) || !Array.isArray(manifest.acceptedInputKinds) || manifest.acceptedInputKinds.length === 0 || !manifest.acceptedInputKinds.every((kind) => nonBlank(kind)) || !Array.isArray(manifest.producedOutputKinds) || manifest.producedOutputKinds.length === 0 || !manifest.producedOutputKinds.every((kind) => nonBlank(kind)) || !Array.isArray(manifest.applicableDeliverableKinds) || manifest.applicableDeliverableKinds.length === 0 || !manifest.applicableDeliverableKinds.every((kind) => nonBlank(kind)) || !manifest.idempotency || !manifest.reconciliation || !manifest.evidenceContract || !Array.isArray(manifest.evidenceContract.kinds) || !nonBlank(manifest.argumentCompiler?.id) || !nonBlank(manifest.argumentCompiler?.version) || !nonBlank(manifest.invokePortId)) {
    return { ok: false, reason: "incomplete" };
  }
  if (!PROVIDER_KINDS.has(manifest.providerKind)) {
    return { ok: false, reason: "unknown_provider_kind" };
  }
  if (!EFFECTS.has(manifest.effect) || manifest.effect === "unknown") {
    return { ok: false, reason: "unknown_effect" };
  }
  const operationSemantics = manifest.operationSemantics === void 0 ? null : parseCapabilityManifestOperationSemantics(manifest.operationSemantics);
  if (manifest.operationSemantics !== void 0 && !operationSemantics) {
    return { ok: false, reason: "incomplete" };
  }
  if (operationSemantics) {
    const readEffect = manifest.effect === "read";
    const destructive = manifest.externalDefinition?.behaviorHints.destructive;
    const atomic = operationSemantics.atomicInputContent;
    if (readEffect || operationSemantics.reversibility === "ordinary_non_destructive" && destructive === true || atomic !== void 0 && (manifest.effect !== "external_write" && manifest.effect !== "local_write" || manifest.destination?.posture !== "create_new" || manifest.idempotency.required !== true || manifest.reconciliation.supported !== true || manifest.evidenceContract.readbackRequired !== false || manifest.evidenceContract.kinds.length !== atomic.evidence.length || manifest.evidenceContract.kinds.some((kind, index) => kind !== atomic.evidence[index]) || destructive === true)) return { ok: false, reason: "incomplete" };
  }
  if (manifest.externalDefinition) {
    const definition = manifest.externalDefinition;
    const hints = definition.behaviorHints;
    const hint = (value) => value === true || value === false || value === null;
    if (manifest.providerKind !== "composio" && manifest.providerKind !== "native_mcp" || definition.version !== 1 || !/^[a-f0-9]{64}$/.test(definition.providerInputSchemaDigest) || definition.providerOutputSchemaObserved !== void 0 && definition.providerOutputSchemaObserved !== true || definition.providerOutputSchemaDigest !== void 0 && definition.providerOutputSchemaObserved !== true || definition.providerOutputSchemaDigest !== void 0 && !/^[a-f0-9]{64}$/.test(definition.providerOutputSchemaDigest) || !nonBlank(definition.semanticName) || definition.verification !== void 0 && !parseOperationVerificationContract(definition.verification) || !hints || !hint(hints.readOnly) || !hint(hints.destructive) || !hint(hints.idempotent) || !hint(hints.openWorld) || hints.readOnly !== null && hints.readOnly !== (manifest.effect === "read") || hints.destructive === true && manifest.effect !== "external_write" && manifest.effect !== "local_write" && manifest.effect !== "admin") return { ok: false, reason: "incomplete" };
  }
  if (manifest.provenance?.trusted !== true || !nonBlank(manifest.provenance.issuer) || !nonBlank(manifest.provenance.issuedAt)) {
    return { ok: false, reason: "untrusted_provenance" };
  }
  if (manifest.lifecycle?.state === "revoked") return { ok: false, reason: "revoked" };
  if (manifest.lifecycle?.state === "superseded") return { ok: false, reason: "superseded" };
  if (manifest.lifecycle?.state !== "current") return { ok: false, reason: "incomplete" };
  if (manifest.delegatedFrom && manifest.operationId === manifest.delegatedFrom) {
    return { ok: false, reason: "multiplexer_is_not_an_operation" };
  }
  if (Buffer.byteLength(manifest.purpose, "utf8") > MAX_MANIFEST_PURPOSE_CHARS || manifest.acceptedInputKinds.some((kind) => Buffer.byteLength(kind, "utf8") > MAX_MANIFEST_KIND_CHARS) || manifest.producedOutputKinds.some((kind) => Buffer.byteLength(kind, "utf8") > MAX_MANIFEST_KIND_CHARS) || manifest.applicableDeliverableKinds.some((kind) => Buffer.byteLength(kind, "utf8") > MAX_MANIFEST_KIND_CHARS) || manifest.acceptedInputKinds.length > MAX_MANIFEST_KIND_COUNT || manifest.producedOutputKinds.length > MAX_MANIFEST_KIND_COUNT || manifest.applicableDeliverableKinds.length > MAX_MANIFEST_KIND_COUNT) {
    return { ok: false, reason: "incomplete" };
  }
  return { ok: true, manifest: boundManifestDescriptorFields(manifest) };
}
function parseCapabilityManifestOperationSemantics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value;
  const hasReversibility = Object.hasOwn(row, "reversibility");
  const hasAtomic = Object.hasOwn(row, "atomicInputContent");
  const keys = Object.keys(row);
  const allowed = /* @__PURE__ */ new Set([
    "version",
    ...hasReversibility ? ["reversibility"] : [],
    ...hasAtomic ? ["atomicInputContent"] : []
  ]);
  const reversibilities = /* @__PURE__ */ new Set([
    "reversible",
    "ordinary_non_destructive",
    "irreversible"
  ]);
  const atomicInputContent = hasAtomic ? parseAtomicInputContentCommitDeclaration(row.atomicInputContent) : void 0;
  if (row.version !== 1 || keys.length !== allowed.size || keys.some((key) => !allowed.has(key)) || !hasReversibility && !hasAtomic || hasReversibility && !reversibilities.has(row.reversibility) || hasAtomic && !atomicInputContent) return null;
  return {
    version: 1,
    ...hasReversibility ? { reversibility: row.reversibility } : {},
    ...atomicInputContent ? { atomicInputContent } : {}
  };
}
function currentCapabilityManifest(manifest) {
  const checked = validateCapabilityManifestV1(manifest);
  return checked.ok ? checked.manifest : null;
}

// src/tools/tool-registry.ts
var TOOL_REGISTRY = [
  { name: "agent_propose", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", description: "Draft a reusable team-agent proposal for user review." },
  { name: "agent_run_get", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", actionTopologyRole: "control", actionControlContext: "task_recovery", description: "Fetch the full event timeline of a single autonomy cycle by runId." },
  { name: "agent_runs_recent", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", actionTopologyRole: "control", actionControlContext: "task_recovery", description: "List recent autonomy cycles (daemon-source runs)." },
  { name: "answer_check_in", sideEffect: "read", tier: "discoverable", lanes: ["cli"], actionTopologyRole: "control", description: "Resolve an open check-in with an answer." },
  { name: "artifact_bundle_save", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "agentic", needsApproval: false, loopClass: "mutating", localPlanning: { consequence: "local_artifact", reversibility: "create_only", destructive: false, purpose: "create_local_artifact_bundle", inputKind: "artifact_content", outputKind: "local_artifact", deliverableKind: "directory", destinationPosture: "create_new", advisoryRoles: ["author", "create", "destination"], safeMode: { id: "content_addressed", requiredEquals: { mode: "content_addressed" } } }, localExecution: { version: 1, adapter: "artifact_bundle_v1", idempotency: "content_addressed", reconciliation: "artifact_bundle_v1" }, description: "Atomically commit a bounded multi-file local artifact as one immutable content-addressed directory; exact replay verifies and reuses the same revision." },
  { name: "ask_user_question", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", blockedFor: ["workflow-step", "worker"], loopClass: "mutating", actionTopologyRole: "control", description: "Ask the user a question when the answer would change what you do \u2014 scope, target, format, or a boundary only they can decide." },
  { name: "automation_opportunity_get", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", actionTopologyRole: "control", description: "Read one inert automation opportunity proposal by its exact ID." },
  { name: "automation_opportunity_list", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", actionTopologyRole: "control", description: "List inert automation opportunity proposals for review." },
  { name: "automation_opportunity_propose", sideEffect: "write", runtimeEffect: "host_only", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", loopClass: "mutating", actionTopologyRole: "control", description: "Persist an inert, reviewable automation opportunity without granting execution authority." },
  { name: "automation_opportunity_revise", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", loopClass: "mutating", actionTopologyRole: "control", description: "Revise an inert automation opportunity without granting execution authority." },
  { name: "automation_opportunity_review_request", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], needsApproval: false, loopClass: "mutating", actionTopologyRole: "control", description: "Stage an exact proposal CAS and formal human decision card without granting execution authority." },
  { name: "automation_read_pilot_acquisition_list", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "read-only", blockedFor: ["workflow-step", "worker"], loopClass: "idempotent", actionTopologyRole: "control", description: "List exact host-issued live read acquisition references without granting authority." },
  { name: "automation_read_pilot_request", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], needsApproval: false, loopClass: "mutating", actionTopologyRole: "control", description: "Create an exact one-read pilot projection and its formal approval card." },
  { name: "automation_read_pilot_workspace_create_request", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], needsApproval: false, loopClass: "mutating", actionTopologyRole: "control", description: "Stage an exact local Workspace manifest and formal human creation card without granting workflow authority." },
  { name: "automation_read_pilot_workspace_list", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "read-only", blockedFor: ["workflow-step", "worker"], loopClass: "idempotent", actionTopologyRole: "control", description: "List exact current Workspace revisions without selecting or binding one." },
  { name: "automation_recurrence_request", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], needsApproval: false, loopClass: "mutating", actionTopologyRole: "control", description: "Stage a disabled interval preview and formal recurrence-consent card from one exact clean pilot." },
  // The background-task family is control-plane (task-lifecycle coordination,
  // same family as run_worker/execution_create) — the default business role
  // made a plain status read on an act-authority turn a turn-killing 500
  // (live 2026-08-11, long-horizon-manifest origin: background_task_status →
  // ExpectedWorkBindingRequiredError).
  { name: "background_task_revise", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "read-only", loopClass: "mutating", blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", actionControlContext: "task_recovery", delegationPrimitive: true, description: "Version and course-correct an active durable background task on its existing session." },
  { name: "background_task_status", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", actionTopologyRole: "control", actionControlContext: "task_recovery", description: "Inspect a durable background task by task id, run id, or session id." },
  { name: "background_tasks_recent", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", actionTopologyRole: "control", actionControlContext: "task_recovery", description: "List recent durable background tasks with status, latest activity, approvals, and result\u2026" },
  { name: "browser_harness_run", sideEffect: "write", tier: "core", lanes: ["orchestrator", "cli"], delegationPrimitive: true, description: "Run a Browser Harness Python snippet against the user browser through the browser-harness\u2026" },
  { name: "browser_harness_status", sideEffect: "read", tier: "core", lanes: ["orchestrator", "cli"], actionTopologyRole: "control", description: "Check Browser Harness availability and setup state." },
  // Generic gated dispatcher for schema-on-demand (SCHEMA-ON-DEMAND-PLAN-2026-07-07,
  // Phase 1). Structural, orchestrator-lane only, added to assembledTools ONLY when
  // CLEMMY_CODEX_TOOL_SEARCH is on (lanes [] like request_approval/run_worker).
  // sideEffect 'write' = documented default-ask, but needsApproval is FALSE: the
  // runtime gate keys on the INNER tool (dispatchBatchItemTool), not call_tool.
  { name: "call_tool", sideEffect: "write", tier: "core", lanes: [], needsApproval: false, description: "Invoke a catalog-only built-in tool by name with a JSON args string; effects and gates key on the inner tool." },
  { name: "check_capability", sideEffect: "read", tier: "discoverable", lanes: ["cli"], actionTopologyRole: "control", delegationPrimitive: true, description: "Check whether a CLI / binary is available on this machine." },
  { name: "cli_setup", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], loopClass: "mutating", blockedFor: ["workflow-step", "worker"], delegationPrimitive: true, description: "Install or re-authenticate a local CLI via the approved runners: status | install | auth | job_status. Ask the user before install/auth." },
  { name: "project_run", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], loopClass: "mutating", blockedFor: ["workflow-step", "worker"], delegationPrimitive: true, description: "Inspect or stop historical Claude Code / Codex guest runs: status | runs | kill. start is unavailable until a durable delegated-execution root owns the child effects and receipt." },
  { name: "check_delegation", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", actionTopologyRole: "control", description: "Check a delegated task by ID or list delegations for an agent." },
  { name: "composio_execute_tool", sideEffect: "send", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "agentic", innerDispatch: "write", loopClass: "mutating", description: "Execute any Composio action by exact slug (Outlook list-mail, Gmail search, Drive search,\u2026" },
  { name: "composio_list_tools", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "agentic", loopClass: "idempotent", cacheSafeRead: true, actionTopologyRole: "control", description: "List available Composio tools for one connected toolkit slug, such as gmail, slack, notio\u2026" },
  { name: "composio_search_tools", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "agentic", loopClass: "idempotent", cacheSafeRead: true, actionTopologyRole: "control", description: "Search Composio for the right action slug." },
  { name: "composio_status", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", actionTopologyRole: "control", description: "Inspect whether Composio is configured and list active third-party app connections availa\u2026" },
  { name: "convert_to_markdown", sideEffect: "write", tier: "discoverable", lanes: ["cli"], description: "Extract a non-text file (PDF, Word/Excel/PowerPoint, EPub, image, audio, \u2026) into Markdown\u2026" },
  { name: "create_agent", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", delegationPrimitive: true, description: "Create a new active team agent with its own personality, tools, and project binding." },
  { name: "create_tool", sideEffect: "admin", tier: "discoverable", lanes: ["cli"], blockedFor: ["workflow-step", "worker"], description: "Create a reusable shell or python tool script in ~/.clementine-next/tools." },
  { name: "cron_progress_read", sideEffect: "read", tier: "discoverable", lanes: ["cli"], actionTopologyRole: "control", description: "Read saved progress state for a cron job." },
  { name: "delegate_task", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", delegationPrimitive: true, description: "Delegate a task to another team agent using local delegation state." },
  { name: "delegation_inbox", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", actionTopologyRole: "control", description: "List delegated tasks assigned to the current team agent and still open." },
  { name: "complete_delegation", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "authoring", actionTopologyRole: "control", delegationPrimitive: true, description: "Finish a delegated task assigned to the current team agent by recording its result." },
  { name: "delete_agent", sideEffect: "admin", tier: "discoverable", lanes: ["cli"], blockedFor: ["workflow-step", "worker"], description: "Delete an agent definition." },
  { name: "desktop_status", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator"], actionTopologyRole: "control", description: "Read-only status for the locally installed Clementine desktop app, including installed bu\u2026" },
  { name: "discover_work", sideEffect: "read", tier: "discoverable", lanes: ["cli"], loopClass: "idempotent", actionTopologyRole: "control", description: "Scan handoffs, plans, goals, tasks, and inbox items to find prioritized work that should\u2026" },
  { name: "dispatch_background_task", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", actionTopologyRole: "control", delegationPrimitive: true, description: "Hand an AGREED, multi-step task to the reliable background runner (fire-and-forget)." },
  { name: "draft_plan", sideEffect: "read", tier: "core", lanes: [], actionTopologyRole: "control", description: "Draft a structured plan for multi-step work before executing it." },
  { name: "execution_complete", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "full-extra", loopClass: "mutating", actionTopologyRole: "control", actionControlContext: "alternate_action_owner", description: "Mark a tracked execution complete after its criteria are verified. Args: id, summary." },
  // Creating an execution lane MINTS DURABLE MUTATION AUTHORITY: it is the
  // record that later external writes point at to prove they were wrapped. A
  // 'read' classification told every telemetry and guardrail consumer that
  // opening that authority costs nothing, so a spinning turn could mint lanes
  // freely and none of it read as mutating work. Classify it honestly as a
  // write, with the same two overrides call_tool documents above:
  //   needsApproval FALSE — this tool is the ESCAPE from the execution gate
  //     (execution-gate.ts EXEMPT_TOOL_NAMES). Approval belongs to the effects
  //     performed INSIDE the lane, never to opening it; gating it here would
  //     deadlock every tracked execution and reintroduce a confirmation beat.
  //   loopClass 'mutating' — repeating it does not corrupt a provider, but it
  //     mints duplicate authority records, which is exactly the repetition the
  //     tight guardrail thresholds exist to catch.
  { name: "execution_create", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "full-extra", needsApproval: false, loopClass: "mutating", actionTopologyRole: "control", actionControlContext: "alternate_action_owner", delegationPrimitive: true, description: "Create a tracked execution lane for multi-step or mutating external work." },
  { name: "execution_get", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "full-extra", actionTopologyRole: "control", actionControlContext: "alternate_action_owner", description: "Fetch one execution by id with full context (objective, plan, next step, success criteria\u2026" },
  { name: "execution_list", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "full-extra", actionTopologyRole: "control", actionControlContext: "alternate_action_owner", description: "List executions for inspection." },
  { name: "execution_mark_blocked", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "full-extra", loopClass: "mutating", actionTopologyRole: "control", actionControlContext: "alternate_action_owner", description: "Mark an execution as blocked with a concrete blocker description." },
  { name: "execution_update_step", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "full-extra", loopClass: "mutating", actionTopologyRole: "control", actionControlContext: "alternate_action_owner", delegationPrimitive: true, description: "Advance an execution: record the next concrete step and an optional summary of what just\u2026" },
  { name: "execution_reconcile_write", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "full-extra", loopClass: "mutating", actionTopologyRole: "control", actionControlContext: "alternate_action_owner", delegationPrimitive: true, description: "Settle an ambiguous/orphaned external write from read-back evidence: absent unlocks one retry, present records it done." },
  { name: "focus_activate", sideEffect: "write", runtimeEffect: "host_only", tier: "discoverable", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], loopClass: "mutating", actionTopologyRole: "control", actionControlContext: "task_recovery", description: "Resume a previously parked focus." },
  { name: "focus_clear", sideEffect: "write", runtimeEffect: "host_only", tier: "discoverable", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], loopClass: "mutating", actionTopologyRole: "control", description: "Mark a focus as done." },
  { name: "focus_get", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], loopClass: "idempotent", cacheSafeRead: true, readMutatedBy: ["focus_set", "focus_update", "focus_touch", "focus_park", "focus_activate", "focus_clear"], actionTopologyRole: "control", actionControlContext: "task_recovery", description: "Read the assistant's current attention pointer." },
  { name: "focus_park", sideEffect: "write", runtimeEffect: "host_only", tier: "discoverable", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], loopClass: "mutating", actionTopologyRole: "control", description: "Park the active focus \u2014 flips it from active to paused so it stays resumable but no longe\u2026" },
  { name: "focus_set", sideEffect: "write", runtimeEffect: "host_only", tier: "core", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], loopClass: "mutating", actionTopologyRole: "control", description: "Pin a NEW current focus." },
  { name: "artifact_claim_resolve", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator"], loopClass: "mutating", actionTopologyRole: "control", description: "Resolve an unresolved provider-create claim after read-only verification: bind the found resource id (evidence-gated) or release a provably-absent claim." },
  { name: "focus_touch", sideEffect: "write", runtimeEffect: "host_only", tier: "discoverable", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], loopClass: "mutating", actionTopologyRole: "control", actionControlContext: "task_recovery", description: "Bump the last-touched time + reset the idle-confirm window for an active focus." },
  { name: "focus_update", sideEffect: "write", runtimeEffect: "host_only", tier: "core", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], loopClass: "mutating", actionTopologyRole: "control", description: "Evolve an existing focus and optionally patch its sparse shared workstate." },
  { name: "git_status", sideEffect: "read", projectEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", description: "Run a read-only git status in an allowed workspace directory." },
  { name: "goal_list", sideEffect: "read", tier: "core", lanes: ["orchestrator", "cli"], loopClass: "idempotent", actionTopologyRole: "control", description: "List persistent goals, optionally filtered by owner or status." },
  { name: "goal_stale", sideEffect: "write", tier: "core", lanes: [], actionTopologyRole: "control", description: "Detect or mark long-running goals that have gone stale (not updated in a while)." },
  { name: "goal_upsert", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", loopClass: "mutating", actionTopologyRole: "control", description: "Create a persistent goal when no id matches, or update the existing goal when one does \u2014 the single durable-goal write tool." },
  { name: "harness_status", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", actionTopologyRole: "control", description: "Inspect Clementine harness-internal capability health." },
  { name: "hold_task_for_later", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", actionTopologyRole: "control", delegationPrimitive: true, description: 'HOLD an agreed multi-step task for later instead of running it now \u2014 the "or you can ask\u2026' },
  { name: "list_files", sideEffect: "read", hostReadOnlyExecution: "pure_local", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", cacheSafeRead: true, readMutatedBy: ["write_file", "artifact_bundle_save", "replace_file", "run_shell_command"], description: "List files in an allowed workspace directory." },
  { name: "list_pending_check_ins", sideEffect: "read", tier: "discoverable", lanes: ["cli"], actionTopologyRole: "control", description: "List open check-ins waiting for a user answer." },
  { name: "local_cli_list", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "agentic", innerDispatch: "read", actionTopologyRole: "control", delegationPrimitive: true, description: "List CLIs installed on the local machine and detected on $PATH." },
  { name: "local_cli_probe", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "agentic", innerDispatch: "read", actionTopologyRole: "control", delegationPrimitive: true, description: "Probe a specific local CLI by running `<command> --version` and `<command> --help`." },
  { name: "mcp_add", sideEffect: "admin", tier: "discoverable", lanes: ["orchestrator", "cli"], localPlanning: { consequence: "runtime_configuration", reversibility: "unknown", destructive: false, purpose: "configure_runtime", inputKind: "configuration", outputKind: "configuration", deliverableKind: "runtime_configuration", destinationPosture: "create_new", advisoryRoles: ["admin"] }, description: "Create a NEW external MCP server configuration." },
  { name: "mcp_configure", sideEffect: "admin", tier: "discoverable", lanes: ["orchestrator", "cli"], localPlanning: { consequence: "runtime_configuration", reversibility: "unknown", destructive: false, purpose: "configure_runtime", inputKind: "configuration", outputKind: "configuration", deliverableKind: "runtime_configuration", destinationPosture: "named_existing", advisoryRoles: ["admin"] }, description: "Edit an EXISTING external MCP server's NON-SECRET fields (description/command/args/url/he\u2026" },
  { name: "mcp_list_tools", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", actionTopologyRole: "control", description: "Search one configured external MCP server for exact callable names and the best match's real input schema." },
  { name: "mcp_reconnect", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "cli"], actionTopologyRole: "control", description: "Recover an external MCP server that is degraded/unavailable (stuck in the connection back\u2026" },
  { name: "mcp_status", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", actionTopologyRole: "control", description: "Inspect configured external MCP servers available to Clementine." },
  { name: "memory_embed_backfill", sideEffect: "write", tier: "discoverable", lanes: ["cli"], actionTopologyRole: "control", description: "Compute embeddings for vault chunks and/or durable facts using the active embedding provi\u2026" },
  { name: "memory_forget", sideEffect: "write", runtimeEffect: "host_only", tier: "core", lanes: ["orchestrator", "cli"], loopClass: "mutating", actionTopologyRole: "control", description: "Soft-delete a fact by id (sets active=0)." },
  { name: "memory_import", sideEffect: "write", tier: "discoverable", lanes: ["cli"], actionTopologyRole: "control", description: "Import ANOTHER agent's memory files (Claude Code memories, OpenClaw/Fermis stores, bare m\u2026" },
  { name: "memory_list_facts", sideEffect: "read", projectEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", actionTopologyRole: "control", description: "List or query durable facts as filterable JSON. Pass query for targeted lookup." },
  { name: "memory_pin", sideEffect: "write", runtimeEffect: "host_only", tier: "discoverable", lanes: ["orchestrator", "cli"], actionTopologyRole: "control", description: "Pin a fact as a STANDING INSTRUCTION (always injected into context, exempt from the recen\u2026" },
  { name: "memory_read", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", actionTopologyRole: "control", description: "Read a durable memory reference (fact:<id> or policy:<id>), a key memory file, or a vault-relative markdown path." },
  { name: "memory_recall", sideEffect: "read", projectEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", cacheSafeRead: true, readMutatedBy: ["memory_remember", "memory_forget"], actionTopologyRole: "control", description: "Recall vault chunks." },
  { name: "memory_recall_all", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", cacheSafeRead: true, readMutatedBy: ["memory_remember", "memory_forget"], actionTopologyRole: "control", description: "Recall relevant facts, notes, entities, resources, episodes, policies, and proven tools through one evidence-backed pipeline." },
  { name: "memory_remember", sideEffect: "write", runtimeEffect: "host_only", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "mutating", actionTopologyRole: "control", description: "Record a durable fact in long-term memory." },
  { name: "memory_restore", sideEffect: "write", runtimeEffect: "host_only", tier: "discoverable", lanes: ["orchestrator", "cli"], actionTopologyRole: "control", description: "Restore (reactivate) a soft-deleted fact by id \u2014 the inverse of memory_forget." },
  { name: "memory_review_instructions", sideEffect: "read", tier: "core", lanes: ["orchestrator", "cli"], actionTopologyRole: "control", description: "Before a batch/irreversible external write, review the standing instructions in play." },
  { name: "memory_search", sideEffect: "read", projectEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", cacheSafeRead: true, readMutatedBy: ["memory_remember", "memory_forget"], actionTopologyRole: "control", description: "Search the local Clementine vault for relevant notes and memories." },
  { name: "memory_search_facts", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", actionTopologyRole: "control", description: "Semantically search durable FACTS (your long-term memory of the user, projects, standing\u2026" },
  { name: "memory_self_heal", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "cli"], actionTopologyRole: "control", description: "Inspect or run the audited long-term-memory self-heal loop." },
  { name: "note_create", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", loopClass: "mutating", actionTopologyRole: "control", description: "Create a new note in the vault." },
  // A notification is a durable host-owned record the user will read: at
  // runtime a host_only mutation like memory_remember, never a read. With no
  // runtime override, a `send` step whose whole job is notify_user settled
  // with zero mutations and the settlement audit called it unproven
  // (morning-briefing, 2026-09-01, five runs). host_only asks no consent and
  // stays out of business accounting; the taxonomy class stays `read` so the
  // approval floor and the sideEffect/classifyTool mirror are unchanged.
  { name: "notify_user", sideEffect: "read", runtimeEffect: "host_only", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "agentic", blockedFor: ["worker"], loopClass: "mutating", actionTopologyRole: "control", description: "Send a notification to the user via the notification queue." },
  { name: "pending_action_execute", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["worker"], needsApproval: false, loopClass: "mutating", actionTopologyRole: "control", delegationPrimitive: true, description: "Execute the exact stored payload of an approved single-call pending action." },
  { name: "pending_action_get", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", actionTopologyRole: "control", description: "Read one queued action with its exact payload, status, approval id, preview, and result h\u2026" },
  { name: "pending_action_list", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", actionTopologyRole: "control", description: "List durable pending actions." },
  { name: "pending_action_queue", sideEffect: "write", runtimeEffect: "host_only", tier: "core", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["worker"], actionTopologyRole: "control", description: "Queue a fully prepared action payload before an irreversible external write/send/deploy o\u2026" },
  { name: "pending_action_record_result", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["worker"], actionTopologyRole: "control", description: "After executing or cancelling a queued action, record the outcome so Clementine can repor\u2026" },
  { name: "plan_task", sideEffect: "write", runtimeEffect: "host_only", hostControlFrame: "sole", hostModelFrameClass: "fresh_plan_barrier", tier: "core", lanes: [], needsApproval: false, loopClass: "mutating", actionTopologyRole: "control", description: "Admit and freeze one primary-model action plan for the exact accepted request." },
  { name: "ping", sideEffect: "read", tier: "discoverable", lanes: ["sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", actionTopologyRole: "control", description: "Basic health-check tool for the local Clementine tool runtime." },
  { name: "propose_check_in_template", sideEffect: "read", tier: "discoverable", lanes: ["cli"], actionTopologyRole: "control", description: "Propose a NEW autonomous check-in template the user can approve." },
  { name: "read_file", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", cacheSafeRead: true, readMutatedBy: ["write_file", "artifact_bundle_save", "replace_file", "run_shell_command"], description: "Read a file from an allowed workspace path." },
  { name: "recall_tool_result", sideEffect: "read", projectEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", actionTopologyRole: "control", description: "Retrieve the full verbatim output of a prior tool call by its call_id." },
  { name: "request_approval", sideEffect: "write", tier: "core", lanes: [], blockedFor: ["worker"], loopClass: "mutating", actionTopologyRole: "control", description: "Pause and ask the user to approve a high-risk action or one batch of same-shape external\u2026" },
  { name: "resume_held_task", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", actionTopologyRole: "control", actionControlContext: "task_recovery", delegationPrimitive: true, description: 'Resume a task the user previously asked you to HOLD (see your Current Focus "Held" list),\u2026' },
  { name: "run_batch", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "full-extra", blockedFor: ["worker"], actionTopologyRole: "control", delegationPrimitive: true, description: "Deterministic batch executor for N same-shape tool calls: reason ONCE (bake every item's\u2026" },
  { name: "run_shell_command", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "agentic", innerDispatch: "write", loopClass: "mutating", description: "Run a shell command in an allowed workspace directory." },
  // actionTopologyRole 'control': run_worker is the fan-out COORDINATION
  // primitive — it spawns children whose business dispatches settle at their
  // own boundaries (same family as execution_create). Classifying it business
  // made act-routed fan-out structurally impossible: dropped from the direct
  // surface, absent from the carrier universe, and walled by the work-binding
  // gate (live 2026-08-11: '"run_worker" is not a deferred callable tool').
  { name: "run_worker", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "full-extra", blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", delegationPrimitive: true, description: "Spawn a stateless Worker on ONE item using a structured parent-planned job packet." },
  { name: "session_history", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", actionTopologyRole: "control", actionControlContext: "task_recovery", description: "Read recent conversation history for a session." },
  { name: "session_pause", sideEffect: "write", tier: "discoverable", lanes: ["cli"], actionTopologyRole: "control", description: "Save a structured handoff for a session so work can resume cleanly after context drift, a\u2026" },
  { name: "session_resume", sideEffect: "write", tier: "discoverable", lanes: ["cli"], actionTopologyRole: "control", description: "Summarize a session using its continuity brief and recent transcript so work can resume c\u2026" },
  { name: "set_model_role", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", actionTopologyRole: "control", description: "Route a model ROLE to a specific model, when the user asks in chat (e.g." },
  { name: "set_timer", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", loopClass: "mutating", actionTopologyRole: "control", description: 'Schedule a one-time reminder notification ("remind me") at an exact time tonight or in N minutes, within 24 hours.' },
  { name: "share_plan", sideEffect: "read", tier: "core", lanes: ["orchestrator", "cli"], actionTopologyRole: "control", description: "Share a non-blocking working plan in the current chat before continuing." },
  { name: "skill_list", sideEffect: "read", projectEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", cacheSafeRead: true, actionTopologyRole: "control", description: "List installed SKILL.md skills (Anthropic Skills format) with name + one-line description." },
  { name: "skill_read", sideEffect: "read", projectEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", cacheSafeRead: true, actionTopologyRole: "control", description: "Load the full body of an installed SKILL.md skill into context." },
  { name: "source_map_upsert", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", actionTopologyRole: "control", description: "Record WHERE a resource lives in one of the user's connected sources \u2014 a Drive folder, an\u2026" },
  { name: "space_action_prepare", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", featureGroup: "spaces-dock", loopClass: "mutating", actionTopologyRole: "control", delegationPrimitive: true, description: "Prepare one declared Workspace action for exact approval, or execute it only when an exact existing standing approval covers the current action, arguments, and runner bytes." },
  { name: "space_diff", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker"], sdkLayer: "read-only", featureGroup: "spaces-dock", loopClass: "idempotent", actionTopologyRole: "control", description: "Compare two retained successful observations for one Workspace data source, defaulting to current versus prior." },
  { name: "space_edit_runner", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", featureGroup: "spaces-dock", actionTopologyRole: "control", delegationPrimitive: true, localPlanning: { consequence: "workspace_definition", reversibility: "reversible", destructive: false, purpose: "author_workspace_runner", inputKind: "workspace_runner_patch", outputKind: "workspace_revision", deliverableKind: "workspace", destinationPosture: "named_existing", advisoryRoles: ["author", "destination"] }, description: "Make a TARGETED, reversible edit to a Workspace runner's SOURCE \u2014 FAST, for changing what\u2026" },
  { name: "space_edit_view", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", featureGroup: "spaces-dock", actionTopologyRole: "control", localPlanning: { consequence: "workspace_definition", reversibility: "reversible", destructive: false, purpose: "author_workspace", inputKind: "workspace_patch", outputKind: "workspace_revision", deliverableKind: "workspace", destinationPosture: "named_existing", advisoryRoles: ["author", "destination"] }, description: "Make a TARGETED edit to an existing Workspace view \u2014 FAST, for small tweaks (a button, la\u2026" },
  { name: "space_get", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker"], sdkLayer: "read-only", featureGroup: "spaces-dock", actionTopologyRole: "control", description: "Read a Workspace: its manifest (title, status, data sources, re-engage contract), a snaps\u2026" },
  { name: "space_get_runner", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker"], sdkLayer: "read-only", featureGroup: "spaces-dock", actionTopologyRole: "control", description: "Read the SOURCE of a Workspace data/action RUNNER (the .mjs/.py/.sh script under data/ th\u2026" },
  { name: "space_get_view", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker"], sdkLayer: "read-only", featureGroup: "spaces-dock", actionTopologyRole: "control", description: "Read the CURRENT view HTML of a Workspace, line-numbered \u2014 this is the EXACT text you nee\u2026" },
  { name: "space_history", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker"], sdkLayer: "read-only", featureGroup: "spaces-dock", loopClass: "idempotent", actionTopologyRole: "control", description: "List bounded, metadata-only observation history for a Workspace without loading raw retained datasets." },
  { name: "space_list", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker"], sdkLayer: "read-only", featureGroup: "spaces-dock", actionTopologyRole: "control", description: "List the user's Workspaces (persistent interactive surfaces you built)." },
  { name: "space_publish", sideEffect: "send", tier: "discoverable", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", featureGroup: "spaces-dock", description: "Export a Workspace as a STATIC, share-ready snapshot \u2014 the shareable counterpart to the l\u2026" },
  { name: "space_refresh", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", featureGroup: "spaces-dock", actionTopologyRole: "control", delegationPrimitive: true, description: "Re-run a Workspace's data source(s) NOW (server-side, no LLM) and persist the fresh datas\u2026" },
  { name: "space_revert_runner", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", featureGroup: "spaces-dock", actionTopologyRole: "control", delegationPrimitive: true, description: "Undo the most recent space_edit_runner on a runner, restoring its prior source from the s\u2026" },
  { name: "space_save", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", featureGroup: "spaces-dock", actionTopologyRole: "control", delegationPrimitive: true, localPlanning: { consequence: "workspace_definition", reversibility: "reversible", destructive: false, purpose: "author_workspace", inputKind: "workspace_definition", outputKind: "workspace_revision", deliverableKind: "workspace", destinationPosture: "create_new", advisoryRoles: ["author", "create", "destination"] }, description: "Create or update a Workspace \u2014 a persistent, interactive HTML surface you build for the u\u2026" },
  { name: "space_set_data", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", featureGroup: "spaces-dock", actionTopologyRole: "control", loopClass: "mutating", localPlanning: { consequence: "workspace_definition", reversibility: "reversible", destructive: false, purpose: "update_workspace_dataset", inputKind: "workspace_dataset", outputKind: "workspace_observation", deliverableKind: "workspace", destinationPosture: "named_existing", advisoryRoles: ["update", "destination"] }, localExecution: { version: 1, adapter: "workspace_dataset_v1", idempotency: "content_addressed", reconciliation: "workspace_dataset_v1" }, description: "Commit a dataset you ALREADY HAVE IN HAND directly into the workspace under a source id \u2014\u2026" },
  { name: "space_try_runner", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain"], sdkLayer: "authoring", featureGroup: "spaces-dock", actionTopologyRole: "control", description: "Statically inspect a legacy Workspace runner's declared role and provenance without executing it; execution remains behind space_refresh or the normal Workspace action approval path." },
  { name: "surface_plan", sideEffect: "read", tier: "core", lanes: ["orchestrator", "cli"], blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", description: "Surface a Plan you just received from `draft_plan` to the user for review." },
  { name: "task_add", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", loopClass: "mutating", actionTopologyRole: "control", description: "Add a passive one-time item to the user's TODO list; it does not fire at a scheduled time." },
  { name: "task_hygiene", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "cli"], actionTopologyRole: "control", description: "Repair and compact the task ledger so completed execution-owned tasks do not remain in th\u2026" },
  { name: "task_list", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", actionTopologyRole: "control", description: "List tasks from the master task list." },
  { name: "task_update", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", loopClass: "mutating", actionTopologyRole: "control", description: "Update a task by ID and optionally move it between pending and completed." },
  { name: "team_list", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", actionTopologyRole: "control", description: "List all team agents and their messaging permissions." },
  { name: "team_message", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", actionTopologyRole: "control", delegationPrimitive: true, description: "Queue a message to another team agent." },
  { name: "team_pending_requests", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", actionTopologyRole: "control", description: "List pending requests assigned to the current team agent." },
  { name: "team_reply", sideEffect: "send", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", delegationPrimitive: true, description: "Reply to a queued team request and mark it completed." },
  { name: "team_request", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", actionTopologyRole: "control", delegationPrimitive: true, description: "Create a structured request for another team agent and queue it locally." },
  { name: "tool_choice_forget", sideEffect: "write", tier: "core", lanes: ["orchestrator"], actionTopologyRole: "control", description: "HARD-clear a remembered tool choice so the next request fully re-discovers it." },
  { name: "tool_choice_invalidate", sideEffect: "write", tier: "core", lanes: ["orchestrator", "cli"], loopClass: "mutating", actionTopologyRole: "control", description: "Mark the currently-recorded tool choice for an intent as broken." },
  { name: "tool_choice_recall", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", actionTopologyRole: "control", description: "Look up the previously-recorded tool choice for an intent (per-machine memory)." },
  { name: "tool_choice_remember", sideEffect: "write", tier: "core", lanes: ["orchestrator", "cli"], loopClass: "mutating", actionTopologyRole: "control", description: "Save the tool that worked for an intent so future runs skip discovery." },
  { name: "tool_output_query", sideEffect: "read", projectEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch"], sdkLayer: "read-only", innerDispatch: "read", actionTopologyRole: "control", description: "Query a slice of a large prior tool output by its call_id, without loading the whole payl\u2026" },
  { name: "tool_search", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", actionTopologyRole: "control", description: "Search the full built-in tool catalog by intent and get matching names, summaries, and sc\u2026" },
  { name: "update_agent", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", delegationPrimitive: true, description: "Update an existing team agent." },
  { name: "user_profile_read", sideEffect: "read", projectEffect: "read", hostReadOnlyExecution: "pure_local", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", description: "Read the user's current profile (name, role, timezone, working hours, communication prefe\u2026" },
  { name: "workflow_apply_contract_fixes", sideEffect: "write", tier: "discoverable", lanes: ["cli"], actionTopologyRole: "control", description: "Apply safe, machine-readable fixes from a workflow visual contract." },
  { name: "workflow_capability_resolve", sideEffect: "write", runtimeEffect: "host_only", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", loopClass: "mutating", actionTopologyRole: "control", description: "Resolve an exact workflow capability pause by saving a human account choice or retrying after setup." },
  { name: "workflow_create", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", delegationPrimitive: true, localPlanning: { consequence: "workflow_definition", reversibility: "reversible", destructive: false, purpose: "author_workflow", inputKind: "workflow_definition", outputKind: "workflow_revision", deliverableKind: "workflow", destinationPosture: "create_new", advisoryRoles: ["author", "create", "destination"] }, description: "Create a workflow." },
  { name: "workflow_delete", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "cli"], blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", localPlanning: { consequence: "workflow_definition", reversibility: "irreversible", destructive: true, purpose: "delete_workflow", inputKind: "workflow_reference", outputKind: "deletion_receipt", deliverableKind: "workflow", destinationPosture: "named_existing", advisoryRoles: ["delete", "destination"] }, description: "Permanently delete a workflow definition file." },
  { name: "workflow_edit_step", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", actionTopologyRole: "control", delegationPrimitive: true, localPlanning: { consequence: "workflow_definition", reversibility: "reversible", destructive: false, purpose: "author_workflow", inputKind: "workflow_patch", outputKind: "workflow_revision", deliverableKind: "workflow", destinationPosture: "named_existing", advisoryRoles: ["author", "destination"] }, description: "Make a TARGETED, reversible edit to ONE step's prompt in an existing workflow \u2014 the FAST,\u2026" },
  { name: "workflow_from_session", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", actionTopologyRole: "control", delegationPrimitive: true, description: "Turn what you JUST did in this chat into a reusable, repeatable workflow." },
  { name: "workflow_get", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", loopClass: "idempotent", actionTopologyRole: "control", description: "Fetch the full definition of a single workflow by name." },
  { name: "workflow_import_framework", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "cli"], blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", delegationPrimitive: true, description: "Import workflow framework packages from a local folder or GitHub repo." },
  { name: "workflow_import_status", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "cli"], actionTopologyRole: "control", description: "Check a workflow framework import job." },
  { name: "workflow_list", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", loopClass: "idempotent", actionTopologyRole: "control", description: "List all workflows with description, steps, and trigger metadata." },
  { name: "workflow_rerun_failed_items", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", loopClass: "mutating", actionTopologyRole: "control", delegationPrimitive: true, description: "Re-run only the failed forEach items from a prior workflow run." },
  { name: "workflow_run", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], loopClass: "mutating", actionTopologyRole: "control", delegationPrimitive: true, localPlanning: { consequence: "workflow_definition", reversibility: "reversible", destructive: false, purpose: "dispatch_named_workflow", inputKind: "workflow_identity", outputKind: "workflow_run", deliverableKind: "workflow", destinationPosture: "create_new", advisoryRoles: ["control", "destination"] }, description: "Dispatch a workflow to run in the BACKGROUND (fire-and-forget) \u2014 it runs in the daemon an\u2026" },
  { name: "workflow_run_status", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", loopClass: "idempotent", actionTopologyRole: "control", description: "Check workflow runs." },
  { name: "workflow_schedule", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", delegationPrimitive: true, description: "Schedule a workflow to fire on a cron expression." },
  { name: "workflow_set_enabled", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", delegationPrimitive: true, description: "Approve or disable a workflow." },
  // Data-operation primitive (2026-07-21 capability audit #1): deterministic
  // reconcile/transform — the "spreadsheet brain". Pure read-class compute
  // (its only write is a transient staged spill file). Available everywhere
  // including workflow-step/worker/inner-dispatch: reconciliation is the middle of
  // the employee loop and must never require a bigger lane.
  { name: "table_ops", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "workflow-step", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", description: "Deterministic table algebra over lists/sheets: diff, intersect, join, dedupe, aggregate, select \u2014 sourced from inline rows, a prior tool call id (full parked output), or a staged file." },
  // Document production (2026-07-21 capability audit #4): render→PDF/DOCX +
  // template merge. A local reversible file write (the artifact chains into
  // uploads via the file pipeline); the SEND of that artifact stays gated at
  // the send tool as always.
  { name: "produce_document", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "workflow-step", "cli"], sdkLayer: "read-only", loopClass: "mutating", description: "Produce a real PDF/DOCX/HTML file from markdown or HTML with {{var}} template merge \u2014 returns a local filePath that chains into uploads/attachments." },
  // Large-input retrieval (2026-07-21 capability audit #2 v1): deterministic
  // chunk-and-retrieve over big files (auto-converted) and parked outputs.
  // actionTopologyRole 'control': same recall class as recall_tool_result /
  // tool_output_query — a deterministic host read over ALREADY-LANDED output.
  // Defaulting to 'business' routed it through work_call on action surfaces
  // (live 2026-08-18: a program-carried file_query → work_binding_required
  // while the model was just trying to read its own search result).
  { name: "file_query", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "workflow-step", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", actionTopologyRole: "control", description: "Query a big document or prior tool output for relevant passages (heading-aware chunks, deterministic ranking) instead of reading a byte-clipped preview." },
  // Structured extraction (2026-07-21 capability audit #3): schema-guided
  // NL→payload with deterministic validation. Uses a model internally (the
  // boundary-judge routing) but mutates nothing — read-class; the CREATE that
  // consumes the payload stays gated as always.
  { name: "extract_structured", sideEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "workflow-step", "cli"], sdkLayer: "read-only", loopClass: "idempotent", description: "Extract validated structured data from text/files/tool outputs against a JSON Schema or a cached Composio action schema \u2014 required fields verified, never invented." },
  // Mutual availability (2026-07-21 capability audit #6): pure interval
  // algebra over attendee busy windows fetched via the calendar actions.
  { name: "time_slots", sideEffect: "read", projectEffect: "read", hostReadOnlyExecution: "pure_local", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "workflow-step", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", description: "Compute mutual free meeting slots from attendees' busy intervals \u2014 exact interval algebra with working-hours/duration constraints." },
  // Employee-memory primitive (2026-07-21): durable cross-RUN state. Core +
  // available in the workflow-step/worker lanes — that's exactly where the
  // amnesia lived (an hourly scrape re-processed the same items every run).
  // sdkLayer read-only mirrors memory_remember: a LOCAL durable write is
  // allowed even on the read-only step lane (it mutates nothing external).
  { name: "workflow_reshape", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "workflow-step", "cli"], sdkLayer: "authoring", loopClass: "mutating", actionTopologyRole: "control", delegationPrimitive: true, description: "Add read-only prompt nodes with only a result channel and run-scoped artifact query, plus dependency edges into those nodes, on an active workflow run. Dynamic writes/sends, scripts, fan-out, and edge disable/enable are not supported; completed and in-flight targets are immutable." },
  { name: "workflow_state", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "workflow-step", "cli"], sdkLayer: "read-only", loopClass: "mutating", actionTopologyRole: "control", description: "Durable per-workflow memory across runs: watermarks/cursors + a processed-item ledger (filter_unprocessed / mark_processed) so recurring runs never redo work." },
  { name: "workflow_unschedule", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", description: "Disable a scheduled workflow so it stops firing, without deleting it." },
  { name: "workflow_update", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", blockedFor: ["workflow-step", "worker"], actionTopologyRole: "control", delegationPrimitive: true, localPlanning: { consequence: "workflow_definition", reversibility: "reversible", destructive: false, purpose: "author_workflow", inputKind: "workflow_patch", outputKind: "workflow_revision", deliverableKind: "workflow", destinationPosture: "named_existing", advisoryRoles: ["author", "destination"] }, description: "Patch workflow fields. If `steps` is provided it replaces the entire graph; use workflow_edit_step for one targeted prompt edit." },
  { name: "working_memory", sideEffect: "write", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "cli"], sdkLayer: "authoring", actionTopologyRole: "control", description: "Read, append, replace, or clear the working-memory scratchpad." },
  { name: "workspace_artifact_query", sideEffect: "read", projectEffect: "read", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", actionTopologyRole: "control", description: "Query exact rows, fields, and pages from a JSON/JSONL run-workspace artifact." },
  { name: "workspace_info", sideEffect: "read", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", actionTopologyRole: "control", description: "Get detailed info about a local project including README, CLAUDE.md, manifest, and struct\u2026" },
  { name: "workspace_list", sideEffect: "read", projectEffect: "read", hostReadOnlyExecution: "pure_local", tier: "discoverable", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "cli"], sdkLayer: "read-only", loopClass: "idempotent", description: "List local projects found in configured workspace directories." },
  { name: "workspace_roots", sideEffect: "read", projectEffect: "read", hostReadOnlyExecution: "pure_local", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "read-only", innerDispatch: "read", loopClass: "idempotent", description: "List directories Clementine is allowed to inspect or operate in." },
  { name: "write_file", sideEffect: "write", tier: "core", lanes: ["orchestrator", "sdk-brain", "sdk-worker", "inner-dispatch", "cli"], sdkLayer: "agentic", innerDispatch: "write", loopClass: "mutating", localPlanning: { consequence: "local_artifact", reversibility: "create_only", destructive: false, purpose: "create_local_artifact", inputKind: "artifact_content", outputKind: "local_artifact", deliverableKind: "file", destinationPosture: "create_new", advisoryRoles: ["author", "create", "destination"], safeMode: { id: "create", requiredEquals: { mode: "create" }, nullEquivalentToRequired: ["mode"], absentOrNull: ["append"] } }, localPlanningVariants: [{ consequence: "local_artifact", reversibility: "irreversible", destructive: false, purpose: "append_local_artifact", inputKind: "artifact_content", outputKind: "local_artifact", deliverableKind: "file", destinationPosture: "named_existing", advisoryRoles: ["author", "update", "destination"], safeMode: { id: "append", requiredEquals: {}, alternatives: [{ requiredEquals: { append: true }, allowedValues: { mode: ["create", "append", "overwrite", null] } }, { requiredEquals: { mode: "append" }, absentOrNull: ["append"] }] } }, { consequence: "local_artifact", reversibility: "irreversible", destructive: true, purpose: "overwrite_local_artifact", inputKind: "artifact_content", outputKind: "local_artifact", deliverableKind: "file", destinationPosture: "named_existing", advisoryRoles: ["author", "update", "destination"], safeMode: { id: "overwrite", requiredEquals: {}, alternatives: [{ requiredEquals: { append: false }, allowedValues: { mode: ["create", "append", "overwrite", null] } }, { requiredEquals: { mode: "overwrite" }, absentOrNull: ["append"] }] } }], description: "Create, append to, or overwrite a UTF-8 file inside an allowed local workspace path (content capped ~24KB/call \u2014 write big files in append:true chunks)." }
];

// src/tools/artifact-bundle-contract.ts
var import_zod2 = require("zod");

// src/tools/artifact-bundle-core.ts
var import_node_crypto4 = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_node_path4 = __toESM(require("node:path"), 1);
var ARTIFACT_BUNDLE_LIMITS = Object.freeze({
  maxFiles: 32,
  maxFileBytes: 64e3,
  maxTotalBytes: 256e3,
  maxPathBytes: 240,
  maxPathSegmentBytes: 120
});
var MANIFEST_NAME = ".clementine-bundle.json";
var BUNDLE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
var ArtifactBundleError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "ArtifactBundleError";
  }
  code;
};
function sha256(value) {
  return (0, import_node_crypto4.createHash)("sha256").update(value).digest("hex");
}
function rootDirectory(options) {
  return import_node_path4.default.resolve(options.rootDir ?? import_node_path4.default.join(BASE_DIR, "files", "bundles"));
}
function safeBundleId(raw) {
  const bundleId = raw.trim();
  if (!BUNDLE_ID.test(bundleId) || bundleId === "." || bundleId === ".." || bundleId.includes("..")) {
    throw new ArtifactBundleError(
      'bundle_id must be 1-80 lowercase ASCII letters, numbers, dots, dashes, or underscores and may not contain ".."',
      "invalid_bundle_id"
    );
  }
  return bundleId;
}
function safeRelativeFilePath(raw) {
  if (raw.length === 0 || raw !== raw.trim() || raw.includes("\\") || raw.includes("\0")) {
    throw new ArtifactBundleError(`unsafe artifact path: ${JSON.stringify(raw)}`, "invalid_path");
  }
  if (import_node_path4.default.posix.isAbsolute(raw) || import_node_path4.default.posix.normalize(raw) !== raw || raw === MANIFEST_NAME) {
    throw new ArtifactBundleError(`unsafe artifact path: ${JSON.stringify(raw)}`, "invalid_path");
  }
  const segments = raw.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || /[\u0000-\u001f\u007f]/.test(segment)) || Buffer.byteLength(raw, "utf8") > ARTIFACT_BUNDLE_LIMITS.maxPathBytes || segments.some((segment) => Buffer.byteLength(segment, "utf8") > ARTIFACT_BUNDLE_LIMITS.maxPathSegmentBytes)) {
    throw new ArtifactBundleError(`unsafe artifact path: ${JSON.stringify(raw)}`, "invalid_path");
  }
  return raw;
}
function prepareBundle(input) {
  const bundleId = safeBundleId(input.bundleId);
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > ARTIFACT_BUNDLE_LIMITS.maxFiles) {
    throw new ArtifactBundleError(
      `files must contain 1-${ARTIFACT_BUNDLE_LIMITS.maxFiles} entries`,
      "invalid_file_count"
    );
  }
  const seen = /* @__PURE__ */ new Set();
  let totalBytes = 0;
  const files = input.files.map((candidate) => {
    const relativePath = safeRelativeFilePath(candidate.path);
    if (seen.has(relativePath)) {
      throw new ArtifactBundleError(`duplicate artifact path: ${relativePath}`, "duplicate_path");
    }
    seen.add(relativePath);
    const bytes = Buffer.byteLength(candidate.content, "utf8");
    if (bytes > ARTIFACT_BUNDLE_LIMITS.maxFileBytes) {
      throw new ArtifactBundleError(
        `${relativePath} is ${bytes} bytes; the per-file limit is ${ARTIFACT_BUNDLE_LIMITS.maxFileBytes}`,
        "file_too_large"
      );
    }
    totalBytes += bytes;
    if (totalBytes > ARTIFACT_BUNDLE_LIMITS.maxTotalBytes) {
      throw new ArtifactBundleError(
        `bundle is ${totalBytes} bytes; the total limit is ${ARTIFACT_BUNDLE_LIMITS.maxTotalBytes}`,
        "bundle_too_large"
      );
    }
    return { path: relativePath, content: candidate.content, sha256: sha256(candidate.content), bytes };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const revisionDigest = sha256(closedCanonicalJson({
    version: 1,
    bundleId,
    files: files.map(({ path: filePath, sha256: digest, bytes }) => ({
      path: filePath,
      sha256: digest,
      bytes
    }))
  }));
  return { bundleId, files, totalBytes, revisionDigest };
}
function manifestFor(bundle) {
  return {
    version: 1,
    bundleId: bundle.bundleId,
    revisionDigest: bundle.revisionDigest,
    totalBytes: bundle.totalBytes,
    files: bundle.files.map(({ path: filePath, sha256: digest, bytes }) => ({
      path: filePath,
      sha256: digest,
      bytes
    }))
  };
}
function resultFor(bundle, directory, created) {
  return {
    version: 1,
    artifactId: `${bundle.bundleId}/${bundle.revisionDigest}`,
    bundleId: bundle.bundleId,
    revisionDigest: bundle.revisionDigest,
    contentDigest: bundle.revisionDigest,
    handle: directory,
    directory,
    manifestPath: import_node_path4.default.join(directory, MANIFEST_NAME),
    files: bundle.files.map(({ path: filePath, sha256: digest, bytes }) => ({
      path: filePath,
      filePath: import_node_path4.default.join(directory, ...filePath.split("/")),
      sha256: digest,
      bytes
    })),
    totalBytes: bundle.totalBytes,
    created
  };
}
function fsyncDirectory(directory) {
  const fd = (0, import_node_fs2.openSync)(directory, "r");
  try {
    (0, import_node_fs2.fsyncSync)(fd);
  } finally {
    (0, import_node_fs2.closeSync)(fd);
  }
}
function writeDurableFile(filePath, content) {
  const fd = (0, import_node_fs2.openSync)(filePath, "wx", 384);
  try {
    (0, import_node_fs2.writeFileSync)(fd, content, "utf8");
    (0, import_node_fs2.fsyncSync)(fd);
  } finally {
    (0, import_node_fs2.closeSync)(fd);
  }
}
function expectedDirectories(bundle) {
  const directories = /* @__PURE__ */ new Set();
  for (const file of bundle.files) {
    const segments = file.path.split("/");
    for (let end = 1; end < segments.length; end += 1) {
      directories.add(segments.slice(0, end).join("/"));
    }
  }
  return [...directories].sort();
}
function walkRevision(directory) {
  const files = [];
  const directories = [];
  const visit = (absolute, relative) => {
    for (const entry of (0, import_node_fs2.readdirSync)(absolute, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbsolute = import_node_path4.default.join(absolute, entry.name);
      const stat = (0, import_node_fs2.lstatSync)(childAbsolute);
      if (stat.isSymbolicLink()) return `symbolic link is forbidden: ${childRelative}`;
      if (stat.isDirectory()) {
        directories.push(childRelative);
        const refusal = visit(childAbsolute, childRelative);
        if (refusal) return refusal;
      } else if (stat.isFile()) {
        files.push(childRelative);
      } else {
        return `non-file entry is forbidden: ${childRelative}`;
      }
    }
    return void 0;
  };
  return { files, directories, refusal: visit(directory, "") };
}
function inspectPrepared(bundle, options) {
  const directory = import_node_path4.default.join(rootDirectory(options), bundle.bundleId, bundle.revisionDigest);
  if (!(0, import_node_fs2.existsSync)(directory)) return { status: "absent" };
  let rootStat;
  try {
    rootStat = (0, import_node_fs2.lstatSync)(directory);
  } catch (error) {
    return { status: "mismatch", reason: `revision could not be inspected: ${error.message}` };
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { status: "mismatch", reason: "revision target is not a real directory" };
  }
  try {
    const walked = walkRevision(directory);
    if (walked.refusal) return { status: "mismatch", reason: walked.refusal };
    const expectedFiles = [...bundle.files.map((file) => file.path), MANIFEST_NAME].sort();
    const actualFiles = walked.files.sort();
    if (closedCanonicalJson(actualFiles) !== closedCanonicalJson(expectedFiles)) {
      return { status: "mismatch", reason: "revision file set differs from the frozen manifest" };
    }
    const expectedDirs = expectedDirectories(bundle);
    if (closedCanonicalJson(walked.directories.sort()) !== closedCanonicalJson(expectedDirs)) {
      return { status: "mismatch", reason: "revision directory set differs from the frozen manifest" };
    }
    const persisted = JSON.parse((0, import_node_fs2.readFileSync)(import_node_path4.default.join(directory, MANIFEST_NAME), "utf8"));
    if (closedCanonicalJson(persisted) !== closedCanonicalJson(manifestFor(bundle))) {
      return { status: "mismatch", reason: "persisted bundle manifest differs from the requested revision" };
    }
    for (const file of bundle.files) {
      const body = (0, import_node_fs2.readFileSync)(import_node_path4.default.join(directory, ...file.path.split("/")));
      if (body.byteLength !== file.bytes || sha256(body) !== file.sha256) {
        return { status: "mismatch", reason: `artifact content differs: ${file.path}` };
      }
    }
    return { status: "present_exact", result: resultFor(bundle, directory, false) };
  } catch (error) {
    return { status: "mismatch", reason: `revision verification failed: ${error.message}` };
  }
}
function inspectArtifactBundleArtifactId(artifactId, options = {}) {
  const separator = artifactId.indexOf("/");
  if (separator <= 0 || artifactId.indexOf("/", separator + 1) !== -1) {
    return { status: "mismatch", reason: "artifact id is not a bundle/revision pair" };
  }
  let bundleId;
  try {
    bundleId = safeBundleId(artifactId.slice(0, separator));
  } catch (error) {
    return { status: "mismatch", reason: error.message };
  }
  const revisionDigest = artifactId.slice(separator + 1);
  if (!/^[a-f0-9]{64}$/.test(revisionDigest)) {
    return { status: "mismatch", reason: "artifact revision digest is malformed" };
  }
  const directory = import_node_path4.default.join(rootDirectory(options), bundleId, revisionDigest);
  if (!(0, import_node_fs2.existsSync)(directory)) return { status: "absent" };
  try {
    const stat = (0, import_node_fs2.lstatSync)(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { status: "mismatch", reason: "revision target is not a real directory" };
    }
    const raw = JSON.parse((0, import_node_fs2.readFileSync)(import_node_path4.default.join(directory, MANIFEST_NAME), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1 || raw.bundleId !== bundleId || raw.revisionDigest !== revisionDigest || !Array.isArray(raw.files)) return { status: "mismatch", reason: "persisted bundle manifest identity is malformed" };
    const files = [];
    const seen = /* @__PURE__ */ new Set();
    for (const candidate of raw.files) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return { status: "mismatch", reason: "persisted bundle manifest contains a malformed file row" };
      }
      const row = candidate;
      if (typeof row.path !== "string" || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) || typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 0) return { status: "mismatch", reason: "persisted bundle manifest contains invalid file metadata" };
      const relative = safeRelativeFilePath(row.path);
      if (seen.has(relative)) return { status: "mismatch", reason: `duplicate artifact path: ${relative}` };
      seen.add(relative);
      files.push({ path: relative, content: (0, import_node_fs2.readFileSync)(import_node_path4.default.join(directory, ...relative.split("/")), "utf8") });
    }
    const prepared = prepareBundle({ bundleId, files });
    if (prepared.revisionDigest !== revisionDigest) {
      return { status: "mismatch", reason: "artifact bytes do not match the revision identity" };
    }
    return inspectPrepared(prepared, options);
  } catch (error) {
    return { status: "mismatch", reason: `revision verification failed: ${error.message}` };
  }
}
function saveArtifactBundle(input, options = {}) {
  const bundle = prepareBundle(input);
  const prior = inspectPrepared(bundle, options);
  if (prior.status === "present_exact") return prior.result;
  if (prior.status === "mismatch") {
    throw new ArtifactBundleError(
      `refusing to overwrite an existing mismatched revision: ${prior.reason}`,
      "existing_mismatch"
    );
  }
  const root = rootDirectory(options);
  const bundleRoot = import_node_path4.default.join(root, bundle.bundleId);
  const finalDirectory = import_node_path4.default.join(bundleRoot, bundle.revisionDigest);
  (0, import_node_fs2.mkdirSync)(bundleRoot, { recursive: true, mode: 448 });
  const stagingDirectory = (0, import_node_fs2.mkdtempSync)(import_node_path4.default.join(bundleRoot, `.tmp-${process.pid}-${(0, import_node_crypto4.randomBytes)(4).toString("hex")}-`));
  let published = false;
  try {
    const directories = expectedDirectories(bundle);
    for (const relative of directories) {
      (0, import_node_fs2.mkdirSync)(import_node_path4.default.join(stagingDirectory, ...relative.split("/")), { recursive: true, mode: 448 });
    }
    for (const file of bundle.files) {
      writeDurableFile(import_node_path4.default.join(stagingDirectory, ...file.path.split("/")), file.content);
    }
    writeDurableFile(
      import_node_path4.default.join(stagingDirectory, MANIFEST_NAME),
      `${closedCanonicalJson(manifestFor(bundle))}
`
    );
    for (const relative of [...directories].sort((left, right) => right.split("/").length - left.split("/").length)) {
      fsyncDirectory(import_node_path4.default.join(stagingDirectory, ...relative.split("/")));
    }
    fsyncDirectory(stagingDirectory);
    options.beforePublish?.(stagingDirectory);
    try {
      (0, import_node_fs2.renameSync)(stagingDirectory, finalDirectory);
      published = true;
      fsyncDirectory(bundleRoot);
    } catch (error) {
      const code = error.code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      const concurrent = inspectPrepared(bundle, options);
      if (concurrent.status === "present_exact") return concurrent.result;
      throw new ArtifactBundleError(
        `concurrent revision publication did not match: ${concurrent.status === "mismatch" ? concurrent.reason : "target absent"}`,
        "existing_mismatch"
      );
    }
    const verified = inspectPrepared(bundle, options);
    if (verified.status !== "present_exact") {
      throw new ArtifactBundleError(
        `published revision failed verification: ${verified.status === "mismatch" ? verified.reason : "target absent"}`,
        "filesystem_refusal"
      );
    }
    return { ...verified.result, created: true };
  } catch (error) {
    if (error instanceof ArtifactBundleError) throw error;
    throw new ArtifactBundleError(`artifact bundle publication failed: ${error.message}`, "filesystem_refusal");
  } finally {
    if (!published) (0, import_node_fs2.rmSync)(stagingDirectory, { recursive: true, force: true });
  }
}

// src/tools/artifact-bundle-contract.ts
var artifactBundleFileShape = import_zod2.z.object({
  path: import_zod2.z.string().min(1).max(ARTIFACT_BUNDLE_LIMITS.maxPathBytes).describe('Safe relative POSIX path inside the bundle, for example "public/index.html". Absolute paths, backslashes, dot segments, and duplicates are refused.'),
  content: import_zod2.z.string().describe(`Exact UTF-8 file content (maximum ${ARTIFACT_BUNDLE_LIMITS.maxFileBytes} bytes per file).`)
}).strict();
var ARTIFACT_BUNDLE_TOOL_PARAMETERS = {
  bundle_id: import_zod2.z.string().min(1).max(80).describe('Stable lowercase artifact id, for example "sales-portal". The revision digest is derived from every file path and byte sequence.'),
  mode: import_zod2.z.literal("content_addressed").describe("Required safety mode. Revisions are immutable and never overwrite a prior revision."),
  files: import_zod2.z.array(artifactBundleFileShape).min(1).max(ARTIFACT_BUNDLE_LIMITS.maxFiles)
};
function executeArtifactBundleSave(args) {
  return saveArtifactBundle({
    bundleId: args.bundle_id,
    files: args.files
  });
}

// src/spaces/workspace-set-data-contract.ts
var import_node_crypto5 = require("node:crypto");
var import_zod3 = require("zod");
var WORKSPACE_SET_DATA_MAX_BYTES = 5 * 1024 * 1024;
var WORKSPACE_SET_DATA_MAX_SOURCE_CHARS = 120;
var WORKSPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
var SOURCE_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
var ARTIFACT_PREFIX = "workspace-dataset:v1";
var REFRESH_PREFIX = "workspace-set-data:v1";
var MAX_JSON_NODES = 2e5;
var MAX_JSON_DEPTH = 64;
var WORKSPACE_SET_DATA_TOOL_PARAMETERS = {
  slug: import_zod3.z.string().min(2).max(63).regex(WORKSPACE_SLUG_RE).describe("The existing active workspace slug."),
  source_id: import_zod3.z.string().min(1).max(WORKSPACE_SET_DATA_MAX_SOURCE_CHARS).describe("The canonical non-reserved source id to replace."),
  data_json: import_zod3.z.string().min(1).max(WORKSPACE_SET_DATA_MAX_BYTES).describe("A complete JSON object or array for this source id.")
};
var WorkspaceSetDataContractError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "WorkspaceSetDataContractError";
  }
  code;
};
function sha2562(value) {
  return (0, import_node_crypto5.createHash)("sha256").update(value, "utf8").digest("hex");
}
function utf8(value) {
  return Buffer.byteLength(value, "utf8");
}
function canonicalWorkspaceJson(value) {
  let nodes = 0;
  const visit = (input, depth) => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw new WorkspaceSetDataContractError(
        "json_limit_exceeded",
        "data_json exceeds the reviewed JSON traversal limit"
      );
    }
    if (input === null || typeof input === "string" || typeof input === "boolean") {
      return JSON.stringify(input);
    }
    if (typeof input === "number" && Number.isFinite(input)) return JSON.stringify(input);
    if (Array.isArray(input)) {
      return `[${input.map((entry) => visit(entry, depth + 1)).join(",")}]`;
    }
    if (input && typeof input === "object") {
      const object = input;
      return `{${Object.keys(object).sort().map(
        (key) => `${JSON.stringify(key)}:${visit(object[key], depth + 1)}`
      ).join(",")}}`;
    }
    throw new WorkspaceSetDataContractError(
      "invalid_json",
      "data_json contains a value outside the JSON domain"
    );
  };
  const canonical = visit(value, 0);
  if (utf8(canonical) > WORKSPACE_SET_DATA_MAX_BYTES) {
    throw new WorkspaceSetDataContractError(
      "json_limit_exceeded",
      `data_json exceeds the ${WORKSPACE_SET_DATA_MAX_BYTES}-byte limit`
    );
  }
  return canonical;
}
function exactArguments(value) {
  const parsed = import_zod3.z.strictObject(WORKSPACE_SET_DATA_TOOL_PARAMETERS).safeParse(value);
  if (!parsed.success) {
    const record3 = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    if (typeof record3.slug === "string" && !WORKSPACE_SLUG_RE.test(record3.slug)) {
      throw new WorkspaceSetDataContractError("invalid_slug", `invalid workspace slug "${record3.slug}"`);
    }
    throw new WorkspaceSetDataContractError(
      "arguments_invalid",
      "space_set_data arguments do not match the closed reviewed schema"
    );
  }
  return parsed.data;
}
function prepareWorkspaceSetData(value) {
  const args = exactArguments(value);
  if (!WORKSPACE_SLUG_RE.test(args.slug)) {
    throw new WorkspaceSetDataContractError("invalid_slug", `invalid workspace slug "${args.slug}"`);
  }
  const sourceId = args.source_id;
  if (sourceId !== sourceId.trim() || sourceId.length === 0 || sourceId.length > WORKSPACE_SET_DATA_MAX_SOURCE_CHARS || SOURCE_CONTROL_RE.test(sourceId)) {
    throw new WorkspaceSetDataContractError(
      "invalid_source",
      "source_id must already be canonical, bounded, and free of control characters"
    );
  }
  if (sourceId === "_meta") {
    throw new WorkspaceSetDataContractError(
      "reserved_source",
      '"_meta" is a reserved Workspace source key'
    );
  }
  if (utf8(args.data_json) > WORKSPACE_SET_DATA_MAX_BYTES) {
    throw new WorkspaceSetDataContractError(
      "json_limit_exceeded",
      `data_json exceeds the ${WORKSPACE_SET_DATA_MAX_BYTES}-byte limit`
    );
  }
  let data;
  try {
    data = JSON.parse(args.data_json);
  } catch (error) {
    throw new WorkspaceSetDataContractError(
      "invalid_json",
      `data_json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!data || typeof data !== "object") {
    throw new WorkspaceSetDataContractError(
      "invalid_json_root",
      "data_json must contain one complete JSON object or array"
    );
  }
  const canonicalData = canonicalWorkspaceJson(data);
  const contentDigest = sha2562(canonicalData);
  const argsDigest = sha2562([
    `${ARTIFACT_PREFIX}\0`,
    args.slug,
    "\0",
    sourceId,
    "\0",
    canonicalData
  ].join(""));
  return Object.freeze({
    args: Object.freeze({ ...args }),
    slug: args.slug,
    sourceId,
    data,
    canonicalData,
    contentDigest,
    argsDigest,
    refreshId: `${REFRESH_PREFIX}:${argsDigest}`
  });
}

// src/runtime/harness/reviewed-local-tool-transport.ts
var REVIEWED_LOCAL_PROVIDER_IDENTITY = "local_registry";
var REVIEWED_LOCAL_PROVIDER_VERSION = "local-registry-v1";
var REVIEWED_LOCAL_OPERATION_VERSION = "1";
var REVIEWED_LOCAL_ACCOUNT = "local_registry:host";
var REVIEWED_LOCAL_ARGUMENT_COMPILER = Object.freeze({
  id: "compile:reviewed-local-canonical-json:v1",
  version: "1"
});
var AUTHORIZED_LOCAL_REGISTRY_PROVENANCE = "authorized_local_registry";
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactDeclaration(name) {
  const rows = TOOL_REGISTRY.filter((entry) => entry.name === name);
  return rows.length === 1 ? rows[0] : null;
}
function validExecutionContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const contract = value;
  return contract.version === 1 && contract.idempotency === "content_addressed" && (contract.adapter === "artifact_bundle_v1" && contract.reconciliation === "artifact_bundle_v1" || contract.adapter === "workspace_dataset_v1" && contract.reconciliation === "workspace_dataset_v1");
}
function safeToken(value) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._/-]+/g, "_");
  return normalized && /^[a-z0-9][a-z0-9._/-]{0,63}$/.test(normalized) ? normalized : null;
}
function schemaAllowsExact(schema, expected) {
  if (!isRecord(schema)) return false;
  if (expected === null && schema.type === "null") return true;
  if (schema.const === expected) return true;
  if (Array.isArray(schema.enum) && schema.enum.some((value) => value === expected)) return true;
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.some((branch) => schemaAllowsExact(branch, expected))) return true;
  }
  return false;
}
function normalizedSemantics(semantics) {
  return {
    consequence: semantics.consequence,
    reversibility: semantics.reversibility,
    destructive: semantics.destructive,
    purpose: semantics.purpose.trim(),
    inputKind: semantics.inputKind.trim(),
    outputKind: semantics.outputKind.trim(),
    deliverableKind: semantics.deliverableKind.trim(),
    destinationPosture: semantics.destinationPosture,
    advisoryRoles: [...new Set(semantics.advisoryRoles.map((role) => role.trim()).filter(Boolean))],
    ...semantics.safeMode ? {
      safeMode: {
        id: semantics.safeMode.id.trim(),
        requiredEquals: { ...semantics.safeMode.requiredEquals },
        ...semantics.safeMode.nullEquivalentToRequired ? {
          nullEquivalentToRequired: [...new Set(
            semantics.safeMode.nullEquivalentToRequired.map((field) => field.trim()).filter(Boolean)
          )]
        } : {},
        ...semantics.safeMode.absentOrNull ? { absentOrNull: [...semantics.safeMode.absentOrNull] } : {}
      }
    } : {}
  };
}
function structurallyCarriesSafeMode(schema, semantics) {
  if (semantics.reversibility !== "create_only") return semantics.safeMode === void 0;
  const safeMode = semantics.safeMode;
  if (!safeMode || !safeToken(safeMode.id)) return false;
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (!properties) return false;
  for (const [field, expected] of Object.entries(safeMode.requiredEquals)) {
    if (!Object.hasOwn(properties, field) || !schemaAllowsExact(properties[field], expected)) return false;
  }
  const nullEquivalent = new Set(safeMode.nullEquivalentToRequired ?? []);
  if (nullEquivalent.size !== (safeMode.nullEquivalentToRequired?.length ?? 0)) return false;
  for (const field of nullEquivalent) {
    if (!Object.hasOwn(safeMode.requiredEquals, field) || !Object.hasOwn(properties, field) || !schemaAllowsExact(properties[field], null)) return false;
  }
  for (const field of safeMode.absentOrNull ?? []) {
    if (!Object.hasOwn(properties, field)) return false;
  }
  return true;
}
function deriveReviewedLocalDefinition(input) {
  const name = input.declaration.name.trim();
  const semantics = input.declaration.localPlanning;
  if (!name || input.declaration.sideEffect !== "write" || input.declaration.runtimeEffect === "host_only" || !semantics || semantics.destructive || semantics.reversibility !== "reversible" && semantics.reversibility !== "create_only") return null;
  const normalized = normalizedSemantics(semantics);
  if (!structurallyCarriesSafeMode(input.schema, normalized)) return null;
  const variant = safeToken(normalized.safeMode?.id ?? "reversible");
  const nameToken = safeToken(name);
  if (!variant || !nameToken) return null;
  const capabilityRef = `cap:local:${nameToken}:${variant}`;
  const schemaFingerprint = stableJsonDigest(input.schema);
  const registrySemanticsFingerprint = stableJsonDigest({
    version: 1,
    name,
    sideEffect: input.declaration.sideEffect,
    actionTopologyRole: input.declaration.actionTopologyRole ?? "business",
    semantics: normalized,
    localExecution: input.declaration.localExecution ?? null
  });
  const envelopeFingerprint = stableJsonDigest({
    version: 1,
    provenance: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
    name,
    carrier: "work_call",
    schemaFingerprint,
    registrySemanticsFingerprint
  });
  const descriptor = Object.freeze({
    id: capabilityRef,
    effect: "local_write",
    purpose: normalized.purpose,
    acceptedInputKinds: ["evidence", normalized.inputKind],
    producedOutputKinds: ["evidence", normalized.outputKind],
    applicableDeliverableKinds: ["evidence", normalized.deliverableKind],
    inputShape: normalized.inputKind,
    outputShape: normalized.outputKind,
    outputKind: normalized.outputKind,
    deliverableKind: normalized.deliverableKind,
    destinationPosture: normalized.destinationPosture,
    evidenceKinds: ["local_commit_receipt"],
    handleRequired: normalized.destinationPosture !== null,
    readbackRequired: false,
    accountScope: REVIEWED_LOCAL_ACCOUNT,
    manifestDigest: stableJsonDigest({
      version: 1,
      provenance: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
      capabilityRef,
      envelopeFingerprint
    }),
    advisoryRoles: [...normalized.advisoryRoles]
  });
  return Object.freeze({
    version: 1,
    provenance: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
    name,
    carrier: "work_call",
    capabilityRef,
    schemaFingerprint,
    registrySemanticsFingerprint,
    envelopeFingerprint,
    consequence: normalized.consequence,
    reversibility: normalized.reversibility,
    destructive: false,
    accountIdentity: REVIEWED_LOCAL_ACCOUNT,
    safeMode: normalized.safeMode ? Object.freeze({ ...normalized.safeMode }) : null,
    descriptor
  });
}
function currentReviewedLocalSchema(execution) {
  const parametersShape = execution.adapter === "artifact_bundle_v1" ? ARTIFACT_BUNDLE_TOOL_PARAMETERS : WORKSPACE_SET_DATA_TOOL_PARAMETERS;
  const deferredParameters = import_zod4.z.strictObject(normalizeShapeForDeferredJson(parametersShape));
  const parameters = import_zod4.z.toJSONSchema(deferredParameters);
  const schema = relaxJsonSchemaForDeferred(parameters);
  return isRecord(schema) ? schema : null;
}
function observeReviewedLocalTool(operationId) {
  const name = operationId.trim();
  if (!name || name !== operationId) return null;
  const declaration = exactDeclaration(name);
  if (!declaration || !validExecutionContract(declaration.localExecution)) return null;
  const schema = currentReviewedLocalSchema(declaration.localExecution);
  if (!schema) return null;
  const definition = deriveReviewedLocalDefinition({ declaration, schema });
  if (!definition || definition.accountIdentity !== REVIEWED_LOCAL_ACCOUNT) return null;
  const manifestId = `${definition.capabilityRef}:exec:${definition.envelopeFingerprint}`;
  return Object.freeze({
    definition,
    execution: Object.freeze({ ...declaration.localExecution }),
    schema,
    manifestId,
    invokePortId: `port:${manifestId}:${name}`,
    reconcilePortId: `reconcile:port:${manifestId}:${name}`
  });
}
function observeReviewedLocalTransport(operationId, accountId) {
  if (accountId !== REVIEWED_LOCAL_ACCOUNT) return null;
  const observed2 = observeReviewedLocalTool(operationId);
  if (!observed2) return null;
  return {
    operationId,
    accountId,
    definitionFingerprint: observed2.definition.envelopeFingerprint,
    providerVersion: REVIEWED_LOCAL_PROVIDER_VERSION,
    operationVersion: REVIEWED_LOCAL_OPERATION_VERSION,
    observedAt: Date.now()
  };
}
function reviewedLocalCapabilityManifest(observed2) {
  const descriptor = observed2.definition.descriptor;
  return currentCapabilityManifest({
    version: 1,
    manifestId: observed2.manifestId,
    providerKind: "local_registry",
    operationId: observed2.definition.name,
    providerIdentity: REVIEWED_LOCAL_PROVIDER_IDENTITY,
    providerVersion: REVIEWED_LOCAL_PROVIDER_VERSION,
    operationVersion: REVIEWED_LOCAL_OPERATION_VERSION,
    definitionFingerprint: observed2.definition.envelopeFingerprint,
    effect: "local_write",
    ...descriptor.destinationPosture ? {
      destination: {
        family: observed2.definition.consequence,
        posture: descriptor.destinationPosture
      }
    } : {},
    accountId: REVIEWED_LOCAL_ACCOUNT,
    idempotency: { required: true, policy: "key_before_dispatch" },
    reconciliation: { supported: true, policy: "exact_artifact" },
    outputContract: { kind: descriptor.outputKind ?? observed2.definition.consequence },
    purpose: descriptor.purpose,
    acceptedInputKinds: [...descriptor.acceptedInputKinds],
    producedOutputKinds: [...descriptor.producedOutputKinds],
    applicableDeliverableKinds: [...descriptor.applicableDeliverableKinds],
    evidenceContract: { kinds: ["local_commit_receipt"], readbackRequired: false },
    provenance: {
      issuer: "host:reviewed-local-registry",
      issuedAt: "1970-01-01T00:00:00.000Z",
      trusted: true
    },
    lifecycle: { state: "current" },
    advisoryRoles: [...descriptor.advisoryRoles ?? []],
    argumentCompiler: { ...REVIEWED_LOCAL_ARGUMENT_COMPILER },
    invokePortId: observed2.invokePortId,
    reconcilePortId: observed2.reconcilePortId
  });
}
function reviewedLocalToolArgumentsMatch(observed2, args) {
  if (observed2.execution.adapter === "artifact_bundle_v1") {
    const parsed = import_zod4.z.strictObject(ARTIFACT_BUNDLE_TOOL_PARAMETERS).safeParse(args);
    if (!parsed.success) return false;
  } else if (observed2.execution.adapter === "workspace_dataset_v1") {
    try {
      prepareWorkspaceSetData(args);
    } catch {
      return false;
    }
  } else {
    return false;
  }
  const safeMode = observed2.definition.safeMode;
  if (!safeMode) return true;
  const nullEquivalent = new Set(safeMode.nullEquivalentToRequired ?? []);
  for (const [field, expected] of Object.entries(safeMode.requiredEquals)) {
    if (args[field] !== expected && !(args[field] === null && nullEquivalent.has(field))) return false;
  }
  for (const field of safeMode.absentOrNull ?? []) {
    if (args[field] !== void 0 && args[field] !== null) return false;
  }
  return true;
}
function reviewedLocalExpectedIdentityMatches(call, observed2) {
  const expected = call.expected;
  const manifest = reviewedLocalCapabilityManifest(observed2);
  return Boolean(
    expected && manifest && call.accountId === REVIEWED_LOCAL_ACCOUNT && expected.manifestDigest === capabilityManifestDigest(manifest) && expected.providerKind === "local_registry" && expected.providerIdentity === REVIEWED_LOCAL_PROVIDER_IDENTITY && expected.providerVersion === REVIEWED_LOCAL_PROVIDER_VERSION && expected.operationVersion === REVIEWED_LOCAL_OPERATION_VERSION && expected.definitionFingerprint === observed2.definition.envelopeFingerprint && expected.manifestId === observed2.manifestId && expected.invokePortId === observed2.invokePortId && expected.argumentCompiler.id === REVIEWED_LOCAL_ARGUMENT_COMPILER.id && expected.argumentCompiler.version === REVIEWED_LOCAL_ARGUMENT_COMPILER.version && expected.providerInputSchemaDigest === void 0 && expected.providerOutputSchemaObserved === void 0 && expected.providerOutputSchemaDigest === void 0
  );
}
function prepareReviewedLocalToolExecution(call) {
  const observed2 = observeReviewedLocalTool(call.operationId);
  if (!observed2 || !reviewedLocalExpectedIdentityMatches(call, observed2)) {
    throw new Error("reviewed local execution identity changed before dispatch");
  }
  if (!reviewedLocalToolArgumentsMatch(observed2, call.args)) {
    throw new Error("reviewed local execution arguments exceed the declared safe mode");
  }
  if (observed2.execution.adapter === "artifact_bundle_v1") {
    return {
      observed: observed2,
      adapter: observed2.execution.adapter,
      args: import_zod4.z.strictObject(ARTIFACT_BUNDLE_TOOL_PARAMETERS).parse(call.args)
    };
  }
  return {
    observed: observed2,
    adapter: observed2.execution.adapter,
    args: prepareWorkspaceSetData(call.args).args
  };
}
async function executeReviewedLocalTool(call) {
  const prepared = prepareReviewedLocalToolExecution(call);
  if (prepared.adapter === "artifact_bundle_v1") {
    return executeArtifactBundleSave(prepared.args);
  }
  throw new Error("reviewed Workspace dataset execution requires the host storage carrier");
}
async function reconcileReviewedLocalTool(input) {
  const observed2 = observeReviewedLocalTool(input.operationId);
  if (!observed2 || input.accountId !== REVIEWED_LOCAL_ACCOUNT || observed2.execution.reconciliation !== "artifact_bundle_v1") return { exists: false };
  const inspected = inspectArtifactBundleArtifactId(input.artifactId);
  if (inspected.status !== "present_exact") return { exists: false };
  return {
    exists: true,
    artifactId: inspected.result.artifactId,
    handle: inspected.result.directory,
    contentDigest: inspected.result.revisionDigest,
    receipt: inspected.result.manifestPath
  };
}

// src/runtime/harness/reviewed-cli-read-transport.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto8 = require("node:crypto");

// src/runtime/harness/reviewed-cli-read-config.ts
var import_node_crypto7 = require("node:crypto");
var import_node_fs4 = require("node:fs");
var import_node_path6 = __toESM(require("node:path"), 1);

// src/runtime/atomic-json.ts
var import_node_async_hooks2 = require("node:async_hooks");
var heldFileLocks = new import_node_async_hooks2.AsyncLocalStorage();
var UUID_TOKEN_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
var OWNER_TOKEN_PATTERN = new RegExp(`^([1-9]\\d*):([1-9]\\d*)(?::(${UUID_TOKEN_PATTERN}))?$`, "i");

// src/runtime/harness/authority-argument-seal.ts
var import_node_crypto6 = require("node:crypto");
var import_node_fs3 = require("node:fs");
var import_node_path5 = __toESM(require("node:path"), 1);
var SEAL_VERSION = 2;
var AUTHORITY_ARGUMENT_MAX_PLAINTEXT_BYTES = 32e3;
var AUTHORITY_ARGUMENT_MAX_CIPHER_BYTES = 48e3;
var AUTHORITY_SEAL_KEY_ID_V2 = "authority_seal_v2";
var AUTHORITY_SEAL_KEY_ID_V1 = "authority_seal_v1";
var VAULT_FILE = import_node_path5.default.join(BASE_DIR, "state", "secrets-vault.json");
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
  if (!(0, import_node_fs3.existsSync)(VAULT_FILE)) return void 0;
  try {
    const parsed = JSON.parse((0, import_node_fs3.readFileSync)(VAULT_FILE, "utf8"));
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
        const decipher = (0, import_node_crypto6.createDecipheriv)("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
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
function exactKeys3(value, expected) {
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
  if (!plainRecord(value) || Object.getOwnPropertySymbols(value).length > 0 || !exactKeys3(value, ["name", "kind", "token", "valueType", "required"]) || Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => entry.get || entry.set)) return null;
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
  if (!plainRecord(value) || Object.getOwnPropertySymbols(value).length > 0 || !exactKeys3(value, ["timeoutMs", "maxStdoutBytes", "maxStderrBytes", "maxArgumentBytes"])) return null;
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
  if (!plainRecord(value) || Object.getOwnPropertySymbols(value).length > 0 || !exactKeys3(value, [
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
  if (value.version !== REVIEWED_CLI_READ_CONFIG_VERSION || !boundedText(value.descriptorId) || !boundedText(value.operationId) || !boundedText(value.displayName) || typeof value.description !== "string" || value.description !== value.description.trim() || Buffer.byteLength(value.description, "utf8") > MAX_DESCRIPTION_BYTES || value.effect !== "read" || value.accountId !== REVIEWED_CLI_READ_ACCOUNT || !boundedText(value.executableRealpath, MAX_TOKEN_BYTES) || !import_node_path6.default.isAbsolute(value.executableRealpath) || import_node_path6.default.resolve(value.executableRealpath) !== value.executableRealpath || typeof value.binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.binarySha256) || !prefix || prefix.some((token) => !boundedText(token, MAX_TOKEN_BYTES)) || !argumentRows || !limits) return null;
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
  if (!plainRecord(value) || !exactKeys3(value, ["version", "descriptor", "authoritySeal"]) || value.version !== REVIEWED_CLI_READ_CONFIG_VERSION || typeof value.authoritySeal !== "string" || Buffer.byteLength(value.authoritySeal, "utf8") > 48e3) return null;
  const descriptor = closeReviewedCliReadDescriptor(value.descriptor);
  if (!descriptor) return null;
  let opened;
  try {
    opened = openCanonicalArguments(value.authoritySeal);
  } catch {
    return null;
  }
  if (!opened || !exactKeys3(opened, ["domain", "descriptorDigest"]) || opened.domain !== "reviewed-cli-read-descriptor:v1" || opened.descriptorDigest !== reviewedCliDescriptorDigest(descriptor)) return null;
  return Object.freeze({
    version: REVIEWED_CLI_READ_CONFIG_VERSION,
    descriptor,
    authoritySeal: value.authoritySeal
  });
}
function closeConfigFile(value) {
  if (!plainRecord(value) || !exactKeys3(value, ["version", "descriptors"])) return null;
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
  return import_node_path6.default.join(BASE_DIR, "state", "reviewed-cli-read-descriptors.json");
}
function listReviewedCliReadDescriptors(filePath = reviewedCliReadConfigPath()) {
  let raw;
  try {
    raw = (0, import_node_fs4.readFileSync)(filePath, "utf8");
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
  const hash = (0, import_node_crypto7.createHash)("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let position = 0;
  for (; ; ) {
    const count = (0, import_node_fs4.readSync)(fd, buffer, 0, buffer.length, position);
    if (count === 0) break;
    hash.update(buffer.subarray(0, count));
    position += count;
  }
  return hash.digest("hex");
}
function observeReviewedCliExecutable(executablePath) {
  if (!import_node_path6.default.isAbsolute(executablePath) || executablePath.includes("\0")) return null;
  let real;
  try {
    real = (0, import_node_fs4.realpathSync)(executablePath);
  } catch {
    return null;
  }
  let fd = -1;
  try {
    fd = (0, import_node_fs4.openSync)(real, "r");
    const before = (0, import_node_fs4.fstatSync)(fd, { bigint: true });
    if (!before.isFile() || (before.mode & 0o111n) === 0n) return null;
    const binarySha256 = hashOpenFile(fd);
    const after = (0, import_node_fs4.fstatSync)(fd, { bigint: true });
    const pathAfter = (0, import_node_fs4.realpathSync)(real);
    const pathStats = (0, import_node_fs4.statSync)(real, { bigint: true });
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
    if (fd >= 0) (0, import_node_fs4.closeSync)(fd);
  }
}
function reviewedCliDescriptorDigest(descriptor) {
  const closed = closeReviewedCliReadDescriptor(descriptor);
  if (!closed) throw new Error("reviewed CLI descriptor is invalid");
  return (0, import_node_crypto7.createHash)("sha256").update(closedCanonicalJson(closed, CLOSED_OPTIONS), "utf8").digest("hex");
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
  const definitionFingerprint = (0, import_node_crypto8.createHash)("sha256").update(closedCanonicalJson({
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

// src/runtime/harness/implementation-artifacts/transport-entry.ts
function here() {
  return typeof import_meta_url === "string" ? (0, import_node_url2.fileURLToPath)(import_meta_url) : (0, import_node_url2.fileURLToPath)(import_meta_url);
}
function findPackageRoot(startFile) {
  let dir = import_node_path7.default.dirname(startFile);
  for (let i = 0; i < 12; i += 1) {
    const candidate = import_node_path7.default.join(dir, "package.json");
    if ((0, import_node_fs5.existsSync)(candidate)) {
      try {
        const pkg = JSON.parse((0, import_node_fs5.readFileSync)(candidate, "utf8"));
        if (pkg.name === "clemmy") return dir;
      } catch {
      }
    }
    const parent = import_node_path7.default.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("attested transport could not resolve the clemmy package root");
}
function loadComposioClient() {
  const root = findPackageRoot(here());
  const req = (0, import_node_module.createRequire)(import_node_path7.default.join(root, "package.json"));
  const distClient = import_node_path7.default.join(root, "dist", "integrations", "composio", "client.js");
  if ((0, import_node_fs5.existsSync)(distClient)) {
    return req(distClient);
  }
  throw new Error("attested transport could not resolve the packaged provider client");
}
function loadNativeMcpCarrier() {
  const root = findPackageRoot(here());
  const req = (0, import_node_module.createRequire)(import_node_path7.default.join(root, "package.json"));
  const distCarrier = import_node_path7.default.join(root, "dist", "runtime", "harness", "production-mcp-read-carrier.js");
  if ((0, import_node_fs5.existsSync)(distCarrier)) {
    return req(distCarrier);
  }
  throw new Error("attested transport could not resolve the packaged native MCP carrier");
}
function loopbackOutboundDenied() {
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    const value = process.env[key] ?? "";
    if (/^https?:\/\/127\.0\.0\.1:9(?:\/|$)/.test(value)) return true;
  }
  return false;
}
async function executeAttestedTransport(call) {
  if (call.expected?.providerKind === "reviewed_cli") {
    return executeReviewedCliRead(call);
  }
  if (call.expected?.providerKind === "local_registry") {
    return executeReviewedLocalTool(call);
  }
  if (loopbackOutboundDenied()) {
    throw new Error(`${call.operationId} transport unavailable`);
  }
  if (call.accountId.startsWith("host:")) {
    throw new Error("consequential call requires a sealed provider account");
  }
  if (call.expected?.providerKind === "native_mcp") {
    return loadNativeMcpCarrier().executeProductionMcpRead(call);
  }
  const client = loadComposioClient();
  if (!client.isComposioEnabled()) {
    throw new Error(`${call.operationId} transport unavailable`);
  }
  const providerOperationVersion = call.expected?.operationVersion;
  if (!providerOperationVersion) {
    throw new Error(`${call.operationId} transport lacks an exact provider operation version`);
  }
  const prepared = client.prepareComposioOneShotDispatch({
    toolSlug: call.operationId,
    args: call.args,
    connectedAccountId: call.accountId,
    providerOperationVersion
  });
  return client.executePreparedComposioTool(prepared);
}
async function prepareAttestedComposioDispatch(input) {
  if (loopbackOutboundDenied()) {
    throw new Error(`${input.operationId} exact connected-account refresh was unavailable`);
  }
  const client = loadComposioClient();
  if (!client.isComposioEnabled()) {
    throw new Error(`${input.operationId} exact connected-account refresh was unavailable`);
  }
  let connection;
  try {
    connection = await client.revalidateSelectedComposioConnections([{
      identifier: input.operationId,
      connectionId: input.accountId
    }]);
  } catch (cause) {
    throw new Error(
      `${input.operationId} exact connected-account refresh was unavailable`,
      { cause }
    );
  }
  if (!connection.ok) {
    throw new Error(
      `${input.operationId} sealed connected account ${input.accountId} is ${connection.reason}`
    );
  }
}
var observed = /* @__PURE__ */ new Map();
function observationKey(operationId, accountId) {
  return `${operationId}\0${accountId}`;
}
function resolveConnectedAccount(client, input) {
  const toolkit = input.operationId.split("_")[0]?.toLowerCase() ?? "";
  if (!toolkit) return null;
  const matched = client.peekConnectedToolkits().filter((row) => {
    const slug = String(row.slug ?? "").toLowerCase();
    return slug.includes(toolkit);
  });
  if (matched.length !== 1) return null;
  const accountId = String(
    matched[0].connectionId ?? matched[0].accountEmail ?? ""
  ).trim();
  if (!accountId || accountId !== input.accountId) return null;
  return accountId;
}
function observeAttestedTransport(input) {
  return observed.get(observationKey(input.operationId, input.accountId)) ?? null;
}
function registerIsolatedObservation(observation) {
  observed.set(observationKey(observation.operationId, observation.accountId), observation);
}
async function refreshAttestedTransportObservation(input) {
  observed.delete(observationKey(input.operationId, input.accountId));
  if (input.accountId === "reviewed_cli:host") {
    try {
      const observation = observeReviewedCliReadTransport(
        input.operationId,
        input.accountId
      );
      if (!observation) return null;
      observed.set(observationKey(input.operationId, input.accountId), observation);
      return observation;
    } catch {
      return null;
    }
  }
  if (input.accountId === "local_registry:host") {
    try {
      const observation = observeReviewedLocalTransport(
        input.operationId,
        input.accountId
      );
      if (!observation) return null;
      observed.set(observationKey(input.operationId, input.accountId), observation);
      return observation;
    } catch {
      return null;
    }
  }
  if (loopbackOutboundDenied()) return null;
  try {
    if (input.accountId.startsWith("native_mcp:")) {
      const observation2 = await loadNativeMcpCarrier().refreshProductionMcpReadObservation(input);
      if (!observation2) return null;
      observed.set(observationKey(input.operationId, input.accountId), observation2);
      return observation2;
    }
    const client = loadComposioClient();
    if (!client.isComposioEnabled()) return null;
    const accountId = resolveConnectedAccount(client, input);
    if (!accountId) return null;
    const tool = await client.getExactComposioToolBySlug(input.operationId);
    if (!tool || tool.slug !== input.operationId || tool.inputParameters === void 0) return null;
    const observedAt = client.composioToolSchemaObservedAt(tool);
    const providerOperationVersion = client.composioToolOperationVersion(tool);
    if (typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt <= 0) return null;
    if (!providerOperationVersion) return null;
    if (!Object.prototype.hasOwnProperty.call(tool, "outputParameters") || tool.outputParameters === void 0) return null;
    const outputSchema = tool.outputParameters === null ? null : tool.outputParameters && typeof tool.outputParameters === "object" && !Array.isArray(tool.outputParameters) ? tool.outputParameters : void 0;
    if (outputSchema === void 0) return null;
    const definitionFingerprint = fingerprintComposioProviderDefinition({
      operationId: input.operationId,
      operationVersion: providerOperationVersion,
      accountId,
      invokePortId: `port:cap:resolved:${input.operationId.toLowerCase()}:${input.operationId}`,
      inputSchema: tool.inputParameters,
      outputSchema
    });
    if (!definitionFingerprint) return null;
    const observation = {
      operationId: input.operationId,
      accountId,
      definitionFingerprint,
      providerVersion: COMPOSIO_PROVIDER_SURFACE_VERSION,
      operationVersion: providerOperationVersion,
      observedAt
    };
    observed.set(observationKey(input.operationId, accountId), observation);
    return observation;
  } catch {
    return null;
  }
}
async function reconcileAttestedTransport(input) {
  const id = input.artifactId.trim();
  if (!id) return { exists: false };
  if (input.accountId === "local_registry:host") {
    try {
      return await reconcileReviewedLocalTool({
        operationId: input.operationId,
        accountId: input.accountId,
        artifactId: id
      });
    } catch {
      return { exists: false };
    }
  }
  try {
    const result = await executeAttestedTransport({
      operationId: input.operationId,
      args: { spreadsheet_id: id },
      accountId: input.accountId
    });
    const record3 = result && typeof result === "object" ? result : {};
    const returned = String(record3.spreadsheet_id ?? record3.spreadsheetId ?? record3.id ?? "").trim();
    if (!returned || returned !== id) return { exists: false };
    return {
      exists: true,
      artifactId: id,
      handle: typeof record3.spreadsheet_url === "string" ? record3.spreadsheet_url : void 0,
      receipt: typeof record3.receipt === "string" ? record3.receipt : void 0
    };
  } catch {
    return { exists: false };
  }
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
  createAttestedTransport,
  executeAttestedTransport,
  observeAttestedTransport,
  prepareAttestedComposioDispatch,
  reconcileAttestedTransport,
  refreshAttestedTransportObservation,
  registerIsolatedObservation
});
