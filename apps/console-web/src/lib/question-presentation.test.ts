import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameQuestionPresentation } from './inbox';

test('question recovery lists come from the server and presentation mutations retain the exact rendered generation and issued mutation token', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-question-presentation-'));
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  const generation = 'a'.repeat(64);
  const mutationToken = 'controlled-mutation-token';
  try {
    const consoleRoot = fileURLToPath(new URL('../../', import.meta.url));
    const output = await build({ stdin: { contents: `export { presentInboxQuestion, listQuestionPresentations } from './src/lib/inbox';`,
      loader: 'ts', resolveDir: consoleRoot }, tsconfig: path.join(consoleRoot, 'tsconfig.json'),
      bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent',
      define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_CLEM_TOKEN': '""' } });
    const module = path.join(temporary, 'client.cjs');
    writeFileSync(module, output.outputFiles[0].contents);
    const { presentInboxQuestion, listQuestionPresentations } = createRequire(import.meta.url)(module) as {
      presentInboxQuestion: (id: string, action: 'dismiss' | 'defer' | 'restore', generation?: string, mutationToken?: string) => Promise<{ generation: string; mutationToken: string }>;
      listQuestionPresentations: () => Promise<{ questions: unknown[]; count: number }>;
    };
    globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ url: String(url), body });
      if (!body) return new Response(JSON.stringify({ questions: [{ id: 'task:controlled / question', action: 'dismiss', generation, mutationToken }], count: 1 }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, id: 'task:controlled / question', action: body.action, generation, mutationToken }), { status: 200 });
    }) as typeof fetch;
    const saved = await listQuestionPresentations();
    assert.equal(saved.count, 1, 'recovery does not depend on an in-memory Undo receipt');
    const receipt = await presentInboxQuestion('task:controlled / question', 'dismiss', generation);
    await presentInboxQuestion('task:controlled / question', 'restore', receipt.generation, receipt.mutationToken);
    assert.deepEqual(calls, [
      { url: '/api/console/inbox/questions/presentation', body: undefined },
      { url: '/api/console/inbox/questions/task%3Acontrolled%20%2F%20question/presentation', body: { action: 'dismiss', generation } },
      { url: '/api/console/inbox/questions/task%3Acontrolled%20%2F%20question/presentation', body: { action: 'restore', generation, mutationToken } },
    ]);
    assert.ok(calls.every(call => !call.url.endsWith('/answer')));
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('restoring one saved presentation cannot clear a newer Undo choice for the same question', () => {
  const receipt = { id: 'controlled-question', generation: 'generation-one', mutationToken: 'mutation-one' };
  assert.equal(sameQuestionPresentation(receipt, { ...receipt }), true);
  assert.equal(sameQuestionPresentation(null, receipt), false);
  assert.equal(sameQuestionPresentation(receipt, { ...receipt, id: 'other-question' }), false);
  assert.equal(sameQuestionPresentation(receipt, { ...receipt, generation: 'generation-two' }), false);
  assert.equal(sameQuestionPresentation(receipt, { ...receipt, mutationToken: 'newer-device-choice' }), false);
});
