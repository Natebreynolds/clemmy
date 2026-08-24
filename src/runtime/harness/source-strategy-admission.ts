/**
 * Physical admission for a confirmed collect-then-construct source.
 *
 * Source selection is conversational state until the user confirms it. The
 * durable `turn_preflight_decision` for the exact accepted source is the only
 * authority consumed here; model-visible context and request options are not.
 *
 * This gate is intentionally narrower than "all reads/computes": it applies
 * only while the ambient expected-work requirement is an admitted ancestor of
 * the accepted graph's aggregate construct write. Destination readback,
 * verification, controls, and unrelated work keep their existing owners. The
 * caller invokes this at the one physical-dispatch seam, after provider/tool/
 * account/schema resolution and before provider-start or network I/O.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { listEvents, type EventRow } from './eventlog.js';
import {
  currentDispatchLease,
  type DispatchLeaseRef,
} from './dispatch-lease.js';
import {
  currentRequestSourceArgumentAuthorityMatches,
  type CurrentRequestSourceArgumentAuthorityV1,
} from './source-strategy-argument-authority.js';
import {
  validatedTurnSourceStrategyBinding,
  type TurnPreflightDecision,
  type TurnSourceCapabilityBindingV1,
  type TurnSourceStrategyBindingV1,
} from './turn-control.js';
import type { RuntimeToolEffect } from './tool-effect.js';
import type { CapabilityManifestV1 } from './capability-manifest.js';

export interface PhysicalSourceCapabilityIdentityV1 {
  /** Exact provider-neutral capability identity (for example,
   * `capability:composio:APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS`). */
  capabilityId: string;
  /** Exact stable account identity resolved by the provider gateway. */
  accountIdentity?: string;
  /** Exact live schema/manifest fingerprint resolved before provider I/O. */
  schemaFingerprint?: string;
}

export type MaterialSourceManifestPurpose =
  | { status: 'source_requirement'; role: 'source' | 'collection' }
  | { status: 'known_unrelated' }
  | { status: 'unknown' };

/** Closed structural vocabulary from the sealed manifest contract. Unknown
 * purposes are not guessed from operation/provider names. */
export function classifyMaterialSourceManifestPurpose(
  purpose: CapabilityManifestV1['purpose'],
): MaterialSourceManifestPurpose {
  if (purpose === 'locate_source') return { status: 'source_requirement', role: 'source' };
  if (purpose === 'collect_records') return { status: 'source_requirement', role: 'collection' };
  if (
    purpose === 'persist_collection'
    || purpose === 'project_records'
    || purpose === 'verify_created_resource'
    || purpose === 'lookup_records'
  ) return { status: 'known_unrelated' };
  return { status: 'unknown' };
}

/** Project the physical identity only from the sealed catalog entry and its
 * current manifest. Id/account/schema are structural catalog bytes, never
 * names parsed from a model call or inferred from provider prose. */
export function physicalSourceCapabilityIdentityFromCatalog(input: {
  manifest: Pick<
    CapabilityManifestV1,
    'providerKind' | 'operationId' | 'accountId'
  >;
  /** Selector-schema fingerprint sealed into the catalog snapshot. This is
   * intentionally distinct from the broader manifest-definition digest. */
  sourceSchemaFingerprint?: string;
}): PhysicalSourceCapabilityIdentityV1 | null {
  if (!input.sourceSchemaFingerprint?.trim()) return null;
  const selectorKind = input.manifest.providerKind === 'composio'
    ? 'composio'
    : input.manifest.providerKind === 'native_mcp'
      ? 'mcp'
      : input.manifest.providerKind === 'reviewed_cli'
        ? 'cli'
        : null;
  if (!selectorKind) return null;
  return {
    capabilityId: `capability:${selectorKind}:${input.manifest.operationId}`,
    ...(input.manifest.accountId ? { accountIdentity: input.manifest.accountId } : {}),
    schemaFingerprint: input.sourceSchemaFingerprint,
  };
}

export type SourceStrategyPhysicalAdmission =
  | { status: 'not_applicable'; reason: 'not_read' | 'not_source_requirement' | 'no_binding' | 'not_confirmed' }
  | { status: 'admitted'; match: 'primary' | 'equivalent_fallback'; binding: TurnSourceStrategyBindingV1 }
  | {
      status: 'refused';
      kind: 'source_strategy_unconfirmed' | 'source_strategy_mismatch' | 'source_strategy_authority_invalid';
      message: string;
      binding?: TurnSourceStrategyBindingV1;
    };

type RequirementRole = 'source' | 'collection' | string;

