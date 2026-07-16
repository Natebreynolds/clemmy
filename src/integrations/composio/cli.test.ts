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

test('getComposioCliStatus memoizes within the TTL and re-probes after invalidation', async () => {
  const { getComposioCliStatus, invalidateComposioCliStatusCache } = await import('./cli.js');
  const oldPath = process.env.COMPOSIO_CLI_PATH;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-composio-cli-memo-'));
  const file = path.join(dir, 'composio');
  const hits = path.join(dir, 'hits.log');
  writeFileSync(file, `#!/bin/sh\necho hit >> "${hits}"\necho "0.2.28"\nexit 0\n`, 'utf-8');
  chmodSync(file, 0o755);
  writeFileSync(hits, '', 'utf-8');
  process.env.COMPOSIO_CLI_PATH = file;
  try {
    invalidateComposioCliStatusCache();
    const first = await getComposioCliStatus();
    assert.equal(first.installed, true);
    const { readFileSync } = await import('node:fs');
    const hitsAfterFirst = readFileSync(hits, 'utf-8').split('\n').filter(Boolean).length;
    assert.equal(hitsAfterFirst, 2, 'one probe = one --version + one whoami spawn');

    const second = await getComposioCliStatus();
    assert.equal(second.installed, true);
    assert.equal(
      readFileSync(hits, 'utf-8').split('\n').filter(Boolean).length,
      hitsAfterFirst,
      'a second status call within the TTL spawns nothing',
    );

    invalidateComposioCliStatusCache();
    await getComposioCliStatus();
    assert.equal(
      readFileSync(hits, 'utf-8').split('\n').filter(Boolean).length,
      hitsAfterFirst + 2,
      'invalidation (backend save / client reset) forces a fresh probe',
    );
  } finally {
    invalidateComposioCliStatusCache();
    if (oldPath === undefined) delete process.env.COMPOSIO_CLI_PATH;
    else process.env.COMPOSIO_CLI_PATH = oldPath;
  }
});

test('getComposioCliStatus keys the memo on options — a different userId is a fresh probe', async () => {
  const { getComposioCliStatus, invalidateComposioCliStatusCache } = await import('./cli.js');
  const oldPath = process.env.COMPOSIO_CLI_PATH;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-composio-cli-memo-key-'));
  const file = path.join(dir, 'composio');
  const hits = path.join(dir, 'hits.log');
  writeFileSync(file, `#!/bin/sh\necho hit >> "${hits}"\necho ok\nexit 0\n`, 'utf-8');
  chmodSync(file, 0o755);
  writeFileSync(hits, '', 'utf-8');
  process.env.COMPOSIO_CLI_PATH = file;
  try {
    invalidateComposioCliStatusCache();
    await getComposioCliStatus({ userId: 'user-a' });
    const { readFileSync } = await import('node:fs');
    const afterA = readFileSync(hits, 'utf-8').split('\n').filter(Boolean).length;
    await getComposioCliStatus({ userId: 'user-b' });
    assert.equal(
      readFileSync(hits, 'utf-8').split('\n').filter(Boolean).length,
      afterA + 2,
      'a different identity never reads another identity\'s cached auth status',
    );
  } finally {
    invalidateComposioCliStatusCache();
    if (oldPath === undefined) delete process.env.COMPOSIO_CLI_PATH;
    else process.env.COMPOSIO_CLI_PATH = oldPath;
  }
});
