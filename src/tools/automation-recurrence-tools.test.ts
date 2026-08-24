import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerAutomationRecurrenceTools } from './automation-recurrence-tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

function capture(options: Parameters<typeof registerAutomationRecurrenceTools>[1]): Handler {
  let handler: Handler | undefined;
  registerAutomationRecurrenceTools({
    tool(name: string, ...args: unknown[]) {
      assert.equal(name, 'automation_recurrence_request');
      handler = args.at(-1) as Handler;
    },
  } as never, options);
  assert.ok(handler);
  return handler;
}

function body(value: Awaited<ReturnType<Handler>>): Record<string, unknown> {
  return JSON.parse(value.content[0]!.text) as Record<string, unknown>;
}

test('recurrence request requires an accepted chat source before reaching runtime', async () => {
  let calls = 0;
  const handler = capture({
    acceptedSource: () => undefined,
    request: (() => { calls += 1; throw new Error('must not run'); }) as never,
  });
  const response = await handler({
    pilot_run_id: 'run.pilot.alpha',
    every: 2,
    unit: 'hour',
    overlap_policy: 'skip',
    catch_up_policy: 'run_once',
  });
  assert.equal(response.isError, true);
  assert.equal(body(response).code, 'accepted_source_required');
  assert.equal(calls, 0);
});

test('recurrence request exposes only a disabled configuration and formal-consent boundary', async () => {
  let captured: unknown;
  const handler = capture({
    acceptedSource: () => ({ sessionId: 'chat.alpha', sourceUserSeq: 7 }),
    request: ((input: unknown) => {
      captured = input;
      return {
        ok: true,
        activation: {
          activationId: 'activation.alpha',
          status: 'approval_pending',
          workflowId: 'record-index',
        },
        preview: {
          previewId: 'preview.alpha',
          previewDigest: 'a'.repeat(64),
          workflowId: 'record-index',
          interval: {
            version: 1,
            every: 2,
            unit: 'hour',
            anchorAt: '2026-08-22T20:00:00.000Z',
            overlapPolicy: 'skip',
            catchUpPolicy: 'run_once',
          },
          firstFireAt: '2026-08-22T22:00:00.000Z',
        },
        approval: {
          approvalId: 'approval.alpha',
          status: 'pending',
          expiresAt: '2026-08-23T20:00:00.000Z',
        },
        approvalCreated: true,
        cardCreated: true,
      } as never;
    }) as never,
  });
  const response = await handler({
    pilot_run_id: 'run.pilot.alpha',
    every: 2,
    unit: 'hour',
    overlap_policy: 'skip',
    catch_up_policy: 'run_once',
  });
  assert.deepEqual(captured, {
    pilotRunId: 'run.pilot.alpha',
    approvalSessionId: 'chat.alpha',
    cadence: {
      every: 2,
      unit: 'hour',
      overlapPolicy: 'skip',
      catchUpPolicy: 'run_once',
    },
  });
  const rendered = body(response);
  assert.equal(rendered.ok, true);
  assert.equal(rendered.recurrenceAuthority, 'none_until_formal_approval_and_exact_reconciliation');
  assert.deepEqual(rendered.preview, {
    previewId: 'preview.alpha',
    previewDigest: 'a'.repeat(64),
    workflowId: 'record-index',
    interval: {
      version: 1,
      every: 2,
      unit: 'hour',
      anchorAt: '2026-08-22T20:00:00.000Z',
      overlapPolicy: 'skip',
      catchUpPolicy: 'run_once',
    },
    firstFireAt: '2026-08-22T22:00:00.000Z',
    effect: 'read',
    externalWrites: false,
    sends: false,
    configurationOnly: true,
  });
});
