/**
 * Real daemon restart proof. The process is stopped while a read-only manifest
 * batch has both completed and unfinished items, then booted against the same
 * isolated home. Already-succeeded worker packets must be reused, not run twice.
 */
import { narrationCheck, openHarnessDb, sessionMetrics, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import {
  compactManifestChecks,
  dispatchBackground,
  getBoardCards,
  manifestFor,
  proofSessionId,
  succeededWorkerItems,
  waitForBackground,
  waitForOutcomeEvents,
  waitForTerminal,
  workerExecutionCounts,
} from './background-proof-helpers.js';

const ITEMS = Array.from({ length: 32 }, (_, index) => `restart-item-${String(index + 1).padStart(2, '0')}`);
const MANIFEST_ID = 'proof-restart-resume';
const WORK_MANIFEST = {
  id: MANIFEST_ID,
  contractVersion: '1',
  phase: 'process',
  mode: 'declare',
  phases: [{ id: 'process', label: 'Process restart-safe items' }],
};

const PROMPT = [
  `Process these exact 32 fictional items: ${ITEMS.join(', ')}.`,
  'This is read-only and hermetic: do not write files, browse, call connected apps, or make external writes.',
  'Use exactly ONE batched run_worker call with the full items array and this exact packet:',
  '- objective: Produce a restart-safe deterministic observation for the assigned fictional item.',
  '- resolvedTools: none needed',
  '- context: Fictional proof data; the item id is the only input.',
  '- instructions: Include the exact item id and marker RESTART-SAFE. Do not use tools or delegate.',
  '- expectedOutput: ITEM_ID | RESTART-SAFE | processed',
  '- intent: writing',
  `- workManifest: ${JSON.stringify(WORK_MANIFEST)}`,
  'If the daemon restarts, repeat that same run_worker call with the exact same packet, including mode "declare". The durable worker ledger will reuse completed packets safely.',
  'Finish only when the manifest says all 32 items succeeded. Report exact coverage; the report itself is the requested deliverable.',
].join('\n');

export const restartResume: ScenarioDef = {
  name: 'restart-resume',
  summary: 'partial read-only swarm → real restart → same task/session resumes',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const originSessionId = proofSessionId('restart-origin');
    const dispatched = await dispatchBackground(daemon, originSessionId, PROMPT);
    const partial = await waitForBackground(
      daemon,
      dispatched.taskId,
      (detail) => {
        const manifest = manifestFor(detail, MANIFEST_ID);
        return detail.task.status === 'running'
          && Boolean(manifest && manifest.remaining > 0 && manifest.phases.some((phase) => phase.succeeded > 0));
      },
      { timeoutMs: 15 * 60_000, intervalMs: 100, label: 'mixed completed/incomplete restart window' },
    );
    const beforeTask = partial.detail.task;
    const completedBeforeRestart = succeededWorkerItems(daemon, beforeTask.runSessionId);
    await daemon.restart();
    const settled = await waitForTerminal(daemon, dispatched.taskId, 40 * 60_000);
    const task = settled.detail.task;
    const manifest = manifestFor(settled.detail, MANIFEST_ID);
    const executionCounts = workerExecutionCounts(daemon, task.runSessionId);
    const replayedSucceeded = completedBeforeRestart.filter((item) => (executionCounts.get(item) ?? 0) > 1);
    const outcomes = await waitForOutcomeEvents(
      daemon,
      dispatched.turn.sessionId,
      task.id,
      (outcomeRows) => outcomeRows.some((event) => ['done', 'blocked', 'failed'].includes(String(event.data.status))),
    );
    const terminalOutcomes = outcomes.filter((event) => ['done', 'blocked', 'failed'].includes(String(event.data.status)));
    const originCards = (await getBoardCards(daemon)).filter((card) => (
      card.sourceKind === 'background' && card.raw?.originSessionId === dispatched.turn.sessionId
    ));
    const result = task.resultFull ?? task.result ?? '';

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, task.runSessionId);
      db.close();
    } catch { /* checks below surface missing evidence */ }

    const checks: Check[] = [
      {
        name: 'restart occurred after durable partial progress',
        pass: completedBeforeRestart.length > 0 && Boolean(manifestFor(partial.detail, MANIFEST_ID)?.remaining),
        detail: `${completedBeforeRestart.length} worker item(s) succeeded before restart`,
      },
      {
        name: 'restart recovery stayed on the same task/session',
        pass: task.id === beforeTask.id && task.runSessionId === beforeTask.runSessionId && originCards.length === 1,
        detail: `task ${beforeTask.id}→${task.id}; session ${beforeTask.runSessionId}→${task.runSessionId}; origin tasks ${originCards.length}`,
      },
      {
        name: 'safe read-only restart auto-resumed in place',
        pass: (task.resumeCount ?? 0) >= 1
          && task.restartRecovery?.disposition === 'auto_resumed_in_place'
          && task.restartRecovery?.reason === 'safe_no_external_write'
          && task.restartRecovery?.externalWriteCount === 0
          && task.restartRecovery?.ambiguousWriteCount === 0,
        detail: JSON.stringify({ resumeCount: task.resumeCount, restartRecovery: task.restartRecovery }),
      },
      { name: 'restarted task completed', pass: task.status === 'done', detail: `${task.status}: ${task.error ?? result.slice(0, 220)}` },
      {
        name: 'restarted manifest completed exact universe',
        pass: Boolean(
          manifest
          && manifest.total === ITEMS.length
          && manifest.completed === ITEMS.length
          && manifest.remaining === 0
          && manifest.phases.every((phase) => phase.succeeded === ITEMS.length && phase.failed === 0),
        ),
        detail: manifest ? JSON.stringify({ total: manifest.total, phases: manifest.phases }) : 'manifest missing',
      },
      {
        name: 'already-succeeded workers were not executed again',
        pass: completedBeforeRestart.length > 0 && replayedSucceeded.length === 0,
        detail: replayedSucceeded.length
          ? `re-executed: ${replayedSucceeded.join(', ')}`
          : `${completedBeforeRestart.length} pre-restart successes reused`,
      },
      {
        name: 'exactly one terminal outcome returned to origin',
        pass: terminalOutcomes.length === 1 && terminalOutcomes[0]?.data.status === 'done',
        detail: JSON.stringify(outcomes.map((event) => event.data.status)),
      },
      narrationCheck(result),
      stormCheck(daemon.log()),
      ...compactManifestChecks(settled.detail, settled.bytes, MANIFEST_ID),
    ];

    return {
      checks,
      latency: [{
        wallMs: dispatched.turn.wallMs,
        ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null,
      }],
      sessionId: task.runSessionId,
      metrics: {
        completedBeforeRestart,
        resumeCount: task.resumeCount,
        restartRecovery: task.restartRecovery,
        manifest: manifest ?? null,
        toolCalls: metrics?.toolCalls,
        tokensUsed: metrics?.tokensUsed,
      },
    };
  },
};
