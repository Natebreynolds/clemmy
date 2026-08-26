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
  reconcileAttestedTransport: () => reconcileAttestedTransport,
  refreshAttestedTransportObservation: () => refreshAttestedTransportObservation
});
module.exports = __toCommonJS(transport_entry_exports);
var import_node_module = require("node:module");
var import_node_fs2 = require("node:fs");
var import_node_path4 = __toESM(require("node:path"), 1);
var import_node_url2 = require("node:url");

// src/integrations/composio/provider-definition-identity.ts
var import_node_crypto2 = require("node:crypto");

// src/tools/tool-contract-store.ts
var import_node_crypto = require("node:crypto");
var import_node_path3 = __toESM(require("node:path"), 1);

// src/config.ts
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

// src/tools/tool-contract-store.ts
var CONTRACTS_ROOT = import_node_path3.default.join(BASE_DIR, "memory", "tool-contracts");
var CONTRACT_TTL_MS = 30 * 24 * 60 * 6e4;
var MAX_CONTRACT_CACHE_BYTES = 64 * 1024 * 1024;
function digestSchema(schema) {
  return (0, import_node_crypto.createHash)("sha256").update(stableStringify(schema)).digest("hex");
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value).filter(([, v]) => v !== void 0).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
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

// src/runtime/harness/implementation-artifacts/transport-entry.ts
function here() {
  return typeof import_meta_url === "string" ? (0, import_node_url2.fileURLToPath)(import_meta_url) : (0, import_node_url2.fileURLToPath)(import_meta_url);
}
function findPackageRoot(startFile) {
  let dir = import_node_path4.default.dirname(startFile);
  for (let i = 0; i < 12; i += 1) {
    const candidate = import_node_path4.default.join(dir, "package.json");
    if ((0, import_node_fs2.existsSync)(candidate)) {
      try {
        const pkg = JSON.parse((0, import_node_fs2.readFileSync)(candidate, "utf8"));
        if (pkg.name === "clemmy") return dir;
      } catch {
      }
    }
    const parent = import_node_path4.default.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("attested transport could not resolve the clemmy package root");
}
function loadComposioClient() {
  const root = findPackageRoot(here());
  const req = (0, import_node_module.createRequire)(import_node_path4.default.join(root, "package.json"));
  const distClient = import_node_path4.default.join(root, "dist", "integrations", "composio", "client.js");
  if ((0, import_node_fs2.existsSync)(distClient)) {
    return req(distClient);
  }
  throw new Error("attested transport could not resolve the packaged provider client");
}
function loadNativeMcpCarrier() {
  const root = findPackageRoot(here());
  const req = (0, import_node_module.createRequire)(import_node_path4.default.join(root, "package.json"));
  const distCarrier = import_node_path4.default.join(root, "dist", "runtime", "harness", "production-mcp-read-carrier.js");
  if ((0, import_node_fs2.existsSync)(distCarrier)) {
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
async function refreshAttestedTransportObservation(input) {
  observed.delete(observationKey(input.operationId, input.accountId));
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
  try {
    const result = await executeAttestedTransport({
      operationId: input.operationId,
      args: { spreadsheet_id: id },
      accountId: input.accountId
    });
    const record = result && typeof result === "object" ? result : {};
    const returned = String(record.spreadsheet_id ?? record.spreadsheetId ?? record.id ?? "").trim();
    if (!returned || returned !== id) return { exists: false };
    return {
      exists: true,
      artifactId: id,
      handle: typeof record.spreadsheet_url === "string" ? record.spreadsheet_url : void 0,
      receipt: typeof record.receipt === "string" ? record.receipt : void 0
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
  reconcileAttestedTransport,
  refreshAttestedTransportObservation
});
