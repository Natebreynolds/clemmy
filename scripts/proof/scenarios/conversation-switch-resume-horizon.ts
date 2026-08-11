/**
 * Clem 4 mixed-conversation horizon.
 *
 * This is deliberately a conversation test, not a style test. It interleaves
 * memory, a connected read, a harmless digression, a correction, a local-write
 * clarification, a compound decline + fresh question, a daemon restart, task
 * resumption, and fresh-session recall. The proof grades truth, authority,
 * exact work performed, and byte consistency across the recorded conversation
 * surfaces; it does not claim raw model-output provenance where none is stored.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  measureAcceptedTurn,
  type AcceptedTurnMeasurement,
} from '../../session-comparison.js';
import {
  narrationCheck,
  openHarnessDb,
  reportBackCheck,
  stormCheck,
} from '../score.js';
import type { BrainKind, Check, DaemonHandle, ScenarioDef, TurnResult } from '../types.js';
import { staleValueAssertedAsCurrent } from './correction-sticks.js';
import {
  hasProviderEvidence,
  terminalConversationSurfacesPreserveBytes,
  verifiedReadOptimizationChecks as terminalVerifiedReadOptimizationChecks,
} from './discovery-reuse-horizon.js';

const IDENTIFIER = 'PROOF_LIST_TASKS';
const REVISION_ONE = 1;
const REVISION_TWO = 2;
const STALE_MEMORY = 'Cedar-12';
const CURRENT_MEMORY = 'Cedar-17';
const COMPOUND_ANSWER = 'No—leave that note alone. Instead, what is 15 × 9? Answer that naturally without tools.';

const MUTATING_TOOLS = new Set([
  'run_shell_command',
  'write_file',
  'edit_file',
  'space_save',
  'space_edit_view',
  'workflow_create',
  'workflow_run',
  'task_create',
  'pending_action_queue',
  'dispatch_background_task',
  'composio_execute_tool',
]);

const BACKGROUND_TOOLS = new Set([
  'dispatch_background_task',
  'workflow_run',
  'run_worker',
]);

interface ProofEvent {
  seq: number;
  type: string;
  data_json: string;
}

interface TerminalConversationSurface {
  completionVerdicts: number;
  reason: string | null;
  receiptKind: string | null;
  receiptPresentationDigest: string | null;
  receiptSourceUserSeq: number | null;
  transport: string | null;
  reply: string | null;
  presentationText: string | null;
}

interface AwaitingQuestion {
  question: string;
  options: string[];
  purpose: string | null;
}

interface ContinuityRow {
  consumed_by_source_user_seq: number | null;
  dismissed_reason: string | null;
  consumed_at: string | null;
  dismissed_at: string | null;
}

interface FileSnapshot {
  existed: boolean;
  content: Buffer | null;
}

interface StepRecord {
  id: string;
  turn: TurnResult;
  sourceUserSeq: number;
  measurement: AcceptedTurnMeasurement;
  events: ProofEvent[];
  terminal: TerminalConversationSurface | null;
}

function eventData(event: ProofEvent): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.data_json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function latestAcceptedSource(home: string, sessionId: string): number {
  const db = openHarnessDb(home);
  try {
    const row = db.prepare(`
      SELECT seq
      FROM events
      WHERE session_id = ?
        AND type = 'user_input_received'
        AND role = 'user'
        AND COALESCE(json_extract(data_json, '$.synthetic'), 0) != 1
      ORDER BY seq DESC
      LIMIT 1
    `).get(sessionId) as { seq?: unknown } | undefined;
    if (!row || typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq <= 0) {
      throw new Error(`accepted source missing for ${sessionId}`);
    }
    return row.seq;
  } finally {
    db.close();
  }
}

function sourceEvents(
  home: string,
  sessionId: string,
  sourceUserSeq: number,
  terminalSeq: number,
): ProofEvent[] {
  const db = openHarnessDb(home);
  try {
    return db.prepare(`
      SELECT seq, type, data_json
      FROM events
      WHERE session_id = ? AND seq >= ? AND seq <= ?
      ORDER BY seq ASC
    `).all(sessionId, sourceUserSeq, terminalSeq) as ProofEvent[];
  } finally {
    db.close();
  }
}

function terminalConversationSurface(
  home: string,
  sessionId: string,
  sourceUserSeq: number,
): TerminalConversationSurface | null {
  const db = openHarnessDb(home);
  try {
    const rows = db.prepare(`
      SELECT seq, data_json
      FROM events
      WHERE session_id = ?
        AND type = 'conversation_completed'
        AND COALESCE(
          json_extract(data_json, '$.sourceUserSeq'),
          json_extract(data_json, '$.presentation.identity.sourceUserSeq')
        ) = ?
      ORDER BY seq ASC
    `).all(sessionId, sourceUserSeq) as Array<{ seq: number; data_json: string }>;
    if (rows.length !== 1) return null;
    const data = JSON.parse(rows[0]!.data_json) as Record<string, unknown>;
    const presentation = data.presentation && typeof data.presentation === 'object'
      && !Array.isArray(data.presentation)
      ? data.presentation as Record<string, unknown>
      : null;
    const receipt = data.verifiedReadCompletionReceipt
      && typeof data.verifiedReadCompletionReceipt === 'object'
      && !Array.isArray(data.verifiedReadCompletionReceipt)
      ? data.verifiedReadCompletionReceipt as Record<string, unknown>
      : null;
    const completionVerdicts = db.prepare(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE session_id = ?
        AND seq > ?
        AND seq < ?
        AND type = 'verdict_recorded'
        AND json_extract(data_json, '$.door') = 'completion'
    `).get(sessionId, sourceUserSeq, rows[0]!.seq) as { count: number };
    return {
      completionVerdicts: completionVerdicts.count,
      reason: typeof data.reason === 'string' ? data.reason : null,
      receiptKind: typeof receipt?.kind === 'string' ? receipt.kind : null,
      receiptPresentationDigest: typeof receipt?.presentationDigest === 'string'
        ? receipt.presentationDigest
        : null,
      receiptSourceUserSeq: Number.isSafeInteger(receipt?.sourceUserSeq)
        ? receipt!.sourceUserSeq as number
        : null,
      transport: typeof data.transport === 'string' ? data.transport : null,
      reply: typeof data.reply === 'string' ? data.reply : null,
      presentationText: typeof presentation?.text === 'string' ? presentation.text : null,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function conversationSurfaceDetail(step: StepRecord): string {
  const delivered = step.turn.text.trim();
  return JSON.stringify({
    reason: step.terminal?.reason ?? null,
    transport: step.terminal?.transport ?? null,
    exactReplyMatches: step.terminal?.reply === step.turn.text,
    exactPresentationMatches: step.terminal?.presentationText === step.turn.text,
    replyMatches: step.terminal?.reply?.trim() === delivered,
    presentationMatches: step.terminal?.presentationText?.trim() === delivered,
  });
}

function verifiedReadOptimizationChecks(
  label: string,
  step: StepRecord,
  selectedBrain: BrainKind,
  expectedReceiptKind: 'single_collection_read' | 'read_discovery_scaffold',
): Check[] {
  return terminalVerifiedReadOptimizationChecks(
    label,
    step.terminal,
    step.turn.text,
    step.sourceUserSeq,
    selectedBrain,
    expectedReceiptKind,
  );
}

function awaitingQuestions(events: readonly ProofEvent[]): AwaitingQuestion[] {
  return events
    .filter((event) => event.type === 'awaiting_user_input')
    .flatMap((event) => {
      const data = eventData(event);
      if (typeof data.question !== 'string' || !data.question.trim()) return [];
      return [{
        question: data.question,
        options: Array.isArray(data.options)
          ? data.options.filter((option): option is string => typeof option === 'string')
          : [],
        purpose: typeof data.purpose === 'string' ? data.purpose : null,
      }];
    });
}

function binaryClarification(question: AwaitingQuestion): boolean {
  const choiceText = question.options.join('\n') || question.question;
  return question.purpose === 'clarification'
    && /(?:^|\b)(?:yes|go ahead|create)(?:\b|$)/i.test(choiceText)
    && /(?:^|\b)(?:no|don['’]?t|do not|leave|skip)(?:\b|$)/i.test(choiceText);
}

function continuityRow(
  home: string,
  sessionId: string,
  originSourceUserSeq: number,
): ContinuityRow | null {
  const db = openHarnessDb(home);
  try {
    return db.prepare(`
      SELECT consumed_by_source_user_seq, dismissed_reason, consumed_at, dismissed_at
      FROM task_continuity_packets
      WHERE session_id = ? AND originating_source_user_seq = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionId, originSourceUserSeq) as ContinuityRow | undefined ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function latestEventData(events: readonly ProofEvent[], type: string): Record<string, unknown> | null {
  const event = events.filter((candidate) => candidate.type === type).at(-1);
  return event ? eventData(event) : null;
}

function snapshotFile(file: string): FileSnapshot {
  return existsSync(file)
    ? { existed: true, content: readFileSync(file) }
    : { existed: false, content: null };
}

function restoreFile(file: string, snapshot: FileSnapshot): void {
  if (snapshot.existed && snapshot.content) writeFileSync(file, snapshot.content);
  else rmSync(file, { force: true });
}

function lines(home: string, name: string): string[] {
  const file = path.join(home, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

function learnedCapabilityCommitted(
  home: string,
  sessionId: string,
  sourceUserSeq: number,
): boolean {
  const root = path.join(home, 'memory', 'capability-aliases');
  if (!existsSync(root)) return false;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'aliases.db');
    if (!existsSync(file)) continue;
    let db: Database.Database | null = null;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      const row = db.prepare(`
        SELECT 1 AS committed
        FROM pending_learning AS pending
        WHERE pending.session_id = ?
          AND pending.source_user_seq = ?
          AND pending.identifier = ?
          AND pending.status = 'done'
          AND EXISTS (
            SELECT 1 FROM aliases AS alias
            WHERE alias.identifier = pending.identifier
              AND alias.klass = 'capability_only'
          )
        LIMIT 1
      `).get(sessionId, sourceUserSeq, IDENTIFIER) as { committed?: number } | undefined;
      if (row?.committed === 1) return true;
    } catch {
      // A concurrent learner may still be committing the SQLite row.
    } finally {
      db?.close();
    }
  }
  return false;
}

async function waitForLearnedCapability(
  home: string,
  sessionId: string,
  sourceUserSeq: number,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (learnedCapabilityCommitted(home, sessionId, sourceUserSeq)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return learnedCapabilityCommitted(home, sessionId, sourceUserSeq);
}

function exactToolShape(
  turn: AcceptedTurnMeasurement,
  expected: Record<string, number>,
): boolean {
  const actualKeys = Object.keys(turn.perTool).sort();
  const expectedKeys = Object.keys(expected).sort();
  return turn.canonicalTopLevelToolCalls
      === Object.values(expected).reduce((sum, count) => sum + count, 0)
    && JSON.stringify(actualKeys) === JSON.stringify(expectedKeys)
    && expectedKeys.every((tool) => turn.perTool[tool] === expected[tool]);
}

function noToolsFrom(measurement: AcceptedTurnMeasurement, tools: ReadonlySet<string>): boolean {
  return Object.keys(measurement.perTool).every((tool) => !tools.has(tool));
}

function exactModelEvidence(label: string, step: StepRecord): Check[] {
  return [
    {
      name: `${label}: exactly one brain route`,
      pass: step.measurement.exactModelRouteEvents === 1
        && step.measurement.modelRouteEvents === 1,
      detail: `exact=${step.measurement.exactModelRouteEvents}, total=${step.measurement.modelRouteEvents}`,
    },
    {
      name: `${label}: usage is exact-source certified`,
      pass: step.measurement.exactUsageRecords >= 1
        && step.measurement.usageAttributionCertified,
      detail: JSON.stringify({
        exactUsageRecords: step.measurement.exactUsageRecords,
        attribution: step.measurement.usageAttribution,
        issues: step.measurement.usageCertificationIssues,
      }),
    },
  ];
}

function buildStep(
  daemon: DaemonHandle,
  id: string,
  turn: TurnResult,
  sourceUserSeq: number,
): StepRecord {
  const measurement = measureAcceptedTurn(daemon.home, turn.sessionId, sourceUserSeq);
  return {
    id,
    turn,
    sourceUserSeq,
    measurement,
    events: sourceEvents(
      daemon.home,
      turn.sessionId,
      sourceUserSeq,
      measurement.terminalSeq,
    ),
    terminal: terminalConversationSurface(daemon.home, turn.sessionId, sourceUserSeq),
  };
}

function acceptedSource(turn: TurnResult, label: string): number {
  if (!turn.sourceUserSeq) {
    throw new Error(`${label} durable ingress did not return an exact accepted source`);
  }
  return turn.sourceUserSeq;
}

/** Root-clause isolation is semantic, not stylistic: the new arithmetic clause
 * must drive retrieval while the declined note clause stays out of that query. */
