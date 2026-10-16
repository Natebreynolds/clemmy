/**
 * Unified report-back: the ONE Outcome contract + delivery mechanism every
 * async lane (background task, workflow run, cron, …) uses to report back to the
 * conversation that started it. North-star Move 4 (`docs/north-star-unification.md`).
 *
 * Before this, each lane had its own near-identical `enqueue*OutcomeTurn` —
 * same mechanism (append a synthetic turn + stage it into the conversation
 * snapshot the orchestrator replays + idempotency by id-prefix), differing only
 * in label/guidance wording. That duplication is collapsed here, so:
 *   • every surface (desktop, Discord, mobile) renders the SAME structure, and
 *   • adding a new lane (or a new status like needs_input) is one call, not a
 *     new copy of the plumbing.
 *
 * Delivery is best-effort and idempotent: a completed run must never fail on a
 * session write, and a retried/double completion must not post twice. A
 * non-terminal needs_input outcome is allowed to be followed by one terminal
 * outcome for the same source id, so a parked background task can still report
 * completion after the user answers.
 */
import { withoutHostReceiptLines } from './host-receipt-lines.js';
import fs from 'node:fs';
import path from 'node:path';
import { SessionStore } from '../memory/session-store.js';
import { HarnessSession } from './harness/session.js';
import { appendEvent, getEvent, getSession as getHarnessSession, listEvents, openEventLog, withEventPublicationTransaction, type EventRow } from './harness/eventlog.js';
import { appendGoalLedgerForSession } from '../agents/plan-proposals.js';
import { BASE_DIR, getRuntimeEnv } from '../config.js';
import { isBackgroundOutcomeSource } from './harness/accepted-source-kind.js';
import pino from 'pino';
import { createHash } from 'node:crypto';
import { commitTurnOutcome } from './harness/delivery-committer.js';
import { presentationEventFromCompletionData, turnOutcomeId, type TurnOutcome } from './harness/turn-outcome.js';
import { RETAINED_WORK_TERMINAL_HEADER } from './harness/retained-work-checkpoint.js';

const logger = pino({ name: 'clementine-next.outcome' });

// Kept lean to what lanes actually produce today (done/blocked/failed) plus
// needs_input — the north-star "ask for clarity" status. The evidence fields
// below are deliberately execution facts, not another model verdict: manifests,
// saved artifact references, committed-write receipts, and the latest concrete
// tool failure. They let the model explain a partial/blocked run without the
// harness replacing useful work with a generic status sentence.
export type OutcomeStatus = 'done' | 'blocked' | 'failed' | 'needs_input';

export interface OutcomeWorkEvidence {
  label: string;
  completed: number;
  total: number;
  evidenceCount?: number;
}

export interface OutcomeArtifactEvidence {
  kind: string;
  ref: string;
  /** A provider readback or equivalent binding check verified this reference. */
  verified?: boolean;
}

export interface OutcomeToolFailureEvidence {
  tool?: string;
  summary: string;
}

/** Bounded, deterministic execution evidence shared by every async lane. */
export interface OutcomeEvidence {
  work?: OutcomeWorkEvidence[];
  artifacts?: OutcomeArtifactEvidence[];
  committedExternalActions?: number;
  lastToolFailure?: OutcomeToolFailureEvidence;
}

/** The single shape every lane produces to report back. */
export interface Outcome {
  status: OutcomeStatus;
  /** One-line headline of what happened (optional — `detail` alone is fine). */
  summary?: string;
  /** The full result body / preview. Truncated on render. */
  detail?: string;
  /** Runtime-owned facts that survive weak or generic model prose. */
  evidence?: OutcomeEvidence;
  /** The one remaining dependency, separate from completed work. */
  blocker?: string;
  /** Concrete action that unblocks/resumes this exact saved run. */
  nextAction?: string;
  /** True when the same durable run can continue after `nextAction`. */
  resumable?: boolean;
}

export interface DeliverContext {
  /** The conversation to report back into. No-op when absent (cron/autonomous
   *  spawns with no session to wake). */
  originSessionId?: string;
  /** Lane label used in the idempotency prefix + headline, e.g. 'background
   *  task', 'workflow run'. */
  sourceLabel: string;
  /** The run/task id. */
  sourceId: string;
  /** Optional durable outbox identity. Exact payload/session matching and a
   * database uniqueness constraint protect acknowledgement-gap recovery. */
  deliveryId?: string;
  /** This stop of the source. A source resumed after reporting that stops
   * again is a new stop and reports again; a replay of the same stop does
   * not. Absent: one report per source. */
  stopId?: string;
  /** Human title (workflow name, task title). */
  title?: string;
  /** How the agent fetches the full result, e.g. `background_task_status('id')`. */
  statusHint?: string;
  /** Per-status head-word overrides, for back-compat with a lane's existing
   *  prefix wording (e.g. workflow renders `blocked` as "needs attention"). */
  headWord?: Partial<Record<OutcomeStatus, string>>;
  /** Detail truncation cap. */
  maxDetailChars?: number;
  /**
   * Publish the settled worker result immediately in its origin chat, even
   * during foreground work. This is presentation only: no extra model turn,
   * task execution or external send. Publication failure retains a durable
   * retry intent; acknowledgement waits for the exact visible terminal.
   */
  proactiveTurn?: boolean;
}

