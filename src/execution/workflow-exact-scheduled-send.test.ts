/**
 * Positive end-to-end authority pin for one unattended exact send. The
 * provider is deliberately generic: this test exercises the saved-definition
 * validator, production call-arg renderer, and durable mutation boundary
 * without encoding any Slack/email-specific policy in product code.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-exact-scheduled-send-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const {
  exactScheduledSendCallEligibility,
  validateWorkflowDefinition,
} = await import('./workflow-validator.js');
const { renderCallArgs } = await import('./workflow-runner.js');
const {
  executeWorkflowCallMutation,
  inspectWorkflowCallMutation,
  readCommittedWorkflowCallMutationEvidence,
  readCommittedWorkflowCallMutationOutput,
  redeemExactScheduledSendStepOutput,
  redeemWorkflowCallMutationEvidence,
  replayWorkflowCallMutationSlot,
  workflowCallExpectedArgsDigest,
  workflowCallMutationFingerprint,
  workflowCallMutationSlotHasCommittedReplayAuthority,
  WorkflowCallMutationAmbiguousError,
} = await import('./workflow-call-receipts.js');
const {
  _clearToolSchemaCacheForTest,
  liveComposioSchemaFingerprint,
  rememberToolSchema,
  resetToolSchemaCache,
} = await import('../tools/composio-schema-cache.js');
const { WORKFLOWS_DIR } = await import('../memory/vault.js');

const workflow = {
  name: 'provider-neutral-exact-send',
  description: 'Render and send one fixed scheduled update.',
  enabled: true,
  allowSends: true,
  trigger: { schedule: '0 9 * * 1-5', timezone: 'UTC' },
  steps: [
    {
      id: 'render_message',
      prompt: '',
      call: {
        tool: 'CHATCO_GET_SCHEDULED_MESSAGE',
        args: { templateId: 'weekday-status' },
      },
      sideEffect: 'read',
      output: {
        type: 'object',
        required_keys: ['summary'],
        non_empty: ['summary'],
      },
    },
    {
      id: 'deliver_message',
      prompt: '',
      dependsOn: ['render_message'],
      sideEffect: 'send',
      call: {
        tool: 'CHATCO_SEND_MESSAGE',
        args: {
          destination: 'fixed-destination',
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
    },
  ],
} as const;

test.after(() => {
  resetToolSchemaCache();
  if (!process.env.CLEM_TEST_KEEP_HOME) rmSync(TMP_HOME, { recursive: true, force: true });
});

test('exact scheduled send: source output renders to one fixed provider crossing and committed replay is free', async () => {
  rememberToolSchema(workflow.steps[1].call.tool, {
    type: 'object',
    required: ['destination', 'body'],
    properties: {
      destination: { type: 'string' },
      body: { type: 'string' },
    },
  }, Date.now());
  const validation = validateWorkflowDefinition(workflow as never);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.deepEqual(
    exactScheduledSendCallEligibility(workflow as never, workflow.steps[1] as never),
    { eligible: true },
  );

  const renderedArgs = renderCallArgs(
    workflow.steps[1].call.args,
    {},
    { render_message: { summary: 'exact rendered payload' } },
  );
  assert.deepEqual(renderedArgs, {
    destination: 'fixed-destination',
    body: 'exact rendered payload',
  });

  const mutation = {
    workflowSlug: workflow.name,
    runId: 'scheduled-occurrence-1',
    stepId: workflow.steps[1].id,
    tool: workflow.steps[1].call.tool,
    schemaFingerprint: liveComposioSchemaFingerprint(workflow.steps[1].call.tool)!,
    expectedArgsDigest: workflowCallExpectedArgsDigest(renderedArgs),
    account: { connectionId: 'provider-connection', identity: 'provider-identity' },
    args: renderedArgs,
  };
  const providerCalls: Array<Record<string, unknown>> = [];
  const first = await executeWorkflowCallMutation(mutation, async () => {
    providerCalls.push(renderedArgs);
    return {
      successful: true,
      data: {
        channel: 'fixed-destination',
        ts: 'provider-receipt-1',
        message: { text: 'exact rendered payload' },
      },
    };
  });
  assert.equal(providerCalls.length, 1);
  assert.deepEqual(providerCalls[0], {
    destination: 'fixed-destination',
    body: 'exact rendered payload',
  });
  assert.equal(inspectWorkflowCallMutation(mutation).status, 'committed');

  const projected = readCommittedWorkflowCallMutationEvidence(mutation, workflow.steps[1].call.tool, renderedArgs);
  assert.equal(projected.evidence.canonicalTool, workflow.steps[1].call.tool);
  assert.equal(projected.evidence.status, 'committed');
  assert.equal(projected.evidence.dispatchSchemaFingerprint, mutation.schemaFingerprint);
  assert.deepEqual(projected.evidence.target, {
    digest: projected.evidence.target.digest,
    total: 1,
  });
  assert.equal(projected.evidence.payloadCharacters, 'exact rendered payload'.length);
  assert.match(projected.evidence.mutationReceiptId, /^workflow-call:v1:[a-f0-9]{64}$/);
  assert.match(projected.evidence.expectedArgsDigest, /^[a-f0-9]{64}$/);
  assert.match(projected.evidence.providerReadyArgsDigest, /^[a-f0-9]{64}$/);
  assert.match(projected.evidence.providerResultDigest, /^[a-f0-9]{64}$/);
  assert.match(projected.evidence.payloadDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    JSON.stringify(projected.evidence).includes('exact rendered payload'),
    false,
    'host evidence binds the exact body by digest without exposing it a second time',
  );
  const committedOutput = readCommittedWorkflowCallMutationOutput(
    mutation,
    workflow.steps[1].call.tool,
    renderedArgs,
  );
  assert.deepEqual(committedOutput, {
    providerResult: {
      protocolVersion: 1,
      kind: 'workflow_call_provider_result',
      resultId: `workflow-call-result:v1:${projected.evidence.providerResultDigest}`,
      digest: projected.evidence.providerResultDigest,
    },
    callEvidence: projected.evidence,
  });
  const publicOutput = JSON.stringify(committedOutput);
  assert.equal(publicOutput.includes('provider-receipt-1'), false);
  assert.equal(publicOutput.includes('exact rendered payload'), false);
  assert.equal(publicOutput.includes('fixed-destination'), false);
  assert.equal(redeemExactScheduledSendStepOutput(
    mutation,
    workflow.steps[1].call.tool,
    renderedArgs,
    committedOutput,
  ).ok, true);
  assert.equal(
    redeemWorkflowCallMutationEvidence(mutation, workflow.steps[1].call.tool, renderedArgs, projected.evidence).ok,
    true,
  );
  assert.equal(
    redeemWorkflowCallMutationEvidence(
      mutation,
      workflow.steps[1].call.tool,
      { ...renderedArgs, body: 'different upstream render' },
      projected.evidence,
    ).ok,
    false,
    'terminal redemption recomputes the upstream-bound expected args',
  );
  assert.equal(
    redeemWorkflowCallMutationEvidence(
      mutation,
      workflow.steps[1].call.tool,
      renderedArgs,
      { ...projected.evidence, canonicalTool: 'DIFFERENT_SEND_ACTION' },
    ).ok,
    false,
  );
  assert.equal(
    redeemExactScheduledSendStepOutput(
      mutation,
      'DIFFERENT_SEND_ACTION',
      renderedArgs,
      committedOutput,
    ).ok,
    false,
    'the authored direct tool must equal the durable mutation intent tool',
  );
  const repairedProjection = redeemExactScheduledSendStepOutput(
      mutation,
      workflow.steps[1].call.tool,
      renderedArgs,
      {
        providerResult: { successful: true, data: { ts: 'forged-provider-result' } },
        callEvidence: projected.evidence,
      },
  );
  assert.equal(repairedProjection.ok, true);
  if (repairedProjection.ok) {
    assert.equal(repairedProjection.repairedProjection, true);
    assert.deepEqual(repairedProjection.output, committedOutput);
  }

  const resumed = await executeWorkflowCallMutation(mutation, async () => {
    providerCalls.push({ duplicate: true });
    throw new Error('a committed scheduled send must not cross again');
  });
  assert.deepEqual(resumed, first);
  assert.equal(providerCalls.length, 1, 'same-run crash/resume replays the receipt with zero duplicate sends');
  assert.deepEqual(replayWorkflowCallMutationSlot(mutation), { replayed: true, result: first });
  assert.deepEqual(
    readCommittedWorkflowCallMutationEvidence(mutation, workflow.steps[1].call.tool, renderedArgs),
    projected,
    'crash replay redeems the same exact host receipt projection',
  );
});

test('committed exact-send replay remains available during a schema metadata outage', async () => {
  const tool = workflow.steps[1].call.tool;
  const schema = {
    type: 'object',
    required: ['destination', 'body'],
    properties: { destination: { type: 'string' }, body: { type: 'string' } },
  } as const;
  rememberToolSchema(tool, schema, Date.now());
  const args = { destination: 'fixed-destination', body: 'outage replay payload' };
  const mutation = {
    workflowSlug: workflow.name,
    runId: 'schema-outage-committed-replay',
    stepId: workflow.steps[1].id,
    tool,
    schemaFingerprint: liveComposioSchemaFingerprint(tool)!,
    expectedArgsDigest: workflowCallExpectedArgsDigest(args),
    args,
  };
  await executeWorkflowCallMutation(mutation, async () => ({ successful: true, id: 'outage-receipt' }));
  const slot = {
    workflowSlug: mutation.workflowSlug,
    runId: mutation.runId,
    stepId: mutation.stepId,
  };
  assert.equal(
    workflowCallMutationSlotHasCommittedReplayAuthority(slot, tool),
    true,
  );
  const realDateNow = Date.now;
  Date.now = () => realDateNow() + (31 * 60_000);
  _clearToolSchemaCacheForTest();
  try {
    assert.equal(liveComposioSchemaFingerprint(tool), undefined);
    const strict = validateWorkflowDefinition(workflow as never);
    assert.ok(strict.errors.some((error) => /live_schema_authority_unavailable/.test(error)));
    const validation = validateWorkflowDefinition(workflow as never, {
      exactSendCommittedReplayStepIds: new Set([workflow.steps[1].id]),
    });
    assert.equal(validation.ok, true, validation.errors.join('\n'));
  } finally {
    Date.now = realDateNow;
    // Keep later receipt cases independent even when an assertion above fails:
    // this test deliberately clears the process lease, while the following
    // cases require a provider-observed schema fingerprint.
    rememberToolSchema(tool, schema, Date.now());
  }
});

test('exact scheduled send evidence is keyed by the catalog slug, never the display name', async () => {
  const renderedArgs = {
    destination: 'fixed-destination',
    body: 'display-name separation payload',
  };
  const catalogSlug = 'catalog-directory-slug';
  const mutation = {
    workflowSlug: catalogSlug,
    runId: 'display-name-separation-run',
    stepId: workflow.steps[1].id,
    tool: workflow.steps[1].call.tool,
    schemaFingerprint: liveComposioSchemaFingerprint(workflow.steps[1].call.tool)!,
    expectedArgsDigest: workflowCallExpectedArgsDigest(renderedArgs),
    args: renderedArgs,
  };
  const providerResult = { successful: true, data: { id: 'display-name-separation-receipt' } };
  await executeWorkflowCallMutation(mutation, async () => providerResult);
  const output = readCommittedWorkflowCallMutationOutput(mutation, workflow.steps[1].call.tool, renderedArgs);

  assert.equal(
    redeemExactScheduledSendStepOutput(mutation, workflow.steps[1].call.tool, renderedArgs, output).ok,
    true,
  );
  assert.equal(
    redeemExactScheduledSendStepOutput(
      { ...mutation, workflowSlug: 'Human Friendly Display Name' },
      workflow.steps[1].call.tool,
      renderedArgs,
      output,
    ).ok,
    false,
    'terminal redemption must not heuristically normalize the display name into ledger authority',
  );
});

test('trim-equivalent mutation identities share one canonical ledger and never dispatch twice', async () => {
  const args = { destination: 'fixed-destination', body: 'canonical path payload' };
  const canonical = {
    workflowSlug: 'canonical-workflow',
    runId: 'canonical-run',
    stepId: 'canonical-step',
    tool: workflow.steps[1].call.tool,
    schemaFingerprint: liveComposioSchemaFingerprint(workflow.steps[1].call.tool)!,
    expectedArgsDigest: workflowCallExpectedArgsDigest(args),
    args,
  };
  let crossings = 0;
  const first = await executeWorkflowCallMutation(canonical, async () => {
    crossings += 1;
    return { successful: true, data: { receipt: 'canonical-only' } };
  });
  const alias = await executeWorkflowCallMutation({
    ...canonical,
    workflowSlug: ` ${canonical.workflowSlug} `,
    runId: ` ${canonical.runId} `,
    stepId: ` ${canonical.stepId} `,
  }, async () => {
    crossings += 1;
    throw new Error('trim alias must replay the canonical slot');
  });
  assert.deepEqual(alias, first);
  assert.equal(crossings, 1);
  assert.equal(inspectWorkflowCallMutation(canonical).status, 'committed');
});

test('a durable provider receipt without local commit self-promotes and replays with zero redispatch', async () => {
  const args = { destination: 'fixed-destination', body: 'receipt promotion payload' };
  const mutation = {
    workflowSlug: 'receipt-promotion-workflow',
    runId: 'receipt-promotion-run',
    stepId: 'deliver',
    tool: workflow.steps[1].call.tool,
    schemaFingerprint: liveComposioSchemaFingerprint(workflow.steps[1].call.tool)!,
    expectedArgsDigest: workflowCallExpectedArgsDigest(args),
    args,
  };
  let crossings = 0;
  const result = await executeWorkflowCallMutation(mutation, async () => {
    crossings += 1;
    return { successful: true, data: { receipt: 'durable-before-commit' } };
  });
  const fingerprint = workflowCallMutationFingerprint(mutation);
  const commitPath = path.join(
    WORKFLOWS_DIR,
    mutation.workflowSlug,
    'runs',
    mutation.runId,
    'call-mutations',
    fingerprint,
    'commit.json',
  );
  rmSync(commitPath);
  assert.equal(inspectWorkflowCallMutation(mutation).status, 'received');

  const replayed = await executeWorkflowCallMutation(mutation, async () => {
    crossings += 1;
    throw new Error('receipt repair must never re-enter provider dispatch');
  });
  assert.deepEqual(replayed, result);
  assert.equal(crossings, 1);
  assert.equal(inspectWorkflowCallMutation(mutation).status, 'committed');
  assert.equal(
    readCommittedWorkflowCallMutationOutput(mutation, mutation.tool, args).callEvidence.status,
    'committed',
  );
});

test('exact scheduled send payload digest recursively excludes nested recipient fields', async () => {
  const tool = workflow.steps[1].call.tool;
  const schemaFingerprint = liveComposioSchemaFingerprint(tool)!;
  const payloadDigests: string[] = [];
  const targetDigests: string[] = [];
  for (const [index, nestedChannel] of ['nested-target-one', 'nested-target-two'].entries()) {
    const args = {
      destination: 'fixed-destination',
      body: { text: 'same exact content', channel: nestedChannel },
    };
    const mutation = {
      workflowSlug: workflow.name,
      runId: `nested-target-projection-${index}`,
      stepId: workflow.steps[1].id,
      tool,
      schemaFingerprint,
      expectedArgsDigest: workflowCallExpectedArgsDigest(args),
      args,
    };
    await executeWorkflowCallMutation(mutation, async () => ({ successful: true, id: index }));
    const projected = readCommittedWorkflowCallMutationEvidence(mutation, tool, args).evidence;
    payloadDigests.push(projected.payloadDigest);
    targetDigests.push(projected.target.digest);
    assert.equal(JSON.stringify(projected).includes(nestedChannel), false);
  }
  assert.equal(payloadDigests[0], payloadDigests[1]);
  assert.notEqual(targetDigests[0], targetDigests[1]);
});

test('Slack markdown_text is bound as payload while channel remains separate target evidence', async () => {
  const args = {
    channel: 'C0BHT7WHZDL',
    markdown_text: 'exact Salesforce team update',
  };
  const mutation = {
    workflowSlug: workflow.name,
    runId: 'slack-markdown-shape',
    stepId: workflow.steps[1].id,
    tool: 'SLACK_SEND_MESSAGE',
    schemaFingerprint: 'a'.repeat(32),
    expectedArgsDigest: workflowCallExpectedArgsDigest(args),
    args,
  };
  await executeWorkflowCallMutation(mutation, async () => ({
    successful: true,
    data: { channel: 'C0BHT7WHZDL', ts: 'provider-receipt-slack' },
  }));
  const committed = readCommittedWorkflowCallMutationEvidence(
    { workflowSlug: mutation.workflowSlug, runId: mutation.runId, stepId: mutation.stepId },
    mutation.tool,
    args,
  );
  assert.equal(committed.evidence.payloadCharacters, args.markdown_text.length);
  assert.match(committed.evidence.payloadDigest, /^[a-f0-9]{64}$/);
  assert.equal(committed.evidence.target.total, 1);
  assert.equal(JSON.stringify(committed.evidence).includes(args.channel), false);
  assert.equal(JSON.stringify(committed.evidence).includes(args.markdown_text), false);
  const publicOutput = readCommittedWorkflowCallMutationOutput(
    { workflowSlug: mutation.workflowSlug, runId: mutation.runId, stepId: mutation.stepId },
    mutation.tool,
    args,
  );
  assert.equal(publicOutput.providerResult.kind, 'workflow_call_provider_result');
  assert.equal(publicOutput.providerResult.digest, committed.evidence.providerResultDigest);
  assert.equal(
    publicOutput.providerResult.resultId,
    `workflow-call-result:v1:${committed.evidence.providerResultDigest}`,
  );
  const serialized = JSON.stringify(publicOutput);
  assert.equal(serialized.includes('provider-receipt-slack'), false);
  assert.equal(serialized.includes(args.channel), false);
  assert.equal(serialized.includes(args.markdown_text), false);
});

test('exact scheduled send: a crash after the provider may have committed parks and never blind-replays', async () => {
  const renderedArgs = renderCallArgs(
    workflow.steps[1].call.args,
    {},
    { render_message: { summary: 'crash-window payload' } },
  );
  const mutation = {
    workflowSlug: workflow.name,
    runId: 'scheduled-occurrence-crash-window',
    stepId: workflow.steps[1].id,
    tool: workflow.steps[1].call.tool,
    schemaFingerprint: liveComposioSchemaFingerprint(workflow.steps[1].call.tool)!,
    expectedArgsDigest: workflowCallExpectedArgsDigest(renderedArgs),
    account: { connectionId: 'provider-connection', identity: 'provider-identity' },
    args: renderedArgs,
  };
  let providerCrossings = 0;
  await assert.rejects(
    executeWorkflowCallMutation(mutation, async () => {
      providerCrossings += 1;
      // The fake provider accepted the exact payload, then the transport died
      // before a success receipt reached the host: committed is possible.
      throw new Error('transport vanished after provider acceptance');
    }),
    (error: unknown) => error instanceof WorkflowCallMutationAmbiguousError,
  );
  assert.equal(inspectWorkflowCallMutation(mutation).status, 'ambiguous');

  await assert.rejects(
    executeWorkflowCallMutation(mutation, async () => {
      providerCrossings += 1;
      return { duplicate: true };
    }),
    (error: unknown) => error instanceof WorkflowCallMutationAmbiguousError,
  );
  assert.equal(providerCrossings, 1, 'ambiguous crash recovery refuses before a second provider crossing');
});
