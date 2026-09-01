var import_meta_url = require("node:url").pathToFileURL(__filename).href;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
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
var init_security = __esm({
  "src/runtime/security.ts"() {
    "use strict";
  }
});

// src/config.ts
function realUserHome() {
  try {
    return import_node_os.default.userInfo().homedir;
  } catch {
    return import_node_os.default.homedir();
  }
}
function isTestProcess() {
  return Boolean(
    process.env.NODE_TEST_CONTEXT || process.env.CLEMMY_TEST_ISOLATED_HOME === "1" || process.argv.includes("--test")
  );
}
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
function resolveDiscordEnabled(rawEnabled, hasToken) {
  const raw = rawEnabled.trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return hasToken;
}
var import_node_async_hooks, import_node_fs, import_node_os, import_node_path, import_node_url, __filename, __dirname, PKG_DIR, REAL_USER_HOME, REAL_DEFAULT_CLEMENTINE_HOME, DEFAULT_BASE_DIR, BASE_DIR, ACTIVE_ENV_FILES, env, runtimeEnvReadObserverForTest, runtimeConfigCaptureObserverForTest, runtimeConfigRequestStorage, agentsTracingDisabled, ASSISTANT_NAME, OWNER_NAME, OPENAI_API_KEY, AUTH_MODE, CODEX_AUTH_SOURCE_FILE, CODEX_EXECUTABLE, CODEX_INSTALL_PACKAGE, CODEX_SANDBOX_MODE, CODEX_USE_FULL_AUTO, VAULT_DIR, WEBHOOK_ENABLED, WEBHOOK_PORT, WEBHOOK_HOST, WEBHOOK_ALLOW_LAN, MOBILE_APP_PORT, MOBILE_APP_LISTENER_ENABLED, WEBHOOK_SECRET, WEBHOOK_SECRET_IS_STRONG, DISCORD_ENABLED_RAW, DISCORD_HARNESS_ENABLED, DISCORD_BOT_TOKEN, DISCORD_ENABLED, DISCORD_CLIENT_ID, DISCORD_REQUIRE_MENTION, DISCORD_DM_ALLOWED_USERS, DISCORD_ALLOWED_USERS, DISCORD_DM_POLL_INTERVAL_MS, DISCORD_ALLOWED_CHANNELS, DISCORD_PUSH_PROACTIVE_BRIEFS, SLACK_ENABLED_RAW, SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ENABLED, SLACK_REQUIRE_MENTION, SLACK_ALLOWED_USERS, SLACK_ALLOWED_CHANNELS, SLACK_PROACTIVE_CHANNEL, LOCAL_MCP_ENABLED, MCP_AUTO_IMPORT_ENABLED, MCP_SERVERS_FILE, COMPOSIO_API_KEY, COMPOSIO_USER_ID;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
    import_node_async_hooks = require("node:async_hooks");
    import_node_fs = require("node:fs");
    import_node_os = __toESM(require("node:os"), 1);
    import_node_path = __toESM(require("node:path"), 1);
    import_node_url = require("node:url");
    init_security();
    __filename = (0, import_node_url.fileURLToPath)(import_meta_url);
    __dirname = import_node_path.default.dirname(__filename);
    PKG_DIR = import_node_path.default.resolve(__dirname, "..");
    REAL_USER_HOME = process.env.CLEMMY_REAL_USER_HOME || realUserHome();
    REAL_DEFAULT_CLEMENTINE_HOME = import_node_path.default.resolve(import_node_path.default.join(REAL_USER_HOME, ".clementine-next"));
    DEFAULT_BASE_DIR = process.env.CLEMENTINE_HOME || REAL_DEFAULT_CLEMENTINE_HOME;
    if (isTestProcess() && import_node_path.default.resolve(DEFAULT_BASE_DIR) === REAL_DEFAULT_CLEMENTINE_HOME && process.env.CLEMMY_ALLOW_LIVE_HOME_TESTS !== "1") {
      throw new Error(
        "Refusing to bind BASE_DIR to the live Clementine home from a test process. Set CLEMENTINE_HOME to a unique temp directory before importing config, or set CLEMMY_ALLOW_LIVE_HOME_TESTS=1 for an explicit destructive test."
      );
    }
    BASE_DIR = DEFAULT_BASE_DIR;
    ACTIVE_ENV_FILES = envSearchPaths().filter((filePath, index, items) => (0, import_node_fs.existsSync)(filePath) && items.indexOf(filePath) === index);
    env = Object.assign({}, ...ACTIVE_ENV_FILES.map((filePath) => parseEnvFile(filePath)));
    runtimeConfigRequestStorage = new import_node_async_hooks.AsyncLocalStorage();
    agentsTracingDisabled = resolveOpenAiAgentsTracingDisabled(
      getEnv("OPENAI_AGENTS_DISABLE_TRACING", ""),
      getOpenAiApiKey()
    );
    if (agentsTracingDisabled) process.env.OPENAI_AGENTS_DISABLE_TRACING = agentsTracingDisabled;
    ASSISTANT_NAME = getEnv("ASSISTANT_NAME", "Clementine");
    OWNER_NAME = getEnv("OWNER_NAME", "");
    OPENAI_API_KEY = getEnv("OPENAI_API_KEY", "");
    AUTH_MODE = (() => {
      const raw = getEnv("AUTH_MODE", "api_key");
      if (raw === "codex_oauth") return "codex_oauth";
      if (raw === "claude_oauth") return "claude_oauth";
      return "api_key";
    })();
    CODEX_AUTH_SOURCE_FILE = getEnv("CODEX_AUTH_SOURCE_FILE", import_node_path.default.join(import_node_os.default.homedir(), ".codex", "auth.json"));
    CODEX_EXECUTABLE = getEnv("CODEX_EXECUTABLE", "codex");
    CODEX_INSTALL_PACKAGE = getEnv("CODEX_INSTALL_PACKAGE", "@openai/codex");
    CODEX_SANDBOX_MODE = getEnv("CODEX_SANDBOX_MODE", "workspace-write");
    CODEX_USE_FULL_AUTO = getEnv("CODEX_USE_FULL_AUTO", "true").toLowerCase() === "true";
    VAULT_DIR = import_node_path.default.join(BASE_DIR, "vault");
    WEBHOOK_ENABLED = getEnv("WEBHOOK_ENABLED", "false").toLowerCase() === "true";
    WEBHOOK_PORT = parseInt(getEnv("WEBHOOK_PORT", "8420"), 10);
    WEBHOOK_HOST = normalizeWebhookHost(getEnv("WEBHOOK_HOST", "127.0.0.1"));
    WEBHOOK_ALLOW_LAN = getEnv("WEBHOOK_ALLOW_LAN", "false").toLowerCase() === "true";
    MOBILE_APP_PORT = parseInt(getEnv("CLEMENTINE_MOBILE_APP_PORT", "8421"), 10);
    MOBILE_APP_LISTENER_ENABLED = getEnv("CLEMENTINE_MOBILE_APP_LISTENER", "on").toLowerCase() !== "off";
    WEBHOOK_SECRET = readSecretFromFileVaultSync("webhook_secret") || getEnv("WEBHOOK_SECRET", "") || "";
    WEBHOOK_SECRET_IS_STRONG = isStrongLocalSecret(WEBHOOK_SECRET);
    DISCORD_ENABLED_RAW = getEnv("DISCORD_ENABLED", "").toLowerCase();
    DISCORD_HARNESS_ENABLED = !["false", "0", "no", "off"].includes(
      getEnv("DISCORD_HARNESS_ENABLED", "true").toLowerCase()
    );
    DISCORD_BOT_TOKEN = readSecretFromFileVaultSync("discord_bot_token") || getEnv("DISCORD_BOT_TOKEN", "") || "";
    DISCORD_ENABLED = resolveDiscordEnabled(DISCORD_ENABLED_RAW, DISCORD_BOT_TOKEN.length > 0);
    DISCORD_CLIENT_ID = getEnv("DISCORD_CLIENT_ID", "");
    DISCORD_REQUIRE_MENTION = getEnv("DISCORD_REQUIRE_MENTION", "true").toLowerCase() === "true";
    DISCORD_DM_ALLOWED_USERS = parseCsvEnv(getEnv("DISCORD_DM_ALLOWED_USERS", ""));
    DISCORD_ALLOWED_USERS = parseCsvEnv(
      getEnv("DISCORD_ALLOWED_USERS", getEnv("DISCORD_DM_ALLOWED_USERS", ""))
    );
    DISCORD_DM_POLL_INTERVAL_MS = parseInt(getEnv("DISCORD_DM_POLL_INTERVAL_MS", "5000"), 10);
    DISCORD_ALLOWED_CHANNELS = parseCsvEnv(getEnv("DISCORD_ALLOWED_CHANNELS", ""));
    DISCORD_PUSH_PROACTIVE_BRIEFS = getEnv("DISCORD_PUSH_PROACTIVE_BRIEFS", "false").toLowerCase() === "true";
    SLACK_ENABLED_RAW = getEnv("SLACK_ENABLED", "").toLowerCase();
    SLACK_BOT_TOKEN = readSecretFromFileVaultSync("slack_bot_token") || getEnv("SLACK_BOT_TOKEN", "") || "";
    SLACK_APP_TOKEN = readSecretFromFileVaultSync("slack_app_token") || getEnv("SLACK_APP_TOKEN", "") || "";
    SLACK_ENABLED = resolveDiscordEnabled(
      SLACK_ENABLED_RAW,
      SLACK_BOT_TOKEN.length > 0 && SLACK_APP_TOKEN.length > 0
    );
    SLACK_REQUIRE_MENTION = getEnv("SLACK_REQUIRE_MENTION", "true").toLowerCase() === "true";
    SLACK_ALLOWED_USERS = parseCsvEnv(getEnv("SLACK_ALLOWED_USERS", ""));
    SLACK_ALLOWED_CHANNELS = parseCsvEnv(getEnv("SLACK_ALLOWED_CHANNELS", ""));
    SLACK_PROACTIVE_CHANNEL = getEnv("SLACK_PROACTIVE_CHANNEL", "").trim();
    LOCAL_MCP_ENABLED = getEnv("LOCAL_MCP_ENABLED", "true").toLowerCase() === "true";
    MCP_AUTO_IMPORT_ENABLED = getEnv("MCP_AUTO_IMPORT_ENABLED", "false").toLowerCase() === "true";
    MCP_SERVERS_FILE = import_node_path.default.join(BASE_DIR, "mcp", "servers.json");
    COMPOSIO_API_KEY = getEnv("COMPOSIO_API_KEY", "");
    COMPOSIO_USER_ID = getEnv("COMPOSIO_USER_ID", "");
  }
});