/**
 * Delivery acknowledgement for callers that own a durable completion marker.
 *
 * `deliverOutcome()` intentionally keeps its historical boolean contract
 * (true only when this call appended a turn). Workflow report-back also needs
 * to distinguish an idempotent duplicate from an actual write failure: both
 * were previously `false`, which let a failed origin write be mistaken for a
 * completed delivery or made a successful retry impossible to acknowledge.
 */
export interface OutcomeDeliveryAcknowledgement {
  acknowledged: boolean;
  written: boolean;
  disposition: 'delivered' | 'already_delivered' | 'not_applicable' | 'failed';
}

/** Pure gate for the proactive report-back turn: only an idle CHAT session
 *  qualifies — a session mid-turn (recent event) must not get a colliding
 *  turn, and workflow/agent sessions have no human watching them. */
export function shouldProactivelyReport(
  sessionKind: string | null,
  lastEventAgeMs: number | null,
  idleThresholdMs = 60_000,
): boolean {
  if (sessionKind !== 'chat') return false;
  if (lastEventAgeMs !== null && lastEventAgeMs < idleThresholdMs) return false;
  return true;
}

const DEFAULT_HEAD_WORDS: Record<OutcomeStatus, string> = {
  done: 'completed',
  blocked: 'BLOCKED',
  failed: 'FAILED',
  needs_input: 'NEEDS INPUT',
};

const DEFAULT_MAX_DETAIL = 4000;

/** The idempotency / UI-detect prefix every outcome turn starts with. */
export function outcomePrefix(ctx: DeliverContext): string {
  return `[${ctx.sourceLabel} ${ctx.sourceId} `;
}

function guidanceFor(status: OutcomeStatus, statusHint?: string): string {
  const ref = statusHint ? ` Details via ${statusHint}.` : '';
  switch (status) {
    case 'done':
      return `This ran in the background and just finished — continue from here.${statusHint ? ` Full result via ${statusHint}.` : ''}`;
    case 'failed':
      return `This run stopped and did NOT complete the full objective. Preserve and report any execution evidence above; do not describe proven work as lost, and do not replay side effects.${ref}`;
    case 'blocked':
      return `This needs attention. Preserve and report the completed work above. If what stopped it is a defect in the work's own setup that you can correct (a saved workflow step's arguments, instructions or output), correct it, check it, and run it again: that is yours to fix, not the user's. Otherwise name only the remaining dependency, and resume this saved work after it is resolved instead of starting over.${ref}`;
    case 'needs_input':
      return `This needs user input to continue. Preserve and report the completed work above, ask for the exact remaining action, then resume this saved work; do not guess or restart.${ref}`;
  }
}

function boundedText(value: string | undefined, max: number): string {
  return (value ?? '').trim().slice(0, max);
}

/** The run's progress facts. The model's report also carries the last raw
 * tool failure; the owner's says what got done, in plain words. */
