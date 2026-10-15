import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { replaceMcpCredentialDeclaration, writeMcpServerCredential } from './mcp-server-credential.js';
import { readMcpServerEnv } from './mcp-server-env.js';
import { writeCredentialTextFileSync } from './credential-private-filesystem.js';

test('replacement removes all exact duplicate declarations and preserves unrelated settings', () => {
  const before = '# keep comment\nUNRELATED="do not alter"\n FIXTURE_KEY = old\nFIXTURE_KEY=stale\nOTHER_KEY=value with trailing space \n';
  const next = replaceMcpCredentialDeclaration(before, 'FIXTURE_KEY', 'new synthetic value');
  assert.equal(next, '# keep comment\nUNRELATED="do not alter"\nFIXTURE_KEY="new synthetic value"\nOTHER_KEY=value with trailing space \n');
  assert.equal(readMcpServerEnv({ FIXTURE_KEY: '' }, '/synthetic.env', {}, () => next).values.FIXTURE_KEY, 'new synthetic value');
});

test('saved values round-trip significant whitespace, quotes and literal backslashes through the real reader', () => {
  for (const value of ['plain', '  significant spaces  ', '"quoted"', "'quoted'", 'both " and \'', String.raw`literal\nbytes`, 'value=with=equals']) {
    const next = replaceMcpCredentialDeclaration('', 'FIXTURE_KEY', value);
    const resolved = readMcpServerEnv({ FIXTURE_KEY: '' }, '/synthetic.env', {}, () => next);
    assert.equal(resolved.values.FIXTURE_KEY, value);
  }
});

test('invalid credentials cause no reads, writes or running environment changes', () => {
  for (const [key, value] of [['bad=name', 'synthetic-value'], ['BAD\nNAME', 'synthetic-value'], ['GOOD', ' \t'],
    ['GOOD', 'one\ntwo'], ['GOOD', 'one\rtwo'], ['GOOD', 'one\0two']]) {
    let reads = 0; let writes = 0; const environment = { GOOD: 'keep' };
    assert.throws(() => writeMcpServerCredential('/synthetic.env', key!, value!, {
      readText: () => { reads++; return ''; }, writeText: () => { writes++; }, environment,
    }), /valid single-line/);
    assert.equal(reads, 0); assert.equal(writes, 0); assert.deepEqual(environment, { GOOD: 'keep' });
  }
});

test('persistence failures never mirror a new running credential', () => {
  for (const failure of ['read', 'write']) {
    const environment = { FIXTURE_KEY: 'keep' }; let writes = 0;
    assert.throws(() => writeMcpServerCredential('/synthetic.env', 'FIXTURE_KEY', 'replacement', {
      readText: () => { if (failure === 'read') throw new Error('controlled read failure'); return 'FIXTURE_KEY=keep\n'; },
      writeText: () => { writes++; throw new Error('controlled write failure'); }, environment,
    }), /controlled/);
    assert.equal(writes, failure === 'read' ? 0 : 1); assert.equal(environment.FIXTURE_KEY, 'keep');
  }
});

test('the canonical private writer saves the effective replacement with private permissions', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'clem-mcp-credential-'));
  try {
    const file = path.join(directory, '.env');
    writeFileSync(file, 'UNRELATED=keep\nFIXTURE_KEY=old\n  FIXTURE_KEY = stale\n', { mode: 0o600 });
    const environment: Record<string, string | undefined> = {};
    writeMcpServerCredential(file, 'FIXTURE_KEY', 'new-synthetic-value', { environment });
    assert.equal(environment.FIXTURE_KEY, 'new-synthetic-value');
    assert.equal(readMcpServerEnv({ FIXTURE_KEY: '' }, file, {}).values.FIXTURE_KEY, 'new-synthetic-value');
    assert.match(readFileSync(file, 'utf8'), /^UNRELATED=keep\n/);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a concurrent edit after composition is preserved without mirroring an unsaved value', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'clem-mcp-credential-race-'));
  try {
    const file = path.join(directory, '.env');
    writeFileSync(file, 'FIXTURE_KEY=old\nUNRELATED=original\n', { mode: 0o600 });
    const concurrent = 'FIXTURE_KEY=old\nUNRELATED=concurrent\n';
    const environment = { FIXTURE_KEY: 'old' };
    assert.throws(() => writeMcpServerCredential(file, 'FIXTURE_KEY', 'replacement', {
      environment,
      writeText: (target, text, options) => {
        writeFileSync(target, concurrent, { mode: 0o600 });
        writeCredentialTextFileSync(target, text, options);
      },
    }), /credential|storage|changed/i);
    assert.equal(readFileSync(file, 'utf8'), concurrent);
    assert.equal(environment.FIXTURE_KEY, 'old');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
