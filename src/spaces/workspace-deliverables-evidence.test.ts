import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-deliverables-evidence-'));
process.env.CLEMENTINE_HOME = home;
process.env.EMBEDDINGS_DISABLED = 'true';
const { spaceStore, resolveInSpace } = await import('./store.js');
const { commitWorkspaceObservationBatch, closeWorkspaceDb, getCurrentWorkspaceDatasetObservation } = await import('./workspace-db.js');
const { captureWorkspaceDeliverablesEvidence, safeWorkspaceEvidenceUrl } = await import('./workspace-deliverables-evidence.js');
type Packet = ReturnType<typeof captureWorkspaceDeliverablesEvidence>;
after(() => { closeWorkspaceDb(); rmSync(home, { recursive: true, force: true }); });

const html = '<!doctype html><html><body><h1>Operations</h1><p>A saved dashboard.</p></body></html>';
function fixture(slug: string, options: { data?: Record<string, unknown>; source?: boolean; view?: string } = {}) {
  const record = spaceStore.save({ id: slug, title: 'Evidence fixture', viewContent: options.view ?? html,
    ...(options.source ? { dataSources: [{ id: 'status', composioSlug: 'EXAMPLE_LIST_RECORDS' }] } : {}),
    ...(options.data ? { initialData: options.data } : {}),
  });
  return { record, root: path.join(home, 'spaces', slug), view: options.view ?? html };
}
function fact(packet: Packet, id: string) {
  assert.equal(packet.status, 'available', JSON.stringify(packet));
  const found = packet.facts.find(item => item.id === id);
  assert.ok(found, `missing ${id}`);
  return found;
}
function detail(packet: Packet, id: string): Record<string, any> {
  return fact(packet, id).detail as Record<string, any>;
}
function observe(slug: string, refreshId: string, status: 'ok' | 'error' | 'awaiting_approval', data?: unknown) {
  return commitWorkspaceObservationBatch({ workspaceId: slug, observations: [{ sourceKey: 'status', refreshId,
    cause: 'manual', status, ...(status === 'ok' ? { data } : { error: 'Controlled refresh problem.' }),
    provenance: { adapter: 'controlled', accountRef: 'private-account', requestId: 'private-request' },
  }] }).observations[0]!;
}

test('snapshot facts bind the saved generation without promoting static authored data or similarly named links to deployment proof', () => {
  const view = '<!doctype html><html><body><h1>Site &amp; backend</h1>'
    + '<a href="https://github.example.test/team/same-site?token=fixture-secret#private">Repository</a>'
    + '<a href="https://deploy.example.test/project/same-site">Deployment</a>'
    + '<script>const privateToken="script-secret";</script><style>.x{content:"style-secret"}</style>'
    + '<template>template-secret</template><p hidden>hidden-secret</p></body></html>';
  const { record } = fixture('saved-content', { view, data: { records: [{ title: 'One authored item' }] } });
  const packet = captureWorkspaceDeliverablesEvidence(record, view, []);
  assert.equal(packet.status, 'available');
  if (packet.status !== 'available') return;
  assert.equal(packet.snapshot.revision, spaceStore.snapshot(record.id)!.revision);
  assert.equal(packet.snapshot.dataSha256, createHash('sha256').update(readFileSync(resolveInSpace(record.id, 'data.json'))).digest('hex'));
  assert.equal(detail(packet, 'dataset-1').state, 'stored_unverified');
  assert.deepEqual(fact(packet, 'dataset-1').supports, ['saved_content']);
  assert.deepEqual(detail(packet, 'saved-links').links, [
    { destination: 'https://github.example.test/team/same-site' },
    { destination: 'https://deploy.example.test/project/same-site' },
  ]);
  assert.match(detail(packet, 'saved-view').text, /Site & backend/);
  assert.doesNotMatch(JSON.stringify(packet), /fixture-secret|script-secret|style-secret|template-secret|hidden-secret/);
  assert.ok(packet.unavailableEvidence.includes('deployment_relationship'));
  assert.ok(packet.facts.every(item => !item.supports.includes('deployment_relationship')));
  assert.equal(captureWorkspaceDeliverablesEvidence(record, view, []).fingerprint, packet.fingerprint, 'identical recapture has no clock drift');
});

