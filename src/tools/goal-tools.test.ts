/**
 * Run: npx tsx --test src/tools/goal-tools.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-goal-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerGoalTools } = await import('./goal-tools.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;

function registeredToolHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    tool(name: string, ...args: unknown[]) {
      const handler = args.at(-1);
      if (typeof handler !== 'function') throw new Error(`tool ${name} missing handler`);
      handlers.set(name, handler as Handler);
    },
  };
  registerGoalTools(server as never);
  return handlers;
}

test('goal_upsert creates without an id, then updates the same goal by id', async () => {
  const handlers = registeredToolHandlers();
  const upsert = handlers.get('goal_upsert');
  const list = handlers.get('goal_list');
  assert.ok(upsert, 'goal_upsert should be registered');
  assert.ok(list, 'goal_list should be registered');
  // goal_get / goal_create / goal_update were folded into goal_upsert.
  assert.equal(handlers.has('goal_get'), false, 'goal_get should be gone');
  assert.equal(handlers.has('goal_create'), false, 'goal_create should be gone');
  assert.equal(handlers.has('goal_update'), false, 'goal_update should be gone');

  // CREATE — no id supplied.
  const created = await upsert({
    title: 'Ship the tool-surface subtraction',
    description: 'Kill unused tools and merge the goal tools.',
    priority: 'high',
    nextActions: ['draft the plan'],
  });
  const createdText = created.content[0].text;
  assert.match(createdText, /Goal created: "Ship the tool-surface subtraction"/);
  const id = createdText.match(/ID: ([0-9a-f]+)\)/)?.[1];
  assert.ok(id, 'created goal should report an id');

  // Missing title+description on a create is refused.
  const refused = await upsert({ priority: 'low' });
  assert.match(refused.content[0].text, /provide both `title` and `description`/);

  // UPDATE — same id, changed status + appended progress note.
  const updated = await upsert({ id, status: 'completed', progressNote: 'shipped locally' });
  assert.match(updated.content[0].text, /updated \(status: completed\)/);

  // Unknown id is a clear error, not a silent create.
  const missing = await upsert({ id: 'deadbeef', progressNote: 'x' });
  assert.match(missing.content[0].text, /Goal not found: deadbeef/);

  // The single goal reflects the create + update (one record, not two).
  const listed = await list({});
  const listedText = listed.content[0].text;
  assert.match(listedText, /\[COMPLETED\] Ship the tool-surface subtraction/);
  assert.equal((listedText.match(/Ship the tool-surface subtraction/g) ?? []).length, 1, 'exactly one goal record');
});
