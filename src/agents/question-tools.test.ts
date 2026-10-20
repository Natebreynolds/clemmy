import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { RunContext } from '@openai/agents';
import { conditionalApprovalPreparationRepair } from './question-tools.js';
import { stableJsonDigest } from '../shared/stable-json-digest.js';

const { getLocalToolSchemas } = await import('../tools/local-runtime-tools.js');
const { buildAskUserQuestionTool, userChoiceToolUseBehavior } = await import('./orchestrator.js');
const { saveProactivityPolicy } = await import('./proactivity-policy.js');
const { createSession, listEvents, resetEventLog } = await import('../runtime/harness/eventlog.js');
const { listPendingActions } = await import('../runtime/harness/pending-actions.js');
const { ASK_USER_QUESTION_AUTO_RESOLVED_PREFIX } = await import('../runtime/harness/terminal-tool.js');

async function ask(
  sessionId: string,
  purpose: 'approval' | 'clarification' | null,
  question = 'Should I send the prepared update now?',
  options = ['Yes', 'No'],
): Promise<string> {
  const tool = buildAskUserQuestionTool();
  const result = await tool.invoke(new RunContext({ sessionId, turn: 1 }), JSON.stringify({
    question, options, purpose,
  }));
  return typeof result === 'string' ? result : JSON.stringify(result);
}

test('approval preparation repair discloses the exact registered deferred schema without arguments or authority', () => {
  const current = getLocalToolSchemas().get('pending_action_queue');
  assert.ok(current, 'the production tool must be registered');
  const expected = z.toJSONSchema(current, { io: 'input', unrepresentable: 'throw' });
  const repair = conditionalApprovalPreparationRepair(current);
  assert.ok(repair);
  assert.deepEqual(repair.preparation_tool.input_schema, expected);
  assert.equal(repair.preparation_tool.schema_sha256, stableJsonDigest(expected));
  assert.equal(repair.preparation_tool.schema_is_permission, false);
  assert.equal(repair.authority, 'none');
  assert.equal(repair.action_performed, false);
  assert.equal(repair.applies_when, 'formal_card_required_and_work_not_already_sealed');
  assert.deepEqual(Object.keys(repair.preparation_tool).sort(), [
    'carrier', 'input_schema', 'name', 'schema_is_permission', 'schema_sha256',
  ]);
  assert.equal(repair.preparation_tool.carrier, 'call_tool');
  assert.equal(repair.preparation_tool.name, 'pending_action_queue');
  // These constraints come from registration, rather than a duplicated schema.
  assert.equal(expected.additionalProperties, false);
  assert.ok(expected.required?.includes('toolName'));
  assert.ok(expected.required?.includes('payloadJson'));
});

test('approval preparation repair tracks supplied current compiled schema rather than a copied contract', () => {
  const first = z.strictObject({ exactNewField: z.literal('current') });
  const second = z.strictObject({ exactNewField: z.literal('changed') });
  const repair = conditionalApprovalPreparationRepair(first);
  assert.ok(repair);
  assert.deepEqual(repair.preparation_tool.input_schema, z.toJSONSchema(first, { io: 'input', unrepresentable: 'throw' }));
  assert.notEqual(repair.preparation_tool.schema_sha256, conditionalApprovalPreparationRepair(second)?.preparation_tool.schema_sha256);
});

test('approval preparation repair never fabricates missing or malformed schema', () => {
  assert.equal(conditionalApprovalPreparationRepair(undefined), null);
  assert.equal(conditionalApprovalPreparationRepair(z.string()), null);
  assert.equal(conditionalApprovalPreparationRepair(z.any()), null);
  assert.equal(conditionalApprovalPreparationRepair({} as z.ZodTypeAny), null);
  const unsupportedNested = z.strictObject({ nested: z.date() });
  assert.throws(() => z.toJSONSchema(unsupportedNested, { io: 'input', unrepresentable: 'throw' }));
  assert.equal(conditionalApprovalPreparationRepair(unsupportedNested), null);
});

test('typed YOLO approval returns conditional schema repair without a card, dispatch, or halt', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const session = createSession({ kind: 'chat' });
    const result = await ask(session.id, 'approval');
    assert.ok(result.startsWith(`${ASK_USER_QUESTION_AUTO_RESOLVED_PREFIX}\n`));
    const repair = JSON.parse(result.slice(result.indexOf('\n{') + 1));
    assert.deepEqual(repair, conditionalApprovalPreparationRepair(getLocalToolSchemas().get('pending_action_queue')));
    assert.match(result, /Already sealed work stays on `work_call`; never queue it again/);
    assert.match(result, /For work requiring no card, continue through its ordinary execution boundary/);
    const terminal = userChoiceToolUseBehavior({ context: { sessionId: session.id, turn: 1 } }, [{
      type: 'function_output', tool: { name: 'ask_user_question' }, output: result,
    }]);
    assert.equal(terminal.isFinalOutput, false);
    assert.deepEqual(listPendingActions({ sessionId: session.id, status: 'all' }), []);
    const events = listEvents(session.id);
    assert.equal(events.filter((event) => event.type === 'autonomy_note').length, 1);
    assert.deepEqual(events.filter((event) => event.type !== 'autonomy_note'), []);
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
});

test('regex approval compatibility keeps its previous response without schema repair', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const session = createSession({ kind: 'chat' });
    const result = await ask(session.id, null);
    assert.ok(result.startsWith(`${ASK_USER_QUESTION_AUTO_RESOLVED_PREFIX}\n`));
    assert.doesNotMatch(result, /conditional_formal_approval_preparation|input_schema|schema_sha256/);
    assert.equal(listEvents(session.id, { types: ['autonomy_note'] })[0]?.data.classifier, 'regex-backstop');
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
});

test('genuine clarification and typed approval choices keep normal question staging without schema repair', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'yolo' });
  try {
    const session = createSession({ kind: 'chat' });
    for (const [purpose, options] of [
      ['clarification', ['Sales', 'Support']],
      ['approval', ['Send now', 'Save a draft', 'Change the recipients']],
    ] as const) {
      const result = await ask(session.id, purpose, 'Which way should I handle the update?', [...options]);
      assert.equal(JSON.parse(result).status, 'staged');
      assert.doesNotMatch(result, /conditional_formal_approval_preparation|input_schema|schema_sha256/);
    }
    assert.equal(listEvents(session.id, { types: ['autonomy_note'] }).length, 0);
    assert.deepEqual(listPendingActions({ sessionId: session.id, status: 'all' }), []);
  } finally {
    saveProactivityPolicy({ autoApproveScope: 'balanced' });
  }
});

test('non-YOLO approval leaves formal response staging and the advertised question tool unchanged', async () => {
  resetEventLog();
  saveProactivityPolicy({ autoApproveScope: 'balanced' });
  const before = buildAskUserQuestionTool();
  const session = createSession({ kind: 'chat' });
  const result = await ask(session.id, 'approval');
  assert.equal(JSON.parse(result).status, 'staged');
  assert.doesNotMatch(result, /conditional_formal_approval_preparation|input_schema|schema_sha256/);
  const after = buildAskUserQuestionTool();
  assert.deepEqual(after.parameters, before.parameters);
  assert.equal(after.description, before.description);
  assert.doesNotMatch(after.description, /schema_sha256|conditional_formal_approval_preparation/);
});
