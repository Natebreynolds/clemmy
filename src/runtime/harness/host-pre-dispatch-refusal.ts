/** A host-only, process-opaque assertion that no business I/O began. Provider
 * error names/text and serialized lookalikes cannot manufacture this fact. */
const refused = new WeakSet<object>();

export function hostPreDispatchRefusal(message: string): Error {
  const error = new Error(message);
  error.name = 'ProviderPreDispatchRefusalError';
  refused.add(error);
  return error;
}

export function isHostPreDispatchRefusal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && refused.has(error);
}
