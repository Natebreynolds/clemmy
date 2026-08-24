/**
 * Production edge adapters for the provider-neutral automation pilot
 * acquisition port. Carrier selection is explicit configuration supplied by a
 * trusted host surface; the control plane never discovers or guesses it.
 */
import { createHash } from 'node:crypto';

import type { AutomationReadPilotCapabilityAcquisitionPortV1 } from './automation-read-pilot-control-plane.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import { discoverMcpServers } from '../runtime/mcp-config.js';
import { configuredProductionLiveReadAcquisitionPort } from '../runtime/harness/production-live-read-acquisition-registry.js';

const ACQUISITION_REF_PREFIX = 'pilot-acquisition:live-read-registry:';
const ACQUISITION_REF_TTL_MS = 10 * 60 * 1_000;
const ACQUISITION_REF_RE = /^pilot-acquisition:live-read-registry:([1-9][0-9]{0,15}):([a-f0-9]{64})$/;
const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;

export interface AutomationReadPilotAcquisitionScopeV1 {
  sessionId: string;
  sourceUserSeq: number;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  phaseId: string;
  requirementId: string;
  requirementDigest: string;
}

export interface ConfiguredReadPilotAcquisitionV1 {
  acquisitionRef: string;
  carrierKind: 'live_read_registry';
  label: string;
  description: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Host-issued reference for the exact current configured carrier registry.
 * The digest covers every connection/configuration byte (including secret
 * values), the accepted source, and the exact proposal requirement. The public
 * projection exposes none of those secret bytes. A credential, registry,
 * source, or requirement change therefore spends the old reference.
 */
function exactScope(scope: AutomationReadPilotAcquisitionScopeV1): AutomationReadPilotAcquisitionScopeV1 {
  if (!SOURCE_ID_RE.test(scope.sessionId)
    || !Number.isSafeInteger(scope.sourceUserSeq)
    || scope.sourceUserSeq < 1
    || !SOURCE_ID_RE.test(scope.proposalId)
    || !Number.isSafeInteger(scope.proposalRevision)
    || scope.proposalRevision < 1
    || !/^[a-f0-9]{64}$/.test(scope.proposalDigest)
    || !SOURCE_ID_RE.test(scope.phaseId)
    || !SOURCE_ID_RE.test(scope.requirementId)
    || !/^[a-f0-9]{64}$/.test(scope.requirementDigest)) {
    throw new TypeError('configured acquisition scope is incomplete');
  }
  return { ...scope };
}

function exactIssuedAtMs(nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 1) {
    throw new TypeError('configured acquisition issuance time is invalid');
  }
  return nowMs;
}

function configuredAcquisitionRow(
  scopeInput: AutomationReadPilotAcquisitionScopeV1,
  issuedAtMs: number,
): {
  acquisition: ConfiguredReadPilotAcquisitionV1;
} | null {
  const scope = exactScope(scopeInput);
  const serverBytes = discoverMcpServers()
    .filter((server) => server.enabled)
    .map((server) => closedCanonicalJson({
      name: server.name,
      type: server.type,
      enabled: true,
      ...(server.command !== undefined ? { command: server.command } : {}),
      ...(server.args !== undefined ? { args: server.args } : {}),
      ...(server.url !== undefined ? { url: server.url } : {}),
      ...(server.headers !== undefined ? { headers: server.headers } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
    }, {
      maxDepth: 12,
      maxNodes: 50_000,
      maxStringBytes: 1_048_576,
      maxTotalBytes: 4_194_304,
    }))
    .sort();
  if (serverBytes.length === 0) return null;
  const identityBytes = closedCanonicalJson({
    domain: 'configured-live-read-registry-acquisition',
    version: 1,
    issuedAtMs,
    scope,
    configuredCarrierBytes: serverBytes,
  }, {
    maxDepth: 12,
    maxNodes: 50_000,
    maxStringBytes: 1_048_576,
    maxTotalBytes: 4_194_304,
  });
  return {
    acquisition: {
      acquisitionRef: `${ACQUISITION_REF_PREFIX}${issuedAtMs}:${sha256(identityBytes)}`,
      carrierKind: 'live_read_registry',
      label: 'Configured live read registry',
      description: 'All currently configured live read carriers; exact-one selection is registry-owned.',
    },
  };
}

/** Exact current host-issued choices. Configuration order has no meaning. */
export function listConfiguredReadPilotAcquisitions(
  scope: AutomationReadPilotAcquisitionScopeV1,
  nowMs = Date.now(),
): ConfiguredReadPilotAcquisitionV1[] {
  const issuedAtMs = exactIssuedAtMs(nowMs);
  const row = configuredAcquisitionRow(scope, issuedAtMs);
  return row ? [{ ...row.acquisition }] : [];
}

export type ResolveConfiguredReadPilotAcquisitionResult =
  | { ok: true; acquisition: AutomationReadPilotCapabilityAcquisitionPortV1 }
  | { ok: false; code: 'acquisition_ref_invalid' | 'acquisition_ref_expired' | 'acquisition_ref_stale'; reason: string };

/**
 * Resolve only a host-issued reference against the current trusted inventory.
 * The caller never supplies or guesses a server name, and a stale reference
 * cannot fall back to another configured carrier.
 */
export function resolveConfiguredReadPilotAcquisition(
  acquisitionRef: string,
  scope: AutomationReadPilotAcquisitionScopeV1,
  nowMs = Date.now(),
): ResolveConfiguredReadPilotAcquisitionResult {
  const parsed = ACQUISITION_REF_RE.exec(acquisitionRef);
  if (!parsed) {
    return { ok: false, code: 'acquisition_ref_invalid', reason: 'The acquisition reference is malformed.' };
  }
  const issuedAtMs = Number(parsed[1]);
  if (!Number.isSafeInteger(issuedAtMs)) {
    return { ok: false, code: 'acquisition_ref_invalid', reason: 'The acquisition reference timestamp is invalid.' };
  }
  const currentMs = exactIssuedAtMs(nowMs);
  if (issuedAtMs > currentMs || currentMs - issuedAtMs > ACQUISITION_REF_TTL_MS) {
    return {
      ok: false,
      code: 'acquisition_ref_expired',
      reason: 'The host-issued acquisition reference has expired.',
    };
  }
  let current: ReturnType<typeof configuredAcquisitionRow>;
  try {
    current = configuredAcquisitionRow(scope, issuedAtMs);
  } catch (error) {
    return {
      ok: false,
      code: 'acquisition_ref_invalid',
      reason: error instanceof Error ? error.message : 'The acquisition scope is invalid.',
    };
  }
  if (!current || current.acquisition.acquisitionRef !== acquisitionRef) {
    return {
      ok: false,
      code: 'acquisition_ref_stale',
      reason: 'The host-issued acquisition reference is absent from the exact current configuration.',
    };
  }
  return {
    ok: true,
    acquisition: configuredProductionLiveReadAcquisitionPort(),
  };
}
