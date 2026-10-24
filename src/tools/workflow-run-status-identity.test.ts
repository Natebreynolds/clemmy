/** Public tool-handler controls: exact run evidence must never come from a
 * different retained identity or a path outside the run directory. */
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-workflow-status-identity-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const { registerOrchestrationTools } = await import('./orchestration-tools.js');
const { WORKFLOW_RUNS_DIR } = await import('./shared.js');
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { appendWorkflowEvent } = await import('../execution/workflow-events.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');

type ToolResult = { content: Array<{ type: string; text?: string }> };
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
let statusHandler: Handler | undefined;
let statusSchema: z.ZodObject<z.ZodRawShape> | undefined;
registerOrchestrationTools({
  tool(name: string, _description: string, schema: z.ZodRawShape, handler: Handler) {
    if (name === 'workflow_run_status') {
      statusHandler = handler;
      statusSchema = z.object(schema);
    }
  },
} as never);
assert.ok(statusHandler, 'the public workflow_run_status tool is registered');
assert.ok(statusSchema);

test.after(() => {
  closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

async function status(args: Record<string, unknown>): Promise<string> {
  const result = await statusHandler!(statusSchema!.parse(args));
  return result.content.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
}

function runFile(id: string): string {
  return path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
}

function saveRun(id: string, record: Record<string, unknown>): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(runFile(id), JSON.stringify(record), 'utf-8');
}

test('registered exact status preserves terminal report, failed-item lookup and full paged step evidence', async () => {
  const runId = 'framework-status-full-output';
  const entry = writeWorkflow('framework-status-exact-evidence', {
    name: 'FRAMEWORK-TEST Status exact evidence', description: 'Controlled status-only fixture.',
    enabled: false, trigger: { manual: true }, steps: [{ id: 'draft', prompt: 'Read supplied text.', sideEffect: 'read' }],
  });
  const fullOutput = 'START "quoted" \\ path — café 🦊\n' + '0123456789'.repeat(2_600) + '\nEXACT-END';
  saveRun(runId, {
    id: runId, workflow: entry.data.name, status: 'completed', needsAttention: true,
    createdAt: '2026-10-16T01:00:00.000Z', finishedAt: '2026-10-16T01:01:00.000Z',
    inputs: { topic: 'controlled-evidence' }, stepOutputs: { draft: fullOutput },
    reportBack: { outcome: 'blocked', detail: 'Exact retained report: one fan-out item remains.' },
    output: 'Exact final summary.',
  });
  appendWorkflowEvent(entry.name, runId, { kind: 'item_failed', stepId: 'draft', itemKey: 'item-2', error: 'Controlled item failed.' });
  const summary = await status({ run_id: runId });
  assert.match(summary, /Status: completed · NEEDS ATTENTION/);
  assert.match(summary, /Outcome: Blocked/);
  assert.match(summary, /Exact retained report: one fan-out item remains\./);
  assert.match(summary, /draft · item-2: Controlled item failed\./);
  assert.match(summary, /workflow_rerun_failed_items/);
  assert.match(summary, /Exact final summary\./);
  assert.doesNotMatch(summary, /EXACT-END/);

  const pages: string[] = [];
  let offset = 0;
  for (let page = 0; page < 5; page++) {
    const text = await status({ run_id: runId, step_id: 'draft', offset });
    const heading = /^Run ([^\n]+) · step draft · output characters (\d+)–(\d+) of (\d+)\n/.exec(text);
    assert.ok(heading, text);
    assert.equal(heading[1], runId);
    assert.equal(Number(heading[2]), offset);
    assert.equal(Number(heading[4]), fullOutput.length);
    const body = text.slice(heading[0].length);
    const more = /\nMore: call workflow_run_status again with run_id="([^"]+)", step_id="draft", offset=(\d+)\.$/.exec(body);
    pages.push(more ? body.slice(0, more.index) : body);
    if (!more) break;
    assert.equal(more[1], runId);
    assert.ok(Number(more[2]) > offset, 'each returned continuation advances');
    offset = Number(more[2]);
  }
  assert.ok(pages.length > 1, 'the handler paged rather than clipping away the remaining evidence');
  assert.equal(pages.join(''), fullOutput);
  const unknownStep = await status({ run_id: runId, step_id: 'missing' });
  assert.match(unknownStep, /has no output recorded for step "missing"/);
  assert.match(unknownStep, /Steps with output: draft/);
});

test('registered summary and step readers refuse foreign, missing and malformed retained run identities', async () => {
  const runId = 'framework-status-wrong-identity';
  for (const id of ['another-run', undefined, 17, { run: runId }]) {
    const record = {
      ...(id === undefined ? {} : { id }), workflow: 'FOREIGN-IDENTITY-EVIDENCE', status: 'completed',
      inputs: { hidden: 'FOREIGN-IDENTITY-EVIDENCE' }, output: 'FOREIGN-IDENTITY-EVIDENCE',
      stepOutputs: { work: 'FOREIGN-IDENTITY-EVIDENCE' },
      reportBack: { outcome: 'succeeded', detail: 'FOREIGN-IDENTITY-EVIDENCE' },
    };
    saveRun(runId, record);
    const before = readFileSync(runFile(runId), 'utf-8');
    for (const extra of [{}, { step_id: 'work' }]) {
      const text = await status({ run_id: runId, ...extra });
      assert.match(text, /Cannot verify workflow run .*saved identity does not match/);
      assert.doesNotMatch(text, /FOREIGN-IDENTITY-EVIDENCE|Status:|Final output|output characters/);
      assert.equal(readFileSync(runFile(runId), 'utf-8'), before, 'a status refusal never rewrites the retained record');
    }
  }
});

