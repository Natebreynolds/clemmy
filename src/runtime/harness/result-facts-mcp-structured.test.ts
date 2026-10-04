import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveResultHandleFactsFromRaw, projectProviderResultEvidenceView } from './result-facts.js';

const listing = { sites: [{ slug: 'alpha' }, { slug: 'beta' }], total_count: 2 };
const text = JSON.stringify(listing, null, 2);

test('a structured copy that wraps the text output in one key agrees with it', () => {
  for (const structuredContent of [{ result: text }, { result: listing }]) {
    const facts = deriveResultHandleFactsFromRaw({ content: [{ type: 'text', text }], structuredContent, isError: false });
    assert.equal(facts.success, true);
    assert.equal(facts.recordCount, 2);
    assert.equal(facts.recordPath, 'content.0.text.sites');
  }
  const view = projectProviderResultEvidenceView({ content: [{ type: 'text', text }], structuredContent: { result: text }, isError: false });
  assert.equal(view.kind, 'provider_payload');
});

test('a structured copy that says something else is still a conflict', () => {
  for (const structuredContent of [
    { result: JSON.stringify({ sites: [], total_count: 0 }) },
    { result: text, extra: true },
    { result: 'not the same text' },
  ]) {
    const facts = deriveResultHandleFactsFromRaw({ content: [{ type: 'text', text }], structuredContent, isError: false });
    assert.equal(facts.success, false, JSON.stringify(structuredContent).slice(0, 80));
  }
});

test('a structured copy equal to the text payload stays the authoritative one', () => {
  const facts = deriveResultHandleFactsFromRaw({ content: [{ type: 'text', text }], structuredContent: listing, isError: false });
  assert.equal(facts.success, true);
  assert.equal(facts.recordPath, 'structuredContent.sites');
});
