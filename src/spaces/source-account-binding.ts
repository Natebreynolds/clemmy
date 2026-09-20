/** Preserve only an exact current task's unambiguous read-account selection.
 * This saves routing intent; refresh still revalidates the live capability. */
export function selectedSpaceReadAccount(input: {
  sessionId: string;
  sourceUserSeq: number;
  operationId: string;
  resolutions: readonly { authoritativeForTask?: unknown; sourceUserSeq?: unknown; entries?: unknown }[];
}): string | undefined {
  const accounts = new Set<string>();
  for (const resolution of input.resolutions) {
    if (resolution.authoritativeForTask !== true || resolution.sourceUserSeq !== input.sourceUserSeq
      || !Array.isArray(resolution.entries)) continue;
    for (const entry of resolution.entries) {
      if (!entry || entry.kind !== 'composio' || entry.status !== 'proven'
        || entry.connection !== 'active' || entry.effectClass !== 'read'
        || typeof entry.identifier !== 'string'
        || entry.identifier.toUpperCase() !== input.operationId.trim().toUpperCase()
        || typeof entry.accountIdentity !== 'string' || !entry.accountIdentity.trim()) continue;
      const routing = entry.sourceAccountRouting;
      if (!routing || routing.sessionId !== input.sessionId
        || routing.checkedForSourceUserSeq !== input.sourceUserSeq) continue;
      accounts.add(entry.accountIdentity);
    }
  }
  return accounts.size === 1 ? [...accounts][0] : undefined;
}