export interface SourceStrategyRequirementContext {
  /** Role admitted by the exact graph/expected-work operation. */
  role: RequirementRole;
  /** Effect admitted by that operation (not the attempted tool heuristic). */
  effect: RuntimeToolEffect;
  /** True only when the accepted graph/continuation has already entered a
   * material-source strategy that must own an exact durable binding. Ordinary
   * current-turn source discovery leaves this false and remains usable. */
  bindingRequired?: boolean;
}

const sourceRequirementStorage = new AsyncLocalStorage<SourceStrategyRequirementContext>();

/** Install the already-admitted expected-work role around its physical child.
 * Only `work_call` owns this mount; provider/model arguments cannot author it. */
export function withSourceStrategyRequirement<T>(
  requirement: SourceStrategyRequirementContext,
  work: () => T,
): T {
  return sourceRequirementStorage.run(requirement, work);
}

export function currentSourceStrategyRequirement(): SourceStrategyRequirementContext | undefined {
  return sourceRequirementStorage.getStore();
}

function exactCapabilityMatch(
  expected: TurnSourceCapabilityBindingV1,
  actual: PhysicalSourceCapabilityIdentityV1,
): boolean {
  const expectedSchema = expected.schemaFingerprint?.trim();
  const actualSchema = actual.schemaFingerprint?.trim();
  if (
    actual.capabilityId !== expected.capabilityId
    || !expectedSchema
    || !actualSchema
    || actualSchema !== expectedSchema
  ) return false;
  const expectedAccount = expected.accountIdentity?.trim();
  const actualAccount = actual.accountIdentity?.trim();
  if (actualAccount) return Boolean(expectedAccount) && actualAccount === expectedAccount;
  return !expectedAccount;
}

export function sourceCapabilityMatchForBinding(
  binding: TurnSourceStrategyBindingV1,
  actual: PhysicalSourceCapabilityIdentityV1,
): 'primary' | 'equivalent_fallback' | null {
  if (exactCapabilityMatch(binding.primary, actual)) return 'primary';
  return binding.equivalentFallbacks.some((fallback) => exactCapabilityMatch(fallback, actual))
    ? 'equivalent_fallback'
    : null;
}

function boundedIdentity(identity: PhysicalSourceCapabilityIdentityV1): string {
  const qualifiers = [
    identity.accountIdentity ? `account=${identity.accountIdentity}` : null,
    identity.schemaFingerprint ? `schema=${identity.schemaFingerprint}` : null,
  ].filter((value): value is string => value !== null);
  return qualifiers.length > 0
    ? `${identity.capabilityId} (${qualifiers.join(', ')})`
    : identity.capabilityId;
}

function allowedIdentityList(binding: TurnSourceStrategyBindingV1): string {
  return [binding.primary, ...binding.equivalentFallbacks]
    .map((identity) => boundedIdentity(identity))
    .join(', ');
}

/** V1 source bindings prove only capability/account/schema identity. They do
 * not prove which provider arguments select the source instance. Until an
 * attested argument template exists, only an actually argument-free provider
 * invocation can inherit that legacy authority. */
function isExactZeroArgumentInvocation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === 0;
}

export interface SourceStrategyIdentityAdmissionInput {
  /** Effect admitted for the current expected-work requirement. This is not
   * the attempted tool's heuristic effect: a write-shaped provider task used
   * as a collection source must not evade a confirmed source binding. */
  requirementEffect: RuntimeToolEffect;
  requirementRole?: RequirementRole;
  decision?: TurnPreflightDecision | null;
  capability?: PhysicalSourceCapabilityIdentityV1;
  /** The accepted graph/continuation has entered a source strategy and must
   * own a durable decision. This is semantic authority, never a surface-kind
   * default: an ordinary chat source query must not be rejected merely because
   * the session happens to be chat. */
  bindingRequired?: boolean;
  /** Backward-compatible spelling for isolated policy callers. */
  requireDurableDecision?: boolean;
}

/** Structural indication that the exact durable decision entered material
 * source selection. A binding byte by itself counts as entered so malformed or
 * partially-written source authority can never degrade into an ordinary
 * unspecified-source call. */
export function turnPreflightDecisionEntersSourceStrategy(
  decision: TurnPreflightDecision | null | undefined,
): boolean {
  return decision?.sourceStrategyBinding !== undefined
    || decision?.sourceStrategyPosture !== undefined
    || decision?.confirmationDisposition === 'material_source_strategy'
    || decision?.reason === 'collect_then_construct';
}

/** Identity/preapproval reducer. It proves only the confirmed provider,
 * account and schema. It deliberately does not authorize provider arguments. */
