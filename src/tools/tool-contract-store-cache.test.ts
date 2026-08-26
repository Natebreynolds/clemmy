/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/tool-contract-store-cache.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { performance } from 'node:perf_hooks';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-contract-cache-'));
const MACHINE_ID = 'contract-cache-machine';
process.env.CLEMENTINE_HOME = TEST_HOME;
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TEST_HOME, 'state', 'machine-id'), `${MACHINE_ID}\n`, 'utf8');

const store = await import('./tool-contract-store.js');
type CacheStats = {
  entries: number;
  bytes: number;
  maxBytes: number;
  hits: number;
  misses: number;
  parses: number;
  validations: number;
};
const cacheControls = store as typeof store & {
  _resetToolContractFileCacheForTests?: () => void;
  _toolContractFileCacheStatsForTests?: () => CacheStats;
  _setToolContractFileCacheByteBudgetForTests?: (bytes: number) => void;
};

const contractsDir = path.join(TEST_HOME, 'memory', 'tool-contracts', MACHINE_ID);
const schema = (version: string) => ({
  type: 'object',
  title: version,
  required: ['query'],
  properties: {
    query: { type: 'string' },
    limit: { type: 'number' },
    filters: { type: 'object', properties: { active: { type: 'boolean' } } },
  },
});

function record(identifier: string, version: string, savedAt = new Date().toISOString()) {
  const exactSchema = schema(version);
  return {
    identifier,
    schema: exactSchema,
    fingerprint: store.fingerprintSchema(exactSchema),
    savedAt,
  };
}

function fileFor(identifier: string): string {
  return path.join(contractsDir, store.contractFileName(identifier));
}

function writeDirect(identifier: string, version: string): void {
  mkdirSync(contractsDir, { recursive: true });
  writeFileSync(fileFor(identifier), JSON.stringify(record(identifier, version), null, 2), 'utf8');
}

function resetCache(): void {
  assert.equal(
    typeof cacheControls._resetToolContractFileCacheForTests,
    'function',
    'the parsed contract cache must expose a bounded test reset seam',
  );
  cacheControls._resetToolContractFileCacheForTests!();
}

function stats(): CacheStats {
  assert.equal(typeof cacheControls._toolContractFileCacheStatsForTests, 'function');
  return cacheControls._toolContractFileCacheStatsForTests!();
}

function scanStore(): number {
  let count = 0;
  for (const file of store.listToolContractFiles()) {
    if (store.readToolContractFile(file.fileName)) count += 1;
  }
  return count;
}

