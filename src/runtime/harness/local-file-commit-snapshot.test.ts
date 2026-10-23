import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clem-file-commit-snapshot-')));
const base = path.join(home, 'clem');
const workspace = path.join(home, 'workspace');
fs.mkdirSync(base); fs.mkdirSync(workspace);
process.env.CLEMENTINE_HOME = base;
process.env.WORKSPACE_DIRS = workspace;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const files = await import('./local-file-revision.js');
const proof = await import('./host-local-write-commit.js');
const observations = await import('./local-file-observation.js');
const { withToolOutputContext } = await import('./tool-output-context.js');
const { executeLocalFileWrite, getComputerTools } = await import('../../tools/computer-tools.js');
const eventlog = await import('./eventlog.js');
const memory = await import('../../memory/db.js');
await import('../../memory/deliverable-index.js');
after(() => { eventlog.closeEventLog(); memory.closeMemoryDb(); fs.rmSync(home, { recursive: true, force: true }); });
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const originalRead = fs.readFileSync;
const originalWrite = fs.writeFileSync;
type ReadTool = { invoke: (...args: any[]) => Promise<unknown> };
const readTool = getComputerTools().find(tool => tool.name === 'read_file') as unknown as ReadTool;

test('actual file body keeps its own receipt when B commits at the post-lock observation-write boundary', async (t) => {
  const sid = eventlog.createSession({ kind: 'chat', channel: 'desktop', title: 'FRAMEWORK-TEST-snapshot-body' }).id;
  const target = path.join(workspace, 'body.txt');
  fs.writeFileSync(target, 'base\n'); fs.chmodSync(target, 0o640);
  await withToolOutputContext({ sessionId: sid, sourceUserSeq: 1, callId: 'read-base', toolName: 'read_file' },
    () => readTool.invoke({ context: { sessionId: sid } }, JSON.stringify({ path: target, max_chars: null })));
  const aKey = JSON.stringify({ sessionId: sid, sourceUserSeq: 1, acceptedTaskId: 'fixture-A', logicalToolCallId: 'write-A' });
  const bKey = JSON.stringify({ sessionId: 'fixture-B', sourceUserSeq: 2, acceptedTaskId: 'fixture-B', logicalToolCallId: 'write-B' });
  const dir = path.join(base, 'state/local-file-revisions', digest(target));
  const current = path.join(dir, 'current.json');
  const observation = path.join(base, 'state/local-file-observations', digest(target), `${digest(sid)}.json`);
  let injected = 0;
  let cutError: unknown;
  let descriptorA: Buffer | undefined;
  let descriptorB: Buffer | undefined;
  let mutableTargetReads = 0;
  const readHook = t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (file === target && args.length === 0) mutableTargetReads += 1;
    return originalRead(file, ...args as []);
  });
  const writeHook = t.mock.method(fs, 'writeFileSync', function (file, ...args) {
    // This is the real observation's atomic write, after the revision lock.
    // It remains present when the authority-bearing target reread is removed.
    if (typeof file === 'string' && file.startsWith(`${observation}.`) && file.endsWith('.tmp') && !injected) {
      injected += 1;
      try {
        assert.equal(fs.existsSync(`${current}.lock`), false);
        descriptorA = originalRead(path.join(dir, `operation-${digest(aKey)}.json`));
        assert.deepEqual(originalRead(current), descriptorA);
        assert.equal(originalRead(target, 'utf8'), 'A\n');
        const b = files.commitLocalFileRevision({ target, content: 'B', mode: 'append',
          expectedContentDigest: digest('A\n'), operationKey: bKey });
        descriptorB = originalRead(path.join(dir, `operation-${digest(bKey)}.json`));
        assert.deepEqual(originalRead(current), descriptorB);
        assert.equal(originalRead(b.previousPath!, 'utf8'), 'A\n');
      } catch (error) { cutError = error; }
    }
    return originalWrite(file, ...args as [any, any]);
  });
  syncBuiltinESMExports();
  let result: unknown;
  try {
    result = await withToolOutputContext({ sessionId: sid, sourceUserSeq: 1, callId: 'write-A', toolName: 'write_file' },
      () => executeLocalFileWrite({ path: target, content: 'A', mode: 'overwrite', append: null, find: null },
        { preserveCreateConflict: true, operationKey: aKey }));
  } finally {
    writeHook.mock.restore(); readHook.mock.restore(); syncBuiltinESMExports();
  }
  if (cutError) throw cutError;
  assert.equal(injected, 1);
  assert.ok(descriptorA && descriptorB);
  assert.notDeepEqual(descriptorA, descriptorB);
  const factsA = proof.parseHostLocalWriteCommitFacts(result);
  assert.ok(factsA);
  assert.equal(factsA.contentDigest, digest(descriptorA), 'A must not stamp B as its own committed descriptor');
  assert.equal(proof.readCommittedArtifactContent(factsA).verified, false, 'A is committed but superseded, not currently verified');
  const factsB = proof.parseHostLocalWriteCommitFacts(proof.withHostLocalWriteCommitFromFile({ createdId: factsA.createdId,
    committedPath: current, result: 'B current' }))!;
  assert.equal(factsB.contentDigest, digest(descriptorB));
  assert.equal(proof.readCommittedArtifactContent(factsB).verified, true);
  assert.equal(mutableTargetReads, 0, 'the write observation must not reopen the target after commit');
  assert.equal(observations.observedLocalFileBase({ sessionId: sid, target })?.contentDigest, digest('A\n'));
  const stored = JSON.parse(originalRead(observation, 'utf8'));
  assert.equal(stored.sourceUserSeq, 1); assert.equal(stored.callId, 'write-A');
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  const later = await withToolOutputContext({ sessionId: sid, sourceUserSeq: 3, callId: 'write-later', toolName: 'write_file' },
    () => executeLocalFileWrite({ path: target, content: 'later', mode: 'overwrite', append: null, find: null }));
  assert.equal(proof.parseHostLocalWriteCommitFacts(later), null);
  assert.equal(originalRead(target, 'utf8'), 'A\nB\n', 'unseen B must survive a later stale overwrite');
  await withToolOutputContext({ sessionId: sid, sourceUserSeq: 3, callId: 'read-B', toolName: 'read_file' },
    () => readTool.invoke({ context: { sessionId: sid } }, JSON.stringify({ path: target, max_chars: null })));
  const reconciled = await withToolOutputContext({ sessionId: sid, sourceUserSeq: 3, callId: 'write-reconciled', toolName: 'write_file' },
    () => executeLocalFileWrite({ path: target, content: 'reconciled', mode: 'overwrite', append: null, find: null }));
  assert.ok(proof.parseHostLocalWriteCommitFacts(reconciled));
  assert.equal(originalRead(target, 'utf8'), 'reconciled\n');
});

