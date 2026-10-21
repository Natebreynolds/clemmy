/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/echoed-written-content.test.ts
 *
 * A read that returned exactly what this request wrote is referenced to the
 * artifact instead of repeated in the review; anything else is shown as before.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { echoedWrittenContent, ECHOED_WRITE_MIN_CHARS } = await import('./host-completion-work.js');

const text = `# Deck\n\n${'Slide line with "quotes" and a tab\t.\n'.repeat(12)}`;
const written = [{ createdId: 'write_file#c1', handle: 'h1', contentDigest: 'a'.repeat(64), text }];

test('a string result holding the whole written text is the write echoed back', () => {
  assert.ok(text.length >= ECHOED_WRITE_MIN_CHARS);
  assert.equal(echoedWrittenContent(`Path: /x/deck.md\n\n${text}\n\n[retained]`, written)?.createdId, 'write_file#c1');
});

test('a JSON-shaped result holding the text, escaped, is the write echoed back', () => {
  assert.equal(echoedWrittenContent({ path: '/x/deck.md', content: text, chars: text.length }, written)?.createdId, 'write_file#c1');
});

test('a partial match, a short write, or no writes leave the read shown as before', () => {
  assert.equal(echoedWrittenContent(text.slice(0, 300), written), undefined);
  assert.equal(echoedWrittenContent('short', [{ ...written[0]!, text: 'short' }]), undefined);
  assert.equal(echoedWrittenContent(text, []), undefined);
  assert.equal(echoedWrittenContent(text, undefined), undefined);
});

test('the largest written part wins when a result holds several', () => {
  const small = { createdId: 'w#small', handle: 'hs', contentDigest: 'b'.repeat(64), text: text.slice(0, 250) };
  assert.equal(echoedWrittenContent(text, [small, written[0]!])?.createdId, 'write_file#c1');
});

test('a plan publication states its plan by size and digest, other scopes are shown whole', async () => {
  const { requestScopeText } = await import('./host-completion-work.js');
  const plan = requestScopeText('publish_plan', { full_text: 'x'.repeat(5000), readiness: 'ready', structured_plan: { steps: [1, 2] } });
  assert.match(plan, /"full_text":"\[5000 chars, sha256 [0-9a-f]{16}\]"/);
  assert.match(plan, /"structured_plan":"\[\d+ chars, sha256 [0-9a-f]{16}\]"/);
  assert.ok(plan.length < 400);
  assert.equal(requestScopeText('read_file', { path: '/a', max_chars: 10 }), '{"path":"/a","max_chars":10}');
  // An argument carrying the whole written file is referenced to the artifact.
  const scoped = requestScopeText('write_file', { path: '/x/deck.md', content: text, mode: 'create' }, written);
  assert.doesNotMatch(scoped, /Slide line with/);
  assert.match(scoped, /identical to the current saved content of artifact write_file#c1/);
  assert.match(scoped, /"mode":"create"/);
  const note = requestScopeText('plan_step_result', { step_id: 's1', result: `Draft:\n${text}\nDone.` }, written);
  assert.match(note, /Draft:\\n\[identical to the current saved content of artifact write_file#c1/);
  assert.equal(requestScopeText('write_file', { content: text }, []), JSON.stringify({ content: text }));
});

test('a result that carries the written content beside a warning keeps the warning and references the content', async () => {
  const { substituteWrittenContent } = await import('./host-completion-work.js');
  const entry = written[0]!;
  const plain = `Wrote the deck.\n${text}\nWARNING: missing requirement: the success criteria name a slide 6 that is absent.`;
  const out = substituteWrittenContent(plain, entry)!;
  assert.doesNotMatch(out, /Slide line with/);
  assert.match(out, /identical to the current saved content of artifact write_file#c1/);
  assert.match(out, /missing requirement: the success criteria name a slide 6/);
  const json = JSON.stringify({ receipt: 'ok', content: text, warning: 'missing requirement: X' });
  const outJson = substituteWrittenContent(json, entry)!;
  assert.doesNotMatch(outJson, /Slide line with/);
  assert.match(outJson, /missing requirement: X/);
  assert.equal(substituteWrittenContent('a windowed view without the span', entry), null);
});
