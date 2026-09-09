import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-file-revision-'));
const base = path.join(home, 'clem');
const workspace = path.join(home, 'workspace');
mkdirSync(base); mkdirSync(workspace);
process.env.CLEMENTINE_HOME = base;
process.env.WORKSPACE_DIRS = workspace;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
const files = await import('./local-file-revision.js');
const proof = await import('./host-local-write-commit.js');
const { getComputerTools } = await import('../../tools/computer-tools.js');
const tool = getComputerTools().find(tool => tool.name === 'write_file') as { invoke: (...args: any[]) => Promise<string> };
after(async () => {
  (await import('./eventlog.js')).closeEventLog();
  (await import('../../memory/db.js')).closeMemoryDb();
  rmSync(home, { recursive: true, force: true });
});
async function write(target: string, content: string, mode: 'create' | 'append' | 'overwrite') {
  const result = await tool.invoke({ context: { sessionId: 'local-file-proof' } }, JSON.stringify({ path: target, content, mode, append: null }));
  const facts = proof.parseHostLocalWriteCommitFacts(result);
  assert.ok(facts, String(result));
  if (!facts) throw new Error('write omitted receipt');
  return { facts, result, descriptor: JSON.parse(readFileSync(path.join(base, facts.handle), 'utf8')) };
}

test('actual write_file retains complete large content, revises once, and redeems current bytes outside the app home', async () => {
  const target = path.join(workspace, 'website.html');
  const original = '<section>Complete project brief €</section>\n'.repeat(3000);
  const first = await write(target, original, 'create');
  assert.ok(Buffer.byteLength(original) > 24000);
  const readback = proof.readCommittedArtifactContent(first.facts);
  assert.equal(readback.verified, true);
  assert.equal(readback.totalBytes, Buffer.byteLength(original));
  assert.equal(readback.parts[0]?.bytes.toString('utf8'), original);
  const second = await write(target, 'Revised private workshop page', 'overwrite');
  assert.equal(second.facts.handle, first.facts.handle, 'stable target identity supports source-local supersession');
  assert.equal(readFileSync(path.join(base, second.descriptor.previous.handle), 'utf8'), original);
  assert.equal(proof.readCommittedArtifactContent(second.facts).verified, true);
  assert.equal(proof.readCommittedArtifactContent(first.facts).verified, false, 'an older receipt cannot certify the new revision');
  const retainedFacts = JSON.parse(JSON.stringify(second.facts));
  writeFileSync(target, 'Changed after judgment\n');
  const drifted = proof.readCommittedArtifactContent(retainedFacts);
  assert.equal(drifted.verified, false);
  assert.equal(drifted.unresolvedReason, 'content_digest_mismatch');
  assert.equal(drifted.parts[0]?.bytes.toString('utf8'), 'Changed after judgment\n');
  // Restore using the same native tool and the durably retained prior text.
  const restored = await write(target, readFileSync(path.join(base, second.descriptor.previous.handle), 'utf8'), 'overwrite');
  assert.equal(readFileSync(target, 'utf8'), original);
  assert.equal(proof.readCommittedArtifactContent(restored.facts).verified, true);
});

test('append preserves the exact preimage and file permissions before adding a newline boundary', async () => {
  const target = path.join(workspace, 'append.txt');
  const prior = Buffer.from([65, 0, 255, 66]);
  writeFileSync(target, prior); chmodSync(target, 0o640);
  const revision = files.commitLocalFileRevision({ target, content: 'next', mode: 'append' });
  assert.deepEqual(readFileSync(revision.previousPath!), prior);
  assert.deepEqual(readFileSync(target), Buffer.concat([prior, Buffer.from('\nnext\n')]));
  assert.equal(statSync(target).mode & 0o777, 0o640);
});

test('failure to retain recovery data leaves the original file unchanged', () => {
  const target = path.join(workspace, 'cannot-backup.txt');
  writeFileSync(target, 'keep these bytes');
  const key = createHash('sha256').update(files.canonicalLocalFileTarget(target)).digest('hex');
  const root = path.join(base, 'state/local-file-revisions');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, key), 'blocked revision directory');
  assert.throws(() => files.commitLocalFileRevision({ target, content: 'replacement', mode: 'overwrite' }));
  assert.equal(readFileSync(target, 'utf8'), 'keep these bytes');
});

test('a current target replaced by a symlink cannot redeem a positive receipt or be overwritten', async () => {
  const target = path.join(workspace, 'direct.txt');
  const other = path.join(workspace, 'unrelated.txt');
  writeFileSync(other, 'unrelated');
  const written = await write(target, 'intended', 'create');
  unlinkSync(target); symlinkSync(other, target);
  const result = proof.readCommittedArtifactContent(written.facts);
  assert.equal(result.verified, false);
  assert.deepEqual(result.parts, []);
  assert.throws(() => files.commitLocalFileRevision({ target, content: 'replacement', mode: 'overwrite' }), /direct regular file/);
  assert.equal(readFileSync(other, 'utf8'), 'unrelated');
});

test('create remains exclusive and model file tools cannot modify revision receipts', async () => {
  const target = path.join(workspace, 'exclusive.txt');
  const written = await write(target, 'first', 'create');
  assert.throws(() => files.commitLocalFileRevision({ target, content: 'second', mode: 'create' }), /Refused to overwrite/);
  assert.equal(readFileSync(target, 'utf8'), 'first\n');
  const descriptor = path.join(base, written.facts.handle);
  const before = readFileSync(descriptor);
  const refused = await tool.invoke({ context: {} }, JSON.stringify({ path: descriptor, content: '{}', mode: 'overwrite', append: null }));
  assert.match(String(refused), /authorization state cannot be mutated/);
  assert.deepEqual(readFileSync(descriptor), before);
  assert.equal(existsSync(target), true);
});
