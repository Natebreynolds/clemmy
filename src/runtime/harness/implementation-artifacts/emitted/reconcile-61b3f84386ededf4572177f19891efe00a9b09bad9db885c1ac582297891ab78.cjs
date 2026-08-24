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
function getRuntimeEnv(key, fallback = "") {
  const activeEnvFiles = envSearchPaths().filter((filePath, index, items) => (0, import_node_fs.existsSync)(filePath) && items.indexOf(filePath) === index);
  const currentEnv = Object.assign({}, ...activeEnvFiles.map((filePath) => parseEnvFile(filePath)));
  return process.env[key] ?? currentEnv[key] ?? fallback;
}
function readSecretFromFileVaultSync(name) {
  const vaultPath = import_node_path.default.join(BASE_DIR, "state", "secrets-vault.json");
  if (!(0, import_node_fs.existsSync)(vaultPath)) return void 0;
  try {
    const parsed = JSON.parse((0, import_node_fs.readFileSync)(vaultPath, "utf-8"));
    if (parsed.version !== "v1" || !parsed.entries) return void 0;
    const value = parsed.entries[name];
    return value && value.length > 0 ? value : void 0;
  } catch {
    return void 0;
  }
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
var import_node_fs, import_node_os, import_node_path, import_node_url, __filename, __dirname, PKG_DIR, REAL_USER_HOME, REAL_DEFAULT_CLEMENTINE_HOME, DEFAULT_BASE_DIR, BASE_DIR, ACTIVE_ENV_FILES, env, agentsTracingDisabled, ASSISTANT_NAME, OWNER_NAME, OPENAI_API_KEY, AUTH_MODE, CODEX_AUTH_SOURCE_FILE, CODEX_EXECUTABLE, CODEX_INSTALL_PACKAGE, CODEX_SANDBOX_MODE, CODEX_USE_FULL_AUTO, VAULT_DIR, WEBHOOK_ENABLED, WEBHOOK_PORT, WEBHOOK_HOST, WEBHOOK_ALLOW_LAN, MOBILE_APP_PORT, MOBILE_APP_LISTENER_ENABLED, WEBHOOK_SECRET, WEBHOOK_SECRET_IS_STRONG, DISCORD_ENABLED_RAW, DISCORD_HARNESS_ENABLED, DISCORD_BOT_TOKEN, DISCORD_ENABLED, DISCORD_CLIENT_ID, DISCORD_REQUIRE_MENTION, DISCORD_DM_ALLOWED_USERS, DISCORD_ALLOWED_USERS, DISCORD_DM_POLL_INTERVAL_MS, DISCORD_ALLOWED_CHANNELS, DISCORD_PUSH_PROACTIVE_BRIEFS, SLACK_ENABLED_RAW, SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ENABLED, SLACK_REQUIRE_MENTION, SLACK_ALLOWED_USERS, SLACK_ALLOWED_CHANNELS, SLACK_PROACTIVE_CHANNEL, LOCAL_MCP_ENABLED, MCP_AUTO_IMPORT_ENABLED, MCP_SERVERS_FILE, COMPOSIO_API_KEY, COMPOSIO_USER_ID;
var init_config = __esm({
  "src/config.ts"() {
    "use strict";
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
var import_node_path2, MACHINE_ID_FILE;
var init_machine_id = __esm({
  "src/runtime/machine-id.ts"() {
    "use strict";
    import_node_path2 = __toESM(require("node:path"), 1);
    init_config();
    MACHINE_ID_FILE = import_node_path2.default.join(BASE_DIR, "state", "machine-id");
  }
});

// src/tools/tool-contract-store.ts
var import_node_path3, CONTRACTS_ROOT, CONTRACT_TTL_MS;
var init_tool_contract_store = __esm({
  "src/tools/tool-contract-store.ts"() {
    "use strict";
    import_node_path3 = __toESM(require("node:path"), 1);
    init_config();
    init_machine_id();
    CONTRACTS_ROOT = import_node_path3.default.join(BASE_DIR, "memory", "tool-contracts");
    CONTRACT_TTL_MS = 30 * 24 * 60 * 6e4;
  }
});

// src/tools/composio-schema-cache.ts
var SCHEMA_TTL_MS;
var init_composio_schema_cache = __esm({
  "src/tools/composio-schema-cache.ts"() {
    "use strict";
    init_tool_contract_store();
    SCHEMA_TTL_MS = 30 * 6e4;
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

// src/runtime/harness/capability-manifest.ts
var init_capability_manifest = __esm({
  "src/runtime/harness/capability-manifest.ts"() {
    "use strict";
  }
});

// src/runtime/harness/isolated-test-contract.ts
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

// src/runtime/harness/production-capability-adapters.ts
function looksLikeContentDigest(value) {
  return /^[a-f0-9]{64}$/i.test(value);
}
function reconcileForSealedManifest(manifest) {
  const supported = manifest.reconciliation.supported;
  const policy = manifest.reconciliation.policy;
  const accountId = manifest.accountId;
  const operationId = manifest.operationId === BETA_PROVIDER_OPERATIONS.create ? SHEET_RECONCILE : manifest.operationId;
  return async ({ artifactId }) => {
    if (!supported || policy === "uncertain_if_absent") {
      return { exists: false };
    }
    const id = artifactId?.trim() || "";
    if (!id || looksLikeContentDigest(id)) return { exists: false };
    const attested = (() => {
      try {
        return requireAttestedTransport();
      } catch {
        return null;
      }
    })();
    if (!attested) return { exists: false };
    const result = await attested.reconcile({
      artifactId: id,
      accountId,
      operationId
    });
    if (!result.exists || result.artifactId !== id) return { exists: false };
    return {
      exists: true,
      id: result.artifactId,
      handle: result.handle,
      receipt: result.receipt,
      ...result.contentDigest ? { contentDigest: result.contentDigest } : {}
    };
  };
}
var SHEET_CREATE, SHEET_READBACK, SHEET_RECONCILE, BETA_PROVIDER_OPERATIONS;
var init_production_capability_adapters = __esm({
  "src/runtime/harness/production-capability-adapters.ts"() {
    "use strict";
    init_composio_schema_cache();
    init_tool_contract_store();
    init_capability_live_identity();
    init_capability_manifest();
    init_isolated_test_contract();
    init_attested_transport();
    SHEET_CREATE = "GOOGLESHEETS_SHEET_FROM_JSON";
    SHEET_READBACK = "GOOGLESHEETS_BATCH_GET";
    SHEET_RECONCILE = "GOOGLESHEETS_GET_SPREADSHEET_INFO";
    BETA_PROVIDER_OPERATIONS = {
      locator: "TAVILY_TAVILY_SEARCH",
      collection: "TAVILY_TAVILY_EXTRACT",
      transform: "host_transform",
      create: SHEET_CREATE,
      readback: SHEET_READBACK,
      calendar: "GOOGLECALENDAR_CREATE_EVENT"
    };
  }
});

// src/runtime/harness/implementation-artifacts/reconcile-entry.ts
var reconcile_entry_exports = {};
__export(reconcile_entry_exports, {
  bindAttestedTransport: () => bindAttestedTransport,
  reconcileForSealedManifest: () => reconcileForSealedManifest
});
module.exports = __toCommonJS(reconcile_entry_exports);
init_production_capability_adapters();
init_attested_transport();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  bindAttestedTransport,
  reconcileForSealedManifest
});
