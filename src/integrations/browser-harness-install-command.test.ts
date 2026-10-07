import assert from 'node:assert/strict';
import test from 'node:test';
import { validateInstallCommand } from './browser-harness.js';

const githubWindows = 'winget install --id GitHub.cli --exact --source winget --disable-interactivity';
test('Windows catalog permits only the exact reviewed GitHub CLI winget install', () => {
  assert.deepEqual(validateInstallCommand(githubWindows, 'win32'), { ok: true, normalized: githubWindows });
  for (const command of [githubWindows.replace('GitHub.cli', 'other.application'), githubWindows + ' --force', githubWindows + ' & echo changed',
    githubWindows.replace(' --exact', ''), githubWindows.replace(' --source winget', ' --source other'), githubWindows + ' --silent']) {
    assert.equal(validateInstallCommand(command, 'win32').ok, false, command);
  }
});

test('Windows Homebrew refusal gives a concrete supported route before any dispatch', () => {
  for (const command of ['brew install gh', 'brew install --cask google-chrome', 'brew tap owner/tool']) {
    const result = validateInstallCommand(command, 'win32'); assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Homebrew is not a Windows installer.*winget install --id GitHub\.cli/);
  }
});

test('Mac approved forms remain unchanged and Windows winget permission is platform-bound', () => {
  assert.equal(validateInstallCommand('brew install gh', 'darwin').ok, true);
  assert.equal(validateInstallCommand('brew install --cask google-chrome', 'darwin').ok, true);
  assert.equal(validateInstallCommand('npm install -g typescript', 'darwin').ok, true);
  assert.equal(validateInstallCommand('uv tool install browser-harness', 'darwin').ok, true);
  for (const platform of ['darwin', 'linux'] as const) assert.equal(validateInstallCommand(githubWindows, platform).ok, false);
});
