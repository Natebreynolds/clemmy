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
const {
  exactScheduledSendCallEligibility,
  exactScheduledSendCandidateToolSlugs,
  validateWorkflowDefinition,
} = await import('./workflow-validator.js');
const { writeWorkflow, readWorkflow } = await import('../memory/workflow-store.js');
const {
  _clearToolSchemaCacheForTest,
  liveComposioSchemaFingerprint,
  rememberToolSchema,
  resetToolSchemaCache,
} = await import('../tools/composio-schema-cache.js');

const INPUTS = { url: 'https://acme-co.example', region: 'east' };
const OUTPUTS = { gather: { rows: [{ id: 1 }, { id: 2 }], region: 'west' }, count: 42 };

test('renderCallArgValue: a full-token value resolves to the RAW upstream value (object/array preserved)', () => {
  // exactly one token → raw value kept (not stringified)
  assert.deepEqual(renderCallArgValue('{{steps.gather.output}}', INPUTS, OUTPUTS), { rows: [{ id: 1 }, { id: 2 }], region: 'west' });
  assert.deepEqual(renderCallArgValue('{{steps.gather.output.rows}}', INPUTS, OUTPUTS), [{ id: 1 }, { id: 2 }]);
  assert.equal(renderCallArgValue('{{input.url}}', INPUTS, OUTPUTS), 'https://acme-co.example');
  assert.equal(renderCallArgValue('{{project.path}}', INPUTS, OUTPUTS, undefined, {
    requested: 'clementine-next',
    source: 'workflow',
    name: 'clementine-next',
    path: '/Users/tester/Developer/clementine-next',
    type: 'node',
  }), '/Users/tester/Developer/clementine-next');
  // item token
  assert.equal(renderCallArgValue('{{item.email}}', INPUTS, OUTPUTS, { email: 'a@beta-co.example' }), 'a@beta-co.example');
  assert.deepEqual(renderCallArgValue('{{item}}', INPUTS, OUTPUTS, { x: 1 }), { x: 1 });
  // unresolved full token → '' (not the literal token)
  assert.equal(renderCallArgValue('{{input.missing}}', INPUTS, OUTPUTS), '');
});