// src/runtime/machine-id.ts
function getMachineId() {
  if (cached) return cached;
  cached = readOrCreateMachineId();
  return cached;
}
function readOrCreateMachineId() {
  try {
    if ((0, import_node_fs2.existsSync)(MACHINE_ID_FILE)) {
      const raw = (0, import_node_fs2.readFileSync)(MACHINE_ID_FILE, "utf-8").trim();
      if (raw) return raw;
    }
    const id = (0, import_node_crypto.randomUUID)();
    (0, import_node_fs2.mkdirSync)(import_node_path2.default.dirname(MACHINE_ID_FILE), { recursive: true });
    (0, import_node_fs2.writeFileSync)(MACHINE_ID_FILE, `${id}
`, "utf-8");
    return id;
  } catch {
    return safeHostname();
  }
}
function safeHostname() {
  try {
    const h = import_node_os2.default.hostname();
    return h && h.length > 0 ? h : "unknown-host";
  } catch {
    return "unknown-host";
  }
}
var import_node_fs2, import_node_os2, import_node_path2, import_node_crypto, MACHINE_ID_FILE, cached;
var init_machine_id = __esm({
  "src/runtime/machine-id.ts"() {
    "use strict";
    import_node_fs2 = require("node:fs");
    import_node_os2 = __toESM(require("node:os"), 1);
    import_node_path2 = __toESM(require("node:path"), 1);
    import_node_crypto = require("node:crypto");
    init_config();
    MACHINE_ID_FILE = import_node_path2.default.join(BASE_DIR, "state", "machine-id");
    cached = null;
  }
});

