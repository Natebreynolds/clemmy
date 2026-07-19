import {
  validateComposioBatchOperation,
  validateComposioArgs,
  validateArgsAgainstSchema,
  normalizeComposioBatchItemArgs,
  formatBatchValidationError,
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
// types are Composio's job)
{
  const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
  const error = validateArgsAgainstSchema('ANY_TOOL', { id: 12345, bonus_key: true }, schema);
  if (error !== null) {
    throw new Error('Presence-only: extra keys and type mismatches must pass');
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