function renderOutcomeEvidence(evidence: OutcomeEvidence | undefined, audience: 'model' | 'owner' = 'model'): string {
  if (!evidence) return '';
  const lines: string[] = [];
  for (const work of (evidence.work ?? []).slice(0, 4)) {
    const label = boundedText(work.label, 160) || 'Logical work';
    const completed = Math.max(0, Math.trunc(work.completed));
    const total = Math.max(0, Math.trunc(work.total));
    if (audience === 'owner') {
      lines.push(`- ${label}: ${completed} of ${total} done`);
      continue;
    }
    const refs = typeof work.evidenceCount === 'number'
      ? ` · ${Math.max(0, Math.trunc(work.evidenceCount))} evidence reference${Math.trunc(work.evidenceCount) === 1 ? '' : 's'}`
      : '';
    lines.push(`- ${label}: ${completed}/${total} complete${refs}`);
  }
  for (const artifact of (evidence.artifacts ?? []).slice(0, 8)) {
    const ref = boundedText(artifact.ref, 500);
    if (!ref) continue;
    // The owner reads the file's name; where it lives is on the run's page.
    if (audience === 'owner') {
      lines.push(`- Saved ${ref.split(/[\\/]/).filter(Boolean).at(-1) ?? ref}`);
      continue;
    }
    const kind = boundedText(artifact.kind, 80) || 'artifact';
    lines.push(`- Saved ${kind}: ${ref}${artifact.verified ? ' (read back)' : ''}`);
  }
  if (typeof evidence.committedExternalActions === 'number' && evidence.committedExternalActions > 0) {
    const count = Math.max(0, Math.trunc(evidence.committedExternalActions));
    lines.push(`- ${count} committed external action receipt${count === 1 ? '' : 's'}`);
  }
  const failureSummary = audience === 'model' ? boundedText(evidence.lastToolFailure?.summary, 700) : '';
  if (failureSummary) {
    const tool = boundedText(evidence.lastToolFailure?.tool, 120);
    lines.push(`- Last concrete tool failure${tool ? ` (${tool})` : ''}: ${failureSummary}`);
  }
  if (lines.length === 0) return '';
  return `${audience === 'owner' ? 'Done so far:' : 'Execution evidence:'}\n${lines.join('\n')}`;
}

/** Owner-facing words from a run's report text: the retained-work handle
 * listing is for the model that resumes the work, not for the owner. */
function ownerFacingText(text: string | undefined): string {
  const trimmed = withoutHostReceiptLines(text ?? '').trim();
  const cut = trimmed.indexOf(RETAINED_WORK_TERMINAL_HEADER);
  return (cut >= 0 ? trimmed.slice(0, cut) : trimmed).trim();
}

/** Render the canonical report-back text. The head + prefix are stable (UI and
 *  idempotency depend on them); the body is the unified card. */
export function renderOutcomeText(outcome: Outcome, ctx: DeliverContext): string {
  const word = ctx.headWord?.[outcome.status] ?? DEFAULT_HEAD_WORDS[outcome.status];
  const head = `${outcomePrefix(ctx)}${word}]${ctx.title ? ` ${ctx.title}` : ''}`;
  const cap = ctx.maxDetailChars ?? DEFAULT_MAX_DETAIL;

  const parts: string[] = [];
  if (outcome.summary && outcome.summary.trim()) parts.push(outcome.summary.trim());
  const evidence = renderOutcomeEvidence(outcome.evidence);
  // On incomplete work, runtime-owned facts lead the free-form report. That
  // way a weak "task did not complete" sentence can never hide 119/120 saved
  // items or an already-written artifact. Successful runs keep Clementine's
  // own report first and use the evidence block as support.
  if (outcome.status !== 'done' && evidence) parts.push(evidence);
  if (outcome.detail && outcome.detail.trim() && outcome.detail.trim() !== outcome.summary?.trim()) {
    const d = outcome.detail.trim();
    parts.push(d.length > cap ? `${d.slice(0, cap)}\n…[truncated]` : d);
  }
  if (outcome.status === 'done' && evidence) parts.push(evidence);
  const blocker = boundedText(outcome.blocker, 1000);
  if (blocker) parts.push(`Remaining dependency:\n${blocker}`);
  const nextAction = boundedText(outcome.nextAction, 700);
  if (nextAction) {
    parts.push(`${outcome.resumable ? 'Resume action' : 'Next safe action'}:\n${nextAction}`);
  }
  parts.push(`(${guidanceFor(outcome.status, ctx.statusHint)})`);

  return `${head}\n\n${parts.join('\n\n')}`;
}

function outcomeHeadWord(status: OutcomeStatus, ctx: DeliverContext): string {
  return ctx.headWord?.[status] ?? DEFAULT_HEAD_WORDS[status];
}

function needsInputPrefix(ctx: DeliverContext): string {
  return `${outcomePrefix(ctx)}${outcomeHeadWord('needs_input', ctx)}]`;
}

function isDuplicateOutcomeText(text: string, outcome: Outcome, ctx: DeliverContext, renderedText: string): boolean {
  const idPrefix = outcomePrefix(ctx);
  if (!text.startsWith(idPrefix)) return false;

  const isNeedsInput = text.startsWith(needsInputPrefix(ctx));
  if (outcome.status === 'needs_input') {
    // A source can park more than once over its lifetime (question A, resume,
    // later question B). Dedup only exact replay of the same parked prompt;
    // terminal outcomes below still dedupe by source id.
    return isNeedsInput && text === renderedText;
  }
  return !isNeedsInput;
}

function sessionStoreHasOutcome(store: SessionStore, sessionId: string, outcome: Outcome, ctx: DeliverContext, renderedText: string): boolean {
  return store.get(sessionId).turns.some((t) => typeof t.text === 'string' && isDuplicateOutcomeText(t.text, outcome, ctx, renderedText));
}

