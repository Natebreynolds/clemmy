/** Exact, read-only selection in retained JSON. No provider keys, search or
 * wildcard expansion: the caller chooses one node and the record query shapes
 * that node. JSON Pointer preserves keys containing dots, slashes or spaces. */
export type RetainedJsonSelection =
  | { status: 'ok'; value: unknown }
  | { status: 'error'; reason: string; atPath: string; parent?: unknown };

const MAX_POINTER_CHARS = 2_048;
const MAX_POINTER_STEPS = 64;

export function selectRetainedJson(value: unknown, pointer: string): RetainedJsonSelection {
  if (pointer.length > MAX_POINTER_CHARS) {
    return { status: 'error', reason: 'path exceeds 2048 characters', atPath: '' };
  }
  if (pointer === '') return { status: 'ok', value };
  if (!pointer.startsWith('/')) {
    return { status: 'error', reason: 'path must be a JSON Pointer starting with / (or empty for the root)', atPath: '' };
  }
  const encoded = pointer.slice(1).split('/');
  if (encoded.length > MAX_POINTER_STEPS) {
    return { status: 'error', reason: 'path exceeds 64 steps', atPath: '' };
  }
  // Validate the whole selector before traversing any part of it.
  if (encoded.some(step => /~(?:[^01]|$)/.test(step))) {
    return { status: 'error', reason: 'path has an invalid escape; use ~0 for ~ and ~1 for /', atPath: '' };
  }
  let current = value;
  let atPath = '';
  for (const step of encoded) {
    const key = step.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)
      && (!/^(0|[1-9]\d*)$/.test(key) || !Number.isSafeInteger(Number(key)))) {
      return { status: 'error', reason: 'an array step must be an exact nonnegative index (0, 1, ...)', atPath, parent: current };
    }
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) {
      return { status: 'error', reason: `no own value at ${JSON.stringify(key)}`, atPath, parent: current };
    }
    current = (current as Record<string, unknown>)[key];
    atPath += `/${step}`;
  }
  return { status: 'ok', value: current };
}
