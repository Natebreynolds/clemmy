import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-static-update-'));
process.env.CLEMENTINE_HOME = home;
const store = await import('./store.js');
const db = await import('./workspace-db.js');
const receipts = await import('../runtime/harness/host-local-write-commit.js');
const projection = await import('./mobile-projection.js');
const carrier = await import('./workspace-set-data-carrier.js');
const contract = await import('./workspace-set-data-contract.js');

const eventlog = await import('../runtime/harness/eventlog.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');

test.after(() => { eventlog.closeEventLog(); db.closeWorkspaceDb(); rmSync(home, { recursive: true, force: true }); });
let ordinal = 0;
function fixture() {
  const slug = `static-update-${++ordinal}`;
  const document = {
    rows: [{ account: 'Southgate', status: 'On hold', note: 'waiting for parts' }, { account: 'Westfield', status: 'Ready', note: 'Thursday' }],
    _mobile: { records: { label: 'Accounts', items: [{ primary: 'Southgate', body: 'On hold: waiting for parts' }, { primary: 'Westfield', body: 'Ready: Thursday' }] } },
  };
  const view = '<!doctype html><html><body><p>Southgate: On hold, waiting for parts</p><p>Westfield: Ready, Thursday</p></body></html>';
  store.spaceStore.save({ id: slug, title: 'Accounts', viewContent: view, initialData: document });
  const before = store.spaceStore.snapshot(slug)!;
  const next = structuredClone(document);
  next.rows[0] = { account: 'Southgate', status: 'Ready', note: 'Parts arrived' };
  next._mobile.records.items[0] = { primary: 'Southgate', body: 'Ready: Parts arrived' };
  const nextView = view.replace('On hold, waiting for parts', 'Ready, Parts arrived');
  return { slug, before, next, nextView, input: { id: slug, title: 'Accounts', expectedRevision: before.revision, replacementData: next, viewContent: nextView } };
}
function bytes(slug: string) {
  return ['space.json', 'data.json', 'view/index.html', receipts.HOST_LOCAL_WORKSPACE_COMMIT_BASENAME]
    .map(file => readFileSync(store.resolveInSpace(slug, file), 'utf8'));
}
function updates(slug: string) {
  return db.openWorkspaceDb().prepare("SELECT count(*) AS n FROM workspace_dataset_observations WHERE workspace_id = ? AND cause = 'static_document_update'").get(slug) as { n: number };
}

test('existing static edit commits root data, mobile and view as one exact receipt and survives SQLite reopen', () => {
  const f = fixture();
  const result = store.spaceStore.replaceStaticDocument(f.input);
  assert.equal(result.record.version, 2);
  const after = store.spaceStore.snapshot(f.slug)!;
  assert.deepEqual(JSON.parse(after.data), f.next);
  assert.equal(after.view, f.nextView);
  assert.deepEqual(JSON.parse(after.data).rows[1], JSON.parse(f.before.data).rows[1]);
  assert.equal(Object.hasOwn(JSON.parse(after.data), 'manual'), false);
  assert.equal(projection.readAuthoredProjection(JSON.parse(after.data))?.records[0]?.body, 'Ready: Parts arrived');
  const facts = receipts.parseHostLocalWriteCommitFacts(result.commitResult)!;
  const content = receipts.readCommittedArtifactContent(facts);
  assert.equal(content.verified, true);
  assert.deepEqual(content.parts.map(part => part.role), ['manifest', 'view', 'data']);
  db.closeWorkspaceDb();
  assert.equal(store.spaceStore.snapshot(f.slug)?.revision, after.revision);
  assert.equal(receipts.readCommittedArtifactContent(facts).verified, true);
  assert.equal(updates(f.slug).n, 1);
});

for (const phase of ['journal_written', 'projection_written', 'files_prepared', 'before_sqlite_commit'] as const) {
  test(`failure at ${phase} restores exact prior bytes and no committed update`, () => {
    const f = fixture(); const before = bytes(f.slug);
    assert.throws(() => store.spaceStore.replaceStaticDocument({ ...f.input, onPhase(at) { if (at === phase) throw new Error('injected update failure'); } }), /injected/);
    assert.deepEqual(bytes(f.slug), before);
    assert.equal(store.spaceStore.snapshot(f.slug)?.revision, f.before.revision);
    assert.equal(updates(f.slug).n, 0);
    assert.equal(existsSync(store.resolveInSpace(f.slug, '.clementine-workspace-update.json')), false);
  });
}

