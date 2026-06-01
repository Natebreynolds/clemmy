/**
 * Run: npx tsx --test src/runtime/harness/tool-output-digest.test.ts
 *
 * The structure-aware digest must never sever a JSON array mid-record,
 * must report the true total + fields, and must point at the recovery
 * path (tool_output_query / recall_tool_result).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestToolOutput } from './tool-output-digest.js';

const accounts = Array.from({ length: 47 }, (_, i) => ({
  Id: `001${i}`,
  Name: `Account ${i} with a reasonably long name to take up bytes`,
  Website: `https://example${i}.com`,
  LastActivityDate: i % 3 === 0 ? null : `2026-0${(i % 9) + 1}-10`,
}));

test('JSON array: shows COMPLETE records (valid JSON), never mid-record', () => {
  const text = JSON.stringify(accounts);
  const digest = digestToolOutput(text, { maxChars: 2000, toolName: 'run_shell_command', callId: 'call_x1' });
  // The body up to the footer must parse as a JSON array (complete records).
  const body = digest.slice(0, digest.indexOf('\n[digest:'));
  const parsed = JSON.parse(body);
  assert.ok(Array.isArray(parsed));
  assert.ok(parsed.length >= 1 && parsed.length < accounts.length, `showed ${parsed.length}`);
  // Each shown record is whole (has all the keys).
  assert.deepEqual(Object.keys(parsed[0]).sort(), ['Id', 'LastActivityDate', 'Name', 'Website']);
});

test('JSON array digest reports the true total, field list, and recovery path', () => {
  const digest = digestToolOutput(JSON.stringify(accounts), { maxChars: 2000, toolName: 'sf', callId: 'call_x1' });
  assert.match(digest, /array of 47 records/);
  assert.match(digest, /Fields: .*Website/);
  assert.match(digest, /tool_output_query\("call_x1"/);
  assert.match(digest, /recall_tool_result\("call_x1"/);
});

test('JSON object: shows real CONTENT of nested arrays, not just array(N) shape', () => {
  const obj = { status: 'ok', count: 100, rows: accounts, nested: { a: 1, b: 2 } };
  const digest = digestToolOutput(JSON.stringify(obj), { maxChars: 1500, toolName: 't', callId: 'call_o1' });
  assert.match(digest, /top-level key/);
  // rows is now EXPANDED to real elements + an accurate "+N more of 47", not collapsed to array(47).
  assert.match(digest, /rows: \[/);
  assert.match(digest, /"Website":"http/); // actual record content is visible
  assert.match(digest, /more of 47/);
  assert.doesNotMatch(digest, /rows: array\(47\)/);
  assert.match(digest, /tool_output_query\("call_o1"/);
});

test('Composio envelope: digest surfaces the data payload (tables/ids), not data: object(1 keys)', () => {
  // The exact shape that broke Airtable: a wrapped result whose payload is the
  // thing the model needs. The old shape-only digest hid it entirely.
  const tables = Array.from({ length: 8 }, (_, i) => ({
    id: `tbl${i}AAAAAAAAAAA`, name: `Prospecting ${i}`,
    fields: Array.from({ length: 12 }, (_, f) => ({ id: `fld${i}_${f}`, name: 'col' + f, type: 'singleLineText' })),
  }));
  const envelope = { data: { tables }, successful: true, error: null, logId: 'log_abc' };
  const digest = digestToolOutput(JSON.stringify(envelope), { maxChars: 2500, toolName: 'composio_execute_tool', callId: 'call_env' });
  assert.doesNotMatch(digest, /data: object\(1 keys\)/); // the old useless output
  assert.match(digest, /tbl0AAAAAAAAAAA/);               // a real table id is now visible
  assert.match(digest, /Prospecting 0/);                 // and its name
});

test('plain text: head+tail + line/char count, points to recall', () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const digest = digestToolOutput(text, { maxChars: 1200, toolName: 'run_shell_command', callId: 'call_t1' });
  assert.match(digest, /chars \/ 500 lines/);
  assert.match(digest, /middle omitted/);
  assert.match(digest, /recall_tool_result\("call_t1"/);
});

test('no callId: still a digest, but recovery hint is the re-run advice', () => {
  const digest = digestToolOutput(JSON.stringify(accounts), { maxChars: 1500, toolName: 'sf' });
  assert.match(digest, /array of 47 records/);
  assert.match(digest, /narrower scope/);
  assert.doesNotMatch(digest, /tool_output_query/);
});

test('Composio search catalog digest preserves exact slugs and compact input fields', () => {
  const catalog = {
    configured: true,
    connectedToolkits: Array.from({ length: 50 }, (_, i) => ({
      toolkit: `toolkit_${i}`,
      connectionId: `ca_${i}`,
      status: 'ACTIVE',
    })),
    searchedToolkits: ['dataforseo'],
    query: 'dataforseo keyword research',
    count: 2,
    matches: [
      {
        toolkit: 'dataforseo',
        slug: 'DATAFORSEO_LABS_GOOGLE_KEYWORDS_FOR_SITE',
        name: 'Keywords for site',
        description: 'Returns Google keywords for a target website with volume and cost data.',
        score: 27,
        inputParameters: {
          type: 'object',
          required: ['target', 'location_name'],
          properties: {
            target: { type: 'string', description: 'Domain or URL to research' },
            location_name: { type: 'string' },
            language_name: { type: 'string' },
          },
        },
      },
      {
        toolkit: 'dataforseo',
        slug: 'DATAFORSEO_SERP_GOOGLE_ORGANIC_LIVE_ADVANCED',
        name: 'Organic SERP live advanced',
        description: 'Returns live organic SERP results.',
        score: 18,
      },
    ],
    nextStep: 'Pick the best match, then call composio_execute_tool.',
  };

  const digest = digestToolOutput(JSON.stringify(catalog), {
    maxChars: 1800,
    toolName: 'composio_search_tools',
    callId: 'call_catalog',
  });

  assert.match(digest, /composio_catalog/);
  assert.match(digest, /DATAFORSEO_LABS_GOOGLE_KEYWORDS_FOR_SITE/);
  assert.match(digest, /DATAFORSEO_SERP_GOOGLE_ORGANIC_LIVE_ADVANCED/);
  assert.match(digest, /target:string/);
  assert.match(digest, /location_name/);
  assert.match(digest, /tool_output_query\("call_catalog"/);
});

test('Composio list catalog digest keeps slug index instead of only top-level shape', () => {
  const tools = Array.from({ length: 60 }, (_, i) => ({
    slug: `DATAFORSEO_TOOL_${String(i).padStart(2, '0')}`,
    name: `DataForSEO tool ${i}`,
    description: `Detailed schema-heavy action ${i}`,
    inputParameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        location_name: { type: 'string' },
      },
    },
  }));

  const digest = digestToolOutput(JSON.stringify({ toolkit: 'dataforseo', count: tools.length, tools }), {
    maxChars: 2400,
    toolName: 'composio_list_tools',
    callId: 'call_list',
  });

  assert.match(digest, /availableSlugs/);
  assert.match(digest, /DATAFORSEO_TOOL_00/);
  assert.match(digest, /DATAFORSEO_TOOL_10/);
  assert.doesNotMatch(digest, /top-level key/);
});
