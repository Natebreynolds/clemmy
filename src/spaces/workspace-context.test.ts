/**
 * Run: npx tsx --test src/spaces/workspace-context.test.ts
 *
 * The shared dock-session primer + the keystone of the Claude workspace-edit fix:
 * the Claude tool profiles must expose the space_* tools (without them a dock turn
 * can't call space_save and wrongly writes a sandbox file). Temp CLEMENTINE_HOME.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-wsctx-test-'));

const store = await import('./store.js');
const { buildWorkspaceContextPrimer, workspaceSlugFromSessionId, WORKSPACE_DOCK_TOOLS } = await import('./workspace-context.js');
const sdk = await import('../runtime/harness/claude-agent-sdk.js');

test('workspaceSlugFromSessionId parses "space-<slug>" sessions only', () => {
  assert.equal(workspaceSlugFromSessionId('space-darrin-sennott-deal-risk'), 'darrin-sennott-deal-risk');
  assert.equal(workspaceSlugFromSessionId('space-x'), 'x');
  assert.equal(workspaceSlugFromSessionId('sess-mq-abc'), null);
  assert.equal(workspaceSlugFromSessionId('chat'), null);
  assert.equal(workspaceSlugFromSessionId('space-'), null); // needs a slug
});

test('buildWorkspaceContextPrimer tells the brain to edit via space_* (never a sandbox)', () => {
  store.spaceStore.save({ id: 'deal-risk', title: 'Deal Risk', actions: [], dataSources: [{ id: 'deals', runner: 'r.mjs' }] });
  const primer = buildWorkspaceContextPrimer('deal-risk');
  assert.ok(primer);
  assert.match(primer!, /Deal Risk/);
  assert.match(primer!, /space_edit_view\('deal-risk'/);
  assert.match(primer!, /space_refresh\('deal-risk'/);
  assert.match(primer!, /NEVER write the workspace HTML to a sandbox/i);
  assert.match(primer!, /\bdeals\b/); // the data source id is surfaced
  // The view-read instruction points at space_get_view (which returns the HTML),
  // NOT the old false "space_get('<slug>') first for the exact current text" — that
  // instruction was impossible (space_get never returns the view) and forced shell.
  assert.match(primer!, /space_get_view\('deal-risk'/);
  assert.doesNotMatch(primer!, /space_get\('deal-risk'\) first for the exact current text/);
  // The DATA line names the dry-run (space_try_runner) so the model tests a runner
  // inside the surface instead of `node data/x.mjs` in the shell.
  assert.match(primer!, /space_try_runner\('deal-risk'/);
});

test('buildWorkspaceContextPrimer is null for a missing workspace', () => {
  assert.equal(buildWorkspaceContextPrimer('nope-nope'), null);
});

test('WORKSPACE_DOCK_TOOLS lists the tools a dock turn needs to edit', () => {
  assert.deepEqual([...WORKSPACE_DOCK_TOOLS], [
    'space_get', 'space_get_view', 'space_list', 'space_edit_view', 'space_save', 'space_refresh',
    'space_get_runner', 'space_edit_runner', 'space_revert_runner', 'space_try_runner', 'space_set_data',
    'space_publish',
  ]);
});

test('the Claude tool profiles EXPOSE the space tools (the keystone fix)', () => {
  const full = sdk.defaultClaudeAgentSdkAllowedLocalTools('full');
  for (const t of ['space_get', 'space_get_view', 'space_get_runner', 'space_list', 'space_edit_view', 'space_edit_runner', 'space_revert_runner', 'space_save', 'space_refresh', 'space_try_runner', 'space_set_data', 'space_publish']) {
    assert.ok(full.includes(t), `full profile missing ${t}`);
  }
  const authoring = sdk.defaultClaudeAgentSdkAllowedLocalTools('local_authoring');
  assert.ok(authoring.includes('space_save') && authoring.includes('space_edit_view'));
  assert.ok(authoring.includes('space_try_runner') && authoring.includes('space_set_data'));
  // read-only gets the reads (incl. space_get_view, the view-HTML reader) but NOT
  // the writes/executors (space_save/edit/try_runner/set_data).
  const ro = sdk.defaultClaudeAgentSdkAllowedLocalTools('read_only');
  assert.ok(ro.includes('space_get') && ro.includes('space_get_view') && ro.includes('space_list'));
  assert.ok(!ro.includes('space_save') && !ro.includes('space_edit_view'));
  assert.ok(!ro.includes('space_try_runner') && !ro.includes('space_set_data'));
});
