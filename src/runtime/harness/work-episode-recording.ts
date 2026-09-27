/**
 * Where finished work becomes a work episode (src/memory/work-episodes.ts).
 *
 * Two moments: a plan revision is published, and a reviewed answer is
 * committed. Both read only what the eventlog already holds for the accepted
 * request (its text, the retained result handles) and never block or fail
 * the turn that produced them.
 */
import { hasWorkEpisode, recordWorkEpisode } from '../../memory/work-episodes.js';
import { listEvents, openEventLog } from './eventlog.js';
import type { PlanArtifactV1 } from './plan-artifacts.js';

/** The accepted request text, or null when the source is not this session's user event. */
function acceptedRequestText(sessionId: string, sourceUserSeq: number): string | null {
  const accepted = listEvents(sessionId, { sinceSeq: sourceUserSeq - 1, types: ['user_input_received'], limit: 1 })[0];
  if (!accepted || accepted.seq !== sourceUserSeq) return null;
  const text = (accepted.data as { text?: unknown }).text;
  return typeof text === 'string' && text.trim() ? text : null;
}

export function recordPlanWorkEpisode(artifact: PlanArtifactV1): void {
  try {
    const objective = acceptedRequestText(artifact.sessionId, artifact.sourceUserSeq);
    if (!objective) return;
    const outline = artifact.structuredPlan?.steps;
    const steps = Array.isArray(outline) ? outline.length : 0;
    recordWorkEpisode({
      kind: 'plan',
      sessionId: artifact.sessionId,
      sourceUserSeq: artifact.sourceUserSeq,
      objective,
      outcome: `${artifact.readiness === 'ready' ? 'Ready plan' : 'Plan needing input'}${steps ? ` (${steps} steps)` : ''}, revision ${artifact.revision}: ${artifact.fullText}`,
      finishedAt: artifact.createdAt,
      plan: { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest, readiness: artifact.readiness },
    });
  } catch { /* memory stays additive */ }
}

export function recordAnswerWorkEpisode(input: { sessionId: string; sourceUserSeq: number; text: string; finishedAt?: string }): void {
  try {
    const objective = acceptedRequestText(input.sessionId, input.sourceUserSeq);
    if (!objective || !input.text.trim()) return;
    // A plan turn's reply presents the plan; the plan episode already carries it.
    if (hasWorkEpisode({ sessionId: input.sessionId, kind: 'plan', sourceUserSeq: input.sourceUserSeq })) return;
    const handles = openEventLog().prepare(`
      SELECT handle_id, tool_name FROM durable_result_handles
       WHERE session_id = ? AND source_user_seq = ? AND scope_kind = 'authoritative' AND raw_location IS NOT NULL
       ORDER BY handle_id
    `).all(input.sessionId, input.sourceUserSeq) as Array<{ handle_id: string; tool_name: string }>;
    recordWorkEpisode({
      kind: 'answer',
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      objective,
      outcome: input.text,
      ...(input.finishedAt ? { finishedAt: input.finishedAt } : {}),
      resultHandleIds: handles.map(row => row.handle_id),
      toolsUsed: [...new Set(handles.map(row => row.tool_name))],
    });
  } catch { /* memory stays additive */ }
}
