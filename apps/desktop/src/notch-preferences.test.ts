import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_CLEMENTINE_NOTCH_PREFERENCES,
  clementineNotchPreferencesPath,
  loadClementineNotchPreferences,
  normalizeClementineNotchPreferences,
  patchClementineNotchPreferences,
  saveClementineNotchPreferences,
} from './notch-preferences.js';

test('normalizes partial and untrusted notch preferences', () => {
  assert.deepEqual(normalizeClementineNotchPreferences({
    enabled: false,
    behavior: 'always',
    autoHideAfterCompletion: false,
    promptForDetectedMeetings: false,
    shortcut: '  Command+Option+N  ',
    preferredDisplay: 'primary',
    ignored: 'value',
  }), {
    enabled: false,
    behavior: 'always',
    autoHideAfterCompletion: false,
    promptForDetectedMeetings: false,
    shortcut: 'Command+Option+N',
    preferredDisplay: 'primary',
  });

  assert.deepEqual(normalizeClementineNotchPreferences({
    behavior: 'surprise',
    shortcut: 'Command+\nShift+K',
    preferredDisplay: 'television',
  }), DEFAULT_CLEMENTINE_NOTCH_PREFERENCES);
});

test('invalid patch fields preserve the current preferences', () => {
  const current = normalizeClementineNotchPreferences({
    enabled: false,
    behavior: 'always',
    shortcut: 'Command+Option+N',
    preferredDisplay: 'primary',
  });
  assert.deepEqual(patchClementineNotchPreferences(current, {
    enabled: 'yes',
    behavior: 'sometimes',
    shortcut: '   ',
    preferredDisplay: 'external',
    autoHideAfterCompletion: false,
    promptForDetectedMeetings: false,
  }), {
    ...current,
    autoHideAfterCompletion: false,
    promptForDetectedMeetings: false,
  });
});

test('persists atomically and falls back safely for corrupt files', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clementine-notch-preferences-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = clementineNotchPreferencesPath(root);
  const saved = saveClementineNotchPreferences(file, {
    enabled: true,
    behavior: 'always',
    autoHideAfterCompletion: false,
    promptForDetectedMeetings: true,
    shortcut: 'Command+Option+N',
    preferredDisplay: 'primary',
  });
  assert.deepEqual(loadClementineNotchPreferences(file), saved);
  assert.equal(JSON.parse(readFileSync(file, 'utf-8')).schemaVersion, 1);

  writeFileSync(file, '{not-json', 'utf-8');
  assert.deepEqual(loadClementineNotchPreferences(file), {
    ...DEFAULT_CLEMENTINE_NOTCH_PREFERENCES,
    enabled: false,
  });

  for (const corrupt of [
    {},
    { preferences: {} },
    { preferences: { enabled: 'yes' } },
  ]) {
    writeFileSync(file, JSON.stringify(corrupt), 'utf-8');
    assert.deepEqual(loadClementineNotchPreferences(file), {
      ...DEFAULT_CLEMENTINE_NOTCH_PREFERENCES,
      enabled: false,
    });
  }

  writeFileSync(file, JSON.stringify({ schemaVersion: 99, preferences: saved }), 'utf-8');
  assert.equal(loadClementineNotchPreferences(file).enabled, false);
});