function outcomeReportIdentity(outcome: Outcome, ctx: DeliverContext): string | undefined {
  if (!ctx.stopId && !ctx.deliveryId) return undefined;
  return createHash('sha256').update(JSON.stringify({
    sourceLabel: ctx.sourceLabel, sourceId: ctx.sourceId, status: outcome.status,
    ...(ctx.stopId ? { stopId: ctx.stopId } : { deliveryId: ctx.deliveryId }),
  })).digest('hex');
}

function retainedPassiveOutcome(sessionId: string, outcome: Outcome, ctx: DeliverContext, text: string): EventRow | undefined {
  if (ctx.stopId || ctx.deliveryId) {
    const identityField = ctx.deliveryId ? 'outcomeDeliveryId' : 'outcomeStopId';
    const row = openEventLog().prepare(`SELECT id FROM events
      WHERE session_id = ? AND type = 'user_input_received' AND json_valid(data_json)
        AND json_extract(data_json, '$.synthetic') = 1 AND json_extract(data_json, '$.source') = 'outcome'
        AND json_extract(data_json, '$.sourceLabel') = ? AND json_extract(data_json, '$.sourceId') = ?
        AND json_extract(data_json, '$.status') = ? AND json_extract(data_json, '$.deliveryPhase') = 'passive'
        AND json_extract(data_json, '$.${identityField}') = ? ORDER BY seq ASC LIMIT 1`)
      .get(sessionId, ctx.sourceLabel, ctx.sourceId, outcome.status, ctx.deliveryId ?? ctx.stopId) as { id: string } | undefined;
    return row ? getEvent(row.id) ?? undefined : undefined;
  }
  // Identity must survive long chats and restart recovery, not just the last
  // 200 inputs. Read only matching passive rows, never the full transcript.
  const row = openEventLog().prepare(`SELECT id FROM events
    WHERE session_id = ? AND type = 'user_input_received' AND role = 'user' AND json_valid(data_json)
      AND json_extract(data_json, '$.synthetic') = 1 AND json_extract(data_json, '$.source') = 'outcome'
      AND json_extract(data_json, '$.sourceLabel') = ? AND json_extract(data_json, '$.sourceId') = ?
      AND json_extract(data_json, '$.deliveryPhase') = 'passive'
      AND ((? = 'needs_input' AND json_extract(data_json, '$.status') = 'needs_input' AND json_extract(data_json, '$.text') = ?)
        OR (? != 'needs_input' AND json_extract(data_json, '$.status') IN ('done', 'blocked', 'failed')))
    ORDER BY seq ASC LIMIT 1`).get(sessionId, ctx.sourceLabel, ctx.sourceId, outcome.status, text, outcome.status) as { id: string } | undefined;
  return row ? getEvent(row.id) ?? undefined : undefined;
}

function stageOutcomeSnapshot(sessionId: string, outcome: Outcome, ctx: DeliverContext, text: string): void {
  try { HarnessSession.load(sessionId)?.injectSyntheticUserTurn(outcomePrefix(ctx), text, outcomeReportIdentity(outcome, ctx)); }
  catch { /* a snapshot write must never affect run state; replay repairs the gap */ }
}

function hasExactOutcomeDelivery(sessionId: string, outcome: Outcome, ctx: DeliverContext, text: string): boolean {
  const row = openEventLog().prepare(`SELECT session_id, data_json FROM events
    WHERE type = 'user_input_received' AND json_valid(data_json)
      AND json_type(data_json, '$.outcomeDeliveryId') = 'text'
      AND json_extract(data_json, '$.outcomeDeliveryId') = ?`).get(ctx.deliveryId) as
      { session_id: string; data_json: string } | undefined;
  if (!row) return false;
  const data = JSON.parse(row.data_json);
  if (row.session_id !== sessionId || data.synthetic !== true || data.source !== 'outcome'
    || data.sourceLabel !== ctx.sourceLabel || data.sourceId !== ctx.sourceId
    || data.status !== outcome.status || data.deliveryPhase !== 'passive' || data.text !== text
    || data.publicReportText !== renderPublicOutcomeText(outcome, ctx)
    || (data.resumable === true) !== (outcome.resumable === true) || data.outcomeStopId !== ctx.stopId) {
    throw new Error('Outcome delivery identity conflicts with its retained destination or content.');
  }
  return true;
}

