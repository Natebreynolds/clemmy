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
const { withHarnessRunContext, ToolCallsCounter, wrapToolForHarness } = await import('./harness/brackets.js');
const { appendEvent, createSession, listEvents } = await import('./harness/eventlog.js');
const { grantSendTrust, openPlanScope, revokeSendTrust } = await import('../agents/plan-scope.js');
const { saveProactivityPolicy } = await import('../agents/proactivity-policy.js');
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

function returnedFailureServer(name: string, toolName: string, message: string): MCPServer {
  return {
    name, cacheToolsList: false, toolFilter: undefined,
    async connect() {}, async close() {}, async invalidateToolsCache() {},
    async listTools() {
      return [{ name: toolName, description: 'write', inputSchema: { type: 'object' } }] as unknown as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool() {
      const content = [{ type: 'text', text: message }] as unknown as Awaited<ReturnType<MCPServer['callTool']>> & { isError?: boolean };
      content.isError = true;
      return content;
    },
  } as unknown as MCPServer;
}

function successfulServer(
  name: string,
  toolName: string,
  onDispatch?: () => Promise<void> | void,
): MCPServer {
  return {
    name, cacheToolsList: false, toolFilter: undefined,
    async connect() {}, async close() {}, async invalidateToolsCache() {},
    async listTools() {
      return [{ name: toolName, description: 'send', inputSchema: { type: 'object' } }] as unknown as Awaited<ReturnType<MCPServer['listTools']>>;
    },
    async callTool() {
      await onDispatch?.();
      return [{ type: 'text', text: 'sent' }] as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
    },
  } as unknown as MCPServer;
}

const ctx = (sessionId: string, sourceUserSeq?: number): HarnessRunContext => ({
  sessionId,
  counter: new ToolCallsCounter(100),
  ...(sourceUserSeq ? { sourceUserSeq } : {}),
});

test('a native send tool name classifies as an irreversible send', () => {
  assert.equal(classifyMcpIntegrityScope('send_email', 'read').isIrreversibleSend, true);
});

test('ordinary native MCP creates and updates require durable integrity admission', () => {
  const create = classifyMcpIntegrityScope(
    'airtable__create_record',
    'write',
    { base_id: 'app1', table_id: 'tbl1', fields: { Name: 'Ada' } },
  );
  assert.equal(create.isIrreversibleSend, false);
  assert.equal(create.needsIntegrityChecks, true);
  const update = classifyMcpIntegrityScope(
    'notion__update_page',
    'write',
    { page_id: 'page1', properties: { Status: 'Done' } },
  );
  assert.equal(update.isIrreversibleSend, false);
  assert.equal(update.needsIntegrityChecks, true);
  assert.equal(
    classifyMcpIntegrityScope('airtable__list_records', 'read', { base_id: 'app1' }).needsIntegrityChecks,
    false,
  );
  assert.equal(
    classifyMcpIntegrityScope(
      'opaque__records_v2',
      'write',
      { record: { name: 'Ada' } },
    ).needsIntegrityChecks,
    true,
    'the authoritative MCP taxonomy must close opaque-name write bypasses',
  );
});

function authorizeSend(sid: string, namespaced: string, tool: string): void {
  openPlanScope({
    sessionId: sid, planProposalId: 'p-test', approvedPlanObjective: 'send outreach',
    goalScoped: { goalId: `g-${sid}` }, allowedSends: [namespaced, tool], allowedTools: [namespaced, tool],
  });
}

test('ordinary native MCP writes reserve before dispatch and settle only a clean acknowledgement', async () => {
  const slug = 'airtable';
  const tool = 'create_record';
  let dispatches = 0;
  const shim = createMcpNamespaceShim({
    servers: [successfulServer(slug, tool, () => { dispatches += 1; })],
  });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;
  const source = appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the approved Airtable record.' },
  });
  openPlanScope({
    sessionId: sid,
    planProposalId: 'p-airtable-write',
    approvedPlanObjective: 'create the record',
    goalScoped: { goalId: 'g-airtable-write' },
    allowedTools: [namespaced, tool],
    allowedSends: [],
  });

  await withHarnessRunContext(ctx(sid, source.seq), async () => {
    await shim.listTools();
    await shim.callTool(namespaced, {
      base_id: 'app1',
      table_id: 'tbl1',
      fields: { Name: 'Ada' },
    });
  });

  assert.equal(dispatches, 1);
  const [reservation] = listEvents(sid, { types: ['external_write'] });
  assert.equal(reservation?.data.preDispatch, true);
  assert.equal(reservation?.data.irreversible, false);
  assert.equal(reservation?.data.sourceUserSeq, source.seq);
  assert.equal(listEvents(sid, { types: ['external_write_succeeded'] }).length, 1);
  assert.equal(listEvents(sid, { types: ['external_write_orphaned'] }).length, 0);
});

