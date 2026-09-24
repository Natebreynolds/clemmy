import { createHash } from 'node:crypto';
import { liveReadCompletenessEvidencePaths } from '../runtime/harness/reviewed-cli-read-config.js';

import {
  createWorkflowNodeInvocationPlan,
  type WorkflowNodeArgumentBindingV1,
  type WorkflowNodeInvocationEffectV1,
  type WorkflowNodeInvocationPlanV1,
  type WorkflowNodeInvocationValueTypeV1,
} from '../memory/workflow-node-invocation-plan.js';
import { currentCapabilityManifest, type CapabilityManifestV1 } from '../runtime/harness/capability-manifest.js';
import { peekCapabilityManifestStore } from '../runtime/harness/capability-manifest-store.js';
import {
  canonicalCatalogIdentityOf,
  peekHostCapabilityCatalogFactory,
  type CanonicalCatalogIdentityV1,
  type HostCapabilityCatalogFactory,
} from '../runtime/harness/host-capability-catalog-factory.js';
import { peekProductionCapabilityAdapter } from '../runtime/harness/production-capability-adapter.js';
import { workflowCapabilityDigest } from './workflow-capability-digest.js';

const EXACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/+\-]{0,255}$/;

/** Normalize caller-owned labels into the exact identity alphabet accepted by
 * the durable workflow activation tables. */

/** The engine's own "nothing can run this operation" diagnostic. It names an
 *  operation id, so a person-facing report shows its own sentence instead;
 *  readers recognise it here rather than re-spelling the text. */
export const CAPABILITY_NOT_REGISTERED_PREFIX = 'No current capability is registered for';
export function isCapabilityNotRegisteredMessage(message: string | undefined | null): boolean {
  return typeof message === 'string' && message.startsWith(CAPABILITY_NOT_REGISTERED_PREFIX);
}

export function exactWorkflowCallIdOrDigest(value: string): string {
  const trimmed = value.trim();
  if (EXACT_ID_RE.test(trimmed)) return trimmed;
  return `sha:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 40)}`;
}

function runtimeValueType(value: unknown): WorkflowNodeInvocationValueTypeV1 | null {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (value !== null && typeof value === 'object') return 'object';
  return null;
}

const PLAN_EFFECTS = new Set<WorkflowNodeInvocationEffectV1>([
  'read', 'compute', 'host_only', 'local_write', 'external_write', 'admin',
]);

export type LiveCallExpectedEffect = 'read' | 'write' | 'send';

/**
 * The only account identity a blocked workflow may offer to a human. Labels,
 * provider ordering, and remembered account names are deliberately excluded:
 * resumption binds the exact current capability + account pair.
 */
export interface WorkflowCapabilityAccountCandidateV1 {
  capabilityId: string;
  accountId: string;
}

export interface WorkflowCapabilityAccountChoiceSetV1 {
  candidates: readonly WorkflowCapabilityAccountCandidateV1[];
  /** Digest of the complete sorted set, including candidates outside the
   * bounded presentation window. A changed catalog therefore invalidates a
   * stale answer instead of silently retargeting it. */
  digest: string;
  total: number;
  truncated: boolean;
}

export interface WorkflowCapabilityAccountSelectionV1 {
  capabilityId: string;
  accountId: string;
  choiceSetDigest: string;
}

const MAX_WORKFLOW_ACCOUNT_CANDIDATES = 16;

function canonicalAccountCandidates(
  identities: readonly Pick<CanonicalCatalogIdentityV1, 'capabilityId' | 'account'>[],
): WorkflowCapabilityAccountCandidateV1[] {
  const pairs = new Map<string, WorkflowCapabilityAccountCandidateV1>();
  for (const identity of identities) {
    const candidate = {
      capabilityId: identity.capabilityId,
      accountId: identity.account,
    };
    pairs.set(`${candidate.capabilityId}\u0000${candidate.accountId}`, candidate);
  }
  return [...pairs.values()].sort((left, right) => (
    left.capabilityId.localeCompare(right.capabilityId)
      || left.accountId.localeCompare(right.accountId)
  ));
}