export function evaluateSourceStrategyIdentityAdmission(
  input: SourceStrategyIdentityAdmissionInput,
): SourceStrategyPhysicalAdmission {
  if (input.requirementEffect !== 'read' && input.requirementEffect !== 'compute') {
    return { status: 'not_applicable', reason: 'not_read' };
  }
  if (input.requirementRole !== 'source' && input.requirementRole !== 'collection') {
    return { status: 'not_applicable', reason: 'not_source_requirement' };
  }
  const rawBinding = input.decision?.sourceStrategyBinding;
  if (rawBinding === undefined) {
    if (
      !input.decision
      && (input.bindingRequired === true || input.requireDurableDecision === true)
    ) {
      return {
        status: 'refused',
        kind: 'source_strategy_authority_invalid',
        message: 'The exact accepted turn has a source/collection requirement but no durable preflight decision. No source provider call was started. Reconstruct and persist the accepted turn decision before retrying this source.',
      };
    }
    const sourceStrategyEntered = turnPreflightDecisionEntersSourceStrategy(input.decision);
    if (!sourceStrategyEntered) return { status: 'not_applicable', reason: 'no_binding' };
    return {
      status: 'refused',
      kind: 'source_strategy_authority_invalid',
      message: 'This turn entered material collection-source selection without persisting an exact capability/account/schema binding. No source provider call was started. Resolve and persist the stated source\'s exact binding; if it is unavailable, explain that blocker and ask whether to choose a surfaced alternative.',
    };
  }
  const binding = validatedTurnSourceStrategyBinding(rawBinding);
  if (!binding) {
    return {
      status: 'refused',
      kind: 'source_strategy_authority_invalid',
      message: 'The confirmed source strategy is not reconstructable. No source provider call was started. Ask the user to confirm a fresh source choice.',
    };
  }
  if (input.decision?.sourceStrategyPosture !== 'confirmed_exact') {
    return {
      status: 'refused',
      kind: 'source_strategy_unconfirmed',
      binding,
      message: 'The material collection source has not been confirmed for this accepted turn. No source provider call was started. Return to the pending source-choice question before doing business work.',
    };
  }
  if (!input.capability) {
    return {
      status: 'refused',
      kind: 'source_strategy_authority_invalid',
      binding,
      message: `The aggregate source reached the physical boundary without an exact capability/account/schema identity. No provider call was started. Re-dispatch through ${boundedIdentity(binding.primary)} or one explicitly listed equivalent fallback.`,
    };
  }
  const match = sourceCapabilityMatchForBinding(binding, input.capability);
  if (!match) {
    return {
      status: 'refused',
      kind: 'source_strategy_mismatch',
      binding,
      message: `The attempted aggregate source ${boundedIdentity(input.capability)} is outside the confirmed source strategy. No provider call was started. Use exactly one of: ${allowedIdentityList(binding)}. If none is currently usable, explain that blocker and ask whether to change the source.`,
    };
  }
  return { status: 'admitted', match, binding };
}

/** Full body-edge reducer. Empty legacy calls retain V1 compatibility; any
 * nonempty call must carry an opaque token minted from this exact current
 * call-bound lease and provider-ready logical contract. */
export function evaluateSourceStrategyPhysicalAdmission(input: (
  SourceStrategyIdentityAdmissionInput & {
    /** Exact provider-ready invocation arguments at the physical boundary. */
    args?: unknown;
    argumentAuthority?: CurrentRequestSourceArgumentAuthorityV1;
    sessionId?: string;
    sourceUserSeq?: number;
    acceptedTaskId?: string;
    logicalToolCallId?: string;
    tool?: string;
    dispatchLease?: DispatchLeaseRef;
  }
)): SourceStrategyPhysicalAdmission {
  const identity = evaluateSourceStrategyIdentityAdmission(input);
  if (identity.status !== 'admitted') return identity;
  if (!isExactZeroArgumentInvocation(input.args)) {
    const argumentAuthorityMatches = Boolean(
      input.argumentAuthority
      && input.sessionId
      && Number.isSafeInteger(input.sourceUserSeq)
      && (input.sourceUserSeq ?? 0) > 0
      && input.acceptedTaskId
      && input.logicalToolCallId
      && input.tool
      && input.dispatchLease
      && currentRequestSourceArgumentAuthorityMatches({
        authority: input.argumentAuthority,
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq as number,
        acceptedTaskId: input.acceptedTaskId,
        logicalToolCallId: input.logicalToolCallId,
        tool: input.tool,
        args: input.args,
        lease: input.dispatchLease,
      }),
    );
    if (argumentAuthorityMatches) return identity;
    return {
      status: 'refused',
      kind: 'source_strategy_authority_invalid',
      binding: identity.binding,
      message: 'The confirmed source strategy proves the exact capability/account/schema, but this nonempty invocation does not carry current call-bound authority for its exact provider-ready arguments; the historical binding carries no attested argument template. No provider call was started. Reconstruct the current accepted call and resolve its arguments again before retrying.',
    };
  }
  return identity;
}

