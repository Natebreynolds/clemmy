import {
  validateComposioBatchOperation,
  validateComposioArgs,
  validateArgsAgainstSchema,
  normalizeComposioBatchItemArgs,
  formatBatchValidationError,
  repairUnambiguousFieldRename,
} from './composio-batch-validator.js';

// Test batch validation detects empty items
{
  const error = validateComposioBatchOperation('OUTLOOK_BATCH_UPDATE_MESSAGES', {
    updates: [
      { id: 'msg1', patch: { subject: 'Test' } },
      {}, // Empty item — should fail
      { id: 'msg3', patch: { subject: 'Test 3' } },
    ],
  });
  if (!error || !error.reason.includes('empty')) {
    throw new Error('Should detect empty item in batch');
  }
}

// Test batch validation detects missing patch field
{
  const error = validateComposioBatchOperation('OUTLOOK_BATCH_UPDATE_MESSAGES', {
    updates: [
      { id: 'msg1' }, // Missing patch — should fail
      { id: 'msg2', patch: { subject: 'Test' } },
    ],
  });
  if (!error || !error.reason.includes('patch')) {
    throw new Error('Should detect missing patch field');
  }
}

// Test batch validation passes on valid batch
{
  const error = validateComposioBatchOperation('OUTLOOK_BATCH_UPDATE_MESSAGES', {
    updates: [
      { id: 'msg1', patch: { subject: 'Test 1' } },
      { id: 'msg2', patch: { subject: 'Test 2' } },
    ],
  });
  if (error !== null) {
    throw new Error('Should accept valid batch');
  }
}

// Test Airtable-style batch update ({ id, fields }) is NOT falsely blocked
{
  const error = validateComposioBatchOperation('AIRTABLE_BATCH_UPDATE_RECORDS', {
    records: [
      { id: 'rec1', fields: { Name: 'ok' } },
      { id: 'rec2', fields: { Name: 'also ok' } },
    ],
  });
  if (error !== null) {
    throw new Error('Should accept Airtable-style { id, fields } batch items');
  }
}

// Test Airtable-style item missing update content is still blocked
{
  const error = validateComposioBatchOperation('AIRTABLE_BATCH_UPDATE_RECORDS', {
    records: [{ id: 'rec1', fields: { Name: 'ok' } }, { id: 'rec2' }],
  });
  if (!error || !error.reason.includes('update content')) {
    throw new Error('Should block Airtable batch item with no update content');
  }
}

// Test Google Sheets-style batch update ({ range, values }) is NOT falsely blocked
// (exact live arg shape from harness.db: GOOGLESHEETS_BATCH_UPDATE_VALUES)
{
  const error = validateComposioBatchOperation('GOOGLESHEETS_BATCH_UPDATE_VALUES', {
    spreadsheet_id: 'sheet1',
    value_input_option: 'RAW',
    data: [{ range: 'Sheet1!A1:B2', values: [['a', 'b']] }],
  });
  if (error !== null) {
    throw new Error('Should accept Sheets-style { range, values } batch items');
  }
}

// Test Sheets-style item with a range but no values is still blocked
{
  const error = validateComposioBatchOperation('GOOGLESHEETS_BATCH_UPDATE_VALUES', {
    data: [{ range: 'Sheet1!A1:B2' }],
  });
  if (!error || !error.reason.includes('update content')) {
    throw new Error('Should block Sheets batch item with no update content');
  }
}

// Test Sheets-style item with values but no write target is still blocked
{
  const error = validateComposioBatchOperation('GOOGLESHEETS_BATCH_UPDATE_VALUES', {
    data: [{ values: [['a', 'b']] }],
  });
  if (!error || !error.reason.includes('missing ID')) {
    throw new Error('Should block Sheets batch item with no range/id target');
  }
}

// Test batch validation ignores non-batch operations
{
  const error = validateComposioBatchOperation('OUTLOOK_OUTLOOK_SEND_EMAIL', {
    to: 'test@example.com',
    subject: 'Test',
  });
  if (error !== null) {
    throw new Error('Should ignore non-batch operations');
  }
}

// Test error formatting
{
  const error = validateComposioBatchOperation('AIRTABLE_BULK_CREATE_RECORDS', {
    items: [{}],
  });
  if (error) {
    const formatted = formatBatchValidationError(error, 'AIRTABLE_BULK_CREATE_RECORDS');
    if (!formatted.includes('⚠️')) {
      throw new Error('Should include warning symbol');
    }
    if (!formatted.includes('AIRTABLE_BULK_CREATE_RECORDS')) {
      throw new Error('Should include tool slug');
    }
  }
}

