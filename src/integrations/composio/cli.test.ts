/**
 * Run: npx tsx --test src/integrations/composio/cli.test.ts
 */
import { mkdtempSync, chmodSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findComposioCli, parseComposioCliJson } from './cli.js';

test('parseComposioCliJson parses clean JSON output', () => {
  assert.deepEqual(parseComposioCliJson('{"ok":true}'), { ok: true });
});

test('parseComposioCliJson parses JSON after banner text', () => {
  assert.deepEqual(parseComposioCliJson('Composio\n[{"slug":"GMAIL_SEND_EMAIL"}]'), [{ slug: 'GMAIL_SEND_EMAIL' }]);
});

test('parseComposioCliJson ignores Composio update banner noise', () => {
  assert.deepEqual(
    parseComposioCliJson('Update available: 0.2.27 -> 0.2.28\nRun composio upgrade to update\n{"ok":true}'),
    { ok: true },
  );
});

test('parseComposioCliJson returns text when output is not JSON', () => {
  assert.equal(parseComposioCliJson('not json'), 'not json');
});

test('findComposioCli honors COMPOSIO_CLI_PATH', () => {
  const oldPath = process.env.COMPOSIO_CLI_PATH;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-composio-cli-'));
  const file = path.join(dir, 'composio');
  writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf-8');
  chmodSync(file, 0o755);
  process.env.COMPOSIO_CLI_PATH = file;
  try {
    assert.equal(findComposioCli(), file);
  } finally {
    if (oldPath === undefined) delete process.env.COMPOSIO_CLI_PATH;
    else process.env.COMPOSIO_CLI_PATH = oldPath;
  }
});
