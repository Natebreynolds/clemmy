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
  reconcileAttestedTransport: () => reconcileAttestedTransport,
  refreshAttestedTransportObservation: () => refreshAttestedTransportObservation,
  registerIsolatedObservation: () => registerIsolatedObservation
});
module.exports = __toCommonJS(transport_isolated_entry_exports);
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var isolatedHandler = null;
var observations = /* @__PURE__ */ new Map();
function homeDir() {
  return process.env.CLEMENTINE_HOME?.trim() || import_node_path.default.join(import_node_os.default.tmpdir(), "clem-isolated-transport");
}
function statePath() {
  return import_node_path.default.join(homeDir(), "state", "attested-isolated-transport.json");
}
function loadState() {
  const file = statePath();
  if (!(0, import_node_fs.existsSync)(file)) return { calls: [], creates: [], observations: {} };
  try {
    const parsed = JSON.parse((0, import_node_fs.readFileSync)(file, "utf8"));
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
  (0, import_node_fs.mkdirSync)(import_node_path.default.dirname(statePath()), { recursive: true });
  (0, import_node_fs.writeFileSync)(statePath(), `${JSON.stringify(state)}
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
function isolatedTransportCalls() {
  return [...loadState().calls];
}
async function executeAttestedTransport(call) {
  const state = loadState();
  state.calls.push(call);
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
      contentDigest: (0, import_node_crypto.createHash)("sha256").update(JSON.stringify(record), "utf8").digest("hex"),
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
  reconcileAttestedTransport,
  refreshAttestedTransportObservation,
  registerIsolatedObservation
});
