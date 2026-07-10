/**
 * Two-turn convergence proof: ask one material question, then execute after the
 * answer. The artifact lives only in the isolated proof home.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { narrationCheck, openHarnessDb, reportBackCheck, sessionMetrics, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

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

interface ProofEvent {
  seq: number;
  type: string;
  data_json: string;
}

function sessionEvents(daemon: DaemonHandle, sessionId: string, afterSeq = 0): ProofEvent[] {
  const db = openHarnessDb(daemon.home);
  const rows = db.prepare(
    'SELECT seq, type, data_json FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC',
  ).all(sessionId, afterSeq) as ProofEvent[];
  db.close();
  return rows;
}

function toolNames(events: ProofEvent[]): string[] {
  const names: string[] = [];
  for (const event of events) {
    if (event.type !== 'tool_called') continue;
    try {
      const data = JSON.parse(event.data_json) as { tool?: unknown };
      if (typeof data.tool === 'string') names.push(data.tool);
    } catch { /* malformed telemetry is simply not a named tool */ }
  }
  return names;
}

function awaitingQuestions(events: ProofEvent[]): string[] {
  const questions: string[] = [];
  for (const event of events) {
    if (event.type !== 'awaiting_user_input') continue;
    try {
      const data = JSON.parse(event.data_json) as { question?: unknown };
      if (typeof data.question === 'string' && data.question.trim()) questions.push(data.question.trim());
    } catch { /* malformed pause telemetry cannot satisfy the proof */ }
  }
  return questions;
}

export const clarifyThenExecute: ScenarioDef = {
  name: 'clarify-then-execute',
  summary: 'one material question -> answer -> verified local artifact, no re-ask',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const sessionId = `proof-converge-${Date.now().toString(36)}`;
    const target = path.join(daemon.home, 'proof', 'clarify-then-execute.md');
    mkdirSync(path.dirname(target), { recursive: true });

    const turn1 = await daemon.chat(
      `Prepare a rollout brief at the exact local path ${JSON.stringify(target)} for the fictional Zephyr service. `
      + 'Once the audience is known, use write_file and verify the saved contents. The file must contain an exact '
      + 'AUDIENCE=<UPPERCASE_AUDIENCE> marker and sections headed Rollout, Rollback, and Verification. '
      + 'The intended audience is the only unresolved choice. Before writing anything, ask me only which audience it should target. '
      + 'Do not create or modify the file until I answer; after my answer, execute the saved brief without another question or a background offer.',
      sessionId,
      300_000,
    );
    const firstEvents = sessionEvents(daemon, sessionId);
    const cutoff = firstEvents.at(-1)?.seq ?? 0;
    const firstTools = toolNames(firstEvents);
    const firstAwaits = firstEvents.filter((event) => event.type === 'awaiting_user_input');
    const firstQuestions = awaitingQuestions(firstEvents);
    const firstMutations = firstTools.filter((name) => MUTATING_TOOLS.has(name));
    const artifactExistedAfterTurn1 = existsSync(target);

    const turn2 = await daemon.chat(
      'Engineers.',
      sessionId,
      420_000,
    );
    const secondEvents = sessionEvents(daemon, sessionId, cutoff);
    const secondTools = toolNames(secondEvents);
    const secondAwaits = secondEvents.filter((event) => event.type === 'awaiting_user_input');
    const secondApprovals = secondEvents.filter((event) => event.type === 'approval_requested');
    const backgroundTools = secondTools.filter((name) =>
      name === 'dispatch_background_task' || name === 'workflow_run' || name === 'run_worker');
    const artifact = existsSync(target) ? readFileSync(target, 'utf-8') : '';

    const checks: Check[] = [
      { name: 'turn 1 HTTP 200', pass: turn1.httpStatus === 200, detail: `status ${turn1.httpStatus}` },
      {
        name: 'turn 1 asks exactly one material clarification',
        pass: firstAwaits.length === 1
          && firstQuestions.length === 1
          && /audience|engineer|executive|operator/i.test(firstQuestions[0]),
        detail: `awaiting events ${firstAwaits.length}; questions ${JSON.stringify(firstQuestions)}; reply ${turn1.text.slice(0, 180)}`,
      },
      {
        name: 'turn 1 performs no mutation',
        pass: firstMutations.length === 0 && !artifactExistedAfterTurn1,
        detail: `mutating tools [${firstMutations.join(', ')}], artifact ${artifactExistedAfterTurn1 ? 'exists' : 'absent'}`,
      },
      { name: 'turn 2 HTTP 200', pass: turn2.httpStatus === 200, detail: `status ${turn2.httpStatus}` },
      reportBackCheck(turn2.text),
      narrationCheck(turn2.text),
      stormCheck(daemon.log()),
      {
        name: 'turn 2 executes write_file',
        pass: secondTools.includes('write_file'),
        detail: `tools [${secondTools.join(', ')}]`,
      },
      {
        name: 'artifact exists with audience and all required sections',
        pass: artifact.includes('AUDIENCE=ENGINEERS')
          && /^#{0,6}\s*Rollout\b/im.test(artifact)
          && /^#{0,6}\s*Rollback\b/im.test(artifact)
          && /^#{0,6}\s*Verification\b/im.test(artifact),
        detail: artifact ? artifact.slice(0, 260) : 'artifact missing',
      },
      {
        name: 'turn 2 does not re-ask, request approval, or background the work',
        pass: secondAwaits.length === 0 && secondApprovals.length === 0 && backgroundTools.length === 0,
        detail: `awaiting ${secondAwaits.length}, approvals ${secondApprovals.length}, background tools [${backgroundTools.join(', ')}]`,
      },
      {
        name: 'turn 2 closes with a result, not another question',
        pass: !/\?\s*$/.test(turn2.text.trim()),
        detail: turn2.text.slice(-180),
      },
    ];

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, sessionId);
      db.close();
    } catch { /* metrics are supplementary */ }

    return {
      checks,
      latency: [
        { wallMs: turn1.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? null },
        { wallMs: turn2.wallMs, ttftMs: metrics?.latency[1]?.ttftMs ?? null },
      ],
      sessionId,
      metrics: metrics ? { turns: metrics.turns, toolCallTotal: metrics.toolCallTotal, toolCalls: metrics.toolCalls } : undefined,
    };
  },
};