test('current exact successful observation supports only data readback; provenance values stay private', () => {
  const { record } = fixture('current-success', { source: true });
  const current = observe(record.id, 'first', 'ok', [{ id: 'row-a', value: 4 }, { id: 'row-b', value: 8 }]);
  const packet = captureWorkspaceDeliverablesEvidence(record, html, []);
  const data = detail(packet, 'dataset-1');
  assert.equal(data.state, 'readback');
  assert.equal(data.summary.count, 2);
  assert.deepEqual(data.summary.fields, ['id', 'value']);
  assert.equal(data.observation.id, current.id);
  assert.equal(data.observation.contentMatches, true);
  assert.ok(fact(packet, 'dataset-1').supports.includes('data_readback'));
  assert.equal(data.providerAccountVerified, false);
  assert.equal(data.providerExecutionVerified, false);
  assert.doesNotMatch(JSON.stringify(packet), /private-account|private-request/);
});

test('latest failure and approval preserve old displayed data but cannot inherit its readback success; a proven empty refresh is distinct', () => {
  const { record } = fixture('failure-after-success', { source: true });
  const old = observe(record.id, 'success', 'ok', [{ id: 1 }]);
  observe(record.id, 'failure', 'error');
  assert.equal(getCurrentWorkspaceDatasetObservation(record.id, 'status')!.id, old.id, 'ledger intentionally retains old successful data');
  const failed = captureWorkspaceDeliverablesEvidence(record, html, []);
  assert.equal(detail(failed, 'dataset-1').state, 'failed');
  assert.ok(!fact(failed, 'dataset-1').supports.includes('data_readback'));
  observe(record.id, 'pending', 'awaiting_approval');
  const pending = captureWorkspaceDeliverablesEvidence(record, html, []);
  assert.equal(detail(pending, 'dataset-1').state, 'awaiting_approval');
  assert.ok(!fact(pending, 'dataset-1').supports.includes('data_readback'));
  observe(record.id, 'empty', 'ok', []);
  const empty = captureWorkspaceDeliverablesEvidence(record, html, []);
  assert.equal(detail(empty, 'dataset-1').state, 'empty_success');
  assert.equal(detail(empty, 'dataset-1').summary.count, 0);
  assert.ok(fact(empty, 'dataset-1').supports.includes('data_readback'));
  assert.notEqual(empty.fingerprint, failed.fingerprint);
});

test('stored content with mismatched observation bytes is unverified, and disabled feed configuration proves no execution', () => {
  const { record } = fixture('mismatched-content', { source: true });
  observe(record.id, 'observed', 'ok', [{ id: 'original' }]);
  const dataFile = resolveInSpace(record.id, 'data.json');
  const data = JSON.parse(readFileSync(dataFile, 'utf8'));
  data.status = [{ id: 'unobserved' }];
  writeFileSync(dataFile, JSON.stringify(data));
  const packet = captureWorkspaceDeliverablesEvidence(record, html, [{ workflow: 'Disabled feed', collections: ['status', 'missing'], enabled: false }]);
  assert.equal(detail(packet, 'dataset-1').state, 'stored_unverified');
  assert.equal(detail(packet, 'dataset-1').observation.contentMatches, false);
  assert.equal(detail(packet, 'dataset-2').state, 'absent');
  assert.deepEqual(fact(packet, 'feed-1').supports, ['configuration']);
  assert.equal(detail(packet, 'feed-1').enabled, false);
  assert.equal(detail(packet, 'feed-1').executionVerified, false);
});

test('absent and corrupt data never become a successful empty dataset', () => {
  const { record } = fixture('absent-data', { source: true });
  const absent = captureWorkspaceDeliverablesEvidence(record, html, []);
  assert.equal(detail(absent, 'dataset-1').state, 'absent');
  assert.equal(absent.snapshot?.dataState, 'absent');
  assert.equal(absent.snapshot?.dataSha256, null);
  assert.equal(absent.snapshot?.revision, spaceStore.snapshot(record.id)!.revision);
  writeFileSync(resolveInSpace(record.id, 'data.json'), '{not JSON');
  const corrupt = captureWorkspaceDeliverablesEvidence(record, html, []);
  assert.equal(corrupt.snapshot?.dataState, 'unreadable');
  assert.equal(detail(corrupt, 'dataset-1').state, 'unreadable');
  assert.ok(!fact(corrupt, 'dataset-1').supports.includes('data_readback'));
});

