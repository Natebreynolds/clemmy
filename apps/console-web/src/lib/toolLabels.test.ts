import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanToolLabel, salientArgDetail, isHousekeepingTool } from './toolLabels';

test('isHousekeepingTool matches the brain bookkeeping set, case-insensitively', () => {
  for (const name of ['reflection', 'Recursive_Reflection', 'TOOL_CHOICE', 'workflow_pattern']) {
    assert.equal(isHousekeepingTool(name), true, `${name} should be housekeeping`);
  }
  for (const name of ['send_email', 'outlook_send_email', 'composio_execute_tool', '', undefined, null]) {
    assert.equal(isHousekeepingTool(name), false, `${String(name)} should not be housekeeping`);
  }
});

test('humanToolLabel unwraps a composio slug and strips mcp prefixes', () => {
  assert.equal(
    humanToolLabel('composio_execute_tool', JSON.stringify({ tool_slug: 'OUTLOOK_SEND_EMAIL' })),
    'outlook send email',
  );
  assert.equal(humanToolLabel('mcp__some_server__list_items'), 'some server · list items');
  assert.equal(humanToolLabel('read_file'), 'read file');
  // No args is fine — the composio branch just doesn't fire.
  assert.equal(humanToolLabel('composio_execute_tool'), 'composio execute tool');
});

test('salientArgDetail pulls the one thing a call is about, incl. nested composio args', () => {
  assert.equal(salientArgDetail(JSON.stringify({ to: 'paul@example.com' })), 'paul@example.com');
  assert.equal(
    salientArgDetail(JSON.stringify({ arguments: JSON.stringify({ query: 'q3 pipeline' }) })),
    'q3 pipeline',
  );
  // Plain (non-JSON) summaries and empty payloads yield nothing salient.
  assert.equal(salientArgDetail('sent to Slack'), '');
  assert.equal(salientArgDetail(undefined), '');
});
