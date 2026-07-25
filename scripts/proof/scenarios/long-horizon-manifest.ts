/**
 * Long-horizon manifest proof.
 *
 * The normal release leg uses 12 items over two phases so it proves graph
 * progression without consuming an unreasonable live-model budget. Set
 * CLEMMY_PROOF_LONG_HORIZON_ITEMS=120 for the endurance leg; that deliberately
 * uses one 120-item phase to prove scale without doubling it to 240 workers.
 */
import { narrationCheck, openHarnessDb, sessionMetrics, stormCheck, tokenCeilingCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import {
  compactManifestChecks,
  dispatchBackground,
  manifestEventCounts,
  manifestFor,
  proofSessionId,
  waitForOutcomeEvents,
  waitForTerminal,
} from './background-proof-helpers.js';

const requestedCount = Number.parseInt(process.env.CLEMMY_PROOF_LONG_HORIZON_ITEMS ?? '12', 10);
const ITEM_COUNT = Number.isFinite(requestedCount) ? Math.max(8, Math.min(120, requestedCount)) : 12;
const ITEMS = Array.from({ length: ITEM_COUNT }, (_, index) => `record-${String(index + 1).padStart(3, '0')}`);
const MANIFEST_ID = 'proof-long-horizon';
const TWO_PHASE = ITEM_COUNT <= 40;

function prompt(): string {
  const phases = TWO_PHASE
    ? [
      { id: 'analyze', label: 'Analyze records' },
      { id: 'validate', label: 'Validate records', dependsOn: ['analyze'] },
    ]
    : [{ id: 'analyze', label: 'Analyze records' }];
  const firstManifest = {
    id: MANIFEST_ID,
    contractVersion: '1',
    phase: 'analyze',
    mode: 'declare',
    phases,
  };
  const secondManifest = {
    id: MANIFEST_ID,
    contractVersion: '1',
    phase: 'validate',
    mode: 'reconcile',
  };
  return [
    `Process this exact set of ${ITEM_COUNT} fictional records: ${ITEMS.join(', ')}.`,
    'This is a hermetic analytical task: do not browse, call connected apps, or make external writes.',
    'Use ONE batched run_worker call with the full items array for the analyze phase. Use this exact shared packet:',
    '- objective: Produce one compact, deterministic quality observation for the assigned fictional record.',
    '- resolvedTools: none needed',
    '- context: Fictional proof data. The record id is the only input.',
    '- instructions: Return a concise observation containing the exact record id. No tools, no external data, no delegation.',
    '- expectedOutput: RECORD_ID | analyzed | one short quality observation',
    '- intent: writing',
    `- workManifest: ${JSON.stringify(firstManifest)}`,
    ...(TWO_PHASE ? [
      'After analyze succeeds, use ONE second batched run_worker call over the exact same items for validation. Use the same packet except:',
      '- objective: Validate that the assigned fictional record has an analyze observation.',
      '- instructions: Return a concise validation containing the exact record id. No tools or external data.',
      '- expectedOutput: RECORD_ID | validated | pass',
      `- workManifest: ${JSON.stringify(secondManifest)}`,
    ] : []),
    'Finish only after the durable manifest says every item completed every declared phase.',
    `Report the exact item count (${ITEM_COUNT}), phase count (${phases.length}), and whether every item completed. The result text is the requested deliverable.`,
  ].join('\n');
}

export const longHorizonManifest: ScenarioDef = {
  name: 'long-horizon-manifest',
  summary: `${ITEM_COUNT} logical items → durable phase graph → exact completion`,
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const originSessionId = proofSessionId('long-horizon-origin');
    const dispatched = await dispatchBackground(daemon, originSessionId, prompt());
    const settled = await waitForTerminal(daemon, dispatched.taskId, ITEM_COUNT >= 100 ? 60 * 60_000 : 30 * 60_000);
    const task = settled.detail.task;
    const manifest = manifestFor(settled.detail, MANIFEST_ID);
    const eventCounts = manifestEventCounts(daemon, task.runSessionId, MANIFEST_ID);
    const outcomes = await waitForOutcomeEvents(
      daemon,
      dispatched.turn.sessionId,
      task.id,
      (events) => events.some((event) => ['done', 'blocked', 'failed'].includes(String(event.data.status))),
    );
    const terminalOutcomes = outcomes.filter((event) => ['done', 'blocked', 'failed'].includes(String(event.data.status)));
    const result = task.resultFull ?? task.result ?? '';

    let metrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      metrics = sessionMetrics(db, task.runSessionId);
      db.close();
    } catch { /* checks below surface missing evidence */ }

    const phaseCount = TWO_PHASE ? 2 : 1;
    const checks: Check[] = [
      { name: 'background dispatch acknowledged', pass: dispatched.turn.httpStatus === 200, detail: `status ${dispatched.turn.httpStatus}` },
      { name: 'task completed', pass: task.status === 'done', detail: `${task.status}: ${task.error ?? result.slice(0, 220)}` },
      {
        name: `manifest contains exactly ${ITEM_COUNT} canonical items`,
        pass: manifest?.total === ITEM_COUNT,
        detail: manifest ? `${manifest.total} total` : 'manifest missing',
      },
      {
        name: `all items completed all ${phaseCount} phase(s)`,
        pass: Boolean(
          manifest
          && manifest.remaining === 0
          && manifest.completed === ITEM_COUNT
          && manifest.phases.length === phaseCount
          && manifest.phases.every((phase) => phase.succeeded === ITEM_COUNT && phase.failed === 0),
        ),
        detail: JSON.stringify(manifest?.phases ?? null),
      },
      {
        name: 'manifest has evidence with no ledger anomalies',
        pass: Boolean(
          manifest
          && manifest.evidenceCount >= ITEM_COUNT * phaseCount
          && manifest.staleCheckpoints === 0
          && manifest.untrackedCheckpoints === 0
          && manifest.anomalies.length === 0,
        ),
        detail: manifest
          ? `evidence ${manifest.evidenceCount}, stale ${manifest.staleCheckpoints}, untracked ${manifest.untrackedCheckpoints}, anomalies ${manifest.anomalies.length}`
          : 'manifest missing',
      },
      {
        name: 'durable manifest events were recorded',
        pass: eventCounts.declarations >= 1 && eventCounts.succeeded >= ITEM_COUNT * phaseCount,
        detail: JSON.stringify(eventCounts),
      },
      {
        name: 'exactly one terminal outcome returned to origin',
        pass: terminalOutcomes.length === 1 && terminalOutcomes[0]?.data.status === 'done',
        detail: JSON.stringify(outcomes.map((event) => event.data.status)),
      },
      narrationCheck(result),
      stormCheck(daemon.log()),
      tokenCeilingCheck(metrics, ITEM_COUNT >= 100 ? 2_500_000 : 700_000),
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
        itemCount: ITEM_COUNT,
        phaseCount,
        manifest: manifest ?? null,
        manifestEvents: eventCounts,
        toolCalls: metrics?.toolCalls,
        tokensUsed: metrics?.tokensUsed,
      },
    };
  },
};
