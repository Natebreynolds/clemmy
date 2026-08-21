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
var import_node_crypto = require("node:crypto");
var import_node_module = require("node:module");
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"), 1);
var import_node_url = require("node:url");
var PROVIDER_VERSION = "composio-tool-router-v1";
function here() {
  return typeof import_meta_url === "string" ? (0, import_node_url.fileURLToPath)(import_meta_url) : (0, import_node_url.fileURLToPath)(import_meta_url);
}
function findPackageRoot(startFile) {
  let dir = import_node_path.default.dirname(startFile);
  for (let i = 0; i < 12; i += 1) {
    const candidate = import_node_path.default.join(dir, "package.json");
    if ((0, import_node_fs.existsSync)(candidate)) {
      try {
        const pkg = JSON.parse((0, import_node_fs.readFileSync)(candidate, "utf8"));
        if (pkg.name === "clemmy") return dir;
      } catch {
      }
    }
    const parent = import_node_path.default.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("attested transport could not resolve the clemmy package root");
}
function loadComposioClient() {
  const root = findPackageRoot(here());
  const req = (0, import_node_module.createRequire)(import_node_path.default.join(root, "package.json"));
  const distClient = import_node_path.default.join(root, "dist", "integrations", "composio", "client.js");
  if ((0, import_node_fs.existsSync)(distClient)) {
    return req(distClient);
  }
  throw new Error("attested transport could not resolve the packaged provider client");
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
  const client = loadComposioClient();
  if (!client.isComposioEnabled()) {
    throw new Error(`${call.operationId} transport unavailable`);
  }
  return client.executeComposioTool(call.operationId, call.args, call.accountId);
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
    const client = loadComposioClient();
    if (!client.isComposioEnabled()) return null;
    const accountId = resolveConnectedAccount(client, input);
    if (!accountId) return null;
    const tool = await client.getComposioToolBySlug(input.operationId);
    if (!tool || tool.slug !== input.operationId || tool.inputParameters === void 0) return null;
    const observedAt = client.composioToolSchemaObservedAt(tool);
    if (typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt <= 0) return null;
    const definitionFingerprint = (0, import_node_crypto.createHash)("sha256").update(JSON.stringify({ slug: tool.slug, inputParameters: tool.inputParameters }), "utf8").digest("hex");
    const observation = {
      operationId: input.operationId,
      accountId,
      definitionFingerprint,
      providerVersion: PROVIDER_VERSION,
      operationVersion: definitionFingerprint.slice(0, 16),
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
