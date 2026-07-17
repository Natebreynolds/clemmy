import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-trace-accounting-'));
process.env.CLEMENTINE_HOME = home;

const eventlog = await import('../runtime/harness/eventlog.js');
const { toolCallCorrelationFingerprint } = await import('../runtime/harness/tool-correlation.js');
const trace = await import('./trace-to-workflow.js');

after(() => rmSync(home, { recursive: true, force: true }));

test('native MCP mirror remains audit evidence but reconstructs as one action with canonical return evidence', () => {
  eventlog.resetEventLog();
  const session = eventlog.createSession({ kind: 'chat' });
  const longBody = 'private-firm-research '.repeat(30);
  assert.ok(longBody.length > 500);
  const fullArgs = { tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT', arguments: { title: 'Firm brief', content: longBody } };
  const args = JSON.stringify(fullArgs);
  const correlationFingerprint = toolCallCorrelationFingerprint('composio_execute_tool', fullArgs);
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: { tool: 'composio_execute_tool', callId: 'toolu-create-doc', accounting: 'top_level', arguments: args, correlationFingerprint },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'composio_execute_tool',
      callId: 'mcp-create-doc',
      accounting: 'transport_mirror',
      args: { tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT', arguments: { title: 'Firm brief', content: `${longBody.slice(0, 300)}…` } },
      correlationFingerprint,
    },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: {
      tool: 'composio_execute_tool',
      callId: 'mcp-create-doc',
      accounting: 'transport_mirror',
      ok: false,
      error: 'provider rejected duplicate title',
    },
  });
  eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { tool: 'composio_execute_tool', callId: 'toolu-create-doc', accounting: 'top_level', ok: false },
  });

  assert.equal(eventlog.listEvents(session.id, { types: ['tool_called'] }).length, 2, 'raw audit rows remain intact');
  const calls = trace.readSessionTrace(session.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callId, 'toolu-create-doc');
  assert.equal(calls[0].slug, 'GOOGLEDOCS_CREATE_DOCUMENT');
  assert.equal(trace.draftWorkflowFromSession(session.id).toolCallCount, 1);
  assert.match(trace.readSessionToolReturns(session.id).get('toolu-create-doc') ?? '', /provider rejected duplicate title/);
});
