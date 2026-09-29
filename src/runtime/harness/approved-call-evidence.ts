/**
 * Whether a person approved one settled call, having been shown one of its
 * values.
 *
 * Nothing records "this approval released this call". The answer is put
 * together from records that each stand on their own, and every part must
 * hold or the answer is no:
 *  - the host's durable resume marker names this request as the work an
 *    approval released, validated the way publication validates it;
 *  - the approval was given by a person;
 *  - the approval's own frozen tool and arguments are the call's contract,
 *    and no other call of the request shares it;
 *  - the call settled after the decision;
 *  - the card that was shown carried the value, whole and not withheld.
 *
 * An approval changed before it was given releases nothing in this lane: the
 * changed call is a new call that asks for its own consent.
 */
import { listEvents, openEventLog } from './eventlog.js';
import { completionEvidenceSource } from './recovery-activation.js';
import { acceptedTaskIdFor } from './attempt-identity.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import {
  approvalDecidedByPerson, approvalGroupMembers, get as getApproval, isApprovalGroup,
  type PendingApprovalRow,
} from './approval-registry.js';

interface ShownField { name?: unknown; value?: unknown }
interface ShownPreview { fields?: unknown; items?: unknown }

function fieldsOf(preview: unknown): ShownField[] {
  const fields = (preview as ShownPreview | null | undefined)?.fields;
  return Array.isArray(fields) ? fields.filter((field): field is ShownField => Boolean(field) && typeof field === 'object') : [];
}

function holdsLeaf(node: unknown, value: string, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof node === 'string') return node.trim() === value;
  if (!node || typeof node !== 'object') return false;
  return (Array.isArray(node) ? node : Object.values(node)).some((child) => holdsLeaf(child, value, depth + 1));
}

/** A field showed the value when it is the value, or is a structure shown
 * whole that holds it. A structure cut short no longer parses, and shows
 * nothing for this purpose. */
function shown(fields: readonly ShownField[], value: string): boolean {
  return fields.some((field) => {
    if (typeof field.value !== 'string') return false;
    const text = field.value.trim();
    if (text === value) return true;
    if (!text.startsWith('{') && !text.startsWith('[')) return false;
    try { return holdsLeaf(JSON.parse(text), value); } catch { return false; }
  });
}

function previewShownFor(sessionId: string, approvalId: string, memberIndex: number | null): ShownField[] {
  const requested = listEvents(sessionId, { types: ['approval_requested'] })
    .filter((event) => event.data.approvalId === approvalId).at(-1);
  if (!requested) return [];
  const preview = requested.data.preview as ShownPreview | undefined;
  if (memberIndex === null) return fieldsOf(preview);
  const items = Array.isArray(preview?.items) ? preview.items : [];
  return fieldsOf(items[memberIndex]);
}

export function personApprovalForCall(input: {
  sessionId: string;
  sourceUserSeq: number;
  callId: string;
  value: string;
}): { approvalId: string } | null {
  try {
    const db = openEventLog();
    const calls = db.prepare(`
      SELECT logical_tool_call_id AS callId, tool_name AS toolName, argument_digest AS digest, settled_at AS settledAt
        FROM logical_tool_calls WHERE session_id = ? AND source_user_seq = ?
    `).all(input.sessionId, input.sourceUserSeq) as Array<{ callId: string; toolName: string; digest: string; settledAt: string | null }>;
    const call = calls.find((row) => row.callId === input.callId);
    if (!call?.settledAt) return null;
    if (calls.filter((row) => row.toolName === call.toolName && row.digest === call.digest).length !== 1) return null;
    const acceptedTaskId = acceptedTaskIdFor(input.sessionId, input.sourceUserSeq);
    const markers = listEvents(input.sessionId, { types: ['run_resumed'], sinceSeq: input.sourceUserSeq })
      .filter((event) => event.role === 'system' && event.data.reviewContinuationVersion === 1
        && event.data.executionSourceUserSeq === input.sourceUserSeq && event.data.decision === 'approve'
        && typeof event.data.approvalId === 'string' && Number.isSafeInteger(event.data.deliverySourceUserSeq));
    for (const marker of markers) {
      // The same validation publication applies before it borrows a verdict.
      const work = completionEvidenceSource({ sessionId: input.sessionId, sourceUserSeq: Number(marker.data.deliverySourceUserSeq) });
      if (work.sourceUserSeq !== input.sourceUserSeq) continue;
      const decided = getApproval(String(marker.data.approvalId));
      if (!decided || decided.sessionId !== input.sessionId || !approvalDecidedByPerson(decided)) continue;
      const group = isApprovalGroup(decided);
      const members: PendingApprovalRow[] | null = group ? approvalGroupMembers(decided) : [decided];
      if (!members) continue;
      for (const [index, member] of members.entries()) {
        if (member.status !== 'resolved' || member.resolution !== 'approved' || !member.tool || !member.resolvedAt) continue;
        const contract = durableLogicalCallContract(acceptedTaskId, member.tool, member.args ?? {});
        if (!contract || contract.toolName !== call.toolName || contract.argumentDigest !== call.digest) continue;
        if (Date.parse(call.settledAt) < Date.parse(member.resolvedAt)) continue;
        if (!shown(previewShownFor(input.sessionId, decided.approvalId, group ? index : null), input.value)) continue;
        return { approvalId: member.approvalId };
      }
    }
    return null;
  } catch {
    return null;
  }
}
