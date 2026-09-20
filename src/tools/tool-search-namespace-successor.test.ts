import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerToolSearchTool } from './tool-search-tool.js';

test('unrelated lifecycle replacements do not precede a plain-language local operation', async () => {
  let handler!: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) {
    handler = callback;
  } } as never, {
    allowedNames: new Set(['write_file']),
    candidateSources: [{ kind: 'authorized_composio', search: async () => [
      { name: 'GOOGLEDRIVE_DELETE_REPLY', summary: 'Delete a reply to a comment in Drive.', carrier: 'work_call', lifecycleSuccessor: true, score: 1 },
      { name: 'GOOGLESHEETS_VALUES_UPDATE', summary: 'Set values in a spreadsheet range.', carrier: 'work_call', lifecycleSuccessor: true, score: 1 },
      { name: 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND', summary: 'Append values to a spreadsheet.', carrier: 'work_call', score: 0.9 },
    ] }],
  });
  const result = JSON.parse((await handler({
    query: 'append exactly one line to a local file and verify resulting file contents',
    limit: 8, cursor: null, role_key: null, account_selection: null,
  })).content[0]!.text);
  const names = result.results.map((row: { name: string }) => row.name);
  assert.equal(names[0], 'write_file');
  assert.ok(names.includes('GOOGLEDRIVE_DELETE_REPLY'), 'ranking must not remove live replacements');
});

test('a named provider precedes unrelated lifecycle replacements without hiding them', async () => {
  let handler!: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) {
    handler = callback;
  } } as never, {
    allowedNames: new Set(),
    candidateSources: [{ kind: 'authorized_composio', search: async () => [
      { name: 'AIRTABLE_CREATE_RECORDS', summary: 'Create records.', carrier: 'work_call', lifecycleSuccessor: true, score: 1 },
      { name: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW', summary: 'Read Outlook calendar events for a specified date range.', carrier: 'work_call', score: 0.9 },
      { name: 'OUTLOOK_GET_CALENDAR_VIEW', summary: 'Get active events.', carrier: 'work_call', lifecycleSuccessor: true, score: 0.1 },
    ] }],
  });
  const result = JSON.parse((await handler({
    query: 'Read Outlook calendar events for a specified date range', limit: 8,
    cursor: null, role_key: null, account_selection: null,
  })).content[0]!.text);
  const names = result.results.map((row: { name: string }) => row.name);
  assert.equal(names[0], 'OUTLOOK_GET_CALENDAR_VIEW', 'same-provider replacement retains priority');
  assert.ok(names.indexOf('OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW') < names.indexOf('AIRTABLE_CREATE_RECORDS'));
  assert.ok(names.includes('AIRTABLE_CREATE_RECORDS'), 'ranking does not remove capabilities');
});
