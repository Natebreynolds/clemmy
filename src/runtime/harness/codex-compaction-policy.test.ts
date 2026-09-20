import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import { inFlightCompactionThresholds, compactInFlightToolContextStable,
  compactInFlightToolContext, createInFlightCompactionState } from './compaction.js';

test('Codex freezes checkpoints without changing explicit pressure overrides', () => {
  for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol']) {
    const thresholds = inFlightCompactionThresholds(key => ({
      CLEMMY_INFLIGHT_RESULT_TRIGGER_TOKENS: '12345',
      CLEMMY_INFLIGHT_RESULT_BUDGET_TOKENS: '6789',
    } as Record<string, string>)[key], model);
    assert.equal(thresholds.checkpointed, true);
    assert.equal(thresholds.resultTriggerTokens, 12345);
    assert.equal(thresholds.retainedResultBudgetTokens, 6789);
  }
});

test('frozen compaction changes earlier frames only at a new checkpoint', () => {
  const history: AgentInputItem[] = [{ role: 'user', content: 'Read these artifacts.' }];
  const state = createInFlightCompactionState();
  const opts = { resultTriggerTokens: 3000, retainedResultBudgetTokens: 1500, minRetainPairs: 1, maxRetainPairs: 3 };
  const stable: string[][] = [], sliding: string[][] = [];
  let checkpoints = 0;
  for (let i = 0; i < 12; i++) {
    history.push({ type: 'function_call', id: `fc_test_${i}`, callId: `test_${i}`, name: 'read_file', arguments: '{}', status: 'completed' });
    history.push({ type: 'function_call_result', callId: `test_${i}`, output: { type: 'text', text: `record ${i} ${'x'.repeat(3000)}` }, status: 'completed' } as AgentInputItem);
    const result = compactInFlightToolContextStable([...history], state, undefined, opts);
    checkpoints += Number(result.checkpointCreated);
    stable.push(result.nextItems.map(item => JSON.stringify(item)));
    sliding.push(compactInFlightToolContext([...history], undefined, opts).nextItems.map(item => JSON.stringify(item)));
  }
  const rewrites = (frames: string[][]) => frames.slice(1).filter((next, i) => !frames[i]!.every((item, index) => next[index] === item)).length;
  assert.ok(checkpoints >= 2);
  assert.equal(rewrites(stable), checkpoints);
  assert.ok(rewrites(sliding) > rewrites(stable));
  assert.equal(history.length, 25, 'full model history is unchanged');
});
