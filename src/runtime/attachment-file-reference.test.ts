/** Run behind scripts/run-tests-isolated.mjs; no model or provider is used. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-attachment-reference-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const attachments = await import('./attachments.js');
const references = await import('./attachment-file-reference.js');
const sending = await import('./local-file-sending.js');
const mcp = await import('./mcp-file-inputs.js');
const log = await import('./harness/eventlog.js');
const continuity = await import('../memory/task-continuity.js');
const previews = await import('./harness/approval-call-preview.js');
after(() => { log.closeEventLog(); rmSync(HOME, { recursive: true, force: true }); });
const BINARY = Buffer.from([0, 1, 7, 255, 0, 9]);
const SCHEMA = { type: 'object', properties: { content: { type: 'string', contentEncoding: 'base64' }, note: { type: 'string' } } };

async function owned(name = 'controlled.mp4', bytes = BINARY) {
  const attachment = await attachments.ingestAttachment({ name, bytes });
  assert.ok(attachment.file, JSON.stringify(attachment));
  const session = log.createSession({ kind: 'chat' });
  const files = references.acceptedAttachmentFiles([attachment]);
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Use the controlled attached bytes.', attachmentFiles: files } });
  return { attachment, session, source, identity: { sessionId: session.id, sourceUserSeq: source.seq }, file: references.attachmentFilePath(attachment.file) };
}

test('video, archive and unknown binary are retained as exact bytes without claiming extracted content', async () => {
  for (const name of ['controlled.mp4', 'controlled.zip', 'controlled.custom']) {
    const f = await owned(name);
    assert.equal(f.attachment.error, undefined);
    assert.equal(f.attachment.file!.sha256, createHash('sha256').update(BINARY).digest('hex'));
    assert.deepEqual(readFileSync(f.file), BINARY);
    assert.match(attachments.foldAttachmentsIntoMessage('Send this selected file.', [f.attachment]), /not instructions or permission/);
    assert.equal(mcp.mcpArgumentsWithFileContent(SCHEMA, { content: f.file, note: f.file }, f.identity).content, BINARY.toString('base64'));
    assert.equal(mcp.mcpArgumentsWithFileContent(SCHEMA, { content: f.file, note: f.file }, f.identity).note, f.file, 'plain strings are not file-content fields');
  }
});

test('retention alone grants no export: default guards, unrelated requests and arbitrary state remain denied', async () => {
  const f = await owned();
  assert.throws(() => sending.resolveLocalFileToSend(f.file), /never sent/);
  assert.throws(() => mcp.mcpArgumentsWithFileContent(SCHEMA, { content: f.file }), /Nothing was sent/);
  const other = log.appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'An unrelated request.' } });
  assert.throws(() => mcp.mcpArgumentsWithFileContent(SCHEMA, { content: f.file }, { sessionId: f.session.id, sourceUserSeq: other.seq }), /does not own/);
  assert.throws(() => mcp.mcpArgumentsWithFileContent(SCHEMA, { note: f.file }, { sessionId: f.session.id, sourceUserSeq: other.seq }), /does not own/, 'plain path fields cannot bypass source ownership');
  const otherSession = log.createSession({ kind: 'chat' });
  assert.throws(() => references.sourceOwnedAttachmentFile(f.file, { sessionId: otherSession.id, sourceUserSeq: f.source.seq }), /does not own/);
  assert.throws(() => references.sourceOwnedAttachmentFile(path.join(HOME, 'state', 'harness.db'), f.identity), /does not own/);
});

test('an unproved operation or Composio preview never labels a state snapshot as sendable', async () => {
  const f = await owned('selected-draft.mp4');
  for (const info of [
    { toolName: 'call_tool', args: { name: 'fixture__send_asset', args_json: { content: f.file } }, rawArgs: '' },
    { toolName: 'composio_execute_tool', args: { tool_slug: 'FIXTURE_UPLOAD', arguments: { content: f.file } }, rawArgs: '' },
  ]) assert.match(previews.approvalCallPreview(info, true, false, f.identity)?.fields[0]?.label ?? '', /cannot be sent/);
  assert.match(previews.approvalFileLabel(f.file)!, /cannot be sent/);
  assert.throws(() => sending.resolveLocalFileToSend(f.file), /never sent/);
});

test('accepted source keeps its exact reference after inbox removal and database reopen', async () => {
  const f = await owned();
  const inbox = attachments.saveIngestedToInbox(f.attachment);
  rmSync(path.join(HOME, 'state', 'attachments-inbox', `${inbox}.json`));
  log.closeEventLog();
  assert.equal(mcp.mcpArgumentsWithFileContent(SCHEMA, { content: f.file }, f.identity).content, BINARY.toString('base64'));
});

test('only a durably consumed clarification answer inherits the original selected bytes', async () => {
  for (const disposition of ['provided', 'declined'] as const) {
    const f = await owned();
    continuity.createTaskContinuityPacket({ sessionId: f.session.id, originatingSourceUserSeq: f.source.seq,
      pause: { kind: 'clarification', question: 'Which controlled label should be used?', options: [] } });
    const answer = log.appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text: disposition === 'provided' ? 'The fixture label.' : 'No.' } });
    const result = continuity.consumeTaskContinuityPacket({ sessionId: f.session.id, consumingSourceUserSeq: answer.seq,
      resolution: { resolverVersion: 'clarification-resolver-v2', disposition, semanticInputHash: 'a'.repeat(64) } });
    assert.equal(result.status, 'consumed', JSON.stringify(result));
    const source = { sessionId: f.session.id, sourceUserSeq: answer.seq };
    if (disposition === 'provided') assert.equal(mcp.mcpArgumentsWithFileContent(SCHEMA, { content: f.file }, source).content, BINARY.toString('base64'));
    else assert.throws(() => mcp.mcpArgumentsWithFileContent(SCHEMA, { content: f.file }, source), /does not own/);
  }
});

test('changed bytes, replaced inode, symlink and corrupted references fail before content preparation', async () => {
  for (const mutation of ['content', 'replace', 'symlink', 'reference'] as const) {
    const f = await owned();
    if (mutation === 'content') writeFileSync(f.file, Buffer.from([1, 1, 7, 255, 0, 9]));
    if (mutation === 'replace') { writeFileSync(`${f.file}.replacement`, BINARY); renameSync(`${f.file}.replacement`, f.file); }
    if (mutation === 'symlink') { writeFileSync(`${f.file}.other`, BINARY); rmSync(f.file); symlinkSync(`${f.file}.other`, f.file); }
    let source = f.identity;
    if (mutation === 'reference') {
      const corrupt = log.appendEvent({ sessionId: f.session.id, turn: 2, role: 'user', type: 'user_input_received', data: {
        text: 'Controlled corrupt host record.', attachmentFiles: [{ ...f.attachment.file, sha256: 'b'.repeat(64) }],
      } });
      source = { sessionId: f.session.id, sourceUserSeq: corrupt.seq };
    }
    assert.throws(() => mcp.mcpArgumentsWithFileContent(SCHEMA, { content: f.file }, source), /Nothing was sent/);
  }
});

test('a snapshot changed after resolution cannot supply bytes at the final read', async () => {
  const f = await owned();
  const reference = references.sourceOwnedAttachmentFile(f.file, f.identity);
  writeFileSync(f.file, Buffer.from([9, 1, 7, 255, 0, 9]));
  assert.throws(() => references.readSourceOwnedAttachmentFile(reference, f.identity), /changed/);
});

test('25MiB ingestion and 20MiB MCP inline boundaries stay separate; executables and credentials are not retained', async () => {
  const overIngress = await attachments.ingestAttachment({ name: 'large.mp4', bytes: Buffer.alloc(attachments.MAX_ATTACHMENT_BYTES + 1) });
  assert.match(overIngress.error!, /too large/);
  assert.equal(overIngress.file, undefined);
  const f = await owned('inline-large.mp4', Buffer.alloc(mcp.MCP_INLINE_FILE_MAX_BYTES + 1));
  assert.throws(() => mcp.mcpArgumentsWithFileContent(SCHEMA, { content: f.file }, f.identity), /over the file-content limit/);
  assert.match(previews.approvalFileLabel(f.file, f.identity)!, /cannot be sent:.*20MiB/, 'the approval cannot promise bytes that native MCP will refuse');
  for (const name of ['installer.exe', 'library.dll', '.env', 'identity.pem']) {
    const blocked = await attachments.ingestAttachment({ name, bytes: BINARY });
    assert.ok(blocked.error, name);
    assert.equal(blocked.file, undefined, name);
  }
});