test('renderCallArgValue: an EMBEDDED token string-renders; non-strings pass through', () => {
  assert.equal(renderCallArgValue('to: {{input.url}} now', INPUTS, OUTPUTS), 'to: https://acme-co.example now');
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

function exactScheduledSend(overrides: Record<string, unknown> = {}) {
  const source = {
    id: 'render_message',
    prompt: '',
    deterministic: { runner: 'render-message.mjs' },
    sideEffect: 'read',
    output: {
      type: 'object',
      required_keys: ['summary'],
      non_empty: ['summary'],
    },
  };
  const send = {
    id: 'deliver_message',
    prompt: '',
    dependsOn: ['render_message'],
    sideEffect: 'send',
    call: {
      tool: 'MESSAGING_SEND_MESSAGE',
      args: {
        destination: 'fixed-room',
        body: '{{steps.render_message.output.summary}}',
      },
    },
    output: {
      type: 'object',
      required_keys: ['providerResult', 'callEvidence'],
      non_empty: [
        'providerResult.kind',
        'providerResult.resultId',
        'providerResult.digest',
        'callEvidence.evidenceId',
        'callEvidence.mutationReceiptId',
        'callEvidence.canonicalTool',
        'callEvidence.kind',
        'callEvidence.status',
        'callEvidence.dispatchSchemaFingerprint',
        'callEvidence.expectedArgsDigest',
        'callEvidence.providerReadyArgsDigest',
        'callEvidence.providerResultDigest',
        'callEvidence.payloadDigest',
        'callEvidence.target.digest',
      ],
    },
  };
  return {
    name: 'exact-scheduled-send',
    description: 'Render and deliver one exact update.',
    enabled: true,
    allowSends: true,
    trigger: { schedule: '0 9 * * 1-5', timezone: 'UTC' },
    steps: [source, send],
    ...overrides,
  } as never;
}

const validateExactScheduledSend = (
  definition: unknown,
  opts: { allowDisabledExactSendDraft?: boolean } = {},
) => validateWorkflowDefinition(definition as never, opts);

test('SEND-CALL GATE: one fixed scheduled direct send is autonomous, but every dynamic authority shape stays gated', () => {
  resetToolSchemaCache();
  rememberToolSchema('MESSAGING_SEND_MESSAGE', {
    type: 'object',
    required: ['destination', 'body'],
    properties: {
      destination: { type: 'string' },
      body: { type: 'string' },
    },
  }, Date.now());
  const exact = validateExactScheduledSend(exactScheduledSend());
  assert.equal(
    exact.errors.some((error) => /SEND-class call node/.test(error)),
    false,
    exact.errors.join('\n'),
  );

  const slackShape = exactScheduledSend() as unknown as {
    steps: Array<{ call?: { tool: string; args: Record<string, unknown> } }>;
  };
  slackShape.steps[1].call = {
    tool: 'SLACK_SEND_MESSAGE',
    args: {
      channel: 'C0BHT7WHZDL',
      markdown_text: '{{steps.render_message.output.summary}}',
    },
  };
  rememberToolSchema('SLACK_SEND_MESSAGE', {
    type: 'object',
    required: ['channel', 'markdown_text'],
    properties: {
      channel: { type: 'string' },
      markdown_text: { type: 'string' },
    },
  }, Date.now());
  const slackResult = validateExactScheduledSend(slackShape);
  assert.equal(
    slackResult.errors.some((error) => /payload_required|SEND-class call node/.test(error)),
    false,
    slackResult.errors.join('\n'),
  );

  const noHostEvidence = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  delete noHostEvidence.steps[1].output;
  const noEvidenceResult = validateExactScheduledSend(noHostEvidence);
  assert.ok(noEvidenceResult.errors.some((error) => /host_commit_evidence_contract_required/.test(error)));

  const strict = validateExactScheduledSend(exactScheduledSend({ allowSends: false }));
  assert.ok(strict.errors.some((error) => /autonomous_sends_disabled/.test(error)));

  const implicitConsent = exactScheduledSend() as unknown as Record<string, unknown>;
  delete implicitConsent.allowSends;
  const implicitConsentResult = validateExactScheduledSend(implicitConsent);
  assert.ok(implicitConsentResult.errors.some((error) => /autonomous_sends_disabled/.test(error)));

  const manualOnly = validateExactScheduledSend(exactScheduledSend({ trigger: { manual: true } }));
  assert.ok(manualOnly.errors.some((error) => /workflow_not_scheduled/.test(error)));

  const disabledStrict = validateExactScheduledSend(exactScheduledSend({ enabled: false }));
  assert.ok(disabledStrict.errors.some((error) => /workflow_not_explicitly_enabled/.test(error)));
  const disabled = validateExactScheduledSend(
    exactScheduledSend({ enabled: false }),
    { allowDisabledExactSendDraft: true },
  );
  assert.equal(
    disabled.errors.some((error) => /SEND-class call node/.test(error)),
    false,
    disabled.errors.join('\n'),
  );

  const disabledDynamicDraft = exactScheduledSend({ enabled: false }) as unknown as { steps: Array<Record<string, unknown>> };
  (disabledDynamicDraft.steps[1].call as { args: Record<string, unknown> }).args.destination =
    '{{steps.render_message.output.summary}}';
  const disabledDynamicResult = validateExactScheduledSend(
    disabledDynamicDraft,
    { allowDisabledExactSendDraft: true },
  );
  assert.ok(
    disabledDynamicResult.errors.some((error) => /fixed_target_required/.test(error)),
    'the authoring-only disabled-draft seam must exempt schema readiness, never static target exactness',
  );

  const withApproval = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  withApproval.steps[1].requiresApproval = true;
  const gated = validateExactScheduledSend(withApproval);
  assert.equal(gated.errors.some((error) => /SEND-class call node/.test(error)), false, gated.errors.join('\n'));

  const dynamicTarget = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  const dynamicTargetArgs = (dynamicTarget.steps[1].call as { args: Record<string, unknown> }).args;
  dynamicTargetArgs.destination = '{{steps.render_message.output.summary}}';
  dynamicTargetArgs.channel = 'second-fixed-looking-target';
  const targetResult = validateExactScheduledSend(dynamicTarget);
  assert.ok(targetResult.errors.some((error) => /fixed_target_required/.test(error)));

  for (const nestedArgs of [
    {
      destination: 'fixed-decoy',
      message: { channel: '{{steps.render_message.output.summary}}', text: 'literal payload' },
    },
    {
      destination: 'fixed-decoy',
      wrapper: { arguments: '{"recipient":"{{steps.render_message.output.summary}}","body":"literal payload"}' },
      body: 'literal payload',
    },
    {
      destination: 'fixed-decoy',
      arguments: { recipient: '{{steps.render_message.output.summary}}', body: 'literal payload' },
      body: 'literal payload',
    },
  ]) {
    const nestedTarget = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
    (nestedTarget.steps[1].call as { args: Record<string, unknown> }).args = nestedArgs;
    const nestedResult = validateExactScheduledSend(nestedTarget);
    assert.ok(
      nestedResult.errors.some((error) => /fixed_target_required/.test(error)),
      `nested dynamic target must fail closed: ${JSON.stringify(nestedArgs)}`,
    );
  }

  const inputPayload = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  (inputPayload.steps[1].call as { args: Record<string, unknown> }).args.body = '{{input.message}}';
  const inputResult = validateExactScheduledSend(inputPayload);
  assert.ok(inputResult.errors.some((error) => /unsupported_template/.test(error)));

  const noPayloadBinding = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  const noPayloadBindingArgs = (noPayloadBinding.steps[1].call as { args: Record<string, unknown> }).args;
  noPayloadBindingArgs.body = '';
  noPayloadBindingArgs.format_hint = '{{steps.render_message.output.summary}}';
  const noPayloadResult = validateExactScheduledSend(noPayloadBinding);
  assert.ok(noPayloadResult.errors.some((error) => /payload_required/.test(error)));

  const literalPayload = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  const literalPayloadArgs = (literalPayload.steps[1].call as { args: Record<string, unknown> }).args;
  literalPayloadArgs.body = 'one exact literal message';
  const literalPayloadResult = validateExactScheduledSend(literalPayload);
  assert.equal(
    literalPayloadResult.errors.some((error) => /SEND-class call node/.test(error)),
    false,
    literalPayloadResult.errors.join('\n'),
  );

  const nestedTargetOnly = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  (nestedTargetOnly.steps[1].call as { args: Record<string, unknown> }).args = {
    destination: 'fixed-room',
    message: { channel: 'also-fixed-but-not-content' },
  };
  const nestedTargetOnlyResult = validateExactScheduledSend(nestedTargetOnly);
  assert.ok(nestedTargetOnlyResult.errors.some((error) => /payload_required/.test(error)));

  const multipleSends = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  multipleSends.steps.push({
    ...(multipleSends.steps[1] as Record<string, unknown>),
    id: 'deliver_message_again',
  });
  const multipleSendsResult = validateExactScheduledSend(multipleSends);
  assert.ok(multipleSendsResult.errors.some((error) => /multiple_autonomous_send_steps/.test(error)));

  const modelSource = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  delete modelSource.steps[0].deterministic;
  modelSource.steps[0].prompt = 'Write the message.';
  const modelResult = validateExactScheduledSend(modelSource);
  assert.ok(modelResult.errors.some((error) => /template_source_not_host_owned/.test(error)));

  const emptySource = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  (emptySource.steps[0].output as Record<string, unknown>).non_empty = [];
  const emptyResult = validateExactScheduledSend(emptySource);
  assert.ok(emptyResult.errors.some((error) => /template_source_may_be_empty/.test(error)));

  const multiplexer = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  (multiplexer.steps[1].call as { tool: string }).tool = 'composio_execute_tool';
  const muxResult = validateExactScheduledSend(multiplexer);
  assert.ok(muxResult.errors.some((error) => /direct_send_tool_required/.test(error)));

  const unknown = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  (unknown.steps[1].call as { tool: string }).tool = 'UNKNOWN_PROVIDER_ACTION';
  const unknownResult = validateExactScheduledSend(unknown);
  assert.ok(unknownResult.errors.some((error) => /direct_send_tool_required/.test(error)));

  const unverifiedSend = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  (unverifiedSend.steps[1].call as { tool: string }).tool = 'MYSTERY_SEND_MESSAGE';
  const unverifiedResult = validateExactScheduledSend(unverifiedSend);
  assert.ok(unverifiedResult.errors.some((error) => /direct_send_tool_unverified/.test(error)));

  const fanout = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  fanout.steps[1].forEach = 'render_message';
  const fanoutResult = validateExactScheduledSend(fanout);
  assert.ok(fanoutResult.errors.some((error) => /call with forEach/.test(error)));
  assert.ok(fanoutResult.errors.some((error) => /unsupported_executor_shape/.test(error)));

  const optionalSend = exactScheduledSend() as unknown as { steps: Array<Record<string, unknown>> };
  optionalSend.steps[1].optional = true;
  const optionalResult = validateExactScheduledSend(optionalSend);
  assert.ok(optionalResult.errors.some((error) => /unsupported_executor_shape/.test(error)));
  resetToolSchemaCache();
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

test('serialization: exact scheduled-send authority round-trips without widening its destination or payload template', () => {
  const definition = exactScheduledSend() as never;
  writeWorkflow('exact-send-rt', definition);
  const back = readWorkflow('exact-send-rt');
  assert.ok(back);
  assert.equal(back!.data.enabled, true);
  assert.equal(back!.data.allowSends, true);
  assert.deepEqual(back!.data.trigger, { schedule: '0 9 * * 1-5', timezone: 'UTC' });
  assert.equal(back!.data.steps[1].sideEffect, 'send');
  assert.equal(back!.data.steps[1].requiresApproval, undefined);
  assert.deepEqual(back!.data.steps[1].call, {
    tool: 'MESSAGING_SEND_MESSAGE',
    args: {
      destination: 'fixed-room',
      body: '{{steps.render_message.output.summary}}',
    },
  });
  assert.deepEqual(back!.data.steps[1].output, {
    type: 'object',
    required_keys: ['providerResult', 'callEvidence'],
    non_empty: [
      'providerResult.kind',
      'providerResult.resultId',
      'providerResult.digest',
      'callEvidence.evidenceId',
      'callEvidence.mutationReceiptId',
      'callEvidence.canonicalTool',
      'callEvidence.kind',
      'callEvidence.status',
      'callEvidence.dispatchSchemaFingerprint',
      'callEvidence.expectedArgsDigest',
      'callEvidence.providerReadyArgsDigest',
      'callEvidence.providerResultDigest',
      'callEvidence.payloadDigest',
      'callEvidence.target.digest',
    ],
  });
});

test('runtime authority predicate: disabled drafts and lost provider schema remain ineligible', () => {
  resetToolSchemaCache();
  const disabled = exactScheduledSend({ enabled: false }) as unknown as { steps: never[] };
  assert.deepEqual(
    exactScheduledSendCallEligibility(disabled as never, disabled.steps[1]),
    { eligible: false, reason: 'workflow_not_explicitly_enabled' },
  );

  const enabled = exactScheduledSend() as unknown as { steps: never[] };
  ((enabled.steps[1] as { call: { tool: string } }).call).tool = 'SCHEMAABSENT_SEND_MESSAGE';
  assert.deepEqual(
    exactScheduledSendCallEligibility(enabled as never, enabled.steps[1]),
    { eligible: false, reason: 'direct_send_tool_unverified' },
  );
});

test('schema self-heal candidate discovery is exact-slug and structural, never broad', () => {
  resetToolSchemaCache();
  const definition = exactScheduledSend() as unknown as { steps: Array<{ call: { tool: string; args: Record<string, unknown> } }> };
  const tool = definition.steps[1].call.tool;
  assert.deepEqual(exactScheduledSendCandidateToolSlugs(definition as never), [tool]);

  definition.steps[1].call.args.destination = '{{steps.render_message.output.summary}}';
  assert.deepEqual(
    exactScheduledSendCandidateToolSlugs(definition as never),
    [],
    'a dynamic target cannot trigger even metadata refresh',
  );
});

test('runtime authority predicate: a durable validation schema without a live provider lease cannot authorize send', () => {
  resetToolSchemaCache();
  const tool = 'STALEONLY_SEND_MESSAGE';
  const definition = exactScheduledSend() as unknown as { steps: Array<{ call: { tool: string } }> };
  definition.steps[1].call.tool = tool;
  rememberToolSchema(tool, {
    type: 'object',
    required: ['destination', 'body'],
    properties: {
      destination: { type: 'string' },
      body: { type: 'string' },
    },
  });
  assert.equal(liveComposioSchemaFingerprint(tool), undefined);
  assert.deepEqual(
    exactScheduledSendCallEligibility(definition as never, definition.steps[1]),
    { eligible: false, reason: 'live_schema_authority_unavailable' },
  );

  rememberToolSchema(tool, {
    type: 'object',
    required: ['destination', 'body'],
    properties: {
      destination: { type: 'string' },
      body: { type: 'string' },
    },
  }, Date.now());
  assert.ok(liveComposioSchemaFingerprint(tool));
  assert.deepEqual(
    exactScheduledSendCallEligibility(definition as never, definition.steps[1]),
    { eligible: true },
  );

  _clearToolSchemaCacheForTest();
  assert.ok(
    liveComposioSchemaFingerprint(tool) === undefined,
    'a cleared process cache never creates live authority from a validation read',
  );
});
