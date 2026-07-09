/**
 * Run: npx tsx --test src/execution/workflow-run-workspace.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-run-workspace-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const {
  anchorRunGoal,
  readRunGoal,
  offloadToolOutput,
  renderOffloadHandback,
  readWorkspaceManifest,
  summarizeToolOutput,
  runWorkspaceDir,
  recordStepOutput,
  stepOutputArtifactRelPath,
} = await import('./workflow-run-workspace.js');

test.after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

const NOW = '2026-07-05T00:00:00.000Z';

test('anchors the goal so every agent shares one objective + criteria', () => {
  anchorRunGoal('brief-wf', 'run1', { objective: 'Build a pre-proposal brief', successCriteria: ['Must cite real data', 'Must not fabricate'] });
  const goal = readRunGoal('brief-wf', 'run1');
  assert.match(goal ?? '', /Build a pre-proposal brief/);
  assert.match(goal ?? '', /Must cite real data/);
  assert.match(goal ?? '', /share this workspace/);
});

test('a large tool output is OFFLOADED to a file, not returned inline (the endurance fix)', () => {
  const big = { records: Array.from({ length: 500 }, (_, i) => ({ keyword: `kw-${i}`, volume: i * 10, rank: i })) };
  const result = offloadToolOutput({ workflowName: 'brief-wf', runId: 'run2', agent: 'pull', tool: 'dataforseo_ranked_keywords', output: big, nowIso: NOW });
  assert.equal(result.offloaded, true);
  assert.match(result.path ?? '', /^artifacts\/dataforseo_ranked_keywords-1\.json$/);
  assert.ok(result.bytes > 8 * 1024);
  // The file actually exists and holds the full payload.
  const full = readFileSync(path.join(runWorkspaceDir('brief-wf', 'run2'), result.path!), 'utf-8');
  assert.match(full, /"records"/);
  // The manifest indexes it (the shared surface a checker / the window reads).
  const manifest = readWorkspaceManifest('brief-wf', 'run2');
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].agent, 'pull');
  assert.equal(manifest[0].tool, 'dataforseo_ranked_keywords');
  assert.match(manifest[0].summary, /"records" has 500 items/);
});

test('a small tool output is kept INLINE (no needless offload)', () => {
  const small = { rank: 42, keywords: 1200 };
  const result = offloadToolOutput({ workflowName: 'brief-wf', runId: 'run3', agent: 'pull', tool: 'domain_rank', output: small, nowIso: NOW });
  assert.equal(result.offloaded, false);
  assert.equal(result.path, undefined);
  assert.equal(readWorkspaceManifest('brief-wf', 'run3').length, 0);
});

test('the model handback points to the path + summary, not the blob', () => {
  const big = 'The prospect homepage: ' + 'lorem ipsum dolor sit amet '.repeat(1000); // ~27KB
  const result = offloadToolOutput({ workflowName: 'brief-wf', runId: 'run4', agent: 'scrape', tool: 'brightdata_scrape', output: big, nowIso: NOW });
  const handback = renderOffloadHandback('brightdata_scrape', result);
  assert.match(handback, /saved to the run workspace at artifacts\/brightdata_scrape-1\.txt/);
  assert.match(handback, /Read artifacts\/brightdata_scrape-1\.txt with read_file/);
  // The handback is BOUNDED — the 27KB blob never reaches the model inline.
  assert.ok(handback.length < 1200, `handback should be bounded, was ${handback.length}`);
  assert.ok(result.bytes > 20 * 1024);
});

test('multiple agents accumulate into one shared, ordered manifest', () => {
  const wf = 'brief-wf', run = 'run5';
  offloadToolOutput({ workflowName: wf, runId: run, agent: 'pull', tool: 'keywords', output: { rows: Array(1000).fill('x') }, nowIso: NOW });
  offloadToolOutput({ workflowName: wf, runId: run, agent: 'competitors', tool: 'competitor_scan', output: { rows: Array(1000).fill('y') }, nowIso: NOW });
  const manifest = readWorkspaceManifest(wf, run);
  assert.deepEqual(manifest.map((m) => `${m.agent}:${m.tool}`), ['pull:keywords', 'competitors:competitor_scan']);
  assert.deepEqual(manifest.map((m) => m.path), ['artifacts/keywords-1.json', 'artifacts/competitor_scan-2.json']);
});

test('recordStepOutput persists every step as an inspectable work product', () => {
  const wf = 'brief-wf', run = 'run6';
  recordStepOutput({ workflowName: wf, runId: run, stepId: 'pull', output: { prospects: [1, 2, 3] }, nowIso: NOW });
  recordStepOutput({ workflowName: wf, runId: run, stepId: 'draft', output: 'a tailored email body', nowIso: NOW });
  const manifest = readWorkspaceManifest(wf, run).filter((m) => m.tool === 'step-output');
  assert.deepEqual(manifest.map((m) => m.agent), ['pull', 'draft']);
  assert.deepEqual(manifest.map((m) => m.path), ['artifacts/step-pull.json', 'artifacts/step-draft.json']);
  assert.match(manifest[0].summary, /"prospects" has 3 items/);
  // The file holds the full work product.
  const full = readFileSync(path.join(runWorkspaceDir(wf, run), 'artifacts/step-pull.json'), 'utf-8');
  assert.match(full, /prospects/);
});

test('stepOutputArtifactRelPath matches the persisted step output location', () => {
  assert.equal(stepOutputArtifactRelPath('fetch accounts'), 'artifacts/step-fetch-accounts.json');
});

test('summarizeToolOutput describes shape without dumping content', () => {
  assert.match(summarizeToolOutput({ prospects: [1, 2, 3], meta: {} }), /object with keys: prospects, meta; "prospects" has 3 items/);
  assert.match(summarizeToolOutput([{ a: 1, b: 2 }]), /array of 1 item; item keys: a, b/);
  assert.match(summarizeToolOutput('short'), /^short$/);
});