test('the locked storage snapshot retains A bytes and descriptor after B and cannot be forged or mutated by its reader', () => {
  const target = path.join(workspace, 'storage.txt');
  const a = files.commitLocalFileRevision({ target, content: 'A', mode: 'create', operationKey: 'storage-A' });
  const descriptorA = originalRead(a.committedPath);
  const b = files.commitLocalFileRevision({ target, content: 'B', mode: 'overwrite',
    expectedContentDigest: digest('A\n'), operationKey: 'storage-B' });
  assert.equal(typeof files.getLocalFileRevisionSnapshot, 'function', 'store returns an exact owned snapshot');
  const snapshot = files.getLocalFileRevisionSnapshot(a);
  assert.equal(snapshot.target, target);
  assert.deepEqual(snapshot.descriptorBytes, descriptorA);
  assert.equal(snapshot.contentBytes.toString(), 'A\n');
  snapshot.descriptorBytes.fill(0); snapshot.contentBytes.fill(0);
  const retained = files.getLocalFileRevisionSnapshot(a);
  assert.deepEqual(retained.descriptorBytes, descriptorA);
  assert.equal(retained.contentBytes.toString(), 'A\n');
  const factsA = proof.parseHostLocalWriteCommitFacts(proof.withHostLocalFileRevisionCommit({ revision: a, result: 'A' }))!;
  const factsB = proof.parseHostLocalWriteCommitFacts(proof.withHostLocalFileRevisionCommit({ revision: b, result: 'B' }))!;
  assert.equal(factsA.contentDigest, digest(descriptorA));
  assert.equal(proof.readCommittedArtifactContent(factsA).verified, false);
  assert.equal(proof.readCommittedArtifactContent(factsB).verified, true);
  assert.throws(() => proof.withHostLocalFileRevisionCommit({ revision: { ...a }, result: 'forged' }), /captured local file revision/);
  assert.throws(() => files.getLocalFileRevisionSnapshot({ ...a }), /captured local file revision/);
});

