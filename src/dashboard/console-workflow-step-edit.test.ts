/**
 * Run: npx tsx --test src/dashboard/console-workflow-step-edit.test.ts
 *
 * The step panel changes one step through the same path as Clementine's
 * workflow_edit_step:
 *   - only the named fields change; every other field on every step is kept
 *   - the everyday four are patchable, including "keep going if this fails"
 *   - the edit is listed as reversible, and revert restores the prior definition
 *   - an unknown field, a no-op and a malformed body are 400s; an unknown step is a 404
 *   - a live workflow whose execution changed is written off, with the test recorded
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-step-edit-'));
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

async function send(url: string, method: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

function seed(slug: string, enabled = false) {
  return writeWorkflow(slug, {
    name: slug,
    description: 'Step edit fixture',
    enabled,
    trigger: { manual: true },
    steps: [
      { id: 'collect', prompt: 'Collect the rows.', allowedTools: ['read_file'], retryBudget: 2 },
      { id: 'digest', prompt: 'Write the digest.', dependsOn: ['collect'], output: { type: 'string' } },
    ],
  } as never);
}

test('the everyday four change on one step and nothing else moves', async () => {
  const slug = 'step-edit-everyday';
  seed(slug);
  const server = await boot();
  try {
    const res = await send(`${server.url}/api/console/workflows/${slug}/steps/digest`, 'POST', {
      patch: { prompt: 'Write a two-line digest.', requiresApproval: true, optional: true, forEach: 'collect' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.backupId, 'string');
    assert.equal(res.body.enabled, false);
    assert.deepEqual(res.body.verification, { turnedOff: false });

    const after = readWorkflow(slug)!.data;
    const digest = after.steps.find((s) => s.id === 'digest')!;
    assert.equal(digest.prompt, 'Write a two-line digest.');
    assert.equal(digest.requiresApproval, true);
    assert.equal(digest.optional, true);
    assert.equal(digest.forEach, 'collect');
    assert.deepEqual(digest.dependsOn, ['collect'], 'an untouched field on the edited step survives');
    assert.deepEqual(digest.output, { type: 'string' });
    const collect = after.steps.find((s) => s.id === 'collect')!;
    assert.deepEqual(collect.allowedTools, ['read_file'], 'the other step is untouched');
    assert.equal(collect.retryBudget, 2);

    // Turning a flag back off removes it rather than storing false forever.
    const off = await send(`${server.url}/api/console/workflows/${slug}/steps/digest`, 'POST', {
      patch: { optional: null, forEach: null },
    });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const digestOff = readWorkflow(slug)!.data.steps.find((s) => s.id === 'digest')!;
    assert.equal(digestOff.optional, undefined);
    assert.equal(digestOff.forEach, undefined);
    assert.equal(digestOff.requiresApproval, true);
  } finally {
    await server.close();
  }
});

test('an edit is listed as reversible, and revert restores the prior definition', async () => {
  const slug = 'step-edit-revert';
  seed(slug);
  const server = await boot();
  try {
    const edit = await send(`${server.url}/api/console/workflows/${slug}/steps/collect`, 'POST', {
      patch: { prompt: 'Collect only the new rows.' },
    });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    const backupId = edit.body.backupId as string;

    const list = await send(`${server.url}/api/console/workflows/${slug}/step-edits`, 'GET');
    assert.equal(list.status, 200);
    const edits = list.body.edits as Array<{ id: string; stepId: string; description: string }>;
    assert.equal(edits.length, 1);
    assert.equal(edits[0].id, backupId);
    assert.equal(edits[0].stepId, 'collect');
    assert.match(edits[0].description, /console step edit collect \(prompt\)/);

    const revert = await send(`${server.url}/api/console/workflows/${slug}/step-edits/${backupId}/revert`, 'POST');
    assert.equal(revert.status, 200, JSON.stringify(revert.body));
    assert.equal(readWorkflow(slug)!.data.steps.find((s) => s.id === 'collect')!.prompt, 'Collect the rows.');

    const again = await send(`${server.url}/api/console/workflows/${slug}/step-edits/${backupId}/revert`, 'POST');
    assert.equal(again.status, 404, 'a used backup is gone');

    // A backup from another workflow cannot be applied here.
    const other = 'step-edit-other';
    seed(other);
    const otherEdit = await send(`${server.url}/api/console/workflows/${other}/steps/collect`, 'POST', { patch: { prompt: 'Other rows.' } });
    const wrong = await send(`${server.url}/api/console/workflows/${slug}/step-edits/${otherEdit.body.backupId}/revert`, 'POST');
    assert.equal(wrong.status, 404);
  } finally {
    await server.close();
  }
});

test('bad edits are refused with the reason and nothing is written', async () => {
  const slug = 'step-edit-refused';
  seed(slug);
  const server = await boot();
  try {
    const unknownField = await send(`${server.url}/api/console/workflows/${slug}/steps/collect`, 'POST', { patch: { executionRole: 'brain' } });
    assert.equal(unknownField.status, 400);
    assert.match(String(unknownField.body.error), /Unknown step field/);

    const noop = await send(`${server.url}/api/console/workflows/${slug}/steps/collect`, 'POST', { patch: { prompt: 'Collect the rows.' } });
    assert.equal(noop.status, 400);
    assert.match(String(noop.body.error), /nothing to change/);

    const empty = await send(`${server.url}/api/console/workflows/${slug}/steps/collect`, 'POST', { patch: { prompt: '   ' } });
    assert.equal(empty.status, 400);

    for (const body of [{}, { patch: [] }, { patch: 'x' }]) {
      const malformed = await send(`${server.url}/api/console/workflows/${slug}/steps/collect`, 'POST', body);
      assert.equal(malformed.status, 400, JSON.stringify(body));
    }
    const missingStep = await send(`${server.url}/api/console/workflows/${slug}/steps/ghost`, 'POST', { patch: { prompt: 'x' } });
    assert.equal(missingStep.status, 404);

    assert.equal(readWorkflow(slug)!.data.steps.find((s) => s.id === 'collect')!.prompt, 'Collect the rows.');
    const list = await send(`${server.url}/api/console/workflows/${slug}/step-edits`, 'GET');
    assert.deepEqual(list.body.edits, []);
  } finally {
    await server.close();
  }
});

test('changing what a live workflow runs writes it off and records the test', async () => {
  const slug = 'step-edit-live';
  // A read that reaches a provider is what makes a workflow testable at all.
  writeWorkflow(slug, {
    name: slug,
    description: 'Live step edit fixture',
    enabled: true,
    trigger: { manual: true },
    steps: [
      { id: 'collect', prompt: 'Read the newest emails and list their subjects.', allowedTools: ['GMAIL_FETCH_EMAILS'], sideEffect: 'read' },
      { id: 'digest', prompt: 'Write the digest.', dependsOn: ['collect'] },
    ],
  } as never);
  const server = await boot();
  try {
    const res = await send(`${server.url}/api/console/workflows/${slug}/steps/collect`, 'POST', {
      patch: { prompt: 'Collect the rows from the other folder.' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const verification = res.body.verification as { turnedOff: boolean; runId?: string; missingInputs?: string[] };
    assert.equal(verification.turnedOff, true);
    assert.equal(res.body.enabled, false);
    assert.equal(readWorkflow(slug)!.data.enabled, false, 'written off until the test passes');
    assert.ok(
      verification.runId || (verification.missingInputs ?? []).length > 0 || verification.message,
      'a test was queued, or the page is told why it could not start',
    );
  } finally {
    await server.close();
  }
});
