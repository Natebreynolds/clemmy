var import_meta_url = require("node:url").pathToFileURL(__filename).href;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/runtime/harness/implementation-artifacts/observer-entry.ts
var observer_entry_exports = {};
__export(observer_entry_exports, {
  applyIndependentObserver: () => applyIndependentObserver,
  bindAttestedTransport: () => bindAttestedTransport,
  observeIndependently: () => observeIndependently
});
module.exports = __toCommonJS(observer_entry_exports);

// src/runtime/harness/implementation-artifacts/observer-impl.ts
var import_node_crypto = require("node:crypto");

// src/runtime/harness/implementation-artifacts/attested-transport.ts
var bound = null;
function bindAttestedTransport(transport) {
  bound = transport;
}
function requireAttestedTransport() {
  if (!bound) {
    throw new Error("attested provider transport is not bound");
  }
  return bound;
}

// src/runtime/harness/implementation-artifacts/observer-impl.ts
function observationIdOf(observation) {
  return `obs:${observation.operationId}:${observation.accountId}:${observation.observedAt}`;
}
function observedBytesDigestOf(observation) {
  return (0, import_node_crypto.createHash)("sha256").update(JSON.stringify({
    operationId: observation.operationId,
    accountId: observation.accountId,
    definitionFingerprint: observation.definitionFingerprint,
    providerVersion: observation.providerVersion,
    operationVersion: observation.operationVersion,
    observedAt: observation.observedAt
  }), "utf8").digest("hex");
}
function applyIndependentObserver(live, expected, observerImplementationId) {
  if (typeof live.operationId !== "string" || live.operationId !== expected.operationId || live.accountId !== expected.accountId || live.definitionFingerprint !== expected.definitionFingerprint || live.providerVersion !== expected.providerVersion || live.operationVersion !== expected.operationVersion || !Number.isFinite(live.observedAt) || live.observedAt <= 0) {
    return null;
  }
  return {
    operationId: live.operationId,
    accountId: live.accountId,
    definitionFingerprint: live.definitionFingerprint,
    providerVersion: live.providerVersion,
    operationVersion: live.operationVersion,
    observedAt: live.observedAt,
    origin: "independent",
    observationId: observationIdOf(live),
    observerImplementationId,
    observedBytesDigest: observedBytesDigestOf(live)
  };
}
function observeIndependently(expected, observerImplementationId) {
  const live = requireAttestedTransport().observe({
    operationId: expected.operationId,
    accountId: expected.accountId
  });
  if (!live) return null;
  return applyIndependentObserver(live, expected, observerImplementationId);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyIndependentObserver,
  bindAttestedTransport,
  observeIndependently
});
