import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { windowsChromeCandidates, windowsChromiumCandidates, windowsEnvValue } from './windows-browser-paths.js';

test('Windows browser detection covers per-user Chrome and both Edge/Brave architectures with mixed-case environment keys', () => {
  const env = { ProgramFiles: 'D:\\Program Files', 'ProgramFiles(x86)': 'D:\\Program Files (x86)', localappdata: 'D:\\Users\\Zoë\\AppData\\Local' };
  const chrome = windowsChromeCandidates(env); const all = windowsChromiumCandidates(env);
  assert.ok(chrome.includes(path.win32.join(env.localappdata, 'Google', 'Chrome', 'Application', 'chrome.exe')));
  assert.ok(all.includes(path.win32.join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
  assert.ok(all.includes(path.win32.join(env['ProgramFiles(x86)'], 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')));
  assert.ok(chrome.every(file => file.endsWith('chrome.exe')), 'Chrome permissions must not open Edge or Brave instead');
  assert.equal(windowsEnvValue({ Path: 'D:\\tools' }, 'PATH'), 'D:\\tools');
});

test('invalid relative browser roots never become working-directory candidates, and duplicate Windows roots are deduplicated', () => {
  const all = windowsChromiumCandidates({ ProgramW6432: 'C:\\PROGRAM FILES', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'relative', LOCALAPPDATA: '' });
  assert.equal(new Set(all.map(value => value.toLowerCase())).size, all.length);
  assert.ok(all.every(value => /^[a-z]:\\/i.test(value)));
  assert.ok(all.every(value => !value.includes('relative')));
});
