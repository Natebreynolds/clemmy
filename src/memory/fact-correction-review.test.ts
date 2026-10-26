import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-memory-clarification-review-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.AUTH_MODE = 'codex_oauth';
process.env.MODEL_ROUTING_MODE = 'all_in';
process.env.BYO_MODEL_BASE_URL = 'https://fixture.invalid/v1';
process.env.BYO_MODEL_API_KEY = 'fixture-only';
process.env.BYO_MODEL_ID = 'fixture-brain';
process.env.BYO_MODEL_JUDGE_ID = 'fixture-review';
process.env.CLEMMY_JUDGE_CROSS_FAMILY = 'off';
const { Runner } = await import('@openai/agents');
const { parseFactCorrectionReview, reviewFactCorrection } = await import('./fact-correction-review.js');
const { closeMemoryDb } = await import('./db.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');
after(() => { mock.restoreAll(); closeMemoryDb(); closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('clarification correction review quotes only the literal current owner answer', () => {
  assert.equal(parseFactCorrectionReview({ decision: 'entailed', ownerQuote: '20', reason: 'Owner supplied the missing cutoff.' }, '20').decision, 'entailed');
  assert.throws(() => parseFactCorrectionReview({ decision: 'entailed', ownerQuote: 'Should I replace B with 20?', reason: 'Question suggested it.' }, '20'), /cite the owner request/);
});

test('clarification correction review carries typed literal history through its existing single Runner call', async () => {
  const captured: Array<{ instructions: unknown; input: string; maxTurns: unknown }> = [];
  const stub = mock.method(Runner.prototype, 'run', async (agent: { instructions: unknown }, input: string, options: { maxTurns: unknown }) => {
    captured.push({ instructions: agent.instructions, input, maxTurns: options.maxTurns });
    return { finalOutput: JSON.stringify({ decision: 'entailed', ownerQuote: '20', reason: 'Original owner asked B correction and selected 20.' }) };
  });
  const input = { ownerText: '20', currentContext: { projectId: 'synthetic-project', agentKey: null },
    observation: { id: 1, content: 'B cutoff 5.' }, edits: [{ before: '5', after: '20' }], replacementContent: 'B cutoff 20.',
    clarification: { version: 1 as const, packetId: 'synthetic-edge', sourceDigest: 'a'.repeat(64),
      resolution: { resolverVersion: 'clarification-resolver-v3-semantic-projection' as const, disposition: 'selected' as const, selectedOption: 'opt-2', semanticInputHash: 'b'.repeat(64) },
      messages: [{ role: 'user' as const, sourceUserSeq: 1, sourceEventId: 'source-A', dataHash: 'c'.repeat(64), sourceContextDigest: 'd'.repeat(64), text: 'Correct B after I choose its cutoff.' },
        { role: 'assistant' as const, awaitingEventId: 'question', terminalEventId: 'terminal', text: 'Use 10 or 20?', options: ['10', '20'] },
        { role: 'user' as const, sourceUserSeq: 2, sourceEventId: 'source-B', dataHash: 'e'.repeat(64), sourceContextDigest: 'f'.repeat(64), text: '20' }] } };
  try {
    const result = await reviewFactCorrection(input);
    assert.equal(result.decision, 'entailed');
  } finally { stub.mock.restore(); }
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.maxTurns, 1);
  assert.deepEqual(JSON.parse(captured[0]!.input), input);
  assert.match(String(captured[0]!.instructions), /Assistant questions\/options are context/);
  assert.match(String(captured[0]!.instructions), /cite ownerQuote from current ownerText, never an assistant message/);
});