test('registered status refuses unsafe supplied ids before any outside-root or alternate-file read', async () => {
  const outsideFile = path.join(TEST_HOME, 'workflows', 'outside-evidence.json');
  mkdirSync(path.dirname(outsideFile), { recursive: true });
  writeFileSync(outsideFile, JSON.stringify({
    id: '../outside-evidence', workflow: 'OUTSIDE-ROOT-EVIDENCE', status: 'completed',
    output: 'OUTSIDE-ROOT-EVIDENCE', stepOutputs: { work: 'OUTSIDE-ROOT-EVIDENCE' },
  }));
  const originalRead = fs.readFileSync;
  const reads: string[] = [];
  fs.readFileSync = ((file: unknown, ...args: unknown[]) => {
    if (typeof file === 'string') reads.push(path.resolve(file));
    return (originalRead as (...input: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    for (const runId of ['../outside-evidence', '..\\outside-evidence', 'subdir/run', 'subdir\\run', 'run\nid']) {
      for (const extra of [{}, { step_id: 'work' }]) {
        const text = await status({ run_id: runId, workflow: 'ignored-for-invalid-id', ...extra });
        assert.match(text, /Cannot read workflow run:.*safe exact basename/);
        assert.doesNotMatch(text, /OUTSIDE-ROOT-EVIDENCE|No workflows are running|has no runs yet/);
      }
    }
    assert.deepEqual(reads, [], 'unsafe exact ids do not read a run, neighboring document or history fallback');
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
  }
});

test('registered status returns unavailable for corrupt and nonobject retained records without exposing raw content', async () => {
  const runId = 'framework-status-invalid-record';
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  for (const bytes of ['{BROKEN-PRIVATE-CONTENT', 'null', '[]', '42', '"PRIVATE-STRING-RECORD"']) {
    writeFileSync(runFile(runId), bytes);
    for (const extra of [{}, { step_id: 'work' }]) {
      const text = await status({ run_id: runId, ...extra });
      assert.match(text, /(?:Cannot verify|Failed to read) workflow run/);
      assert.match(text, /No run evidence was returned/);
      assert.doesNotMatch(text, /BROKEN-PRIVATE-CONTENT|PRIVATE-STRING-RECORD|Status:|output characters/);
    }
  }
});

test('registered status sees an exact record replaced, refused and then deleted without stale evidence', async () => {
  const runId = 'framework-status-replacement';
  saveRun(runId, { id: runId, workflow: 'controlled-replacement', status: 'completed', output: 'EXACT-FIRST' });
  assert.match(await status({ run_id: runId }), /EXACT-FIRST/);
  saveRun(runId, { id: 'foreign-replacement', workflow: 'foreign', status: 'completed', output: 'FOREIGN-REPLACEMENT' });
  const refused = await status({ run_id: runId });
  assert.match(refused, /saved identity does not match/);
  assert.doesNotMatch(refused, /EXACT-FIRST|FOREIGN-REPLACEMENT/);
  saveRun(runId, { id: runId, workflow: 'controlled-replacement', status: 'completed', output: 'EXACT-NEW' });
  assert.match(await status({ run_id: runId }), /EXACT-NEW/);
  rmSync(runFile(runId));
  for (const extra of [{}, { step_id: 'work' }]) {
    const text = await status({ run_id: runId, ...extra });
    assert.match(text, /not found/);
    assert.doesNotMatch(text, /EXACT-FIRST|EXACT-NEW|FOREIGN-REPLACEMENT/);
  }
});

test('registered status keeps omitted-id active overview and named history forms', async () => {
  saveRun('framework-status-active', {
    id: 'framework-status-active', workflow: 'framework-status-history', status: 'running', createdAt: '2026-10-16T03:00:00.000Z',
  });
  saveRun('framework-status-earlier', {
    id: 'framework-status-earlier', workflow: 'framework-status-history', status: 'completed', createdAt: '2026-10-16T02:00:00.000Z',
  });
  saveRun('framework-status-other-history', {
    id: 'framework-status-other-history', workflow: 'unrelated-status-history', status: 'completed', createdAt: '2026-10-16T04:00:00.000Z',
  });
  for (const run_id of [undefined, '', '   ']) {
    const optionalId = run_id === undefined ? {} : { run_id };
    assert.match(await status(optionalId), /framework-status-history · running · run framework-status-active/);
    const history = await status({ ...optionalId, workflow: 'framework-status-history' });
    assert.match(history, /framework-status-active/);
    assert.match(history, /framework-status-earlier/);
    assert.ok(history.indexOf('framework-status-active') < history.indexOf('framework-status-earlier'));
    assert.doesNotMatch(history, /unrelated-status-history|framework-status-other-history/);
  }
});

test('a workflow name given as the run id answers with that workflow\'s runs', async () => {
  const entry = writeWorkflow('framework-status-name-as-run', {
    name: 'FRAMEWORK-TEST Name as run id', description: 'Controlled status-only fixture.',
    enabled: false, trigger: { manual: true }, steps: [{ id: 'read', prompt: 'Read supplied text.', sideEffect: 'read' }],
  });
  saveRun('framework-status-name-run-1', {
    id: 'framework-status-name-run-1', workflow: entry.data.name, status: 'failed',
    createdAt: '2026-10-16T02:00:00.000Z', finishedAt: '2026-10-16T02:00:05.000Z', error: 'Controlled failure.',
  });
  for (const spelled of [entry.name, entry.data.name]) {
    const reply = await status({ run_id: spelled });
    assert.match(reply, /is a workflow, not a run id\./, spelled);
    assert.match(reply, /framework-status-name-run-1/, `${spelled}: its run history, not a not-found`);
  }
  assert.match(await status({ run_id: 'no-such-run-or-workflow' }), /Workflow run "no-such-run-or-workflow" not found\./);
});
