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
  assert.equal(renderHostExecutionContext('darwin'), '');
  assert.equal(renderHostExecutionContext('linux'), '');
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
