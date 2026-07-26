/**
 * Run: npx tsx --test src/tools/focus-tools.test.ts
 *
 * Model-facing coverage for the sparse conversational workstate carried by
 * focus_update. Storage semantics live in memory/focus.test.ts; this pins the
 * tool translation and optimistic-conflict message the brains actually see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-focus-tools-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerFocusTools } = await import('./focus-tools.js');
const { createFocus, getFocusById, getFocusWorkstate } = await import('../memory/focus.js');
const { resetMemoryDb } = await import('../memory/db.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');

type ToolResult = { content?: Array<{ text?: string }> };
type ToolHandler = (input: Record<string, any>) => Promise<ToolResult>;

function handlers(): Map<string, ToolHandler> {
  const out = new Map<string, ToolHandler>();
  const server = {
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      out.set(name, handler);
    },
  };
  registerFocusTools(server as never);
  return out;
}

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('focus_update patches the shared notebook and focus_get exposes it', async () => {
  resetMemoryDb();
  const focus = createFocus({
    resourceRef: 'session:recipes',
    title: 'Recipe planning',
    summary: 'Discussing dinner options.',
  });
  const tools = handlers();
  const update = tools.get('focus_update');
  const get = tools.get('focus_get');
  assert.ok(update);
  assert.ok(get);

  const result = await update!({
    id: focus.id,
    summary: 'Selecting dinners before updating Airtable and Calendar.',
    workstate_patch: {
      mode: 'decide',
      objective: 'Select three dinners.',
      upsert_candidates: [
        { id: 'tacos', label: 'Black bean tacos', status: 'selected' },
      ],
      add_decisions: ['Use tacos on Thursday'],
      open_loops: ['Select two more dinners'],
    },
  });

  assert.match(result.content?.[0]?.text ?? '', /Shared workstate v1 \(decide\)/);
  assert.equal(getFocusById(focus.id)?.summary, 'Selecting dinners before updating Airtable and Calendar.');
  assert.equal(getFocusWorkstate(getFocusById(focus.id))?.candidates[0]?.status, 'selected');

  const rendered = await get!({});
  assert.match(rendered.content?.[0]?.text ?? '', /Workstate: v1 · decide/);
  assert.match(rendered.content?.[0]?.text ?? '', /Black bean tacos \[selected\]/);
});

test('focus_update refuses a stale expected workstate version', async () => {
  resetMemoryDb();
  const focus = createFocus({
    resourceRef: 'session:versioned',
    title: 'Versioned planning',
    summary: 'Testing concurrent corrections.',
  });
  const update = handlers().get('focus_update');
  assert.ok(update);
  await update!({
    id: focus.id,
    workstate_patch: {
      expected_version: 0,
      add_decisions: ['First decision'],
    },
  });
  const conflict = await update!({
    id: focus.id,
    workstate_patch: {
      expected_version: 0,
      add_decisions: ['Stale decision'],
    },
  });

  assert.match(conflict.content?.[0]?.text ?? '', /workstate is now v1/i);
  assert.deepEqual(getFocusWorkstate(getFocusById(focus.id))?.decisions, ['First decision']);
});

test('focus tools bind cross-surface continuity to the trustworthy ambient session', async () => {
  resetMemoryDb();
  const tools = handlers();
  const set = tools.get('focus_set');
  const update = tools.get('focus_update');
  assert.ok(set && update);

  await withToolOutputContext({ sessionId: 'discord-origin' }, () => set!({
    resource_ref: 'https://example.com/meal-plan',
    title: 'Meal plan',
    summary: 'Choose and schedule the weeknight meals.',
    resource_kind: 'project',
    related_session_id: 'model-invented-session',
  }));
  const created = getFocusById(1);
  assert.equal(created?.related_session_id, 'discord-origin');

  await withToolOutputContext({ sessionId: 'desktop-continuation' }, () => update!({
    id: created!.id,
    workstate_patch: { add_decisions: ['Continue the same plan on desktop'] },
  }));
  assert.equal(getFocusById(created!.id)?.related_session_id, 'desktop-continuation');
});
