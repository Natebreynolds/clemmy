/**
 * Run: node scripts/run-tests-isolated.mjs src/execution/workflow-continuation-facts.test.ts
 *
 * The brain that continues a held request after its workflows finish gets
 * each run's own facts: report, step outputs and the path of every file a
 * step committed. Live 2026-10-21: with only a one-run report and settlement
 * counts, it searched the home folder for a note the run had saved.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-continuation-facts-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const { WORKFLOW_RUNS_DIR } = await import('../tools/shared.js');
const { ensureRunWorkspace, recordStepOutput } = await import('./workflow-run-workspace.js');
const { workflowMemberFactsForContinuation } = await import('./workflow-continuation-facts.js');

after(() => { rmSync(home, { recursive: true, force: true }); });

const NOW = '2026-10-21T07:10:12.000Z';
const NOTE_PATH = path.join(home, 'files', 'clem-fixtures', 'rehearsal-args-note.md');

function runRecord(runId: string, workflow: string, extra: Record<string, unknown>): void {
  mkdirSync(WORKFLOW_RUNS_DIR, { recursive: true });
  writeFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), JSON.stringify({
    id: runId, workflow, workflowSlug: workflow.toLowerCase().replace(/\s+/g, '-'), status: 'completed',
    createdAt: NOW, startedAt: NOW, finishedAt: NOW, ...extra,
  }));
}

test('each member hands over its report, step outputs and the path of every committed file', () => {
  const notes = 'Clem fixture rehearsal args';
  const grant = 'Clem fixture standing grant';
  const receipt = 'local-file-receipt:v1:AAAA';
  runRecord('run-notes', notes, {
    stepOutputs: { gather_tips: { title: 'Houseplant Care Basics', tips: ['Water when the top inch is dry.', 'Bright, indirect light.'] }, save_note: receipt },
    reportBack: { version: 1, workflowName: notes, outcome: 'done', detail: 'The rehearsal workflow ran and finished. It also saved a note.' },
  });
  ensureRunWorkspace(notes, 'run-notes');
  recordStepOutput({ workflowName: notes, runId: 'run-notes', stepId: 'gather_tips', output: { title: 'Houseplant Care Basics', tips: ['a', 'b'] }, nowIso: NOW });
  recordStepOutput({ workflowName: notes, runId: 'run-notes', stepId: 'save_note', nowIso: NOW, output: {
    artifactId: receipt, handle: 'state/local-file-revisions/abc/current.json', contentDigest: 'd'.repeat(64),
    receipt: '[clementine:host-local-write-commit:v1] {}', path: NOTE_PATH, result: `Committed file at ${NOTE_PATH} (218 chars).`,
  } });
  runRecord('run-grant', grant, {
    stepOutputs: { compose_note: 'This email draft was created by the saved workflow.', stage_draft: { status: 'draft_created', draft_only: true, mailbox: 'owner@example.test', subject: 'Clem fixture: standing grant' } },
    reportBack: { version: 1, workflowName: grant, outcome: 'done', detail: 'The standing grant workflow staged one unsent draft.' },
  });

  const facts = workflowMemberFactsForContinuation(['run-notes', 'run-grant', 'run-missing']);
  assert.deepEqual(facts.map((member) => member.runId), ['run-notes', 'run-grant'], 'a run whose record cannot be read is left out, never guessed');

  const [noteRun, grantRun] = facts;
  assert.equal(noteRun!.workflow, notes);
  assert.equal(noteRun!.outcome, 'done');
  assert.match(noteRun!.detail, /saved a note/);
  const saved = noteRun!.steps.find((step) => step.step === 'save_note');
  assert.equal(saved?.file?.path, NOTE_PATH, 'the committed path rides with the step, resolved from its receipt');
  assert.match(saved?.file?.result ?? '', /Committed file at/);
  assert.match(noteRun!.steps.find((step) => step.step === 'gather_tips')?.output ?? '', /Houseplant Care Basics/);
  assert.ok(noteRun!.artifacts.some((artifact) => artifact.agent === 'save_note' && artifact.bytes > 0), JSON.stringify(noteRun!.artifacts));

  assert.equal(grantRun!.workflow, grant);
  const draft = grantRun!.steps.find((step) => step.step === 'stage_draft');
  assert.match(draft?.output ?? '', /draft_created/);
  assert.match(draft?.output ?? '', /Clem fixture: standing grant/);
  assert.equal(draft?.file, undefined, 'a draft is not a file');
  assert.deepEqual(grantRun!.artifacts, [], 'no workspace, no invented artifacts');
});

test('outputs and reports are bounded, and a step output that names a path directly keeps it', () => {
  const name = 'Clem fixture long output';
  runRecord('run-long', name, {
    stepOutputs: { big: 'x'.repeat(5_000), wrote: { path: '/tmp/clem/out.csv', result: 'Saved 20 rows.' } },
    reportBack: { version: 1, workflowName: name, outcome: 'blocked', detail: 'y'.repeat(5_000) },
  });
  const [facts] = workflowMemberFactsForContinuation(['run-long']);
  assert.ok(facts);
  assert.ok(facts.detail.length <= 2_000, String(facts.detail.length));
  assert.ok(facts.steps.find((step) => step.step === 'big')!.output.length <= 800);
  assert.equal(facts.steps.find((step) => step.step === 'wrote')?.file?.path, '/tmp/clem/out.csv');
  assert.equal(facts.outcome, 'blocked');
});