function runExternalReplacement(input: {
  file: string;
  bytes?: string;
  restoreMtimeMs?: number;
  atomic?: boolean;
  remove?: boolean;
}): void {
  const script = String.raw`
    const fs = require('node:fs');
    const file = process.env.CLEM_CONTRACT_FILE;
    if (process.env.CLEM_CONTRACT_REMOVE === '1') {
      fs.unlinkSync(file);
      process.exit(0);
    }
    const bytes = Buffer.from(process.env.CLEM_CONTRACT_BYTES_B64, 'base64');
    const target = process.env.CLEM_CONTRACT_ATOMIC === '1' ? file + '.external.tmp' : file;
    fs.writeFileSync(target, bytes);
    const mtimeMs = Number(process.env.CLEM_CONTRACT_MTIME_MS);
    if (Number.isFinite(mtimeMs)) fs.utimesSync(target, new Date(mtimeMs), new Date(mtimeMs));
    if (target !== file) fs.renameSync(target, file);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      CLEM_CONTRACT_FILE: input.file,
      CLEM_CONTRACT_BYTES_B64: Buffer.from(input.bytes ?? '', 'utf8').toString('base64'),
      CLEM_CONTRACT_MTIME_MS: input.restoreMtimeMs === undefined ? '' : String(input.restoreMtimeMs),
      CLEM_CONTRACT_ATOMIC: input.atomic ? '1' : '0',
      CLEM_CONTRACT_REMOVE: input.remove ? '1' : '0',
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

after(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  store._clearToolContractsForTests();
  cacheControls._resetToolContractFileCacheForTests?.();
});

test('2,000-file admission scan parses once, then serves immutable metadata-validated cache hits', (t) => {
  mkdirSync(contractsDir, { recursive: true });
  const savedAt = new Date().toISOString();
  for (let index = 0; index < 2_000; index += 1) {
    const identifier = `BENCHMARK_SEARCH_TOOL_${String(index).padStart(4, '0')}`;
    writeFileSync(fileFor(identifier), JSON.stringify(record(identifier, 'A', savedAt)), 'utf8');
  }
  resetCache();

  const firstStarted = performance.now();
  assert.equal(scanStore(), 2_000);
  const firstMs = performance.now() - firstStarted;
  const afterFirst = stats();
  assert.equal(afterFirst.parses, 2_000);
  assert.equal(afterFirst.entries, 2_000, 'cache is capped at the durable store ceiling');
  assert.equal(afterFirst.bytes <= afterFirst.maxBytes, true, 'cache also stays inside its fixed process byte budget');

  const secondStarted = performance.now();
  assert.equal(scanStore(), 2_000);
  const secondMs = performance.now() - secondStarted;
  const afterSecond = stats();
  assert.equal(afterSecond.parses, 2_000, 'unchanged contracts are never reparsed on the next admission');
  assert.equal(afterSecond.hits - afterFirst.hits, 2_000);
  assert.equal(afterSecond.entries, 2_000);
  t.diagnostic(`contract cache measurement: first=${firstMs.toFixed(1)}ms second=${secondMs.toFixed(1)}ms`);
});

test('atomic child-process replacement with identical size and restored mtime invalidates by inode/ctime', () => {
  const identifier = 'EXTERNAL_ATOMIC_TOOL';
  writeDirect(identifier, 'A');
  const file = fileFor(identifier);
  const fixedTime = new Date('2026-01-02T03:04:05.000Z');
  utimesSync(file, fixedTime, fixedTime);
  resetCache();
  assert.equal((store.loadToolContract(identifier)?.schema as { title?: string }).title, 'A');
  const before = statSync(file, { bigint: true });
  const replacement = JSON.stringify(record(identifier, 'B', JSON.parse(readFileSync(file, 'utf8')).savedAt), null, 2);
  assert.equal(Buffer.byteLength(replacement), Number(before.size), 'fixture keeps byte size identical');

  runExternalReplacement({
    file,
    bytes: replacement,
    restoreMtimeMs: Number(before.mtimeNs) / 1_000_000,
    atomic: true,
  });
  const after = statSync(file, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs, 'external writer restored the exact prior mtime');
  assert.notEqual(after.ino, before.ino, 'atomic external replacement changes inode identity');
  assert.equal((store.loadToolContract(identifier)?.schema as { title?: string }).title, 'B');
  assert.equal(stats().parses, 2, 'replacement is parsed exactly once rather than serving cached A');
});

test('in-place child rewrite with identical size and restored mtime invalidates by ctime', () => {
  const identifier = 'EXTERNAL_IN_PLACE_TOOL';
  writeDirect(identifier, 'A');
  const file = fileFor(identifier);
  const fixedTime = new Date('2026-01-02T03:04:05.000Z');
  utimesSync(file, fixedTime, fixedTime);
  resetCache();
  assert.equal((store.loadToolContract(identifier)?.schema as { title?: string }).title, 'A');
  const before = statSync(file, { bigint: true });
  const replacement = JSON.stringify(record(identifier, 'B', JSON.parse(readFileSync(file, 'utf8')).savedAt), null, 2);
  assert.equal(Buffer.byteLength(replacement), Number(before.size));

  runExternalReplacement({
    file,
    bytes: replacement,
    restoreMtimeMs: Number(before.mtimeNs) / 1_000_000,
    atomic: false,
  });
  const after = statSync(file, { bigint: true });
  assert.equal(after.ino, before.ino, 'in-place rewrite retains inode');
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs, 'external writer restored the exact prior mtime');
  assert.notEqual(after.ctimeNs, before.ctimeNs, 'filesystem ctime exposes the otherwise-hidden rewrite');
  assert.equal((store.loadToolContract(identifier)?.schema as { title?: string }).title, 'B');
});

test('save, external deletion, and malformed replacement invalidate without stale authority', () => {
  const identifier = 'INVALIDATION_TOOL';
  store.saveToolContract({ identifier, schema: schema('A') });
  resetCache();
  const first = store.loadToolContract(identifier)!;
  assert.equal((first.schema as { title?: string }).title, 'A');
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.schema), true, 'cached authority is deeply immutable');
  assert.throws(() => { (first.schema as { title?: string }).title = 'MUTATED'; }, TypeError);

  store.saveToolContract({ identifier, schema: schema('B') });
  assert.equal((store.loadToolContract(identifier)?.schema as { title?: string }).title, 'B');

  const file = fileFor(identifier);
  runExternalReplacement({ file, bytes: '{ malformed', atomic: true });
  assert.equal(store.loadToolContract(identifier), null, 'malformed replacement fails closed to no opinion');

  const fixed = JSON.stringify(record(identifier, 'C'), null, 2);
  runExternalReplacement({ file, bytes: fixed, atomic: true });
  assert.equal((store.loadToolContract(identifier)?.schema as { title?: string }).title, 'C',
    'a later valid replacement invalidates cached malformed-null state');

  runExternalReplacement({ file, remove: true });
  assert.equal(existsSync(file), false);
  assert.equal(store.loadToolContract(identifier), null, 'deletion cannot serve the last cached contract');
});

test('byte budget evicts LRU entries even when the count ceiling is not reached', () => {
  for (let index = 0; index < 12; index += 1) {
    writeDirect(`BYTE_BUDGET_TOOL_${index}`, 'A');
  }
  assert.equal(typeof cacheControls._setToolContractFileCacheByteBudgetForTests, 'function');
  cacheControls._setToolContractFileCacheByteBudgetForTests!(4_096);
  assert.equal(scanStore(), 12, 'eviction never changes the current validated scan result');
  const bounded = stats();
  assert.equal(bounded.maxBytes, 4_096);
  assert.equal(bounded.bytes <= bounded.maxBytes, true);
  assert.equal(bounded.entries < 12, true, 'byte pressure evicts before the 2,000-entry ceiling');
});

test('parsed invalid records cache their permanent no-opinion verdict and file reader enforces TTL/fingerprint/output integrity', () => {
  mkdirSync(contractsDir, { recursive: true });
  const savedAt = new Date().toISOString();
  for (let index = 0; index < 2_000; index += 1) {
    const identifier = `INVALID_FINGERPRINT_TOOL_${String(index).padStart(4, '0')}`;
    const invalid = { ...record(identifier, 'A', savedAt), fingerprint: '0'.repeat(32) };
    writeFileSync(fileFor(identifier), JSON.stringify(invalid), 'utf8');
  }
  resetCache();
  assert.equal(scanStore(), 0);
  const afterFirst = stats();
  assert.equal(afterFirst.parses, 2_000);
  assert.equal(afterFirst.validations, 2_000);
  assert.equal(scanStore(), 0);
  const afterSecond = stats();
  assert.equal(afterSecond.parses, 2_000, 'invalid immutable bytes are not reparsed');
  assert.equal(afterSecond.validations, 2_000, 'permanent invalid verdict avoids repeated schema hashing');
  assert.equal(afterSecond.hits - afterFirst.hits, 2_000);

  store._clearToolContractsForTests();
  const expiredIdentifier = 'EXPIRED_FILE_READER_TOOL';
  const expired = record(
    expiredIdentifier,
    'A',
    new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString(),
  );
  writeFileSync(fileFor(expiredIdentifier), JSON.stringify(expired), 'utf8');
  assert.equal(store.readToolContractFile(path.basename(fileFor(expiredIdentifier))), null, 'TTL is enforced');

  const outputIdentifier = 'INVALID_OUTPUT_FILE_READER_TOOL';
  const invalidOutput = {
    ...record(outputIdentifier, 'A'),
    providerOutputSchemaObserved: true,
    providerOutputSchema: { type: 'object' },
    providerOutputSchemaDigest: 'bad-digest',
    providerOutputSchemaFingerprint: 'bad-fingerprint',
  };
  writeFileSync(fileFor(outputIdentifier), JSON.stringify(invalidOutput), 'utf8');
  assert.equal(store.readToolContractFile(path.basename(fileFor(outputIdentifier))), null, 'output identity is enforced');
});

test('cached time verdicts re-evaluate only when wall clock crosses their savedAt/expiry boundary', () => {
  const realDateNow = Date.now;
  const base = Date.parse('2026-08-25T12:00:00.000Z');
  try {
    const futureIdentifier = 'FUTURE_CACHE_TOOL';
    mkdirSync(contractsDir, { recursive: true });
    writeFileSync(
      fileFor(futureIdentifier),
      JSON.stringify(record(futureIdentifier, 'A', new Date(base + 1_000).toISOString())),
      'utf8',
    );
    resetCache();
    Date.now = () => base;
    assert.equal(store.loadToolContract(futureIdentifier), null);
    assert.equal(stats().validations, 1);
    assert.equal(store.loadToolContract(futureIdentifier), null);
    assert.equal(stats().validations, 1, 'future verdict is cached until savedAt');
    Date.now = () => base + 1_001;
    assert.ok(store.loadToolContract(futureIdentifier));
    assert.equal(stats().validations, 2, 'crossing savedAt performs the deferred structural validation once');

    store._clearToolContractsForTests();
    const expiredIdentifier = 'CLOCK_ROLLBACK_CACHE_TOOL';
    const savedAtMs = base - 31 * 24 * 60 * 60_000;
    writeFileSync(
      fileFor(expiredIdentifier),
      JSON.stringify(record(expiredIdentifier, 'A', new Date(savedAtMs).toISOString())),
      'utf8',
    );
    Date.now = () => base;
    assert.equal(store.loadToolContract(expiredIdentifier), null);
    assert.equal(stats().validations, 1);
    assert.equal(store.loadToolContract(expiredIdentifier), null);
    assert.equal(stats().validations, 1, 'expired verdict avoids repeated validation at the same clock');
    Date.now = () => savedAtMs + 29 * 24 * 60 * 60_000;
    assert.ok(store.loadToolContract(expiredIdentifier), 'clock rollback into the TTL window re-evaluates safely');
    assert.equal(stats().validations, 2);
  } finally {
    Date.now = realDateNow;
  }
});
