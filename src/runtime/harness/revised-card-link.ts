/**
 * A CHANGE IN WORDS KEEPS ITS CARD. When the owner answered a card with a
 * change ("yes but make it shorter"), the old card was rejected with that
 * change and the brain raised a new card from it. The new card names the one
 * it revises, the owner's words, and the fields as they were, so a surface
 * can draw the change on the card — the new content, "Was: …" under it —
 * instead of two unrelated cards (owner-approved design, 2026-10-07).
 * Deterministic: the latest change-request rejection along this session's
 * conversation lineage that no later card has already claimed, and the
 * accepted source's own words. Shared by every card emitter: the brain's
 * work_call card and the queued exact payload's card.
 */
import { getSession, listEvents } from './eventlog.js';

export function revisedCardLink(sessionId: string, sourceUserSeq: number | undefined): Record<string, unknown> {
  try {
    // The changed card may sit in the conversation this session branched
    // from (an accepted-source successor runs the owner's words); the
    // resolution and the earlier card are read along that lineage.
    const branch = getSession(sessionId)?.metadata?.__accepted_source_branch as { rootSessionId?: unknown; parentSessionId?: unknown } | undefined;
    const lineage = [sessionId, branch?.parentSessionId, branch?.rootSessionId]
      .filter((id, index, all): id is string => typeof id === 'string' && Boolean(id) && all.indexOf(id) === index);
    let resolved: { seq: number; sessionId: string; data: Record<string, unknown> } | undefined;
    for (const id of lineage) {
      const found = listEvents(id, { types: ['approval_resolved'], desc: true, limit: 40 })
        .find((event) => event.data.changeRequested === true && typeof event.data.approvalId === 'string');
      if (found && (!resolved || found.seq > resolved.seq)) resolved = { seq: found.seq, sessionId: id, data: found.data };
    }
    if (!resolved) return {};
    const previousId = resolved.data.approvalId as string;
    const claimed = lineage.some((id) => listEvents(id, { types: ['approval_requested'], sinceSeq: resolved!.seq, limit: 40 })
      .some((event) => event.data.revises && (event.data.revises as { approvalId?: unknown }).approvalId === previousId));
    if (claimed) return {};
    const previous = lineage.flatMap((id) => listEvents(id, { types: ['approval_requested'], desc: true, limit: 80 }))
      .find((event) => event.data.approvalId === previousId);
    const fields = previous && previous.data.preview && typeof previous.data.preview === 'object'
      ? (previous.data.preview as { fields?: unknown }).fields
      : undefined;
    const source = Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0
      ? listEvents(sessionId, { types: ['user_input_received'], sinceSeq: (sourceUserSeq as number) - 1, limit: 1 })
        .find((event) => event.seq === sourceUserSeq)
      : undefined;
    const changeRequest = typeof source?.data.text === 'string' && source.data.text.trim()
      ? source.data.text.trim().slice(0, 600)
      : typeof resolved.data.changeRequest === 'string' && resolved.data.changeRequest.trim()
        ? resolved.data.changeRequest.trim().slice(0, 600)
        : undefined;
    return {
      revises: {
        approvalId: previousId,
        ...(Array.isArray(fields) ? { fields } : {}),
        ...(changeRequest ? { changeRequest } : {}),
      },
    };
  } catch {
    return {};
  }
}

