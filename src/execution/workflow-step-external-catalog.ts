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
import pino from 'pino';
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
  typedExecutionCatalogRefusals,
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
  /** Route an ambiguous operation to the account the run's ORIGIN source
   * already established (the same host policy a chat turn uses). Returns the
   * connection id, or null when the origin established nothing. */
  routeOriginAccount?: (input: {
    sessionId: string;
    sourceUserSeq: number;
    toolkit: string;
    operation: string;
  }) => Promise<string | null>;
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

const logger = pino({ name: 'clementine-next.workflow-step-external-catalog' });

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
/**
 * REVALIDATION AND PUBLISH MUST AGREE ABOUT A MOVED LABEL.
 *
 * A label-only operation-version move is one revalidation already PROVED
 * benign: it recomputed the definition fingerprint under the old label, found
 * it identical, and recorded the old values in `reboundFrom` while returning
 * ok. Publish then compared the new label against the stored manifest and
 * refused — sanctioning the move in one comparison and rejecting it in the
 * next, a deadlock no amount of re-provisioning can break.
 *
 * Live 2026-09-18: daily-standup-email rebound both of its calendar and mail
 * operations (driftOperationIds empty, so label-only), then refused
 * with `operation_version` against a manifest still holding the pre-move
 * label. It had blocked every morning since 2026-09-16 on exactly this.
 *
 * So the stored manifest matches when it holds EITHER the live label or the
 * label revalidation recorded as the one that moved. Nothing else is widened:
 * a move revalidation did not sanction has no `reboundFrom` and still refuses.
 */
function versionAccepted(
  definition: RevalidatedComposioDefinition,
  manifest: InstalledCapabilityManifest['manifest'],
): boolean {
  return definition.providerOperationVersion === manifest.operationVersion
    || definition.reboundFrom?.providerOperationVersion === manifest.operationVersion;
}

/** The same agreement for the fingerprint that moved with the label. */
function fingerprintAccepted(
  definition: RevalidatedComposioDefinition,
  manifest: InstalledCapabilityManifest['manifest'],
): boolean {
  return definition.definitionFingerprint === manifest.definitionFingerprint
    || definition.reboundFrom?.definitionFingerprint === manifest.definitionFingerprint;
}

/** Returns null when the observation published, or the NAME of the first field
 *  that disagreed. The name reaches the refusal so a live block is diagnosable
 *  from its own message instead of by inspection. */