// src/shared/stable-json-digest.ts
function stableJsonStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  const entries = Object.entries(value).filter(([, nested]) => nested !== void 0).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJsonStringify(nested)}`).join(",")}}`;
}
function stableJsonDigest(value) {
  return (0, import_node_crypto2.createHash)("sha256").update(stableJsonStringify(value)).digest("hex");
}
function stableJsonFingerprint(value) {
  return stableJsonDigest(value).slice(0, 32);
}
var import_node_crypto2;
var init_stable_json_digest = __esm({
  "src/shared/stable-json-digest.ts"() {
    "use strict";
    import_node_crypto2 = require("node:crypto");
  }
});

// src/tools/tool-contract-store.ts
function contractFileIdentity(file) {
  try {
    const stat = (0, import_node_fs3.statSync)(file, { bigint: true });
    if (!stat.isFile()) return null;
    const fields = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
    if (fields.some((field) => typeof field !== "bigint")) return { cacheable: false };
    const sizeBytes = stat.size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(stat.size);
    return { cacheable: true, key: fields.map(String).join(":"), sizeBytes };
  } catch {
    try {
      return (0, import_node_fs3.existsSync)(file) ? { cacheable: false } : null;
    } catch {
      return null;
    }
  }
}
function deepFreezeContractValue(value, seen = /* @__PURE__ */ new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  const object = value;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const nested of Object.values(value)) {
    deepFreezeContractValue(nested, seen);
  }
  return Object.freeze(value);
}
function invalidateContractFileCache(file) {
  const cached2 = contractFileCache.get(file);
  if (cached2) contractCacheBytes = Math.max(0, contractCacheBytes - cached2.estimatedBytes);
  contractFileCache.delete(file);
}
function conservativeContractCacheBytes(sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return contractCacheByteBudget + 1;
  return Math.max(512, Math.ceil(sizeBytes * 4));
}
function cacheContractFile(file, identity, sizeBytes, record3) {
  invalidateContractFileCache(file);
  const estimatedBytes = conservativeContractCacheBytes(sizeBytes);
  if (estimatedBytes > contractCacheByteBudget) return;
  contractFileCache.set(file, { identity, record: record3, estimatedBytes });
  contractCacheBytes += estimatedBytes;
  while (contractFileCache.size > MAX_CONTRACTS || contractCacheBytes > contractCacheByteBudget) {
    const oldest = contractFileCache.keys().next().value;
    if (oldest === void 0) break;
    invalidateContractFileCache(oldest);
  }
}
function machineDir() {
  return import_node_path3.default.join(CONTRACTS_ROOT, getMachineId());
}
function contractFileName(identifier) {
  const safe = identifier.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  const digest = (0, import_node_crypto3.createHash)("sha256").update(identifier).digest("hex").slice(0, 12);
  return `${safe}.${digest}.json`;
}
function digestSchema(schema) {
  return stableJsonDigest(schema);
}
function fingerprintSchema(schema) {
  return stableJsonFingerprint(schema);
}
function readContractFile(file, attempt = 0) {
  const before = contractFileIdentity(file);
  if (!before) {
    invalidateContractFileCache(file);
    return null;
  }
  if (before.cacheable && before.key) {
    const cached2 = contractFileCache.get(file);
    if (cached2?.identity === before.key) {
      contractFileCache.delete(file);
      contractFileCache.set(file, cached2);
      contractCacheHits += 1;
      return cached2.record;
    }
    invalidateContractFileCache(file);
  }
  contractCacheMisses += 1;
  let record3 = null;
  try {
    contractCacheParses += 1;
    const parsed = JSON.parse((0, import_node_fs3.readFileSync)(file, "utf-8"));
    record3 = parsed && typeof parsed === "object" && typeof parsed.identifier === "string" && parsed.identifier ? deepFreezeContractValue(parsed) : null;
  } catch {
    record3 = null;
  }
  if (!before.cacheable || !before.key) {
    invalidateContractFileCache(file);
    return record3;
  }
  const after = contractFileIdentity(file);
  if (!after?.cacheable || !after.key || after.key !== before.key) {
    invalidateContractFileCache(file);
    return attempt < 1 ? readContractFile(file, attempt + 1) : null;
  }
  if (after.sizeBytes === void 0) {
    invalidateContractFileCache(file);
    return record3;
  }
  cacheContractFile(file, after.key, after.sizeBytes, record3);
  return record3;
}
function validateToolContractRecord(record3, expectedIdentifier) {
  if (!record3 || record3.identifier !== expectedIdentifier) return null;
  const now = Date.now();
  const cachedValidation = contractValidationCache.get(record3);
  if (cachedValidation) {
    if (cachedValidation.status === "invalid") return null;
    if (cachedValidation.status === "future") {
      if (now < cachedValidation.savedAtMs) return null;
      contractValidationCache.delete(record3);
    } else if (cachedValidation.status === "expired") {
      if (now > cachedValidation.expiresAtMs) return null;
      contractValidationCache.delete(record3);
    } else {
      return now >= cachedValidation.savedAtMs && now <= cachedValidation.expiresAtMs ? record3 : null;
    }
  }
  contractCacheValidations += 1;
  const savedAtMs = Date.parse(record3.savedAt);
  if (!Number.isFinite(savedAtMs)) {
    contractValidationCache.set(record3, { status: "invalid" });
    return null;
  }
  const expiresAtMs = savedAtMs + CONTRACT_TTL_MS;
  if (now < savedAtMs) {
    contractValidationCache.set(record3, { status: "future", savedAtMs });
    return null;
  }
  if (now > expiresAtMs) {
    contractValidationCache.set(record3, { status: "expired", expiresAtMs });
    return null;
  }
  const permanentlyInvalid = () => {
    contractValidationCache.set(record3, { status: "invalid" });
    return null;
  };
  if (!record3.schema || typeof record3.schema !== "object" || Array.isArray(record3.schema)) {
    return permanentlyInvalid();
  }
  if (fingerprintSchema(record3.schema) !== record3.fingerprint) return permanentlyInvalid();
  const outputFields = [
    record3.providerOutputSchema,
    record3.providerOutputSchemaDigest,
    record3.providerOutputSchemaFingerprint
  ];
  const hasAnyOutputField = outputFields.some((value) => value !== void 0);
  const hasAllOutputFields = outputFields.every((value) => value !== void 0);
  if (record3.providerOutputSchemaObserved !== void 0 && record3.providerOutputSchemaObserved !== true) return permanentlyInvalid();
  if (hasAnyOutputField && (!hasAllOutputFields || record3.providerOutputSchemaObserved !== true)) {
    return permanentlyInvalid();
  }
  if (hasAllOutputFields) {
    if (!record3.providerOutputSchema || typeof record3.providerOutputSchema !== "object" || Array.isArray(record3.providerOutputSchema) || digestSchema(record3.providerOutputSchema) !== record3.providerOutputSchemaDigest || fingerprintSchema(record3.providerOutputSchema) !== record3.providerOutputSchemaFingerprint) return permanentlyInvalid();
  }
  contractValidationCache.set(record3, {
    status: "valid",
    savedAtMs,
    expiresAtMs
  });
  return record3;
}
function caseTwinIdentifier(identifier) {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) return null;
  if (!identifier.includes("_") || identifier.includes("__")) return null;
  const upper = identifier.toUpperCase();
  return upper === identifier ? null : upper;
}
function loadToolContract(identifier) {
  if (!identifier) return null;
  try {
    const file = import_node_path3.default.join(machineDir(), contractFileName(identifier));
    const exact = validateToolContractRecord(readContractFile(file), identifier);
    if (exact) return exact;
    const twin = caseTwinIdentifier(identifier);
    if (!twin) return null;
    const twinFile = import_node_path3.default.join(machineDir(), contractFileName(twin));
    return validateToolContractRecord(readContractFile(twinFile), twin);
  } catch {
    return null;
  }
}
var import_node_crypto3, import_node_fs3, import_node_path3, CONTRACTS_ROOT, CONTRACT_TTL_MS, MAX_CONTRACTS, MAX_CONTRACT_CACHE_BYTES, contractFileCache, contractValidationCache, contractCacheHits, contractCacheMisses, contractCacheParses, contractCacheValidations, contractCacheBytes, contractCacheByteBudget;
var init_tool_contract_store = __esm({
  "src/tools/tool-contract-store.ts"() {
    "use strict";
    import_node_crypto3 = require("node:crypto");
    import_node_fs3 = require("node:fs");
    import_node_path3 = __toESM(require("node:path"), 1);
    init_config();
    init_machine_id();
    init_stable_json_digest();
    CONTRACTS_ROOT = import_node_path3.default.join(BASE_DIR, "memory", "tool-contracts");
    CONTRACT_TTL_MS = 30 * 24 * 60 * 6e4;
    MAX_CONTRACTS = 2e3;
    MAX_CONTRACT_CACHE_BYTES = 64 * 1024 * 1024;
    contractFileCache = /* @__PURE__ */ new Map();
    contractValidationCache = /* @__PURE__ */ new WeakMap();
    contractCacheHits = 0;
    contractCacheMisses = 0;
    contractCacheParses = 0;
    contractCacheValidations = 0;
    contractCacheBytes = 0;
    contractCacheByteBudget = MAX_CONTRACT_CACHE_BYTES;
  }
});

