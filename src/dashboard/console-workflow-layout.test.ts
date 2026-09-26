/**
 * Run: npx tsx --test src/dashboard/console-workflow-layout.test.ts
 *
 * A workflow's graph placement is a sidecar beside SKILL.md:
 *   - PUT /layout stores {x, y} per step and GET /:name hands it back
 *   - a position for a step the definition does not have is dropped
 *   - saving placement never rewrites the definition (SKILL.md is byte-identical)
 *   - a malformed body is a 400, never an error that ends the daemon
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-layout-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
const { normalizeWorkflowLayoutPositions, readWorkflowLayout, writeWorkflowLayout, WORKFLOW_LAYOUT_FILE } = await import('../memory/workflow-layout.js');

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
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

function seed(slug: string) {
  return writeWorkflow(slug, {
    name: slug,
    description: 'Layout fixture',
    enabled: false,
    trigger: { manual: true },
    steps: [
      { id: 'collect', prompt: 'Collect the rows.' },
      { id: 'digest', prompt: 'Write the digest.', dependsOn: ['collect'] },
    ],
  } as never);
}

test('positions are normalized to the steps the definition has', () => {
  const positions = normalizeWorkflowLayoutPositions(
    { collect: { x: 10.4, y: 20.6 }, ghost: { x: 1, y: 1 }, digest: { x: 'no', y: 3 }, bad: null },
    ['collect', 'digest'],
  );
  assert.deepEqual(positions, { collect: { x: 10, y: 21 } });
});

test('a layout round-trips through PUT and GET without touching the definition', async () => {
  const slug = 'layout-roundtrip';
  const entry = seed(slug);
  const skillPath = path.join(entry.dir, 'SKILL.md');
  const skillBefore = readFileSync(skillPath, 'utf8');

  const server = await boot();
  try {
    const put = await send(`${server.url}/api/console/workflows/${slug}/layout`, 'PUT', {
      positions: { collect: { x: 0, y: 0 }, digest: { x: 280, y: 0 }, ghost: { x: 5, y: 5 } },
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.layout, { positions: { collect: { x: 0, y: 0 }, digest: { x: 280, y: 0 } } });

    const get = await send(`${server.url}/api/console/workflows/${slug}`, 'GET');
    assert.equal(get.status, 200);
    assert.deepEqual(get.body.layout, { positions: { collect: { x: 0, y: 0 }, digest: { x: 280, y: 0 } } });
  } finally {
    await server.close();
  }

  assert.equal(readFileSync(skillPath, 'utf8'), skillBefore, 'placement must never rewrite SKILL.md');
  assert.ok(existsSync(path.join(entry.dir, WORKFLOW_LAYOUT_FILE)));
  assert.deepEqual(readWorkflow(slug)?.data.steps.map((s) => s.id), ['collect', 'digest']);
});

test('a position for a step that was removed disappears on the next read', () => {
  const slug = 'layout-prunes';
  const entry = seed(slug);
  const written = writeWorkflowLayout(entry, { collect: { x: 1, y: 2 }, digest: { x: 3, y: 4 } });
  assert.ok(written.ok);
  writeWorkflow(slug, { ...entry.data, steps: [entry.data.steps[0]] });
  const after = readWorkflow(slug);
  assert.ok(after);
  assert.deepEqual(readWorkflowLayout(after), { positions: { collect: { x: 1, y: 2 } } });
});

test('a malformed body is refused with a 400 and no file is written', async () => {
  const slug = 'layout-malformed';
  const entry = seed(slug);
  const server = await boot();
  try {
    for (const body of [{}, { positions: [] }, { positions: 'x' }]) {
      const res = await send(`${server.url}/api/console/workflows/${slug}/layout`, 'PUT', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const missing = await send(`${server.url}/api/console/workflows/no-such-workflow/layout`, 'PUT', { positions: {} });
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
  assert.equal(existsSync(path.join(entry.dir, WORKFLOW_LAYOUT_FILE)), false);
});

test('a workflow without a layout reads as null, and a corrupt file reads as null too', () => {
  const slug = 'layout-absent';
  const entry = seed(slug);
  assert.equal(readWorkflowLayout(entry), null);
  const corrupt = writeWorkflowLayout(entry, { collect: { x: 1, y: 1 } });
  assert.ok(corrupt.ok);
  const filePath = path.join(entry.dir, WORKFLOW_LAYOUT_FILE);
  rmSync(filePath);
  mkdirSync(filePath); // a directory where the file should be: unreadable, not fatal
  assert.equal(readWorkflowLayout(entry), null);
});
