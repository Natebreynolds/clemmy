/** Preserve source-revalidated local identity across semantic admission.
 * A similarly prefixed execution manifest is a different authority surface. */
export function resolveAdmittedCapabilityRef(
  ref: string,
  revalidatedLocalRefs: ReadonlySet<string> | undefined,
  resolveSuccessor: (ref: string) => string | undefined,
): string {
  if (revalidatedLocalRefs?.has(ref)) return ref;
  return resolveSuccessor(ref) ?? ref;
}
