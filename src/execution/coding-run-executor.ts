/**
 * The daemon-side driver of coding runs — the only place a delegated coding
 * agent is ever started.
 *
 * The `project_run` tool only admits a run (a row in the coding-run store); it
 * never spawns. The daemon claims admitted runs on its own timer, holds a lease
 * while the agent works, and is the one writer of the run's live activity and
 * its settlement. A restart ends the agent process, and the next claim resumes
 * the agent's own session instead of failing the run.
 *
 * One run, one conversation between Clem and the agent: Clem sends the brief,
 * the agent works, and at every turn end Clem builds a receipt from git and her
 * own test run, reviews it, and either sends the agent back with what is still
 * missing or settles the run and reports back to the chat that asked for it.
 */
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import {
  appendEvent,
  createSession,
  getSession as getHarnessSession,
  updateSession,
  type EventType,
} from '../runtime/harness/eventlog.js';
import { redactSensitiveText } from '../runtime/security.js';
import { recordModelUsage } from '../runtime/usage-log.js';
import type { CodingAgentBridge, CodingAgentEvent, CodingAgentSession, CodingAgentUsage } from './coding-agent-bridge.js';
import { claudeCodingAgent } from './coding-agent-claude.js';
import { buildCodingAgentEnv } from './coding-run-env.js';
import { ensureRunWorktree, readGitEvidence } from './coding-run-git.js';
import { decideCodingToolUse } from './coding-run-policy.js';
import {
  buildCodingRunReceipt,
  renderCodingRunReceipt,
  reviewCodingRunReceipt,
  type CodingRunReceipt,
} from './coding-run-receipt.js';
import {
  claimNextCodingRun,
  getCodingRun,
  getCodingRunSettlement,
  isCodingRunStopRequested,
  listPendingCodingRunReportBacks,
  markCodingRunReportBackDelivered,
  markCodingRunSettling,
  recordCodingRunReportBackFailure,
  recordCodingRunUsageSnapshot,
  releaseCodingRunForResume,
  renewCodingRunLease,
  settleCodingRun,
  updateCodingRunProgress,
  type CodingAgentId,
  type CodingRunOutcome,
  type CodingRunRecord,
  type CodingRunSettlement,
  type CodingRunUsageTotals,
  type CodingRunVerdict,
} from './coding-run-store.js';

const logger = pino({ name: 'clementine.coding-runs' });

const LEASE_MS = 60_000;
const RENEW_EVERY_MS = 15_000;
const WATCH_EVERY_MS = 2_000;
const DRAIN_EVERY_MS = 3_000;
const ACTIVITY_TOUCH_EVERY_MS = 10_000;
const MAX_CONCURRENT_RUNS = 2;
/** A run whose agent process keeps dying is not coming back on its own. */
const MAX_RESUMES = 3;

const OWNER_ID = `daemon:${process.pid}:${randomUUID().slice(0, 8)}`;

const DEFAULT_BRIDGES: Record<CodingAgentId, CodingAgentBridge | null> = {
  claude: claudeCodingAgent,
  codex: null,
};
let bridges: Record<CodingAgentId, CodingAgentBridge | null> = { ...DEFAULT_BRIDGES };

export interface CodingRunPreflight {
  ok: boolean;
  /** Written for the user: what is missing and how they fix it. */
  reason?: string;
}

type PreflightFn = (agent: CodingAgentId) => Promise<CodingRunPreflight>;

async function defaultPreflight(agent: CodingAgentId): Promise<CodingRunPreflight> {
  const { resolveGuestHarnessBinary } = await import('./guest-harness.js');
  const label = agent === 'claude' ? 'Claude Code' : 'Codex';
  if (!resolveGuestHarnessBinary(agent)) {
    return { ok: false, reason: `${label} is not installed on this Mac. Install it from Connect → CLI tools, then run this again.` };
  }
  try {
    const { getCliHealth } = await import('../integrations/cli-catalog/auth-health.js');
    const health = await getCliHealth(agent === 'claude' ? 'claude-code' : 'codex');
    if (health.authStatus === 'signed_out') {
      return { ok: false, reason: `${label} is signed out. Sign in from Connect → CLI tools, then run this again.` };
    }
  } catch {
    // An unreadable health record is not a verdict; the agent's own start
    // reports a real sign-in failure.
  }
  return { ok: true };
}

