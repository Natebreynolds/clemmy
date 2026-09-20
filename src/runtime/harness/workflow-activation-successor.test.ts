import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowActivationSuccessor } from './workflow-activation-successor.js';

const original = { createdId: 'workflow', handle: 'vault/00-System/workflows/workflow/SKILL.md',
  contentDigest: 'a'.repeat(64), receipt: 'original' };
const successor = { ...original, contentDigest: 'b'.repeat(64), receipt: 'successor' };
const source = { sessionId: 'session', sourceUserSeq: 4, logicalToolCallId: 'create-call' };
const event = { role: 'system', data: { ...source, priorDigest: original.contentDigest, facts: successor } };

test('only exact host activation replaces the original artifact receipt', () => {
  assert.deepEqual(workflowActivationSuccessor(original, source, [event]), successor);
  assert.deepEqual(workflowActivationSuccessor(original, source, []), original);
  assert.deepEqual(workflowActivationSuccessor(original, source, [event, event]), original);
  for (const changed of [
    { sessionId: 'another-session' }, { sourceUserSeq: 5 },
    { logicalToolCallId: 'other-call' }, { priorDigest: 'c'.repeat(64) },
    { facts: { ...successor, handle: 'another-file' } },
    { facts: { ...successor, contentDigest: 'invalid' } },
  ]) assert.deepEqual(workflowActivationSuccessor(original, source,
    [{ ...event, data: { ...event.data, ...changed } }]), original);
  assert.deepEqual(workflowActivationSuccessor(original, source, [{ ...event, role: 'assistant' }]), original);
});