function appendGoalEvidence(sessionId: string, outcome: Outcome, ctx: DeliverContext): void {
  try {
    const head = (outcome.summary ?? outcome.detail ?? '').trim();
    if (head) {
      appendGoalLedgerForSession(
        sessionId,
        `${ctx.sourceLabel} "${ctx.title ?? ctx.sourceId}" ${outcome.status}: ${head.slice(0, 120)}`,
      );
    }
  } catch { /* goal ledger is best-effort */ }
}

function isSyntheticOutcomeForSource(
  event: Pick<EventRow, 'type' | 'data'>,
  ctx: Pick<DeliverContext, 'sourceLabel' | 'sourceId'>,
): boolean {
  const data = event.data;
  return event.type === 'user_input_received'
    && data?.synthetic === true
    && data?.source === 'outcome'
    && data?.sourceLabel === ctx.sourceLabel
    && data?.sourceId === ctx.sourceId;
}

export function proactiveReportLastEventAgeMs(
  events: Array<Pick<EventRow, 'type' | 'data' | 'createdAt'>>,
  ctx: Pick<DeliverContext, 'sourceLabel' | 'sourceId'>,
  nowMs = Date.now(),
): number | null {
  let latestMs: number | null = null;
  for (const event of events) {
    if (isSyntheticOutcomeForSource(event, ctx)) continue;
    const ts = Date.parse(event.createdAt);
    if (!Number.isFinite(ts)) continue;
    latestMs = latestMs === null ? ts : Math.max(latestMs, ts);
  }
  return latestMs === null ? null : Math.max(0, nowMs - latestMs);
}

function reportDigest(outcome: Outcome, ctx: DeliverContext, text: string): string {
  return createHash('sha256').update(JSON.stringify({
    sourceLabel: ctx.sourceLabel, sourceId: ctx.sourceId, status: outcome.status,
    ...(ctx.stopId ? { stopId: ctx.stopId } : ctx.deliveryId ? { deliveryId: ctx.deliveryId } : { text }),
  })).digest('hex');
}

function reportSource(sessionId: string, digest: string): EventRow | undefined {
  const row = openEventLog().prepare(`SELECT id FROM events WHERE session_id = ?
    AND type = 'user_input_received' AND json_valid(data_json)
    AND json_extract(data_json, '$.synthetic') = 1 AND json_extract(data_json, '$.source') = 'outcome'
    AND json_extract(data_json, '$.deliveryPhase') = 'report'
    AND json_extract(data_json, '$.outcomeDigest') = ? ORDER BY seq LIMIT 1`)
    .get(sessionId, digest) as { id: string } | undefined;
  return row ? getEvent(row.id) ?? undefined : undefined;
}

function retainedReportInput(passive: EventRow): { outcome: Outcome; ctx: DeliverContext } {
  if (!isBackgroundOutcomeSource(passive) || passive.data.deliveryPhase !== 'passive'
    || !['done', 'blocked', 'failed', 'needs_input'].includes(String(passive.data.status))
    || typeof passive.data.publicReportText !== 'string') throw new Error('Retained outcome is not a publishable result.');
  return { outcome: { status: passive.data.status as OutcomeStatus, resumable: passive.data.resumable === true },
    ctx: { originSessionId: passive.sessionId, sourceLabel: passive.data.sourceLabel as string,
      sourceId: passive.data.sourceId as string, proactiveTurn: true,
      ...(typeof passive.data.outcomeStopId === 'string' ? { stopId: passive.data.outcomeStopId } : {}),
      ...(typeof passive.data.outcomeDeliveryId === 'string' ? { deliveryId: passive.data.outcomeDeliveryId } : {}) } };
}

function reportIsPublished(passive: EventRow): boolean {
  const { outcome, ctx } = retainedReportInput(passive);
  const source = reportSource(passive.sessionId, reportDigest(outcome, ctx, passive.data.publicReportText as string));
  if (!source) return false;
  const row = openEventLog().prepare(`SELECT data_json FROM events WHERE session_id = ?
    AND type = 'conversation_completed' AND json_valid(data_json)
    AND json_extract(data_json, '$.sourceUserSeq') = ? ORDER BY seq LIMIT 1`)
    .get(passive.sessionId, source.seq) as { data_json: string } | undefined;
  if (!row) return false;
  const presentation = presentationEventFromCompletionData(JSON.parse(row.data_json));
  return presentation?.identity.sessionId === passive.sessionId
    && presentation.identity.sourceUserSeq === source.seq && presentation.status === outcome.status
    && presentation.text === source.data.text;
}

/** A display retry only reads the immutable accepted result. Its pending row
 * is deleted after the exact canonical terminal exists, including recovery
 * after a crash between publication and acknowledgement. */
