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
var import_node_crypto8 = require("node:crypto");
var import_node_fs9 = require("node:fs");
var import_node_os3 = __toESM(require("node:os"), 1);
var import_node_path9 = __toESM(require("node:path"), 1);

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
var import_node_child_process2 = require("node:child_process");
var import_node_crypto7 = require("node:crypto");

// src/runtime/spawn-env.ts
var import_node_path = __toESM(require("node:path"), 1);
var import_node_os = __toESM(require("node:os"), 1);
var import_node_fs = require("node:fs");

// src/runtime/child-env-layers.ts
function windowsLayer(layer) {
  const entries = /* @__PURE__ */ new Map();
  for (const [key, value] of Object.entries(layer)) {
    if (typeof value !== "string") continue;
    const identity = key.toUpperCase();
    const previous = entries.get(identity);
    if (previous?.key === identity && key !== identity) continue;
    entries.set(identity, { key, value });
  }
  return entries;
}
function childEnvValue(layer, name, platform = process.platform) {
  if (platform === "win32") {
    const identity = name.toUpperCase();
    let value;
    for (const [key, candidate] of Object.entries(layer)) {
      if (key.toUpperCase() !== identity || typeof candidate !== "string") continue;
      if (key === identity) return candidate;
      value = candidate;
    }
    return value;
  }
  return Object.hasOwn(layer, name) && typeof layer[name] === "string" ? layer[name] : void 0;
}
function mergeChildEnvLayers(layers, platform = process.platform) {
  if (platform !== "win32") return Object.fromEntries(layers.flatMap((layer) => Object.entries(layer).filter((entry) => typeof entry[1] === "string")));
  const merged = /* @__PURE__ */ new Map();
  for (const layer of layers) for (const [identity, entry] of windowsLayer(layer)) merged.set(identity, entry);
  return Object.fromEntries([...merged].map(([identity, { key, value }]) => [identity === "PATH" ? "PATH" : key, value]));
}

// src/runtime/spawn-env.ts
function existingDirectory(candidate) {
  try {
    return (0, import_node_fs.statSync)(candidate).isDirectory();
  } catch {
    return false;
  }
}
function versionDirectories(root, suffix = []) {
  let names;
  try {
    names = (0, import_node_fs.readdirSync)(root);
  } catch {
    return [];
  }
  return names.sort((a, b) => b.localeCompare(a, void 0, { numeric: true, sensitivity: "base" })).map((name) => import_node_path.default.join(root, name, ...suffix)).filter(existingDirectory);
}
function nvmDefaultBin(home) {
  const nvm = import_node_path.default.join(home, ".nvm");
  let value;
  try {
    value = (0, import_node_fs.readFileSync)(import_node_path.default.join(nvm, "alias", "default"), "utf8").trim();
  } catch {
    return null;
  }
  for (let hop = 0; hop < 3 && value && !/^v?\d/.test(value); hop += 1) {
    try {
      value = (0, import_node_fs.readFileSync)(import_node_path.default.join(nvm, "alias", value), "utf8").trim();
    } catch {
      return null;
    }
  }
  if (!/^v?\d/.test(value)) return null;
  const want = value.startsWith("v") ? value : `v${value}`;
  const match = versionDirectories(import_node_path.default.join(nvm, "versions", "node")).find((dir) => {
    const name = import_node_path.default.basename(dir);
    return name === want || name.startsWith(`${want}.`);
  });
  return match && existingDirectory(import_node_path.default.join(match, "bin")) ? import_node_path.default.join(match, "bin") : null;
}
function nvmExecutableDirs(home) {
  const all = versionDirectories(import_node_path.default.join(home, ".nvm", "versions", "node"), ["bin"]);
  const preferred = nvmDefaultBin(home);
  return preferred ? [preferred, ...all.filter((dir) => dir !== preferred)] : all;
}
function userManagedExecutableDirs(home) {
  if (!home) return [];
  const candidates = [
    import_node_path.default.join(home, ".volta", "bin"),
    import_node_path.default.join(home, ".asdf", "shims"),
    import_node_path.default.join(home, ".local", "share", "mise", "shims"),
    import_node_path.default.join(home, ".mise", "shims"),
    import_node_path.default.join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
    import_node_path.default.join(home, ".fnm", "aliases", "default", "bin"),
    ...nvmExecutableDirs(home),
    ...versionDirectories(import_node_path.default.join(home, ".local", "share", "fnm", "node-versions"), ["installation", "bin"]),
    ...versionDirectories(import_node_path.default.join(home, ".fnm", "node-versions"), ["installation", "bin"])
  ];
  const npmPrefix = process.env.NPM_CONFIG_PREFIX ?? process.env.npm_config_prefix;
  if (npmPrefix?.trim()) candidates.push(import_node_path.default.join(npmPrefix.trim(), "bin"));
  return [...new Set(candidates.filter(existingDirectory))];
}
function isolatedNpmCache(env2, platform) {
  if (childEnvValue(env2, "NPM_CONFIG_CACHE", platform) !== void 0 || childEnvValue(env2, "npm_config_cache", platform) !== void 0) return void 0;
  let base;
  try {
    base = process.env.CLEMENTINE_HOME?.trim() || import_node_path.default.join(import_node_os.default.homedir(), ".clementine-next");
  } catch {
    return void 0;
  }
  const cache = import_node_path.default.join(base, "cache", "npm");
  try {
    (0, import_node_fs.mkdirSync)(cache, { recursive: true, mode: 448 });
    if (!(0, import_node_fs.statSync)(cache).isDirectory()) return void 0;
    (0, import_node_fs.accessSync)(cache, import_node_fs.constants.W_OK | import_node_fs.constants.X_OK);
    return cache;
  } catch {
    return void 0;
  }
}
function augmentPath(existing) {
  const candidates = [];
  try {
    const dir = import_node_path.default.dirname(process.execPath);
    if (dir) candidates.push(dir);
  } catch {
  }
  try {
    const home = import_node_os.default.homedir();
    if (home) {
      if (process.platform === "win32") {
        candidates.push(import_node_path.default.join(home, "scoop", "shims"));
      } else {
        candidates.push(...userManagedExecutableDirs(home));
        candidates.push(import_node_path.default.join(home, ".local", "bin"));
      }
    }
  } catch {
  }
  if (process.platform === "win32") {
    if (process.env.APPDATA) candidates.push(import_node_path.default.join(process.env.APPDATA, "npm"));
    if (process.env.LOCALAPPDATA) candidates.push(import_node_path.default.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps"));
    if (process.env.ProgramData) candidates.push(import_node_path.default.join(process.env.ProgramData, "chocolatey", "bin"));
    if (process.env.SCOOP) candidates.push(import_node_path.default.join(process.env.SCOOP, "shims"));
  } else {
    candidates.push(
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin"
    );
  }
  const existingParts = (existing ?? "").split(import_node_path.default.delimiter).filter(Boolean);
  const seen = new Set(existingParts);
  const prepend = [];
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    prepend.push(dir);
  }
  return [...prepend, ...existingParts].join(import_node_path.default.delimiter);
}
var CLI_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
var cliEnvCache;
function cliEnvGeneration(stat) {
  return `${stat.dev}\0${stat.ino}\0${stat.ctimeNs}\0${stat.mtimeNs}\0${stat.size}`;
}
function readCliEnvValues(file, before) {
  const generation = cliEnvGeneration(before);
  const fd = (0, import_node_fs.openSync)(file, "r");
  try {
    const opened = (0, import_node_fs.fstatSync)(fd, { bigint: true });
    if (!opened.isFile() || cliEnvGeneration(opened) !== generation) throw new Error("CLI environment changed before read");
    const text = (0, import_node_fs.readFileSync)(fd, "utf8");
    const afterRead = (0, import_node_fs.fstatSync)(fd, { bigint: true });
    const afterPath = (0, import_node_fs.statSync)(file, { bigint: true });
    if (!afterRead.isFile() || !afterPath.isFile() || cliEnvGeneration(afterRead) !== generation || cliEnvGeneration(afterPath) !== generation) {
      throw new Error("CLI environment changed during read");
    }
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("CLI environment is not an object");
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, value]) => {
      if (!CLI_ENV_KEY.test(key) || key.toUpperCase() === "PATH") return [];
      if (typeof value === "string") return [[key, value]];
      if (typeof value === "number" || typeof value === "boolean") return [[key, String(value)]];
      return [];
    }));
  } finally {
    (0, import_node_fs.closeSync)(fd);
  }
}
function userDeclaredCliEnv() {
  let file;
  try {
    const base = process.env.CLEMENTINE_HOME?.trim() || import_node_path.default.join(import_node_os.default.homedir(), ".clementine-next");
    file = import_node_path.default.join(base, "state", "cli-env.json");
  } catch {
    cliEnvCache = void 0;
    return {};
  }
  try {
    const before = (0, import_node_fs.statSync)(file, { bigint: true });
    if (!before.isFile()) throw new Error("CLI environment is not a file");
    const generation = cliEnvGeneration(before);
    if (cliEnvCache?.file === file && cliEnvCache.generation === generation) {
      return Object.fromEntries(Object.entries(cliEnvCache.values));
    }
    const values = Object.freeze(readCliEnvValues(file, before));
    cliEnvCache = { file, generation, values };
    return Object.fromEntries(Object.entries(values));
  } catch {
    cliEnvCache = void 0;
    return {};
  }
}
function connectedCliBinDir() {
  try {
    const base = process.env.CLEMENTINE_HOME?.trim() || import_node_path.default.join(import_node_os.default.homedir(), ".clementine-next");
    return import_node_path.default.join(base, "state", "connected-cli-bin");
  } catch {
    return void 0;
  }
}
function withConnectedCliBin(pathValue) {
  if (process.platform === "win32") return pathValue;
  const dir = connectedCliBinDir();
  if (!dir || !existingDirectory(dir)) return pathValue;
  const rest = pathValue.split(import_node_path.default.delimiter).filter((part) => part && part !== dir);
  return [dir, ...rest].join(import_node_path.default.delimiter);
}
function childExecutablePath(inheritedPath) {
  return withConnectedCliBin(augmentPath(inheritedPath));
}
function mergedSpawnEnv(extra = {}, options = {}) {
  const platform = options.platform ?? process.platform;
  const inherited = options.inherited ?? process.env;
  const env2 = mergeChildEnvLayers([
    inherited,
    { PATH: childExecutablePath(childEnvValue(inherited, "PATH", platform)) }
  ], platform);
  const merged = mergeChildEnvLayers([env2, userDeclaredCliEnv(), extra], platform);
  const npmCache = isolatedNpmCache(merged, platform);
  return npmCache ? mergeChildEnvLayers([merged, { NPM_CONFIG_CACHE: npmCache }], platform) : merged;
}

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
  constructor(message, code, path10) {
    super(`${message} at ${path10}`);
    this.code = code;
    this.path = path10;
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
  const token = (text, path10) => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maxTotalBytes) {
      throw new ClosedCanonicalJsonError(
        "canonical JSON exceeds the total byte limit",
        "total_byte_limit",
        path10
      );
    }
    return text;
  };
  const encodeString = (text, path10) => {
    if (Buffer.byteLength(text, "utf8") > maxStringBytes) {
      throw new ClosedCanonicalJsonError(
        "string exceeds the canonical JSON string limit",
        "string_limit",
        path10
      );
    }
    return token(JSON.stringify(text), path10);
  };
  const visit = (input, path10, depth) => {
    nodes += 1;
    if (nodes > maxNodes) {
      throw new ClosedCanonicalJsonError("canonical JSON exceeds the node limit", "node_limit", path10);
    }
    if (depth > maxDepth) {
      throw new ClosedCanonicalJsonError("canonical JSON exceeds the depth limit", "depth_limit", path10);
    }
    if (input === null) return token("null", path10);
    if (typeof input === "string") return encodeString(input, path10);
    if (typeof input === "boolean") return token(input ? "true" : "false", path10);
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new ClosedCanonicalJsonError("number is not finite", "non_finite_number", path10);
      }
      return token(JSON.stringify(input), path10);
    }
    if (typeof input !== "object") {
      throw new ClosedCanonicalJsonError("value is outside the closed JSON domain", "unsupported_type", path10);
    }
    if (seen.has(input)) {
      throw new ClosedCanonicalJsonError("value is cyclic", "cyclic", path10);
    }
    if (Object.getOwnPropertySymbols(input).length > 0) {
      throw new ClosedCanonicalJsonError("symbol keys are not JSON data", "symbol_key", path10);
    }
    const prototype = Object.getPrototypeOf(input);
    if (Array.isArray(input)) {
      if (prototype !== Array.prototype) {
        throw new ClosedCanonicalJsonError("array has a foreign prototype", "non_plain_object", path10);
      }
      const descriptors2 = Object.getOwnPropertyDescriptors(input);
      const names = Object.getOwnPropertyNames(input);
      for (const name of names) {
        if (name === "length") continue;
        if (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= input.length) {
          throw new ClosedCanonicalJsonError(
            "array has an extra non-index property",
            "extra_array_property",
            `${path10}.${name}`
          );
        }
      }
      seen.add(input);
      try {
        token("[", path10);
        const children = [];
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = descriptors2[String(index)];
          if (!descriptor) {
            throw new ClosedCanonicalJsonError("array is sparse", "sparse_array", `${path10}[${index}]`);
          }
          if ("get" in descriptor || "set" in descriptor) {
            throw new ClosedCanonicalJsonError(
              "accessor properties are not canonical JSON",
              "accessor_property",
              `${path10}[${index}]`
            );
          }
          if (index > 0) token(",", path10);
          children.push(visit(descriptor.value, `${path10}[${index}]`, depth + 1));
        }
        token("]", path10);
        return `[${children.join(",")}]`;
      } finally {
        seen.delete(input);
      }
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ClosedCanonicalJsonError("object is not plain JSON", "non_plain_object", path10);
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.getOwnPropertyNames(input).sort();
    seen.add(input);
    try {
      token("{", path10);
      const fields = [];
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        const keyPath = `${path10}.${key}`;
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
        if (fields.length > 0) token(",", path10);
        const encodedKey = encodeString(key, keyPath);
        token(":", keyPath);
        fields.push(`${encodedKey}:${visit(descriptor.value, keyPath, depth + 1)}`);
      }
      token("}", path10);
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
var import_node_crypto6 = require("node:crypto");
var import_node_fs8 = require("node:fs");
var import_node_path8 = __toESM(require("node:path"), 1);

