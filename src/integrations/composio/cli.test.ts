/**
 * Run: npx tsx --test src/integrations/composio/cli.test.ts
 */
import { mkdtempSync, chmodSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composioCliSpawnSpec, findComposioCli, parseComposioCliJson } from './cli.js';

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

test('findComposioCli probes safe Windows PATHEXT candidates, including cmd shims', () => {
  const checked: string[] = [];
  const selected = findComposioCli({
    platform: 'win32',
    homeDir: 'C:\\Users\\Clem',
    env: {
      PATH: 'C:\\Tools;D:\\Bin',
      PATHEXT: '.EXE;.PS1;.CMD;.PY;.VBS;..\\escape;.BAT',
    },
    isExecutable: (candidate: string) => {
      checked.push(candidate);
      return candidate === 'D:\\Bin\\composio.CMD';
    },
  });

  assert.equal(selected, 'D:\\Bin\\composio.CMD');
  assert.ok(checked.includes('C:\\Tools\\composio.EXE'));
  assert.ok(checked.includes('C:\\Tools\\composio.CMD'));
  assert.ok(checked.includes('D:\\Bin\\composio.CMD'));
  assert.ok(
    checked.every((candidate) => !candidate.includes('escape')),
    'invalid PATHEXT entries never become filesystem probes',
  );
  assert.ok(
    checked.every((candidate) => !/\.(?:ps1|py|vbs)$/i.test(candidate)),
    'PATHEXT entries the spawn adapter cannot launch are never discovered',
  );
});

test('findComposioCli rejects unsupported explicit Windows script extensions before probing', () => {
  for (const extension of ['ps1', 'vbs']) {
    const checked: string[] = [];
    const selected = findComposioCli({
      platform: 'win32',
      homeDir: 'C:\\Users\\Clem',
      env: {
        COMPOSIO_CLI_PATH: `C:\\Custom\\composio.${extension}`,
        PATH: '',
        PATHEXT: '.EXE;.CMD',
      },
      isExecutable: (candidate: string) => {
        checked.push(candidate);
        return candidate.toLowerCase().endsWith(`.${extension}`);
      },
    });
    assert.equal(selected, null);
    assert.ok(
      checked.every((candidate) => !candidate.toLowerCase().endsWith(`.${extension}`)),
      `explicit .${extension} path never reaches the executable probe`,
    );
  }

  assert.equal(
    findComposioCli({
      platform: 'win32',
      homeDir: 'C:\\Users\\Clem',
      env: {
        COMPOSIO_CLI_PATH: 'C:\\Custom\\composio.cjs',
        PATH: '',
      },
      isExecutable: (candidate: string) => candidate === 'C:\\Custom\\composio.cjs',
    }),
    'C:\\Custom\\composio.cjs',
    'an explicitly supported Node adapter remains discoverable',
  );
});

test('Composio JS adapters run through Node without a command shell on every platform', () => {
  assert.deepEqual(
    composioCliSpawnSpec('C:\\proof\\composio-proof.cjs', ['execute', 'TOOL', '-d', '{"value":"a&b"}']),
    {
      command: process.execPath,
      args: ['C:\\proof\\composio-proof.cjs', 'execute', 'TOOL', '-d', '{"value":"a&b"}'],
    },
  );
  assert.deepEqual(
    composioCliSpawnSpec('/usr/local/bin/composio', ['whoami']),
    { command: '/usr/local/bin/composio', args: ['whoami'] },
  );
});

test('Windows cmd/bat shims use explicit cmd.exe with metacharacter-safe verbatim arguments', () => {
  const payload =
    '{"value":"a&b|c>out<in%PATH%!bang^caret","quote":"\\"hello\\""}';
  for (const extension of ['cmd', 'bat']) {
    const spec = composioCliSpawnSpec(
      `C:\\Program Files\\Composio\\composio.${extension}`,
      ['execute', 'TOOL', '-d', payload],
      {
        platform: 'win32',
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      },
    );

    assert.equal(spec.command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(spec.args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
    assert.equal(spec.windowsVerbatimArguments, true);
    const commandLine = spec.args[4] ?? '';
    assert.match(commandLine, /^"C:\\Program\^ Files\\Composio\\composio\.(?:cmd|bat) /i);
    assert.match(commandLine, /\^&/);
    assert.match(commandLine, /\^\|/);
    assert.match(commandLine, /\^>/);
    assert.match(commandLine, /\^</);
    assert.match(commandLine, /\^%PATH\^%/);
    assert.match(commandLine, /\^!/);
    assert.match(commandLine, /\^\^caret/);
    assert.doesNotMatch(commandLine, /(?<!\^)(?:%PATH%|&b|\|c|>out|<in)/);
    assert.equal(commandLine.at(-1), '"');
  }
  assert.throws(
    () => composioCliSpawnSpec(
      'C:\\Composio\\composio.cmd',
      ['execute', 'TOOL', '-d', '{"value":"safe"}\r\nwhoami'],
      { platform: 'win32', env: {} },
    ),
    /line breaks|NUL/i,
  );
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