// src/tools/composio-schema-cache.ts
function liveComposioSchemaFingerprint(toolSlug) {
  const hit = cache.get(toolSlug);
  if (!hit) return void 0;
  const age = Date.now() - (hit.providerObservedAt ?? Number.NaN);
  if (!Number.isFinite(age) || age < 0 || age > SCHEMA_TTL_MS) return void 0;
  try {
    const currentFingerprint = fingerprintSchema(hit.schema);
    return hit.providerObservedFingerprint === currentFingerprint ? currentFingerprint : void 0;
  } catch {
    return void 0;
  }
}
var SCHEMA_TTL_MS, cache;
var init_composio_schema_cache = __esm({
  "src/tools/composio-schema-cache.ts"() {
    "use strict";
    init_tool_contract_store();
    SCHEMA_TTL_MS = 30 * 6e4;
    cache = /* @__PURE__ */ new Map();
  }
});

// src/runtime/harness/capability-live-identity.ts
var import_node_path4, STORE;
var init_capability_live_identity = __esm({
  "src/runtime/harness/capability-live-identity.ts"() {
    "use strict";
    import_node_path4 = __toESM(require("node:path"), 1);
    init_config();
    STORE = import_node_path4.default.join(BASE_DIR, "state", "capability-live-identity.json");
  }
});