// ─── Schema-grounded validation ──────────────────────────────────────

// Batch item repair: unwrap an accidental composio_execute_tool wrapper and
// normalize Outlook's human-friendly "to" alias to the provider field.
{
  const normalized = normalizeComposioBatchItemArgs('OUTLOOK_OUTLOOK_SEND_EMAIL', {
    tool_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    arguments: JSON.stringify({ to: 'alex@example.com', subject: 'Hi', body: 'Body' }),
    connected_account_id: 'ca_123',
  });
  if (normalized.errors.length > 0) throw new Error(`Should not reject same-slug wrapper: ${normalized.errors.join(', ')}`);
  if (normalized.args.to_email !== 'alex@example.com' || 'to' in normalized.args) {
    throw new Error('Should map Outlook "to" alias to "to_email" and remove the alias');
  }
  if (normalized.connectedAccountId !== 'ca_123') {
    throw new Error('Should preserve wrapper connected_account_id for batch dispatch');
  }
}

// Account routing is part of the certified payload, not disposable wrapper
// decoration. Preserve one agreed alias across unwrap; refuse dual carriers.
{
  const preserved = normalizeComposioBatchItemArgs('OUTLOOK_LIST_MESSAGES', {
    tool_slug: 'OUTLOOK_LIST_MESSAGES',
    account_alias: 'Scorpion',
    arguments: JSON.stringify({ folder: 'Inbox' }),
  });
  if (preserved.errors.length > 0 || preserved.args.account_alias !== 'Scorpion') {
    throw new Error(`Wrapper normalization must preserve account_alias: ${preserved.errors.join(', ')}`);
  }

  const aliasConflict = normalizeComposioBatchItemArgs('OUTLOOK_LIST_MESSAGES', {
    tool_slug: 'OUTLOOK_LIST_MESSAGES',
    account_alias: 'Scorpion',
    arguments: JSON.stringify({ folder: 'Inbox', account_alias: 'Personal' }),
  });
  if (!aliasConflict.errors.some((error) => /account_alias conflicts/i.test(error))) {
    throw new Error('Wrapper and inner account_alias carriers must not disagree');
  }

  const dualAuthority = normalizeComposioBatchItemArgs('OUTLOOK_LIST_MESSAGES', {
    tool_slug: 'OUTLOOK_LIST_MESSAGES',
    account_alias: 'Scorpion',
    arguments: JSON.stringify({ folder: 'Inbox' }),
    connected_account_id: 'ca_scorpion',
  });
  if (!dualAuthority.errors.some((error) => /account_alias conflicts with connected_account_id/i.test(error))) {
    throw new Error('Alias and raw connected-account selectors must not coexist');
  }

  const staleProviderArg = normalizeComposioBatchItemArgs('OUTLOOK_LIST_MESSAGES', {
    folder: 'Inbox',
    connected_account_id: 'ca_stale_provider_arg',
  });
  if (!staleProviderArg.errors.some((error) => /inside provider args is not account authority/i.test(error))) {
    throw new Error('A bare provider-args connected_account_id must be refused with account_alias guidance');
  }
  if (staleProviderArg.connectedAccountId !== undefined
    || 'connected_account_id' in staleProviderArg.args
    || 'connectedAccountId' in staleProviderArg.args) {
    throw new Error('A bare provider-args connected account id must be stripped, never promoted to batch authority');
  }
}

// Only the OUTER field of a positively identified full broker wrapper can mint
// BatchPlanItem account authority. A stale ca_* buried in provider args is
// stripped and rejected even when valid outer authority is also present.
{
  const innerOnly = normalizeComposioBatchItemArgs('OUTLOOK_LIST_MESSAGES', {
    tool_slug: 'OUTLOOK_LIST_MESSAGES',
    arguments: JSON.stringify({ folder: 'Inbox', connected_account_id: 'ca_stale_inner' }),
  });
  if (innerOnly.connectedAccountId !== undefined) {
    throw new Error('Inner provider args must never become BatchPlanItem connected-account authority');
  }
  if ('connected_account_id' in innerOnly.args || !innerOnly.errors.some((error) => /not account authority/i.test(error))) {
    throw new Error('Inner connected_account_id must be stripped and rejected');
  }

  const outerWithInner = normalizeComposioBatchItemArgs('OUTLOOK_LIST_MESSAGES', {
    tool_slug: 'OUTLOOK_LIST_MESSAGES',
    arguments: JSON.stringify({ folder: 'Inbox', connected_account_id: 'ca_stale_inner' }),
    connected_account_id: 'ca_outer_reviewed',
  });
  if (outerWithInner.connectedAccountId !== 'ca_outer_reviewed') {
    throw new Error('A supported wrapper must preserve its outer connected_account_id');
  }
  if (!outerWithInner.errors.some((error) => /not account authority/i.test(error))) {
    throw new Error('An inner selector remains a rejection beside valid outer authority');
  }
}