test('same-owner proof read does not mistake its uncommitted journal for a crashed writer', () => {
  const f = fixture(); let inspected = false;
  const result = store.spaceStore.replaceStaticDocument({ ...f.input, onPhase(at) {
    if (at !== 'files_prepared') return;
    inspected = true;
    assert.equal(JSON.parse(store.spaceStore.snapshot(f.slug)!.data).rows[0].status, 'Ready');
    assert.throws(() => store.spaceStore.save({ id: f.slug, title: 'Nested writer' }), /not reentrant/);
  } });
  assert.equal(inspected, true);
  assert.equal(receipts.readCommittedArtifactContent(receipts.parseHostLocalWriteCommitFacts(result.commitResult)!).verified, true);
  assert.equal(updates(f.slug).n, 1);
});

test('failure after SQLite commit recovers that generation without repeating the observation', () => {
  const f = fixture();
  const result = store.spaceStore.replaceStaticDocument({ ...f.input, onPhase(at) { if (at === 'after_sqlite_commit') throw new Error('lost return'); } });
  assert.equal(JSON.parse(store.spaceStore.snapshot(f.slug)!.data).rows[0].status, 'Ready');
  assert.equal(receipts.readCommittedArtifactContent(receipts.parseHostLocalWriteCommitFacts(result.commitResult)!).verified, true);
  assert.equal(updates(f.slug).n, 1);
  db.closeWorkspaceDb(); store.spaceStore.snapshot(f.slug);
  assert.equal(updates(f.slug).n, 1);
});

test('stale snapshot and source-backed target refuse without changing the current generation', () => {
  const f = fixture(); store.spaceStore.replaceStaticDocument(f.input);
  const current = bytes(f.slug);
  assert.throws(() => store.spaceStore.replaceStaticDocument(f.input), /changed since it was read/);
  assert.deepEqual(bytes(f.slug), current); assert.equal(updates(f.slug).n, 1);
  const slug = `dynamic-update-${++ordinal}`;
  store.spaceStore.save({ id: slug, title: 'Dynamic', viewContent: '<html>Dynamic</html>' });
  const snapshot = store.spaceStore.snapshot(slug)!;
  assert.throws(() => store.spaceStore.replaceStaticDocument({ ...f.input, id: slug, expectedRevision: snapshot.revision }), /existing active static/);
  assert.equal(store.spaceStore.snapshot(slug)?.revision, snapshot.revision);
});

