/**
 * Run: npx tsx --test src/runtime/mcp-namespace-shim.resume-writeledger.test.ts
 *
 * Wave 4 Stage 1 (adversarial review finding G): a native-MCP irreversible SEND
 * must record its external_write ledger entry PRE-dispatch, so a throw AFTER the
 * backend already committed (timeout / dropped response / 5xx-after-send) still
 * leaves an entry and the shared duplicate-send wall refuses a re-send on resume.
 * Previously the entry was written only on the RETURN path, so a throw-after-commit
 * left nothing → a real irreversible double-send on the autonomous-resume flow.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-shim-writeledger-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-writeledger-test\n', 'utf-8');
// Let the send reach dispatch (we are testing the ledger, not the approval gate).
process.env.CLEMMY_CONFIRM_FIRST = 'off';

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { MCPServer } from '@openai/agents';

const { createMcpNamespaceShim, namespaceToolName, slugifyServerName, classifyMcpIntegrityScope } = await import('./mcp-namespace-shim.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('./harness/brackets.js');
const { createSession, listEvents } = await import('./harness/eventlog.js');
const { openPlanScope } = await import('../agents/plan-scope.js');
type HarnessRunContext = import('./harness/brackets.js').HarnessRunContext;

after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

// A server whose tool THROWS with a configurable error (ambiguous timeout vs a
// demonstrably-never-sent failure).
function throwingServer(name: string, toolName: string, errMessage: string): MCPServer {
  return {
    name, cacheToolsList: false, toolFilter: undefined,
    async connect() {}, async close() {}, async invalidateToolsCache() {},
    async listTools() {
      return [{ name: toolName, description: 'send', inputSchema: { type: 'object' } }] as unknown as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool() {
      throw new Error(errMessage);
    },
  } as unknown as MCPServer;
}

const ctx = (sessionId: string): HarnessRunContext => ({ sessionId, counter: new ToolCallsCounter(100) });

test('a native send tool name classifies as an irreversible send', () => {
  assert.equal(classifyMcpIntegrityScope('send_email', 'read').isIrreversibleSend, true);
});

function authorizeSend(sid: string, namespaced: string, tool: string): void {
  openPlanScope({
    sessionId: sid, planProposalId: 'p-test', approvedPlanObjective: 'send outreach',
    goalScoped: { goalId: `g-${sid}` }, allowedSends: [namespaced, tool], allowedTools: [namespaced, tool],
  });
}

test('G: an AMBIGUOUS send throw (timeout / dropped response) records external_write PRE-dispatch + an orphan marker (send stays counted)', async () => {
  const slug = 'gmailish';
  const tool = 'send_email';
  assert.equal(classifyMcpIntegrityScope(tool, 'read').isIrreversibleSend, true, 'test tool must be a send');
  const shim = createMcpNamespaceShim({ servers: [throwingServer(slug, tool, 'ETIMEDOUT: request timed out; response dropped after send')] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;
  authorizeSend(sid, namespaced, tool);

  await withHarnessRunContext(ctx(sid), async () => {
    await shim.listTools();
    await assert.rejects(
      () => shim.callTool(namespaced, { to: 'lead@example.com', subject: 'Hi' }),
      'the throwing dispatch surfaces as an error',
    );
  });

  const writes = listEvents(sid, { types: ['external_write'] });
  assert.equal(writes.length, 1, 'the send was recorded in the ledger despite the throw');
  const w = writes[0].data as { irreversible?: boolean; preDispatch?: boolean; targets?: string[] };
  assert.equal(w.irreversible, true);
  assert.equal(w.preDispatch, true, 'recorded PRE-dispatch (so a throw-after-commit is still counted)');
  assert.ok((w.targets ?? []).some((t) => String(t).toLowerCase().includes('lead@example.com')), 'target captured for the duplicate wall');

  // Ambiguous → orphan (NOT compensated); the pre-record stays counted so a resume
  // re-send is refused.
  assert.equal(listEvents(sid, { types: ['external_write_orphaned'] }).length, 1, 'ambiguous throw → orphan');
  assert.equal(listEvents(sid, { types: ['external_write_failed'] }).length, 0, 'ambiguous throw is NOT compensated');
});

test('G: a DEMONSTRABLY-never-sent throw (auth 401 / DNS / bad-params) COMPENSATES the pre-record so a legit retry/resume is not blocked', async () => {
  const slug = 'gmailish2';
  const tool = 'send_email';
  const shim = createMcpNamespaceShim({ servers: [throwingServer(slug, tool, 'Request failed: 401 Unauthorized — permission denied')] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;
  authorizeSend(sid, namespaced, tool);

  await withHarnessRunContext(ctx(sid), async () => {
    await shim.listTools();
    await assert.rejects(() => shim.callTool(namespaced, { to: 'lead@example.com', subject: 'Hi' }));
  });

  // The pre-record is netted out by external_write_failed → writes==fails → the
  // workflow resume guard (writes>fails) is false → the recipient is RE-SENT, not
  // dropped; and the duplicate wall (which nets external_write_failed) allows retry.
  assert.equal(listEvents(sid, { types: ['external_write'] }).length, 1, 'pre-record present');
  assert.equal(listEvents(sid, { types: ['external_write_failed'] }).length, 1, 'a demonstrable failure compensates (parity with composio)');
  assert.equal(listEvents(sid, { types: ['external_write_orphaned'] }).length, 0, 'a demonstrable failure is not an orphan');
});

test('G negative: a READ tool whose dispatch throws records NO external_write (only sends are pre-recorded)', async () => {
  const slug = 'serpish';
  const tool = 'serp_organic_live_advanced';
  assert.equal(classifyMcpIntegrityScope(tool, 'read').isIrreversibleSend, false, 'test tool must be a read');
  const shim = createMcpNamespaceShim({ servers: [throwingServer(slug, tool, 'ETIMEDOUT')] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;

  await withHarnessRunContext(ctx(sid), async () => {
    await shim.listTools();
    await assert.rejects(() => shim.callTool(namespaced, { target: 'acme.example' }));
  });

  assert.equal(listEvents(sid, { types: ['external_write'] }).length, 0, 'a read never records an external_write');
});
