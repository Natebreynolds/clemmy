/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/local-file-stale-read.test.ts
 *
 * A write binds to what this conversation last saw of the file (its own read
 * or write) and meets an edit made outside since then as a typed conflict,
 * never replacing it in silence. No read is demanded before a write, and a
 * base is never guessed. The base is frozen with the admitted operation, so
 * recovery of a completed write recomputes nothing and writes nothing.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-stale-read-'));
const base = path.join(home, 'clem');
const workspace = path.join(home, 'workspace');
mkdirSync(base); mkdirSync(workspace);
process.env.CLEMENTINE_HOME = base;
process.env.WORKSPACE_DIRS = workspace;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';

const proof = await import('./host-local-write-commit.js');
const { withToolOutputContext } = await import('./tool-output-context.js');
const { getComputerTools, executeLocalFileWrite } = await import('../../tools/computer-tools.js');
const eventlog = await import('./eventlog.js');
type Invokable = { invoke: (...args: any[]) => Promise<unknown> };
const writeTool = getComputerTools().find((tool) => tool.name === 'write_file') as unknown as Invokable;
const readTool = getComputerTools().find((tool) => tool.name === 'read_file') as unknown as Invokable;
after(async () => {
  eventlog.closeEventLog();
  (await import('../../memory/db.js')).closeMemoryDb();
  rmSync(home, { recursive: true, force: true });
});

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let calls = 0;
function inConversation<T>(sessionId: string, toolName: string, work: () => Promise<T>): Promise<T> {
  calls += 1;
  return withToolOutputContext({ sessionId, sourceUserSeq: 1, callId: `call-${calls}`, toolName }, work) as Promise<T>;
}
function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  const record = result as { output?: unknown; text?: unknown; message?: unknown };
  return String(record?.output ?? record?.text ?? record?.message ?? result);
}
async function write(sessionId: string, args: Record<string, unknown>) {
  const result = await inConversation(sessionId, 'write_file', () => writeTool.invoke({ context: { sessionId } }, JSON.stringify({ mode: null, append: null, ...args })));
  return { result, text: resultText(result), facts: proof.parseHostLocalWriteCommitFacts(result) };
}
async function read(sessionId: string, target: string) {
  return resultText(await inConversation(sessionId, 'read_file', () => readTool.invoke({ context: { sessionId } }, JSON.stringify({ path: target, max_chars: null }))));
}
function session(label: string): string {
  return eventlog.createSession({ kind: 'chat', channel: 'desktop', title: label }).id;
}

test('stale read: a file edited outside after this conversation read it is not overwritten', async () => {
  const sid = session('stale-read');
  const target = path.join(workspace, 'brief.md');
  writeFileSync(target, 'Draft one.\n');
  assert.match(await read(sid, target), /Draft one/);
  writeFileSync(target, 'Someone else edited this in another app.\n');
  const stale = await write(sid, { path: target, content: 'Draft two, written from the stale read.', mode: 'overwrite' });
  assert.equal(stale.facts, null, 'no receipt for a refused write');
  assert.match(stale.text, /changed since this conversation last read or wrote it/, stale.text);
  assert.equal(readFileSync(target, 'utf8'), 'Someone else edited this in another app.\n', 'the outside edit is kept');
  // Re-reading binds the write to the file as it now is.
  await read(sid, target);
  const fresh = await write(sid, { path: target, content: 'Draft two, reconciled.', mode: 'overwrite' });
  assert.ok(fresh.facts, fresh.text);
  assert.equal(readFileSync(target, 'utf8'), 'Draft two, reconciled.\n');
});

test('exact-span replacement binds the same way: stale after an outside edit, fine after a fresh read', async () => {
  const sid = session('stale-replace');
  const target = path.join(workspace, 'notes.md');
  writeFileSync(target, 'alpha\nbeta\ngamma\n');
  await read(sid, target);
  writeFileSync(target, 'alpha\nbeta (edited outside)\ngamma\n');
  const stale = await write(sid, { path: target, content: 'BETA', mode: 'replace', find: 'alpha' });
  assert.equal(stale.facts, null);
  assert.match(stale.text, /changed since this conversation last read or wrote it/);
  assert.equal(readFileSync(target, 'utf8'), 'alpha\nbeta (edited outside)\ngamma\n');
  await read(sid, target);
  const ok = await write(sid, { path: target, content: 'ALPHA', mode: 'replace', find: 'alpha' });
  assert.ok(ok.facts, ok.text);
  assert.equal(readFileSync(target, 'utf8'), 'ALPHA\nbeta (edited outside)\ngamma\n');
});

test('create, append and chunked writes keep working, bound to the conversation\'s own writes', async () => {
  const sid = session('chunked');
  const target = path.join(workspace, 'report.md');
  const created = await write(sid, { path: target, content: 'Part 1', mode: 'create' });
  assert.ok(created.facts, created.text);
  const again = await write(sid, { path: target, content: 'Part 1', mode: 'create' });
  assert.equal(again.facts, null, 'create never replaces an existing file');
  assert.match(again.text, /Refused to overwrite existing file/);
  const appended = await write(sid, { path: target, content: 'Part 2', mode: 'append' });
  assert.ok(appended.facts, appended.text);
  assert.equal(appended.facts!.handle, created.facts!.handle);
  // Chunked by construction: append:false starts fresh, append:true continues.
  const fresh = await write(sid, { path: target, content: 'Chunk A', append: false });
  assert.ok(fresh.facts, fresh.text);
  const chunkB = await write(sid, { path: target, content: 'Chunk B', append: true });
  const chunkC = await write(sid, { path: target, content: 'Chunk C', append: true });
  assert.ok(chunkB.facts && chunkC.facts, `${chunkB.text}\n${chunkC.text}`);
  assert.equal(readFileSync(target, 'utf8'), 'Chunk A\nChunk B\nChunk C\n');
  assert.equal(chunkC.facts!.handle, created.facts!.handle, 'one stable identity across the chunks');
});

