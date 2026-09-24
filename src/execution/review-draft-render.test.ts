/**
 * Run: npx tsx --test src/execution/review-draft-render.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderReviewDraftForHumans, renderReviewValueForHumans } from './review-draft-render.js';

test('an array of drafts renders as numbered items with labelled lines and long text on its own lines', () => {
  const text = renderReviewDraftForHumans(JSON.stringify([
    { name: 'Dana Whitfield', company: 'Harbor Point Dental', email: 'dana@harborpointdental.example', subject: 'The practice outranking you', body: 'Hi Dana, a nearby practice currently outranks Harbor Point Dental for "dentist near me" in local search, which means new patients find them first.' },
    { name: 'Marcus Lee', company: 'Lee & Sons Roofing', subject: 'Lead quality before October', body: 'Short.' },
  ]));
  assert.match(text, /^1\.\n   Name: Dana Whitfield\n   Company: Harbor Point Dental\n   Email: dana@harborpointdental.example\n   Subject: The practice outranking you\n   Body:\n     Hi Dana, a nearby practice/);
  assert.match(text, /\n\n2\.\n   Name: Marcus Lee\n/);
  assert.match(text, /Body: Short\.$/);
  assert.doesNotMatch(text, /[{}]|"name"|"body"/, 'no JSON structure reaches the reviewer');
});

test('keys become labels; nested objects indent; scalar lists join; non-JSON passes through', () => {
  assert.equal(renderReviewValueForHumans({ send_to: 'a@x.example', follow_up_days: 3, tags: ['warm', 'q4'], meta: { owner: 'me' } }),
    'Send to: a@x.example\nFollow up days: 3\nTags: warm, q4\nMeta:\n  Owner: me');
  assert.equal(renderReviewDraftForHumans('  Plain draft text.  '), 'Plain draft text.');
  assert.equal(renderReviewDraftForHumans('{not json'), '{not json');
  assert.equal(renderReviewValueForHumans(null), '—');
});