/** Build the bounded, content-addressed choice set persisted with a gate. */
export function workflowCapabilityAccountChoiceSet(
  identities: readonly Pick<CanonicalCatalogIdentityV1, 'capabilityId' | 'account'>[],
): WorkflowCapabilityAccountChoiceSetV1 {
  const all = canonicalAccountCandidates(identities);
  return Object.freeze({
    candidates: Object.freeze(all.slice(0, MAX_WORKFLOW_ACCOUNT_CANDIDATES).map((candidate) => Object.freeze({ ...candidate }))),
    digest: createHash('sha256').update(JSON.stringify({ version: 1, candidates: all }), 'utf8').digest('hex'),
    total: all.length,
    truncated: all.length > MAX_WORKFLOW_ACCOUNT_CANDIDATES,
  });
}

export type CompileLiveCatalogWorkflowCallPlanResult =
  | {
      ok: true;
      plan: WorkflowNodeInvocationPlanV1;
      identity: Readonly<CanonicalCatalogIdentityV1>;
    }
  | {
      ok: false;
      recoverable: true;
      reason: 'not-connected' | 'ambiguous-account';
      message: string;
      accountChoiceSet?: WorkflowCapabilityAccountChoiceSetV1;
    }
  | { ok: false; recoverable: false; message: string };

/**
 * Compile one already-rendered call against the exact current live catalog.
 *
 * This is deliberately only a compiler. The returned plan is not executable
 * authority: preparation revalidates its manifest, observation, schema,
 * account, effect, argument compiler, and invoke port before the shared
 * workflow call kernel may be armed.
 */

/**
 * Does the LIVE effect carry more authority than what the author declared?
 *
 * This is the whole question the effect gate exists to answer. An authored
 * `read` that resolves to a live write is an escalation and must be refused.
 * The reverse — an operation that does LESS than declared — is strictly safer
 * than the thing already approved, and refusing it converts a safe surprise
 * into a dead workflow.
 *
 * That reverse case is the DEFAULT path, not an edge case. A promptless `call`
 * step (the shape `workflow_create` recommends) never gets `sideEffect`
 * stamped, so `structuredCallSideEffectClass` returns its conservative
 * `'write'`. That default is correct FOR VALIDATION and is deliberately left
 * alone — it is simply not an author's declaration, and treating it as one
 * made every noun-shaped read slug non-recoverable.
 *
 * `'send'` is an irreversibility marker on top of a write, not a third tier of
 * authority; genuine send slugs are caught upstream and can never be
 * downgraded there.
 */
export function liveCallEffectEscalates(
  authored: LiveCallExpectedEffect,
  live: 'read' | 'write' | 'admin',
): boolean {
  const liveRank = live === 'read' ? 0 : live === 'write' ? 1 : 2;
  const authoredRank = authored === 'read' ? 0 : 1;
  return liveRank > authoredRank;
}

function currentOperationCandidates(
  factory: HostCapabilityCatalogFactory,
  operationId: string,
): CanonicalCatalogIdentityV1[] {
  return factory.snapshot().flatMap((entry) => {
    if (!entry.manifest || !currentCapabilityManifest(entry.manifest)) return [];
    const identity = canonicalCatalogIdentityOf(entry);
    return identity?.operationId === operationId ? [identity] : [];
  });
}

/**
 * Re-materialize only the exact durable manifests for one saved operation.
 *
 * Workflow authoring and workflow draining are separate lifetimes. The
 * trusted manifest and exact invocation port are durable/runtime authority;
 * membership in the in-memory host catalog is only a cache. A later creation
 * test therefore gets one provider-neutral chance to revalidate the current
 * durable identity through the installed production adapter before reporting
 * the operation as disconnected.
 *
 * The adapter still requires a current trusted manifest, an exact registered
 * port, and a fresh independent observation. Nothing is synthesized from the
 * saved slug or arguments, and every matching account is refreshed so the
 * compiler's existing ambiguity refusal remains intact.
 */
export type OperationCatalogRevalidation = {
  durableManifests: number;
  registered: number;
  refused: Array<{ manifestId: string; reason: string }>;
  error?: string;
};