function publishPendingReport(passive: EventRow): boolean {
  const { outcome, ctx } = retainedReportInput(passive);
  if (!reportIsPublished(passive)) {
    const result = fireProactiveReportTurnImpl
      ? fireProactiveReportTurnImpl(passive.sessionId, outcome, ctx)
      : publishOutcomeSource(passive.sessionId, outcome, ctx, passive);
    // Compatibility seam for tests that deliberately observe passive staging.
    // An async callback is never itself proof of public delivery.
    if (result && typeof result.then === 'function') void result.catch(() => {});
  }
  if (!reportIsPublished(passive)) return false;
  openEventLog().prepare('DELETE FROM outcome_reports_pending_v1 WHERE source_event_id = ? AND session_id = ?')
    .run(passive.id, passive.sessionId);
  return true;
}

/** The worker has already authored and settled the result. Relay its exact
 * words through the public committer. The separate source is delivery identity
 * only and grants no execution, review, approval or external-send authority. */
export function publishProactiveOutcome(sessionId: string, outcome: Outcome, ctx: DeliverContext): void {
  const text = renderOutcomeText(outcome, ctx);
  if (ctx.deliveryId) hasExactOutcomeDelivery(sessionId, outcome, ctx, text);
  publishOutcomeSource(sessionId, outcome, ctx, retainedPassiveOutcome(sessionId, outcome, ctx, text));
}

function publishOutcomeSource(sessionId: string, outcome: Outcome, ctx: DeliverContext, passive?: EventRow): void {
  const renderedText = typeof passive?.data.publicReportText === 'string'
    ? passive.data.publicReportText : renderPublicOutcomeText(outcome, ctx);
  const digest = reportDigest(outcome, ctx, renderedText);
  // A crash between acceptance and publication reuses this exact identity.
  const source = withEventPublicationTransaction(() => reportSource(sessionId, digest) ?? appendEvent({
    sessionId, turn: 0, role: 'user', type: 'user_input_received',
    data: { text: renderedText, synthetic: true, source: 'outcome', sourceLabel: ctx.sourceLabel,
      sourceId: ctx.sourceId, status: outcome.status, deliveryPhase: 'report', outcomeDigest: digest,
      ...(ctx.stopId ? { outcomeStopId: ctx.stopId } : {}), resumable: passive ? passive.data.resumable === true : outcome.resumable === true },
  }));
  // The first accepted report owns presentation as well as identity. Wording
  // changes on replay must not conflict with its already committed terminal.
  const text = source.data.text as string;
  const resumable = source.data.resumable === undefined ? outcome.resumable === true : source.data.resumable === true;
  const identity = { sessionId, sourceUserSeq: source.seq, turn: source.turn };
  const base = { version: 2 as const, id: turnOutcomeId(identity), identity };
  const terminal: TurnOutcome = outcome.status === 'done'
    ? { ...base, status: 'done', resumable: false, presentation: { kind: 'answer', text } }
    : outcome.status === 'needs_input'
      ? { ...base, status: 'needs_input', resumable: true, needs: { kind: 'input' }, presentation: { kind: 'question', text } }
      : outcome.status === 'blocked'
        ? { ...base, status: 'blocked', resumable, presentation: { kind: 'blocked', text } }
        : { ...base, status: 'failed', resumable: false, presentation: { kind: 'error', text } };
  const published = commitTurnOutcome(terminal);
  if (published.presentation.identity.sourceUserSeq !== source.seq || published.presentation.text !== text
    || published.presentation.status !== outcome.status) throw new Error('Outcome publication is not yet certified.');
}

/** Public result, without runtime instructions or a second truncation pass.
 * Large results already carry their durable file reference in the outbox. */
export function renderPublicOutcomeText(outcome: Outcome, ctx: DeliverContext): string {
  const parts: string[] = [];
  const evidence = renderOutcomeEvidence(outcome.evidence, 'owner');
  const summary = ownerFacingText(outcome.summary);
  const detail = ownerFacingText(outcome.detail);
  const blocker = ownerFacingText(outcome.blocker);
  const nextAction = ownerFacingText(outcome.nextAction);
  if (outcome.status !== 'done' && evidence) parts.push(evidence);
  if (summary) parts.push(summary);
  if (detail && detail !== summary) parts.push(detail);
  if (outcome.status === 'done' && evidence) parts.push(evidence);
  if (blocker && !parts.some(part => part.includes(blocker))) parts.push(blocker);
  if (nextAction && !parts.some(part => part.includes(nextAction))) parts.push(nextAction);
  return parts.join('\n\n') || `${ctx.title || ctx.sourceLabel}: ${DEFAULT_HEAD_WORDS[outcome.status]}.`;
}

