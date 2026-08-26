/**
 * Post-terminal redemption for an authoritative readback that already ran for
 * an accepted source.
 *
 * This module never opens a logical call and never invokes a provider.  The
 * host/graph execution owner must already have settled the exact readback.  We
 * re-open that source-owned binding, revalidate the current manifest/catalog/
 * account/port/independent observation tuple, and redeem only the settlement-
 * named bytes.  A background verifier therefore cannot turn a closed source
 * into new execution authority.
 */
import { getTurnGraphEventForSource, openEventLog } from './eventlog.js';
import { turnGraphFromShadowEvent } from '../graph/turn-graph-shadow.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import { peekCapabilityManifestStore } from './capability-manifest-store.js';
import {
  canonicalCatalogIdentityOf,
  loadSealedNodeBinding,
  peekHostCapabilityCatalogFactory,
  type SealedNodeBinding,
} from './host-capability-catalog-factory.js';
import {
  independentlyObserveCapability,
  observationIsFresh,
} from './independent-capability-observation.js';
import { resolveProductionPortsForManifest } from './production-capability-ports.js';
import { loadHostCallCapabilityBinding } from './host-call-capability-binding.js';
import { redeemAuthoritativeResultPayload } from './result-handle.js';

export type AcceptedSourceReadbackRedemption =
  | { status: 'ok'; payload: unknown; physicalDispatchId: string }
  | { status: 'unavailable'; reason: string };

interface ExactReadbackBinding {
  capabilityId: string;
  manifestId: string;
  manifestDigest: string;
  operationId: string;
  operationVersion: string;
  schemaDigest: string;
  providerInputSchemaDigest?: string;
  accountId: string;
  invokePortId: string;
}

function exactCurrentReadbackManifest(binding: ExactReadbackBinding): CapabilityManifestV1 | null {
  const stored = peekCapabilityManifestStore()?.get(binding.manifestId);
  const manifest = currentCapabilityManifest(stored?.manifest);
  if (
    !stored
    || !manifest
    || stored.digest !== binding.manifestDigest
    || capabilityManifestDigest(manifest) !== binding.manifestDigest
    || manifest.manifestId !== binding.manifestId
    || manifest.operationId !== binding.operationId
    || manifest.operationVersion !== binding.operationVersion
    || manifest.definitionFingerprint !== binding.schemaDigest
    || manifest.accountId !== binding.accountId
    || manifest.invokePortId !== binding.invokePortId
    || manifest.effect !== 'read'
    || manifest.purpose !== 'verify_created_resource'
    || !manifest.acceptedInputKinds.includes('created_resource')
  ) return null;
  if (
    binding.providerInputSchemaDigest !== undefined
    && manifest.externalDefinition?.providerInputSchemaDigest !== binding.providerInputSchemaDigest
  ) return null;

  // Resolve by the opaque capability id only.  No operation-name scan or
  // catalog-wide fallback may choose the executable identity here.
  const entry = peekHostCapabilityCatalogFactory()?.get(binding.capabilityId);
  const live = entry ? canonicalCatalogIdentityOf(entry) : null;
  if (
    !entry
    || !live
    || live.capabilityId !== binding.capabilityId
    || live.manifestId !== binding.manifestId
    || live.manifestDigest !== binding.manifestDigest
    || live.operationId !== binding.operationId
    || live.schemaVersion !== binding.operationVersion
    || live.schemaDigest !== binding.schemaDigest
    || live.providerVersion !== manifest.providerVersion
    || live.liveFingerprint !== binding.schemaDigest
    || live.account !== binding.accountId
    || live.effect !== 'read'
    || live.invokePortId !== binding.invokePortId
    || (binding.providerInputSchemaDigest !== undefined
      && live.providerInputSchemaDigest !== binding.providerInputSchemaDigest)
  ) return null;
  const port = resolveProductionPortsForManifest(manifest);
  if (!port?.invoke || entry.invoke !== port.invoke) return null;
  const observation = independentlyObserveCapability(binding.operationId, binding.accountId);
  if (
    !observation
    || observation.origin !== 'independent'
    || !observationIsFresh(observation)
    || observation.operationId !== binding.operationId
    || observation.operationVersion !== binding.operationVersion
    || observation.providerVersion !== manifest.providerVersion
    || observation.definitionFingerprint !== binding.schemaDigest
    || observation.accountId !== binding.accountId
  ) return null;
  return manifest;
}

function resourceIdFromPayload(payload: unknown): string | null {
  const queue: unknown[] = [payload];
  const seen = new Set<object>();
  for (let depth = 0; depth < 5 && queue.length > 0; depth += 1) {
    const width = queue.length;
    for (let index = 0; index < width; index += 1) {
      const value = queue.shift();
      if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) continue;
      seen.add(value);
      const record = value as Record<string, unknown>;
      for (const key of ['id', 'spreadsheetId', 'spreadsheet_id'] as const) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      }
      // Only unwrap known result envelopes. Arbitrary deep object search would
      // allow unrelated record ids to masquerade as the artifact identity.
      for (const key of ['data', 'result', 'output', 'response'] as const) {
        if (record[key] && typeof record[key] === 'object') queue.push(record[key]);
      }
    }
  }
  return null;
}

function redeemMatchingSettlement(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  resourceId: string;
}): AcceptedSourceReadbackRedemption | null {
  const acceptedTaskId = `task:${input.sessionId}#${input.sourceUserSeq}`;
  const redeemed = redeemAuthoritativeResultPayload({
    kind: 'successful_settlement',
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId: input.logicalToolCallId,
  });
  if (redeemed.status !== 'ok' || !redeemed.value.physicalDispatchId) return null;
  if (resourceIdFromPayload(redeemed.value.rawPayload) !== input.resourceId) return null;
  return {
    status: 'ok',
    payload: redeemed.value.rawPayload,
    physicalDispatchId: redeemed.value.physicalDispatchId,
  };
}

