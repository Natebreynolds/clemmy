/**
 * Clementine 3 graph-runtime proof.
 *
 * A real queued workflow enters a deterministic read-only step and waits on a
 * release file. While that step is in flight, the model adds two result-only
 * prompt nodes and dependency edges into them. An authored-edge disable is
 * refused by the shipped additive contract. The daemon is then really
 * restarted, the gate is released, and scoring waits for the added nodes to
 * execute, journal durable outputs, and appear in terminal run output.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openHarnessDb, reportBackCheck, narrationCheck, sessionMetrics, stormCheck } from '../score.js';
import { compileWorkflowStepsToGraph, type WorkflowGraphDefinition } from '../../../src/execution/workflow-graph.js';
import { WORKFLOW_GRAPH_SCHEMA_SQL } from '../../../src/execution/workflow-graph-store.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

const WORKFLOW = 'proof-reshape-flow';
const RUN_ID = 'proof-reshape-run';
const BRANCH_B_MARKER = 'GRAPH-BRANCH-B-EXECUTED';
const BRANCH_C_MARKER = 'GRAPH-BRANCH-C-EXECUTED';

const SEED_STEPS = [
  {
    id: 'pull',
    prompt: 'Wait for the proof release gate, then return the durable seed.',
    deterministic: { runner: 'wait-for-release.mjs' },
    sideEffect: 'read',
  },
  {
    id: 'finish',
    prompt: 'Return exactly AUTHORED-FINISH-EXECUTED.',
    dependsOn: ['pull'],
    sideEffect: 'read',
  },
];

interface ProofRunRecord {
  id?: string;
  status?: string;
  finishedAt?: string;
  output?: string;
  stepOutputs?: Record<string, unknown>;
  error?: string;
}

interface ProofWorkflowEvent {
  kind: string;
  stepId?: string;
  output?: unknown;
  error?: string;
  meta?: Record<string, unknown>;
}

/** Seed + read the daemon's own stores, as score.ts does for harness.db. */
function seedLiveGraph(home: string, graph: WorkflowGraphDefinition): void {
  const dir = path.join(home, 'state');
  mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'workflow-graphs.db'));
  try {
    db.exec(WORKFLOW_GRAPH_SCHEMA_SQL);
    db.prepare(`
      INSERT OR REPLACE INTO workflow_graphs (
        id, workflow_name, run_id, graph_id, graph_version, created_at,
        validation_ok, validation_errors_json, validation_warnings_json,
        entry_node_ids_json, metadata_json, graph_json
      ) VALUES (@id, @workflowName, @runId, @graphId, NULL, @createdAt, 1, '[]', '[]', @entryNodeIdsJson, '{}', @graphJson)
    `).run({
      id: `${RUN_ID}:graph`,
      workflowName: WORKFLOW,
      runId: RUN_ID,
      graphId: graph.id ?? null,
      createdAt: new Date().toISOString(),
      entryNodeIdsJson: JSON.stringify(graph.entryNodeIds ?? []),
      graphJson: JSON.stringify(graph),
    });
  } finally {
    db.close();
  }
}

function readLiveGraph(home: string): WorkflowGraphDefinition | null {
  const file = path.join(home, 'state', 'workflow-graphs.db');
  if (!existsSync(file)) return null;
  const db = new Database(file, { readonly: true });
  try {
    const row = db.prepare('SELECT graph_json FROM workflow_graphs WHERE run_id = ?').get(RUN_ID) as { graph_json?: string } | undefined;
    return row?.graph_json ? (JSON.parse(row.graph_json) as WorkflowGraphDefinition) : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function runFile(home: string): string {
  return path.join(home, 'workflows', 'runs', `${RUN_ID}.json`);
}

function readRun(home: string): ProofRunRecord | null {
  try {
    return JSON.parse(readFileSync(runFile(home), 'utf-8')) as ProofRunRecord;
  } catch {
    return null;
  }
}

function readRunEvents(home: string): ProofWorkflowEvent[] {
  const file = path.join(home, 'vault', '00-System', 'workflows', WORKFLOW, 'runs', RUN_ID, 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as ProofWorkflowEvent; } catch { return null; }
    })
    .filter((row): row is ProofWorkflowEvent => row !== null);
}

