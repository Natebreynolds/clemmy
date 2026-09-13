/** Keep a rejected but structurally valid outline available if automatic repair
 * ends. It is never an executable revision until normal preparation succeeds. */
import { openEventLog } from './eventlog.js';
import { acceptedTaskModeIdentity } from './accepted-task-mode.js';
import { getPlanRevisionForSource, publishPlanRevision, type PlanStructuredOutline, type PlanArtifactV1 } from './plan-artifacts.js';
import { parsePlanRevisionRef } from './task-mode.js';
import { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } from '../../shared/closed-canonical-json.js';
import { createHash } from 'node:crypto';

type Identity = { sessionId: string; sourceUserSeq: number };
function db() {
  const store = openEventLog();
  store.exec(`CREATE TABLE IF NOT EXISTS reviewed_plan_preparation_drafts_v1 (
    session_id TEXT NOT NULL, source_user_seq INTEGER NOT NULL REFERENCES events(seq),
    draft_json TEXT NOT NULL, PRIMARY KEY(session_id, source_user_seq)
  )`);
  return store;
}
export function retainPlanPreparationDraft(input: Identity & { fullText: string; structuredPlan: PlanStructuredOutline; baseRefJson: string | null }) {
  const source = acceptedTaskModeIdentity(input.sessionId, input.sourceUserSeq);
  if (source.mode?.kind !== 'plan') throw new Error('Only a Plan source can retain its preparation.');
  const value = closedCanonicalJson({ fullText: input.fullText, structuredPlan: input.structuredPlan,
    base: input.baseRefJson ? parsePlanRevisionRef(JSON.parse(input.baseRefJson)) : null }, SEALED_CALL_CANONICAL_LIMITS);
  db().prepare(`INSERT INTO reviewed_plan_preparation_drafts_v1 VALUES (?, ?, ?)
    ON CONFLICT(session_id, source_user_seq) DO UPDATE SET draft_json = excluded.draft_json`)
    .run(input.sessionId, input.sourceUserSeq, value);
  return createHash('sha256').update(value).digest('hex');
}

/** A patch names the exact retained draft in this accepted source. Concurrent
 * or stale repairs cannot silently overwrite a newer draft or a reviewed plan. */
export function loadRetainedPlanDraft(input: Identity & { digest: string }) {
  if (acceptedTaskModeIdentity(input.sessionId, input.sourceUserSeq).mode?.kind !== 'plan') throw new Error('Only a Plan source can repair its draft.');
  const row = db().prepare('SELECT draft_json FROM reviewed_plan_preparation_drafts_v1 WHERE session_id = ? AND source_user_seq = ?')
    .get(input.sessionId, input.sourceUserSeq) as { draft_json: string } | undefined;
  if (!row || createHash('sha256').update(row.draft_json).digest('hex') !== input.digest) throw new Error('The draft reference is stale or belongs to another source. Use the current retained draft reference.');
  return JSON.parse(row.draft_json) as { fullText: string; structuredPlan: PlanStructuredOutline; base: unknown };
}
export function publishRetainedPlanDraft(input: Identity): PlanArtifactV1 | null {
  const source = acceptedTaskModeIdentity(input.sessionId, input.sourceUserSeq);
  if (source.mode?.kind !== 'plan') return null;
  const scope = { ...input, principalId: source.principalId };
  if (getPlanRevisionForSource(scope)) return null;
  const row = db().prepare('SELECT draft_json FROM reviewed_plan_preparation_drafts_v1 WHERE session_id = ? AND source_user_seq = ?')
    .get(input.sessionId, input.sourceUserSeq) as { draft_json: string } | undefined;
  if (!row) return null;
  const draft = JSON.parse(row.draft_json);
  const issues = draft.structuredPlan?.preparationIssues;
  if (!Array.isArray(issues) || !issues.length || !issues.every(x => typeof x === 'string')) return null;
  return publishPlanRevision({ ...scope, fullText: draft.fullText + '\n\nThe outline is saved, but execution preparation is incomplete:\n\n' + issues.map(x => `- ${x}`).join('\n'),
    structuredPlan: draft.structuredPlan, readiness: 'needs_input', missingPrerequisites: issues,
    ...(draft.base ? { base: parsePlanRevisionRef(draft.base) } : {}),
  });
}