function revalidateCurrentOperationCatalog(operationId: string): OperationCatalogRevalidation {
  const store = peekCapabilityManifestStore();
  const adapter = peekProductionCapabilityAdapter();
  if (!store || !adapter) return { durableManifests: 0, registered: 0, refused: [], error: 'no manifest store or adapter installed' };
  const manifestIds = store.list().flatMap((entry) => {
    const manifest = currentCapabilityManifest(entry.manifest);
    return manifest?.operationId === operationId ? [manifest.manifestId] : [];
  });
  if (manifestIds.length === 0) return { durableManifests: 0, registered: 0, refused: [] };
  try {
    const result = adapter.refresh(new Set(manifestIds));
    return { durableManifests: manifestIds.length, registered: result.registered, refused: result.refused };
  } catch (error) {
    // Revalidation is supply, never authority. The ordinary zero-candidate
    // result below remains the fail-closed outcome when refresh is unavailable.
    return { durableManifests: manifestIds.length, registered: 0, refused: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** Why a saved operation with durable manifests still has no current
 *  candidate — the refresh's own refusal reasons, so a parked run names the
 *  cause (live 2026-09-22: a cold daemon parked an exact calendar step as
 *  "not connected" while two current manifests sat in the store). */
export function describeOperationCatalogRevalidation(revalidation: OperationCatalogRevalidation): string {
  if (revalidation.error) return `revalidation failed: ${revalidation.error}`;
  if (revalidation.durableManifests === 0) return 'no durable manifest for this operation';
  const reasons = [...new Set(revalidation.refused.map((entry) => entry.reason))];
  return `${revalidation.durableManifests} durable manifest(s), ${revalidation.registered} registered`
    + (reasons.length > 0 ? `, refused: ${reasons.join(', ')}` : '');
}

/**
 * Prove a saved provider operation in THIS process before the compiler asks
 * for a current candidate.
 *
 * A durable manifest becomes a live candidate only once the attested
 * transport has observed the operation for its account in the running
 * daemon: a provider schema seen within its 30-minute lease, the connected
 * toolkits enumerated, and one independent observation per account (60 s
 * freshness). Chat does all of that as a side effect of discovery and the
 * calendar watch does it for itself; a call step never did, so a freshly
 * restarted daemon parked an exact calendar step as "not connected" while
 * two current manifests sat in the store (live 2026-09-22, creation test of
 * an authored workflow eight minutes after a launch). Supply, never
 * authority: the compiler below still re-proves candidate, account and
 * effect from the same refresh it always ran.
 */
export type DurableProviderOperationWarmDeps = {
  listDurableManifests: (operationId: string) => Array<Pick<CapabilityManifestV1, 'accountId' | 'definitionFingerprint' | 'providerVersion' | 'operationVersion'>>;
  ensureSchema: (operationId: string) => Promise<string | undefined>;
  listToolkits: () => Promise<unknown>;
  observe: (input: { operationId: string; accountId: string; definitionFingerprint: string; providerVersion: string; operationVersion: string }) => Promise<unknown>;
};

const defaultWarmDeps: DurableProviderOperationWarmDeps = {
  listDurableManifests: (operationId) => (peekCapabilityManifestStore()?.list() ?? []).flatMap((entry) => {
    const manifest = currentCapabilityManifest(entry.manifest);
    return manifest && manifest.operationId === operationId && manifest.providerKind === 'composio' ? [manifest] : [];
  }),
  ensureSchema: async (operationId) => {
    const { ensureLiveComposioSchemaFingerprint } = await import('../tools/composio-schema-cache.js');
    return ensureLiveComposioSchemaFingerprint(operationId);
  },
  listToolkits: async () => {
    const { listConnectedToolkits } = await import('../integrations/composio/client.js');
    return listConnectedToolkits();
  },
  observe: async (input) => {
    const { refreshIndependentCapabilityObservation } = await import('../runtime/harness/independent-capability-observation.js');
    return refreshIndependentCapabilityObservation(input);
  },
};

export async function warmDurableProviderOperation(
  operationId: string,
  deps: DurableProviderOperationWarmDeps = defaultWarmDeps,
): Promise<{ status: 'present' | 'no_durable_manifest' | 'warmed'; manifests: number; observed: number; notes: string[] }> {
  const factory = peekHostCapabilityCatalogFactory();
  if (factory && currentOperationCandidates(factory, operationId).length > 0) {
    return { status: 'present', manifests: 0, observed: 0, notes: [] };
  }
  const manifests = deps.listDurableManifests(operationId);
  if (manifests.length === 0) return { status: 'no_durable_manifest', manifests: 0, observed: 0, notes: [] };
  const notes: string[] = [];
  try {
    if (!(await deps.ensureSchema(operationId))) notes.push('live provider schema unavailable for this operation');
  } catch (error) {
    notes.push(`live provider schema refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try { await deps.listToolkits(); } catch (error) {
    notes.push(`connected toolkits unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let observed = 0;
  for (const manifest of manifests) {
    const accountId = manifest.accountId?.trim();
    if (!accountId) continue;
    try {
      const result = await deps.observe({
        operationId,
        accountId,
        definitionFingerprint: manifest.definitionFingerprint,
        providerVersion: manifest.providerVersion,
        operationVersion: manifest.operationVersion,
      });
      if (result) observed += 1;
      else notes.push(`${accountId}: not observed`);
    } catch (error) {
      notes.push(`${accountId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { status: 'warmed', manifests: manifests.length, observed, notes };
}

/**
 * Acquire a saved READ operation that has no durable manifest yet.
 *
 * A structured `call:` step names an exact operation the workflow author
 * chose (a reviewed CLI read such as a SOQL query, or a configured MCP read).
 * Readiness already counts those operations as present because the carriers
 * can dispatch them, but the live catalog only learns a carrier's operation
 * when something acquires it — chat does that through tool_search; a
 * scheduled call step never did, so the compiler reported `not-connected`
 * for an operation the host could serve (Friday dashboard, 2026-09-01).
 *
 * This is supply, never authority: the exact-operation nomination must match
 * a currently attested carrier definition, the materializer installs the same
 * trusted manifest/port it would for a foreground disclosure, and the
 * compiler below still re-proves candidates, accounts and effect. Only reads
 * are acquired here; writes keep their authored/reviewed paths.
 */
/** One acquisition per operation at a time. Six parallel Friday-dashboard
 * steps each acquired salesforce_sf_soql_query at once (live 2026-09-01): the
 * first installed it, and the other five saw the fresh install as an identity
 * mismatch against their own nomination, superseded and revoked it, and the
 * run parked on "no current capability" for a capability the host had just
 * registered. Siblings now await the one in-flight acquisition and re-check. */
const inFlightLiveReadAcquisitions = new Map<string, Promise<{ status: 'present' | 'acquired' | 'unavailable'; detail?: string }>>();

export async function ensureLiveReadCapabilityForOperation(input: {
  ownerId: string;
  nodeId: string;
  operationId: string;
  expectedEffect: LiveCallExpectedEffect;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<{ status: 'present' | 'acquired' | 'unavailable'; detail?: string }> {
  if (input.expectedEffect !== 'read') return { status: 'present' };
  const factory = peekHostCapabilityCatalogFactory();
  if (!factory) return { status: 'unavailable', detail: 'no live host capability catalog is installed' };
  if (currentOperationCandidates(factory, input.operationId).length > 0) return { status: 'present' };
  const key = input.operationId.trim().toLowerCase();
  const inFlight = inFlightLiveReadAcquisitions.get(key);
  if (inFlight) {
    const settled = await inFlight;
    if (currentOperationCandidates(factory, input.operationId).length > 0) return { status: 'present' };
    return settled;
  }
  const own = acquireLiveReadCapabilityOnce(input, factory).finally(() => {
    if (inFlightLiveReadAcquisitions.get(key) === own) inFlightLiveReadAcquisitions.delete(key);
  });
  inFlightLiveReadAcquisitions.set(key, own);
  return own;
}

async function acquireLiveReadCapabilityOnce(input: {
  ownerId: string;
  nodeId: string;
  operationId: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}, factory: NonNullable<ReturnType<typeof peekHostCapabilityCatalogFactory>>): Promise<{ status: 'present' | 'acquired' | 'unavailable'; detail?: string }> {
  revalidateCurrentOperationCatalog(input.operationId);
  if (currentOperationCandidates(factory, input.operationId).length > 0) return { status: 'present' };
  const { createProductionLiveReadAcquisitionRegistry } = await import(
    '../runtime/harness/production-live-read-acquisition-registry.js'
  );
  const requirementId = `workflow-call:${exactWorkflowCallIdOrDigest(`${input.ownerId}\0${input.nodeId}\0${input.operationId}`)}`;
  try {
    const acquired = await createProductionLiveReadAcquisitionRegistry().acquire(
      { requirementId, objective: input.operationId, effect: 'read' },
      {
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
      },
    );
    if (acquired.status !== 'installed') {
      return { status: 'unavailable', detail: `${acquired.reason}: ${acquired.detail}` };
    }
  } catch (error) {
    return { status: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
  return currentOperationCandidates(factory, input.operationId).length > 0
    ? { status: 'acquired' }
    : { status: 'unavailable', detail: 'the acquired capability did not become a current catalog candidate' };
}

export function compileLiveCatalogWorkflowCallPlan(input: {
  /** Stable semantic owner, such as a workflow or Workspace id. */
  ownerId: string;
  /** Stable node/action id within the owner. */
  nodeId: string;
  operationId: string;
  args: Record<string, unknown>;
  expectedEffect: LiveCallExpectedEffect;
  /** Optional identity namespaces for non-Workflow carriers. */
  requirementNamespace?: string;
  logicalCapabilityNamespace?: string;
  /** Exact human-selected account from the durable capability gate. The
   * choice-set digest is mandatory so catalog drift can never retarget it. */
  selectedAccount?: WorkflowCapabilityAccountSelectionV1;
}): CompileLiveCatalogWorkflowCallPlanResult {
  const factory = peekHostCapabilityCatalogFactory();
  if (!factory) {
    return { ok: false, recoverable: false, message: 'no live host capability catalog is installed' };
  }

  let candidates = currentOperationCandidates(factory, input.operationId);
  let revalidation: OperationCatalogRevalidation | undefined;
  if (candidates.length === 0) {
    revalidation = revalidateCurrentOperationCatalog(input.operationId);
    candidates = currentOperationCandidates(factory, input.operationId);
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      recoverable: true,
      reason: 'not-connected',
      message: `${CAPABILITY_NOT_REGISTERED_PREFIX} "${input.operationId}". Connect it, then retry.`
        + (revalidation ? ` (${describeOperationCatalogRevalidation(revalidation)})` : ''),
    };
  }

  const accountChoiceSet = workflowCapabilityAccountChoiceSet(candidates);
  let identity: CanonicalCatalogIdentityV1 | undefined;
  if (input.selectedAccount) {
    identity = candidates.find((candidate) => (
      candidate.capabilityId === input.selectedAccount!.capabilityId
      && candidate.account === input.selectedAccount!.accountId
    ));
    if (!identity || input.selectedAccount.choiceSetDigest !== accountChoiceSet.digest) {
      return {
        ok: false,
        recoverable: true,
        reason: 'ambiguous-account',
        message: identity
          ? `The available account set for "${input.operationId}" changed after the choice was saved; choose an exact current account again.`
          : `The selected account for "${input.operationId}" is no longer a current capability; choose an exact current account again.`,
        accountChoiceSet,
      };
    }
  } else if (accountChoiceSet.total > 1) {
    return {
      ok: false,
      recoverable: true,
      reason: 'ambiguous-account',
      message: `${accountChoiceSet.total} accounts are registered for "${input.operationId}"; choose the exact account before this workflow can dispatch.`,
      accountChoiceSet,
    };
  } else {
    identity = candidates[0];
  }

  // A non-empty candidate list and the branches above always establish one
  // exact identity. Keep this guard fail-closed if that invariant changes.
  if (!identity) {
    return { ok: false, recoverable: false, message: 'no exact live account identity was selected' };
  }
  if (!PLAN_EFFECTS.has(identity.effect as WorkflowNodeInvocationEffectV1)) {
    return {
      ok: false,
      recoverable: false,
      message: `"${input.operationId}" has no plan-representable effect classification ("${identity.effect}").`,
    };
  }
  const liveEffectClass = identity.effect === 'read'
    || identity.effect === 'compute'
    || identity.effect === 'host_only'
    ? 'read'
    : identity.effect === 'local_write' || identity.effect === 'external_write'
      ? 'write'
      : 'admin';
  // Refuse ESCALATION, not inequality.
  //
  // The gate exists so an authored `read` cannot quietly resolve to a live
  // write. It must not also refuse the reverse: an operation that turns out to
  // do LESS than was declared is strictly safer than the thing already
  // approved, and refusing it converts a safe surprise into a dead workflow.
  //
  // That reverse case is not hypothetical, it is the DEFAULT path. A promptless
  // `call` step — the exact shape workflow_create recommends ("No prompt
  // needed") — never gets `sideEffect` stamped, because autoRepair only stamps
  // when `step.prompt` is truthy. `structuredCallSideEffectClass` then sees
  // `undefined`, not `'read'`, and returns its conservative `'write'`. That
  // default is correct FOR VALIDATION; it is not an author's declaration, and
  // treating it as one made every noun-shaped read slug
  // (SLACK_CONVERSATIONS_HISTORY, TWITTER_USER_TIMELINE) non-recoverable.
  //
  // Worse downstream: a Workspace action can only ever declare 'send'|'write'
  // (space-action-v3-authority.ts), so a read-bound action refused here lands
  // in recordApprovedActionNotRun — refused AFTER a human approved it, which is
  // the safe-but-unavailable failure, not a safeguard.
  const effectMatches = !liveCallEffectEscalates(input.expectedEffect, liveEffectClass);
  if (!effectMatches) {
    return {
      ok: false,
      recoverable: false,
      message: `Authored ${input.expectedEffect} call "${input.operationId}" resolves to live ${identity.effect} authority, which carries MORE effect than was declared; escalation refused.`,
    };
  }

  const argumentContract: Record<string, WorkflowNodeArgumentBindingV1> = {};
  for (const [key, value] of Object.entries(input.args)) {
    const type = runtimeValueType(value);
    if (!type) {
      return {
        ok: false,
        recoverable: false,
        message: `Argument "${key}" is not a plan-representable JSON value.`,
      };
    }
    argumentContract[key] = {
      source: { kind: 'workflow_input', key },
      required: true,
      type,
    };
  }

  try {
    const requirementNamespace = input.requirementNamespace ?? 'workflow-bare-call';
    const logicalCapabilityNamespace = input.logicalCapabilityNamespace ?? 'workflow.call';
    const plan = createWorkflowNodeInvocationPlan({
      requirementId: exactWorkflowCallIdOrDigest(
        `${requirementNamespace}:${input.ownerId}:${input.nodeId}`,
      ),
      logicalCapabilityId: exactWorkflowCallIdOrDigest(
        `${logicalCapabilityNamespace}:${input.operationId}`,
      ),
      binding: {
        capabilityId: identity.capabilityId,
        manifestId: identity.manifestId,
        manifestDigest: identity.manifestDigest,
        operationId: identity.operationId,
        operationVersion: identity.schemaVersion,
        schemaDigest: workflowCapabilityDigest(identity.schemaDigest),
        providerVersion: identity.providerVersion,
        liveFingerprint: workflowCapabilityDigest(identity.liveFingerprint),
        accountId: identity.account,
        effect: identity.effect as WorkflowNodeInvocationEffectV1,
        invokePortId: identity.invokePortId,
        argumentCompiler: {
          id: identity.argumentCompiler.id,
          version: identity.argumentCompiler.version,
        },
      },
      arguments: argumentContract,
      evidence: { requiredPaths: [], nonEmptyPaths: [], minItems: {} },
      completeness: {
        kind: 'terminal_result',
        evidencePaths: [...liveReadCompletenessEvidencePaths(identity.argumentCompiler.id)],
      },
      continuation: { kind: 'none' },
    });
    return { ok: true, plan, identity: Object.freeze({ ...identity }) };
  } catch (error) {
    return {
      ok: false,
      recoverable: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
