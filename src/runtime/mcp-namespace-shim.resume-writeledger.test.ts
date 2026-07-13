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

// A server whose tool THROWS after "committing" the send (the routine
// timeout/dropped-response mode this fix targets).
function throwingServer(name: string, toolName: string): MCPServer {
  return {
    name, cacheToolsList: false, toolFilter: undefined,
    async connect() {}, async close() {}, async invalidateToolsCache() {},
    async listTools() {
      return [{ name: toolName, description: 'send', inputSchema: { type: 'object' } }] as unknown as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool() {
      throw new Error('socket hang up (ETIMEDOUT) — response dropped after send');
    },
  } as unknown as MCPServer;
}

const ctx = (sessionId: string): HarnessRunContext => ({ sessionId, counter: new ToolCallsCounter(100) });

test('a native send tool name classifies as an irreversible send', () => {
  assert.equal(classifyMcpIntegrityScope('send_email', 'read').isIrreversibleSend, true);
});

test('G: an irreversible SEND whose dispatch THROWS still records external_write PRE-dispatch + an orphan marker', async () => {
  const slug = 'gmailish';
  const tool = 'send_email';
  assert.equal(classifyMcpIntegrityScope(tool, 'read').isIrreversibleSend, true, 'test tool must be a send');
  const shim = createMcpNamespaceShim({ servers: [throwingServer(slug, tool)] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;
  // Authorize the send (a goal-scoped, human-blessed enumerated send scope — the
  // same shape a background swarm's one-batch approval opens) so it reaches
  // dispatch instead of parking at the approval gate.
  openPlanScope({
    sessionId: sid, planProposalId: 'p-test', approvedPlanObjective: 'send outreach',
    goalScoped: { goalId: 'g-test' }, allowedSends: [namespaced, tool], allowedTools: [namespaced, tool],
  });

  await withHarnessRunContext(ctx(sid), async () => {
    await shim.listTools();
    await assert.rejects(
      // No groundable body → the grounding/output-grounding gates fail-open fast.
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

  const orphans = listEvents(sid, { types: ['external_write_orphaned'] });
  assert.equal(orphans.length, 1, 'an orphan marker records the maybe-committed throw for the audit trail');
});

test('G negative: a READ tool whose dispatch throws records NO external_write (only sends are pre-recorded)', async () => {
  const slug = 'serpish';
  const tool = 'serp_organic_live_advanced';
  assert.equal(classifyMcpIntegrityScope(tool, 'read').isIrreversibleSend, false, 'test tool must be a read');
  const shim = createMcpNamespaceShim({ servers: [throwingServer(slug, tool)] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;

  await withHarnessRunContext(ctx(sid), async () => {
    await shim.listTools();
    await assert.rejects(() => shim.callTool(namespaced, { target: 'acme.com' }));
  });

  assert.equal(listEvents(sid, { types: ['external_write'] }).length, 0, 'a read never records an external_write');
});
