/**
 * Run: npx tsx --test src/dashboard/console-workflow-step-save.test.ts
 *
 * What a step save through PATCH /api/console/workflows/:name must do for the
 * editors that use it (the canvas today, the step panel next):
 *   - an edit to one facet of a step keeps every other field on every step
 *   - removeStepIds really removes, and refuses to strand a step's dependency
 *   - a malformed step value is a 400, never an error that ends the daemon
 *   - a save that was written as off says it was written
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-step-save-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

async function boot(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, {
    getRuntime: () => ({ listPendingApprovals: () => [] }),
  } as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function patch(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

test('rewiring one step keeps every other field on every step', async () => {
  const name = 'Keep Fields Flow';
  writeWorkflow('keep-fields-flow', {
    name,
    description: 'fields a rewire must not touch',
    enabled: false,
    trigger: { manual: true },
    steps: [
      { id: 'research', prompt: 'Pull the posts.', sideEffect: 'read', optional: true, executionRole: 'specialist', useHarness: false },
      { id: 'enrich', prompt: 'Add images.', sideEffect: 'read', optional: true, executionRole: 'specialist' },
      { id: 'draft', prompt: 'Draft captions.', dependsOn: ['research', 'enrich'], executionRole: 'reducer' },
    ],
  });
  const h = await boot();
  try {
    const saved = await patch(`${h.url}/api/console/workflows/${encodeURIComponent(name)}`, {
      stepEdits: [
        { id: 'research', dependsOn: [] },
        { id: 'enrich', dependsOn: [] },
        { id: 'draft', dependsOn: ['research'] },
      ],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const steps = Object.fromEntries((readWorkflow('keep-fields-flow')?.data.steps ?? []).map((s) => [s.id, s]));
    assert.equal(steps.research?.optional, true, 'research kept "keep going if this fails"');
    assert.equal(steps.enrich?.optional, true, 'enrich kept "keep going if this fails"');
    assert.equal(steps.research?.executionRole, 'specialist');
    assert.equal(steps.draft?.executionRole, 'reducer');
    assert.equal(steps.research?.useHarness, false, 'a deliberate non-harness step stays one');
    assert.deepEqual(steps.draft?.dependsOn, ['research'], 'and the rewire itself landed');
  } finally {
    await h.close();
  }
});

test('removeStepIds removes the step, alongside the rewire that detaches it', async () => {
  const name = 'Remove Step Flow';
  writeWorkflow('remove-step-flow', {
    name,
    description: 'remove really removes',
    enabled: false,
    trigger: { manual: true },
    steps: [
      { id: 'pull', prompt: 'Pull.', sideEffect: 'read' },
      { id: 'extra', prompt: 'An extra look.', sideEffect: 'read', dependsOn: ['pull'] },
      { id: 'draft', prompt: 'Draft.', dependsOn: ['pull', 'extra'] },
    ],
  });
  const h = await boot();
  try {
    const saved = await patch(`${h.url}/api/console/workflows/${encodeURIComponent(name)}`, {
      stepEdits: [{ id: 'pull', dependsOn: [] }, { id: 'draft', dependsOn: ['pull'] }],
      removeStepIds: ['extra', 'already-gone'],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const steps = readWorkflow('remove-step-flow')?.data.steps ?? [];
    assert.deepEqual(steps.map((s) => s.id), ['pull', 'draft'], 'extra is gone; an id that was already gone is not an error');
    assert.equal(steps.find((s) => s.id === 'draft')?.prompt, 'Draft.', 'the kept steps are otherwise untouched');
  } finally {
    await h.close();
  }
});

test('removeStepIds refuses to leave a step waiting on a removed step', async () => {
  const name = 'Strand Step Flow';
  writeWorkflow('strand-step-flow', {
    name,
    description: 'a removal cannot strand a dependency',
    enabled: false,
    trigger: { manual: true },
    steps: [
      { id: 'pull', prompt: 'Pull.', sideEffect: 'read' },
      { id: 'draft', prompt: 'Draft.', dependsOn: ['pull'] },
    ],
  });
  const h = await boot();
  try {
    const url = `${h.url}/api/console/workflows/${encodeURIComponent(name)}`;
    const stranded = await patch(url, { removeStepIds: ['pull'] });
    assert.equal(stranded.status, 400);
    assert.match(String(stranded.body.error ?? ''), /"draft" depends on unknown step "pull"/);

    // The canvas drops the edge along with the step. On a live workflow, a
    // step that still iterates over the removed one fails validation. (A
    // workflow that is off may be saved as an unfinished draft; turning it on
    // runs the same validation.)
    writeWorkflow('strand-foreach-flow', {
      name: 'Strand ForEach Flow',
      description: 'a removal cannot strand a fan-out',
      enabled: true,
      trigger: { manual: true },
      steps: [
        { id: 'pull', prompt: 'List the posts.', sideEffect: 'read' },
        { id: 'caption', prompt: 'Caption {{item}}.', dependsOn: ['pull'], forEach: 'pull' },
      ],
    });
    const fanOut = await patch(`${h.url}/api/console/workflows/${encodeURIComponent('Strand ForEach Flow')}`, {
      stepEdits: [{ id: 'caption', dependsOn: [] }],
      removeStepIds: ['pull'],
    });
    assert.equal(fanOut.status, 400, JSON.stringify(fanOut.body));
    assert.deepEqual((readWorkflow('strand-foreach-flow')?.data.steps ?? []).map((s) => s.id), ['pull', 'caption']);

    const both = await patch(url, { steps: [{ id: 'pull' }], removeStepIds: ['draft'] });
    assert.equal(both.status, 400, 'steps already removes what it omits; the two do not combine');

    assert.deepEqual((readWorkflow('strand-step-flow')?.data.steps ?? []).map((s) => s.id), ['pull', 'draft'], 'nothing was written');
  } finally {
    await h.close();
  }
});

test('a malformed step value is refused with a reason, and the service keeps answering', async () => {
  const name = 'Malformed Step Flow';
  writeWorkflow('malformed-step-flow', {
    name,
    description: 'bad values are a 400',
    enabled: false,
    trigger: { manual: true },
    steps: [{ id: 'pull', prompt: 'Pull.', sideEffect: 'read' }],
  });
  const h = await boot();
  try {
    const url = `${h.url}/api/console/workflows/${encodeURIComponent(name)}`;
    for (const edit of [
      { id: 'pull', transform: { version: 1, expression: { op: 'not-an-op' } } },
      { id: 'pull', call: { tool: 'SHEETS_APPEND_ROW', args_json: '{not json' } },
    ]) {
      const refused = await patch(url, { stepEdits: [edit] });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.ok(String(refused.body.error ?? '').length > 0, 'the refusal says why');
    }
    const created = await fetch(`${h.url}/api/console/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Malformed Create Flow',
        description: 'bad create',
        steps: [{ id: 'a', prompt: 'A.', transform: { version: 1, expression: { op: 'not-an-op' } } }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(created.status, 400);
    const still = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    assert.equal(still.status, 200, 'the service still answers');
  } finally {
    await h.close();
  }
});

test('a save written as off for a missing test input says it was written', async () => {
  const name = 'Missing Input Flow';
  writeWorkflow('missing-input-flow', {
    name,
    description: 'live workflow whose test needs an input',
    enabled: true,
    trigger: { manual: true },
    inputs: { topic: { type: 'string', required: true, description: 'What to look up' } },
    steps: [
      { id: 'pull', prompt: 'Search the web for {{input.topic}}.', sideEffect: 'read', allowedTools: ['FIRECRAWL_SEARCH'] },
      { id: 'draft', prompt: 'Draft.', dependsOn: ['pull'] },
    ],
  });
  const h = await boot();
  try {
    const saved = await patch(`${h.url}/api/console/workflows/${encodeURIComponent(name)}`, {
      stepEdits: [{ id: 'draft', dependsOn: [] }],
    });
    assert.equal(saved.status, 409, JSON.stringify(saved.body));
    assert.equal(saved.body.updated, true, 'the edit was written, so the response says so');
    assert.equal(saved.body.enabled, false);
    const stored = readWorkflow('missing-input-flow')?.data;
    assert.equal(stored?.enabled, false);
    assert.deepEqual(stored?.steps.find((s) => s.id === 'draft')?.dependsOn ?? [], []);
  } finally {
    await h.close();
  }
});