test('no read is required before a write: a file this conversation never observed takes the write as before', async () => {
  const sid = session('unobserved');
  const target = path.join(workspace, 'external.md');
  writeFileSync(target, 'Written by someone else, never read here.\n');
  const over = await write(sid, { path: target, content: 'Replaced without a read, as the owner asked.', mode: 'overwrite' });
  assert.ok(over.facts, over.text);
  assert.equal(readFileSync(target, 'utf8'), 'Replaced without a read, as the owner asked.\n');
  const appended = await write(sid, { path: target, content: 'And appended.', mode: 'append' });
  assert.ok(appended.facts, appended.text);
  // Another conversation's observation is not this one's base.
  const other = session('other-chat');
  await read(other, target);
  writeFileSync(target, 'Edited outside after the other chat read it.\n');
  const mine = await write(sid, { path: target, content: 'Still unbound here.', mode: 'append' });
  assert.equal(mine.facts, null, 'this conversation wrote it last: its own base is stale now');
  const theirs = await write(other, { path: target, content: 'Their base is stale too.', mode: 'append' });
  assert.equal(theirs.facts, null);
  assert.match(theirs.text, /changed since this conversation last read or wrote it/);
});

test('replay identity: the base is frozen with the admitted operation; recovery recomputes nothing and writes nothing', async () => {
  const sid = session('replay');
  const target = path.join(workspace, 'frozen.md');
  writeFileSync(target, 'v1\n');
  await read(sid, target);
  const operationKey = JSON.stringify({ sessionId: sid, sourceUserSeq: 1, acceptedTaskId: 'task:1', logicalToolCallId: 'lc-1' });
  const args = { path: target, content: 'v2', mode: 'overwrite' as const, append: null, find: null };
  const first = await inConversation(sid, 'write_file', () => executeLocalFileWrite(args, { preserveCreateConflict: true, operationKey }));
  const firstFacts = proof.parseHostLocalWriteCommitFacts(first);
  assert.ok(firstFacts, resultText(first));
  assert.equal(readFileSync(target, 'utf8'), 'v2\n');
  // The conversation has since seen the file again (its own write, a read):
  // a recomputed base would differ from the admitted one.
  await read(sid, target);
  const recovered = await inConversation(sid, 'write_file', () => executeLocalFileWrite(args, { preserveCreateConflict: true, operationKey, recoveryOnly: true }));
  const recoveredFacts = proof.parseHostLocalWriteCommitFacts(recovered);
  assert.ok(recoveredFacts, resultText(recovered));
  assert.equal(recoveredFacts!.contentDigest, firstFacts!.contentDigest, 'the same receipt comes back');
  assert.match(resultText(recovered), /No changes needed/, 'recovery is never a second write');
  assert.equal(readFileSync(target, 'utf8'), 'v2\n');
  // The operation record carries the frozen base.
  const dir = path.dirname(path.join(base, firstFacts!.handle));
  const operationFile = readdirSync(dir).find((name) => name.startsWith('operation-'))!;
  const saved = JSON.parse(readFileSync(path.join(dir, operationFile), 'utf8'));
  assert.equal(saved.operation.expectedContentDigest, digest('v1\n'), JSON.stringify(saved.operation));

  // An operation recorded before the base existed (no field) still recovers
  // from the request as before.
  const legacyTarget = path.join(workspace, 'legacy.md');
  const legacyKey = JSON.stringify({ sessionId: sid, sourceUserSeq: 1, acceptedTaskId: 'task:1', logicalToolCallId: 'lc-legacy' });
  const legacyArgs = { path: legacyTarget, content: 'legacy', mode: 'create' as const, append: null, find: null };
  const legacy = await inConversation(sid, 'write_file', () => executeLocalFileWrite(legacyArgs, { preserveCreateConflict: true, operationKey: legacyKey }));
  const legacyFacts = proof.parseHostLocalWriteCommitFacts(legacy)!;
  const legacyDir = path.dirname(path.join(base, legacyFacts.handle));
  // A record written before the base existed: the same descriptor bytes in
  // the operation file, its prepared copy and the current revision.
  for (const name of readdirSync(legacyDir)) {
    if (!name.startsWith('operation-') && !name.endsWith('.prepared.json') && name !== 'current.json') continue;
    const file = path.join(legacyDir, name);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    if (!record.operation) continue;
    delete record.operation.expectedContentDigest;
    writeFileSync(file, JSON.stringify(record));
  }
  const legacyRecovered = await inConversation(sid, 'write_file', () => executeLocalFileWrite(legacyArgs, { preserveCreateConflict: true, operationKey: legacyKey, recoveryOnly: true }));
  assert.ok(proof.parseHostLocalWriteCommitFacts(legacyRecovered), resultText(legacyRecovered));
  assert.equal(existsSync(legacyTarget), true);
});