function graphBindingMatches(
  sealed: SealedNodeBinding,
  capabilityId: string,
): ExactReadbackBinding | null {
  if (
    sealed.capabilityId !== capabilityId
    || sealed.effect !== 'read'
    || !sealed.account
  ) return null;
  const entry = peekHostCapabilityCatalogFactory()?.get(capabilityId);
  const live = entry ? canonicalCatalogIdentityOf(entry) : null;
  if (
    !live
    || live.capabilityId !== sealed.capabilityId
    || live.operationId !== sealed.providerOperationId
    || live.schemaVersion !== sealed.schemaVersion
    || live.schemaDigest !== sealed.schemaDigest
    || live.account !== sealed.account
    || live.effect !== sealed.effect
    || (sealed.providerInputSchemaDigest !== undefined
      && live.providerInputSchemaDigest !== sealed.providerInputSchemaDigest)
  ) return null;
  return {
    capabilityId: live.capabilityId,
    manifestId: live.manifestId,
    manifestDigest: live.manifestDigest,
    operationId: live.operationId,
    operationVersion: live.schemaVersion,
    schemaDigest: live.schemaDigest,
    ...(live.providerInputSchemaDigest
      ? { providerInputSchemaDigest: live.providerInputSchemaDigest }
      : {}),
    accountId: live.account,
    invokePortId: live.invokePortId,
  };
}

/**
 * Redeem one previously executed, exact source-owned readback. Missing source
 * identity, missing settlement, ambiguity, or any live drift is unavailable
 * before provider I/O. This function contains no invoke seam by design.
 */
export function redeemAcceptedSourceReadback(input: {
  sessionId: string;
  sourceUserSeq: number;
  resourceId: string;
}): AcceptedSourceReadbackRedemption {
  if (
    !input.sessionId.trim()
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || !input.resourceId.trim()
  ) return { status: 'unavailable', reason: 'originating accepted source identity is missing' };

  const matches = new Map<string, AcceptedSourceReadbackRedemption & { status: 'ok' }>();
  const remember = (candidate: AcceptedSourceReadbackRedemption | null): void => {
    if (candidate?.status === 'ok') matches.set(candidate.physicalDispatchId, candidate);
  };

  // Host-owned accepted calls persist the exact catalog-manifest attestation.
  // Enumerating rows within this one accepted source is recovery only; each
  // candidate still reopens by logical id and resolves by opaque capability id.
  try {
    const db = openEventLog();
    const rows = db.prepare(`
      SELECT logical_tool_call_id
        FROM host_call_capability_bindings
       WHERE session_id = ? AND source_user_seq = ?
         AND effect = 'read' AND binding_kind = 'catalog_manifest'
       ORDER BY logical_tool_call_id
    `).all(input.sessionId, input.sourceUserSeq) as Array<{ logical_tool_call_id: string }>;
    for (const row of rows) {
      const loaded = loadHostCallCapabilityBinding({
        db,
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        logicalToolCallId: row.logical_tool_call_id,
      });
      if (loaded.status !== 'ok') continue;
      const binding = loaded.binding;
      if (!exactCurrentReadbackManifest({
        capabilityId: binding.capabilityId,
        manifestId: binding.manifestId,
        manifestDigest: binding.manifestDigest,
        operationId: binding.operationId,
        operationVersion: peekHostCapabilityCatalogFactory()?.get(binding.capabilityId)?.schemaVersion ?? '',
        schemaDigest: binding.schemaFingerprint,
        ...(binding.providerInputSchemaDigest
          ? { providerInputSchemaDigest: binding.providerInputSchemaDigest }
          : {}),
        accountId: binding.accountId,
        invokePortId: binding.invokePortId,
      })) continue;
      remember(redeemMatchingSettlement({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        logicalToolCallId: binding.logicalToolCallId,
        resourceId: input.resourceId,
      }));
    }
  } catch {
    return { status: 'unavailable', reason: 'accepted-source host readback authority is unreadable' };
  }

  // Typed graph execution persists a sealed node binding rather than a host
  // call attestation. The immutable graph selects only explicit readback nodes.
  const graph = turnGraphFromShadowEvent(
    getTurnGraphEventForSource(input.sessionId, input.sourceUserSeq),
  );
  if (graph) {
    for (const node of graph.nodes) {
      if (node.kind !== 'retrieve' || node.capabilityRole !== 'readback') continue;
      const exactNames = node.capabilities
        .filter((requirement) => requirement.kind === 'tool' && requirement.resolution === 'explicit')
        .flatMap((requirement) => requirement.names ?? []);
      if (exactNames.length !== 1) continue;
      const sealed = loadSealedNodeBinding(input.sessionId, input.sourceUserSeq, node.id);
      if (!sealed) continue;
      const binding = graphBindingMatches(sealed, exactNames[0]!);
      if (!binding || !exactCurrentReadbackManifest(binding)) continue;
      remember(redeemMatchingSettlement({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        logicalToolCallId: `logical:${node.id}`,
        resourceId: input.resourceId,
      }));
    }
  }

  if (matches.size !== 1) {
    return {
      status: 'unavailable',
      reason: matches.size === 0
        ? 'originating accepted source has no exact settled readback for this resource'
        : 'originating accepted source has ambiguous settled readbacks for this resource',
    };
  }
  return matches.values().next().value!;
}
