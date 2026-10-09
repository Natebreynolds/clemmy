/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/shell-outgoing-files.test.ts
 *
 * The files a command that leaves this computer would send, for the card.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { outgoingFilesInCommand, shellWords } from './shell-outgoing-files.js';

test('the files an outgoing command carries are read from its own arguments', () => {
  const cwd = '/work';
  assert.deepEqual(outgoingFilesInCommand(`curl -sS -X POST https://x.test/up -F "file=@/Users/a/My Report.pdf;type=application/pdf" -F name=b`, cwd), ['/Users/a/My Report.pdf']);
  assert.deepEqual(outgoingFilesInCommand('curl --data-binary @body.json https://x.test', cwd), ['/work/body.json']);
  assert.deepEqual(outgoingFilesInCommand('curl -T ./video.mp4 https://x.test/put', cwd), ['/work/video.mp4']);
  assert.deepEqual(outgoingFilesInCommand('curl -d ping=1 https://x.test', cwd), [], 'inline data is not a file');
  assert.deepEqual(outgoingFilesInCommand('gh release upload v1.2.0 dist/app.zip "dist/notes.md#Release notes" --clobber -R me/app', cwd), ['/work/dist/app.zip', '/work/dist/notes.md']);
  assert.deepEqual(outgoingFilesInCommand('gh gist create -d "snippet" a.ts b.ts', cwd), ['/work/a.ts', '/work/b.ts']);
  assert.deepEqual(outgoingFilesInCommand('gh issue create --title "Bug" --body-file issue.md', cwd), ['/work/issue.md']);
  assert.deepEqual(outgoingFilesInCommand('scp -P 2222 a.pdf b.pdf user@host:/tmp/', cwd), ['/work/a.pdf', '/work/b.pdf']);
  assert.deepEqual(outgoingFilesInCommand('scp user@host:/tmp/a.pdf .', cwd), [], 'a download sends nothing');
  assert.deepEqual(outgoingFilesInCommand('aws s3 cp report.pdf s3://bucket/report.pdf', cwd), ['/work/report.pdf']);
  assert.deepEqual(outgoingFilesInCommand('rclone copy ./out remote:backup', cwd), ['/work/out']);
  assert.deepEqual(outgoingFilesInCommand('cd /x && curl -F f=@~/c.txt https://x.test', cwd).length, 1);
  assert.deepEqual(shellWords(`a 'b c' "d \\"e\\"" f\\ g`), ['a', 'b c', 'd "e"', 'f g']);
});