test('candidate source, view or manifest drift cannot certify a different saved generation', () => {
  const { record } = fixture('snapshot-drift', { data: { count: 1 } });
  const changed = { ...record, title: 'A different authoring request' };
  assert.equal(captureWorkspaceDeliverablesEvidence(changed, html, []).status, 'unavailable');
  const manifestFile = resolveInSpace(record.id, 'space.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  writeFileSync(manifestFile, JSON.stringify({ ...manifest, futureAuthoringField: 'must remain exact' }));
  assert.equal(captureWorkspaceDeliverablesEvidence(record, html, []).status, 'unavailable', 'new authoring fields cannot escape the existing shared manifest boundary');
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const operationalChange = { ...manifest, updatedAt: '2026-10-16T09:00:00.000Z', lastOpenedAt: '2026-10-16T09:00:00.000Z' };
  writeFileSync(manifestFile, JSON.stringify(operationalChange));
  assert.equal(captureWorkspaceDeliverablesEvidence(record, html, []).status, 'available', 'ordinary upkeep does not replace the authoring surface');
  writeFileSync(resolveInSpace(record.id, record.viewEntry), html + '<p>newer bytes</p>');
  assert.equal(captureWorkspaceDeliverablesEvidence(record, html, []).status, 'unavailable');
  writeFileSync(resolveInSpace(record.id, 'space.json'), '{bad JSON');
  const packet = captureWorkspaceDeliverablesEvidence(record, html, []);
  assert.equal(packet.status, 'unavailable');
  assert.deepEqual(packet.facts, []);
});

test('unmanaged symlink components cannot expose files outside the saved Workspace', () => {
  const { record } = fixture('outside-component');
  const dataFile = resolveInSpace(record.id, 'data.json');
  const outside = path.join(home, 'private.json');
  writeFileSync(outside, '{"private":"must-not-leak"}');
  symlinkSync(outside, dataFile);
  const packet = captureWorkspaceDeliverablesEvidence(record, html, []);
  assert.doesNotMatch(JSON.stringify(packet), /must-not-leak/);
  assert.equal(packet.snapshot?.dataState, 'unreadable');
});

test('HTML evidence is bounded and unsafe URLs are omitted without executing or exposing capabilities', () => {
  assert.equal(safeWorkspaceEvidenceUrl('https://user:password@example.test/team/repo?access_token=secret#private'), 'https://example.test/team/repo');
  for (const url of ['javascript:alert(1)', 'file:///private/secret', 'http://localhost/api/console',
    'https://example.test/viewer/unguessable', 'https://example.test/public/a8a8a8a8a8a8a8a8a8a8a8a8a8a8',
    'https://example.test/public/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
    'https://example.test/capability/some-value']) assert.equal(safeWorkspaceEvidenceUrl(url), null);
  const view = '<body><p>' + 'word '.repeat(2_000) + '</p>'
    + Array.from({ length: 30 }, (_, index) => `<a href="https://example.test/page-${index}?secret=omit">item</a>`).join('')
    + '<a href="https://example.test/viewer/private">secret link</a></body>';
  const { record } = fixture('bounded-evidence', { view });
  const packet = captureWorkspaceDeliverablesEvidence(record, view, []);
  assert.equal(packet.truncation.text, true);
  assert.equal(packet.truncation.links, true);
  assert.equal(detail(packet, 'saved-links').links.length, 24);
  assert.equal(detail(packet, 'saved-links').omittedUnsafeLinks, 1);
  assert.equal(detail(packet, 'saved-view').text.length, 6_000);
  assert.doesNotMatch(JSON.stringify(packet), /secret=omit|viewer\/private/);
  const omittedView = '<body><a href="https://example.test/viewer/private">Private viewer</a></body>';
  const omitted = fixture('omitted-link-evidence', { view: omittedView });
  const omittedPacket = captureWorkspaceDeliverablesEvidence(omitted.record, omittedView, []);
  assert.equal(omittedPacket.truncation.links, true, 'privacy omission cannot establish absence of required links');
  assert.equal(detail(omittedPacket, 'saved-links').omittedUnsafeLinks, 1);
});
