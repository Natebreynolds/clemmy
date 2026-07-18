/**
 * CALL-1 — structured tool-call node: arg rendering, side-effect classification,
 * validation, and serialization round-trip. Per-test temp home via
 * CLEMENTINE_HOME (BINDING) — set BEFORE any src import.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-call-node-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const {
  renderCallArgs,
  renderCallArgValue,
  callToolSideEffectClass,
  stepSideEffectClass,
  structuredCallNeedsMutationReceipt,
} = await import('./workflow-runner.js');
const { validateWorkflowDefinition } = await import('./workflow-validator.js');
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');

const INPUTS = { url: 'https://acme.co', region: 'east' };
const OUTPUTS = { gather: { rows: [{ id: 1 }, { id: 2 }], region: 'west' }, count: 42 };

test('renderCallArgValue: a full-token value resolves to the RAW upstream value (object/array preserved)', () => {
  // exactly one token → raw value kept (not stringified)
  assert.deepEqual(renderCallArgValue('{{steps.gather.output}}', INPUTS, OUTPUTS), { rows: [{ id: 1 }, { id: 2 }], region: 'west' });
  assert.deepEqual(renderCallArgValue('{{steps.gather.output.rows}}', INPUTS, OUTPUTS), [{ id: 1 }, { id: 2 }]);
  assert.equal(renderCallArgValue('{{input.url}}', INPUTS, OUTPUTS), 'https://acme.co');
  assert.equal(renderCallArgValue('{{project.path}}', INPUTS, OUTPUTS, undefined, {
    requested: 'clementine-next',
    source: 'workflow',
    name: 'clementine-next',
    path: '/Users/tester/Developer/clementine-next',
    type: 'node',
  }), '/Users/tester/Developer/clementine-next');
  // item token
  assert.equal(renderCallArgValue('{{item.email}}', INPUTS, OUTPUTS, { email: 'a@b.co' }), 'a@b.co');
  assert.deepEqual(renderCallArgValue('{{item}}', INPUTS, OUTPUTS, { x: 1 }), { x: 1 });
  // unresolved full token → '' (not the literal token)
  assert.equal(renderCallArgValue('{{input.missing}}', INPUTS, OUTPUTS), '');
});

test('renderCallArgValue: an EMBEDDED token string-renders; non-strings pass through', () => {
  assert.equal(renderCallArgValue('to: {{input.url}} now', INPUTS, OUTPUTS), 'to: https://acme.co now');
  assert.equal(renderCallArgValue(50, INPUTS, OUTPUTS), 50);
  assert.equal(renderCallArgValue(true, INPUTS, OUTPUTS), true);
});

test('renderCallArgs: recurses into nested objects and arrays', () => {
  const args = {
    query: 'region:{{input.region}}',
    limit: 25,
    filter: { region: '{{steps.gather.output.region}}', ids: ['{{input.region}}', 'static'] },
  };
  assert.deepEqual(renderCallArgs(args, INPUTS, OUTPUTS), {
    query: 'region:east',
    limit: 25,
    filter: { region: 'west', ids: ['east', 'static'] },
  });
  assert.deepEqual(renderCallArgs(undefined, INPUTS, OUTPUTS), {});
});

test('callToolSideEffectClass: classifies send / write / read from the tool slug', () => {
  assert.equal(callToolSideEffectClass('composio_gmail_send_email'), 'send');
  assert.equal(callToolSideEffectClass('COMPOSIO_TWITTER_POST'), 'send');
  assert.equal(callToolSideEffectClass('composio_airtable_create_record'), 'write');
  assert.equal(callToolSideEffectClass('composio_sheets_update_row'), 'write');
  assert.equal(callToolSideEffectClass('ONE_DRIVE_UPLOAD_FILE'), 'write');
  assert.equal(callToolSideEffectClass('GMAIL_MARK_AS_READ'), 'write');
  assert.equal(callToolSideEffectClass('COMPOSIO_UNFAMILIAR_ACTION'), 'write');
  assert.equal(callToolSideEffectClass('composio_gmail_search'), 'read');
  assert.equal(callToolSideEffectClass('composio_hubspot_list_contacts'), 'read');
  assert.equal(callToolSideEffectClass('TWITTER_GET_POST'), 'read');
});

test('stepSideEffectClass: declared sideEffect can STRENGTHEN but never downgrade a real send (re-hunt round 2 author-side)', () => {
  assert.equal(stepSideEffectClass({ id: 's', prompt: '', call: { tool: 'composio_gmail_send' } }), 'send');
  assert.equal(stepSideEffectClass({ id: 's', prompt: '', call: { tool: 'composio_gmail_search' } }), 'read');
  // A real SEND slug can NOT be downgraded by an explicit sideEffect — labeling a
  // send node `read` must not skip the gate. The slug is authoritative for sends.
  assert.equal(stepSideEffectClass({ id: 's', prompt: '', call: { tool: 'composio_gmail_send' }, sideEffect: 'read' }), 'send');
  // For a NON-send slug the declared class still wins (an author can strengthen a
  // read-classified call to write, or knows their read-only call best).
  assert.equal(stepSideEffectClass({ id: 's', prompt: '', call: { tool: 'composio_gmail_search' }, sideEffect: 'write' }), 'write');
  assert.equal(stepSideEffectClass({ id: 's', prompt: '', call: { tool: 'TWITTER_GET_POST' } }), 'read');
  assert.equal(stepSideEffectClass({ id: 's', prompt: '', call: { tool: 'GMAIL_MARK_AS_READ' }, sideEffect: 'read' }), 'write');
});

test('structuredCallNeedsMutationReceipt: obvious writes cannot disable receipts with a stale read label', () => {
  assert.equal(structuredCallNeedsMutationReceipt({ id: 's', prompt: '', call: { tool: 'composio_airtable_create_record' } }), true);
  assert.equal(structuredCallNeedsMutationReceipt({ id: 's', prompt: '', call: { tool: 'composio_airtable_create_record' }, sideEffect: 'read' }), true);
  assert.equal(structuredCallNeedsMutationReceipt({ id: 's', prompt: '', call: { tool: 'GMAIL_MARK_AS_READ' }, sideEffect: 'read' }), true);
  assert.equal(structuredCallNeedsMutationReceipt({ id: 's', prompt: '', call: { tool: 'UNKNOWN_PROVIDER_ACTION' }, sideEffect: 'read' }), true);
  assert.equal(structuredCallNeedsMutationReceipt({ id: 's', prompt: '', call: { tool: 'composio_gmail_search' }, sideEffect: 'read' }), false);
});

function frontmatter(steps: unknown[]) {
  return { name: 'w', description: 'd', enabled: true, trigger: { manual: true }, steps } as never;
}

test('validation: a call step needs no prompt, allows read fan-out, and blocks unsafe call combinations', () => {
  // valid: a call step with no prompt
  const ok = validateWorkflowDefinition(frontmatter([{ id: 'fetch', call: { tool: 'composio_http_get', args: { url: '{{input.url}}' } } }]));
  assert.equal(ok.errors.some((e) => /no substantive prompt/.test(e)), false, 'call step should not require a prompt');

  // call without a tool → error
  const noTool = validateWorkflowDefinition(frontmatter([{ id: 'x', call: {} }]));
  assert.ok(noTool.errors.some((e) => /declares call but no tool/.test(e)));

  // call + deterministic → error
  const both = validateWorkflowDefinition(frontmatter([{ id: 'x', call: { tool: 't' }, deterministic: { runner: 'r.mjs' } }]));
  assert.ok(both.errors.some((e) => /both call and deterministic/.test(e)));

  // CALL-2b: a READ-class call + forEach is ALLOWED (idempotent per-item fetch)
  const readFanout = validateWorkflowDefinition(frontmatter([
    { id: 'list', prompt: 'produce a list', output: { type: 'array' } },
    { id: 'enrich', call: { tool: 'composio_hubspot_get_contact', args: { id: '{{item.id}}' } }, forEach: 'list', dependsOn: ['list'] },
  ]));
  assert.equal(readFanout.errors.some((e) => /call with forEach|call and forEach/.test(e)), false, 'read-class call+forEach is allowed');

  const objectNounReadFanout = validateWorkflowDefinition(frontmatter([
    { id: 'list', prompt: 'produce a list', output: { type: 'array' } },
    { id: 'fetch', call: { tool: 'TWITTER_GET_POST', args: { id: '{{item.id}}' } }, forEach: 'list', dependsOn: ['list'] },
  ]));
  assert.equal(objectNounReadFanout.errors.some((e) => /call with forEach|call and forEach/.test(e)), false);

  const trailingStateWriteFanout = validateWorkflowDefinition(frontmatter([
    { id: 'list', prompt: 'produce a list', output: { type: 'array' } },
    { id: 'mark', call: { tool: 'GMAIL_MARK_AS_READ', args: { id: '{{item.id}}' } }, sideEffect: 'read', forEach: 'list', dependsOn: ['list'] },
  ]));
  assert.ok(trailingStateWriteFanout.errors.some((e) => /call with forEach|call and forEach/.test(e)));

  // a SEND-class call + forEach → error (double-send risk)
  const sendFanout = validateWorkflowDefinition(frontmatter([
    { id: 'list', prompt: 'produce a list', output: { type: 'array' } },
    { id: 'blast', call: { tool: 'composio_gmail_send_email', args: { to: '{{item.email}}' } }, forEach: 'list', dependsOn: ['list'] },
  ]));
  assert.ok(sendFanout.errors.some((e) => /send-class call with forEach/.test(e)), 'send-class call+forEach is blocked');
});

test('serialization: a call node round-trips through SKILL.md', () => {
  writeWorkflow('call-rt', {
    name: 'call-rt', description: 'round trip', enabled: false, trigger: { manual: true },
    inputs: { url: { type: 'string' } },
    steps: [{ id: 'fetch', prompt: '', call: { tool: 'composio_http_get', args: { url: '{{input.url}}', limit: 25 } }, sideEffect: 'read' }],
  } as never);
  const back = readWorkflow('call-rt');
  assert.ok(back);
  assert.deepEqual(back!.data.steps[0].call, { tool: 'composio_http_get', args: { url: '{{input.url}}', limit: 25 } });
});
