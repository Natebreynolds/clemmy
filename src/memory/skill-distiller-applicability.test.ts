/**
 * Run: npx tsx --test src/memory/skill-distiller-applicability.test.ts
 *
 * Lane D Phase 2 — slot parameterization + applicability. A distilled procedure
 * must be reusable across clients (concrete ids → {{slots}}) AND global, never
 * user-specific: the GLOBAL entity classes (table/app ids, emails, domains) are
 * slotted; a client NAME is left untouched (it must not be baked into the global
 * distiller).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotParameterize, deriveApplicability } from './skill-distiller.js';

test('global entity ids → {{slots}} (table/app/email/domain)', () => {
  const r = slotParameterize('update tblAbc123def456 in appXyz789ghi012 for casey@example-legal.example on example-legal.example');
  assert.match(r.text, /\{\{table_id\}\}/);
  assert.match(r.text, /\{\{app_id\}\}/);
  assert.match(r.text, /\{\{email\}\}/);
  assert.match(r.text, /\{\{domain\}\}/);
  assert.ok(!/tblAbc123def456|appXyz789ghi012|casey@example-legal\.example/.test(r.text), 'no concrete id survives');
  assert.deepEqual(new Set(r.slots), new Set(['table_id', 'app_id', 'email', 'domain']));
});

test('GLOBAL-ONLY: a user-specific client name is NOT slotted (no user data in the global distiller)', () => {
  const r = slotParameterize('Build the Example Legal Group outreach and the Acme brief');
  assert.equal(r.text, 'Build the Example Legal Group outreach and the Acme brief');
  assert.deepEqual(r.slots, []);
});

test('email is slotted as one unit (its domain is not double-replaced)', () => {
  const r = slotParameterize('to a@beta.example');
  assert.equal(r.text, 'to {{email}}');
  assert.deepEqual(r.slots, ['email']);
});

test('text with no entities is returned unchanged', () => {
  const r = slotParameterize('list the unread messages and summarize them');
  assert.equal(r.text, 'list the unread messages and summarize them');
  assert.deepEqual(r.slots, []);
});

test('deriveApplicability: composio slugs → toolkit families; slots passed through deduped', () => {
  const a = deriveApplicability(
    [{ tool: 'GMAIL_SEND_EMAIL' }, { tool: 'GMAIL_FETCH_EMAILS' }, { tool: 'AIRTABLE_UPDATE_RECORD' }],
    ['email', 'email', 'table_id'],
  );
  assert.deepEqual(new Set(a.toolFamilies), new Set(['gmail', 'airtable']));
  assert.deepEqual(new Set(a.entitySlots), new Set(['email', 'table_id']));
});

test('deriveApplicability: non-composio tool → its lowercased name as the family', () => {
  const a = deriveApplicability([{ tool: 'run_shell_command' }], []);
  assert.deepEqual(a.toolFamilies, ['run_shell_command']);
  assert.deepEqual(a.entitySlots, []);
});
