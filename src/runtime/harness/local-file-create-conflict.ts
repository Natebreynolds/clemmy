/** Produced only while holding the revision lock, before changing file bytes.
 * Keep nominal identity across the host carrier; copied error JSON is not proof. */
export class LocalFileCreateConflict extends Error {}

export function isKnownLocalFileCreateConflict(error: unknown, providerKind: string | undefined): boolean {
  return providerKind === 'local_registry' && error instanceof LocalFileCreateConflict;
}
