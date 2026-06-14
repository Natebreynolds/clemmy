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
let needsApprovalFromTaxonomy: typeof import('./tool-taxonomy.js').needsApprovalFromTaxonomy;
let openPlanScope: typeof import('./plan-scope.js').openPlanScope;
let withHarnessRunContext: typeof import('../runtime/harness/brackets.js').withHarnessRunContext;
let ToolCallsCounter: typeof import('../runtime/harness/brackets.js').ToolCallsCounter;

before(async () => {
  setScope('strict');
  const mod = await import('./tool-taxonomy.js');
  classifyTool = mod.classifyTool;
  decideToolApproval = mod.decideToolApproval;
  needsApprovalFromTaxonomy = mod.needsApprovalFromTaxonomy;
  ({ openPlanScope } = await import('./plan-scope.js'));
  ({ withHarnessRunContext, ToolCallsCounter } = await import('../runtime/harness/brackets.js'));
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

test('classifyTool: local-side-effect tools never gate on approval', () => {
  // Regression for the 2026-05-22 "proactive brief pings about notify_user
  // approval in a loop" bug. notify_user matches the `notify` verb in the
  // `send` category, but it has only LOCAL side effects (desktop notification
  // + Discord ping) and must not require approval. Same logic for
  // ask_user_question, draft_plan, share_plan, surface_plan, propose_check_in_template.
  assert.equal(classifyTool('notify_user'), 'read');
  assert.equal(classifyTool('ask_user_question'), 'read');
  assert.equal(classifyTool('draft_plan'), 'read');
  assert.equal(classifyTool('share_plan'), 'read');
  assert.equal(classifyTool('surface_plan'), 'read');
  assert.equal(classifyTool('propose_check_in_template'), 'read');
  assert.equal(classifyTool('execution_create'), 'read');
  assert.equal(classifyTool('workflow_run'), 'read');
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

test('classifyTool: outbound phone calls are SEND, not write (irreversible external action)', () => {
  // Regression: vapi `create_call` / ElevenLabs `make_outbound_call` were
  // classified `write` → defeated the goal-scope send-lock + auto-approved a
  // real phone call under YOLO/scope. They must be `send`.
  assert.equal(classifyTool('mcp__vapi__create_call'), 'send');
  assert.equal(classifyTool('mcp__ElevenLabs__make_outbound_call'), 'send');
  // No false positives: reading call data stays `read`.
  assert.equal(classifyTool('mcp__vapi__list_calls'), 'read');
  assert.equal(classifyTool('mcp__vapi__get_call'), 'read');
});

test('classifyTool: credential/secret/auth management is ADMIN (always asks)', () => {
  // Regression: MCP-hosted credential tools (n8n / kernel) were `write` → YOLO/
  // scope auto-approved a secret write. The in-process credentials_* tools are
  // ALWAYS_ADMIN; extend the same floor to MCP-hosted ones.
  assert.equal(classifyTool('mcp__n8n__n8n_manage_credentials'), 'admin');
  assert.equal(classifyTool('mcp__kernel__manage_api_keys'), 'admin');
  assert.equal(classifyTool('mcp__kernel__manage_auth_connections'), 'admin');
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
    classifyTool('composio_execute_tool', { args: { tool_slug: 'FIRECRAWL_BATCH_SCRAPE' } }),
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

test('decideToolApproval: write_file inside an allowed local path auto-approves even in strict', () => {
  setScope('strict');
  const inside = decideToolApproval({
    toolName: 'write_file',
    insideWorkspaceHint: true,
  });
  assert.equal(inside.needsApproval, false);
  assert.equal(inside.reason, 'local-workspace-write');

  const outside = decideToolApproval({
    toolName: 'write_file',
    insideWorkspaceHint: false,
  });
  assert.equal(outside.needsApproval, true);
  assert.equal(outside.reason, 'strict-policy');
});

test('decideToolApproval: workspace scope still asks for send (no workspace concept)', () => {
  setScope('workspace');
  const { needsApproval } = decideToolApproval({
    toolName: 'send_message',
    insideWorkspaceHint: true, // hint should be ignored for 'send'
  });
  assert.equal(needsApproval, true);
});

test('decideToolApproval: composio send slugs honor approved plan scope', () => {
  setScope('strict');
  openPlanScope({
    sessionId: 'sess-composio-plan',
    planProposalId: 'batch-approval',
    approvedPlanObjective: 'Create Outlook drafts',
    allowedTools: ['composio_execute_tool'],
    allowedComposioSlugs: ['OUTLOOK_CREATE_DRAFT'],
  });

  const approved = decideToolApproval({
    sessionId: 'sess-composio-plan',
    toolName: 'composio_execute_tool',
    args: { tool_slug: 'OUTLOOK_CREATE_DRAFT' },
  });
  assert.equal(approved.needsApproval, false);
  assert.equal(approved.reason, 'plan-scope');

  const unrelated = decideToolApproval({
    sessionId: 'sess-composio-plan',
    toolName: 'composio_execute_tool',
    args: { tool_slug: 'OUTLOOK_SEND_EMAIL' },
  });
  assert.equal(unrelated.needsApproval, true);
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

test('needsApprovalFromTaxonomy: worker sub-runs inherit harness plan scope', async () => {
  setScope('strict');
  openPlanScope({
    sessionId: 'sess-worker-scope',
    planProposalId: 'request-approval-batch',
    approvedPlanObjective: 'Create Outlook drafts',
    allowedTools: ['composio_execute_tool'],
    allowedComposioSlugs: ['OUTLOOK_CREATE_DRAFT'],
  });
  const needsApproval = needsApprovalFromTaxonomy('composio_execute_tool');

  const result = await withHarnessRunContext(
    { sessionId: 'sess-worker-scope', counter: new ToolCallsCounter(16) },
    () => needsApproval(
      {},
      { tool_slug: 'OUTLOOK_CREATE_DRAFT', arguments: JSON.stringify({ subject: 'A' }) },
    ),
  );

  assert.equal(result, false);
});

// Cleanup the temp HOME directory at the end of the suite.
process.on('exit', () => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});
