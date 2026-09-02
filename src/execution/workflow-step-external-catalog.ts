import {
  revalidateSelectedComposioDefinitions,
  type RevalidatedComposioDefinition,
  type SelectedComposioDefinition,
  type SelectedComposioRevalidationResult,
} from '../integrations/composio/selected-definition-revalidation.js';
import {
  isRegisteredToolkitSlug,
  registeredToolkitOfSlug,
} from '../integrations/composio/toolkit-slug.js';
import { currentCapabilityManifest } from '../runtime/harness/capability-manifest.js';
import {
  peekCapabilityManifestStore,
  type CapabilityManifestStore,
  type InstalledCapabilityManifest,
} from '../runtime/harness/capability-manifest-store.js';
import {
  canonicalCatalogIdentityOf,
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
  type CanonicalCatalogIdentityV1,
  type HostCapabilityCatalogFactory,
} from '../runtime/harness/host-capability-catalog-factory.js';
import {
  compareAndSetIndependentCapabilityObservation,
  peekIndependentCapabilityObservation,
  registerIndependentCapabilityObservation,
} from '../runtime/harness/independent-capability-observation.js';
import {
  refreshTypedExecutionReadiness,
  typedExecutionCatalogReady,
} from '../runtime/semantic-boundary/configure-typed-execution-runtime.js';
import {
  provisionExactWorkflowProviderOperations,
  type ExactWorkflowProviderProvisionResult,
} from '../tools/tool-search-provider-sources.js';

const MAX_EXACT_WORKFLOW_OPERATIONS = 32;
const EXPLICIT_EXTERNAL_OPERATION = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/g;
const EXACT_EXTERNAL_OPERATION = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}$/;

export type WorkflowStepExternalCatalogPreparation =
  | { status: 'none' }
  | {
      status: 'ready';
      manifestIds: readonly string[];
      operationIds: readonly string[];
      catalogIdentities: readonly CanonicalCatalogIdentityV1[];
    }
  | {
      status: 'refused';
      reason:
        | 'too_many_explicit_operations'
        | 'ambiguous_current_manifest'
        | 'exact_operation_provisioning_refused'
        | 'exact_operation_manifest_missing_after_provision'
        | 'selected_definition_revalidation_refused'
        | 'selected_definition_observation_refused'
        | 'typed_catalog_not_ready'
        | 'callable_identity_missing_or_changed';
      operationId?: string;
      detail?: string;
    };

export interface WorkflowStepExternalCatalogDependencies {
  manifestStore?: CapabilityManifestStore | null;
  catalogFactory?: HostCapabilityCatalogFactory | null;
  revalidate?: (
    selections: readonly SelectedComposioDefinition[],
  ) => Promise<SelectedComposioRevalidationResult>;
  refresh?: (manifestIds: readonly string[]) => void;
  ready?: (manifestIds: readonly string[]) => boolean;
  provisionExactOperations?: (input: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedInput: string;
    operationIds: readonly string[];
    deadlineAt?: number;
  }) => Promise<ExactWorkflowProviderProvisionResult>;
}

const DIRECT_OPERATION_PROHIBITION_RE = new RegExp([
  String.raw`\b(?:do\s+not|don['’]?t|dont|must\s+not|should\s+not|cannot|can['’]?t|never)`
    + String.raw`\s+(?:ever\s+)?(?:call|use|invoke|run|execute)`
    + String.raw`(?:\s+(?:the\s+)?(?:following|exact|operation|action|tool))?\s*:?\s*$`,
  String.raw`\b(?:without|never|avoid|excluding)\s*$`,
].join('|'), 'i');

function operationOccurrenceIsOnlyProhibited(text: string, start: number): boolean {
  let clauseStart = 0;
  for (let index = Math.min(start, text.length) - 1; index >= 0; index -= 1) {
    if (/[.!?;\n—–]/.test(text[index]!)) {
      clauseStart = index + 1;
      break;
    }
  }
  const prefix = text.slice(clauseStart, start);
  // A nearby negation is not enough: long workflow constraints often prohibit
  // one fallback and then explain the exact operation that remains available.
  // Exclude only when the negator directly governs call/use/invoke/run/execute
  // of this token, or the token immediately follows without/never/avoid.
  return DIRECT_OPERATION_PROHIBITION_RE.test(prefix);
}

