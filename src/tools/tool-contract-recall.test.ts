/**
 * A1 pins: learned contracts become readable, rankable, and renderable.
 *
 * The flagship fails-on-old-code fact: before this module, `exampleArgs` had
 * ZERO readers repo-wide — the store banked working payload shapes nothing
 * consumed. These tests seed a real on-disk store (isolated CLEMENTINE_HOME)
 * and prove the read side end-to-end: seed → recall by turn text → render
 * containing the schema's required fields AND the worked example.
 *
 * Cache pin lives with the WIRING (render must ride the volatile turn tail),
 * which lands at handoff; here we pin recall behavior, budget, dedupe, and
 * redaction-passthrough.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'contract-recall-test-'));

import test from 'node:test';
import assert from 'node:assert/strict';

const { saveToolContract, saveToolContractExample, _clearToolContractsForTests } = await import('./tool-contract-store.js');
const {
  MAX_RECALLED_CONTRACTS,
  RENDER_BUDGET_CHARS_PER_ENTRY,
  recallLearnedContracts,
  renderLearnedContracts,
} = await import('./tool-contract-recall.js');

function seed(identifier: string, required: string[], example?: Record<string, unknown>): void {
  saveToolContract({
    identifier,
    schema: { type: 'object', required, properties: {} },
    providerObservedAt: '2026-08-10T00:00:00.000Z',
  });
  if (example) {
    saveToolContractExample({ identifier, exampleArgs: example });
  }
}

test.beforeEach(() => {
  _clearToolContractsForTests();
});

test('recall finds the learned contract from natural turn text and renders the worked shape', () => {
  seed('OUTLOOK_CREATE_DRAFT', ['subject', 'body', 'to_recipients'], {
    subject: 'q3 traffic',
    body: 'text',
    to_recipients: ['a@b.co'],
  });
  seed('SLACK_SEND_MESSAGE', ['channel', 'text']);

  const hints = recallLearnedContracts('draft a follow-up email in my scorpion outlook to christian');
  assert.equal(hints.length, 1, `expected exactly the outlook contract, got ${JSON.stringify(hints.map((h) => h.identifier))}`);
  assert.equal(hints[0].identifier, 'OUTLOOK_CREATE_DRAFT');
  assert.deepEqual(hints[0].requiredFields, ['subject', 'body', 'to_recipients']);
  assert.ok(hints[0].exampleArgs, 'the banked example must surface — it had zero readers before this module');

  const rendered = renderLearnedContracts(hints);
  assert.ok(rendered);
  assert.match(rendered, /OUTLOOK_CREATE_DRAFT/);
  assert.match(rendered, /required: subject, body, to_recipients/);
  assert.doesNotMatch(rendered, /worked with:|a@b\.co/, 'instance payloads are not present-task authority');
});

test('redaction passthrough: rendered examples carry shapes, not content', () => {
  seed('OUTLOOK_CREATE_DRAFT', ['subject', 'body'], {
    subject: 'SECRET Q3 numbers for acme',
    body: 'do not leak this content',
  });
  const rendered = renderLearnedContracts(
    recallLearnedContracts('create an outlook draft about the numbers'),
  );
  assert.ok(rendered);
  // redactExample in the store replaces string VALUES with type placeholders.
  assert.doesNotMatch(rendered, /SECRET|acme|do not leak/i);
});

test('one shared word is coincidence: single-token overlap does not recall', () => {
  seed('AIRTABLE_CREATE_BASE', ['name', 'workspaceId', 'tables']);
  const hints = recallLearnedContracts('create a summary of my week');
  assert.deepEqual(hints, [], 'generic create-verb overlap alone must not surface a contract');
});

test('limit and dedupe: top-2 by match strength, case-collision twins render once', () => {
  seed('COMPOSIO_SEARCH_TOOLS', ['queries']);
  seed('composio_search_tools', ['queries']);
  seed('GOOGLESHEETS_CREATE_SPREADSHEET', ['title', 'sheets']);
  seed('GOOGLESHEETS_VALUES_UPDATE', ['spreadsheet_id', 'range', 'values']);

  const hints = recallLearnedContracts('search composio tools for a google sheets values update');
  assert.ok(hints.length <= MAX_RECALLED_CONTRACTS);
  const upper = hints.map((hint) => hint.identifier.toUpperCase());
  assert.equal(new Set(upper).size, upper.length, 'case-collision twins must dedupe');
});

test('render budget: an oversized entry is clipped, a 40-contract store stays bounded', () => {
  const bigExample: Record<string, unknown> = {};
  for (let index = 0; index < 60; index += 1) bigExample[`field_with_a_long_name_${index}`] = 'x'.repeat(20);
  seed('NOTION_UPDATE_DATABASE_ROW_PROPERTIES', ['database_id', 'row_id'], bigExample);

  const rendered = renderLearnedContracts(
    recallLearnedContracts('update the notion database row properties'),
  );
  assert.ok(rendered);
  const entryLines = rendered.split('\n').slice(1);
  for (const line of entryLines) {
    assert.ok(
      line.length <= RENDER_BUDGET_CHARS_PER_ENTRY,
      `entry exceeded budget: ${line.length} chars`,
    );
  }
});

test('empty store and empty text are silent, never a throw', () => {
  assert.deepEqual(recallLearnedContracts('anything at all here'), []);
  assert.deepEqual(recallLearnedContracts(''), []);
  assert.equal(renderLearnedContracts([]), null);
});

test.after(() => {
  rmSync(process.env.CLEMENTINE_HOME!, { recursive: true, force: true });
});