// src/config.ts
var import_node_async_hooks = require("node:async_hooks");
var import_node_fs5 = require("node:fs");
var import_node_os2 = __toESM(require("node:os"), 1);
var import_node_path4 = __toESM(require("node:path"), 1);
var import_node_url2 = require("node:url");

// src/runtime/credential-private-filesystem.ts
var import_node_crypto3 = require("node:crypto");
var import_node_fs4 = require("node:fs");
var import_node_path3 = __toESM(require("node:path"), 1);

// src/runtime/windows-private-filesystem.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto2 = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_node_path2 = __toESM(require("node:path"), 1);
var import_node_url = require("node:url");

// src/runtime/ascii-json.ts
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// src/runtime/windows-private-filesystem.ts
var WINDOWS_PRIVATE_FILESYSTEM_ACL_SOURCE = String.raw`
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class ClemPrivateAcl {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder p,uint size,uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationByHandleW(SafeFileHandle h,StringBuilder name,uint size,out uint serial,out uint component,out uint flags,StringBuilder fs,uint fsSize);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle h,int type,uint information,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle h,int type,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor,out bool present,out IntPtr dacl,out bool defaulted);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  static void Require(bool ok,string stage="acl_policy") { if(!ok) throw new InvalidOperationException("private ACL "+stage+" failed"); }
  static RawSecurityDescriptor Read(SafeFileHandle h) {
    IntPtr owner,group,dacl,sacl,sd;
    Require(GetSecurityInfo(h,1,5,out owner,out group,out dacl,out sacl,out sd)==0);
    try {
      uint count=GetSecurityDescriptorLength(sd); Require(count>0 && count<=65536);
      byte[] bytes=new byte[count]; Marshal.Copy(sd,bytes,0,(int)count);
      return new RawSecurityDescriptor(bytes,0);
    } finally { LocalFree(sd); }
  }
  static bool Trusted(SecurityIdentifier sid, SecurityIdentifier user) {
    return sid!=null && (sid.Equals(user) || sid.Value=="S-1-5-18" || sid.Value=="S-1-5-32-544");
  }
  static void Verify(RawSecurityDescriptor sd,SecurityIdentifier user,bool directory,bool allowInheritedPrivate) {
    Require(Trusted(sd.Owner,user));
    Require((allowInheritedPrivate || (sd.ControlFlags & ControlFlags.DiscretionaryAclProtected)!=0) && sd.DiscretionaryAcl!=null);
    Require(sd.DiscretionaryAcl.Count>0 && sd.DiscretionaryAcl.Count<=3);
    bool own=false; var seen=new System.Collections.Generic.HashSet<string>();
    AceFlags flags=directory ? AceFlags.ContainerInherit|AceFlags.ObjectInherit : AceFlags.None;
    foreach(GenericAce raw in sd.DiscretionaryAcl) {
      CommonAce ace=raw as CommonAce;
      Require(ace!=null && !ace.IsCallback && ace.AceQualifier==AceQualifier.AccessAllowed);
      Require(Trusted(ace.SecurityIdentifier,user) && seen.Add(ace.SecurityIdentifier.Value));
      // Credential-only legacy admission inspects the CURRENT effective ACL.
      // It never repairs an inherited ACL or accepts an inherit-only, callback,
      // deny, duplicate or untrusted rule. Strict stores retain exact flags.
      AceFlags allowed=flags|AceFlags.Inherited;
      Require((allowInheritedPrivate ? (ace.AceFlags & ~allowed)==0 : ace.AceFlags==flags) && ace.AccessMask==0x1f01ff);
      if(ace.SecurityIdentifier.Equals(user)) own=true;
    }
    Require(own);
  }
  static void Harden(SafeFileHandle h,RawSecurityDescriptor old,SecurityIdentifier user,bool directory) {
    Require(Trusted(old.Owner,user));
    RawAcl acl=new RawAcl(2,3);
    AceFlags flags=directory ? AceFlags.ContainerInherit|AceFlags.ObjectInherit : AceFlags.None;
    foreach(string sid in new[]{user.Value,"S-1-5-18","S-1-5-32-544"})
      acl.InsertAce(acl.Count,new CommonAce(flags,AceQualifier.AccessAllowed,0x1f01ff,new SecurityIdentifier(sid),false,null));
    var sd=new RawSecurityDescriptor(ControlFlags.DiscretionaryAclPresent|ControlFlags.DiscretionaryAclProtected,old.Owner,old.Group,null,acl);
    byte[] bytes=new byte[sd.BinaryLength]; sd.GetBinaryForm(bytes,0);
    GCHandle pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);
    try {
      bool present,defaulted; IntPtr dacl;
      Require(GetSecurityDescriptorDacl(pinned.AddrOfPinnedObject(),out present,out dacl,out defaulted) && present && dacl!=IntPtr.Zero);
      Require(SetSecurityInfo(h,1,0x80000004,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero)==0);
    } finally { pinned.Free(); }
  }
  public static void Apply(string target,ulong volume,ulong inode,ulong links,bool directory,bool harden,bool allowInheritedPrivate) {
    Require(!String.IsNullOrEmpty(target) && target.Length<=16000 && Path.IsPathRooted(target));
    using(var h=CreateFileW(target,0x20080u|(harden?0x40000u:0u),3,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      Require(!h.IsInvalid,"open_handle");
      Info info; Require(GetFileInformationByHandle(h,out info));
      Require(info.Volume==volume && (((ulong)info.IndexHigh<<32)|info.IndexLow)==inode && inode!=0,"identity");
      Require(info.Links==links && (!harden || directory || links==1));
      Require((info.Attributes&0x400)==0 && ((info.Attributes&0x10)!=0)==directory);
      var canonical=new StringBuilder(32768);
      uint count=GetFinalPathNameByHandleW(h,canonical,32768,0); Require(count>0 && count<32768);
      string observed=canonical.ToString(); if(observed.StartsWith(@"\\?\")) observed=observed.Substring(4);
      Require(String.Equals(observed,Path.GetFullPath(target),StringComparison.OrdinalIgnoreCase),"canonical_path");
      uint serial,component,flags; var fs=new StringBuilder(32);
      Require(GetVolumeInformationByHandleW(h,null,0,out serial,out component,out flags,fs,32) && fs.ToString()=="NTFS","ntfs_volume");
      var user=WindowsIdentity.GetCurrent().User; Require(user!=null);
      var sd=Read(h);
      if(harden) { Harden(h,sd,user,directory); sd=Read(h); }
      Verify(sd,user,directory,!harden && allowInheritedPrivate);
      Info after; Require(GetFileInformationByHandle(h,out after));
      Require(after.Volume==info.Volume && after.IndexHigh==info.IndexHigh && after.IndexLow==info.IndexLow && after.Links==info.Links);
    }
  }
}
`;
var ACL_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
try {
# The request is ASCII-only JSON (asciiJson), readable in any console code page.
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false, $true) } catch { }
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
` + WINDOWS_PRIVATE_FILESYSTEM_ACL_SOURCE + String.raw`
'@
if($p.version -ne 2) { throw 'unsupported private ACL protocol' }
[ClemPrivateAcl]::Apply($p.path,[UInt64]::Parse($p.dev),[UInt64]::Parse($p.ino),[UInt64]::Parse($p.nlink),[bool]$p.directory,[bool]$p.harden,[bool]$p.allowInheritedPrivate)
[Console]::Out.Write('private-acl-ok-v2')
} catch {
  if($p.syntheticDiagnostic -eq $true) { [Console]::Error.Write($_.ToString()) }
  else { [Console]::Error.Write('private-acl-refused-v1') }
  exit 1
}
`;
var WindowsPrivateFilesystemError = class extends Error {
  constructor(cause) {
    super("Windows private filesystem ACL could not be verified. Check NTFS folder access and the Clementine native helper installation, then retry. Development fallback also requires PowerShell access.", cause === void 0 ? void 0 : { cause });
    this.name = "WindowsPrivateFilesystemError";
  }
};
function windowsPrivateFilesystemProbeLocation() {
  const filename = typeof __filename === "string" ? __filename : (0, import_node_url.fileURLToPath)(import_meta_url);
  const directory = import_node_path2.default.dirname(filename);
  for (let ancestor = directory; ; ancestor = import_node_path2.default.dirname(ancestor)) {
    if (import_node_path2.default.basename(ancestor).toLowerCase() === "daemon" && (0, import_node_fs2.existsSync)(import_node_path2.default.join(import_node_path2.default.dirname(ancestor), "windows-private-filesystem"))) {
      return { directory: import_node_path2.default.join(import_node_path2.default.dirname(ancestor), "windows-private-filesystem"), packaged: true };
    }
    if (import_node_path2.default.dirname(ancestor) === ancestor) break;
  }
  const packageRoot = import_node_path2.default.resolve(directory, "../..");
  if (import_node_path2.default.basename(packageRoot).toLowerCase() === "daemon") {
    return { directory: import_node_path2.default.join(import_node_path2.default.dirname(packageRoot), "windows-private-filesystem"), packaged: true };
  }
  const asarIndex = filename.toLowerCase().indexOf(`${import_node_path2.default.sep}app.asar${import_node_path2.default.sep}`);
  if (asarIndex >= 0) {
    const resources = filename.slice(0, asarIndex);
    if (!import_node_path2.default.isAbsolute(resources)) throw new WindowsPrivateFilesystemError();
    return { directory: import_node_path2.default.join(resources, "windows-private-filesystem"), packaged: true };
  }
  const repoRoot = import_node_path2.default.basename(import_node_path2.default.dirname(directory)) === "desktop" ? import_node_path2.default.resolve(directory, "../../..") : packageRoot;
  return { directory: import_node_path2.default.join(repoRoot, "output", "windows-private-filesystem"), packaged: false };
}
function windowsPrivateFilesystemClassSourceSha256() {
  return (0, import_node_crypto2.createHash)("sha256").update(WINDOWS_PRIVATE_FILESYSTEM_ACL_SOURCE).digest("hex");
}
function readStableBuildArtifact(target) {
  const before = (0, import_node_fs2.lstatSync)(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.ino === 0n || before.size > 16n * 1024n * 1024n) throw new WindowsPrivateFilesystemError();
  const bytes = (0, import_node_fs2.readFileSync)(target);
  const after = (0, import_node_fs2.lstatSync)(target, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== before.nlink || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new WindowsPrivateFilesystemError();
  return bytes;
}
function qualifiedNativeProbe() {
  const location = windowsPrivateFilesystemProbeLocation();
  const probe = import_node_path2.default.join(location.directory, "windows-private-filesystem-probe.exe");
  const manifestFile = import_node_path2.default.join(location.directory, "manifest.json");
  if (!(0, import_node_fs2.existsSync)(probe) && !(0, import_node_fs2.existsSync)(manifestFile) && !location.packaged) return null;
  try {
    const manifest = JSON.parse(readStableBuildArtifact(manifestFile).toString("utf8"));
    if (manifest.version !== 2 || manifest.classSourceSha256 !== windowsPrivateFilesystemClassSourceSha256() || typeof manifest.probeSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.probeSha256)) throw new WindowsPrivateFilesystemError();
    if ((0, import_node_crypto2.createHash)("sha256").update(readStableBuildArtifact(probe)).digest("hex") !== manifest.probeSha256) throw new WindowsPrivateFilesystemError();
    return probe;
  } catch (cause) {
    throw new WindowsPrivateFilesystemError(cause);
  }
}
function assertWindowsPrivateFilesystem(target, identity, kind, harden = false, options = {}) {
  if (process.platform !== "win32") throw new Error("Windows private ACL verification called on another platform");
  if (!import_node_path2.default.isAbsolute(target) || target.length > 16e3 || /\0/.test(target)) throw new Error("private ACL target is invalid");
  const syntheticHome = process.env.CLEMENTINE_HOME ?? "";
  const relative = import_node_path2.default.relative(syntheticHome, target);
  const syntheticDiagnostic = process.env.CLEMMY_TEST_ISOLATED_HOME === "1" && process.env.CLEMMY_TEST_PRIVATE_ACL_DIAGNOSTICS === "1" && /^clem-private-ntfs-test-/.test(import_node_path2.default.basename(syntheticHome)) && !relative.startsWith("..") && !import_node_path2.default.isAbsolute(relative);
  const allowInheritedPrivate = !harden && options.allowInheritedPrivate === true;
  const input = asciiJson({ version: 2, path: target, dev: String(identity.dev), ino: String(identity.ino), nlink: String(identity.nlink), directory: kind === "directory", harden, allowInheritedPrivate, syntheticDiagnostic });
  const native = qualifiedNativeProbe();
  const systemRoot = Object.entries(process.env).find(([key, value]) => key.toLowerCase() === "systemroot" && value)?.[1] ?? "C:\\Windows";
  if (!import_node_path2.default.isAbsolute(systemRoot)) throw new WindowsPrivateFilesystemError();
  const command = native ?? import_node_path2.default.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = native ? [] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ACL_PROGRAM, "utf16le").toString("base64")];
  const env2 = native ? Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== void 0 && /^(?:systemroot|windir|systemdrive|comspec|pathext|temp|tmp)$/i.test(key))) : process.env;
  const result = (0, import_node_child_process.spawnSync)(command, args, {
    input,
    env: env2,
    encoding: "utf8",
    windowsHide: true,
    timeout: native ? 15e3 : 1e4,
    maxBuffer: 4096
  });
  if (result.error || result.status !== 0 || result.stdout !== "private-acl-ok-v2") {
    throw new WindowsPrivateFilesystemError(syntheticDiagnostic ? String(result.stderr || result.error?.message || "no ACL receipt").slice(0, 4096) : void 0);
  }
  return { backend: native ? "native" : "powershell-development", policy: allowInheritedPrivate ? "credential-inherited-private-v1" : "strict" };
}

// src/runtime/sync-directory.ts
var import_node_fs3 = require("node:fs");
var nativeIo = {
  open: (directory, flags) => (0, import_node_fs3.openSync)(directory, flags),
  sync: import_node_fs3.fsyncSync,
  close: import_node_fs3.closeSync
};
function syncDirectoryMetadata(directory, options = {}) {
  if ((options.platform ?? process.platform) === "win32") return "unsupported_on_windows";
  const io = options.io ?? nativeIo;
  const fd = io.open(directory, options.flags ?? "r");
  try {
    io.sync(fd);
  } finally {
    io.close(fd);
  }
  return "synced";
}

// src/runtime/credential-private-filesystem.ts
var MAX_CREDENTIAL_BYTES = 8 * 1024 * 1024;
var MESSAGE = "Credential storage privacy or integrity could not be verified. Check NTFS folder permissions and the Clementine installation, then retry; no other credential source was selected. A write may require verification before retrying.";
var CredentialStoragePrivacyError = class extends Error {
  constructor(_cause) {
    super(MESSAGE);
    this.name = "CredentialStoragePrivacyError";
  }
};
function isCredentialStoragePrivacyError(error) {
  return error instanceof Error && error.name === "CredentialStoragePrivacyError";
}
var regular = (stat) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.ino !== 0n;
var same = (left, right) => left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
var CREDENTIAL_ACL_REUSE_MS = 3e4;
function createCredentialFilePolicy(dependencies = {}) {
  const windows = (dependencies.platform ?? process.platform) === "win32";
  const observeAcl = dependencies.checkAcl ?? assertWindowsPrivateFilesystem;
  const now = dependencies.now ?? (() => performance.now());
  const verified = /* @__PURE__ */ new Map();
  const checkAcl = (target, stat, kind, harden = false, options) => {
    const key = `${kind}\0${options?.allowInheritedPrivate === true}\0${target}`;
    const prior = verified.get(key);
    verified.delete(key);
    if (!harden && prior && now() - prior.at < CREDENTIAL_ACL_REUSE_MS && prior.stat.dev === stat.dev && prior.stat.ino === stat.ino && (kind === "directory" || same(prior.stat, stat))) {
      verified.set(key, prior);
      return;
    }
    observeAcl(target, stat, kind, harden, options);
    if (!harden) verified.set(key, { at: now(), stat });
  };
  const assertMissingPathParents = (directory, verifyNearestPrivate = true) => {
    let current = directory;
    let nearestObserved = false;
    while (true) {
      try {
        const stat = (0, import_node_fs4.lstatSync)(current, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) throw new CredentialStoragePrivacyError();
        if (!nearestObserved) {
          if (verifyNearestPrivate) privateDirectory(current);
          nearestObserved = true;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const parent = import_node_path3.default.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  };
  const privateDirectory = (directory, harden = false) => {
    const before = (0, import_node_fs4.lstatSync)(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || before.ino === 0n) throw new CredentialStoragePrivacyError();
    checkAcl(directory, before, "directory", harden, { allowInheritedPrivate: !harden });
    const after = (0, import_node_fs4.lstatSync)(directory, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.isSymbolicLink() || !after.isDirectory()) throw new CredentialStoragePrivacyError();
  };
  const ensureDirectory = (directory) => {
    try {
      (0, import_node_fs4.lstatSync)(directory);
      privateDirectory(directory);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = import_node_path3.default.dirname(directory);
    if (parent === directory) throw new CredentialStoragePrivacyError();
    ensureDirectory(parent);
    (0, import_node_fs4.mkdirSync)(directory, { mode: 448 });
    privateDirectory(directory, true);
  };
  const read = (target, optionalExternalSource = false) => {
    if (!windows) return (0, import_node_fs4.existsSync)(target) ? (0, import_node_fs4.readFileSync)(target, "utf8") : void 0;
    let fd;
    try {
      const directory = import_node_path3.default.dirname(target);
      if (!import_node_path3.default.isAbsolute(target) || target.includes("\0")) throw new CredentialStoragePrivacyError();
      let entry;
      try {
        entry = (0, import_node_fs4.lstatSync)(target, { bigint: true });
      } catch (error) {
        if (error.code === "ENOENT") {
          assertMissingPathParents(directory, !optionalExternalSource);
          return void 0;
        }
        throw error;
      }
      if (!regular(entry) || entry.size > BigInt(MAX_CREDENTIAL_BYTES)) throw new CredentialStoragePrivacyError();
      privateDirectory(directory);
      fd = (0, import_node_fs4.openSync)(target, import_node_fs4.constants.O_RDONLY | (import_node_fs4.constants.O_NOFOLLOW ?? 0));
      const before = (0, import_node_fs4.fstatSync)(fd, { bigint: true });
      if (!regular(before) || !same(entry, before)) throw new CredentialStoragePrivacyError();
      checkAcl(target, before, "file", false, { allowInheritedPrivate: true });
      const raw = (0, import_node_fs4.readFileSync)(fd, "utf8");
      const after = (0, import_node_fs4.fstatSync)(fd, { bigint: true });
      if (!regular(after) || !same(before, after) || !same(after, (0, import_node_fs4.lstatSync)(target, { bigint: true }))) throw new CredentialStoragePrivacyError();
      checkAcl(target, after, "file", false, { allowInheritedPrivate: true });
      privateDirectory(directory);
      if (!same(after, (0, import_node_fs4.fstatSync)(fd, { bigint: true })) || !same(after, (0, import_node_fs4.lstatSync)(target, { bigint: true }))) throw new CredentialStoragePrivacyError();
      return raw;
    } catch (cause) {
      throw isCredentialStoragePrivacyError(cause) ? cause : new CredentialStoragePrivacyError(cause);
    } finally {
      if (fd !== void 0) (0, import_node_fs4.closeSync)(fd);
    }
  };
  const write = (target, content, format, options) => {
    const pinsPrior = format === "text" && options !== void 0 && Object.hasOwn(options, "expectedPrior");
    const assertExpectedPrior = (observed) => {
      if (pinsPrior && observed !== options.expectedPrior) throw new CredentialStoragePrivacyError();
    };
    if (!windows) {
      if (pinsPrior) {
        try {
          assertExpectedPrior(read(target));
        } catch (cause) {
          throw isCredentialStoragePrivacyError(cause) ? cause : new CredentialStoragePrivacyError(cause);
        }
      }
      (0, import_node_fs4.mkdirSync)(import_node_path3.default.dirname(target), { recursive: true });
      const temporary2 = `${target}.${process.pid}.${(0, import_node_crypto3.randomUUID)()}.tmp`;
      try {
        (0, import_node_fs4.writeFileSync)(temporary2, content, { encoding: "utf8", mode: 384 });
        if (pinsPrior) assertExpectedPrior(read(target));
        (0, import_node_fs4.renameSync)(temporary2, target);
        try {
          (0, import_node_fs4.chmodSync)(target, 384);
        } catch {
        }
      } catch (cause) {
        if (pinsPrior) throw isCredentialStoragePrivacyError(cause) ? cause : new CredentialStoragePrivacyError(cause);
        throw cause;
      } finally {
        try {
          (0, import_node_fs4.unlinkSync)(temporary2);
        } catch {
        }
      }
      return;
    }
    let fd;
    let temporary;
    let temporaryIdentity;
    try {
      if (Buffer.byteLength(content) > MAX_CREDENTIAL_BYTES) throw new CredentialStoragePrivacyError();
      const prior = read(target);
      assertExpectedPrior(prior);
      if (prior !== void 0 && format === "json-object") {
        const parsed = JSON.parse(prior);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CredentialStoragePrivacyError();
      }
      const priorIdentity = prior === void 0 ? null : (0, import_node_fs4.lstatSync)(target, { bigint: true });
      const directory = import_node_path3.default.dirname(target);
      ensureDirectory(directory);
      temporary = import_node_path3.default.join(directory, `.${import_node_path3.default.basename(target)}.${process.pid}.${(0, import_node_crypto3.randomUUID)()}.tmp`);
      fd = (0, import_node_fs4.openSync)(temporary, import_node_fs4.constants.O_CREAT | import_node_fs4.constants.O_EXCL | import_node_fs4.constants.O_WRONLY | (import_node_fs4.constants.O_NOFOLLOW ?? 0), 384);
      const empty = (0, import_node_fs4.fstatSync)(fd, { bigint: true });
      temporaryIdentity = empty;
      if (!regular(empty) || empty.size !== 0n) throw new CredentialStoragePrivacyError();
      checkAcl(temporary, empty, "file", true);
      (0, import_node_fs4.writeFileSync)(fd, content, "utf8");
      (0, import_node_fs4.fsyncSync)(fd);
      const written = (0, import_node_fs4.fstatSync)(fd, { bigint: true });
      if (!regular(written) || written.dev !== empty.dev || written.ino !== empty.ino || !same(written, (0, import_node_fs4.lstatSync)(temporary, { bigint: true }))) throw new CredentialStoragePrivacyError();
      checkAcl(temporary, written, "file");
      privateDirectory(directory);
      const current = read(target);
      assertExpectedPrior(current);
      if (current !== prior || priorIdentity && !same(priorIdentity, (0, import_node_fs4.lstatSync)(target, { bigint: true }))) throw new CredentialStoragePrivacyError();
      (0, import_node_fs4.closeSync)(fd);
      fd = void 0;
      (0, import_node_fs4.renameSync)(temporary, target);
      temporary = void 0;
      syncDirectoryMetadata(directory);
      if (read(target) !== content) throw new CredentialStoragePrivacyError();
    } catch (cause) {
      throw isCredentialStoragePrivacyError(cause) ? cause : new CredentialStoragePrivacyError(cause);
    } finally {
      if (fd !== void 0) (0, import_node_fs4.closeSync)(fd);
      if (temporary && temporaryIdentity) {
        try {
          const current = (0, import_node_fs4.lstatSync)(temporary, { bigint: true });
          if (regular(current) && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) (0, import_node_fs4.unlinkSync)(temporary);
        } catch {
        }
      }
    }
  };
  return {
    readCredentialFileSync: (target) => read(target),
    // Optional external .env/CLI files are never hardened. Safe absent files
    // need no private ACL on public package/cwd parents. Present files use the
    // same current parent/file ACL, no-follow and exact identity checks.
    readCredentialSourceFileSync: (target) => read(target, true),
    writeCredentialFileSync: (target, content) => write(target, content, "json-object"),
    /** Optional exact prior bytes bind a caller's read-modify-write composition.
     * An own expectedPrior:undefined requires absence; omitting it pins nothing. */
    writeCredentialTextFileSync: (target, content, options) => write(target, content, "text", options),
    assertCredentialFileReadable: (target) => {
      read(target);
    }
  };
}
var policy = createCredentialFilePolicy();
var readCredentialFileSync = policy.readCredentialFileSync;
var readCredentialSourceFileSync = policy.readCredentialSourceFileSync;
var writeCredentialFileSync = policy.writeCredentialFileSync;
var writeCredentialTextFileSync = policy.writeCredentialTextFileSync;
var assertCredentialFileReadable = policy.assertCredentialFileReadable;

// src/config.ts
var __filename2 = (0, import_node_url2.fileURLToPath)(import_meta_url);
var __dirname = import_node_path4.default.dirname(__filename2);
var PKG_DIR = import_node_path4.default.resolve(__dirname, "..");
function realUserHome() {
  try {
    return import_node_os2.default.userInfo().homedir;
  } catch {
    return import_node_os2.default.homedir();
  }
}
var REAL_USER_HOME = process.env.CLEMMY_REAL_USER_HOME || realUserHome();
var REAL_DEFAULT_CLEMENTINE_HOME = import_node_path4.default.resolve(import_node_path4.default.join(REAL_USER_HOME, ".clementine-next"));
var DEFAULT_BASE_DIR = process.env.CLEMENTINE_HOME || REAL_DEFAULT_CLEMENTINE_HOME;
function isTestProcess() {
  return Boolean(
    process.env.NODE_TEST_CONTEXT || process.env.CLEMMY_TEST_ISOLATED_HOME === "1" || process.argv.includes("--test")
  );
}
if (isTestProcess() && import_node_path4.default.resolve(DEFAULT_BASE_DIR) === REAL_DEFAULT_CLEMENTINE_HOME && process.env.CLEMMY_ALLOW_LIVE_HOME_TESTS !== "1") {
  throw new Error(
    "Refusing to bind BASE_DIR to the live Clementine home from a test process. Set CLEMENTINE_HOME to a unique temp directory before importing config, or set CLEMMY_ALLOW_LIVE_HOME_TESTS=1 for an explicit destructive test."
  );
}
var BASE_DIR = DEFAULT_BASE_DIR;
function parseEnvText(text) {
  const result = {};
  for (const rawLine of text.split("\n")) {
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
    return [import_node_path4.default.join(BASE_DIR, ".env")];
  }
  return [
    import_node_path4.default.join(PKG_DIR, ".env"),
    import_node_path4.default.join(process.cwd(), ".env"),
    import_node_path4.default.join(BASE_DIR, ".env")
  ];
}
function captureEnvFiles() {
  const files = [];
  const environment = {};
  for (const filePath of [...new Set(envSearchPaths())]) {
    const raw = process.platform === "win32" ? readCredentialSourceFileSync(filePath) : (0, import_node_fs5.existsSync)(filePath) ? (0, import_node_fs5.readFileSync)(filePath, "utf-8") : void 0;
    if (raw === void 0) continue;
    files.push(filePath);
    Object.assign(environment, parseEnvText(raw));
  }
  return { files, environment };
}
var initialEnvFiles = captureEnvFiles();
var ACTIVE_ENV_FILES = initialEnvFiles.files;
var env = initialEnvFiles.environment;
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
var runtimeConfigCaptureObserverForTest;
function captureSecretVault() {
  const vaultPath = import_node_path4.default.join(BASE_DIR, "state", "secrets-vault.json");
  let entries = {};
  if (process.platform === "win32" || (0, import_node_fs5.existsSync)(vaultPath)) {
    try {
      const raw = process.platform === "win32" ? readCredentialFileSync(vaultPath) : (0, import_node_fs5.readFileSync)(vaultPath, "utf-8");
      if (raw === void 0) {
        runtimeConfigCaptureObserverForTest?.("secret_vault");
        return Object.freeze(entries);
      }
      const parsed = JSON.parse(raw);
      if (parsed.version === "v1" && parsed.entries) {
        if (process.platform === "win32" && (typeof parsed.entries !== "object" || Array.isArray(parsed.entries) || Object.values(parsed.entries).some((value) => typeof value !== "string"))) throw new CredentialStoragePrivacyError();
        entries = { ...parsed.entries };
      } else if (process.platform === "win32") throw new CredentialStoragePrivacyError();
    } catch (cause) {
      if (process.platform === "win32") throw isCredentialStoragePrivacyError(cause) ? cause : new CredentialStoragePrivacyError(cause);
      entries = {};
    }
  }
  runtimeConfigCaptureObserverForTest?.("secret_vault");
  return Object.freeze(entries);
}
var runtimeConfigRequestStorage = new import_node_async_hooks.AsyncLocalStorage();
function readSecretFromFileVaultSync(name) {
  const requestSnapshot = runtimeConfigRequestStorage.getStore();
  const value = requestSnapshot ? requestSnapshot.secretValue(name) : captureSecretVault()[name];
  return value && value.length > 0 ? value : void 0;
}
function resolveOpenAiAgentsTracingDisabled(configuredValue, apiKey) {
  const configured = configuredValue?.trim().toLowerCase() ?? "";
  if (configured === "1" || configured === "true" || configured === "on") return "1";
  if (configured) return void 0;
  return apiKey.trim() ? void 0 : "1";
}
var agentsTracingDisabled = resolveOpenAiAgentsTracingDisabled(
  getEnv("OPENAI_AGENTS_DISABLE_TRACING", ""),
  process.env.OPENAI_API_KEY ?? ""
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
var CODEX_AUTH_SOURCE_FILE = getEnv("CODEX_AUTH_SOURCE_FILE", import_node_path4.default.join(import_node_os2.default.homedir(), ".codex", "auth.json"));
var CODEX_EXECUTABLE = getEnv("CODEX_EXECUTABLE", "codex");
var CODEX_INSTALL_PACKAGE = getEnv("CODEX_INSTALL_PACKAGE", "@openai/codex");
var CODEX_SANDBOX_MODE = getEnv("CODEX_SANDBOX_MODE", "workspace-write");
var CODEX_USE_FULL_AUTO = getEnv("CODEX_USE_FULL_AUTO", "true").toLowerCase() === "true";
var VAULT_DIR = import_node_path4.default.join(BASE_DIR, "vault");
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
var MCP_SERVERS_FILE = import_node_path4.default.join(BASE_DIR, "mcp", "servers.json");
var COMPOSIO_API_KEY = getEnv("COMPOSIO_API_KEY", "");
var COMPOSIO_USER_ID = getEnv("COMPOSIO_USER_ID", "");

// src/integrations/cli-catalog/catalog-entries.ts
function catalogReviewedReadsOf(entry) {
  return Object.freeze([
    ...entry.reviewedRead ? [entry.reviewedRead] : [],
    ...entry.reviewedReads ?? []
  ]);
}
var CLI_CATALOG = [
  {
    id: "salesforce",
    name: "Salesforce CLI",
    command: "sf",
    vendor: "Salesforce",
    description: "Manage Salesforce orgs, deploy metadata, run SOQL, and automate Apex.",
    tags: ["salesforce", "sf", "sfdx", "crm", "apex", "soql"],
    installCommand: "npm install -g @salesforce/cli",
    installSource: "npm",
    authDocsUrl: "https://developer.salesforce.com/docs/atlas.en-us.sfdx_setup.meta/sfdx_setup/sfdx_setup_auth_intro.htm",
    authCommand: "sf org login web -a default",
    homepage: "https://developer.salesforce.com/tools/salesforcecli",
    // Default-org only. `sf org list` would classify a second inactive org
    // as signed-out even when the default org is Connected.
    authProbe: {
      args: ["org", "display", "--json"],
      failurePatterns: [
        { pattern: "SecKeychain|keychain.*(?:locked|incorrect|not correct)|user name or passphrase you entered is not correct", kind: "credential_store_unavailable" },
        { pattern: "NoDefault(?:Env|OrgFound)Error|no default (?:environment|org)", kind: "configuration_required" }
      ],
      signedOutPattern: "No default org found|NoAuthInfoFound|no default org|Not authenticated|No org found|unable to refresh session",
      usernameCapture: '"username"\\s*:\\s*"([^"]+)"',
      connectionOriginPath: ["result", "instanceUrl"],
      timeoutMs: 15e3
    },
    reviewedRead: {
      descriptorId: "salesforce.data.query",
      operationId: "salesforce_sf_soql_query",
      displayName: "Salesforce CLI SOQL query",
      description: 'Read-only SOQL via the local Salesforce sf CLI (sf data query --json). Query Salesforce opportunities, accounts, contacts, leads, and deals. If it fails because no default org is set, read salesforce_sf_org_list and fix it with cli_setup {action:"repairs", catalogId:"salesforce"} \u2014 never report that you cannot run the command.',
      argvPrefix: ["data", "query", "--json"],
      arguments: [
        { name: "query", kind: "option", token: "--query", valueType: "string", required: true },
        { name: "target_org", kind: "option", token: "--target-org", valueType: "string", required: false }
      ],
      limits: {
        timeoutMs: 6e4,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        maxArgumentBytes: 32768
      }
    },
    repairs: [
      {
        id: "salesforce.default-org",
        title: "Set the default Salesforce org",
        description: "Point the Salesforce CLI at one of its authenticated orgs, so commands that do not name an org stop failing (sf config set target-org=<org> --global).",
        argv: ["config", "set", "target-org={org}", "--global"],
        arguments: [
          { name: "org", description: "Username or alias of an authenticated org, exactly as the org list reports it.", required: true }
        ],
        diagnosis: "salesforce_sf_org_list",
        failureSignals: [
          "NoDefaultEnvError",
          "No default environment",
          "No default org",
          "no default org"
        ],
        limits: { timeoutMs: 3e4, maxStdoutBytes: 65536, maxStderrBytes: 65536 }
      }
    ],
    reviewedReads: [
      {
        descriptorId: "salesforce.org.list",
        operationId: "salesforce_sf_org_list",
        displayName: "Salesforce CLI org list",
        description: "List the Salesforce orgs this machine is authenticated to (sf org list --json): each org's username, alias, connection status, and which one is the default target-org. Read this before reporting a Salesforce CLI authentication problem.",
        argvPrefix: ["org", "list", "--json"],
        arguments: [],
        limits: {
          timeoutMs: 3e4,
          maxStdoutBytes: 262144,
          maxStderrBytes: 65536,
          maxArgumentBytes: 1024
        }
      }
    ]
  },
  {
    id: "higgsfield",
    name: "Higgsfield CLI",
    command: "higgsfield",
    vendor: "Higgsfield",
    description: "Run Higgsfield image, video, and Marketing Studio generative workflows from the terminal.",
    tags: ["higgsfield", "higgs", "hf", "video", "image", "generative", "ai", "marketing studio", "soul-id", "product-photoshoot"],
    installCommand: "npm install -g @higgsfield/cli",
    installSource: "npm",
    authDocsUrl: "https://higgsfield.ai/cli",
    // Note: subcommand `auth login`, not bare `login` (verified against
    // higgsfield 0.1.33). Surfaces as the post-install bootstrap step
    // so the user knows the exact handshake command.
    authCommand: "higgsfield auth login",
    homepage: "https://higgsfield.ai"
  },
  {
    id: "railway",
    name: "Railway CLI",
    command: "railway",
    vendor: "Railway",
    description: "Deploy services, manage environments, and tail logs on Railway.",
    tags: ["railway", "deploy", "paas"],
    installCommand: "npm install -g @railway/cli",
    installSource: "npm",
    authDocsUrl: "https://docs.railway.com/guides/cli",
    authCommand: "railway login",
    // Verified live: exit 0 + "Logged in as user@host 👋"; signed out
    // reports "Unauthorized. Please login with `railway login`".
    authProbe: { args: ["whoami"], signedOutPattern: "unauthorized|not logged in", usernameCapture: "Logged in as (\\S+)" },
    // `railway login` opens the browser and waits on a callback — no TTY
    // input. Job runner enforces a hard timeout as the safety net.
    authHeadless: true,
    homepage: "https://railway.com"
  },
  {
    id: "vercel",
    name: "Vercel CLI",
    command: "vercel",
    vendor: "Vercel",
    description: "Deploy front-end and edge functions to Vercel, manage projects + domains.",
    tags: ["vercel", "deploy", "next.js", "nextjs", "edge"],
    installCommand: "npm install -g vercel",
    installSource: "npm",
    authDocsUrl: "https://vercel.com/docs/cli",
    authCommand: "vercel login",
    homepage: "https://vercel.com"
  },
  {
    id: "supabase",
    name: "Supabase CLI",
    command: "supabase",
    vendor: "Supabase",
    description: "Local dev + migrations + Edge Functions for Supabase projects.",
    tags: ["supabase", "postgres", "database", "edge functions"],
    installCommand: "brew install supabase/tap/supabase",
    installSource: "brew",
    authDocsUrl: "https://supabase.com/docs/guides/local-development/cli/getting-started",
    authCommand: "supabase login",
    homepage: "https://supabase.com"
  },
  {
    id: "github",
    name: "GitHub CLI",
    command: "gh",
    vendor: "GitHub",
    description: "Work with PRs, issues, releases, and Actions from the terminal.",
    tags: ["github", "gh", "git", "pr", "pull request"],
    installCommand: "brew install gh",
    installSource: "brew",
    authDocsUrl: "https://docs.github.com/en/github-cli/github-cli/quickstart",
    authCommand: "gh auth login",
    homepage: "https://cli.github.com"
  },
  {
    id: "aws",
    name: "AWS CLI",
    command: "aws",
    vendor: "Amazon Web Services",
    description: "Manage every AWS service from S3 to IAM to Lambda.",
    tags: ["aws", "amazon", "s3", "iam", "lambda", "ec2"],
    installCommand: "brew install awscli",
    installSource: "brew",
    authDocsUrl: "https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-quickstart.html",
    authCommand: "aws configure",
    homepage: "https://aws.amazon.com/cli/"
  },
  {
    id: "gcloud",
    name: "Google Cloud CLI",
    command: "gcloud",
    vendor: "Google Cloud",
    description: "Manage GCP projects, services, and resources.",
    tags: ["gcloud", "gcp", "google cloud", "firebase"],
    installCommand: "brew install --cask google-cloud-sdk",
    installSource: "brew",
    authDocsUrl: "https://cloud.google.com/sdk/docs/initializing",
    authCommand: "gcloud init",
    // Verified live: active account as a JSON array; with NO active
    // account it prints `[]` and still exits 0 — the pattern carries the
    // signed-out truth, not the exit code.
    authProbe: { args: ["auth", "list", "--format=json", "--filter=status:ACTIVE"], signedOutPattern: "^\\s*\\[\\s*\\]\\s*$", usernameCapture: '"account":\\s*"([^"]+)"', timeoutMs: 1e4 },
    homepage: "https://cloud.google.com/sdk"
  },
  {
    id: "heroku",
    name: "Heroku CLI (manual)",
    // Note: Heroku is intentionally omitted from auto-install because
    // the canonical brew form is `brew tap heroku/brew && brew install
    // heroku`, which is a two-step command our installer allowlist
    // rejects. Listed here so search finds it, but installCommand
    // points the user at the docs rather than running a broken cmd.
    command: "heroku",
    vendor: "Heroku",
    description: "Manage Heroku apps, dynos, addons, and releases. Install via the linked docs.",
    tags: ["heroku", "paas", "deploy"],
    installCommand: "brew install heroku",
    installSource: "brew",
    authDocsUrl: "https://devcenter.heroku.com/articles/heroku-cli",
    authCommand: "heroku login",
    homepage: "https://devcenter.heroku.com/articles/heroku-cli"
  },
  {
    id: "stripe",
    name: "Stripe CLI",
    command: "stripe",
    vendor: "Stripe",
    description: "Trigger events, tail webhook logs, manage products and prices.",
    tags: ["stripe", "payments", "webhooks"],
    installCommand: "brew install stripe/stripe-cli/stripe",
    installSource: "brew",
    authDocsUrl: "https://docs.stripe.com/stripe-cli",
    authCommand: "stripe login",
    homepage: "https://stripe.com/docs/stripe-cli"
  },
  {
    id: "wrangler",
    name: "Cloudflare Wrangler",
    command: "wrangler",
    vendor: "Cloudflare",
    description: "Build, deploy, and tail Workers; manage Pages, KV, R2, D1.",
    tags: ["cloudflare", "wrangler", "workers", "pages", "kv", "r2", "d1"],
    installCommand: "npm install -g wrangler",
    installSource: "npm",
    authDocsUrl: "https://developers.cloudflare.com/workers/wrangler/get-started/",
    authCommand: "wrangler login",
    homepage: "https://developers.cloudflare.com/workers/"
  },
  {
    id: "flyio",
    name: "Fly.io CLI",
    command: "flyctl",
    vendor: "Fly.io",
    description: "Deploy apps globally on Fly.io machines.",
    tags: ["fly", "flyio", "fly.io", "flyctl", "deploy"],
    installCommand: "brew install flyctl",
    installSource: "brew",
    authDocsUrl: "https://fly.io/docs/flyctl/auth-login/",
    authCommand: "flyctl auth login",
    homepage: "https://fly.io"
  },
  {
    id: "netlify",
    name: "Netlify CLI",
    command: "netlify",
    vendor: "Netlify",
    description: "Deploy sites, run local dev, manage Netlify Functions.",
    tags: ["netlify", "jamstack", "deploy"],
    installCommand: "npm install -g netlify-cli",
    installSource: "npm",
    authDocsUrl: "https://docs.netlify.com/cli/get-started/",
    authCommand: "netlify login",
    // Verified live: exit 0 with a "Current Netlify User" block (ANSI
    // colored — auth-health strips escapes) even outside a linked
    // project; signed out prints "Not logged in".
    authProbe: { args: ["status"], signedOutPattern: "not logged in", usernameCapture: "Email:\\s*(\\S+)", timeoutMs: 1e4 },
    authHeadless: true,
    homepage: "https://www.netlify.com"
  },
  {
    id: "doppler",
    name: "Doppler CLI",
    command: "doppler",
    vendor: "Doppler",
    description: "Sync secrets across environments without checking them into source.",
    tags: ["doppler", "secrets", "env"],
    installCommand: "brew install dopplerhq/cli/doppler",
    installSource: "brew",
    authDocsUrl: "https://docs.doppler.com/docs/install-cli",
    authCommand: "doppler login",
    homepage: "https://www.doppler.com"
  },
  {
    id: "ngrok",
    name: "ngrok",
    command: "ngrok",
    vendor: "ngrok",
    description: "Expose local servers to the public internet via secure tunnels.",
    tags: ["ngrok", "tunnel", "webhook"],
    installCommand: "brew install ngrok/ngrok/ngrok",
    installSource: "brew",
    authDocsUrl: "https://ngrok.com/docs/getting-started/",
    authCommand: "ngrok config add-authtoken <your-token>",
    homepage: "https://ngrok.com"
  },
  {
    id: "doctl",
    name: "DigitalOcean CLI",
    command: "doctl",
    vendor: "DigitalOcean",
    description: "Manage Droplets, Apps, Kubernetes, and Spaces on DigitalOcean.",
    tags: ["digitalocean", "doctl", "do"],
    installCommand: "brew install doctl",
    installSource: "brew",
    authDocsUrl: "https://docs.digitalocean.com/reference/doctl/how-to/install/",
    authCommand: "doctl auth init",
    homepage: "https://www.digitalocean.com/products/tools"
  },
  // Guest agent harnesses — these two are what project_run drives inside the
  // user's local projects. They cannot ship bundled with the app (Claude Code
  // is proprietary; both self-update and carry per-user subscription auth),
  // so install-on-demand through this catalog IS the distribution story.
  {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    vendor: "Anthropic",
    description: "Anthropic\u2019s coding agent \u2014 runs your projects\u2019 slash commands and skills on your Claude subscription.",
    tags: ["claude", "claude code", "anthropic", "agent", "harness", "coding"],
    installCommand: "npm install -g @anthropic-ai/claude-code",
    installSource: "npm",
    authDocsUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
    authCommand: "claude auth login",
    // Verified live (claude 2.1.220): `claude auth status` exits 0 with JSON
    // {"loggedIn":true,...,"email":"..."}. Signed-out shape not exercised
    // (would require logging the user out) — pattern targets the documented
    // loggedIn:false field, and pattern-first classification covers an
    // exit-0 signed-out report, same trap class as gcloud.
    authProbe: { args: ["auth", "status"], signedOutPattern: '"loggedIn"\\s*:\\s*false', usernameCapture: '"email"\\s*:\\s*"([^"]+)"' },
    homepage: "https://www.anthropic.com/claude-code"
  },
  {
    id: "codex",
    name: "Codex CLI",
    command: "codex",
    vendor: "OpenAI",
    description: "OpenAI\u2019s coding agent \u2014 works in your projects on your ChatGPT subscription.",
    tags: ["codex", "openai", "chatgpt", "agent", "harness", "coding"],
    installCommand: "npm install -g @openai/codex",
    installSource: "npm",
    authDocsUrl: "https://developers.openai.com/codex/cli",
    authCommand: "codex login",
    // Verified live (codex-cli 0.144.3): `codex login status` exits 0 with
    // "Logged in using ChatGPT". Signed-out shape not exercised — the CLI
    // reports "Not logged in" per its own docs/help.
    authProbe: { args: ["login", "status"], signedOutPattern: "not logged in", usernameCapture: "Logged in using (\\S+)" },
    homepage: "https://developers.openai.com/codex"
  }
];

