import { jsonSchemaAllowsNull } from '../schema-normalizer.js';

/** The native args_json adapter fills omitted nullable fields. Compare the
 * approved arguments in that same representation, only for local registry
 * bindings. Provider nulls can carry write semantics and remain exact. */
export function reviewedArgumentsWithLocalNulls(
  expected: Record<string, unknown>,
  actual: unknown,
  binding: { identity?: { kind?: string }; inputSchema?: { properties?: Record<string, unknown> } },
): Record<string, unknown> {
  if (binding.identity?.kind !== 'local_registry' || !actual || typeof actual !== 'object' || Array.isArray(actual)) return expected;
  const properties = binding.inputSchema?.properties ?? {};
  let result = expected;
  for (const [key, value] of Object.entries(actual)) {
    if (value !== null || Object.hasOwn(expected, key) || !Object.hasOwn(properties, key)
      || !jsonSchemaAllowsNull(properties[key])) continue;
    if (result === expected) result = { ...expected };
    Object.defineProperty(result, key, { value: null, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