function publishRevalidatedObservation(
  entry: InstalledCapabilityManifest,
  definition: RevalidatedComposioDefinition | undefined,
): string | null {
  const manifest = entry.manifest;
  const external = manifest.externalDefinition;
  // NAME THE FIELD THAT MOVED.
  //
  // This returned a bare boolean, so a refusal could say only that the
  // observation failed — never which of eight fields disagreed. The caller
  // then reported "either the toolkit is not connected or the operation name
  // is wrong", and diagnosing a live block meant guessing. A comparison that
  // knows why must say why.
  const mismatch = !definition ? 'definition_absent'
    : !external ? 'manifest_has_no_external_definition'
    : definition.identifier !== manifest.operationId ? 'identifier'
    : definition.accountIdentity !== manifest.accountId ? 'account_identity'
    : definition.schemaDigest !== external.providerInputSchemaDigest ? 'input_schema_digest'
    : !versionAccepted(definition, manifest) ? 'operation_version'
    : definition.invokePortId !== manifest.invokePortId ? 'invoke_port_id'
    : !fingerprintAccepted(definition, manifest) ? 'definition_fingerprint'
    : (definition.outputSchemaDigest ?? null) !== (external.providerOutputSchemaDigest ?? null)
      ? 'output_schema_digest'
      : null;
  if (mismatch) return mismatch;
  // Redundant after the chain above; narrows for the compiler.
  if (!definition || !external) return 'definition_absent';

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
  if (registered.ok) return null;
  if (registered.reason !== 'identity_exists') return `observation_register:${registered.reason}`;
  const prior = peekIndependentCapabilityObservation(
    manifest.operationId,
    manifest.accountId,
  );
  const settled = Boolean(
    prior
    && compareAndSetIndependentCapabilityObservation({
      expected: prior,
      next: observation,
    }).ok,
  );
  return settled ? null : 'observation_compare_and_set_lost';
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
/** Revalidation refusals that mean "the provider changed this operation's
 * definition", which the successor path settles by provisioning the live
 * definition — as opposed to a connection or identity refusal it cannot. */
function isSelectedDefinitionDriftCode(code: string): boolean {
  return code === 'selected_definition_schema_drift'
    || code === 'selected_definition_output_schema_drift'
    || code === 'selected_definition_fingerprint_drift'
    || code === 'selected_definition_operation_version_drift'
    || code === 'selected_definition_semantic_contract_drift';
}

/**
 * The account the run's origin source already routes to for this toolkit,
 * by the host's own source-account policy (remembered read default,
 * established route for the principal). Chat resolved the calendar read to
 * one of three Outlook connections without asking; a workflow authored from
 * that same conversation should not park on "which account?" for the same
 * operation (live 2026-09-22, "Invite digest" creation test).
 */
async function routeOriginAccountByHostPolicy(input: {
  sessionId: string;
  sourceUserSeq: number;
  toolkit: string;
  operation: string;
}): Promise<string | null> {
  try {
    const [{ resolveSourceAccountRouting }, { listUsableConnectedToolkits }] = await Promise.all([
      import('../tools/source-account-routing.js'),
      import('../integrations/composio/client.js'),
    ]);
    const routed = await resolveSourceAccountRouting({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      toolkit: input.toolkit,
      operation: input.operation,
      connections: await listUsableConnectedToolkits(),
      effect: 'read',
    });
    return routed.kind === 'resolved' ? routed.connection.connectionId : null;
  } catch {
    return null;
  }
}

export async function prepareWorkflowStepExternalCatalog(input: {
  immutablePrompt: string;
  allowedTools: readonly string[];
  acceptedSource?: {
    sessionId: string;
    sourceUserSeq: number;
    acceptedInput: string;
  };
  /** The chat source this run was authored or dispatched from, when there
   * is one. Its established account routing disambiguates a multi-account
   * operation the step does not name. */
  originSource?: {
    sessionId: string;
    sourceUserSeq: number;
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
  // Two current manifests for one operation are two ACCOUNTS (two Outlook
  // connections, 2026-09-02). The workflow names its account the same way the
  // exact provisioner resolves one — a connection id written verbatim in the
  // immutable prompt or the accepted input — so honor that name here instead
  // of refusing as ambiguous. No name, or a name matching none: still ambiguous.
  const namedAccountTokens = new Set([
    ...(input.immutablePrompt.match(/[A-Za-z0-9_-]+/g) ?? []),
    ...((input.acceptedSource?.acceptedInput ?? '').match(/[A-Za-z0-9_-]+/g) ?? []),
  ]);
  // An operation with several current accounts and no name in the step: ask
  // the run's origin source which account it already routes to. One lookup
  // per ambiguous operation, before either provisioning pass.
  if (input.originSource) {
    const routeOrigin = dependencies.routeOriginAccount ?? routeOriginAccountByHostPolicy;
    const seenOperations = new Set<string>();
    for (const entry of currentRows) {
      const key = entry.manifest.operationId.toUpperCase();
      if (!operationIds.includes(key) || seenOperations.has(key)) continue;
      const siblings = currentRows.filter((row) => row.manifest.operationId.toUpperCase() === key);
      if (siblings.length < 2 || siblings.some((row) => namedAccountTokens.has(row.manifest.accountId))) continue;
      seenOperations.add(key);
      const routed = await routeOrigin({
        sessionId: input.originSource.sessionId,
        sourceUserSeq: input.originSource.sourceUserSeq,
        toolkit: registeredToolkitOfSlug(key).trim().toLowerCase(),
        operation: key,
      });
      if (routed && siblings.some((row) => row.manifest.accountId === routed)) namedAccountTokens.add(routed);
    }
  }
  const rowsByOperation = (): Map<string, InstalledCapabilityManifest[]> => {
    const rows = new Map<string, InstalledCapabilityManifest[]>();
    for (const entry of currentRows) {
      const key = entry.manifest.operationId.toUpperCase();
      if (!operationIds.includes(key)) continue;
      rows.set(key, [...(rows.get(key) ?? []), entry]);
    }
    for (const [key, entries] of rows) {
      if (entries.length < 2) continue;
      const named = entries.filter((entry) => namedAccountTokens.has(entry.manifest.accountId));
      if (named.length === 1) rows.set(key, named);
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
    // A DEFINITION DRIFT (input/output schema, fingerprint, or a non-label
    // operation-version move) means the provider changed the operation the
    // stored manifest describes. That is not a missing connection: the live
    // definition is provisioned as the stored manifest's recorded successor
    // and the successor is what gets revalidated — the same successor path a
    // label-only move takes. Refusing here labeled Facebook trends' Apify scrape
    // "not connected" on every run while Apify was connected (2026-09-02).
    const driftOperationIds = !revalidated.ok && isSelectedDefinitionDriftCode(revalidated.refusal.code)
      ? [revalidated.refusal.identifier]
      : [];
    if (!revalidated.ok && driftOperationIds.length === 0) {
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
    const reboundOperationIds = [...new Set([
      ...selected
        .filter((entry) => revalidated.ok
          && revalidated.definitions.get(entry.manifest.operationId.toLowerCase())?.reboundFrom)
        .map((entry) => entry.manifest.operationId),
      ...driftOperationIds,
    ])];
    if (reboundOperationIds.length > 0) {
      // This path has now failed in production twice (2026-09-02, 2026-09-16)
      // with no record of what it decided. Say it once per preparation.
      logger.info({
        reboundOperationIds,
        driftOperationIds,
        hasAcceptedSource: Boolean(input.acceptedSource),
      }, 'external catalog rebinding a moved provider definition');
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
        logger.warn({
          operationId: reprovisioned.identifier,
          code: reprovisioned.code,
          detail: reprovisioned.detail,
        }, 'external catalog rebind provisioning refused');
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
    if (!revalidated.ok) {
      // Unreachable by construction (a drift always enters the successor block
      // above, which revalidates again and returns on refusal); kept as the
      // typed refusal rather than a cast.
      return {
        status: 'refused',
        reason: 'selected_definition_revalidation_refused',
        operationId: revalidated.refusal.identifier,
        detail: revalidated.refusal.code,
      };
    }
    // A PUBLISH-TIME MISMATCH IS DRIFT TOO.
    //
    // Revalidation and this publish compare the SAME live definition against
    // the SAME stored manifest, but across different field sets: publish also
    // checks `invokePortId` and `accountIdentity`, for which revalidation has
    // no drift code. So when either of those moved, revalidation returned ok,
    // publish disagreed, and the run took a terminal refusal with no successor
    // path — parked forever waiting for a capability that was present the
    // whole time.
    //
    // That is the 2026-09-02 failure recorded above, one comparison later:
    // daily-standup-email blocked every morning from 2026-09-16 on
    // its calendar-list operation while that toolkit was connected, the
    // operation was live,
    // and its pinned connection id was still valid. Route the mismatch into the
    // same exact-provisioning successor path a revalidation drift takes, once.
    const firstPass = revalidated;
    const unpublished = selected
      .map((entry) => ({
        entry,
        mismatch: publishRevalidatedObservation(
          entry,
          firstPass.definitions.get(entry.manifest.operationId.toLowerCase()),
        ),
      }))
      .filter((row): row is { entry: typeof row.entry; mismatch: string } => row.mismatch !== null);
    if (unpublished.length > 0) {
      const retryable = unpublished
        .map((row) => row.entry.manifest.operationId)
        .filter((operationId) => !reboundOperationIds.includes(operationId));
      // Already re-provisioned once, or there is no accepted source to
      // provision against — the mismatch is real and terminal.
      // One attempt, never a loop.
      if (retryable.length === 0 || !input.acceptedSource) {
        logger.warn({
          operationId: unpublished[0]!.entry.manifest.operationId,
          mismatch: unpublished[0]!.mismatch,
          alreadyRebound: reboundOperationIds,
          hasAcceptedSource: Boolean(input.acceptedSource),
          manifestOperationVersion: unpublished[0]!.entry.manifest.operationVersion,
        }, 'external catalog observation mismatch has no remaining repair');
        return {
          status: 'refused',
          reason: 'selected_definition_observation_refused',
          operationId: unpublished[0]!.entry.manifest.operationId,
          detail: unpublished[0]!.mismatch,
        };
      }
      const republished = await (
        dependencies.provisionExactOperations ?? provisionExactWorkflowProviderOperations
      )({
        ...input.acceptedSource,
        operationIds: retryable,
        ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      });
      if (!republished.ok) {
        return {
          status: 'refused',
          reason: 'exact_operation_provisioning_refused',
          operationId: republished.identifier,
          detail: ['observation_mismatch_rebind', republished.code, republished.detail].filter(Boolean).join(':'),
        };
      }
      if (dependencies.manifestStore === undefined) store = peekCapabilityManifestStore();
      currentRows = currentComposioManifestRows(store);
      byOperation = rowsByOperation();
      for (const operationId of retryable) {
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
      const secondPass = await revalidate(selected.map(selectionFromManifest));
      if (!secondPass.ok) {
        return {
          status: 'refused',
          reason: 'selected_definition_revalidation_refused',
          operationId: secondPass.refusal.identifier,
          detail: secondPass.refusal.code,
        };
      }
      revalidated = secondPass;
      for (const entry of selected) {
        const mismatch = publishRevalidatedObservation(
          entry,
          secondPass.definitions.get(entry.manifest.operationId.toLowerCase()),
        );
        if (mismatch) {
          return {
            status: 'refused',
            reason: 'selected_definition_observation_refused',
            operationId: entry.manifest.operationId,
            detail: `after_rebind:${mismatch}`,
          };
        }
      }
    }
  }

  const manifestIds = selected.map((entry) => entry.manifest.manifestId).sort();
  if (manifestIds.length > 0) {
    (dependencies.refresh ?? refreshTypedExecutionReadiness)(manifestIds);
    if (!(dependencies.ready ?? typedExecutionCatalogReady)(manifestIds)) {
      // The readiness evaluator records WHY each manifest was refused; this
      // returned only that it was not ready, so a live block again could not be
      // diagnosed from its own message. Carry the scoped reasons out.
      let detail: string | undefined;
      try {
        const scoped = new Set(manifestIds);
        const refusals = typedExecutionCatalogRefusals()
          .filter((refusal) => refusal.manifestId === '*' || scoped.has(refusal.manifestId));
        if (refusals.length > 0) {
          detail = [...new Set(refusals.map((refusal) => refusal.reason))].sort().join(',');
          logger.warn({ manifestIds, refusals }, 'typed execution catalog refused the selected manifests');
        }
      } catch { /* a refusal ledger that cannot be read names no reason */ }
      return { status: 'refused', reason: 'typed_catalog_not_ready', ...(detail ? { detail } : {}) };
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
