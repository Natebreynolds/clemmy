/**
 * Opaque configured-object marker for the fresh host's proposal-free
 * work_call mode. The symbol is intentionally module-private: model bytes,
 * registry names, and a lookalike tool cannot manufacture it.
 *
 * Harness wrapping copies enumerable own symbol properties, so the exact
 * assembly-time mode survives the configured-tool wrapper without turning a
 * tool name or a schema heuristic into authority.
 */
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
  | { status: 'refused'; output: string }
  | { status: 'conflict'; reason: string };

type HostWorkCallPreparer = (
  input: HostWorkCallPreparationRequest,
) => Promise<HostWorkCallPreparationResult>;

const hostWorkCallPreparers = new WeakMap<object, HostWorkCallPreparer>();

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
