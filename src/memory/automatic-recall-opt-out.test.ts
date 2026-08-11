import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  EXPLICIT_MEMORY_RECALL_OPTOUT_REASON,
  explicitlyOptsOutOfAutomaticMemoryRecall,
} = await import('./automatic-recall-opt-out.js');

test('explicit recall boundaries opt the current request out of the automatic primer', () => {
  const requests = [
    'Do not use memory for this request. Answer from the supplied records.',
    "Please don't consult your saved memory on this turn.",
    'Answer without using Clementine\'s long-term memory.',
    'Proceed without memory for this task.',
    'Ignore stored memory for this request and inspect only the attached payload.',
    'Do not browse or consult memory.',
    'Use no-memory mode for this answer.',
    'Do not use code mode, shell, workspace, or memory.',
    'Do not discover, use code mode, shell, workspace, or memory.',
    'Do not save this as memory. Do not use memory for this request.',
    'Do not save this or use memory while answering.',
  ];
  for (const request of requests) {
    assert.equal(explicitlyOptsOutOfAutomaticMemoryRecall(request), true, request);
  }
  assert.equal(EXPLICIT_MEMORY_RECALL_OPTOUT_REASON, 'explicit_request_opt_out');
});

test('capture-only boundaries do not disable current-turn recall', () => {
  const requests = [
    'My preferred reviewer is Taylor. Do not save this as memory.',
    'Do not store this in long-term memory, but use what you already know.',
    "Don't capture this request in memory.",
    'Do not write to or update memory.',
    'Please never persist this conversation to memory.',
  ];
  for (const request of requests) {
    assert.equal(explicitlyOptsOutOfAutomaticMemoryRecall(request), false, request);
  }
});

test('ambiguous, conversational, and computational memory mentions preserve normal recall', () => {
  const requests = [
    'Do you remember what we decided yesterday?',
    'Can you use memory to answer this?',
    "I don't remember the account name; can you check memory?",
    'Memory may not be relevant here.',
    "You don't have to use memory if it is not useful.",
    "Maybe don't use memory? I am not sure.",
    "Don't only use memory; verify the source too.",
    "Don't always use memory for every answer.",
    'Do not assume memory is correct.',
    'Do not mention the word memory in the response.',
    'Do not use the term memory in the heading.',
    'Do not use the words code mode, shell, workspace, or memory in the heading.',
    'Do not use memory-safe APIs in the implementation.',
    'Use less memory while processing this large file.',
    'Do not use too much system memory.',
    'Ignore memory pressure warnings in this benchmark.',
    'Do not discover with Composio; use memory instead.',
    "Maybe don't use memory? I am not sure. But do not save this as memory.",
  ];
  for (const request of requests) {
    assert.equal(explicitlyOptsOutOfAutomaticMemoryRecall(request), false, request);
  }
});

test('a hedged mention does not mask a later explicit recall boundary', () => {
  assert.equal(
    explicitlyOptsOutOfAutomaticMemoryRecall("Maybe don't use memory for the outline? Actually, do not use memory for this request."),
    true,
  );
});
