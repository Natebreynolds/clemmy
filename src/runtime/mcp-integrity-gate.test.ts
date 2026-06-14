/**
 * Run: npx tsx --test src/runtime/mcp-integrity-gate.test.ts
 *
 * Blind-spot audit #1: native MCP tools bypass wrapToolForHarness, so an MCP
 * SEND (Gmail/Slack/etc.) never got the grounding + duplicate-target gates that
 * composio sends get. The shim now runs those gates for send-kind MCP tools.
 * Exercised under a `['*']` plan-scope (the realistic auto-approved case where
 * the integrity gate is the ONLY remaining guard — no human in the loop).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mcp-integrity-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
// YOLO mode: the shim's approval is sessionId-blind (a plan-scope can't
// auto-approve there), so YOLO is how an MCP send passes approval with NO human
// in the loop — exactly the case where the integrity gate is the only guard.
writeFileSync(
  path.join(TMP_HOME, 'state', 'proactivity-policy.json'),
  JSON.stringify({ autoApproveScope: 'yolo' }),
  'utf-8',
);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MCPServer } from '@openai/agents';

const { createMcpNamespaceShim } = await import('./mcp-namespace-shim.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('./harness/brackets.js');
const { createSession, writeToolOutput, listEvents, resetEventLog } = await import('./harness/eventlog.js');
const grounding = await import('./harness/grounding-gate.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

function makeSendServer(name: string): MCPServer & { _calls: Array<{ tool: string; args: unknown }> } {
  const calls: Array<{ tool: string; args: unknown }> = [];
  const server: MCPServer = {
    name,
    cacheToolsList: false,
    toolFilter: undefined,
    async connect() {},
    async close() {},
    async listTools() { return [{ name: 'send_email' }] as any; },
    async callTool(toolName, args) {
      calls.push({ tool: toolName, args });
      return { content: [{ type: 'text', text: `${name}:${toolName} sent` }] } as any;
    },
    async invalidateToolsCache() {},
  };
  Object.defineProperty(server, '_calls', { get: () => calls, enumerable: true });
  return server as any;
}

test('MCP send gets grounding + duplicate gates under a `*` scope (the only guard with no human)', async () => {
  resetEventLog();
  grounding._resetGroundingStateForTests();
  grounding._resetDuplicateStateForTests();
  const sess = createSession({ kind: 'chat' });

  // The agent's own extraction artifact for this target (Denver).
  writeToolOutput({
    sessionId: sess.id,
    callId: 'c_extract',
    tool: 'mcp__research__lookup',
    output: 'Eley Law Firm; verified term "workers compensation lawyer Denver"; contact cliff@eleylawfirm.com',
  });
  grounding._setGroundingJudgeForTests(async (payload) => payload.includes('Houston')
    ? { grounded: false, reason: 'Payload claims Houston; the extraction artifact says Denver.' }
    : { grounded: true, reason: 'Matches the Denver extraction.' });

  // YOLO (set at file top) auto-approves the send with no human — so the
  // integrity gate is the ONLY thing between a corrupted/duplicate send and the
  // wire. Exactly the case the gate must cover.
  const server = makeSendServer('gmail');
  const shim = createMcpNamespaceShim({ servers: [server], cacheToolsList: false });
  await shim.listTools();
  const counter = new ToolCallsCounter(100);
  const send = (subject: string) =>
    withHarnessRunContext({ sessionId: sess.id, counter }, () =>
      shim.callTool('gmail__send_email', { to_email: 'cliff@eleylawfirm.com', subject, body: `${subject} body` }));

  try {
    // 1. Corrupted payload (Houston) → grounding soft-blocks BEFORE dispatch.
    await assert.rejects(
      () => Promise.resolve(send('Houston workers comp gap')),
      (err: Error) => { assert.match(err.message, /GROUNDING_CHECK_FAILED/); assert.match(err.message, /Denver/); return true; },
    );
    assert.equal(server._calls.length, 0, 'blocked send never reached the server');

    // 2. Faithful payload (Denver) → passes + records the shared external_write.
    await send('Denver comp search gap');
    assert.equal(server._calls.length, 1, 'faithful send dispatched');
    assert.ok(
      listEvents(sess.id, { types: ['external_write'] }).some((e) => (e.data as { mcp?: boolean }).mcp === true),
      'an mcp external_write was recorded in the shared ledger',
    );

    // 3. Re-send to the SAME target → duplicate bump fires once…
    await assert.rejects(
      () => Promise.resolve(send('Denver comp search gap')),
      (err: Error) => { assert.match(err.message, /DUPLICATE_EXTERNAL_WRITE/); assert.match(err.message, /cliff@eleylawfirm\.com/); return true; },
    );
    assert.equal(server._calls.length, 1, 'duplicate blocked before dispatch');

    // …and the conscious retry passes (speed bump, not a wall).
    await send('Denver comp search gap');
    assert.equal(server._calls.length, 2, 'conscious re-send went through');
  } finally {
    grounding._setGroundingJudgeForTests(null);
  }
});

test('MCP EXEC tool with a network-mutation command gets grounding too (audit #6)', async () => {
  // kernel exec_command classifies `execute`, not `send`, so the send path
  // misses it — but `{command:'curl', args:['-X','POST',…body…]}` IS a network
  // mutation. The arg-shape detector routes it through the same grounding.
  resetEventLog();
  grounding._resetGroundingStateForTests();
  grounding._resetDuplicateStateForTests();
  const sess = createSession({ kind: 'chat' });
  writeToolOutput({
    sessionId: sess.id, callId: 'c_extract', tool: 'mcp__research__lookup',
    output: 'Eley Law Firm; verified term "workers compensation lawyer Denver"; contact cliff@eleylawfirm.com',
  });
  grounding._setGroundingJudgeForTests(async (payload) => payload.includes('Houston')
    ? { grounded: false, reason: 'Payload claims Houston; artifact says Denver.' }
    : { grounded: true, reason: 'matches' });
  const server = makeSendServer('kernel'); // reuse the fake; we override the tool name below
  (server as any).listTools = async () => [{ name: 'exec_command' }];
  const shim = createMcpNamespaceShim({ servers: [server], cacheToolsList: false });
  await shim.listTools();
  const counter = new ToolCallsCounter(100);
  const exec = (city: string) =>
    withHarnessRunContext({ sessionId: sess.id, counter }, () =>
      shim.callTool('kernel__exec_command', {
        session_id: 's1',
        command: 'curl',
        args: ['-X', 'POST', 'https://api.example.com/send', '-d', `{"to_email":"cliff@eleylawfirm.com","body":"${city} gap"}`],
      }));
  try {
    // exec_command classifies as `execute` → would normally NOT be approval-blocked
    // in strict either (execute asks)… so set YOLO at file top already covers it.
    await assert.rejects(() => Promise.resolve(exec('Houston')), /GROUNDING_CHECK_FAILED/);
    assert.equal((server as any)._calls.length, 0, 'blocked exec never reached the server');
    await exec('Denver');
    assert.equal((server as any)._calls.length, 1, 'faithful exec dispatched');
  } finally {
    grounding._setGroundingJudgeForTests(null);
  }
});

test('MCP READ tool is untouched by the integrity gate (no false gating)', async () => {
  resetEventLog();
  grounding._resetGroundingStateForTests();
  const sess = createSession({ kind: 'chat' });
  const calls: Array<{ tool: string }> = [];
  const server: MCPServer = {
    name: 'airtable', cacheToolsList: false, toolFilter: undefined,
    async connect() {}, async close() {}, async invalidateToolsCache() {},
    async listTools() { return [{ name: 'list_records' }] as any; },
    async callTool(toolName) { calls.push({ tool: toolName }); return { content: [] } as any; },
  };
  const shim = createMcpNamespaceShim({ servers: [server], cacheToolsList: false });
  await shim.listTools();
  const counter = new ToolCallsCounter(100);
  await withHarnessRunContext({ sessionId: sess.id, counter }, () =>
    shim.callTool('airtable__list_records', { baseId: 'b1' }));
  assert.equal(calls.length, 1, 'read dispatched with no gate interference');
  assert.equal(listEvents(sess.id, { types: ['external_write'] }).length, 0, 'no external_write for a read');
});
