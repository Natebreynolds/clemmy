/** Run: npx tsx --test packages/chat-engine/src/decision-presentation.test.ts
 *
 * A waiting decision reads the same on desktop and phone: one line in a list,
 * a short heading over its full text when opened, never a reference id as the
 * line a person reads, never the same paragraph twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionHeading, decisionPreview, isIdentifierLike, oneLine } from './decision-presentation.js';

const longText = 'Clem found that the research steps you ran three times this week share the same inputs. '.repeat(12);

test('markdown and code in a record read as plain words, cut at a word', () => {
  assert.equal(oneLine('**Bold** `code` and [a link](https://example.test)\n\nnext'), 'Bold code and a link next');
  assert.equal(oneLine('```\nblock\n```after'), 'after');
  const cut = oneLine(longText);
  assert.ok(cut.length <= 140 && cut.endsWith('…'));
});

test('a reference id is never the line a person reads', () => {
  assert.equal(isIdentifierLike('noticing:ntc-mupqxx8k-aa8684'), true);
  assert.equal(isIdentifierLike('Waiting for a connection'), false);
  assert.equal(isIdentifierLike('Q3'), false);
  assert.equal(decisionPreview('Pick a goal', ['noticing:ntc-mupqxx8k-aa8684', 'Two options are open']), 'Two options are open');
});

test('a preview never repeats the title', () => {
  assert.equal(decisionPreview('Pick the next goal step', ['Pick the next goal step']), undefined);
  assert.equal(decisionPreview('Pick the next goal step', ['Pick the next goal step, then report back']), undefined);
});

test('a long title becomes a short heading and the whole text stays in the body', () => {
  assert.deepEqual(decisionHeading('Pick the next goal step'), { heading: 'Pick the next goal step' });
  const sentence = decisionHeading(`Should I close the stalled goal? ${longText}`);
  assert.equal(sentence.heading, 'Should I close the stalled goal?');
  assert.ok(sentence.body?.startsWith('Clem found that'));
  const objective = 'Save this kind of request as a reusable workflow named "Docs search", built from the exact tools that chat already used (docs_search) for it';
  assert.deepEqual(decisionHeading(objective), { heading: objective }, 'a little over the limit stays whole, no stub');
  const stalled = 'and it has been stalled for weeks waiting on a decision '.repeat(6);
  const lined = decisionHeading(`Settle the panel goal — close it or re-scope it (for your goal 249a2309)\n\nThis is the only open goal ${stalled}`);
  assert.equal(lined.heading, 'Settle the panel goal — close it or re-scope it (for your goal 249a2309)', 'the text’s own first line leads');
  assert.ok(lined.body?.startsWith('This is the only open goal'));
  const runOn = `Settle the panel goal — close it or re-scope it (for your goal 249a2309) ${stalled}`;
  const cut = decisionHeading(runOn);
  assert.ok(cut.heading.length <= 140 && cut.heading.endsWith('…'));
  assert.equal(`${cut.heading.slice(0, -1)} ${cut.body!.slice(1)}`, runOn.trim(), 'the body continues where the heading stops; nothing lost or repeated');
});