export function exactSourceStrategyDecisionRowsForSource(
  sessionId: string,
  sourceUserSeq: number,
): EventRow[] {
  return listEvents(sessionId, { types: ['turn_preflight_decision'] })
    .filter((event) =>
      (event.data as { sourceUserSeq?: unknown }).sourceUserSeq === sourceUserSeq);
}

export type ExactSourceStrategyDecisionInspection =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'ok'; decision: TurnPreflightDecision };

export function inspectExactSourceStrategyDecisionForSource(
  sessionId: string,
  sourceUserSeq: number,
): ExactSourceStrategyDecisionInspection {
  const rows = exactSourceStrategyDecisionRowsForSource(sessionId, sourceUserSeq);
  if (rows.length === 0) return { status: 'absent' };
  if (rows.length !== 1 || rows[0]!.role !== 'system' || rows[0]!.turn !== 0) {
    return { status: 'invalid' };
  }
  const { sourceUserSeq: _sourceUserSeq, ...decision } = rows[0]!.data;
  return { status: 'ok', decision: decision as unknown as TurnPreflightDecision };
}

function exactPreflightDecision(
  sessionId: string,
  sourceUserSeq: number,
): TurnPreflightDecision | null {
  const inspection = inspectExactSourceStrategyDecisionForSource(sessionId, sourceUserSeq);
  return inspection.status === 'ok' ? inspection.decision : null;
}

/** Exact sole system-authored decision for the accepted B source. Consumers
 * compare the entire returned authority object with their durable A/Q/B
 * derivation; a matching binding alone is insufficient. */
export function confirmedSourceStrategyDecisionForSource(
  sessionId: string,
  sourceUserSeq: number,
): TurnPreflightDecision | null {
  return exactPreflightDecision(sessionId, sourceUserSeq);
}

/** Read the exact accepted source's confirmed binding for model-facing carrier
 * assembly. This is routing context only; `withPhysicalDispatch` re-reads the
 * same durable decision and owns the actual admission. */
export function confirmedSourceStrategyBindingForSource(
  sessionId: string,
  sourceUserSeq: number,
): TurnSourceStrategyBindingV1 | undefined {
  const decision = exactPreflightDecision(sessionId, sourceUserSeq);
  if (decision?.sourceStrategyPosture !== 'confirmed_exact') return undefined;
  return validatedTurnSourceStrategyBinding(decision.sourceStrategyBinding) ?? undefined;
}

/** Durable-event-derived admission used by `withPhysicalDispatch`. */
export function admitSourceStrategyPhysicalDispatch(input: {
  sessionId: string;
  sourceUserSeq: number;
  capability?: PhysicalSourceCapabilityIdentityV1;
  /** Exact provider-ready logical tool at this physical boundary. */
  tool?: string;
  /** Exact provider-ready invocation arguments. */
  args?: unknown;
  /** Opaque current-request authority minted after provider resolution. */
  argumentAuthority?: CurrentRequestSourceArgumentAuthorityV1;
}): SourceStrategyPhysicalAdmission {
  const requirement = currentSourceStrategyRequirement();
  if (!requirement || (requirement.role !== 'source' && requirement.role !== 'collection')) {
    return evaluateSourceStrategyPhysicalAdmission({
      requirementEffect: requirement?.effect ?? 'unknown',
      ...(requirement?.role ? { requirementRole: requirement.role } : {}),
    });
  }
  let decision: TurnPreflightDecision | null;
  try {
    const inspection = inspectExactSourceStrategyDecisionForSource(input.sessionId, input.sourceUserSeq);
    if (inspection.status === 'invalid') {
      return {
        status: 'refused',
        kind: 'source_strategy_authority_invalid',
        message: 'The exact accepted source has ambiguous or malformed durable preflight authority. No source provider call was started. Reconstruct and persist one exact accepted-turn decision before retrying.',
      };
    }
    decision = inspection.status === 'ok' ? inspection.decision : null;
  } catch {
    return {
      status: 'refused',
      kind: 'source_strategy_authority_invalid',
      message: 'The exact accepted source strategy could not be read durably. No source provider call was started. Retry after Clementine storage is healthy.',
    };
  }
  const dispatchLease = currentDispatchLease();
  return evaluateSourceStrategyPhysicalAdmission({
    requirementEffect: requirement.effect,
    requirementRole: requirement.role,
    decision,
    bindingRequired: requirement.bindingRequired,
    ...(input.capability ? { capability: input.capability } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    args: input.args,
    ...(input.argumentAuthority ? { argumentAuthority: input.argumentAuthority } : {}),
    ...(dispatchLease?.acceptedTaskId ? { acceptedTaskId: dispatchLease.acceptedTaskId } : {}),
    ...(dispatchLease?.logicalToolCallId
      ? { logicalToolCallId: dispatchLease.logicalToolCallId }
      : {}),
    ...(dispatchLease ? { dispatchLease } : {}),
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
  });
}
