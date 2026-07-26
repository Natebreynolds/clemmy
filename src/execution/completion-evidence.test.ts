/**
 * Run: npx tsx --test src/execution/completion-evidence.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventRow } from '../runtime/harness/eventlog.js';
import { recentExecutionToolEvidence } from './completion-evidence.js';

function event(
  seq: number,
  type: 'tool_called' | 'tool_returned',
  data: Record<string, unknown>,
): EventRow {
  return {
    seq,
    id: `event-${seq}`,
    sessionId: 'completion-evidence-session',
    turn: 1,
    role: type === 'tool_called' ? 'agent' : 'tool',
    type,
    parentEventId: null,
    data,
    createdAt: '2026-07-25T20:00:00.000Z',
  };
}

test('completion evidence exposes verified readback and write receipts without bookkeeping noise', () => {
  const events = [
    event(1, 'tool_called', {
      tool: 'execution_update_step',
      callId: 'control-1',
      accounting: 'top_level',
      arguments: '{"id":"exec-1","nextStep":"read it"}',
      effect: 'local_write',
    }),
    event(2, 'tool_returned', {
      tool: 'execution_update_step',
      callId: 'control-1',
      accounting: 'top_level',
      ok: true,
      effect: 'local_write',
    }),
    event(3, 'tool_called', {
      tool: 'composio_search_tools',
      callId: 'discovery-1',
      accounting: 'top_level',
      arguments: '{"query":"google sheets"}',
      effect: 'read',
    }),
    event(4, 'tool_returned', {
      tool: 'composio_search_tools',
      callId: 'discovery-1',
      accounting: 'top_level',
      ok: true,
      effect: 'read',
    }),
    event(5, 'tool_called', {
      tool: 'composio_execute_tool',
      toolSlug: 'GOOGLESHEETS_VALUES_UPDATE',
      callId: 'write-1',
      accounting: 'top_level',
      arguments: JSON.stringify({
        tool_slug: 'GOOGLESHEETS_VALUES_UPDATE',
        arguments: { range: 'Sheet1!A1:B4' },
      }),
      effect: 'external_write',
    }),
    event(6, 'tool_returned', {
      tool: 'composio_execute_tool',
      toolSlug: 'GOOGLESHEETS_VALUES_UPDATE',
      callId: 'write-1',
      accounting: 'top_level',
      ok: true,
      effect: 'external_write',
    }),
    event(7, 'tool_called', {
      tool: 'composio_execute_tool',
      toolSlug: 'GOOGLESHEETS_BATCH_GET',
      callId: 'read-1',
      accounting: 'top_level',
      arguments: JSON.stringify({
        tool_slug: 'GOOGLESHEETS_BATCH_GET',
        arguments: { ranges: ['Sheet1!A1:B4'] },
      }),
      effect: 'read',
    }),
    event(8, 'tool_returned', {
      tool: 'composio_execute_tool',
      toolSlug: 'GOOGLESHEETS_BATCH_GET',
      callId: 'read-1',
      accounting: 'top_level',
      ok: true,
      effect: 'read',
    }),
    event(9, 'tool_called', {
      tool: 'composio_execute_tool',
      toolSlug: 'GOOGLESHEETS_BATCH_GET',
      callId: 'mirror-read',
      accounting: 'transport_mirror',
      effect: 'read',
    }),
    event(10, 'tool_returned', {
      tool: 'composio_execute_tool',
      toolSlug: 'GOOGLESHEETS_BATCH_GET',
      callId: 'mirror-read',
      accounting: 'transport_mirror',
      ok: true,
      effect: 'read',
    }),
  ];
  const outputs = new Map([
    ['control-1', 'Execution advanced.'],
    ['discovery-1', 'A very large tool catalog that should not enter completion evidence.'],
    ['write-1', JSON.stringify({
      successful: true,
      data: { updatedRange: 'Sheet1!A1:B4', updatedCells: 8 },
    })],
    ['read-1', JSON.stringify({
      successful: true,
      data: {
        valueRanges: [{
          range: 'Sheet1!A1:B4',
          values: [
            ['company', 'email'],
            ['Acme', 'acme@example.com'],
            ['Beacon', 'beacon@example.com'],
            ['Cedar', 'cedar@example.com'],
          ],
        }],
      },
    })],
    ['mirror-read', 'duplicate transport output'],
  ]);

  const evidence = recentExecutionToolEvidence({
    sessionId: 'completion-evidence-session',
    createdAt: '2026-07-25T19:00:00.000Z',
  }, {
    listEventsFn: () => events,
    getToolOutputFn: (_sessionId, callId) => {
      const output = outputs.get(callId);
      return output ? { output } : null;
    },
  });

  assert.match(evidence, /GOOGLESHEETS_VALUES_UPDATE \[external_write\]=1/);
  assert.match(evidence, /GOOGLESHEETS_BATCH_GET \[read\]=1/);
  assert.match(evidence, /Sheet1!A1:B4/);
  assert.match(evidence, /Beacon/);
  assert.match(evidence, /beacon@example\.com/);
  assert.doesNotMatch(evidence, /Execution advanced/);
  assert.doesNotMatch(evidence, /very large tool catalog/);
  assert.doesNotMatch(evidence, /duplicate transport output/);
});

test('completion evidence excludes failed receipts and stays globally bounded', () => {
  const events: EventRow[] = [];
  const outputs = new Map<string, string>();
  for (let index = 0; index < 14; index += 1) {
    const callId = `call-${index}`;
    events.push(
      event(index * 2 + 1, 'tool_called', {
        tool: 'write_file',
        callId,
        accounting: 'top_level',
        arguments: JSON.stringify({ path: `/tmp/report-${index}.json` }),
        effect: 'local_write',
      }),
      event(index * 2 + 2, 'tool_returned', {
        tool: 'write_file',
        callId,
        accounting: 'top_level',
        ok: index !== 13,
        effect: 'local_write',
      }),
    );
    outputs.set(
      callId,
      index === 13
        ? 'FAILED: disk full'
        : `Wrote /tmp/report-${index}.json ${'verified-data '.repeat(300)}`,
    );
  }

  const evidence = recentExecutionToolEvidence({
    sessionId: 'completion-evidence-session',
    createdAt: '2026-07-25T19:00:00.000Z',
  }, {
    listEventsFn: () => events,
    getToolOutputFn: (_sessionId, callId) => {
      const output = outputs.get(callId);
      return output ? { output } : null;
    },
  });

  assert.match(evidence, /write_file \[local_write\]=13/);
  assert.match(evidence, /5 additional successful receipt\(s\) omitted/);
  assert.doesNotMatch(evidence, /disk full/);
  assert.ok(evidence.length <= 7_000, `expected bounded evidence, got ${evidence.length} chars`);
});
