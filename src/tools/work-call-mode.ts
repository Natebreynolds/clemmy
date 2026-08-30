/**
 * Opaque configured-object marker for the fresh host's proposal-free
 * work_call mode. The symbol is intentionally module-private: model bytes,
 * registry names, and a lookalike tool cannot manufacture it.
 *
 * Harness wrapping copies enumerable own symbol properties, so the exact
 * assembly-time mode survives the configured-tool wrapper without turning a
 * tool name or a schema heuristic into authority.
 */
import type { HostCapabilityDescriptorV1 } from '../runtime/semantic-boundary/turn-semantic-proposal.js';

const HOST_PLAN_REQUIRED_WORK_CALL = Symbol('clementine.host-plan-required-work-call');

/**
 * Host-only, process-local preparation capability for the exact configured
 * work_call object.  The function never appears on the tool object (including
 * as a symbol), so object enumeration, schema serialization, model arguments,
 * and a lookalike tool cannot discover or copy it.
 *
 * `wrapToolForHarness` deliberately transfers this WeakMap entry from the raw
 * assembly object to the exact wrapped object.  Possession is still not
 * sufficient authority: the preparer itself reopens the current host root,
 * logical call and module-minted HostCallAttestation before doing any work.
 */
export interface HostWorkCallPreparationRequest {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  outerArgs: Record<string, unknown>;
  runContext: unknown;
  details?: unknown;
}

export type HostWorkCallPreparationResult =
  | { status: 'prepared'; preparation: object }
  | {
      status: 'refused';
      output: string;
      /** Host-owned recovery class for this zero-crossing refusal. The runner
       * must not infer it from provider/tool prose or the diagnostic bytes. */
      recovery: 'repair_arguments' | 'stop_and_explain';
    }
  | { status: 'conflict'; reason: string };

type HostWorkCallPreparer = (
  input: HostWorkCallPreparationRequest,
) => Promise<HostWorkCallPreparationResult>;

const hostWorkCallPreparers = new WeakMap<object, HostWorkCallPreparer>();

export interface HostPlanningReadCapabilityRequest {
  sessionId: string;
  sourceUserSeq: number;
  operationId: string;
}

export interface HostPlanningReadCapability {
  capabilityId: string;
  manifestDigest: string;
}

export type HostPlanningReadCapabilityResolver = (
  input: HostPlanningReadCapabilityRequest,
) => HostPlanningReadCapability | null;

/** Exact configured-object bridge for a source-bound foreground planning
 * card. Like the preparer above, this callback never becomes an own property
 * and cannot be recovered from model bytes, a tool name, or a lookalike. */
const hostPlanningReadCapabilityResolvers = new WeakMap<
  object,
  HostPlanningReadCapabilityResolver
>();

export interface HostSingleActionPlanCapabilityRequest {
  sessionId: string;
  sourceUserSeq: number;
  requirementId: string;
  operationId: string;
  effect: 'local_write' | 'external_write';
  /** Exact strict-schema-materialized work_call bytes. They are diagnostic
   * input to the source-bound resolver, never catalog or execution authority. */
  outerArgs: Record<string, unknown>;
}

export interface HostSingleActionPlanCapability {
  capabilityRef: string;
  operationId: string;
  effect: 'local_write' | 'external_write';
  descriptor: HostCapabilityDescriptorV1;
}

export type HostSingleActionPlanCapabilityResolver = (
  input: HostSingleActionPlanCapabilityRequest,
) => HostSingleActionPlanCapability | null | Promise<HostSingleActionPlanCapability | null>;

/** Exact configured-object bridge for the narrow Auto lane. This is only a
 * source-disclosure resolver; it cannot compile a graph or invoke a body. */
const hostSingleActionPlanCapabilityResolvers = new WeakMap<
  object,
  HostSingleActionPlanCapabilityResolver
>();

/** Assembly-only registration. The capability is retained solely in a
 * module-private WeakMap; it is not an own property of `value`. */
export function registerHostWorkCallPreparer<T extends object>(
  value: T,
  preparer: HostWorkCallPreparer,
): T {
  hostWorkCallPreparers.set(value, preparer);
  return value;
}

/** Wrapper-construction bridge. A raw object without the registered opaque
 * capability gives the wrapper no preparation authority. */
export function copyHostWorkCallPreparer<T extends object>(
  source: object,
  target: T,
): T {
  const preparer = hostWorkCallPreparers.get(source);
  if (preparer) hostWorkCallPreparers.set(target, preparer);
  return target;
}

export function registerHostPlanningReadCapabilityResolver<T extends object>(
  value: T,
  resolver: HostPlanningReadCapabilityResolver,
): T {
  hostPlanningReadCapabilityResolvers.set(value, resolver);
  return value;
}

export function copyHostPlanningReadCapabilityResolver<T extends object>(
  source: object,
  target: T,
): T {
  const resolver = hostPlanningReadCapabilityResolvers.get(source);
  if (resolver) hostPlanningReadCapabilityResolvers.set(target, resolver);
  return target;
}

export function registerHostSingleActionPlanCapabilityResolver<T extends object>(
  value: T,
  resolver: HostSingleActionPlanCapabilityResolver,
): T {
  hostSingleActionPlanCapabilityResolvers.set(value, resolver);
  return value;
}

export function copyHostSingleActionPlanCapabilityResolver<T extends object>(
  source: object,
  target: T,
): T {
  const resolver = hostSingleActionPlanCapabilityResolvers.get(source);
  if (resolver) hostSingleActionPlanCapabilityResolvers.set(target, resolver);
  return target;
}