// src/runtime/harness/mutation-verification-contract.ts
function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, required, optional = []) {
  const permitted = /* @__PURE__ */ new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every((key) => permitted.has(key));
}
function boundedIdentity(value) {
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
  if (value.version !== 1 || !boundedIdentity(value.resourceFamily) || !boundedIdentity(value.producedHandleKind) || value.proof !== "resource_identity_v1" && value.proof !== "exact_content_v1" || !record(value.target) || !exactKeys(value.target, ["source", "pointers"]) || value.target.source !== "authoritative_result" && value.target.source !== "provider_arguments" || !onePointer(value.target.pointers) || value.resultEnvelope !== void 0 && value.resultEnvelope !== "successful_data_envelope_v1") return null;
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
  if (value.version !== 1 || !boundedIdentity(value.resourceFamily) || !boundedIdentity(value.acceptedHandleKind) || !onePointer(value.requestTargetPointers) || Boolean(responsePointers) === Boolean(responseTarget) || value.resultEnvelope !== void 0 && value.resultEnvelope !== "successful_data_envelope_v1" || responseTarget && value.resultEnvelope !== "successful_data_envelope_v1") return null;
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
var init_mutation_verification_contract = __esm({
  "src/runtime/harness/mutation-verification-contract.ts"() {
    "use strict";
  }
});

// src/shared/closed-canonical-json.ts
var CLOSED_CANONICAL_JSON_DEFAULTS;
var init_closed_canonical_json = __esm({
  "src/shared/closed-canonical-json.ts"() {
    "use strict";
    CLOSED_CANONICAL_JSON_DEFAULTS = Object.freeze({
      maxDepth: 32,
      maxNodes: 2e4,
      maxStringBytes: 64e3,
      maxTotalBytes: 512e3
    });
  }
});

// src/runtime/harness/provider-read-evidence.ts
var init_provider_read_evidence = __esm({
  "src/runtime/harness/provider-read-evidence.ts"() {
    "use strict";
  }
});

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
var init_atomic_input_content_contract = __esm({
  "src/runtime/harness/atomic-input-content-contract.ts"() {
    "use strict";
    init_closed_canonical_json();
    init_mutation_verification_contract();
    init_provider_read_evidence();
  }
});

// src/runtime/harness/capability-manifest.ts
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
  return (0, import_node_crypto4.createHash)("sha256").update(canonicalManifestBytes(manifest), "utf8").digest("hex");
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
var import_node_crypto4, CAPABILITY_MANIFEST_VERSION, PROVIDER_KINDS, EFFECTS, MAX_MANIFEST_PURPOSE_CHARS, MAX_MANIFEST_KIND_CHARS, MAX_MANIFEST_KIND_COUNT;
var init_capability_manifest = __esm({
  "src/runtime/harness/capability-manifest.ts"() {
    "use strict";
    import_node_crypto4 = require("node:crypto");
    init_mutation_verification_contract();
    init_atomic_input_content_contract();
    CAPABILITY_MANIFEST_VERSION = 1;
    PROVIDER_KINDS = /* @__PURE__ */ new Set([
      "local_registry",
      "composio",
      "native_mcp",
      "reviewed_cli"
    ]);
    EFFECTS = /* @__PURE__ */ new Set([
      "none",
      "read",
      "compute",
      "host_only",
      "unknown",
      "local_write",
      "external_write",
      "admin"
    ]);
    MAX_MANIFEST_PURPOSE_CHARS = 256;
    MAX_MANIFEST_KIND_CHARS = 64;
    MAX_MANIFEST_KIND_COUNT = 8;
  }
});

// src/runtime/harness/isolated-test-contract.ts
function isolatedTestContractActive() {
  return process.env.CLEMMY_TEST_ISOLATED_HOME === "1" || Boolean(process.env.NODE_TEST_CONTEXT) || process.argv.includes("--test");
}
var init_isolated_test_contract = __esm({
  "src/runtime/harness/isolated-test-contract.ts"() {
    "use strict";
  }
});

// src/runtime/harness/implementation-artifacts/attested-transport.ts
function bindAttestedTransport(transport) {
  bound = transport;
}
function requireAttestedTransport() {
  if (!bound) {
    throw new Error("attested provider transport is not bound");
  }
  return bound;
}
var bound;
var init_attested_transport = __esm({
  "src/runtime/harness/implementation-artifacts/attested-transport.ts"() {
    "use strict";
    bound = null;
  }
});

// src/runtime/harness/implementation-artifacts/host-local-write-carrier.ts
function bindHostLocalWriteCarrier(carrier) {
  bound2 = carrier;
}
function peekHostLocalWriteCarrier() {
  return bound2;
}
var bound2;
var init_host_local_write_carrier = __esm({
  "src/runtime/harness/implementation-artifacts/host-local-write-carrier.ts"() {
    "use strict";
    bound2 = null;
  }
});

// src/runtime/harness/production-capability-adapters.ts
function asRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record3 = payload;
    if (Array.isArray(record3.records)) return record3.records;
    if (Array.isArray(record3.content)) return record3.content;
  }
  return [];
}
function firstString(record3, keys) {
  for (const key of keys) {
    const value = record3[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const nested = value.data ?? value.response;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return { ...value, ...nested };
  }
  return value;
}
function canonicalJson(value) {
  if (value === void 0) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record3 = value;
  return `{${Object.keys(record3).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record3[key])}`).join(",")}}`;
}
function looksLikeContentDigest(value) {
  return /^[a-f0-9]{64}$/i.test(value);
}
function gridFromSheetPayload(result) {
  const record3 = asRecord(result);
  if (Array.isArray(record3.valueRanges)) {
    const first = record3.valueRanges.find((entry) => entry && typeof entry === "object");
    if (Array.isArray(first?.values)) return first.values;
  }
  if (Array.isArray(record3.values)) return record3.values;
  if (Array.isArray(record3.content)) return record3.content;
  if (Array.isArray(result)) return result;
  return [];
}
function canonicalizeSheetScalar(value) {
  if (value === null || value === void 0) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return Number(value);
  return String(value);
}
function canonicalizeSheetGrid(records, fields) {
  const header = fields && fields.length > 0 ? [...fields] : [...new Set(records.flatMap((record3) => Object.keys(record3)))];
  const rows = records.map((record3) => header.map((key) => canonicalizeSheetScalar(record3[key])));
  const lastRow = rows.length + 1;
  const lastCol = String.fromCharCode(64 + Math.max(header.length, 1));
  return {
    header,
    rows,
    range: `Sheet1!A1:${lastCol}${lastRow}`
  };
}
function normalizeSheetGrid(result) {
  const grid = gridFromSheetPayload(result);
  if (grid.length === 0) {
    const records = asRecords(result);
    return canonicalizeSheetGrid(records);
  }
  if (grid.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
    return canonicalizeSheetGrid(grid);
  }
  const header = Array.isArray(grid[0]) ? grid[0].map((cell) => String(cell ?? "").trim()) : [];
  const rows = grid.slice(1).flatMap((row) => {
    if (!Array.isArray(row)) return [];
    return [header.map((_, index) => canonicalizeSheetScalar(row[index]))];
  });
  return { header, rows };
}
function normalizeSheetRows(result) {
  const { header, rows } = normalizeSheetGrid(result);
  return rows.map((row) => {
    const next = {};
    header.forEach((key, index) => {
      if (key) next[key] = row[index] ?? "";
    });
    return next;
  });
}
function requiredFieldsFromCachedSchema(operationId) {
  const live = liveComposioSchemaFingerprint(operationId);
  const contract = loadToolContract(operationId);
  const schema = contract?.schema && typeof contract.schema === "object" ? contract.schema : null;
  if (!live && !schema) return [];
  return Array.isArray(schema?.required) ? schema.required.filter((entry) => typeof entry === "string" && entry.trim().length > 0) : [];
}
function sealedAccount(bindingAccount, manifestAccount) {
  const account = (bindingAccount ?? manifestAccount).trim();
  if (!account) throw new Error("capability is missing a sealed account");
  return account;
}
function sheetArtifactFromProvider(result) {
  const record3 = asRecord(result);
  const id = firstString(record3, ["spreadsheet_id", "spreadsheetId", "id"]);
  if (!id) throw new Error("sheet adapter returned no exact created id");
  const handle = firstString(record3, ["spreadsheet_url", "spreadsheetUrl", "url", "handle"]) || `https://docs.google.com/spreadsheets/d/${id}`;
  return { id, handle, receipt: canonicalJson(result), raw: result };
}
function locatorFromEnvelope(envelope) {
  const fields = envelope?.cardinality?.fields ?? [];
  const count = envelope?.cardinality?.count ?? 0;
  const query = [envelope?.goal.objective ?? "", ...fields].filter(Boolean).join(" ").trim();
  if (!query) throw new Error("source envelope is missing an objective or required fields");
  return {
    locator: `locator:${envelope?.identity.sessionId ?? "unscoped"}:${envelope?.identity.sourceUserSeq ?? 0}`,
    query,
    fields,
    count
  };
}
function recordsFromEnvelope(envelope, payload) {
  const fromPayload = asRecords(payload);
  if (fromPayload.length > 0) return fromPayload;
  const merged = [];
  for (const prior of envelope?.predecessors ?? []) merged.push(...asRecords(prior.value));
  return merged;
}
function createArgsFromEnvelope(envelope, payload) {
  const records = recordsFromEnvelope(envelope, payload);
  const title = (envelope?.goal.objective ?? "Workbook").trim().slice(0, 80) || "Workbook";
  const grid = canonicalizeSheetGrid(records, envelope?.cardinality?.fields);
  return {
    title,
    sheet_name: "Sheet1",
    sheet_json: records,
    grid
  };
}
function assertDistinctReadyRecords(records, cardinality) {
  if (!cardinality) {
    if (records.length === 0) throw new Error("collection returned no records");
    return;
  }
  if (records.length !== cardinality.count) {
    throw new Error(`collection cardinality mismatch: expected ${cardinality.count} got ${records.length}`);
  }
  const seen = /* @__PURE__ */ new Set();
  for (const [index, record3] of records.entries()) {
    for (const field of cardinality.fields) {
      const value = record3[field];
      if (value == null || String(value).trim() === "") {
        throw new Error(`collection record ${index} is missing required field ${field}`);
      }
    }
    const key = cardinality.fields.map((field) => String(record3[field] ?? "")).join("\0");
    if (seen.has(key)) throw new Error("collection records are not distinct");
    seen.add(key);
  }
}
async function executeSealed(operationId, args, accountId, expected) {
  const attested = (() => {
    try {
      return requireAttestedTransport();
    } catch {
      return null;
    }
  })();
  if (attested) {
    return attested.execute({ operationId, args, accountId, ...expected ? { expected } : {} });
  }
  if (isolatedTestContractActive() && installedTransport) {
    return installedTransport({ operationId, args, accountId, ...expected ? { expected } : {} });
  }
  throw new Error(`${operationId} transport unavailable`);
}
function attestedExpectationForManifest(manifest) {
  const external = manifest.externalDefinition;
  return {
    manifestId: manifest.manifestId,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    providerIdentity: manifest.providerIdentity,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    definitionFingerprint: manifest.definitionFingerprint,
    ...external ? {
      providerInputSchemaDigest: external.providerInputSchemaDigest,
      ...external.providerOutputSchemaObserved === true ? {
        providerOutputSchemaObserved: true,
        providerOutputSchemaDigest: external.providerOutputSchemaDigest ?? null
      } : {}
    } : {},
    invokePortId: manifest.invokePortId,
    argumentCompiler: { ...manifest.argumentCompiler }
  };
}
function refuseRoleSwitch(role, sealedPurpose) {
  if (role === "readback" && sealedPurpose === "locate_source") {
    throw new Error("source capability refuses readback role before transport");
  }
}
function isLegacySheetArtifactReadback(manifest, role) {
  return role === "readback" && manifest.operationId === BETA_PROVIDER_OPERATIONS.readback && manifest.purpose === "verify_created_resource" && manifest.effect === "read" && manifest.acceptedInputKinds.includes("created_resource");
}
function compileSealedProviderArgs(manifest, envelope, payload) {
  if (manifest.effect === "host_only") {
    return Object.freeze({ compiler: manifest.argumentCompiler.id });
  }
  if (manifest.operationId === BETA_PROVIDER_OPERATIONS.locator) {
    const query = locatorFromEnvelope(envelope);
    return Object.freeze({
      query: query.query,
      fields: [...query.fields],
      count: query.count
    });
  }
  if (manifest.operationId === BETA_PROVIDER_OPERATIONS.collection) {
    const locator = envelope?.predecessors.map((prior) => prior.value).find((value) => value && typeof value === "object" && "locator" in value) ?? payload;
    if (!locator || typeof locator !== "object" || !("locator" in locator)) {
      throw new Error("collection requires a locator predecessor");
    }
    return Object.freeze({
      locator: locator.locator,
      query: locator.query ?? ""
    });
  }
  if (manifest.operationId === BETA_PROVIDER_OPERATIONS.create) {
    const args = createArgsFromEnvelope(envelope, payload);
    return Object.freeze({
      title: args.title,
      sheet_name: args.sheet_name,
      sheet_json: args.sheet_json
    });
  }
  if (isLegacySheetArtifactReadback(manifest, envelope?.node.role)) {
    const predecessor = envelope?.predecessors.find((prior) => prior.value && typeof prior.value === "object" && "id" in prior.value)?.value;
    const id = typeof payload === "string" ? payload : String(payload?.id ?? predecessor?.id ?? "");
    const range = typeof payload?.range === "string" ? String(payload.range) : typeof predecessor?.range === "string" ? String(predecessor.range) : envelope?.cardinality ? canonicalizeSheetGrid([], envelope.cardinality.fields).range : "Sheet1!A1:Z1000";
    return Object.freeze({
      spreadsheet_id: id,
      ranges: [range]
    });
  }
  if (manifest.operationId === BETA_PROVIDER_OPERATIONS.readback && manifest.effect === "read" && payload && typeof payload === "object" && !Array.isArray(payload)) {
    return Object.freeze({ ...payload });
  }
  return Object.freeze({ digest: JSON.stringify(payload ?? null) });
}
function invokeForSealedManifest(manifest) {
  const sealed = Object.freeze({
    manifestId: manifest.manifestId,
    operationId: manifest.operationId,
    providerKind: manifest.providerKind,
    providerIdentity: manifest.providerIdentity,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    definitionFingerprint: manifest.definitionFingerprint,
    purpose: manifest.purpose,
    effect: manifest.effect,
    accountId: manifest.accountId,
    invokePortId: manifest.invokePortId,
    argumentCompiler: manifest.argumentCompiler,
    acceptedInputKinds: Object.freeze([...manifest.acceptedInputKinds]),
    producedOutputKinds: Object.freeze([...manifest.producedOutputKinds])
  });
  const expectedTransport = () => Object.freeze(attestedExpectationForManifest(manifest));
  return async ({ payload, role, envelope, binding, authority }) => {
    refuseRoleSwitch(role, sealed.purpose);
    if (binding.capabilityId && binding.capabilityId !== sealed.manifestId) {
      throw new Error("invoke port is bound to a different capability identity");
    }
    if (authority) {
      if (authority.operationId !== sealed.operationId) {
        throw new Error("invoke authority operation does not match the sealed manifest");
      }
      if (authority.accountId !== sealed.accountId) {
        throw new Error("invoke authority account does not match the sealed manifest");
      }
      if (authority.capabilityRef !== sealed.manifestId) {
        throw new Error("invoke authority capability does not match the sealed manifest");
      }
      if (authority.invokePortId !== sealed.invokePortId) {
        throw new Error("invoke authority port does not match the sealed manifest");
      }
    }
    const accountId = sealedAccount(
      authority?.accountId ?? binding.account ?? envelope?.binding.account,
      sealed.accountId
    );
    if (accountId !== sealed.accountId) {
      throw new Error("invoke account does not match the sealed manifest account");
    }
    if (sealed.operationId === BETA_PROVIDER_OPERATIONS.locator) {
      const compiled = authority?.canonicalArgs ?? compileSealedProviderArgs(
        { ...manifest, operationId: sealed.operationId, effect: sealed.effect, argumentCompiler: sealed.argumentCompiler, invokePortId: sealed.invokePortId, accountId: sealed.accountId },
        envelope,
        payload
      );
      const query = {
        query: String(compiled.query ?? ""),
        fields: Array.isArray(compiled.fields) ? compiled.fields.map((entry) => String(entry)) : [],
        count: typeof compiled.count === "number" ? compiled.count : 0,
        locator: locatorFromEnvelope(envelope).locator
      };
      const result = await executeSealed(sealed.operationId, {
        query: query.query,
        fields: [...query.fields],
        count: query.count
      }, accountId, expectedTransport());
      const record3 = asRecord(result);
      const locator = firstString(record3, ["locator"]) || query.locator;
      return { locator, query: firstString(record3, ["query"]) || query.query, fields: query.fields, count: query.count };
    }
    if (sealed.operationId === BETA_PROVIDER_OPERATIONS.collection) {
      const compiled = authority?.canonicalArgs ?? compileSealedProviderArgs(manifest, envelope, payload);
      const result = await executeSealed(sealed.operationId, {
        locator: compiled.locator,
        query: compiled.query ?? ""
      }, accountId, expectedTransport());
      const records = asRecords(result);
      assertDistinctReadyRecords(records, envelope?.cardinality);
      return { records };
    }
    if (sealed.effect === "host_only" || sealed.operationId === BETA_PROVIDER_OPERATIONS.transform) {
      return asRecords(payload);
    }
    if (sealed.operationId === BETA_PROVIDER_OPERATIONS.create) {
      const args = createArgsFromEnvelope(envelope, payload);
      assertDistinctReadyRecords(args.sheet_json, envelope?.cardinality);
      const required = requiredFieldsFromCachedSchema(sealed.operationId);
      const createArgs = authority?.canonicalArgs ?? {
        title: args.title,
        sheet_name: args.sheet_name,
        sheet_json: args.sheet_json
      };
      for (const field of required) {
        if (!(field in createArgs) || createArgs[field] == null) {
          throw new Error(`create missing required field ${field}`);
        }
      }
      const result = await executeSealed(sealed.operationId, createArgs, accountId, expectedTransport());
      const artifact = sheetArtifactFromProvider(result);
      return {
        ...artifact,
        grid: args.grid,
        range: args.grid.range,
        sheet_name: args.sheet_name,
        providerReceipt: firstString(asRecord(result), ["receipt", "response_id", "requestId"]) || (typeof result?.receipt === "string" ? String(result.receipt) : void 0)
      };
    }
    if (isLegacySheetArtifactReadback(sealed, role)) {
      const predecessor = envelope?.predecessors.find((prior) => prior.value && typeof prior.value === "object" && "id" in prior.value)?.value;
      const id = typeof payload === "string" ? payload : String(payload?.id ?? predecessor?.id ?? "");
      if (!id || looksLikeContentDigest(id)) throw new Error("readback requires an exact artifact id");
      const intendedRange = typeof payload?.range === "string" ? String(payload.range) : typeof predecessor?.range === "string" ? String(predecessor.range) : envelope?.cardinality ? canonicalizeSheetGrid([], envelope.cardinality.fields).range : "Sheet1!A1:Z1000";
      const range = intendedRange;
      try {
        const result = await executeSealed(sealed.operationId, {
          spreadsheet_id: id,
          ranges: [range]
        }, accountId, expectedTransport());
        const record3 = asRecord(result);
        const returnedId = firstString(record3, ["spreadsheet_id", "spreadsheetId", "id"]) || id;
        if (returnedId !== id) throw new Error("readback spreadsheet id does not match the created id");
        return {
          id,
          handle: firstString(record3, ["spreadsheet_url", "spreadsheetUrl", "url"]) || void 0,
          content: normalizeSheetRows(result),
          grid: normalizeSheetGrid(result),
          range,
          receipt: firstString(record3, ["receipt", "response_id", "requestId"]) || void 0,
          dispatchRef: envelope?.identity.acceptedTaskId
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/transport unavailable|account/i.test(message)) {
          throw new Error(`read_transport_failed:${message}`);
        }
        throw error;
      }
    }
    if (sealed.purpose === "invoke_live_read" && sealed.effect === "read") {
      const compiled = authority?.canonicalArgs ?? (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null);
      if (!compiled) throw new Error("live read requires canonical object arguments");
      const result = await executeSealed(sealed.operationId, compiled, accountId, expectedTransport());
      return { result, complete: true };
    }
    if (sealed.providerKind === "native_mcp") {
      const compiled = authority?.canonicalArgs ?? (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null);
      if (!compiled) throw new Error("native MCP invoke requires canonical object arguments");
      return executeSealed(sealed.operationId, compiled, accountId, expectedTransport());
    }
    if (sealed.providerKind === "local_registry" && sealed.effect === "local_write") {
      const compiled = authority?.canonicalArgs ?? (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null);
      if (!compiled) throw new Error("reviewed local invoke requires canonical object arguments");
      const hostStorage = peekHostLocalWriteCarrier()?.select({
        operationId: sealed.operationId,
        accountId
      }) ?? null;
      if (hostStorage) {
        return hostStorage.execute({
          operationId: sealed.operationId,
          args: compiled,
          accountId,
          expected: expectedTransport()
        });
      }
      return executeSealed(sealed.operationId, compiled, accountId, expectedTransport());
    }
    if (sealed.effect === "read" && sealed.providerKind === "composio") {
      const compiled = authority?.canonicalArgs ?? (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null);
      if (!compiled) throw new Error("proof-provisioned read requires canonical object arguments");
      const result = await executeSealed(sealed.operationId, compiled, accountId, expectedTransport());
      return { result, complete: true };
    }
    if (sealed.effect === "external_write" && sealed.providerKind === "composio") {
      const current = currentCapabilityManifest(manifest);
      const digest = current ? capabilityManifestDigest(current) : "";
      if (!current || current.effect !== "external_write" || current.providerKind !== "composio") {
        throw new Error("generic external write requires a current sealed manifest");
      }
      if (!authority) {
        throw new Error("generic external write requires current call authority");
      }
      if (authority.manifestId !== current.manifestId || authority.manifestDigest !== digest || authority.providerKind !== current.providerKind || authority.providerIdentity !== current.providerIdentity || authority.operationVersion !== current.operationVersion || authority.liveProviderVersion !== current.providerVersion || authority.liveFingerprint !== current.definitionFingerprint || authority.resolvedEffect !== current.effect || authority.argumentCompiler.id !== current.argumentCompiler.id || authority.argumentCompiler.version !== current.argumentCompiler.version || authority.invokePortId !== current.invokePortId) {
        throw new Error("generic external write authority does not match the current sealed manifest port");
      }
      if (binding.manifestDigest !== digest || binding.toolName !== current.operationId || binding.schemaVersion !== current.operationVersion || binding.schemaDigest !== current.definitionFingerprint || binding.account !== current.accountId || binding.effect !== current.effect || binding.providerKind !== current.providerKind) {
        throw new Error("generic external write binding does not match the current sealed manifest");
      }
      const compiled = authority.canonicalArgs;
      if (!compiled || typeof compiled !== "object" || Array.isArray(compiled)) {
        throw new Error("generic external write requires canonical object arguments");
      }
      return executeSealed(current.operationId, compiled, current.accountId, expectedTransport());
    }
    throw new Error(`no sealed invoke for exact operation ${sealed.operationId}`);
  };
}
var SHEET_CREATE, SHEET_READBACK, BETA_PROVIDER_OPERATIONS, installedTransport;
var init_production_capability_adapters = __esm({
  "src/runtime/harness/production-capability-adapters.ts"() {
    "use strict";
    init_composio_schema_cache();
    init_tool_contract_store();
    init_capability_live_identity();
    init_capability_manifest();
    init_isolated_test_contract();
    init_attested_transport();
    init_host_local_write_carrier();
    SHEET_CREATE = "GOOGLESHEETS_SHEET_FROM_JSON";
    SHEET_READBACK = "GOOGLESHEETS_BATCH_GET";
    BETA_PROVIDER_OPERATIONS = {
      locator: "TAVILY_TAVILY_SEARCH",
      collection: "TAVILY_TAVILY_EXTRACT",
      transform: "host_transform",
      create: SHEET_CREATE,
      readback: SHEET_READBACK,
      calendar: "GOOGLECALENDAR_CREATE_EVENT"
    };
    installedTransport = null;
  }
});

// src/runtime/harness/implementation-artifacts/invoke-entry.ts
var invoke_entry_exports = {};
__export(invoke_entry_exports, {
  bindAttestedTransport: () => bindAttestedTransport,
  bindHostLocalWriteCarrier: () => bindHostLocalWriteCarrier,
  invokeForSealedManifest: () => invokeForSealedManifest
});
module.exports = __toCommonJS(invoke_entry_exports);
init_production_capability_adapters();
init_attested_transport();
init_host_local_write_carrier();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  bindAttestedTransport,
  bindHostLocalWriteCarrier,
  invokeForSealedManifest
});
