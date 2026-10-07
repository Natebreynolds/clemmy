import type { ApprovalPreview, ChatMessage, HarnessEvent } from './types.js';

type ApprovalEditState = Pick<NonNullable<ChatMessage['approval']>, 'approvalId' | 'preview' | 'revises'>;

/** The resolved event carries the host's committed edit, not a local draft.
 * Apply only existing field names and exact bounded text to this exact card.
 * Replayed/ordinary decisions cannot replace the retained before values. */
export function approvalWithCanonicalEdits<T extends ApprovalEditState>(
  approval: T, data: Record<string, unknown>,
): T & ApprovalEditState {
  const preview = approval.preview;
  const edits = data.editedFields;
  if (!approval.approvalId || data.approvalId !== approval.approvalId || data.edited !== true
    || data.decision !== 'approve_with_edits' || data.changeRequested === true
    || !preview || preview.items || !edits || typeof edits !== 'object' || Array.isArray(edits)) return approval;
  const entries = Object.entries(edits);
  if (!entries.length || entries.some(([name, value]) => typeof value !== 'string' || value.length > 20_000
    || !preview.fields.some(field => field.name === name))) return approval;
  const fields = preview.fields.map(field => Object.hasOwn(edits, field.name)
    ? { ...field, value: (edits as Record<string, string>)[field.name]! } : field);
  if (!fields.some((field, index) => field.value !== preview.fields[index]!.value)) return approval;
  return { ...approval, preview: { ...preview, fields }, revises: {
    approvalId: approval.approvalId, fields: preview.fields,
    ...(approval.revises?.changeRequest ? { changeRequest: approval.revises.changeRequest } : {}),
  } };
}

/** A direct card decision resumes a durable source without adding the host's
 * internal approval command to the person's transcript. Only the known card's
 * typed resume event can own this assistant reply. */
export function acceptedApprovalResumeSource(event: Pick<HarnessEvent, 'seq' | 'type' | 'role' | 'turn' | 'data' | 'sessionId'>,
  sessionId: string | null | undefined,
  knownApprovalId: string | null | undefined): ChatMessage['acceptedSource'] {
  const d = event.data ?? {};
  const session = event.sessionId ?? sessionId;
  if (event.type !== 'user_input_received' || event.role !== 'user' || d.synthetic !== true
    || d.source !== 'approval_resume' || !knownApprovalId || d.approvalId !== knownApprovalId
    || !['approve', 'reject', 'approve_with_edits'].includes(String(d.decision))
    || !session || (sessionId && session !== sessionId)
    || !Number.isSafeInteger(event.seq) || event.seq <= 0
    || !Number.isSafeInteger(event.turn) || event.turn! < 0) return undefined;
  return { sessionId: session, sourceUserSeq: event.seq, turn: event.turn! };
}

/** One edit watches its exact resumed source. Another turn in the reusable
 * session cannot supply its reply or end the watch. */
export class ApprovalReplyObserver {
  private sourceUserSeq: number | null = null;

  constructor(private readonly sessionId: string, private readonly approvalId: string) {}

  observe(event: Pick<HarnessEvent, 'seq' | 'type' | 'role' | 'turn' | 'data' | 'sessionId'>): boolean {
    if (event.sessionId && event.sessionId !== this.sessionId) return false;
    const source = acceptedApprovalResumeSource(event, this.sessionId, this.approvalId);
    if (source && this.sourceUserSeq === null) this.sourceUserSeq = source.sourceUserSeq;
    if (source) return source.sourceUserSeq === this.sourceUserSeq;
    if ((event.type === 'approval_resolved' || event.type === 'awaiting_user_input')
      && event.data?.approvalId === this.approvalId) return true;
    return this.ownsSource(event);
  }

  ownsSource(event: { sessionId?: string; data?: Record<string, unknown> }): boolean {
    return (!event.sessionId || event.sessionId === this.sessionId) && this.sourceUserSeq !== null
      && event.data?.sourceUserSeq === this.sourceUserSeq;
  }
}

/** Named recipients and entity IDs are display labels, not the content the
 * owner is retyping. Both devices choose the same content field. */
export function editableApprovalField(preview: ApprovalPreview | undefined): ApprovalPreview['fields'][number] | null {
  if (!preview || preview.items) return null;
  return preview.fields.filter(field => !field.label)
    .reduce<ApprovalPreview['fields'][number] | null>((longest, field) =>
      !longest || field.value.length > longest.value.length ? field : longest, null);
}

/** State updates alone cannot guard two clicks in the same render, or an edit
 * racing the card's original answer. */
export class ApprovalDecisionGate {
  private inFlight = false;

  async run(action: () => Promise<void>): Promise<boolean> {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      await action();
      return true;
    } finally {
      this.inFlight = false;
    }
  }
}