function explicitOperationTokens(input: {
  immutablePrompt: string;
  allowedTools: readonly string[];
}): Set<string> {
  const tokens = new Set<string>();
  const promptOccurrences = new Map<string, { positive: boolean; prohibited: boolean }>();
  for (const match of input.immutablePrompt.matchAll(EXPLICIT_EXTERNAL_OPERATION)) {
    if (match[0].length > 128) continue;
    const token = match[0].toUpperCase();
    const prohibited = operationOccurrenceIsOnlyProhibited(
      input.immutablePrompt,
      match.index ?? 0,
    );
    const prior = promptOccurrences.get(token) ?? { positive: false, prohibited: false };
    promptOccurrences.set(token, {
      positive: prior.positive || !prohibited,
      prohibited: prior.prohibited || prohibited,
    });
    if (!prohibited) tokens.add(token);
  }
  for (const raw of input.allowedTools) {
    const value = raw.trim();
    // An allowedTools entry is a provider operation only when the AUTHOR
    // wrote it as one (uppercase slug). A lowercase local tool name such as
    // composio_search_tools is Clementine's own tool; uppercasing it minted a
    // phantom COMPOSIO_SEARCH_TOOLS "operation" that parked
    // scorpion-facebook-trends on a capability block (2026-09-01).
    if (!EXACT_EXTERNAL_OPERATION.test(value)) continue;
    const normalized = value.toUpperCase();
    const occurrence = promptOccurrences.get(normalized);
    if (!(occurrence?.prohibited && !occurrence.positive)) tokens.add(normalized);
  }
  return tokens;
}

function currentComposioManifestRows(
  store: CapabilityManifestStore | null | undefined,
): InstalledCapabilityManifest[] {
  return (store?.list() ?? []).filter((entry) => {
    const current = currentCapabilityManifest(entry.manifest);
    return Boolean(
      current
      && current.providerKind === 'composio'
      && current.externalDefinition
      && current.operationId.trim(),
    );
  });
}

function selectionFromManifest(entry: InstalledCapabilityManifest): SelectedComposioDefinition {
  const manifest = entry.manifest;
  const external = manifest.externalDefinition!;
  return {
    identifier: manifest.operationId,
    schemaDigest: external.providerInputSchemaDigest,
    accountIdentity: manifest.accountId,
    definitionFingerprint: manifest.definitionFingerprint,
    providerOperationVersion: manifest.operationVersion,
    invokePortId: manifest.invokePortId,
    ...(external.providerOutputSchemaObserved === true
      ? { outputSchemaDigest: external.providerOutputSchemaDigest ?? null }
      : {}),
    ...(external.verification
      ? { verificationContract: external.verification }
      : {}),
    ...(manifest.operationSemantics
      ? { operationSemantics: manifest.operationSemantics }
      : {}),
  };
}

/**
 * Publish the exact provider bytes just revalidated above as the independent
 * observation consumed by typed-catalog readiness. This is not a manifest
 * echo: every identity-bearing field is first compared with the provider
 * definition returned by revalidation, and publication happens only after the
 * complete selected set has passed that provider boundary.
 *
 * A cold process intentionally has no in-memory observation even though the
 * durable manifest is current. Discarding the revalidation result here made
 * the immediately-following scoped refresh refuse every such workflow with
 * `typed_catalog_not_ready`.
 */
function publishRevalidatedObservation(
  entry: InstalledCapabilityManifest,
  definition: RevalidatedComposioDefinition | undefined,
): boolean {
  const manifest = entry.manifest;
  const external = manifest.externalDefinition;
  if (
    !definition
    || !external
    || definition.identifier !== manifest.operationId
    || definition.accountIdentity !== manifest.accountId
    || definition.schemaDigest !== external.providerInputSchemaDigest
    || definition.providerOperationVersion !== manifest.operationVersion
    || definition.invokePortId !== manifest.invokePortId
    || definition.definitionFingerprint !== manifest.definitionFingerprint
    || (definition.outputSchemaDigest ?? null)
      !== (external.providerOutputSchemaDigest ?? null)
  ) return false;

  const observedAt = Date.now();
  const observation = {
    operationId: definition.identifier,
    accountId: definition.accountIdentity,
    definitionFingerprint: definition.definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: definition.providerOperationVersion,
    observedAt,
    origin: 'independent' as const,
    // Revalidation just read these exact provider-owned bytes. Replay that
    // bounded observation instant to the synchronous crossing; do not restamp
    // it on read, or one workflow run could manufacture perpetual freshness.
    observe: () => ({
      operationId: definition.identifier,
      accountId: definition.accountIdentity,
      definitionFingerprint: definition.definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: definition.providerOperationVersion,
      observedAt,
    }),
  };
  const registered = registerIndependentCapabilityObservation(observation);
  if (registered.ok) return true;
  if (registered.reason !== 'identity_exists') return false;
  const prior = peekIndependentCapabilityObservation(
    manifest.operationId,
    manifest.accountId,
  );
  return Boolean(
    prior
    && compareAndSetIndependentCapabilityObservation({
      expected: prior,
      next: observation,
    }).ok,
  );
}