type ProactiveReportFire = (sessionId: string, outcome: Outcome, ctx: DeliverContext) => void | Promise<void>;
let fireProactiveReportTurnImpl: ProactiveReportFire | null = null;
export function setProactiveReportFireForTest(fn: ProactiveReportFire | null): void {
  fireProactiveReportTurnImpl = fn;
}

// Older builds kept busy-chat deferrals in this file. Drain them into the same
// durable delivery path on upgrade; age is not evidence that a result arrived.
interface DeferredProactiveReport {
  sessionId: string;
  outcome: Outcome;
  ctx: Omit<DeliverContext, 'proactiveTurn'>;
  createdAt: string;
  attempts: number;
}
const DEFERRED_REPORTS_FILE = path.join(BASE_DIR, 'state', 'deferred-proactive-reports.json');

function migrateDeferredReports(): void {
  if (!fs.existsSync(DEFERRED_REPORTS_FILE)) return;
  // Each replacement intent serializes with other publishers. Remove the
  // file only after every entry is retained in the SQLite outbox. If a crash leaves
  // the file behind, exact delivery identity makes re-reading it harmless.
  const retainedBytes = fs.readFileSync(DEFERRED_REPORTS_FILE, 'utf8');
  const entries: DeferredProactiveReport[] = JSON.parse(retainedBytes);
  if (!Array.isArray(entries)) throw new Error('Invalid deferred outcome report file.');
  let allRetained = true;
  for (const entry of entries) {
    try {
      if (!entry || typeof entry.sessionId !== 'string' || !entry.outcome || !entry.ctx) {
        throw new Error('Invalid deferred outcome report entry.');
      }
      // Each entry commits independently. A missing destination cannot prevent
      // other saved results from reaching their own conversations.
      if (!retainHarnessOutcome(entry.outcome,
        { ...entry.ctx, originSessionId: entry.sessionId, proactiveTurn: true })) {
        throw new Error('Deferred outcome destination is not retained.');
      }
    } catch { allRetained = false; }
  }
  // Never delete the legacy owner before all replacement intents commit. Valid
  // entries are idempotent if an invalid sibling keeps this file for recovery.
  if (allRetained && fs.existsSync(DEFERRED_REPORTS_FILE)
    && fs.readFileSync(DEFERRED_REPORTS_FILE, 'utf8') === retainedBytes) fs.unlinkSync(DEFERRED_REPORTS_FILE);
}

/** Daemon tick: retry at most 50 retained display intents, oldest/least tried
 * first. No quiet-chat gate, expiration, model call or re-execution of work. */
export async function processDeferredProactiveReports(): Promise<void> {
  if ((getRuntimeEnv('CLEMMY_PROACTIVE_REPORT_DEFER', 'on') || 'on').trim().toLowerCase() === 'off') return;
  try { migrateDeferredReports(); }
  catch (err) { logger.warn({ err: err instanceof Error ? err.message : err }, 'deferred report migration remains pending'); }
  const db = openEventLog();
  const entries = db.prepare('SELECT source_event_id, session_id FROM outcome_reports_pending_v1 ORDER BY attempts, created_at LIMIT 50')
    .all() as Array<{ source_event_id: string; session_id: string }>;
  for (const entry of entries) {
    try {
      db.prepare('UPDATE outcome_reports_pending_v1 SET attempts = attempts + 1 WHERE source_event_id = ?').run(entry.source_event_id);
      const passive = getEvent(entry.source_event_id);
      if (!passive || passive.sessionId !== entry.session_id || getHarnessSession(entry.session_id)?.kind !== 'chat') continue;
      publishPendingReport(passive);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, sessionId: entry.session_id }, 'outcome display remains pending');
    }
  }
}

/** Retain immutable content and its publication intent in one transaction.
 * Non-chat destinations retain passive context only, as before. */