// src/integrations/cli-catalog/cli-executable-identity.ts
var import_node_path5 = __toESM(require("node:path"), 1);
function cliHealthExecutableIdentity(binaryPath, platform = process.platform) {
  if (!binaryPath || binaryPath !== binaryPath.trim() || /[\u0000-\u001f\u007f]/.test(binaryPath)) return null;
  if (platform === "win32") {
    const normalized = import_node_path5.default.win32.normalize(binaryPath);
    const fullyQualified = /^[A-Za-z]:\\/.test(normalized) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(normalized);
    return fullyQualified ? normalized.toLowerCase() : null;
  }
  return import_node_path5.default.posix.isAbsolute(binaryPath) ? binaryPath : null;
}

// src/integrations/cli-catalog/connected-cli-executable-selection.ts
var import_node_path6 = __toESM(require("node:path"), 1);
var import_node_fs6 = require("node:fs");

// src/integrations/cli-catalog/cli-connection-revision.ts
var import_node_crypto4 = require("node:crypto");
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function connectedCliRevision(value) {
  if (!record(value)) return null;
  if (Object.hasOwn(value, "connectionRevision")) {
    const revision = value.connectionRevision;
    return typeof revision === "string" && revision.length > 0 && revision.length <= 128 && !/[\u0000-\u0020\u007f]/.test(revision) ? revision : null;
  }
  return `legacy:${(0, import_node_crypto4.createHash)("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}
function cliHealthMatchesConnection(connected, health) {
  if (!record(connected) || !record(health) || !Object.hasOwn(connected, "id") || !Object.hasOwn(connected, "command") || !Object.hasOwn(health, "id") || !Object.hasOwn(health, "command") || typeof connected.id !== "string" || !connected.id || typeof connected.command !== "string" || !connected.command || connected.id !== health.id || connected.command !== health.command) return false;
  const revision = connectedCliRevision(connected);
  if (!revision) return false;
  return !Object.hasOwn(connected, "connectionRevision") && !Object.hasOwn(health, "connectionRevision") || health.connectionRevision === revision;
}

// src/integrations/cli-catalog/connected-cli-executable-selection.ts
function record2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function reviewedCliExecutablePathIsSupported(executablePath, platform = process.platform) {
  return platform !== "win32" || import_node_path6.default.win32.extname(executablePath).toLowerCase() === ".exe";
}
function reviewedCliExecutableFileIsSupported(input) {
  const platform = input.platform ?? process.platform;
  if (!input.isFile || !reviewedCliExecutablePathIsSupported(input.executablePath, platform)) return false;
  if (platform === "win32") return true;
  if (typeof input.mode === "number" && !Number.isInteger(input.mode)) return false;
  return (BigInt(input.mode) & 0o111n) !== 0n;
}
function selectConnectedCliExecutable(target, input) {
  const platform = input.platform ?? process.platform;
  if (input.forgotten.includes(target.id)) return { status: "blocked", reason: "forgotten" };
  if (!record2(input.connected)) return { status: "blocked", reason: "malformed_roster" };
  if (!Object.hasOwn(input.connected, target.id)) return { status: "unbound", reason: "not_connected" };
  const connected = input.connected[target.id];
  if (!record2(connected)) return { status: "blocked", reason: "malformed_roster" };
  if (!Object.hasOwn(connected, "id") || !Object.hasOwn(connected, "command") || connected.id !== target.id || connected.command !== target.command) {
    return { status: "blocked", reason: "roster_identity_mismatch" };
  }
  if (!record2(input.health)) return { status: "blocked", reason: "malformed_health" };
  if (!Object.hasOwn(input.health, target.id)) return { status: "unbound", reason: "not_observed" };
  const health = input.health[target.id];
  if (!record2(health)) return { status: "blocked", reason: "malformed_health" };
  if (!Object.hasOwn(health, "id") || !Object.hasOwn(health, "command") || health.id !== target.id || health.command !== target.command) {
    return { status: "blocked", reason: "health_identity_mismatch" };
  }
  if (!cliHealthMatchesConnection(connected, health)) {
    return { status: "blocked", reason: "connection_revision_mismatch" };
  }
  if (health.installed === false) return { status: "blocked", reason: "not_installed" };
  if (!Object.hasOwn(health, "installed") || health.installed !== true) return { status: "blocked", reason: "malformed_health" };
  const binary = Object.hasOwn(health, "binaryPath") && typeof health.binaryPath === "string" ? health.binaryPath : void 0;
  const identity = cliHealthExecutableIdentity(binary, platform);
  if (!binary || !identity) return { status: "blocked", reason: "missing_executable_identity" };
  if (!reviewedCliExecutablePathIsSupported(binary, platform)) {
    return { status: "blocked", reason: "unsupported_windows_launcher" };
  }
  return { status: "selected", executablePath: binary, executableIdentity: identity };
}
function readMetadata(file) {
  try {
    return JSON.parse((0, import_node_fs6.readFileSync)(file, "utf8"));
  } catch (error) {
    return error.code === "ENOENT" ? void 0 : null;
  }
}
function readConnectedCliExecutableSelection(target, options = {}) {
  const state = import_node_path6.default.join(options.baseDir ?? BASE_DIR, "state");
  const roster = readMetadata(import_node_path6.default.join(state, "connected-clis.json"));
  const health = readMetadata(import_node_path6.default.join(state, "cli-auth-health.json"));
  const validRoster = record2(roster) && roster.version === "v1" && Object.hasOwn(roster, "entries");
  const validHealth = record2(health) && health.version === "v1" && Object.hasOwn(health, "entries");
  const forgotten = validRoster && roster.forgotten !== void 0 ? roster.forgotten : [];
  if (!Array.isArray(forgotten) || !forgotten.every((id) => typeof id === "string")) {
    return { status: "blocked", reason: "malformed_roster" };
  }
  return selectConnectedCliExecutable(target, {
    connected: roster === void 0 ? {} : validRoster ? roster.entries : null,
    health: health === void 0 ? {} : validHealth ? health.entries : null,
    forgotten,
    platform: options.platform
  });
}

// src/runtime/atomic-json.ts
var import_node_async_hooks2 = require("node:async_hooks");
var heldFileLocks = new import_node_async_hooks2.AsyncLocalStorage();
var UUID_TOKEN_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
var OWNER_TOKEN_PATTERN = new RegExp(`^([1-9]\\d*):([1-9]\\d*)(?::(${UUID_TOKEN_PATTERN}))?$`, "i");

// src/runtime/harness/authority-argument-seal.ts
var import_node_crypto5 = require("node:crypto");
var import_node_fs7 = require("node:fs");
var import_node_path7 = __toESM(require("node:path"), 1);
var SEAL_VERSION = 2;
var AUTHORITY_ARGUMENT_MAX_PLAINTEXT_BYTES = SEALED_CALL_CANONICAL_LIMITS.maxTotalBytes;
var AUTHORITY_ARGUMENT_MAX_CIPHER_BYTES = Math.min(
  Math.ceil(AUTHORITY_ARGUMENT_MAX_PLAINTEXT_BYTES * 2) + 4096,
  // The durable lease column's CHECK (eventlog schema v75) is the outer wall.
  16777216
);
var AUTHORITY_SEAL_KEY_ID_V2 = "authority_seal_v2";
var AUTHORITY_SEAL_KEY_ID_V1 = "authority_seal_v1";
var VAULT_FILE = import_node_path7.default.join(BASE_DIR, "state", "secrets-vault.json");
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
  if (!(0, import_node_fs7.existsSync)(VAULT_FILE)) return void 0;
  try {
    const parsed = JSON.parse((0, import_node_fs7.readFileSync)(VAULT_FILE, "utf8"));
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
        const decipher = (0, import_node_crypto5.createDecipheriv)("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
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
  if (value.version !== REVIEWED_CLI_READ_CONFIG_VERSION || !boundedText(value.descriptorId) || !boundedText(value.operationId) || !boundedText(value.displayName) || typeof value.description !== "string" || value.description !== value.description.trim() || Buffer.byteLength(value.description, "utf8") > MAX_DESCRIPTION_BYTES || value.effect !== "read" || value.accountId !== REVIEWED_CLI_READ_ACCOUNT || !boundedText(value.executableRealpath, MAX_TOKEN_BYTES) || !import_node_path8.default.isAbsolute(value.executableRealpath) || import_node_path8.default.resolve(value.executableRealpath) !== value.executableRealpath || typeof value.binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.binarySha256) || !prefix || prefix.some((token) => !boundedText(token, MAX_TOKEN_BYTES)) || !argumentRows || !limits) return null;
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
  return import_node_path8.default.join(BASE_DIR, "state", "reviewed-cli-read-descriptors.json");
}
function listReviewedCliReadDescriptors(filePath = reviewedCliReadConfigPath()) {
  let raw;
  try {
    raw = (0, import_node_fs8.readFileSync)(filePath, "utf8");
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
  const hash = (0, import_node_crypto6.createHash)("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let position = 0;
  for (; ; ) {
    const count = (0, import_node_fs8.readSync)(fd, buffer, 0, buffer.length, position);
    if (count === 0) break;
    hash.update(buffer.subarray(0, count));
    position += count;
  }
  return hash.digest("hex");
}
function observeReviewedCliExecutable(executablePath) {
  if (!import_node_path8.default.isAbsolute(executablePath) || executablePath.includes("\0")) return null;
  let real;
  try {
    real = (0, import_node_fs8.realpathSync)(executablePath);
  } catch {
    return null;
  }
  let fd = -1;
  try {
    fd = (0, import_node_fs8.openSync)(real, "r");
    const before = (0, import_node_fs8.fstatSync)(fd, { bigint: true });
    if (!reviewedCliExecutableFileIsSupported({ executablePath: real, isFile: before.isFile(), mode: before.mode })) return null;
    const binarySha256 = hashOpenFile(fd);
    const after = (0, import_node_fs8.fstatSync)(fd, { bigint: true });
    const pathAfter = (0, import_node_fs8.realpathSync)(real);
    const pathStats = (0, import_node_fs8.statSync)(real, { bigint: true });
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
    if (fd >= 0) (0, import_node_fs8.closeSync)(fd);
  }
}
function reviewedCliDescriptorDigest(descriptor) {
  const closed = closeReviewedCliReadDescriptor(descriptor);
  if (!closed) throw new Error("reviewed CLI descriptor is invalid");
  return (0, import_node_crypto6.createHash)("sha256").update(closedCanonicalJson(closed, CLOSED_OPTIONS), "utf8").digest("hex");
}
function currentReviewedCliDescriptor(descriptor) {
  const closed = closeReviewedCliReadDescriptor(descriptor);
  if (!closed) return null;
  const catalog = CLI_CATALOG.find((entry) => catalogReviewedReadsOf(entry).some((contract) => contract.descriptorId === closed.descriptorId));
  const selection = catalog ? readConnectedCliExecutableSelection(catalog) : null;
  if (selection?.status === "blocked") return null;
  const selectedPathMatches = () => {
    if (selection?.status !== "selected") return true;
    try {
      const real = (0, import_node_fs8.realpathSync)(selection.executablePath);
      return reviewedCliExecutablePathIsSupported(real) && cliHealthExecutableIdentity(real) === cliHealthExecutableIdentity(closed.executableRealpath);
    } catch {
      return false;
    }
  };
  if (!selectedPathMatches()) return null;
  const executable = observeReviewedCliExecutable(closed.executableRealpath);
  if (!executable || executable.executableRealpath !== closed.executableRealpath || executable.binarySha256 !== closed.binarySha256) return null;
  if (catalog && (JSON.stringify(readConnectedCliExecutableSelection(catalog)) !== JSON.stringify(selection) || !selectedPathMatches())) return null;
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
  const definitionFingerprint = (0, import_node_crypto7.createHash)("sha256").update(closedCanonicalJson({
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
  const childEnv = mergedSpawnEnv();
  const before = observeReviewedCliExecutable(descriptor.executableRealpath);
  if (!before || before.binarySha256 !== descriptor.binarySha256) {
    throw new Error("reviewed CLI executable changed before dispatch");
  }
  const outcome = await new Promise((resolve, reject) => {
    (0, import_node_child_process2.execFile)(
      descriptor.executableRealpath,
      [...argv],
      {
        env: childEnv,
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
  return process.env.CLEMENTINE_HOME?.trim() || import_node_path9.default.join(import_node_os3.default.tmpdir(), "clem-isolated-transport");
}
function statePath() {
  return import_node_path9.default.join(homeDir(), "state", "attested-isolated-transport.json");
}
function loadState() {
  const file = statePath();
  if (!(0, import_node_fs9.existsSync)(file)) return { calls: [], creates: [], observations: {} };
  try {
    const parsed = JSON.parse((0, import_node_fs9.readFileSync)(file, "utf8"));
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
  (0, import_node_fs9.mkdirSync)(import_node_path9.default.dirname(statePath()), { recursive: true });
  (0, import_node_fs9.writeFileSync)(statePath(), `${JSON.stringify(state)}
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
  const record3 = result && typeof result === "object" ? result : {};
  const createdId = String(record3.spreadsheet_id ?? record3.spreadsheetId ?? record3.id ?? "").trim();
  if (createdId && (call.operationId.includes("SHEET_FROM_JSON") || call.operationId === "host_create")) {
    const handle = String(record3.spreadsheet_url ?? record3.handle ?? `https://docs.google.com/spreadsheets/d/${createdId}`);
    const receipt = String(record3.receipt ?? `receipt:${createdId}`);
    state.creates.push({
      artifactId: createdId,
      handle,
      accountId: call.accountId,
      operationId: call.operationId,
      contentDigest: (0, import_node_crypto8.createHash)("sha256").update(JSON.stringify(record3), "utf8").digest("hex"),
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