test('valid-shaped native MCP failure prose and empty envelopes never certify a write', async () => {
  const cases = [
    { slug: 'airtable-plain-invalid', result: [{ type: 'text', text: 'Invalid JSON input' }] },
    { slug: 'airtable-plain-auth', result: [{ type: 'text', text: 'HTTP 401 Unauthorized: provider rejected the request' }] },
    { slug: 'airtable-empty', result: [] },
  ] as const;
  for (const [index, entry] of cases.entries()) {
    let dispatches = 0;
    const server = successfulServer(entry.slug, 'create_record');
    server.callTool = async () => {
      dispatches += 1;
      return entry.result as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
    };
    const shim = createMcpNamespaceShim({ servers: [server] });
    const namespaced = namespaceToolName(slugifyServerName(entry.slug), 'create_record');
    const sid = createSession({ kind: 'execution' }).id;
    const source = appendEvent({
      sessionId: sid,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: `Create provider-failure fixture ${index}.` },
    });
    openPlanScope({
      sessionId: sid,
      planProposalId: `p-native-failure-${index}`,
      approvedPlanObjective: 'create the record once',
      goalScoped: { goalId: `g-native-failure-${index}` },
      allowedTools: [namespaced, 'create_record'],
      allowedSends: [],
    });
    await withHarnessRunContext(ctx(sid, source.seq), async () => {
      await shim.listTools();
      await shim.callTool(namespaced, {
        base_id: 'app1',
        table_id: 'tbl1',
        fields: { Name: `Case ${index}` },
      });
    });
    assert.equal(dispatches, 1, entry.slug);
    assert.equal(listEvents(sid, { types: ['external_write'] }).length, 1, entry.slug);
    assert.equal(listEvents(sid, { types: ['external_write_succeeded'] }).length, 0, entry.slug);
    assert.equal(listEvents(sid, { types: ['external_write_orphaned'] }).length, 1, entry.slug);
  }
});

