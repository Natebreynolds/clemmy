/**
 * Mid-run course correction proof: revise a live task after its canonical
 * universe exists, then prove that v1 evidence became stale/revalidation work
 * instead of being silently banked against v2.
 */
import { narrationCheck, openHarnessDb, sessionMetrics, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import {
  compactManifestChecks,
  dispatchBackground,
  getBoardCards,
  manifestEventCounts,
  manifestFor,
  proofSessionId,
  sessionEvents,
  waitForBackground,
  waitForOutcomeEvents,
  waitForTerminal,
} from './background-proof-helpers.js';

const ITEMS = Array.from({ length: 24 }, (_, index) => `account-${String(index + 1).padStart(2, '0')}`);
const MANIFEST_ID = 'proof-live-steer';
const V1_MANIFEST = {
  id: MANIFEST_ID,
  contractVersion: '1',
  phase: 'research',
  mode: 'declare',
  phases: [{ id: 'research', label: 'Research accounts' }],
};

const PROMPT = [
  `Research these exact 24 fictional accounts: ${ITEMS.join(', ')}.`,
  'Do not browse, use connected apps, or make external writes.',
  'Use one batched run_worker call with the full items array and this exact packet:',
  '- objective: Produce a compact fictional account observation for the assigned item.',
  '- resolvedTools: none needed',
  '- context: Fictional proof data; the item id is the only source fact.',
  '- instructions: Include the exact item id and the marker BASELINE. No tools or delegation.',
  '- expectedOutput: ITEM_ID | BASELINE | one short observation',
  '- intent: writing',
  `- workManifest: ${JSON.stringify(V1_MANIFEST)}`,
  'A user may update this task while the worker batch is running. The latest durable task contract always overrides this v1 packet.',
  'If a contract v2 course correction appears, re-run ONE batched worker call over the exact same 24 items. Keep the objective, resolvedTools, context, intent, item universe, and manifest id unchanged.',
  'For that v2 call, REPLACE the instructions field with: Include the exact item id and the marker REVALIDATED. No tools or delegation. Do not include the BASELINE marker anywhere in the v2 packet or output.',
  'REPLACE expectedOutput with: ITEM_ID | REVALIDATED | one short observation. Set workManifest contractVersion to "2", phase "research", mode "reconcile".',
  'Finish only when the manifest for the latest contract says all 24 items succeeded. Report the active contract version and exact coverage.',
].join('\n');

export const backgroundSteerInFlight: ScenarioDef = {
  name: 'background-steer-in-flight',
  summary: 'running v1 manifest → revise in place → revalidate on v2',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const originSessionId = proofSessionId('steer-origin');
    const dispatched = await dispatchBackground(daemon, originSessionId, PROMPT);
    const inFlight = await waitForBackground(
      daemon,
      dispatched.taskId,
      (detail) => {
        const manifest = manifestFor(detail, MANIFEST_ID);
        return detail.task.status === 'running'
          && Boolean(manifest && manifest.remaining > 0 && manifest.phases.some((phase) => phase.running > 0));
      },
      { timeoutMs: 10 * 60_000, intervalMs: 100, label: 'manifest in-flight window' },
    );
    const beforeTask = inFlight.detail.task;
    const beforeManifest = manifestFor(inFlight.detail, MANIFEST_ID);
    const revision = await daemon.request(
      'POST',
      `/api/console/background-tasks/${encodeURIComponent(dispatched.taskId)}/contract-revisions`,
      {
        instruction: 'Contract v2: preserve the exact account universe, replace BASELINE with REVALIDATED, and revalidate every saved item before completion.',
        evidencePolicy: 'revalidate',
      },
    );
    const revisedBody = revision.json as { ok?: boolean; task?: ProofTaskRevision };
    const settled = await waitForTerminal(daemon, dispatched.taskId, 35 * 60_000);
    const task = settled.detail.task;
    const manifest = manifestFor(settled.detail, MANIFEST_ID);
    const events = manifestEventCounts(daemon, task.runSessionId, MANIFEST_ID);
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
    const runWorkerCalls = sessionEvents(daemon, task.runSessionId, ['tool_called'])
      .filter((event) => event.data.tool === 'run_worker');
    const runWorkerReturns = sessionEvents(daemon, task.runSessionId, ['tool_returned'])
      .filter((event) => event.data.tool === 'run_worker');
    const workerStarts = sessionEvents(daemon, task.runSessionId, ['worker_started']);
    const workerResults = sessionEvents(daemon, task.runSessionId, ['worker_result']);
    const workerReturnText = (event: (typeof runWorkerReturns)[number]): string => String(
      event.data.result ?? event.data.preview ?? event.data.output ?? '',
    );
    const successfulWorkerBatches = runWorkerReturns.filter((event) => (
      event.data.ok !== false && /^Batch complete:/i.test(workerReturnText(event))
    )).length;
    const rejectedBeforeDispatch = runWorkerReturns.filter((event) => (
      /workers were NOT started/i.test(workerReturnText(event))
    )).length;
    const targetOnlyReuses = workerResults.filter((event) => (
      /target already completed in this session/i.test(String(event.data.reason ?? ''))
    )).length;
    const revalidationBatchText = runWorkerReturns[1]
      ? workerReturnText(runWorkerReturns[1])
      : '';
    const revalidationPacketText = String(runWorkerCalls[1]?.data.arguments ?? '');

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, task.runSessionId);
      db.close();
    } catch { /* checks below surface missing evidence */ }

    const checks: Check[] = [
      {
        name: 'revision landed while logical work was in flight',
        pass: Boolean(beforeManifest && beforeManifest.remaining > 0 && beforeManifest.phases.some((phase) => phase.running > 0)),
        detail: JSON.stringify(beforeManifest?.phases ?? null),
      },
      {
        name: 'course correction accepted as contract v2',
        pass: revision.status === 200 && revisedBody.ok === true && revisedBody.task?.contractVersion === 2,
        detail: `HTTP ${revision.status}; ${JSON.stringify(revisedBody.task ?? revisedBody)}`,
      },
      {
        name: 'same task and run session survived steering',
        pass: task.id === beforeTask.id && task.runSessionId === beforeTask.runSessionId && originCards.length === 1,
        detail: `task ${beforeTask.id}→${task.id}; session ${beforeTask.runSessionId}→${task.runSessionId}; origin tasks ${originCards.length}`,
      },
      {
        name: 'v2 revision was applied durably',
        pass: task.contractVersion === 2
          && !task.pendingContractRevision
          && Boolean(task.contractRevisions?.some((entry) => entry.version === 2 && entry.appliedAt)),
        detail: JSON.stringify(task.contractRevisions ?? []),
      },
      { name: 'steered task completed', pass: task.status === 'done', detail: `${task.status}: ${task.error ?? result.slice(0, 220)}` },
      {
        name: 'latest manifest completed exact universe on v2',
        pass: Boolean(
          manifest
          && manifest.contractVersion === '2'
          && manifest.total === ITEMS.length
          && manifest.completed === ITEMS.length
          && manifest.remaining === 0
          && manifest.phases.every((phase) => phase.succeeded === ITEMS.length && phase.failed === 0),
        ),
        detail: manifest ? JSON.stringify({ version: manifest.contractVersion, total: manifest.total, phases: manifest.phases }) : 'manifest missing',
      },
      {
        name: 'v1 completions could not silently satisfy v2',
        pass: Boolean(manifest && manifest.staleCheckpoints > 0 && events.revisions >= 1 && events.versions.includes('2')),
        detail: `stale ${manifest?.staleCheckpoints ?? 0}; ${JSON.stringify(events)}`,
      },
      {
        name: 'one baseline batch plus one revalidation batch — no extra worker dispatch',
        pass: successfulWorkerBatches === 2
          && (metrics?.workerResults ?? 0) === ITEMS.length * 2,
        detail: `successful batches ${successfulWorkerBatches}; worker results ${metrics?.workerResults ?? 'unavailable'}; pre-dispatch refusals ${rejectedBeforeDispatch}; total run_worker calls ${metrics?.toolCalls['run_worker'] ?? 'unavailable'}`,
      },
      {
        name: 'revalidation wave executed fresh workers instead of target-only reuse',
        pass: workerStarts.length === ITEMS.length * 2 && targetOnlyReuses === 0,
        detail: `worker starts ${workerStarts.length}; target-only reuses ${targetOnlyReuses}`,
      },
      {
        name: 'revalidation dispatch packet replaced the superseded requirement',
        pass: /\|\s*REVALIDATED\s*\|/i.test(revalidationPacketText)
          && !/\|\s*BASELINE\s*\|/i.test(revalidationPacketText),
        detail: revalidationPacketText.slice(0, 220),
      },
      {
        name: 'revalidation work-product matches the active contract',
        pass: /\|\s*REVALIDATED\s*\|/i.test(revalidationBatchText)
          && !/\|\s*BASELINE\s*\|/i.test(revalidationBatchText),
        detail: revalidationBatchText.slice(0, 220),
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
        contractVersion: task.contractVersion,
        manifest: manifest ?? null,
        manifestEvents: events,
        toolCalls: metrics?.toolCalls,
        tokensUsed: metrics?.tokensUsed,
      },
    };
  },
};

interface ProofTaskRevision {
  id?: string;
  contractVersion?: number;
  status?: string;
}