async function waitFor<T>(
  label: string,
  read: () => T | null,
  timeoutMs = 10 * 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.`);
}

function seedWorkflowAndQueuedRun(home: string): string {
  const workflowDir = path.join(home, 'vault', '00-System', 'workflows', WORKFLOW);
  const scriptsDir = path.join(workflowDir, 'scripts');
  const queueDir = path.dirname(runFile(home));
  const releaseFile = path.join(home, 'state', `${RUN_ID}.release`);
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(queueDir, { recursive: true });

  writeFileSync(path.join(workflowDir, 'SKILL.md'), `---
name: ${WORKFLOW}
description: Live graph execution proof.
enabled: true
trigger:
  manual: true
steps:
  - id: pull
    deterministic:
      runner: wait-for-release.mjs
    side_effect: read
  - id: finish
    dependsOn:
      - pull
    side_effect: read
---

## step: pull

Wait for the proof release gate, then return the durable seed.

## step: finish

Return exactly AUTHORED-FINISH-EXECUTED.
`, 'utf-8');

  writeFileSync(path.join(scriptsDir, 'wait-for-release.mjs'), `import { existsSync } from 'node:fs';
const releaseFile = ${JSON.stringify(releaseFile)};
while (!existsSync(releaseFile)) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
process.stdout.write(JSON.stringify({ released: true, marker: 'GRAPH-SEED-RELEASED' }));
`, 'utf-8');

  writeFileSync(runFile(home), JSON.stringify({
    id: RUN_ID,
    workflow: WORKFLOW,
    status: 'queued',
    inputs: {},
    source: 'proof',
    createdAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
  return releaseFile;
}

export const graphReshapeLive: ScenarioDef = {
  name: 'graph-reshape-live',
  summary: 'model adds read-only nodes mid-run; restart proves they execute and publish durable output',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const checks: Check[] = [];
    const releaseFile = seedWorkflowAndQueuedRun(daemon.home);
    seedLiveGraph(
      daemon.home,
      compileWorkflowStepsToGraph(SEED_STEPS as never[], { id: `${WORKFLOW}:${RUN_ID}` }),
    );

    await waitFor('the authored seed step to be durably in flight', () => {
      const events = readRunEvents(daemon.home);
      return events.some((event) => event.kind === 'step_started' && event.stepId === 'pull')
        ? events
        : null;
    });
    const activeRun = readRun(daemon.home);
    checks.push({
      name: 'real workflow run reached an in-flight execution boundary',
      pass: activeRun?.status === 'running',
      detail: JSON.stringify({ status: activeRun?.status, events: readRunEvents(daemon.home).map((event) => `${event.kind}:${event.stepId ?? ''}`) }),
    });

    const sessionId = `proof-reshape-${Date.now().toString(36)}`;
    const turn = await daemon.chat(
      [
        `Workflow "${WORKFLOW}" has the active in-flight run "${RUN_ID}".`,
        'Use workflow_reshape and inspect the live graph first.',
        `Add read-only result node "analyze-b" with prompt "Return exactly ${BRANCH_B_MARKER}." and make it depend on "pull".`,
        `Add read-only result node "analyze-c" with prompt "Return exactly ${BRANCH_C_MARKER}." and make it depend on "pull".`,
        'Use one additive patch for both nodes and both dependency edges, with a concise reason.',
        'Then try to disable authored edge "dependency:pull->finish".',
        'Report exactly what succeeded and what was refused.',
      ].join(' '),
      sessionId,
      420_000,
    );

    checks.push({ name: 'HTTP 200', pass: turn.httpStatus === 200, detail: `status ${turn.httpStatus}` });
    checks.push(reportBackCheck(turn.text));
    checks.push(narrationCheck(turn.text));

    const patchedBeforeRestart = readLiveGraph(daemon.home);
    const patchedIds = new Set((patchedBeforeRestart?.nodes ?? []).map((node) => node.id));
    const patchEvents = readRunEvents(daemon.home);
    const appliedEvents = patchEvents.filter((event) => event.kind === 'workflow_graph_patch_applied');
    const rejectedEvents = patchEvents.filter((event) => event.kind === 'workflow_graph_patch_rejected');
    checks.push({
      name: 'model persisted both additive read-only branches',
      pass: patchedIds.has('analyze-b') && patchedIds.has('analyze-c'),
      detail: `nodes: ${[...patchedIds].join(', ')}`,
    });
    checks.push({
      name: 'additive patch is durably recorded with its reason',
      pass: appliedEvents.length >= 1
        && appliedEvents.some((event) => String(event.meta?.reason ?? '').trim().length > 0),
      detail: `${appliedEvents.length} applied; reason="${String(appliedEvents[0]?.meta?.reason ?? '')}"`.slice(0, 240),
    });
    const finishEdge = (patchedBeforeRestart?.edges ?? [])
      .find((edge) => edge.id === 'dependency:pull->finish');
    checks.push({
      name: 'authored topology held — pull→finish remains enabled',
      pass: Boolean(finishEdge) && finishEdge?.disabled !== true,
      detail: `edge disabled=${String(finishEdge?.disabled)}`,
    });
    checks.push({
      name: 'edge rewrite was refused by the exact release-v3 contract',
      pass: rejectedEvents.some((event) =>
        /disable operations are not supported|additive read-only/i.test(
          JSON.stringify(event.meta?.errors ?? []),
        )),
      detail: JSON.stringify(rejectedEvents[0]?.meta?.errors ?? []).slice(0, 240),
    });

    // Prove persisted graph recovery rather than merely continuing in process.
    await daemon.restart();
    writeFileSync(releaseFile, 'release', 'utf-8');
    const terminal = await waitFor('the restarted graph-backed run to become terminal', () => {
      const record = readRun(daemon.home);
      return record && ['completed', 'completed_with_errors', 'error', 'failed', 'cancelled'].includes(record.status ?? '')
        ? record
        : null;
    }, 20 * 60_000);
    const finalEvents = readRunEvents(daemon.home);
    const branchBCompleted = finalEvents.some((event) =>
      event.kind === 'step_completed'
      && event.stepId === 'analyze-b'
      && JSON.stringify(event.output).includes(BRANCH_B_MARKER));
    const branchCCompleted = finalEvents.some((event) =>
      event.kind === 'step_completed'
      && event.stepId === 'analyze-c'
      && JSON.stringify(event.output).includes(BRANCH_C_MARKER));
    const terminalEvidence = JSON.stringify({
      output: terminal.output,
      stepOutputs: terminal.stepOutputs,
    });

    checks.push({
      name: 'real daemon restart resumed the same workflow run',
      pass: finalEvents.some((event) => event.kind === 'run_resumed'),
      detail: `status=${terminal.status}; resumed=${finalEvents.filter((event) => event.kind === 'run_resumed').length}`,
    });
    checks.push({
      name: 'both graph-added nodes executed and journaled durable outputs',
      pass: branchBCompleted && branchCCompleted,
      detail: `analyze-b=${branchBCompleted}; analyze-c=${branchCCompleted}`,
    });
    checks.push({
      name: 'terminal output and stepOutputs include both graph-added results',
      pass: terminal.status === 'completed'
        && terminalEvidence.includes(BRANCH_B_MARKER)
        && terminalEvidence.includes(BRANCH_C_MARKER),
      detail: terminal.status === 'completed'
        ? terminalEvidence.slice(0, 320)
        : `${terminal.status}: ${terminal.error ?? terminalEvidence.slice(0, 240)}`,
    });
    checks.push({
      name: 'completed authored work remained part of terminal evidence',
      pass: finalEvents.some((event) => event.kind === 'step_completed' && event.stepId === 'pull')
        && finalEvents.some((event) => event.kind === 'step_completed' && event.stepId === 'finish'),
      detail: finalEvents
        .filter((event) => event.kind === 'step_completed')
        .map((event) => event.stepId)
        .join(', '),
    });

    const claimsRewrite = /(disabled|removed|skipped).{0,40}(pull→finish|pull->finish)/i.test(turn.text)
      && !/refus|could not|couldn’t|couldn't|blocked|denied|not supported|not allowed/i.test(turn.text);
    checks.push({
      name: 'reply does not claim the refused topology rewrite succeeded',
      pass: !claimsRewrite,
      detail: turn.text.slice(0, 240),
    });
    checks.push(stormCheck(daemon.log()));

    let latency = [{ wallMs: turn.wallMs, ttftMs: null as number | null }];
    try {
      const db = openHarnessDb(daemon.home);
      const metrics = sessionMetrics(db, turn.sessionId);
      latency = [{ wallMs: turn.wallMs, ttftMs: metrics?.latency[0]?.ttftMs ?? metrics?.firstByteMs ?? null }];
      db.close();
    } catch { /* latency is reporting only */ }

    return { sessionId: turn.sessionId, checks, latency };
  },
};