let preflightImpl: PreflightFn = defaultPreflight;

/** Test seams — a coding run in a test must never reach a real CLI. */
export function setCodingRunBridgesForTests(next: Partial<Record<CodingAgentId, CodingAgentBridge | null>> | null): void {
  bridges = next ? { ...DEFAULT_BRIDGES, ...next } : { ...DEFAULT_BRIDGES };
}
export function setCodingRunPreflightForTests(fn: PreflightFn | null): void {
  preflightImpl = fn ?? defaultPreflight;
}

export function codingAgentLabel(agent: CodingAgentId): string {
  return agent === 'claude' ? 'Claude Code' : 'Codex';
}

/** Clem's standing instructions to the agent, appended to its own system prompt. */
export function codingAgentInstructions(run: Pick<CodingRunRecord, 'branch' | 'testCommand'>): string {
  return [
    'You are working for Clementine (Clem), an assistant who delegated this task to you and will review your work before reporting to the user.',
    `Your working directory is a git worktree created for this task, on branch ${run.branch}. Work only inside it.`,
    'Commit your changes on this branch as you go, with clear messages.',
    'Do not push, open pull requests, publish, deploy, or send anything off this machine. Clem carries the work further when the user asks.',
    run.testCommand ? `Clem will verify with \`${run.testCommand}\`; run it yourself before you finish.` : '',
    'When you are done, reply with a short summary of what you changed and how you verified it.',
  ].filter(Boolean).join('\n');
}

export function codingRunBrief(run: Pick<CodingRunRecord, 'objective' | 'brief' | 'acceptance' | 'testCommand'>): string {
  const parts = [`Task: ${run.objective}`];
  if (run.brief.trim() && run.brief.trim() !== run.objective.trim()) parts.push(run.brief.trim());
  if (run.acceptance.length) parts.push(`Done means:\n${run.acceptance.map((item) => `- ${item}`).join('\n')}`);
  if (run.testCommand) parts.push(`Verify with: ${run.testCommand}`);
  return parts.join('\n\n');
}

function resumeNote(run: Pick<CodingRunRecord, 'objective'>): string {
  return 'Clem here. Your session was interrupted (the app restarted or the connection dropped). '
    + 'Anything you were in the middle of may not have finished: check `git status` and `git log` first, '
    + `then carry on with the task: ${run.objective}`;
}

// ─── Live activity ────────────────────────────────────────────────────────

type ActivityKind =
  | 'status'
  | 'clem_message'
  | 'agent_message'
  | 'plan'
  | 'step_started'
  | 'step_finished'
  | 'permission'
  | 'review';

function emit(run: CodingRunRecord, type: EventType, role: string, data: Record<string, unknown>): void {
  try {
    appendEvent({
      sessionId: run.sessionId,
      turn: run.round + 1,
      role,
      type,
      data: { runId: run.runId, agent: run.agent, ...data },
    });
  } catch (error) {
    logger.warn({ runId: run.runId, error: error instanceof Error ? error.message : String(error) }, 'coding run activity write failed');
  }
}

function activity(run: CodingRunRecord, kind: ActivityKind, data: Record<string, unknown>, role = 'system'): void {
  emit(run, 'coding_run_activity', role, { kind, ...data });
}