test('G: an AMBIGUOUS send throw (timeout / dropped response) records external_write PRE-dispatch + an orphan marker (send stays counted)', async () => {
  const slug = 'gmailish';
  const tool = 'send_email';
  assert.equal(classifyMcpIntegrityScope(tool, 'read').isIrreversibleSend, true, 'test tool must be a send');
  const shim = createMcpNamespaceShim({ servers: [throwingServer(slug, tool, 'ETIMEDOUT: request timed out; response dropped after send')] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;
  const source = appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the approved email.' },
  });
  authorizeSend(sid, namespaced, tool);

  await withHarnessRunContext(ctx(sid, source.seq), async () => {
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
  assert.equal((writes[0].data as { sourceUserSeq?: number }).sourceUserSeq, source.seq);
  assert.ok((w.targets ?? []).some((t) => String(t).toLowerCase().includes('lead@example.com')), 'target captured for the duplicate wall');
  assert.equal(typeof writes[0].data.correlationFingerprint, 'string');

  // Ambiguous → orphan (NOT compensated); the pre-record stays counted so a resume
  // re-send is refused.
  const orphaned = listEvents(sid, { types: ['external_write_orphaned'] });
  assert.equal(orphaned.length, 1, 'ambiguous throw → orphan');
  assert.equal(
    orphaned[0]?.data.correlationFingerprint,
    writes[0]?.data.correlationFingerprint,
    'the attempt and outcome carry the same one-way payload identity',
  );
  assert.equal(listEvents(sid, { types: ['external_write_failed'] }).length, 0, 'ambiguous throw is NOT compensated');
});

test('G: provider auth/DNS/bad-params throws remain ambiguous after invocation starts', async () => {
  const slug = 'gmailish2';
  const tool = 'send_email';
  const shim = createMcpNamespaceShim({ servers: [throwingServer(slug, tool, 'Request failed: 401 Unauthorized — permission denied')] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;
  const source = appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the approved email.' },
  });
  authorizeSend(sid, namespaced, tool);

  await withHarnessRunContext(ctx(sid, source.seq), async () => {
    await shim.listTools();
    await assert.rejects(() => shim.callTool(namespaced, { to: 'lead@example.com', subject: 'Hi' }));
  });

  assert.equal(listEvents(sid, { types: ['external_write'] }).length, 1, 'pre-record present');
  assert.equal(listEvents(sid, { types: ['external_write_failed'] }).length, 0, 'provider prose cannot compensate');
  assert.equal(listEvents(sid, { types: ['external_write_orphaned'] }).length, 1, 'the post-boundary throw is orphaned');
  assert.ok(
    listEvents(sid, { types: ['external_write', 'external_write_orphaned'] })
      .every((event) => event.data.sourceUserSeq === source.seq),
    'both the attempt and its resolution retain exact request ownership',
  );
});

test('returned native MCP failure envelopes never become successful write receipts', async () => {
  const cases = [
    {
      slug: 'gmail-returned-failure',
      tool: 'send_email',
      args: { to: 'lead@example.com', subject: 'Hi' },
      expectedAttempts: 1,
    },
    {
      slug: 'browser',
      tool: 'request',
      args: {
        method: 'PATCH',
        url: 'https://example.test/records/1',
        body: { status: 'reviewed' },
      },
      expectedAttempts: 1,
    },
  ] as const;

  for (const [index, entry] of cases.entries()) {
    const shim = createMcpNamespaceShim({
      servers: [returnedFailureServer(
        entry.slug,
        entry.tool,
        '[provider-dispatch:not-started:invalid-args] 400 validation failed: missing required field',
      )],
    });
    const namespaced = namespaceToolName(slugifyServerName(entry.slug), entry.tool);
    const sid = createSession({ kind: 'execution' }).id;
    const source = appendEvent({
      sessionId: sid,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: `Run returned-failure write ${index + 1}.` },
    });
    openPlanScope({
      sessionId: sid,
      planProposalId: `p-returned-${index}`,
      approvedPlanObjective: 'perform the approved test write',
      goalScoped: { goalId: `g-returned-${index}` },
      allowedSends: [namespaced, entry.tool],
      allowedTools: [namespaced, entry.tool],
    });

    await withHarnessRunContext(ctx(sid, source.seq), async () => {
      await shim.listTools();
      await shim.callTool(namespaced, entry.args as unknown as Record<string, unknown>);
    });

    const attempts = listEvents(sid, { types: ['external_write'] });
    const failed = listEvents(sid, { types: ['external_write_failed'] });
    const orphaned = listEvents(sid, { types: ['external_write_orphaned'] });
    assert.equal(attempts.length, entry.expectedAttempts, namespaced);
    assert.equal(failed.length, 0, namespaced);
    assert.equal(orphaned.length, entry.expectedAttempts, namespaced);
    if (entry.expectedAttempts > 0) {
      assert.equal(orphaned[0]?.data.sourceUserSeq, source.seq, namespaced);
    }
  }
});

test('concurrent identical native sends admit exactly one provider dispatch', async () => {
  const slug = 'gmail-race';
  const tool = 'send_email';
  let dispatches = 0;
  const shim = createMcpNamespaceShim({
    servers: [successfulServer(slug, tool, async () => {
      dispatches += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
    })],
  });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;
  const source = appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the approved email exactly once.' },
  });
  authorizeSend(sid, namespaced, tool);

  const settled = await withHarnessRunContext(ctx(sid, source.seq), async () => {
    await shim.listTools();
    return Promise.allSettled([
      shim.callTool(namespaced, { to: 'same@example.com', subject: 'One', body: 'Only once' }),
      shim.callTool(namespaced, { to: 'same@example.com', subject: 'One', body: 'Only once' }),
    ]);
  });

  assert.equal(dispatches, 1);
  assert.deepEqual(
    settled.map((entry) => entry.status).sort(),
    ['fulfilled', 'rejected'],
  );
  assert.equal(listEvents(sid, { types: ['external_write'] }).length, 1);
});