function exactSingleActionDescriptor(
  value: unknown,
  request: HostSingleActionPlanCapabilityRequest,
): HostCapabilityDescriptorV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const descriptor = value as HostCapabilityDescriptorV1;
  if (
    descriptor.id !== request.requirementId
    || descriptor.effect !== request.effect
    || typeof descriptor.manifestDigest !== 'string'
    || !/^[a-f0-9]{64}$/.test(descriptor.manifestDigest)
    || typeof descriptor.purpose !== 'string'
    || !descriptor.purpose.trim()
    || !Array.isArray(descriptor.acceptedInputKinds)
    || !Array.isArray(descriptor.producedOutputKinds)
    || !Array.isArray(descriptor.applicableDeliverableKinds)
    || typeof descriptor.deliverableKind !== 'string'
    || !descriptor.deliverableKind.trim()
    || !Array.isArray(descriptor.evidenceKinds)
    || typeof descriptor.handleRequired !== 'boolean'
    || typeof descriptor.readbackRequired !== 'boolean'
    || typeof descriptor.accountScope !== 'string'
    || !descriptor.accountScope.trim()
    || (descriptor.destinationPosture !== null
      && descriptor.destinationPosture !== 'create_new'
      && descriptor.destinationPosture !== 'named_existing')
  ) return null;
  return Object.freeze({
    ...descriptor,
    acceptedInputKinds: Object.freeze([...descriptor.acceptedInputKinds]),
    producedOutputKinds: Object.freeze([...descriptor.producedOutputKinds]),
    applicableDeliverableKinds: Object.freeze([...descriptor.applicableDeliverableKinds]),
    evidenceKinds: Object.freeze([...descriptor.evidenceKinds]),
    ...(descriptor.advisoryRoles
      ? { advisoryRoles: Object.freeze([...descriptor.advisoryRoles]) }
      : {}),
  });
}

/** Resolve one sole Auto candidate through the opaque callback carried by the
 * exact configured work_call object. Names/lookalikes and malformed callback
 * output fail closed. Compilation and execution remain downstream owners. */
export async function resolveHostSingleActionPlanCapability(
  value: unknown,
  input: HostSingleActionPlanCapabilityRequest,
): Promise<HostSingleActionPlanCapability | null> {
  if (
    !value
    || typeof value !== 'object'
    || !input
    || typeof input.sessionId !== 'string'
    || !input.sessionId
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || typeof input.requirementId !== 'string'
    || !input.requirementId.startsWith('cap:')
    || input.requirementId !== input.requirementId.trim()
    || typeof input.operationId !== 'string'
    || !input.operationId
    || input.operationId !== input.operationId.trim()
    || (input.effect !== 'local_write' && input.effect !== 'external_write')
    || !input.outerArgs
    || typeof input.outerArgs !== 'object'
    || Array.isArray(input.outerArgs)
  ) return null;
  const resolver = hostSingleActionPlanCapabilityResolvers.get(value);
  if (!resolver) return null;
  try {
    const resolved = await resolver(input);
    if (
      !resolved
      || resolved.capabilityRef !== input.requirementId
      || resolved.operationId !== input.operationId
      || resolved.effect !== input.effect
    ) return null;
    const descriptor = exactSingleActionDescriptor(resolved.descriptor, input);
    return descriptor ? Object.freeze({
      capabilityRef: resolved.capabilityRef,
      operationId: resolved.operationId,
      effect: resolved.effect,
      descriptor,
    }) : null;
  } catch {
    return null;
  }
}

export function resolveHostPlanningReadCapability(
  value: unknown,
  input: HostPlanningReadCapabilityRequest,
): HostPlanningReadCapability | null {
  if (
    !value
    || typeof value !== 'object'
    || !input
    || typeof input.sessionId !== 'string'
    || !input.sessionId
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || typeof input.operationId !== 'string'
    || !input.operationId
    || input.operationId !== input.operationId.trim()
  ) return null;
  const resolver = hostPlanningReadCapabilityResolvers.get(value);
  if (!resolver) return null;
  try {
    const resolved = resolver(input);
    if (
      !resolved
      || typeof resolved.capabilityId !== 'string'
      || !resolved.capabilityId
      || resolved.capabilityId !== resolved.capabilityId.trim()
      || typeof resolved.manifestDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(resolved.manifestDigest)
    ) return null;
    return Object.freeze({
      capabilityId: resolved.capabilityId,
      manifestDigest: resolved.manifestDigest,
    });
  } catch {
    return null;
  }
}

/** Host adapter entrypoint. Tool names and structural lookalikes are never
 * accepted as a substitute for the exact configured object. */
export async function prepareHostWorkCall(
  value: unknown,
  input: HostWorkCallPreparationRequest,
): Promise<HostWorkCallPreparationResult> {
  if (!value || typeof value !== 'object') {
    return { status: 'conflict', reason: 'configured work_call object is missing' };
  }
  const preparer = hostWorkCallPreparers.get(value);
  if (!preparer) {
    return { status: 'conflict', reason: 'configured work_call lacks its opaque preparation capability' };
  }
  return preparer(input);
}

export function markHostPlanRequiredWorkCall<T extends object>(value: T): T {
  Object.defineProperty(value, HOST_PLAN_REQUIRED_WORK_CALL, {
    value: true,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return value;
}

export function isHostPlanRequiredWorkCall(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as Record<PropertyKey, unknown>)[HOST_PLAN_REQUIRED_WORK_CALL] === true,
  );
}