function clip(text: string, max: number): string {
  const redacted = redactSensitiveText(text);
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

function publishAgentEvent(run: CodingRunRecord, event: CodingAgentEvent): void {
  switch (event.kind) {
    case 'message':
      activity(run, 'agent_message', { text: clip(event.text, 4_000), nested: event.nested }, 'agent');
      return;
    case 'plan':
      activity(run, 'plan', { items: event.items.slice(0, 40) }, 'agent');
      return;
    case 'step_started':
      activity(run, 'step_started', {
        stepId: event.stepId, tool: event.tool, detail: clip(event.detail, 300), nested: event.nested,
      }, 'agent');
      return;
    case 'step_finished':
      activity(run, 'step_finished', { stepId: event.stepId, ok: event.ok, output: clip(event.output, 1_500) }, 'agent');
      return;
    case 'permission':
      activity(run, 'permission', {
        stepId: event.stepId, tool: event.tool, detail: clip(event.detail, 300),
        decision: event.decision, effect: event.effect, reason: event.reason,
      });
      return;
    default:
      return;
  }
}

function ensureCodingSession(run: CodingRunRecord): void {
  if (getHarnessSession(run.sessionId)) return;
  try {
    createSession({
      id: run.sessionId,
      kind: 'agent',
      channel: 'coding',
      title: `${codingAgentLabel(run.agent)} · ${run.projectName}`,
      objective: run.objective,
      metadata: {
        source: 'coding-run',
        codingRunId: run.runId,
        originSessionId: run.originSessionId,
        agent: run.agent,
        projectName: run.projectName,
        branch: run.branch,
      },
    });
  } catch (error) {
    // A concurrent creator won the insert; the row existing is all we need.
    if (!getHarnessSession(run.sessionId)) throw error;
  }
}

// ─── Usage ───────────────────────────────────────────────────────────────

function recordUsageGrowth(run: CodingRunRecord, usage: CodingAgentUsage[]): void {
  const recorded = getCodingRun(run.runId)?.usageRecorded ?? run.usageRecorded;
  const next: Record<string, CodingRunUsageTotals> = { ...recorded };
  for (const entry of usage) {
    const before = recorded[entry.model] ?? { inputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 };
    const grow = (now: number, then: number): number => Math.max(0, now - then);
    const delta = {
      inputTokens: grow(entry.inputTokens, before.inputTokens),
      cachedInputTokens: grow(entry.cachedInputTokens, before.cachedInputTokens),
      cacheCreationInputTokens: grow(entry.cacheCreationInputTokens, before.cacheCreationInputTokens),
      outputTokens: grow(entry.outputTokens, before.outputTokens),
    };
    next[entry.model] = {
      inputTokens: Math.max(entry.inputTokens, before.inputTokens),
      cachedInputTokens: Math.max(entry.cachedInputTokens, before.cachedInputTokens),
      cacheCreationInputTokens: Math.max(entry.cacheCreationInputTokens, before.cacheCreationInputTokens),
      outputTokens: Math.max(entry.outputTokens, before.outputTokens),
    };
    if (delta.inputTokens + delta.cachedInputTokens + delta.cacheCreationInputTokens + delta.outputTokens === 0) continue;
    try {
      recordModelUsage({
        sessionId: run.originSessionId ?? run.sessionId,
        channel: 'guest-harness',
        model: entry.model,
        // Anthropic result usage: input excludes cache reads.
        cacheDialect: run.agent === 'claude' ? 'exclusive' : 'inclusive',
        ...(run.originSourceUserSeq ? { sourceUserSeq: run.originSourceUserSeq } : {}),
        ...(run.originAttemptId ? { attemptId: run.originAttemptId } : {}),
        inputTokens: delta.inputTokens,
        cachedInputTokens: delta.cachedInputTokens,
        cacheCreationInputTokens: delta.cacheCreationInputTokens,
        outputTokens: delta.outputTokens,
      });
    } catch { /* metering never fails a run */ }
  }
  recordCodingRunUsageSnapshot(run.runId, OWNER_ID, next);
}

// ─── Settlement and report-back ──────────────────────────────────────────

interface SettleInput {
  outcome: CodingRunOutcome;
  reason: string;
  receipt?: CodingRunReceipt | null;
  verdict?: CodingRunVerdict | null;
  verdictReason?: string | null;
}

async function settle(run: CodingRunRecord, input: SettleInput): Promise<CodingRunSettlement | null> {
  markCodingRunSettling(run.runId, OWNER_ID);
  // Without a full receipt (stopped, blocked, crashed) the branch still shows
  // what the agent got done; read it so the report says so.
  let receipt = input.receipt ?? null;
  let evidence = receipt?.evidence ?? null;
  if (!evidence && run.baseCommit) {
    try { evidence = await readGitEvidence(run.worktreePath, run.baseCommit); } catch { evidence = null; }
  }
  const settlement = settleCodingRun(run.runId, OWNER_ID, {
    outcome: input.outcome,
    reason: input.reason,
    headCommit: evidence?.headCommit ?? null,
    commits: evidence?.commits ?? [],
    diffStat: evidence?.diffStat ?? null,
    autoCommitted: receipt?.autoCommitted ?? false,
    testCommand: run.testCommand,
    testExitCode: receipt?.test ? receipt.test.exitCode : null,
    testTail: receipt?.test?.tail ?? null,
    finalMessage: receipt?.finalMessage ?? null,
    verdict: input.verdict ?? null,
    verdictReason: input.verdictReason ?? null,
  });
  if (!settlement) {
    logger.warn({ runId: run.runId }, 'coding run settle lost its lease; another owner holds it');
    return null;
  }
  emit(run, 'coding_run_settled', 'system', {
    outcome: settlement.outcome,
    reason: clip(settlement.reason, 600),
    branch: run.branch,
    projectName: run.projectName,
    headCommit: settlement.headCommit,
    commitCount: settlement.commits.length,
    filesChanged: settlement.diffStat?.filesChanged ?? 0,
    insertions: settlement.diffStat?.insertions ?? 0,
    deletions: settlement.diffStat?.deletions ?? 0,
    testExitCode: settlement.testExitCode,
    verdict: settlement.verdict,
  });
  try {
    updateSession(run.sessionId, {
      status: settlement.outcome === 'cancelled' ? 'cancelled'
        : settlement.outcome.startsWith('completed') ? 'completed' : 'failed',
    });
  } catch { /* the settlement row is the authority */ }
  void drainCodingRunReportBacks();
  return settlement;
}

function reportHeadline(run: CodingRunRecord, settlement: CodingRunSettlement): string {
  const who = codingAgentLabel(run.agent);
  switch (settlement.outcome) {
    case 'completed_verified': return `${who} finished in ${run.projectName}, and I checked the work`;
    case 'completed_unverified': return `${who} finished in ${run.projectName}; I could not verify it`;
    case 'blocked': return `${who} could not start in ${run.projectName}`;
    case 'cancelled': return `${who} stopped in ${run.projectName}`;
    default: return `${who} did not finish in ${run.projectName}`;
  }
}

function reportDetail(run: CodingRunRecord, settlement: CodingRunSettlement): string {
  const lines = [`Task: ${run.objective}`, settlement.reason];
  if (settlement.commits.length) {
    lines.push(`Branch \`${run.branch}\` has ${settlement.commits.length} commit(s):\n`
      + settlement.commits.slice(-10).map((c) => `- ${c.subject}`).join('\n'));
  }
  if (settlement.diffStat && settlement.diffStat.filesChanged > 0) {
    lines.push(`${settlement.diffStat.filesChanged} file(s) changed, +${settlement.diffStat.insertions} -${settlement.diffStat.deletions}.`);
  }
  if (settlement.testCommand) {
    lines.push(settlement.testExitCode === 0
      ? `\`${settlement.testCommand}\` passed when I ran it.`
      : `\`${settlement.testCommand}\` did not pass when I ran it (exit ${settlement.testExitCode ?? 'none'}).`);
  }
  if (settlement.finalMessage) lines.push(`${codingAgentLabel(run.agent)} said:\n${settlement.finalMessage.slice(0, 1_500)}`);
  if (settlement.outcome.startsWith('completed') && run.finishLine === 'local_branch') {
    lines.push(`The work is on the local branch \`${run.branch}\` (worktree ${run.worktreePath}). Nothing was pushed.`);
  }
  return lines.join('\n\n');
}

type ReportDeliverer = (run: CodingRunRecord, settlement: CodingRunSettlement) => boolean;
let reportDelivererForTests: ReportDeliverer | null = null;
export function setCodingRunReportDelivererForTests(fn: ReportDeliverer | null): void {
  reportDelivererForTests = fn;
}

async function deliverReport(run: CodingRunRecord, settlement: CodingRunSettlement): Promise<boolean> {
  if (reportDelivererForTests) return reportDelivererForTests(run, settlement);
  const { deliverOutcomeWithAcknowledgement } = await import('../runtime/outcome.js');
  const status = settlement.outcome.startsWith('completed') ? 'done'
    : settlement.outcome === 'blocked' ? 'blocked' : 'failed';
  const ack = deliverOutcomeWithAcknowledgement(
    { status, summary: reportHeadline(run, settlement), detail: reportDetail(run, settlement) },
    {
      originSessionId: run.originSessionId ?? undefined,
      sourceLabel: 'coding run',
      sourceId: run.runId,
      title: `${codingAgentLabel(run.agent)} · ${run.projectName}`,
      proactiveTurn: true,
    },
  );
  return ack.acknowledged;
}

let draining = false;
/** Deliver every settled run's report to the chat that asked for it. The
 *  outbox row was written with the settlement, so a crash in between still
 *  reports on the next pass; a stopped run needs no report. */
export async function drainCodingRunReportBacks(): Promise<number> {
  if (draining) return 0;
  draining = true;
  let delivered = 0;
  try {
    for (const pending of listPendingCodingRunReportBacks(20)) {
      const run = getCodingRun(pending.runId);
      const settlement = getCodingRunSettlement(pending.runId);
      if (!run || !settlement) continue;
      if (settlement.outcome === 'cancelled') {
        markCodingRunReportBackDelivered(pending.runId);
        continue;
      }
      try {
        if (await deliverReport(run, settlement)) {
          markCodingRunReportBackDelivered(pending.runId);
          delivered += 1;
        } else {
          recordCodingRunReportBackFailure(pending.runId, 'delivery not acknowledged');
        }
      } catch (error) {
        recordCodingRunReportBackFailure(pending.runId, error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    draining = false;
  }
  return delivered;
}

// ─── Driving one run ─────────────────────────────────────────────────────

interface ActiveRun {
  runId: string;
  session: CodingAgentSession | null;
  done: Promise<void>;
  release: () => void;
}

const active = new Map<string, ActiveRun>();
/** Set while the daemon hands its runs back for the next process to resume. */
let shuttingDown = false;

async function driveRun(claimed: CodingRunRecord, handle: ActiveRun): Promise<void> {
  let run = claimed;
  ensureCodingSession(run);
  const resuming = run.resumeCount > 0;

  const preflight = await preflightImpl(run.agent);
  const bridge = bridges[run.agent];
  if (!bridge) {
    await settle(run, { outcome: 'blocked', reason: `${codingAgentLabel(run.agent)} runs are not available in this version yet.` });
    return;
  }
  if (!preflight.ok) {
    await settle(run, { outcome: 'blocked', reason: preflight.reason ?? `${codingAgentLabel(run.agent)} is not ready.` });
    return;
  }
  if (!run.baseCommit) {
    await settle(run, { outcome: 'failed', reason: 'The run has no base commit to branch from.' });
    return;
  }
  const worktree = await ensureRunWorktree({
    projectPath: run.projectPath,
    worktreePath: run.worktreePath,
    branch: run.branch,
    baseCommit: run.baseCommit,
  });
  if (!worktree.ok) {
    await settle(run, { outcome: 'failed', reason: `Could not create the run's worktree: ${worktree.reason}` });
    return;
  }

  let resume = resuming && Boolean(run.agentSessionId);
  let agentSessionId = run.agentSessionId ?? randomUUID();
  if (!run.agentSessionId) updateCodingRunProgress(run.runId, OWNER_ID, { agentSessionId });
  run = getCodingRun(run.runId) ?? run;

  const label = codingAgentLabel(run.agent);
  if (resume) {
    activity(run, 'status', { state: 'resuming', text: `Reconnecting to ${label} in ${run.projectName}` });
  } else {
    activity(run, 'status', {
      state: 'started',
      text: `${label} is working in ${run.projectName} on ${run.branch}`,
      projectName: run.projectName,
      branch: run.branch,
      objective: clip(run.objective, 300),
    });
  }

  // One attempt of the agent process. Returns how it ended; a resume that
  // finds no transcript falls back once to a fresh start with the brief.
  const attempt = async (message: string): Promise<'settled' | 'lost' | 'ended' | 'no_session'> => {
    activity(run, 'clem_message', { text: clip(message, 4_000) }, 'Clem');
    const session = bridge.start({
      cwd: run.worktreePath,
      message,
      agentSessionId,
      resume,
      model: run.model,
      env: buildCodingAgentEnv(),
      instructions: codingAgentInstructions(run),
      decide: (tool, input) => decideCodingToolUse({ tool, input, worktreePath: run.worktreePath }),
    });
    handle.session = session;

    let settled = false;
    let lostLease = false;
    let sawSession = false;
    let lastError: string | null = null;
    let stopReason: 'stop' | 'deadline' | null = null;
    let lastTouch = 0;

    const renew = setInterval(() => {
      if (!renewCodingRunLease(run.runId, OWNER_ID, LEASE_MS)) {
        lostLease = true;
        session.close();
      }
    }, RENEW_EVERY_MS);
    const watch = setInterval(() => {
      if (stopReason) return;
      if (isCodingRunStopRequested(run.runId)) stopReason = 'stop';
      else if (Date.now() > Date.parse(run.deadlineAt)) stopReason = 'deadline';
      if (stopReason) {
        void session.interrupt().finally(() => session.close());
      }
    }, WATCH_EVERY_MS);
    renew.unref?.();
    watch.unref?.();

    try {
      for await (const event of session.events) {
        if (Date.now() - lastTouch > ACTIVITY_TOUCH_EVERY_MS) {
          lastTouch = Date.now();
          updateCodingRunProgress(run.runId, OWNER_ID, { touchActivity: true });
        }
        if (event.kind === 'session') {
          sawSession = true;
          if (event.agentSessionId !== agentSessionId) {
            agentSessionId = event.agentSessionId;
            updateCodingRunProgress(run.runId, OWNER_ID, { agentSessionId });
          }
          continue;
        }
        if (event.kind === 'error') {
          lastError = event.message;
          continue;
        }
        if (event.kind !== 'turn_completed') {
          publishAgentEvent(run, event);
          continue;
        }

        recordUsageGrowth(run, event.usage);
        if (stopReason) break;
        activity(run, 'status', { state: 'reviewing', text: `Checking ${label}'s work` });
        const receipt = await buildCodingRunReceipt(run, { finalMessage: event.finalMessage, ok: event.ok });
        const review = await reviewCodingRunReceipt(run, receipt);
        activity(run, 'review', {
          verdict: review.verdict,
          next: review.next,
          reason: clip(review.reason, 600),
          commitCount: receipt.evidence.commits.length,
          filesChanged: receipt.evidence.diffStat.filesChanged,
          testExitCode: receipt.test ? receipt.test.exitCode : null,
        }, 'Clem');
        if (review.next === 'continue' && review.followUp) {
          const round = run.round + 1;
          updateCodingRunProgress(run.runId, OWNER_ID, { round });
          run = getCodingRun(run.runId) ?? { ...run, round };
          activity(run, 'clem_message', { text: clip(review.followUp, 4_000) }, 'Clem');
          session.send(review.followUp, 'follow_up');
          continue;
        }
        const completed = review.verdict === 'pass' || review.verdict === 'unavailable';
        await settle(run, {
          outcome: review.verdict === 'pass' ? 'completed_verified'
            : review.verdict === 'unavailable' ? 'completed_unverified' : 'failed',
          reason: completed ? review.reason : `Still not done after ${run.round + 1} review round(s): ${review.reason}`,
          receipt,
          verdict: review.verdict,
          verdictReason: review.reason,
        });
        settled = true;
        session.close();
        break;
      }
    } finally {
      clearInterval(renew);
      clearInterval(watch);
      handle.session = null;
    }

    if (settled) return 'settled';
    if (lostLease) return 'lost';
    if (shuttingDown) return 'ended';
    if (stopReason === 'stop') {
      const current = getCodingRun(run.runId);
      await settle(run, { outcome: 'cancelled', reason: current?.stopReason ?? 'Stopped by the user.' });
      return 'settled';
    }
    if (stopReason === 'deadline') {
      await settle(run, { outcome: 'failed', reason: 'The run reached its four-hour ceiling and was stopped.' });
      return 'settled';
    }
    if (resume && !sawSession) {
      logger.warn({ runId: run.runId, lastError }, 'coding agent resume found no session; starting fresh');
      return 'no_session';
    }
    if (lastError) activity(run, 'status', { state: 'interrupted', text: clip(`${label} stopped unexpectedly: ${lastError}`, 400) });
    return 'ended';
  };

  let ended = await attempt(resume ? resumeNote(run) : codingRunBrief(run));
  if (ended === 'no_session') {
    resume = false;
    agentSessionId = randomUUID();
    updateCodingRunProgress(run.runId, OWNER_ID, { agentSessionId });
    ended = await attempt(codingRunBrief(run));
  }
  if (ended !== 'ended' || shuttingDown) return;

  // The agent process ended without Clem settling the run: a crash, a lost
  // connection, or a sign-in failure. Resume it a bounded number of times.
  const current = getCodingRun(run.runId);
  if (current && current.resumeCount < MAX_RESUMES && releaseCodingRunForResume(run.runId, OWNER_ID)) return;
  await settle(run, {
    outcome: 'failed',
    reason: `${label} kept stopping before the task was done (${(current?.resumeCount ?? 0) + 1} attempts).`,
  });
}

function launch(run: CodingRunRecord): void {
  let release = (): void => {};
  const handle: ActiveRun = {
    runId: run.runId,
    session: null,
    done: Promise.resolve(),
    release: () => release(),
  };
  handle.done = new Promise<void>((resolve) => { release = resolve; });
  active.set(run.runId, handle);
  void driveRun(run, handle)
    .catch(async (error) => {
      logger.error({ runId: run.runId, error: error instanceof Error ? error.message : String(error) }, 'coding run driver failed');
      try {
        await settle(run, { outcome: 'failed', reason: `Clem hit an internal error while driving the run: ${error instanceof Error ? error.message : String(error)}` });
      } catch { /* the lease expires and the next claim retries */ }
    })
    .finally(() => {
      active.delete(run.runId);
      handle.release();
    });
}

/** Claim and start as many runs as there are free slots. */
export async function drainCodingRunsOnce(nowMs = Date.now()): Promise<number> {
  let started = 0;
  while (active.size < MAX_CONCURRENT_RUNS) {
    const run = claimNextCodingRun(OWNER_ID, LEASE_MS, nowMs);
    if (!run) break;
    launch(run);
    started += 1;
  }
  await drainCodingRunReportBacks();
  return started;
}

/** Test seam: wait for every run this process is driving to finish. The
 *  executor's own timers are unref'd (the daemon keeps the process alive), so
 *  the wait holds the event loop open itself. */
export async function _waitForActiveCodingRunsForTests(): Promise<void> {
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await Promise.all([...active.values()].map((entry) => entry.done));
  } finally {
    clearInterval(keepAlive);
  }
}

let timer: NodeJS.Timeout | null = null;

export function startCodingRunExecutor(): void {
  if (timer) return;
  shuttingDown = false;
  const tick = (): void => {
    void drainCodingRunsOnce().catch((error) => {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'coding run drain failed');
    });
  };
  timer = setInterval(tick, DRAIN_EVERY_MS);
  timer.unref?.();
  tick();
}

/** Daemon shutdown: close every agent and hand its run to the next process
 *  to resume, rather than letting a dying process settle it as failed. */
export async function stopCodingRunExecutor(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  shuttingDown = true;
  for (const entry of active.values()) {
    releaseCodingRunForResume(entry.runId, OWNER_ID);
    entry.session?.close();
  }
  await Promise.race([
    Promise.all([...active.values()].map((entry) => entry.done)),
    new Promise((resolve) => setTimeout(resolve, 5_000).unref?.()),
  ]);
}

export function codingRunOwnerIdForTests(): string {
  return OWNER_ID;
}

export { renderCodingRunReceipt };