/**
 * Pre-model workflow gate for direct provider operations explicitly authored
 * into an immutable step. Durable manifests identify the exact account and
 * prior schema; provider revalidation proves those bytes are still current,
 * and a scoped catalog refresh reconstructs the exact callable ports after a
 * process restart.
 *
 * Prompt data and model output never select an operation here. Tokens count
 * only when their longest prefix is a registered Composio namespace; missing
 * definitions are then acquired by exact slug and source-bound proof. The
 * returned manifest ids later narrow (never widen) the accepted-source
 * planning/frozen catalog.
 */
export async function prepareWorkflowStepExternalCatalog(input: {
  immutablePrompt: string;
  allowedTools: readonly string[];
  acceptedSource?: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedInput: string;
  };
  deadlineAt?: number;
}, dependencies: WorkflowStepExternalCatalogDependencies = {}): Promise<WorkflowStepExternalCatalogPreparation> {
  let store = dependencies.manifestStore === undefined
    ? peekCapabilityManifestStore()
    : dependencies.manifestStore;
  const tokens = explicitOperationTokens(input);
  const operationIds = [...tokens].filter((token) => {
    const toolkit = registeredToolkitOfSlug(token).trim().toLowerCase();
    // The platform plane (COMPOSIO_SEARCH_TOOLS, COMPOSIO_*) is discovery and
    // control, never a business operation a workflow step provisions.
    if (toolkit === 'composio') return false;
    return isRegisteredToolkitSlug(toolkit)
      && token.startsWith(`${toolkit.toUpperCase()}_`);
  }).sort();
  if (operationIds.length === 0) return { status: 'none' };
  if (operationIds.length > MAX_EXACT_WORKFLOW_OPERATIONS) {
    return { status: 'refused', reason: 'too_many_explicit_operations' };
  }
  let currentRows = currentComposioManifestRows(store);
  const rowsByOperation = (): Map<string, InstalledCapabilityManifest[]> => {
    const rows = new Map<string, InstalledCapabilityManifest[]>();
    for (const entry of currentRows) {
      const key = entry.manifest.operationId.toUpperCase();
      if (!operationIds.includes(key)) continue;
      rows.set(key, [...(rows.get(key) ?? []), entry]);
    }
    return rows;
  };
  let byOperation = rowsByOperation();
  for (const operationId of operationIds) {
    const rows = byOperation.get(operationId) ?? [];
    if (rows.length > 1) {
      return { status: 'refused', reason: 'ambiguous_current_manifest', operationId };
    }
  }

  const missingOperationIds = operationIds.filter((operationId) => (
    (byOperation.get(operationId) ?? []).length === 0
  ));
  if (missingOperationIds.length > 0) {
    if (!input.acceptedSource) {
      return {
        status: 'refused',
        reason: 'exact_operation_provisioning_refused',
        operationId: missingOperationIds[0],
        detail: 'accepted_source_missing_or_changed',
      };
    }
    const provisioned = await (
      dependencies.provisionExactOperations ?? provisionExactWorkflowProviderOperations
    )({
      ...input.acceptedSource,
      operationIds: missingOperationIds,
      ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    });
    if (!provisioned.ok) {
      return {
        status: 'refused',
        reason: 'exact_operation_provisioning_refused',
        operationId: provisioned.identifier,
        detail: [
          provisioned.code,
          provisioned.detail,
          provisioned.choices?.join(','),
        ].filter(Boolean).join(':'),
      };
    }
    if (dependencies.manifestStore === undefined) store = peekCapabilityManifestStore();
    currentRows = currentComposioManifestRows(store);
    byOperation = rowsByOperation();
  }

  const selected: InstalledCapabilityManifest[] = [];
  for (const operationId of operationIds) {
    const rows = byOperation.get(operationId) ?? [];
    if (rows.length > 1) {
      return { status: 'refused', reason: 'ambiguous_current_manifest', operationId };
    }
    if (rows.length === 0) {
      return {
        status: 'refused',
        reason: 'exact_operation_manifest_missing_after_provision',
        operationId,
      };
    }
    selected.push(rows[0]!);
  }

  if (selected.length > 0) {
    const revalidate = dependencies.revalidate ?? revalidateSelectedComposioDefinitions;
    let revalidated = await revalidate(selected.map(selectionFromManifest));
    if (!revalidated.ok) {
      return {
        status: 'refused',
        reason: 'selected_definition_revalidation_refused',
        operationId: revalidated.refusal.identifier,
        detail: revalidated.refusal.code,
      };
    }
    // A label-only operation-version move (revalidation: `reboundFrom`) means
    // the durable manifest names a label the provider no longer reports for
    // the same definition. Route it through exact provisioning, which installs
    // the live definition as the recorded successor of the stored manifest,
    // then select and revalidate the successor. Comparing the live definition
    // against the stale manifest instead refused every workflow naming the
    // operation as "not connected" forever (daily-standup, 2026-09-02).
    const reboundOperationIds = selected
      .filter((entry) => revalidated.ok
        && revalidated.definitions.get(entry.manifest.operationId.toLowerCase())?.reboundFrom)
      .map((entry) => entry.manifest.operationId);
    if (reboundOperationIds.length > 0) {
      if (!input.acceptedSource) {
        return {
          status: 'refused',
          reason: 'exact_operation_provisioning_refused',
          operationId: reboundOperationIds[0],
          detail: 'operation_version_rebind_requires_accepted_source',
        };
      }
      const reprovisioned = await (
        dependencies.provisionExactOperations ?? provisionExactWorkflowProviderOperations
      )({
        ...input.acceptedSource,
        operationIds: reboundOperationIds,
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      });
      if (!reprovisioned.ok) {
        return {
          status: 'refused',
          reason: 'exact_operation_provisioning_refused',
          operationId: reprovisioned.identifier,
          detail: ['operation_version_rebind', reprovisioned.code, reprovisioned.detail].filter(Boolean).join(':'),
        };
      }
      if (dependencies.manifestStore === undefined) store = peekCapabilityManifestStore();
      currentRows = currentComposioManifestRows(store);
      byOperation = rowsByOperation();
      for (const operationId of reboundOperationIds) {
        const rows = byOperation.get(operationId) ?? [];
        if (rows.length !== 1) {
          return {
            status: 'refused',
            reason: rows.length === 0
              ? 'exact_operation_manifest_missing_after_provision'
              : 'ambiguous_current_manifest',
            operationId,
          };
        }
        const index = selected.findIndex((entry) => entry.manifest.operationId === operationId);
        if (index >= 0) selected[index] = rows[0]!;
      }
      revalidated = await revalidate(selected.map(selectionFromManifest));
      if (!revalidated.ok) {
        return {
          status: 'refused',
          reason: 'selected_definition_revalidation_refused',
          operationId: revalidated.refusal.identifier,
          detail: revalidated.refusal.code,
        };
      }
    }
    for (const entry of selected) {
      if (!publishRevalidatedObservation(
        entry,
        revalidated.definitions.get(entry.manifest.operationId.toLowerCase()),
      )) {
        return {
          status: 'refused',
          reason: 'selected_definition_observation_refused',
          operationId: entry.manifest.operationId,
        };
      }
    }
  }

  const manifestIds = selected.map((entry) => entry.manifest.manifestId).sort();
  if (manifestIds.length > 0) {
    (dependencies.refresh ?? refreshTypedExecutionReadiness)(manifestIds);
    if (!(dependencies.ready ?? typedExecutionCatalogReady)(manifestIds)) {
      return { status: 'refused', reason: 'typed_catalog_not_ready' };
    }
  }

  const factory = dependencies.catalogFactory === undefined
    ? peekHostCapabilityCatalogFactory()
    : dependencies.catalogFactory;
  const catalogIdentities: CanonicalCatalogIdentityV1[] = [];
  for (const entry of selected) {
    const callable = factory?.get(entry.manifest.manifestId);
    const identity = callable ? canonicalCatalogIdentityOf(callable) : null;
    if (
      !callable
      || !isCurrentCallableCatalogEntry(callable)
      || !identity
      || callable.manifestDigest !== entry.digest
      || callable.manifest?.operationId !== entry.manifest.operationId
      || callable.manifest.accountId !== entry.manifest.accountId
      || callable.manifest.definitionFingerprint !== entry.manifest.definitionFingerprint
      || callable.manifest.invokePortId !== entry.manifest.invokePortId
    ) {
      return {
        status: 'refused',
        reason: 'callable_identity_missing_or_changed',
        operationId: entry.manifest.operationId,
      };
    }
    catalogIdentities.push(identity);
  }

  return {
    status: 'ready',
    manifestIds,
    operationIds,
    catalogIdentities: catalogIdentities.sort((left, right) => (
      left.manifestId.localeCompare(right.manifestId)
      || left.capabilityId.localeCompare(right.capabilityId)
    )),
  };
}
