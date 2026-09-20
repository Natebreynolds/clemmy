import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankCatalogEntriesLexically } from './tool-catalog.js';

test('plural query forms retain the same relevance as singular catalog concepts', () => {
  const entries = [
    { name: 'LOCAL_READ', oneLiner: 'Read local file content and directory entry.' },
    { name: 'CLOUD_APPEND', oneLiner: 'Append spreadsheet values and verify the resulting range.' },
  ];
  assert.deepEqual(
    rankCatalogEntriesLexically('read local files contents and directories entries', entries),
    rankCatalogEntriesLexically('read local file content and directory entry', entries),
  );
});

test('plural relevance does not rewrite operation identity or provider namespace selection', () => {
  const entries = [
    { name: 'ATLAS_DOCS_READ', namespace: 'atlasdocs', oneLiner: 'Read documents.' },
    { name: 'ATLAS_DOC_READ', namespace: 'atlasdoc', oneLiner: 'Read a document.' },
  ];
  const ranked = rankCatalogEntriesLexically('Atlas Docs read documents', entries);
  assert.equal(ranked.find(row => row.name === 'ATLAS_DOCS_READ')?.namespaceMatch, true);
  assert.equal(ranked.find(row => row.name === 'ATLAS_DOC_READ')?.namespaceMatch, false);
  assert.deepEqual(new Set(ranked.map(row => row.name)), new Set(entries.map(row => row.name)));
});