export function compoundSemanticScopeIsFreshOnly(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return /15\s*(?:×|x|\*)\s*9/i.test(normalized)
    && !/\b(?:note|leave|uncreated|create|file)\b/i.test(normalized);
}

/** A reply may quote both values, but it must identify the correction and may
 * never assert the retired value as current. No tone or sentence shape is set. */
export function correctedMemoryReplyIsTruthful(text: string): boolean {
  return text.includes(CURRENT_MEMORY)
    && !staleValueAssertedAsCurrent(text, STALE_MEMORY);
}

const PROOF_INTEGER_WORD_PATTERNS = new Map<number, string>([
  [56, 'fifty[\\s-]+six'],
  [135, 'one[\\s-]+hundred(?:[\\s-]+and)?[\\s-]+thirty[\\s-]+five'],
]);

/** Proof answers may use digits or ordinary English number words. Grading the
 * value instead of its typography keeps this horizon conversational without
 * weakening the exact arithmetic assertion. */
export function replyContainsInteger(text: string, expected: number): boolean {
  const wordPattern = PROOF_INTEGER_WORD_PATTERNS.get(expected);
  if (!wordPattern) return false;
  const normalized = text
    .normalize('NFKC')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[’]/g, "'")
    .replace(/[*_~`]/g, '');
  const candidatePattern = new RegExp(
    `(?<![a-z0-9-])(?:${String(expected)}|${wordPattern})(?![a-z0-9-])`,
    'gi',
  );

  for (const match of normalized.matchAll(candidatePattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = normalized.slice(Math.max(0, start - 48), start);
    const after = normalized.slice(end, Math.min(normalized.length, end + 48));
    const deniedBefore = /(?:\bnot|\bnever|\bisn't|\bwasn't|\bincorrectly)\s*$/i.test(before);
    const deniedAfter = /^\s*(?:(?:is|was|would be|=)\s+)?(?:not\s+(?:(?:the|an)\s+)?(?:answer|result|correct)|wrong|incorrect)\b/i.test(after)
      || /^\s*(?:isn't|wasn't)\s+(?:(?:the|an)\s+)?(?:answer|result|correct)\b/i.test(after);
    if (!deniedBefore && !deniedAfter) return true;
  }
  return false;
}

function aggregateMeasurements(steps: readonly StepRecord[]): Record<string, unknown> {
  const sum = (select: (measurement: AcceptedTurnMeasurement) => number): number =>
    steps.reduce((total, step) => total + select(step.measurement), 0);
  return {
    stepCount: steps.length,
    sumAcceptedTurnWallMs: sum((measurement) => measurement.turnWallMs ?? 0),
    promptTokens: sum((measurement) => measurement.promptTokens),
    cachedInputTokens: sum((measurement) => measurement.cachedInputTokens),
    uncachedInputTokens: sum((measurement) => measurement.uncachedInputTokens),
    outputTokens: sum((measurement) => measurement.outputTokens),
    usageRecords: sum((measurement) => measurement.usageRecords),
    canonicalTopLevelToolCalls: sum((measurement) => measurement.canonicalTopLevelToolCalls),
    discoveryOperations: sum((measurement) => measurement.discoveryOperations),
    sdkDurationMs: sum((measurement) => measurement.sdkDurationMs),
    providerDurationMs: sum((measurement) => measurement.providerDurationMs),
    allUsageCertified: steps.every((step) => step.measurement.usageAttributionCertified),
  };
}

export const conversationSwitchResumeHorizon: ScenarioDef = {
  name: 'conversation-switch-resume-horizon',
  summary: 'memory + discovery + digression + correction + compound decline + restart resumption',
  routeExpectation: 'exact-brain',
  expectedModelTurns: 9,
  benchmarkWorkload: {
    contractVersion: 1,
    horizonTurns: 9,
    connectedReads: 3,
    compoundArithmetic: '15x9',
    restartCount: 1,
  },
  async run(daemon: DaemonHandle, context?: { brain: BrainKind }) {
    if (!context) throw new Error('conversation horizon requires the explicitly selected proof brain');
    const { brain } = context;
    const suffix = Date.now().toString(36);
    const horizonSession = `proof-conversation-horizon-${suffix}`;
    const recallSession = `proof-conversation-recall-${suffix}`;
    const relativeTarget = path.join('proof', 'conversation-switch-resume.md');
    const target = path.join(daemon.home, relativeTarget);
    mkdirSync(path.dirname(target), { recursive: true });

    const connectionMarker = path.join(daemon.home, 'proof-composio-connected');
    const providerState = path.join(daemon.home, 'proof-task-feed-state.json');
    const connectionBefore = snapshotFile(connectionMarker);
    const providerStateBefore = snapshotFile(providerState);
    const searchBaseline = lines(daemon.home, 'proof-composio-searches.log').length;
    const dispatchBaseline = lines(daemon.home, 'proof-composio-dispatches.log').length;
    writeFileSync(connectionMarker, 'connected\n', 'utf8');
    writeFileSync(providerState, `${JSON.stringify({
      revision: REVISION_ONE,
      id: 'proof-release-1',
      title: 'Review the Clementine 4 release proof',
      status: 'open',
    }, null, 2)}\n`, 'utf8');
    const refreshed = await daemon.request('POST', '/api/composio/refresh', {});
    const horizonStartedAt = performance.now();

    try {
      const teach = await daemon.chat(
        `Please remember for later that Cedar's current release number is ${STALE_MEMORY}. A natural acknowledgement is enough.`,
        horizonSession,
        300_000,
      );
      const teachSeq = latestAcceptedSource(daemon.home, teach.sessionId);

      const cold = await daemon.acceptedChat([
        'Now retrieve the proof release queue current items from the connected local provider.',
        'You do not know the action identifier yet. Call composio_search_tools exactly once with query "proof release queue current items", choose its single read-only match, then call composio_execute_tool exactly once with that action and the empty argument object {}.',
        'Do not use other discovery, code mode, shell, workspace, or memory. Return the source marker, revision, item id, title, and status.',
      ].join('\n'), horizonSession, 300_000);
      const coldSeq = acceptedSource(cold, 'cold read');
      const learned = await waitForLearnedCapability(daemon.home, horizonSession, coldSeq);

      const digression = await daemon.acceptedChat(
        'Quick tangent: what is 8 × 7? Answer conversationally without tools.',
        horizonSession,
        300_000,
      );
      const digressionSeq = acceptedSource(digression, 'digression');

      const reuse = await daemon.acceptedChat([
        'Back to the proof release queue: refresh its current items from the same connected source.',
        'Reuse the capability already proved on this machine. Do not discover, inspect a contract, use code mode, shell, workspace, or memory.',
        'Return the source marker, revision, item id, title, and status.',
      ].join('\n'), horizonSession, 300_000);
      const reuseSeq = acceptedSource(reuse, 'learned reuse');

      const correction = await daemon.acceptedChat(
        `Small correction for later: Cedar's current release number is ${CURRENT_MEMORY}. ${STALE_MEMORY} is retired and must not be used as current. A natural acknowledgement is enough.`,
        horizonSession,
        300_000,
      );
      const correctionSeq = acceptedSource(correction, 'memory correction');

      const clarify = await daemon.acceptedChat(
        `I may want a tiny local note at the exact workspace-relative path ${JSON.stringify(relativeTarget)}. `
        + 'Before creating or changing anything, ask me in your own words whether I actually want it created. '
        + 'Use ask_user_question with purpose clarification and two explicit choices: create it, or leave it alone. '
        + 'There are no other unknowns. Do not touch the file until I answer.',
        horizonSession,
        300_000,
      );
      const clarifySeq = acceptedSource(clarify, 'local-note clarification');
      const absentAfterClarification = !existsSync(target);

      const compound = await daemon.acceptedChat(
        COMPOUND_ANSWER,
        horizonSession,
        300_000,
      );
      const compoundSeq = acceptedSource(compound, 'compound decline');
      const absentAfterCompound = !existsSync(target);

      writeFileSync(providerState, `${JSON.stringify({
        revision: REVISION_TWO,
        id: 'proof-release-1',
        title: 'Review the Clementine 4 release proof',
        status: 'done',
      }, null, 2)}\n`, 'utf8');
      await daemon.restart();

      const resumed = await daemon.acceptedChat([
        'Return to the proof release queue and refresh its current items now.',
        'The provider state may have changed. Use the capability already proved, perform a fresh read, and do not replay an old answer or rediscover anything.',
        'Return the source marker, revision, item id, title, and status.',
      ].join('\n'), horizonSession, 300_000);
      const resumedSeq = acceptedSource(resumed, 'post-restart resumption');

      const recalled = await daemon.chat(
        'What is Cedar\'s current release number now? You may mention the retired value only if you clearly label it retired.',
        recallSession,
        300_000,
      );
      const recalledSeq = latestAcceptedSource(daemon.home, recalled.sessionId);
      const horizonWallMs = Math.max(0, performance.now() - horizonStartedAt);

      const steps = [
        buildStep(daemon, 'teach_memory', teach, teachSeq),
        buildStep(daemon, 'cold_connected_read', cold, coldSeq),
        buildStep(daemon, 'digression', digression, digressionSeq),
        buildStep(daemon, 'learned_connected_reuse', reuse, reuseSeq),
        buildStep(daemon, 'correct_memory', correction, correctionSeq),
        buildStep(daemon, 'clarify_local_note', clarify, clarifySeq),
        buildStep(daemon, 'compound_decline_fresh_question', compound, compoundSeq),
        buildStep(daemon, 'restart_resume_connected_read', resumed, resumedSeq),
        buildStep(daemon, 'fresh_session_recall', recalled, recalledSeq),
      ];
      const byId = Object.fromEntries(steps.map((step) => [step.id, step])) as Record<string, StepRecord>;
      const teachStep = byId.teach_memory!;
      const coldStep = byId.cold_connected_read!;
      const digressionStep = byId.digression!;
      const reuseStep = byId.learned_connected_reuse!;
      const correctionStep = byId.correct_memory!;
      const clarifyStep = byId.clarify_local_note!;
      const compoundStep = byId.compound_decline_fresh_question!;
      const resumedStep = byId.restart_resume_connected_read!;
      const recallStep = byId.fresh_session_recall!;
      const clarifyQuestions = awaitingQuestions(clarifyStep.events);
      const compoundQuestions = awaitingQuestions(compoundStep.events);
      const compoundApprovals = compoundStep.events.filter((event) => event.type === 'approval_requested');
      const primer = latestEventData(compoundStep.events, 'turn_memory_primer');
      const contextPacket = latestEventData(compoundStep.events, 'agent_context_packet');
      const packetRow = continuityRow(daemon.home, horizonSession, clarifySeq);
      const searches = lines(daemon.home, 'proof-composio-searches.log').slice(searchBaseline);
      const dispatches = lines(daemon.home, 'proof-composio-dispatches.log').slice(dispatchBaseline);

      let activeCorrected = -1;
      try {
        const memoryDb = new Database(path.join(daemon.home, 'state', 'memory.db'), { readonly: true });
        activeCorrected = (memoryDb.prepare(`
          SELECT COUNT(*) AS count FROM consolidated_facts
          WHERE active = 1 AND lower(content) LIKE ?
        `).get(`%${CURRENT_MEMORY.toLowerCase()}%`) as { count: number }).count;
        memoryDb.close();
      } catch {
        // Surfaced by the store check below.
      }

      const allHttpOk = teach.httpStatus === 200
        && recalled.httpStatus === 200
        && [cold, digression, reuse, correction, clarify, compound, resumed]
          .every((turn) => turn.httpStatus === 202);
      const allConversationSurfaces = steps.every((step) =>
        terminalConversationSurfacesPreserveBytes({
          terminal: step.terminal,
          deliveredText: step.turn.text,
        }));
      const surfaceFailures = steps
        .filter((step) => !terminalConversationSurfacesPreserveBytes({
          terminal: step.terminal,
          deliveredText: step.turn.text,
        }))
        .map((step) => ({ id: step.id, detail: conversationSurfaceDetail(step) }));

      const checks: Check[] = [
        { name: 'proof-only local provider connected', pass: refreshed.status === 200, detail: `status ${refreshed.status}` },
        { name: 'all nine conversation turns completed on their intended ingress', pass: allHttpOk, detail: steps.map((step) => `${step.id}:${step.turn.httpStatus}`).join(', ') },
        stormCheck(daemon.log()),
        {
          name: 'all terminal, presentation, and delivered conversation surfaces are byte-identical',
          pass: allConversationSurfaces,
          detail: surfaceFailures.length === 0 ? 'all nine matched' : JSON.stringify(surfaceFailures),
        },
        ...verifiedReadOptimizationChecks(
          'cold connected read',
          coldStep,
          brain,
          'read_discovery_scaffold',
        ),
        ...verifiedReadOptimizationChecks(
          'learned connected reuse',
          reuseStep,
          brain,
          'single_collection_read',
        ),
        ...verifiedReadOptimizationChecks(
          'restart resumed read',
          resumedStep,
          brain,
          'single_collection_read',
        ),
        ...steps.flatMap((step) => [narrationCheck(step.turn.text)]),
        ...steps.flatMap((step) => exactModelEvidence(step.id, step)),
        {
          name: 'teaching memory does not bleed into connected-provider work',
          pass: teachStep.measurement.discoveryOperations === 0
            && !Object.prototype.hasOwnProperty.call(teachStep.measurement.perTool, IDENTIFIER)
            && searches.length >= 1,
          detail: JSON.stringify({ discovery: teachStep.measurement.discoveryOperations, tools: teachStep.measurement.perTool }),
        },
        {
          name: 'cold provider read returns revision 1 and pays exactly one discovery',
          pass: hasProviderEvidence(cold.text, REVISION_ONE, 'open', 'cold')
            && coldStep.measurement.discoveryOperations === 1
            && coldStep.measurement.discoveryClaimsByCategory.broad_discovery === 1
            && exactToolShape(coldStep.measurement, { composio_search_tools: 1, [IDENTIFIER]: 1 }),
          detail: JSON.stringify({ text: cold.text.slice(0, 220), discovery: coldStep.measurement.discoveryOperations, tools: coldStep.measurement.perTool }),
        },
        {
          name: 'verified cold read commits reusable capability evidence',
          pass: learned,
          detail: learned ? IDENTIFIER : 'learning artifact did not materialize within 20s',
        },
        {
          name: 'arithmetic digression is answered with zero tools or discovery',
          pass: replyContainsInteger(digression.text, 56)
            && exactToolShape(digressionStep.measurement, {})
            && digressionStep.measurement.discoveryOperations === 0,
          detail: JSON.stringify({ text: digression.text.slice(0, 180), tools: digressionStep.measurement.perTool, discovery: digressionStep.measurement.discoveryOperations }),
        },
        {
          name: 'return from digression reuses one learned read with zero rediscovery',
          pass: hasProviderEvidence(reuse.text, REVISION_ONE, 'open', 'reuse')
            && reuseStep.measurement.governorKnownCapability === true
            && reuseStep.measurement.discoveryOperations === 0
            && exactToolShape(reuseStep.measurement, { [IDENTIFIER]: 1 }),
          detail: JSON.stringify({ text: reuse.text.slice(0, 220), known: reuseStep.measurement.governorKnownCapability, tools: reuseStep.measurement.perTool, discovery: reuseStep.measurement.discoveryOperations }),
        },
        {
          name: 'memory correction stays conversational and does no connected-provider work',
          pass: correction.text.trim().length > 0
            && correctionStep.measurement.discoveryOperations === 0
            && !Object.prototype.hasOwnProperty.call(correctionStep.measurement.perTool, IDENTIFIER),
          detail: JSON.stringify({ text: correction.text.slice(0, 180), tools: correctionStep.measurement.perTool, discovery: correctionStep.measurement.discoveryOperations }),
        },
        {
          name: 'local-note turn asks one typed binary clarification in Clem\'s own words',
          pass: clarifyQuestions.length === 1 && binaryClarification(clarifyQuestions[0]!),
          detail: JSON.stringify({ questions: clarifyQuestions, reply: clarify.text.slice(0, 180) }),
        },
        {
          name: 'clarification performs no mutation before the answer',
          pass: absentAfterClarification
            && noToolsFrom(clarifyStep.measurement, MUTATING_TOOLS),
          detail: JSON.stringify({ absentAfterClarification, tools: clarifyStep.measurement.perTool }),
        },
        {
          name: 'compound decline answers its fresh arithmetic clause naturally',
          pass: replyContainsInteger(compound.text, 135)
            && reportBackCheck(compound.text).pass,
          detail: compound.text.slice(0, 220),
        },
        {
          name: 'compound decline revokes the note without re-ask, approval, background, or tools',
          pass: absentAfterCompound
            && compoundQuestions.length === 0
            && compoundApprovals.length === 0
            && noToolsFrom(compoundStep.measurement, BACKGROUND_TOOLS)
            && exactToolShape(compoundStep.measurement, {})
            && compoundStep.measurement.discoveryOperations === 0,
          detail: JSON.stringify({ absentAfterCompound, questions: compoundQuestions.length, approvals: compoundApprovals.length, tools: compoundStep.measurement.perTool, discovery: compoundStep.measurement.discoveryOperations }),
        },
        {
          name: 'compound root clause is typed as parent decline plus a fresh active clause',
          pass: packetRow?.consumed_by_source_user_seq === compoundSeq
            && packetRow.consumed_at !== null
            && packetRow.dismissed_at === null
            && packetRow.dismissed_reason === null,
          detail: JSON.stringify(packetRow),
        },
        {
          name: 'compound retrieval and semantic ranking use only the fresh clause',
          pass: compoundSemanticScopeIsFreshOnly(primer?.queryPreview)
            && compoundSemanticScopeIsFreshOnly(contextPacket?.inputPreview),
          detail: JSON.stringify({ primer: primer?.queryPreview ?? null, context: contextPacket?.inputPreview ?? null }),
        },
        {
          name: 'compound fresh clause keeps normal semantic processing instead of global decline short-circuit',
          pass: primer?.skippedReason !== 'declined_continuation'
            && contextPacket?.semanticEnrichmentSkippedReason !== 'declined_continuation',
          detail: JSON.stringify({ primerSkipped: primer?.skippedReason ?? null, contextSkipped: contextPacket?.semanticEnrichmentSkippedReason ?? null }),
        },
        {
          name: 'post-restart resumption reads fresh revision 2 without replay or rediscovery',
          pass: hasProviderEvidence(resumed.text, REVISION_TWO, 'done', 'correction')
            && resumedStep.measurement.terminalTransport !== 'completed_answer_replay'
            && resumedStep.measurement.governorKnownCapability === true
            && resumedStep.measurement.discoveryOperations === 0
            && exactToolShape(resumedStep.measurement, { [IDENTIFIER]: 1 }),
          detail: JSON.stringify({ text: resumed.text.slice(0, 240), transport: resumedStep.measurement.terminalTransport, known: resumedStep.measurement.governorKnownCapability, tools: resumedStep.measurement.perTool, discovery: resumedStep.measurement.discoveryOperations }),
        },
        {
          name: 'fresh session recalls only the corrected Cedar value as current',
          pass: correctedMemoryReplyIsTruthful(recalled.text),
          detail: recalled.text.slice(0, 240),
        },
        {
          name: 'corrected Cedar value reached the active durable store',
          pass: activeCorrected >= 1,
          detail: `active corrected facts: ${activeCorrected}`,
        },
        {
          name: 'whole mixed horizon pays one physical discovery and exactly three provider reads',
          pass: searches.length === 1
            && dispatches.length === 3
            && dispatches.every((slug) => slug === IDENTIFIER),
          detail: JSON.stringify({ searches: searches.length, dispatches }),
        },
      ];

      const aggregate = aggregateMeasurements(steps);
      return {
        checks,
        latency: steps.map((step) => ({
          wallMs: step.turn.wallMs,
          // No provider-neutral exact-source TTFT span exists yet. Keeping this
          // null is more accurate than attaching positional lifecycle rows.
          ttftMs: null,
        })),
        sessionId: horizonSession,
        routeSessions: [
          { sessionId: horizonSession, expectedModelTurns: 8 },
          { sessionId: recallSession, expectedModelTurns: 1 },
        ],
        metrics: {
          measurementContract: 'accepted-source-v1',
          ttftStatus: 'unavailable_until_exact_source_span',
          horizonWallMs,
          sumClientTurnWallMs: steps.reduce((sum, step) => sum + step.turn.wallMs, 0),
          ...aggregate,
          steps: Object.fromEntries(steps.map((step) => [step.id, {
            sourceUserSeq: step.sourceUserSeq,
            clientWallMs: step.turn.wallMs,
            acceptedTurn: step.measurement,
            reply: step.turn.text,
          }])),
          physicalSearches: searches.length,
          providerDispatches: dispatches.length,
          compoundScope: {
            continuity: packetRow,
            primerQueryPreview: primer?.queryPreview ?? null,
            contextInputPreview: contextPacket?.inputPreview ?? null,
            primerSkippedReason: primer?.skippedReason ?? null,
            semanticEnrichmentSkippedReason: contextPacket?.semanticEnrichmentSkippedReason ?? null,
          },
          activeCorrectedFacts: activeCorrected,
        },
      };
    } finally {
      restoreFile(connectionMarker, connectionBefore);
      restoreFile(providerState, providerStateBefore);
      try { await daemon.request('POST', '/api/composio/refresh', {}); } catch { /* best effort */ }
    }
  },
};
