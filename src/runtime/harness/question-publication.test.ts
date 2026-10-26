import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publishOrDeferQuestionPublication,
  withQuestionPublicationCapture,
  type PreparedQuestionPublication,
} from './question-publication.js';

test('question publication remains synchronous without a capture scope', () => {
  let posts = 0;
  const result = publishOrDeferQuestionPublication({ question: 'Which heading?', options: null, modelAuthored: true },
    () => { posts += 1; return true; });
  assert.equal(result, true);
  assert.equal(posts, 1);
});

test('captured projection is immutable and publication executes once', () => {
  const captures: PreparedQuestionPublication[] = [];
  const options = ['First heading', 'Second heading'];
  let posts = 0;
  const result = withQuestionPublicationCapture(p => captures.push(p), () =>
    publishOrDeferQuestionPublication({ question: 'Which heading?', options, modelAuthored: true },
      () => { posts += 1; return true; }));
  assert.equal(result, true);
  assert.equal(posts, 0, 'capture is a proposal, not publication');
  const [publication] = captures;
  assert.ok(publication);
  options[0] = 'A later mutation';
  assert.deepEqual(publication.options, ['First heading', 'Second heading']);
  assert.ok(Object.isFrozen(publication));
  assert.ok(Object.isFrozen(publication.options));
  assert.equal(publication.publish(), true);
  assert.equal(publication.publish(), true);
  assert.equal(posts, 1);
});

test('a refused or throwing publication cannot retry under a later owner', () => {
  for (const throwing of [false, true]) {
    const captures: PreparedQuestionPublication[] = [];
    let calls = 0;
    withQuestionPublicationCapture(p => captures.push(p), () =>
      publishOrDeferQuestionPublication({ question: 'Which heading?', options: null, modelAuthored: false }, () => {
        calls += 1;
        if (throwing) throw new Error('Controlled lost owner');
        return false;
      }));
    const [publication] = captures;
    assert.ok(publication);
    if (throwing) assert.throws(() => publication.publish(), /Controlled lost owner/);
    else assert.equal(publication.publish(), false);
    assert.equal(publication.publish(), false);
    assert.equal(calls, 1);
  }
});

test('capture rejection never publishes and concurrent async scopes stay separate', async () => {
  let posts = 0;
  assert.throws(() => withQuestionPublicationCapture(() => { throw new Error('Controlled capture refusal'); }, () =>
    publishOrDeferQuestionPublication({ question: 'Not admitted', options: null, modelAuthored: true },
      () => { posts += 1; return true; })), /Controlled capture refusal/);
  const left: PreparedQuestionPublication[] = [];
  const right: PreparedQuestionPublication[] = [];
  await Promise.all([
    withQuestionPublicationCapture(p => left.push(p), async () => {
      await Promise.resolve();
      publishOrDeferQuestionPublication({ question: 'Left source', options: null, modelAuthored: true },
        () => { posts += 1; return true; });
    }),
    withQuestionPublicationCapture(p => right.push(p), async () => {
      await Promise.resolve();
      publishOrDeferQuestionPublication({ question: 'Right source', options: [], modelAuthored: false },
        () => { posts += 1; return true; });
    }),
  ]);
  assert.equal(posts, 0);
  assert.deepEqual(left.map(p => p.question), ['Left source']);
  assert.deepEqual(right.map(p => p.question), ['Right source']);
  assert.equal(left[0]!.options, null);
  assert.deepEqual(right[0]!.options, []);
});
