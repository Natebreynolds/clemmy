/**
 * Run: npx tsx --test src/runtime/harness/post-result-guardrail-recovery.test.ts
 *
 * Regression for the live GLM planning loop where plan_task returned an exact
 * local typed refusal, then the post-result semantic-loop backstop threw over
 * those settled bytes. The host subsequently paired effect_unknown and asked
 * the user to continue even though no external effect existed.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-post-result-guardrail-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-post-result-guardrail\n', 'utf8');

const { tool } = await import('@openai/agents');
const { z } = await import('zod');
const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const guardrail = await import('./tool-guardrail.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const refusal = JSON.stringify({
  ok: false,
  code: 'plan_not_admitted',
  detail: 'write_not_aligned:work.requestedEffect',
  repair: 'Correct the requested effect against the exact planning catalog.',
});

function semanticEscalation(effect: Parameters<typeof brackets.hostOwnsObservedGuardrailResult>[0]['frozenEffect']) {
  return {
    hostOwnsToolDeadlineAndSettlement: true,
    frozenEffect: effect,
    decision: {
      action: 'escalate',
      rule: 'semantic_result_repeat',
      effect,
    },
  } as const;
}

test('only frozen non-mutating host effects may own an observed post-result escalation', () => {
  for (const effect of ['read', 'compute', 'host_only'] as const) {
    assert.equal(
      brackets.hostOwnsObservedGuardrailResult(semanticEscalation(effect)),
      true,
      `${effect} exact returned bytes remain model/checkpoint input`,
    );
  }

  for (const effect of ['local_write', 'external_write', 'admin', 'unknown'] as const) {
    assert.equal(
      brackets.hostOwnsObservedGuardrailResult(semanticEscalation(effect)),
      false,
      `${effect} cannot inherit the non-mutating recovery rail`,
    );
  }

  assert.equal(brackets.hostOwnsObservedGuardrailResult({
    ...semanticEscalation('read'),
    hostOwnsToolDeadlineAndSettlement: false,
  }), false, 'a legacy/local-file wrapper without host settlement ownership keeps the hard stop');
  assert.equal(brackets.hostOwnsObservedGuardrailResult({
    ...semanticEscalation('read'),
    frozenEffect: 'external_write',
  }), false, 'an MCP/read-shaped outer decision cannot downgrade a frozen mutation');
  assert.equal(brackets.hostOwnsObservedGuardrailResult({
    ...semanticEscalation('host_only'),
    decision: {
      action: 'escalate',
      rule: 'exact_args_repeat',
      effect: 'host_only',
    },
  }), false, 'pre-body/exact-argument runaway control remains terminal');
});

test('live-shaped third plan refusal returns exact bytes to the host-owned model loop', async () => {
  guardrail._resetAllTrackersForTests();
  const session = eventlog.createSession({ kind: 'chat' });
  let bodies = 0;
  const configured = tool({
    name: 'plan_task',
    description: 'Fixture host planning control.',
    parameters: z.object({
      draft: z.object({ criterion: z.string() }),
    }),
    execute: async () => {
      bodies += 1;
      return refusal;
    },
  });
  const wrapped = brackets.wrapToolForHarness(configured) as typeof configured;
  const invoke = wrapped.invoke!.bind(wrapped);
  const controller = new AbortController();
  const results: unknown[] = [];

  for (const criterion of ['first wording', 'second wording', 'third wording']) {
    const result = await brackets.withHarnessRunContext({
      sessionId: session.id,
      behaviorScopeId: `${session.id}::source:1`,
      counter: new brackets.ToolCallsCounter(20),
      hostOwnsToolDeadlineAndSettlement: true,
      hostOwnedToolEffect: 'host_only',
    }, () => invoke(
      null,
      JSON.stringify({ draft: { criterion } }),
      {
        signal: controller.signal,
        toolCall: { callId: `live-plan-${results.length + 1}` },
      },
    ));
    results.push(result);
  }

  assert.equal(bodies, 3);
  assert.deepEqual(results, [refusal, refusal, refusal],
    'the third exact local result is preserved instead of becoming a thrown effect_unknown');
});

test('the same post-result escalation without a frozen effect proof still throws', async () => {
  guardrail._resetAllTrackersForTests();
  const session = eventlog.createSession({ kind: 'chat' });
  const configured = tool({
    name: 'plan_task',
    description: 'Fixture legacy planning control.',
    parameters: z.object({
      draft: z.object({ criterion: z.string() }),
    }),
    execute: async () => refusal,
  });
  const wrapped = brackets.wrapToolForHarness(configured) as typeof configured;
  const invoke = wrapped.invoke!.bind(wrapped);
  const controller = new AbortController();
  const invokeOne = (criterion: string) => brackets.withHarnessRunContext({
    sessionId: session.id,
    behaviorScopeId: `${session.id}::source:1`,
    counter: new brackets.ToolCallsCounter(20),
    hostOwnsToolDeadlineAndSettlement: true,
  }, () => invoke(
    null,
    JSON.stringify({ draft: { criterion } }),
    {
      signal: controller.signal,
      toolCall: { callId: `unproven-plan-${criterion}` },
    },
  ));

  assert.equal(await invokeOne('one'), refusal);
  assert.equal(await invokeOne('two'), refusal);
  await assert.rejects(
    invokeOne('three'),
    (error: unknown) => error instanceof brackets.ToolGuardrailEscalated
      && error.decision.rule === 'semantic_result_repeat',
  );
});
