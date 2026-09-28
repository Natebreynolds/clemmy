/** Adapter-owned display semantics. These facts never grant consent or change
 * arguments. Callers supply redeemed results and their exact admitted requests,
 * scoped to one accepted source and account. Never join records by proximity. */
export interface ApprovalDestinationEvidence {
  operation: string;
  accountId: string;
  args: unknown;
  result: unknown;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 160
    && !/[\r\n\x00-\x1f]/.test(value) ? value.trim() : undefined;
}
export function composioApprovalDestinationLabel(input: {
  operation: string; accountId: string; value: string;
  evidence: readonly ApprovalDestinationEvidence[];
}): string | undefined {
  if (input.operation.toUpperCase() !== 'SLACK_SEND_MESSAGE' || !input.accountId) return undefined;
  const rows = input.evidence.filter(row => row.accountId === input.accountId);
  const recipients = new Set<string>();
  for (const row of rows) {
    if (row.operation.toUpperCase() !== 'SLACK_OPEN_DM') continue;
    const data = record(record(row.result)?.data);
    const args = record(row.args);
    if (data?.ok !== true || record(data.channel)?.id !== input.value) continue;
    // Only a single-user DM has this unambiguous request -> result relation.
    // Existing-channel lookups and group DMs need their own membership proof.
    const user = text(args?.users);
    if (!user || user.includes(',') || /\s/.test(user)) continue;
    recipients.add(user);
  }
  if (recipients.size !== 1) return undefined;
  const recipient = [...recipients][0];
  const names = new Set<string>();
  for (const row of rows) {
    if (!['SLACK_FIND_USER_BY_EMAIL_ADDRESS', 'SLACK_RETRIEVE_USER_INFO'].includes(row.operation.toUpperCase())) continue;
    const data = record(record(row.result)?.data);
    const user = record(data?.user);
    if (data?.ok !== true || user?.id !== recipient || user.deleted === true) continue;
    const profile = record(user.profile);
    const name = text(profile?.real_name) ?? text(user.real_name) ?? text(profile?.display_name) ?? text(user.name);
    const email = text(profile?.email);
    if (name) names.add(`${name}${email ? ` (${email})` : ''}`);
  }
  return names.size === 1 ? `DM with ${[...names][0]}` : undefined;
}
