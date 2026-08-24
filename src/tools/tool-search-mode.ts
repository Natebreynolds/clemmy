/** Opaque assembly marker for the metadata-only tool_search mounted by the
 * fresh host planning loop. It survives harness object wrapping but cannot be
 * supplied in model arguments or reproduced by a name-compatible tool. */
const FRESH_PLAN_DISCLOSURE_SEARCH = Symbol('clementine.fresh-plan-disclosure-search');

export function markFreshPlanDisclosureSearch<T extends object>(value: T): T {
  Object.defineProperty(value, FRESH_PLAN_DISCLOSURE_SEARCH, {
    value: true,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return value;
}

export function isFreshPlanDisclosureSearch(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && (value as Record<PropertyKey, unknown>)[FRESH_PLAN_DISCLOSURE_SEARCH] === true,
  );
}
