/** Advisory recall must not introduce a different tool into a resolved job. */
export function toolChoiceMatchesResolvedContract(identifier: string, contract: string): boolean {
  const name = identifier.trim().toLowerCase();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9_.-])${escaped}(?=$|[^a-z0-9_.-])`, 'i').test(contract);
}
