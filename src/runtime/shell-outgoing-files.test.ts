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

test('on Windows the command is read the way cmd.exe reads it: backslash paths, curl.exe, %VARIABLES%', () => {
  const cwd = 'C:\\work';
  const env = { USERPROFILE: 'C:\\Users\\me' };
  const win = (command: string) => outgoingFilesInCommand(command, cwd, 'win32', env);
  assert.deepEqual(win('curl.exe -F "file=@C:\\Users\\me\\My Report.pdf" https://x.test/up'), ['C:\\Users\\me\\My Report.pdf']);
  assert.deepEqual(win('curl -T C:\\Users\\me\\video.mp4 https://x.test/put'), ['C:\\Users\\me\\video.mp4'],
    'an unquoted backslash path is a path, not escapes');
  assert.deepEqual(win('curl --data-binary @body.json https://x.test'), ['C:\\work\\body.json'], 'relative to the Windows cwd');
  assert.deepEqual(win('curl -F f=@%USERPROFILE%\\Documents\\a.pdf https://x.test'), ['C:\\Users\\me\\Documents\\a.pdf']);
  assert.deepEqual(win('curl -F f=@%userprofile%\\b.pdf https://x.test'), ['C:\\Users\\me\\b.pdf'], 'variable names are case-insensitive');
  assert.deepEqual(win('cd C:\\other && gh.exe release upload v1 dist\\app.zip'), ['C:\\work\\dist\\app.zip']);
  assert.deepEqual(win('scp report.pdf user@host:/tmp/'), ['C:\\work\\report.pdf']);
  assert.deepEqual(shellWords('a "b c" C:\\x\\y d^&e', 'cmd'), ['a', 'b c', 'C:\\x\\y', 'd&e']);
  // Elsewhere the POSIX reading is unchanged.
  assert.deepEqual(outgoingFilesInCommand('curl -T ./v.mp4 https://x.test', '/work', 'darwin'), ['/work/v.mp4']);
});
