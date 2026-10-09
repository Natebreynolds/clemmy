/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/local-file-sending.test.ts
 *
 * The one check before a file on this computer is sent anywhere, by any lane.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-local-file-sending-'));
process.env.CLEMENTINE_HOME = path.join(HOME, '.clementine-next');
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
mkdirSync(path.join(HOME, '.clementine-next', 'state'), { recursive: true });

const sending = await import('./local-file-sending.js');

after(() => rmSync(HOME, { recursive: true, force: true }));

function file(relative: string, content = 'fixture'): string {
  const full = path.join(HOME, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

test('a file in the owner\'s folders is described by name, size, folder and type', () => {
  const report = file('Documents/Reports/q3 report.pdf', '%PDF-1.4 x');
  const resolved = sending.resolveLocalFileToSend(report);
  assert.equal(resolved.name, 'q3 report.pdf');
  assert.equal(resolved.folder, 'Reports');
  assert.equal(resolved.bytes, 10);
  assert.equal(resolved.mimetype, 'application/pdf');
  assert.equal(sending.describeLocalFileToSend(resolved), 'q3 report.pdf · 10 B · in Reports');
  assert.deepEqual([...sending.readLocalFileToSend(resolved)], [...Buffer.from('%PDF-1.4 x')]);
  // A file Clem wrote into her own outputs can be sent too.
  assert.equal(sending.resolveLocalFileToSend(file('.clementine-next/vault/brief.docx')).mimetype,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('what is never sent: a missing file, a folder, credentials, Clem\'s own stores, and anything outside the owner\'s folders', () => {
  const refusal = (value: string) => {
    try { sending.resolveLocalFileToSend(value); return 'sent'; } catch (error) {
      assert.ok(error instanceof sending.LocalFileSendRefusal, String(error));
      return (error as InstanceType<typeof sending.LocalFileSendRefusal>).code;
    }
  };
  assert.equal(refusal(path.join(HOME, 'nope.pdf')), 'missing');
  mkdirSync(path.join(HOME, 'Folder'), { recursive: true });
  assert.equal(refusal(path.join(HOME, 'Folder')), 'not_a_file');
  assert.equal(refusal(file('.ssh/id_ed25519')), 'sensitive');
  assert.equal(refusal(file('project/.env')), 'sensitive');
  assert.equal(refusal(file('.aws/config')), 'sensitive');
  assert.equal(refusal(file('certs/server.pem')), 'sensitive');
  assert.equal(refusal(file('.clementine-next/state/harness.db')), 'sensitive');
  assert.equal(refusal(file('.clementine-next/mcp/servers.json')), 'sensitive');
  assert.equal(refusal(file('.clementine-next/memory.db')), 'sensitive');
  const outside = mkdtempSync(path.join(os.tmpdir(), 'clem-outside-'));
  try {
    writeFileSync(path.join(outside, 'elsewhere.pdf'), 'x');
    assert.equal(refusal(path.join(outside, 'elsewhere.pdf')), 'outside_allowed_folders');
    // A link inside the home folder to a file outside it is judged by where it leads.
    symlinkSync(path.join(outside, 'elsewhere.pdf'), path.join(HOME, 'link.pdf'));
    assert.equal(refusal(path.join(HOME, 'link.pdf')), 'outside_allowed_folders');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  assert.equal(refusal('report.pdf'), 'not_a_local_path', 'a bare name is not a path');
  assert.equal(refusal('https://example.com/report.pdf'), 'not_a_local_path');
  const big = file('Documents/big.bin', 'x'.repeat(2048));
  assert.throws(() => sending.resolveLocalFileToSend(big, { maxBytes: 1024 }), (error: unknown) =>
    error instanceof sending.LocalFileSendRefusal && error.code === 'too_large' && /over the 1 KB limit/.test(error.message));
});

test('what counts as a path on this computer, on any platform', () => {
  for (const value of ['/Users/a/b.pdf', '~/b.pdf', 'C:\\Users\\a\\b.pdf', 'D:/x/y.pdf', '\\\\server\\share\\x.pdf']) {
    assert.equal(sending.looksLikeLocalFilePath(value), true, value);
  }
  for (const value of ['b.pdf', 'https://x.test/b.pdf', 's3://bucket/k', '', 'line\nbreak']) {
    assert.equal(sending.looksLikeLocalFilePath(value), false, value);
  }
  assert.equal(sending.localFileMimetype('Deck.KEY'), 'application/vnd.apple.keynote');
  assert.equal(sending.localFileMimetype('archive.unknownext'), 'application/octet-stream');
});