function retainHarnessOutcome(outcome: Outcome, ctx: DeliverContext): { written: boolean; event: EventRow; proactive: boolean } | null {
  const sessionId = ctx.originSessionId;
  if (!sessionId) return null;
  const harnessRow = getHarnessSession(sessionId);
  if (!harnessRow) return null;
  const text = renderOutcomeText(outcome, ctx);
  return withEventPublicationTransaction(() => {
    if (ctx.deliveryId) hasExactOutcomeDelivery(sessionId, outcome, ctx, text);
    const retained = retainedPassiveOutcome(sessionId, outcome, ctx, text);
    const event = retained ?? appendEvent({ sessionId, turn: 0, role: 'user', type: 'user_input_received', data: {
      text, synthetic: true, source: 'outcome', sourceLabel: ctx.sourceLabel, sourceId: ctx.sourceId,
      status: outcome.status, deliveryPhase: 'passive', publicReportText: renderPublicOutcomeText(outcome, ctx),
      ...(ctx.deliveryId ? { outcomeDeliveryId: ctx.deliveryId } : {}),
      ...(ctx.stopId ? { outcomeStopId: ctx.stopId } : {}),
      ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
      ...(outcome.blocker ? { blocker: outcome.blocker } : {}),
      ...(outcome.nextAction ? { nextAction: outcome.nextAction } : {}),
      ...(outcome.resumable !== undefined ? { resumable: outcome.resumable } : {}),
    } });
    const proactive = ctx.proactiveTurn === true && harnessRow.kind === 'chat';
    if (proactive) {
      // Validate before accepting an immediate-publication obligation.
      retainedReportInput(event);
      openEventLog().prepare(`INSERT INTO outcome_reports_pending_v1 (source_event_id, session_id, created_at)
        VALUES (?, ?, ?) ON CONFLICT(source_event_id) DO NOTHING`).run(event.id, sessionId, event.createdAt);
    }
    return { written: !retained, event, proactive };
  });
}

/**
 * Deliver an Outcome back to the conversation that started the work. For
 * harness-owned conversations, append a synthetic event to the harness eventlog;
 * for legacy desktop/mobile conversations, append to SessionStore. In both
 * cases, stage into the HarnessSession snapshot when one exists so the
 * orchestrator sees the report-back on its next turn. Idempotent by id-prefix
 * across retries / daemon restarts. Best-effort: never throws, never blocks the
 * run.
 *
 * Returns true if a turn was written, false if it was a no-op (no origin
 * session) or a duplicate.
 */
export function deliverOutcomeWithAcknowledgement(
  outcome: Outcome,
  ctx: DeliverContext,
): OutcomeDeliveryAcknowledgement {
  try {
    const sessionId = ctx.originSessionId;
    if (!sessionId) {
      return { acknowledged: true, written: false, disposition: 'not_applicable' };
    }
    const idPrefix = outcomePrefix(ctx);
    const text = renderOutcomeText(outcome, ctx);

    // Harness chats are the canonical desktop/Discord conversation store. Writing
    // their report-backs to sessions.json creates a same-raw-id "desktop:" ghost
    // that loses the original harness transcript on reopen.
    const delivery = retainHarnessOutcome(outcome, ctx);
    if (delivery) {
      stageOutcomeSnapshot(sessionId, outcome, ctx, delivery.event.data.text as string);
      if (delivery.written) appendGoalEvidence(sessionId, outcome, ctx);
      let acknowledged = !delivery.proactive;
      if (delivery.proactive) {
        try { acknowledged = publishPendingReport(delivery.event); }
        catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : err, sourceId: ctx.sourceId }, 'outcome display remains pending');
        }
      }
      return { acknowledged, written: delivery.written,
        disposition: acknowledged ? delivery.written ? 'delivered' : 'already_delivered' : 'failed' };
    }

    // A durable outbox must not create a legacy ghost after its canonical
    // conversation disappears. Keep its report pending for owner recovery.
    if (ctx.deliveryId) throw new Error('Outcome delivery destination is not retained.');
    const store = new SessionStore();
    if (sessionStoreHasOutcome(store, sessionId, outcome, ctx, text)) {
      return { acknowledged: true, written: false, disposition: 'already_delivered' };
    }
    store.appendTurn(sessionId, { role: 'user', text, createdAt: new Date().toISOString() });
    // Stage into the harness conversation snapshot so the desktop/Discord
    // orchestrator (which replays the snapshot, not this SessionStore) sees the
    // outcome on its next turn. Best-effort + idempotent.
    try {
      const hs = HarnessSession.load(sessionId);
      if (hs) hs.injectSyntheticUserTurn(idPrefix, text);
    } catch { /* a harness-store write must never affect run state */ }
    logger.info({ sourceId: ctx.sourceId, sessionId, status: outcome.status }, 'Outcome delivered to origin session');
    // Async-lane work (workflow run, background task) that reports back into a
    // session with an active goal becomes goal evidence — one ledger line so
    // the goal's progress timeline reflects sub-work it dispatched. Best-effort.
    appendGoalEvidence(sessionId, outcome, ctx);
    return { acknowledged: true, written: true, disposition: 'delivered' };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, sourceId: ctx.sourceId },
      'deliverOutcome failed (best-effort; run + notification unaffected)',
    );
    return { acknowledged: false, written: false, disposition: 'failed' };
  }
}

export function deliverOutcome(outcome: Outcome, ctx: DeliverContext): boolean {
  return deliverOutcomeWithAcknowledgement(outcome, ctx).written;
}