test('concurrent distinct native sends cannot race past the batch-consent threshold', async () => {
  const priorConfirmFirst = process.env.CLEMMY_CONFIRM_FIRST;
  process.env.CLEMMY_CONFIRM_FIRST = 'on';
  saveProactivityPolicy({ autoApproveScope: 'balanced', batchConfirmThreshold: 3 });
  let sendTrustId: string | undefined;
  try {
    const slug = 'gmail-batch-race';
    const tool = 'send_email';
    let dispatches = 0;
    const shim = createMcpNamespaceShim({
      servers: [successfulServer(slug, tool, async () => {
        dispatches += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      })],
    });
    const namespaced = namespaceToolName(slugifyServerName(slug), tool);
    const sid = createSession({ kind: 'execution' }).id;
    const source = appendEvent({
      sessionId: sid,
      turn: 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Send distinct messages, but stop at the batch approval floor.' },
    });
    const recipients = Array.from({ length: 5 }, (_, index) =>
      `distinct-${index + 1}@example.com`
    );
    sendTrustId = grantSendTrust({
      recipients,
      note: 'test-only exact recipients below the per-call mass-send floor',
    })?.id;
    assert.ok(sendTrustId, 'narrow send trust lets each individual call reach batch admission');

    const settled = await withHarnessRunContext(ctx(sid, source.seq), async () => {
      await shim.listTools();
      return Promise.allSettled(
        recipients.map((recipient, index) =>
          shim.callTool(namespaced, {
            to: recipient,
            subject: `Message ${index + 1}`,
          })
        ),
      );
    });

    assert.equal(dispatches, 2, 'only sends below the threshold reach the provider');
    assert.equal(
      settled.filter((entry) => entry.status === 'fulfilled').length,
      2,
    );
    assert.equal(
      settled.filter((entry) => entry.status === 'rejected').length,
      3,
    );
    assert.equal(listEvents(sid, { types: ['external_write'] }).length, 2);
  } finally {
    if (sendTrustId) revokeSendTrust(sendTrustId);
    saveProactivityPolicy({ autoApproveScope: 'balanced', batchConfirmThreshold: 5 });
    if (priorConfirmFirst === undefined) delete process.env.CLEMMY_CONFIRM_FIRST;
    else process.env.CLEMMY_CONFIRM_FIRST = priorConfirmFirst;
  }
});

