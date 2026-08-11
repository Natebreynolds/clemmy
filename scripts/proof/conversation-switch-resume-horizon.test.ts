import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compoundSemanticScopeIsFreshOnly,
  correctedMemoryReplyIsTruthful,
  replyContainsInteger,
} from './scenarios/conversation-switch-resume-horizon.js';

test('compound semantic scope keeps the fresh clause without grading its wording', () => {
  assert.equal(compoundSemanticScopeIsFreshOnly('Instead, what is 15 × 9?'), true);
  assert.equal(compoundSemanticScopeIsFreshOnly('Could you calculate 15 x 9 for me?'), true);
  assert.equal(compoundSemanticScopeIsFreshOnly('15 * 9'), true);
});

test('compound semantic scope rejects cancelled-parent leakage and missing fresh work', () => {
  assert.equal(
    compoundSemanticScopeIsFreshOnly('No—leave that note alone. Instead, what is 15 × 9?'),
    false,
  );
  assert.equal(compoundSemanticScopeIsFreshOnly('Leave the file uncreated.'), false);
  assert.equal(compoundSemanticScopeIsFreshOnly('No.'), false);
  assert.equal(compoundSemanticScopeIsFreshOnly(null), false);
});

test('corrected-memory truth check accepts varied retirement phrasing', () => {
  assert.equal(correctedMemoryReplyIsTruthful('Cedar-17 is current.'), true);
  assert.equal(
    correctedMemoryReplyIsTruthful('The current release is Cedar-17; Cedar-12 is retired.'),
    true,
  );
  assert.equal(
    correctedMemoryReplyIsTruthful(
      "Cedar's current release is Cedar-17. Cedar-12 is the retired value and should not be used as current.",
    ),
    true,
  );
  assert.equal(
    correctedMemoryReplyIsTruthful(
      "Cedar's current release is **Cedar-17**.\n\n(The earlier **Cedar-12** is retired and should no longer be used as the current number.)",
    ),
    true,
    'Markdown emphasis does not turn an explicit retirement into a stale assertion',
  );
});

test('corrected-memory truth check rejects stale assertions and missing current value', () => {
  assert.equal(correctedMemoryReplyIsTruthful('Cedar-12 is current; Cedar-17 came later.'), false);
  assert.equal(
    correctedMemoryReplyIsTruthful('The current release is **Cedar-12**, although Cedar-17 exists.'),
    false,
    'Markdown emphasis does not excuse a stale-as-current assertion',
  );
  assert.equal(correctedMemoryReplyIsTruthful('Cedar-12'), false);
  assert.equal(correctedMemoryReplyIsTruthful('I remember the correction.'), false);
});

test('arithmetic proof grading accepts exact digits or conversational number words', () => {
  assert.equal(replyContainsInteger('56.', 56), true);
  assert.equal(replyContainsInteger('The answer is **56**.', 56), true);
  assert.equal(replyContainsInteger('Fifty-six.', 56), true);
  assert.equal(replyContainsInteger('fifty‑six', 56), true);
  assert.equal(replyContainsInteger('One hundred thirty-five.', 135), true);
  assert.equal(replyContainsInteger('That is one hundred and thirty five.', 135), true);
});

test('arithmetic proof grading rejects nearby or incomplete values', () => {
  assert.equal(replyContainsInteger('Fifty-seven.', 56), false);
  assert.equal(replyContainsInteger('One hundred thirty-four.', 135), false);
  assert.equal(replyContainsInteger('One hundred.', 135), false);
  assert.equal(replyContainsInteger('1350', 135), false);
  assert.equal(replyContainsInteger('Cedar-135', 135), false);
  assert.equal(replyContainsInteger('15 × 9', 135), false);
  assert.equal(replyContainsInteger('8 and 7', 56), false);
  assert.equal(replyContainsInteger('The answer is not 56.', 56), false);
  assert.equal(replyContainsInteger('One hundred thirty-five is wrong.', 135), false);
  assert.equal(replyContainsInteger('No number supplied.', 135), false);
});