test('recovery captures the exact frozen operation without target retry and never relabels a later B revision', (t) => {
  const target = path.join(workspace, 'recovery.txt');
  fs.writeFileSync(target, 'before\n'); fs.chmodSync(target, 0o600);
  const input = { target, content: 'A', mode: 'append' as const, expectedContentDigest: digest('before\n'), operationKey: 'recover-A' };
  const a = files.commitLocalFileRevision(input);
  const descriptorA = originalRead(a.committedPath);
  const before = fs.statSync(target);
  let targetPublicationCount = 0;
  const originalRename = fs.renameSync, originalLink = fs.linkSync;
  const renameHook = t.mock.method(fs, 'renameSync', (from, to) => { if (to === target) targetPublicationCount++; return originalRename(from, to); });
  const linkHook = t.mock.method(fs, 'linkSync', (from, to) => { if (to === target) targetPublicationCount++; return originalLink(from, to); });
  syncBuiltinESMExports();
  let recovered: ReturnType<typeof files.recoverLocalFileRevision>;
  try {
    // A recomputed observation now differs, but the operation's frozen base wins.
    recovered = files.recoverLocalFileRevision({ ...input, expectedContentDigest: digest('before\nA\n') });
    assert.throws(() => files.recoverLocalFileRevision({ ...input, operationKey: 'wrong' }), files.LocalFileRevisionConflict);
    assert.throws(() => files.recoverLocalFileRevision({ ...input, content: 'changed request' }), files.LocalFileRevisionConflict);
  } finally { renameHook.mock.restore(); linkHook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(targetPublicationCount, 0);
  const after = fs.statSync(target);
  assert.deepEqual([after.ino, after.mtimeMs, after.size, after.mode], [before.ino, before.mtimeMs, before.size, before.mode]);
  assert.equal(recovered.unchanged, true);
  assert.equal(typeof files.getLocalFileRevisionSnapshot, 'function', 'recovery also returns an exact owned snapshot');
  const captured = files.getLocalFileRevisionSnapshot(recovered);
  assert.deepEqual(captured.descriptorBytes, descriptorA);
  assert.equal(captured.contentBytes.toString(), 'before\nA\n');
  const saved = JSON.parse(captured.descriptorBytes.toString());
  assert.equal(saved.operation.expectedContentDigest, digest('before\n'));
  assert.equal(originalRead(recovered.previousPath!, 'utf8'), 'before\n');
  const b = files.commitLocalFileRevision({ target, content: 'B', mode: 'append', expectedContentDigest: digest('before\nA\n'), operationKey: 'recover-B' });
  const recoveredFacts = proof.parseHostLocalWriteCommitFacts(proof.withHostLocalFileRevisionCommit({ revision: recovered, result: 'Recovered A' }))!;
  assert.equal(recoveredFacts.contentDigest, digest(descriptorA));
  assert.equal(proof.readCommittedArtifactContent(recoveredFacts).verified, false);
  assert.throws(() => files.recoverLocalFileRevision(input), files.LocalFileRevisionConflict);
  assert.equal(originalRead(target, 'utf8'), 'before\nA\nB\n');
  assert.equal(originalRead(b.previousPath!, 'utf8'), 'before\nA\n');
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});