test('native duplicate safety preserves recipients beyond the eighth identity', async () => {
  const slug = 'gmail-many-recipients';
  const tool = 'send_email';
  let dispatches = 0;
  const shim = createMcpNamespaceShim({
    servers: [successfulServer(slug, tool, () => { dispatches += 1; })],
  });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;
  const source = appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send this approved message to the ten listed recipients exactly once.' },
  });
  authorizeSend(sid, namespaced, tool);
  const recipients = Array.from({ length: 10 }, (_, index) => `person-${index + 1}@example.com`);

  await withHarnessRunContext(ctx(sid, source.seq), async () => {
    await shim.listTools();
    await shim.callTool(namespaced, { recipients, subject: 'One message' });
    await assert.rejects(
      () => shim.callTool(namespaced, { to: recipients[8], subject: 'Blind retry' }),
      /duplicate|already sent/i,
    );
  });

  assert.equal(dispatches, 1);
  const write = listEvents(sid, { types: ['external_write'] })[0];
  const targets = (write?.data as { targets?: string[] } | undefined)?.targets ?? [];
  assert.ok(targets.includes(recipients[8]), 'the safety ledger keeps recipient nine');
  assert.ok(targets.includes(recipients[9]), 'the safety ledger keeps recipient ten');
});

test('fresh resend approval is previewed without consumption and authorizes exactly one native resend', async () => {
  const slug = 'gmail-resend-consent';
  const tool = 'send_email';
  let dispatches = 0;
  const shim = createMcpNamespaceShim({
    servers: [successfulServer(slug, tool, () => { dispatches += 1; })],
  });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;
  const source = appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the approved email, then honor one separately approved follow-up.' },
  });
  authorizeSend(sid, namespaced, tool);
  const args = {
    to: 'approved-resend@example.com',
    subject: 'Approved follow-up',
    body: 'Same exact follow-up',
  };

  await withHarnessRunContext(ctx(sid, source.seq), async () => {
    await shim.listTools();
    await shim.callTool(namespaced, args);
    // Resend consent must resolve strictly after the prior write reservation.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const approvals = await import('./harness/approval-registry.js');
    const approval = approvals.register({
      sessionId: sid,
      subject: `Send a second email to ${args.to}`,
      tool: namespaced,
      args,
      ttlMs: 60_000,
    });
    approvals.resolve(approval.approvalId, 'approved', 'native-resend-test');

    await shim.callTool(namespaced, args);
    await assert.rejects(
      () => shim.callTool(namespaced, args),
      /duplicate|already sent/i,
      'the same approval is one-shot and cannot authorize a third dispatch',
    );
  });

  assert.equal(dispatches, 2, 'initial send plus one approved resend reach the provider');
  assert.equal(listEvents(sid, { types: ['external_write'] }).length, 2);
});

test('native MCP refuses a same-recipient email already reserved through Composio', async () => {
  const slug = 'outlook-cross-transport';
  const tool = 'send_email';
  let dispatches = 0;
  const shim = createMcpNamespaceShim({
    servers: [successfulServer(slug, tool, () => { dispatches += 1; })],
  });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;
  const source = appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the approved email exactly once.' },
  });
  appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'system',
    type: 'external_write',
    data: {
      sourceUserSeq: source.seq,
      toolName: 'composio_execute_tool',
      shapeKey: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
      targets: ['cross-transport@example.com'],
    },
  });
  authorizeSend(sid, namespaced, tool);

  await withHarnessRunContext(ctx(sid, source.seq), async () => {
    await shim.listTools();
    await assert.rejects(
      () => shim.callTool(namespaced, {
        to: 'cross-transport@example.com',
        subject: 'Do not send twice',
      }),
      /duplicate|already sent/i,
    );
  });

  assert.equal(dispatches, 0);
});

