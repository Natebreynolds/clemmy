/**
 * Exact native-MCP execution carrier for an accepted foreground call.
 *
 * Tool metadata is discovery input only.  Once the host accepts a call, this
 * module reopens the host-minted capability binding and the immutable
 * manifest/catalog/port tuple.  No server lookup, tools/list result, scope, or
 * model-authored name can select a provider body at this edge.
 */
import type { ToolCallsCounter } from './brackets.js';
import {
  currentLogicalCall,
  withPhysicalDispatch,
  withPhysicalPreparationDispatch,
} from './attempt-identity.js';
import { settleToolAttempt } from './attempt-settlement.js';
import {
  currentHostCallAttestation,
  type HostCallAttestation,
} from './accepted-turn-call-authority.js';
import {
  hostCallCapabilityBindingMatchesAttestation,
  loadHostCallCapabilityBinding,
} from './host-call-capability-binding.js';
import { openEventLog } from './eventlog.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import { peekCapabilityManifestStore } from './capability-manifest-store.js';
import {
  canonicalCatalogIdentityOf,
  peekHostCapabilityCatalogFactory,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import {
  resolveProductionPortsForManifest,
  type ProductionCapabilityPort,
} from './production-capability-ports.js';
import { physicalSourceCapabilityIdentityFromCatalog } from './source-strategy-admission.js';
import { consumeNestedCallAdmission } from './nested-tool-approval-admission.js';
import { ExternalWritePreDispatchError } from './external-write-admission.js';
import { PhysicalDispatchPreDispatchError } from './attempt-identity.js';
import { loadToolContract, type ToolContract } from '../../tools/tool-contract-store.js';
import { stripMcpToolCarrier } from '../mcp-tool-authority.js';
import { currentLiveReadPlanningDefinitionFromEntry } from './live-read-planning-authority.js';

export class ExactMcpCarrierPreDispatchError extends ExternalWritePreDispatchError {
  override readonly name = 'ExactMcpCarrierPreDispatchError';

  constructor(readonly reason: string) {
    super(`Exact native MCP dispatch refused before provider I/O: ${reason}`);
  }
}

export interface AcceptedExactMcpCarrierBinding {
  operationId: string;
  inputSchema: Readonly<Record<string, unknown>>;
  manifest: CapabilityManifestV1;
  catalogEntry: RegisteredHostCapability;
  port: ProductionCapabilityPort;
  attestation: Readonly<HostCallAttestation>;
}

export type AcceptedExactMcpCarrierResolution =
  | { ok: true; binding: AcceptedExactMcpCarrierBinding }
  | { ok: false; reason: string };

function refused(reason: string): AcceptedExactMcpCarrierResolution {
  return { ok: false, reason };
}

function exactContractFor(
  operationId: string,
  manifest: CapabilityManifestV1,
  catalogEntry: RegisteredHostCapability,
): ToolContract | null {
  const contract = loadToolContract(operationId);
  if (
    !contract
    || contract.identifier !== operationId
    || contract.providerAuthorityConflictAt !== undefined
    || contract.providerObservedFingerprint !== contract.fingerprint
    || !catalogEntry.sourceSchemaFingerprint
    || contract.fingerprint !== catalogEntry.sourceSchemaFingerprint
    || (contract.providerOperationVersion !== undefined
      && contract.providerOperationVersion !== manifest.operationVersion)
  ) return null;
  return contract;
}

/**
 * Read-only exact binding resolution.  It never enumerates MCP metadata and it
 * never falls back to an operation-name/catalog-wide search.
 */
export function resolveAcceptedExactMcpCarrier(
  requestedOperationId: string,
): AcceptedExactMcpCarrierResolution {
  try {
    const operationId = stripMcpToolCarrier(requestedOperationId);
    if (!operationId || operationId !== requestedOperationId.trim().replace(/^mcp__/i, '')) {
      return refused('the requested operation identity is malformed');
    }
    const attestation = currentHostCallAttestation();
    if (!attestation || attestation.bindingKind !== 'catalog_manifest') {
      return refused('the accepted call has no exact catalog-manifest attestation');
    }
    const logical = currentLogicalCall();
    if (
      !logical
      || logical.acceptedTaskId !== attestation.acceptedTaskId
      || logical.logicalToolCallId !== attestation.logicalToolCallId
      || attestation.operationId !== operationId
    ) return refused('the accepted logical call does not own this exact operation');

    const durable = loadHostCallCapabilityBinding({
      db: openEventLog(),
      sessionId: attestation.sessionId,
      sourceUserSeq: attestation.sourceUserSeq,
      logicalToolCallId: attestation.logicalToolCallId,
    });
    if (
      durable.status !== 'ok'
      || !hostCallCapabilityBindingMatchesAttestation(durable.binding, attestation)
      || durable.binding.operationId !== operationId
    ) return refused('the durable host capability binding is missing or conflicts');

    const stored = peekCapabilityManifestStore()?.get(attestation.manifestId);
    const manifest = currentCapabilityManifest(stored?.manifest);
    if (
      !stored
      || !manifest
      || manifest.providerKind !== 'native_mcp'
      || stored.digest !== attestation.manifestDigest
      || capabilityManifestDigest(manifest) !== attestation.manifestDigest
      || manifest.manifestId !== attestation.manifestId
      || manifest.operationId !== operationId
      || manifest.definitionFingerprint !== attestation.schemaFingerprint
      || manifest.accountId !== attestation.accountId
      || manifest.invokePortId !== attestation.invokePortId
      || manifest.effect !== attestation.effect
      || !manifest.externalDefinition
      || manifest.externalDefinition.providerInputSchemaDigest
        !== attestation.providerInputSchemaDigest
    ) return refused('the exact native MCP manifest is absent, stale, or mismatched');

    // capabilityId is the manifest id for production materialized externals.
    // Resolve by that opaque id only; never scan the catalog by tool name.
    const catalogEntry = peekHostCapabilityCatalogFactory()?.get(attestation.capabilityId);
    const canonical = catalogEntry ? canonicalCatalogIdentityOf(catalogEntry) : null;
    if (
      !catalogEntry
      || !canonical
      || canonical.capabilityId !== attestation.capabilityId
      || canonical.manifestId !== manifest.manifestId
      || canonical.manifestDigest !== attestation.manifestDigest
      || canonical.operationId !== operationId
      || canonical.schemaVersion !== manifest.operationVersion
      || canonical.schemaDigest !== manifest.definitionFingerprint
      || canonical.providerKind !== 'native_mcp'
      || canonical.providerVersion !== manifest.providerVersion
      || canonical.providerInputSchemaDigest
        !== manifest.externalDefinition.providerInputSchemaDigest
      || canonical.liveFingerprint !== manifest.definitionFingerprint
      || canonical.account !== manifest.accountId
      || canonical.effect !== manifest.effect
      || canonical.invokePortId !== manifest.invokePortId
      || canonical.argumentCompiler.id !== manifest.argumentCompiler.id
      || canonical.argumentCompiler.version !== manifest.argumentCompiler.version
    ) return refused('the exact catalog identity is absent or drifted');

    const currentDefinition = currentLiveReadPlanningDefinitionFromEntry(catalogEntry);
    if (
      !currentDefinition
      || currentDefinition.providerInputSchemaDigest
        !== manifest.externalDefinition.providerInputSchemaDigest
      || currentDefinition.providerInputSchemaDigest !== attestation.providerInputSchemaDigest
      || currentDefinition.definitionFingerprint !== manifest.definitionFingerprint
      || currentDefinition.providerOperationVersion !== manifest.operationVersion
      || currentDefinition.providerOutputSchemaDigest
        !== (manifest.externalDefinition.providerOutputSchemaDigest ?? null)
      || currentDefinition.invokePortId !== manifest.invokePortId
    ) return refused('the exact current provider definition is absent or drifted');

    const port = resolveProductionPortsForManifest(manifest);
    if (
      !port?.invoke
      || catalogEntry.invoke !== port.invoke
      || typeof port.admitPreparation !== 'function'
      || typeof port.prepareInvocation !== 'function'
      || typeof port.invokeWithPreparation !== 'function'
    ) {
      return refused('the exact immutable registered invoke port is absent');
    }
    const contract = exactContractFor(operationId, manifest, catalogEntry);
    if (!contract) return refused('the exact provider-observed input schema is absent or conflicted');
    // Closed local configuration/account/port identity is checked before a
    // physical preparation row. No provider I/O occurs here.
    port.admitPreparation();

    return {
      ok: true,
      binding: {
        operationId,
        inputSchema: Object.freeze(structuredClone(contract.schema)),
        manifest,
        catalogEntry,
        port,
        attestation,
      },
    };
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Redeem one host-prepared nested admission and execute the exact registered
 * native-MCP port.  Every mismatch above and every missing/consumed admission
 * fails before a physical row and before the provider body.
 */
export async function invokeAcceptedExactMcpCarrier(input: {
  requestedOperationId: string;
  args: unknown;
  sessionId: string;
  counter: ToolCallsCounter;
  /** work_call owns a separate one-shot nested hand-off. A direct call_tool is
   * already the host-attested logical call and therefore needs no second token. */
  requiresNestedAdmission: boolean;
}): Promise<unknown> {
  const resolved = resolveAcceptedExactMcpCarrier(input.requestedOperationId);
  if (!resolved.ok) throw new ExactMcpCarrierPreDispatchError(resolved.reason);
  const { manifest, catalogEntry, port, attestation, operationId } = resolved.binding;
  const args = input.args && typeof input.args === 'object' && !Array.isArray(input.args)
    ? input.args as Record<string, unknown>
    : {};
  // A turn-budget checkpoint is not an execution attempt. Check it before the
  // one-shot nested admission CAS so an auto-resume can retain that authority.
  // ToolCallsCounter is synchronous; no await can interleave this check with
  // the later increment in this process.
  if (input.counter.willExceed()) {
    const { ToolCallsLimitExceeded } = await import('./brackets.js');
    throw new ToolCallsLimitExceeded(input.counter.limit);
  }
  if (input.sessionId !== attestation.sessionId) {
    throw new ExactMcpCarrierPreDispatchError('the carrier session conflicts with the accepted binding');
  }
  if (
    input.requiresNestedAdmission
    && !consumeNestedCallAdmission({
      sessionId: input.sessionId,
      toolName: operationId,
      args,
    })
  ) {
    throw new ExactMcpCarrierPreDispatchError(
      'the exact accepted work/consent admission is missing, consumed, or mismatched',
    );
  }
  input.counter.increment();

  const sourceCapability = physicalSourceCapabilityIdentityFromCatalog({
    manifest,
    ...(catalogEntry.sourceSchemaFingerprint
      ? { sourceSchemaFingerprint: catalogEntry.sourceSchemaFingerprint }
      : {}),
  });
  const mutating = manifest.effect === 'local_write'
    || manifest.effect === 'external_write'
    || manifest.effect === 'admin';
  let result: unknown;
  try {
    // A fresh tools/list is provider I/O. Account and settle it independently,
    // then hand its process-opaque exact observation proof to one business call.
    const prepared = await withPhysicalPreparationDispatch({
      sessionId: attestation.sessionId,
      sourceUserSeq: attestation.sourceUserSeq,
      tool: operationId,
      args,
      ...(sourceCapability ? { sourceCapability } : {}),
    }, () => port.prepareInvocation!());
    result = await withPhysicalDispatch({
      sessionId: attestation.sessionId,
      sourceUserSeq: attestation.sourceUserSeq,
      tool: operationId,
      args,
      ...(sourceCapability ? { sourceCapability } : {}),
    }, () => port.invokeWithPreparation!(prepared, () => port.invoke({
        nodeId: attestation.logicalToolCallId,
        role: 'foreground',
        payload: args,
        identity: {
          sessionId: attestation.sessionId,
          sourceUserSeq: attestation.sourceUserSeq,
          acceptedTaskId: attestation.acceptedTaskId,
        },
        binding: {
          capabilityId: manifest.manifestId,
          toolName: operationId,
          schemaVersion: manifest.operationVersion,
          schemaDigest: manifest.definitionFingerprint,
          args,
          account: manifest.accountId,
          effect: manifest.effect,
          ...(manifest.destination ? { destination: manifest.destination } : {}),
          manifestDigest: attestation.manifestDigest,
          providerKind: 'native_mcp',
          liveFingerprint: manifest.definitionFingerprint,
          manifest,
          invoke: port.invoke,
        },
      })));
  } catch (error) {
    if (error instanceof PhysicalDispatchPreDispatchError) {
      throw new ExactMcpCarrierPreDispatchError(error.message);
    }
    settleToolAttempt({
      sessionId: attestation.sessionId,
      sourceUserSeq: attestation.sourceUserSeq,
      lane: 'native_mcp',
      toolName: operationId,
      callId: attestation.logicalToolCallId,
      args,
      mutating,
      businessCall: true,
      thrown: error,
    });
    throw error;
  }
  settleToolAttempt({
    sessionId: attestation.sessionId,
    sourceUserSeq: attestation.sourceUserSeq,
    lane: 'native_mcp',
    toolName: operationId,
    callId: attestation.logicalToolCallId,
    args,
    mutating,
    businessCall: true,
    result,
    signals: { envelopeSuccessful: true },
  });
  return result;
}