for (const phase of ['projection_written', 'before_sqlite_commit', 'after_sqlite_commit'] as const) {
  test(`process death at ${phase} reopens the SQLite-decided generation once`, () => {
    const f = fixture(); const prior = bytes(f.slug);
    // Canonical blobs sort 10 before 2, but the real JSON projection orders
    // integer keys numerically. A death at projection_written must still name
    // exactly one journal generation, never an unrecognized third byte string.
    const replacement = { ...f.next, numeric: { '2': 'b', '10': 'a', '01': 'c' } };
    const input = { ...f.input, replacementData: replacement };
    const script = path.join(home, `crash-${f.slug}.mjs`);
    const profileFile = path.join(home, `profile-${f.slug}.json`);
    writeFileSync(script, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(profileFile)}, JSON.stringify({execPath:process.execPath,version:process.version,home:process.env.CLEMENTINE_HOME,isolated:process.env.CLEMMY_TEST_ISOLATED_HOME,pid:process.pid})); const store = await import(${JSON.stringify(new URL('./store.ts', import.meta.url).href)});\nstore.spaceStore.replaceStaticDocument({...${JSON.stringify(input)}, onPhase(at) { if(at===${JSON.stringify(phase)}) process.kill(process.pid,'SIGKILL'); }});`);
    const child = spawnSync(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, CLEMENTINE_HOME: home }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const profile = JSON.parse(readFileSync(profileFile, 'utf8'));
    assert.equal(profile.execPath, process.execPath);
    assert.equal(profile.version, process.version);
    assert.equal(profile.home, home);
    assert.equal(profile.isolated, process.env.CLEMMY_TEST_ISOLATED_HOME);
    assert.ok(profile.pid !== process.pid);
    assert.throws(() => process.kill(profile.pid, 0), { code: 'ESRCH' }, 'the exact diagnostic process has exited');
    assert.equal(existsSync(store.resolveInSpace(f.slug, '.clementine-workspace-update.json')), true);
    db.closeWorkspaceDb();
    const reopened = store.spaceStore.snapshot(f.slug)!;
    if (phase !== 'after_sqlite_commit') {
      assert.deepEqual(bytes(f.slug), prior); assert.equal(reopened.revision, f.before.revision); assert.equal(updates(f.slug).n, 0);
    } else {
      assert.deepEqual(JSON.parse(reopened.data), replacement); assert.equal(reopened.view, f.nextView); assert.equal(updates(f.slug).n, 1);
    }
    const again = store.spaceStore.snapshot(f.slug)!;
    assert.equal(again.revision, reopened.revision);
    assert.equal(existsSync(store.resolveInSpace(f.slug, '.clementine-workspace-update.json')), false);
  });
}

test('current byte drift is a failed receipt, not a reason to replay or repair a cleared commit', () => {
  const f = fixture(); const result = store.spaceStore.replaceStaticDocument(f.input);
  const facts = receipts.parseHostLocalWriteCommitFacts(result.commitResult)!;
  writeFileSync(store.resolveInSpace(f.slug, 'data.json'), '{"owner_changed":true}');
  assert.equal(receipts.readCommittedArtifactContent(facts).verified, false);
  assert.equal(store.spaceStore.snapshot(f.slug)?.data, '{"owner_changed":true}');
  assert.equal(updates(f.slug).n, 1);
});

test('manual and reviewed source writes keep source identity and carry whole-file proof at their own commit edge', async () => {
  const slug = `source-proof-${++ordinal}`;
  store.spaceStore.save({ id: slug, title: 'Sources', viewContent: '<html>Sources</html>' });
  const args = { slug, source_id: 'deals', data_json: JSON.stringify([{ id: 'one', state: 'Ready' }]) };
  const reviewed = await carrier.executeReviewedWorkspaceSetData(args);
  assert.ok(reviewed.handle.endsWith('#source=deals'));
  assert.equal(reviewed.contentDigest, contract.workspaceDataContentDigest(JSON.parse(args.data_json)));
  const encoded = contract.workspaceDatasetHostFileCommit(JSON.stringify(reviewed));
  const facts = receipts.parseHostLocalWriteCommitFacts(encoded)!;
  assert.equal(facts.handle, `spaces/${slug}/data.json`);
  assert.equal(receipts.readCommittedArtifactContent(facts).verified, true);
  const manual = await carrier.executeManualWorkspaceSetData({ ...args, data_json: '[{"id":"one","state":"Changed"}]' });
  assert.ok(manual.hostFileCommit);
  assert.equal(receipts.readCommittedArtifactContent(facts).verified, false);
  const replay = await carrier.executeReviewedWorkspaceSetData(args);
  assert.equal(replay.created, false);
  assert.equal(replay.hostFileCommit, undefined, 'historical source receipt cannot vouch for fresh unrelated file bytes');
  assert.equal(contract.workspaceDatasetHostFileCommit({ arbitrary: reviewed.hostFileCommit }), undefined);
});

test('native producers expose complete selected data and one legitimate static update, while duplicate create stays refused', async () => {
  const { registerSpaceTools } = await import('../tools/space-tools.js');
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  registerSpaceTools({ tool(name: string, _description: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>) { handlers.set(name, handler); } } as never);
  const f = fixture();
  // The real native producer previously destroyed everything after 1,500
  // characters before recall storage had an opportunity to retain it.
  const current = JSON.parse(f.before.data); current.padding = 'x'.repeat(30_000); current.zz_tail = 'complete-selected-data';
  store.spaceStore.replaceStaticDocument({ ...f.input, replacementData: current, viewContent: f.before.view });
  const session = eventlog.createSession({ kind: 'chat' });
  const callId = 'space-complete-retained-read'; const nonce = randomUUID();
  const get = await withToolOutputContext({ sessionId: session.id, callId, toolName: 'space_get', settlementNonce: nonce }, () => handlers.get('space_get')!({ slug: f.slug }));
  const visible = get.content.map(part => part.text).join('\n');
  assert.ok(visible.length <= 20_000);
  assert.match(visible, /recall_tool_result/);
  assert.match(visible, /exact-output-receipt:v1/);
  const retained = eventlog.getToolOutputForInvocation(session.id, callId, nonce);
  assert.ok(retained); assert.equal(retained.truncatedAtWrite, false);
  const readText = retained.output;
  assert.ok(readText.length > 30_000);
  assert.ok(visible.length < readText.length, 'the model projection is bounded even though its head/tail can include the final record');
  assert.ok(readText.includes(store.spaceStore.snapshot(f.slug)!.data), 'the complete raw saved JSON reaches retention before model projection');
  eventlog.closeEventLog();
  assert.equal(eventlog.getToolOutput(session.id, callId)?.output, readText);
  const { registerRecallTools } = await import('../tools/recall-tools.js');
  const { withHarnessRunContext, ToolCallsCounter, RecallBudget } = await import('../runtime/harness/brackets.js');
  registerRecallTools({ tool(name: string, ...args: unknown[]) { handlers.set(name, args.at(-1) as never); } } as never);
  const recovered = await withHarnessRunContext({ sessionId: session.id, counter: new ToolCallsCounter(4), recallBudget: new RecallBudget(2, 60_000) }, () => handlers.get('recall_tool_result')!({ call_id: callId, offset: readText.indexOf('complete-selected-data') - 20, max_chars: 1000 }));
  assert.match(recovered.content.map(part => part.text).join('\n'), /complete-selected-data/);
  const other = eventlog.createSession({ kind: 'chat' });
  const unrelated = await withHarnessRunContext({ sessionId: other.id, counter: new ToolCallsCounter(4), recallBudget: new RecallBudget(2, 60_000) }, () => handlers.get('recall_tool_result')!({ call_id: callId, offset: readText.indexOf('complete-selected-data') - 20, max_chars: 1000 }));
  assert.doesNotMatch(unrelated.content.map(part => part.text).join('\n'), /complete-selected-data/);
  assert.match(readText, /complete-selected-data/);
  assert.match(readText, /Dataset \(complete JSON\)/);
  const revision = /Snapshot revision: ([a-f0-9]{64})/.exec(readText)?.[1];
  assert.ok(revision);
  const beforeRefusal = bytes(f.slug);
  const duplicate = await handlers.get('space_save')!({ slug: f.slug, title: 'Accounts', view_html: f.nextView, initial_data_json: JSON.stringify(f.next) });
  assert.match(duplicate.content.map(part => part.text).join('\n'), /already exists.*does not exactly match/s);
  assert.deepEqual(bytes(f.slug), beforeRefusal);
  const changed = structuredClone(current); changed.rows = f.next.rows; changed._mobile = f.next._mobile;
  const update = await handlers.get('space_save')!({ slug: f.slug, title: 'Accounts', view_html: f.nextView, replacement_data_json: JSON.stringify(changed), expected_revision: revision });
  const resultText = update.content.map(part => part.text).join('\n');
  assert.equal(update.isError, undefined, resultText);
  const facts = receipts.parseHostLocalWriteCommitFacts(resultText);
  assert.ok(facts, resultText);
  assert.equal(receipts.readCommittedArtifactContent(facts).verified, true);
  assert.deepEqual(JSON.parse(store.spaceStore.snapshot(f.slug)!.data), changed);
  assert.equal(updates(f.slug).n, 2, 'one setup edit and one actual native replacement, no duplicate-create effect');
});


test('an oversized recovery journal refuses before any update or history effect', () => {
  const f = fixture(); const prior = bytes(f.slug);
  const historyBefore = db.openWorkspaceDb().prepare('SELECT count(*) AS n FROM workspace_dataset_observations WHERE workspace_id = ?').get(f.slug);
  // A legacy view_path can hold more than the inline HTML limit. JSON escaping
  // is part of the durable journal size, not merely the input character count.
  assert.throws(() => store.spaceStore.replaceStaticDocument({ ...f.input, viewContent: '\"'.repeat(4_100_000) }), /cannot fit its durable recovery journal/);
  assert.deepEqual(bytes(f.slug), prior);
  assert.deepEqual(db.openWorkspaceDb().prepare('SELECT count(*) AS n FROM workspace_dataset_observations WHERE workspace_id = ?').get(f.slug), historyBefore);
  assert.equal(existsSync(store.resolveInSpace(f.slug, '.clementine-workspace-update.json')), false);
});

test('one invalid recovery journal leaves unrelated Spaces listable without presenting the broken snapshot', () => {
  const broken = fixture(); const healthy = fixture();
  writeFileSync(store.resolveInSpace(broken.slug, '.clementine-workspace-update.json'), '{"version":1}');
  assert.throws(() => store.spaceStore.snapshot(broken.slug), /Invalid Workspace update recovery journal/);
  const listed = store.spaceStore.list();
  assert.ok(listed.some(record => record.id === healthy.slug));
  assert.ok(!listed.some(record => record.id === broken.slug));
});