test('targetless social duplicate identity matches across Composio and native MCP transports', async () => {
  const previousExecutionGate = process.env.CLEMMY_EXECUTION_GATE;
  const previousGroundingGate = process.env.CLEMMY_GROUNDING_GATE;
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  process.env.CLEMMY_GROUNDING_GATE = 'off';
  const slug = 'linkedin';
  const tool = 'create_post';
  let nativeDispatches = 0;
  const shim = createMcpNamespaceShim({
    servers: [successfulServer(slug, tool, () => { nativeDispatches += 1; })],
  });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;
  const source = appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Publish this exact LinkedIn launch note once.' },
  });
  const payload = { text: 'Clementine 3.0 launches today.', visibility: 'PUBLIC' };
  authorizeSend(sid, namespaced, tool);
  const composio = wrapToolForHarness({
    name: 'composio_execute_tool',
    execute: async () => ({ successful: true, data: { id: 'urn:li:share:123' } }),
  });
  try {
    await withHarnessRunContext(ctx(sid, source.seq), async () => {
      await composio.execute!({
        tool_slug: 'LINKEDIN_CREATE_POST',
        arguments: payload,
      });
      await shim.listTools();
      await assert.rejects(
        () => shim.callTool(namespaced, payload),
        /duplicate|already sent/i,
      );
    });
    assert.equal(nativeDispatches, 0);
    const writes = listEvents(sid, { types: ['external_write'] });
    assert.equal(writes.length, 1);
    assert.match(
      String((writes[0]?.data.duplicateIdentityKeys as string[] | undefined)?.[0] ?? ''),
      /^payload:semantic-v1:/,
    );
  } finally {
    if (previousExecutionGate === undefined) delete process.env.CLEMMY_EXECUTION_GATE;
    else process.env.CLEMMY_EXECUTION_GATE = previousExecutionGate;
    if (previousGroundingGate === undefined) delete process.env.CLEMMY_GROUNDING_GATE;
    else process.env.CLEMMY_GROUNDING_GATE = previousGroundingGate;
  }
});

test('a malformed post-dispatch MCP response remains ambiguous, never retry-safe', async () => {
  const slug = 'gmail-malformed-response';
  const tool = 'send_email';
  let dispatches = 0;
  const malformed = successfulServer(slug, tool);
  malformed.callTool = async () => {
    dispatches += 1;
    return { success: true, providerId: 'sent-123' } as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
  };
  const shim = createMcpNamespaceShim({ servers: [malformed] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;
  const source = appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the approved email.' },
  });
  authorizeSend(sid, namespaced, tool);

  await withHarnessRunContext(ctx(sid, source.seq), async () => {
    await shim.listTools();
    await shim.callTool(namespaced, { to: 'lead@example.com', subject: 'Hi' });
  });

  assert.equal(dispatches, 1);
  assert.equal(listEvents(sid, { types: ['external_write'] }).length, 1);
  assert.equal(listEvents(sid, { types: ['external_write_failed'] }).length, 0);
  assert.equal(listEvents(sid, { types: ['external_write_orphaned'] }).length, 1);
});

test('a missing-text MCP result after dispatch remains ambiguous despite invalid-response wording', async () => {
  const slug = 'gmail-missing-text-response';
  const tool = 'send_email';
  let dispatches = 0;
  const malformed = successfulServer(slug, tool);
  malformed.callTool = async () => {
    dispatches += 1;
    return [{ type: 'text' }] as unknown as Awaited<ReturnType<MCPServer['callTool']>>;
  };
  const shim = createMcpNamespaceShim({ servers: [malformed] });
  const namespaced = namespaceToolName(slugifyServerName(slug), tool);
  const sid = createSession({ kind: 'execution' }).id;
  const source = appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the approved email.' },
  });
  authorizeSend(sid, namespaced, tool);

  await withHarnessRunContext(ctx(sid, source.seq), async () => {
    await shim.listTools();
    await shim.callTool(namespaced, { to: 'missing-text@example.com', subject: 'Hi' });
  });

  assert.equal(dispatches, 1);
  assert.equal(listEvents(sid, { types: ['external_write'] }).length, 1);
  assert.equal(listEvents(sid, { types: ['external_write_failed'] }).length, 0);
  assert.equal(listEvents(sid, { types: ['external_write_orphaned'] }).length, 1);
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