// Positive wrapper recognition: `arguments` can be a legitimate provider field.
// Without tool_slug it stays untouched; tool_slug without arguments is a broken
// wrapper and must not leak into provider args.
{
  const providerArguments = { mode: 'literal-provider-field', values: ['a', 'b'] };
  const direct = normalizeComposioBatchItemArgs('ACME_RUN_SCRIPT', {
    arguments: providerArguments,
    script_id: 'script-1',
  });
  if (direct.errors.length > 0 || direct.args.arguments !== providerArguments) {
    throw new Error('A provider arguments field without tool_slug must not be unwrapped');
  }
  if (direct.repairs.some((repair) => /unwrapped/i.test(repair))) {
    throw new Error('Direct provider args must not claim wrapper repair');
  }

  const incomplete = normalizeComposioBatchItemArgs('ACME_RUN_SCRIPT', {
    tool_slug: 'ACME_RUN_SCRIPT',
    script_id: 'script-1',
  });
  if ('tool_slug' in incomplete.args || !incomplete.errors.some((error) => /without arguments/i.test(error))) {
    throw new Error('tool_slug without arguments must be stripped and rejected as an incomplete wrapper');
  }
}

// Schema-grounded recipient alias: any provider whose real schema requires
// to_email can be repaired without slug-specific code.
{
  const normalized = normalizeComposioBatchItemArgs('ACME_SEND', {
    to: 'alex@example.com',
    subject: 'Hi',
    body: 'Body',
  }, {
    type: 'object',
    required: ['to_email', 'subject', 'body'],
    properties: { to_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
  });
  if (normalized.args.to_email !== 'alex@example.com' || 'to' in normalized.args) {
    throw new Error('Schema-required to_email should be repaired from to');
  }
}

// No over-normalization: Gmail-style tools commonly accept "to"; leave them
// alone unless a schema explicitly asks for to_email.
{
  const normalized = normalizeComposioBatchItemArgs('GMAIL_SEND_EMAIL', {
    to: 'alex@example.com',
    subject: 'Hi',
    body: 'Body',
  });
  if (normalized.args.to !== 'alex@example.com' || 'to_email' in normalized.args || normalized.repairs.length > 0) {
    throw new Error('Should not rewrite Gmail-style to into to_email without schema evidence');
  }
}

// Mismatched wrappers are provably unsafe: the model put one slug in the batch
// plan and a different slug in the item wrapper.
{
  const normalized = normalizeComposioBatchItemArgs('OUTLOOK_OUTLOOK_SEND_EMAIL', {
    tool_slug: 'GMAIL_SEND_EMAIL',
    arguments: JSON.stringify({ to: 'alex@example.com', subject: 'Hi', body: 'Body' }),
  });
  if (!normalized.errors.some((err) => err.includes('does not match'))) {
    throw new Error('Should reject a mismatched nested wrapper slug');
  }
}

// THE FUTURE-PROOF PROOF: a brand-new toolkit whose items are keyed by a
// non-`*id` identity ('sku') — the one shape class the structural
// heuristic still cannot recognize. The heuristic blocks it; the real
// schema passes it. No code change needed for new toolkits.
{
  const args = { items: [{ sku: 'ABC-123', qty: 5 }] };
  const heuristic = validateComposioArgs('INVENTORY_BATCH_UPDATE_STOCK', args, null);
  if (heuristic.mode !== 'heuristic' || heuristic.error === null) {
    throw new Error('Heuristic should block the sku-keyed shape (proves the schema is what saves it)');
  }
  const schema = {
    type: 'object',
    required: ['items'],
    properties: { items: { type: 'array', items: { type: 'object', required: ['sku', 'qty'] } } },
  };
  const grounded = validateComposioArgs('INVENTORY_BATCH_UPDATE_STOCK', args, schema);
  if (grounded.mode !== 'schema' || grounded.error !== null) {
    throw new Error('Real schema must override the heuristic and pass the valid shape');
  }
}

// Structural heuristic accepts ANY identity+content pairing without
// vocabulary: message_id+patch, message_id+is_read, row_ids+cells —
// shapes never enumerated anywhere in this file.
{
  for (const item of [
    { message_id: 'm1', patch: { isRead: true } },
    { message_id: 'm1', is_read: true },
    { row_ids: ['r1', 'r2'], cells: { A: 1 } },
  ]) {
    const error = validateComposioBatchOperation('ANYTOOL_BATCH_UPDATE_THINGS', { updates: [item] });
    if (error !== null) {
      throw new Error(`Structural heuristic should accept identity+content item: ${JSON.stringify(item)}`);
    }
  }
}

// Schema catches a missing required top-level field, naming the real fields
{
  const schema = { type: 'object', required: ['spreadsheet_id', 'data'], properties: {} };
  const error = validateArgsAgainstSchema('GOOGLESHEETS_BATCH_UPDATE_VALUES', { data: [] }, schema);
  if (!error || !error.reason.includes('spreadsheet_id')) {
    throw new Error('Schema validation should name the real missing required field');
  }
}

// Schema catches a batch item missing a required item field
{
  const schema = {
    type: 'object',
    required: ['data'],
    properties: { data: { type: 'array', items: { type: 'object', required: ['range', 'values'] } } },
  };
  const error = validateArgsAgainstSchema('GOOGLESHEETS_BATCH_UPDATE_VALUES', { data: [{ range: 'A1' }] }, schema);
  if (!error || !error.reason.includes('values')) {
    throw new Error('Schema validation should catch missing required item field');
  }
}

// Extra keys and type mismatches are NOT blocked (presence-only contract;
// types are Composio's job) unless the provider explicitly closes the object.
{
  const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
  const error = validateArgsAgainstSchema('ANY_TOOL', { id: 12345, bonus_key: true }, schema);
  if (error !== null) {
    throw new Error('Presence-only: extra keys and type mismatches must pass');
  }
}

// An explicit closed-object provider contract rejects invented keys locally.
// This is the retained Codex correction shape: "fresh" must not become an
// unsupported force_refresh argument when the learned action accepts exactly {}.
{
  const schema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  const error = validateArgsAgainstSchema('PROOF_LIST_TASKS', { force_refresh: true }, schema);
  if (error?.kind !== 'unsupported-fields'
    || error.field !== 'force_refresh'
    || !error.reason.includes('use {}')) {
    throw new Error(`Closed schema must reject force_refresh before dispatch: ${JSON.stringify(error)}`);
  }
  if (validateArgsAgainstSchema('PROOF_LIST_TASKS', {}, schema) !== null) {
    throw new Error('The exact empty payload must remain valid for a no-argument action');
  }
  const message = formatBatchValidationError(error, 'PROOF_LIST_TASKS', 'schema');
  if (!message.includes('remove the unsupported field')
    || !message.includes('do not rediscover')
    || message.includes('add them and retry')) {
    throw new Error(`Closed-schema recovery must tell the model to remove, not add: ${message}`);
  }
}

// Explicitly closed schemas still admit declared keys, while open schemas keep
// the prior fail-open behavior for extras.
{
  const closed = {
    type: 'object',
    properties: { status: { type: 'string' } },
    additionalProperties: false,
  };
  if (validateArgsAgainstSchema('PROOF_FILTER_TASKS', { status: 'open' }, closed) !== null) {
    throw new Error('A declared key must pass an explicitly closed schema');
  }
  const open = {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
  if (validateArgsAgainstSchema('EXTENSIBLE_TOOL', { provider_extension: true }, open) !== null) {
    throw new Error('additionalProperties:true must preserve fail-open extra-key behavior');
  }
  const patterned = {
    type: 'object',
    properties: {},
    patternProperties: { '^x_': { type: 'string' } },
    additionalProperties: false,
  };
  if (validateArgsAgainstSchema('PATTERNED_TOOL', { x_provider: 'ok' }, patterned) !== null) {
    throw new Error('A patterned closed schema must fail open rather than reject a possibly allowed key');
  }
}

// Fail-open on malformed schemas — junk must never block a dispatch
{
  for (const junk of [
    { required: 'not-an-array' },
    { required: [42, null] },
    { properties: 'nope', required: [] },
    {},
  ]) {
    const error = validateArgsAgainstSchema('ANY_TOOL', { whatever: 1 }, junk as Record<string, unknown>);
    if (error !== null) {
      throw new Error(`Malformed schema must fail open, got block for: ${JSON.stringify(junk)}`);
    }
  }
}

// Mode selection: schema present → 'schema', absent → 'heuristic'
{
  if (validateComposioArgs('X', {}, { type: 'object' }).mode !== 'schema') {
    throw new Error('Should select schema mode when a schema is supplied');
  }
  if (validateComposioArgs('X', {}, null).mode !== 'heuristic') {
    throw new Error('Should select heuristic mode when no schema is supplied');
  }
}

// Heuristic-mode block message teaches the self-fix path
{
  const error = validateComposioBatchOperation('OUTLOOK_BATCH_UPDATE_MESSAGES', { updates: [{ id: 'm1' }] });
  if (!error) throw new Error('precondition: should block');
  const msg = formatBatchValidationError(error, 'OUTLOOK_BATCH_UPDATE_MESSAGES', 'heuristic');
  if (!msg.includes('composio_search_tools') || !msg.includes('do NOT guess or rename keys')) {
    throw new Error('Heuristic block must teach the schema-fetch recovery path');
  }
}

console.log('composio-batch-validator tests passed');

// A missing-required-field refusal hands back the REPAIRED CALL, not just the
// complaint. Live 2026-08-12: the refusal named `actorId` exactly, six times
// across three lanes, and the model switched tools instead of filling it in.
// The fix has to be the cheapest next move, not a fact to act on.
{
  const schema = {
    type: 'object',
    required: ['actorId', 'runInput'],
    properties: {
      actorId: { type: 'string', description: 'The Apify actor to run, e.g. compass~google-maps-scraper' },
      runInput: { type: 'object', description: 'Actor input payload' },
      timeout: { type: 'number' },
    },
  };
  const error = validateArgsAgainstSchema(
    'APIFY_RUN_ACTOR',
    { runInput: { searchStrings: ['restaurants'] }, timeout: 60 },
    schema,
  );
  if (!error) throw new Error('a missing required field must still be refused');
  if (!/actorId/.test(error.reason)) throw new Error('the refusal must name the missing field');

  const template = error.examples.find((line) => /Repair this exact call/.test(line));
  if (!template) throw new Error('the refusal must carry a ready-to-send repaired call');
  const payload = JSON.parse(template.slice(template.indexOf('{'))) as {
    tool_slug: string;
    arguments: Record<string, unknown>;
  };
  if (payload.tool_slug !== 'APIFY_RUN_ACTOR') throw new Error('the repair targets the same action');
  // The caller's own values survive untouched; only the gap is marked.
  if (JSON.stringify(payload.arguments.runInput) !== JSON.stringify({ searchStrings: ['restaurants'] })) {
    throw new Error('supplied arguments must be preserved verbatim');
  }
  if (payload.arguments.timeout !== 60) throw new Error('unrelated arguments must be preserved');
  if (!/^<FILL: /.test(String(payload.arguments.actorId))) {
    throw new Error('the missing field must be marked as a fillable gap');
  }
  if (!/google-maps-scraper/.test(String(payload.arguments.actorId))) {
    throw new Error('the field description must travel with the gap');
  }
}

// An unambiguous wrong field name repairs in place instead of refusing.
// Live 2026-08-18 session-fixture-unprovisioned-catalog: FIRECRAWL_SEARCH called with
// arguments.query while the schema requires `q` — one pre-dispatch refusal
// and a paid tuition round-trip. One missing required + one unknown provided
// = deterministic rename, value untouched, surfaced as a note.
{
  const schema = { required: ['q'], properties: { q: { type: 'string' }, limit: { type: 'number' } } };
  const repaired = repairUnambiguousFieldRename('FIRECRAWL_SEARCH', { query: 'fort worth firms', limit: 10 }, schema);
  if (!repaired) throw new Error('unambiguous rename must repair');
  if (repaired.args.q !== 'fort worth firms') throw new Error('value must move to the required key');
  if ('query' in repaired.args) throw new Error('the wrong key must be removed');
  if (repaired.args.limit !== 10) throw new Error('other args untouched');
  if (repairUnambiguousFieldRename('FIRECRAWL_SEARCH', { query: 'x', qq: 'y' }, schema) !== null) {
    throw new Error('two unknown fields is ambiguous — no repair');
  }
  if (repairUnambiguousFieldRename('FIRECRAWL_SEARCH', { q: 'x', extra: 'y' }, schema) !== null) {
    throw new Error('nothing missing — no repair');
  }
  console.log('✓ unambiguous field rename repairs query→q (session-fixture-unprovisioned-catalog)');
}
