import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderHostExecutionContext, shellCwdGuidance } from './host-execution-context.js';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-platform-context-'));

test('Windows host facts identify the real shell, cross-drive cwd and computer capability boundary', () => {
  const text = renderHostExecutionContext('win32');
  assert.match(text, /Windows.*cmd\.exe syntax/);
  assert.match(text, /PowerShell syntax requires explicitly invoking PowerShell/);
  assert.match(text, /tool's cwd.*another drive/);
  assert.match(text, /does not imply arbitrary desktop mouse\/keyboard/);
  assert.equal(renderHostExecutionContext('linux'), '');
});

test('macOS host facts name the BSD tools, for every model and in the shell tool, so commands are written for this machine', () => {
  assert.match(renderHostExecutionContext('darwin'), /^HOST EXECUTION — this connected computer runs macOS\. run_shell_command runs \/bin\/sh with the BSD command-line tools/);
  assert.ok(shellCwdGuidance('darwin').startsWith(renderHostExecutionContext('darwin')));
  assert.doesNotMatch(shellCwdGuidance('win32'), /BSD/);
  assert.doesNotMatch(shellCwdGuidance('linux'), /^HOST EXECUTION/);
  // Finding a file by name goes to the Spotlight index, not a home-folder walk.
  assert.match(renderHostExecutionContext('darwin'), /mdfind -name/);
  assert.match(shellCwdGuidance('darwin'), /mdfind -name/);
  assert.doesNotMatch(renderHostExecutionContext('win32'), /mdfind/);
  // Windows has no instant index command; a search stays inside one folder.
  assert.match(renderHostExecutionContext('win32'), /dir \/s \/b "%USERPROFILE%\\Downloads\\\*name\*"/);
  assert.match(shellCwdGuidance('win32'), /search one folder rather than the whole drive/);
});

test('the live tool definition carries current-host guidance and Windows permission errors get Windows remedies', async () => {
  const { getComputerTools, annotateShellStderr } = await import('../tools/computer-tools.js');
  const tool = getComputerTools().find(entry => entry.name === 'run_shell_command')!;
  assert.ok(tool.description.includes(shellCwdGuidance()));
  if (process.platform === 'win32') {
    assert.match(tool.description, /uses cmd\.exe syntax/);
    const failure = annotateShellStderr('EPERM: operation not permitted, uv_cwd', 'node fixture.cjs');
    assert.match(failure, /Windows refused access/);
    assert.doesNotMatch(failure, /TCC|Full Disk Access|Clementine\.app/);
  }
});
