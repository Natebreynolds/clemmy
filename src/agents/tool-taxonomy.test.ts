/**
 * Run: npx tsx --test src/agents/tool-taxonomy.test.ts
 *
 * Locks the classifier and the scope-driven approval decision so we
 * know that:
 *   - reads never ask
 *   - admin tools always ask (even in YOLO)
 *   - composio_execute_tool routes through the slug
 *   - cx_* tools route through their lowercased slug
 *   - MCP namespaced names (server__tool) classify by the underlying tool
 *   - destructive-hint forces a prompt even with scope=yolo
 *   - the hard ALWAYS_ADMIN list overrides everything
 *
 * The proactivity-policy loader is bound to a temp `CLEMENTINE_HOME`
 * set BEFORE any import of taxonomy/policy modules.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Set CLEMENTINE_HOME at top-of-module so the very first import of
// `../config.js` sees the temp path. Imports below are dynamic so
// they observe this env.
const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-tax-test-'));
const baseDir = path.join(tmpHome, 'clementine-home');
process.env.CLEMENTINE_HOME = baseDir;
process.env.HOME = tmpHome;
const policyDir = path.join(baseDir, 'state');

function setScope(scope: 'strict' | 'workspace' | 'yolo'): void {
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(
    path.join(policyDir, 'proactivity-policy.json'),
    JSON.stringify({ autoApproveScope: scope }, null, 2),
  );
}

// Bind these in `before` so the dynamic import resolves once env is set.
let classifyTool: typeof import('./tool-taxonomy.js').classifyTool;
let decideToolApproval: typeof import('./tool-taxonomy.js').decideToolApproval;

before(async () => {
  setScope('strict');
  const mod = await import('./tool-taxonomy.js');
  classifyTool = mod.classifyTool;
  decideToolApproval = mod.decideToolApproval;
});

// ---------- classifyTool ----------

test('classifyTool: explicit admin list wins', () => {
  for (const name of ['create_tool', 'delete_agent', 'workspace_config', 'plugin_install']) {
    assert.equal(classifyTool(name), 'admin', name);
  }
});

test('classifyTool: workspace_config list is read, add/remove are admin', () => {
  assert.equal(classifyTool('workspace_config', { args: { action: 'list' } }), 'read');
  assert.equal(classifyTool('workspace_config', { args: { action: 'add' } }), 'admin');
  assert.equal(classifyTool('workspace_config', { args: { action: 'remove' } }), 'admin');
});

test('classifyTool: read prefixes', () => {
  assert.equal(classifyTool('get_tasks'), 'read');
  assert.equal(classifyTool('list_files'), 'read');
  assert.equal(classifyTool('workspace_info'), 'read');
  assert.equal(classifyTool('search_memory'), 'read');
  assert.equal(classifyTool('ping'), 'read');
  assert.equal(classifyTool('recall'), 'read');
});

test('classifyTool: write prefixes', () => {
  assert.equal(classifyTool('write_file'), 'write');
  assert.equal(classifyTool('remember'), 'write');
  assert.equal(classifyTool('update_task'), 'write');
});

test('classifyTool: execute names', () => {
  assert.equal(classifyTool('run_shell_command'), 'execute');
  assert.equal(classifyTool('run_workflow'), 'execute');
});

test('classifyTool: send (network mutation) prefixes', () => {
  assert.equal(classifyTool('send_message'), 'send');
  assert.equal(classifyTool('post_status'), 'send');
  assert.equal(classifyTool('publish_announcement'), 'send');
});

test('classifyTool: composio_execute_tool routes through tool_slug', () => {
  assert.equal(
    classifyTool('composio_execute_tool', { args: { tool_slug: 'GOOGLESHEETS_BATCH_GET' } }),
    'read',
  );
  assert.equal(
    classifyTool('composio_execute_tool', { args: { tool_slug: 'GMAIL_SEND_EMAIL' } }),
    'send',
  );
  // Missing slug → conservative.
  assert.equal(classifyTool('composio_execute_tool', { args: {} }), 'send');
});

test('classifyTool: cx_* tools route through the slug', () => {
  assert.equal(classifyTool('cx_googlesheets_batch_get'), 'read');
  assert.equal(classifyTool('cx_googlesheets_create_spreadsheet'), 'send');
  assert.equal(classifyTool('cx_gmail_send_email'), 'send');
});

test('classifyTool: MCP-namespaced names classify by underlying tool', () => {
  // Standard verbs work through the shim prefix.
  assert.equal(classifyTool('filesystem__write_file'), 'write');
  assert.equal(classifyTool('hostinger-mcp__list_domains'), 'read');
  assert.equal(classifyTool('github__get_pull_request'), 'read');
  // DataForSEO tool names are domain verbs rather than CRUD verbs, but
  // the MCP server is read-only SEO data lookup surface.
  assert.equal(classifyTool('dataforseo__serp_organic_live_advanced'), 'read');
  assert.equal(classifyTool('dataforseo-mcp-server__serp_organic_live_advanced'), 'read');
  // Unknown vendors with no known read verb still fall to the
  // conservative default.
  assert.equal(classifyTool('unknownvendor__serp_organic_live_advanced'), 'write');
});

test('classifyTool: unknown names default to write (conservative)', () => {
  assert.equal(classifyTool('weird_unfamiliar_tool'), 'write');
});

// ---------- decideToolApproval ----------

test('decideToolApproval: read is auto in every scope', () => {
  for (const scope of ['strict', 'workspace', 'yolo'] as const) {
    setScope(scope);
    for (const toolName of ['list_files', 'workspace_info', 'dataforseo__serp_organic_live_advanced']) {
      const { needsApproval, kind, reason } = decideToolApproval({ toolName });
      assert.equal(needsApproval, false, `${scope}: ${toolName} should auto`);
      assert.equal(kind, 'read');
      assert.equal(reason, 'read-always-auto');
    }
  }
});

test('decideToolApproval: admin always asks (even YOLO)', () => {
  setScope('yolo');
  const { needsApproval, kind, reason } = decideToolApproval({ toolName: 'create_tool' });
  assert.equal(needsApproval, true);
  assert.equal(kind, 'admin');
  assert.equal(reason, 'admin');
});

test('decideToolApproval: workspace_config list autos, add asks', () => {
  setScope('yolo');
  const list = decideToolApproval({ toolName: 'workspace_config', args: { action: 'list' } });
  assert.equal(list.needsApproval, false);
  assert.equal(list.kind, 'read');

  const add = decideToolApproval({ toolName: 'workspace_config', args: { action: 'add' } });
  assert.equal(add.needsApproval, true);
  assert.equal(add.kind, 'admin');
});

test('decideToolApproval: destructive-hint forces a prompt even in YOLO', () => {
  setScope('yolo');
  const { needsApproval, reason } = decideToolApproval({
    toolName: 'write_file',
    isDestructiveHint: true,
  });
  assert.equal(needsApproval, true);
  assert.equal(reason, 'destructive-hint');
});

test('decideToolApproval: strict scope makes writes/executes/sends ask', () => {
  setScope('strict');
  for (const name of ['write_file', 'run_shell_command', 'send_message']) {
    const { needsApproval } = decideToolApproval({ toolName: name });
    assert.equal(needsApproval, true, name);
  }
});

test('decideToolApproval: yolo scope auto-approves writes/executes/sends', () => {
  setScope('yolo');
  for (const name of ['write_file', 'run_shell_command', 'send_message']) {
    const { needsApproval, reason } = decideToolApproval({ toolName: name });
    assert.equal(needsApproval, false, name);
    assert.equal(reason, 'yolo-policy');
  }
});

test('decideToolApproval: workspace scope auto-approves writes inside workspace only', () => {
  setScope('workspace');
  const inside = decideToolApproval({
    toolName: 'write_file',
    insideWorkspaceHint: true,
  });
  assert.equal(inside.needsApproval, false);
  assert.equal(inside.reason, 'workspace-policy');

  const outside = decideToolApproval({
    toolName: 'write_file',
    insideWorkspaceHint: false,
  });
  assert.equal(outside.needsApproval, true);
});

test('decideToolApproval: workspace scope still asks for send (no workspace concept)', () => {
  setScope('workspace');
  const { needsApproval } = decideToolApproval({
    toolName: 'send_message',
    insideWorkspaceHint: true, // hint should be ignored for 'send'
  });
  assert.equal(needsApproval, true);
});

test('decideToolApproval: agent-owned-dir short-circuits even under strict scope', () => {
  setScope('strict');
  // write into ~/.clementine-next/ (or any path the caller flagged as
  // agent-owned) auto-approves regardless of scope — that's bookkeeping.
  const writeIntoAgentDir = decideToolApproval({
    toolName: 'write_file',
    insideAgentOwnedDirHint: true,
  });
  assert.equal(writeIntoAgentDir.needsApproval, false);
  assert.equal(writeIntoAgentDir.reason, 'agent-owned-dir');

  // The hint is meaningless for 'send' tools (no path concept) — they
  // should still gate under strict.
  const sendWithFalseHint = decideToolApproval({
    toolName: 'send_message',
    insideAgentOwnedDirHint: true,
  });
  assert.equal(sendWithFalseHint.needsApproval, true);

  // A destructive hint still wins — agent-owned dir does NOT override
  // an explicit "this is destructive" caller signal.
  const destructiveInAgentDir = decideToolApproval({
    toolName: 'write_file',
    insideAgentOwnedDirHint: true,
    isDestructiveHint: true,
  });
  assert.equal(destructiveInAgentDir.needsApproval, true);
  assert.equal(destructiveInAgentDir.reason, 'destructive-hint');
});

test('decideToolApproval: cx_* googlesheets writes auto in yolo, ask in strict', () => {
  setScope('yolo');
  const yolo = decideToolApproval({ toolName: 'cx_googlesheets_create_spreadsheet' });
  assert.equal(yolo.needsApproval, false);
  assert.equal(yolo.kind, 'send');

  setScope('strict');
  const strict = decideToolApproval({ toolName: 'cx_googlesheets_create_spreadsheet' });
  assert.equal(strict.needsApproval, true);
});

test('decideToolApproval: cx_* read tools auto in every scope', () => {
  for (const scope of ['strict', 'workspace', 'yolo'] as const) {
    setScope(scope);
    const { needsApproval } = decideToolApproval({ toolName: 'cx_googlesheets_batch_get' });
    assert.equal(needsApproval, false, scope);
  }
});

test('decideToolApproval: kindHint overrides the classifier', () => {
  setScope('yolo');
  const { kind, needsApproval } = decideToolApproval({
    toolName: 'list_files',
    kindHint: 'admin', // pretend this list_files is actually an admin op
  });
  assert.equal(kind, 'admin');
  assert.equal(needsApproval, true);
});

// Cleanup the temp HOME directory at the end of the suite.
process.on('exit', () => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});
