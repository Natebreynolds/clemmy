/** The inventory core can observe an explicit read snapshot without application initialization. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { readInstallQuiescenceRead, type InstallQuiescenceReader } from './install-quiescence-read.js';

test('cold inventory core import cannot enter application initializers or create a home', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-install-read-cold-'));
  const home = path.join(temporary, 'must-stay-absent');
  const allowed = [
    'dashboard/install-quiescence-read.ts',
    'runtime/harness/host-checkpoint-state.ts', 'runtime/harness/host-interactive-consent-subject.ts',
    'runtime/harness/source-budget-policy-ref.ts', 'runtime/harness/source-approval-checkpoint-data.ts',
    'runtime/harness/host-connection-progress.ts', 'runtime/harness/conversation-protocol.ts',
    'runtime/harness/no-progress-governor.ts', 'shared/closed-canonical-json.ts',
  ];
  const loader = `
    import { fileURLToPath } from 'node:url';
    import path from 'node:path';
    const sourceRoot = ${JSON.stringify(path.join(root, 'src') + path.sep)};
    const allowed = new Set(${JSON.stringify(allowed)});
    export async function resolve(specifier, context, next) {
      const result = await next(specifier, context);
      if (result.url.startsWith('file:')) {
        const filename = fileURLToPath(result.url);
        if (filename.startsWith(sourceRoot) && !allowed.has(filename.slice(sourceRoot.length).split(path.sep).join('/'))) {
          throw new Error('blocked application import: ' + filename.slice(sourceRoot.length));
        }
        if (filename.split(path.sep).join('/').includes('/node_modules/@openai/')) throw new Error('blocked provider import');
      }
      return result;
    }`;
  const run = (entry: string, negative: boolean) => spawnSync(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', `
      import { register } from 'node:module';
      import { existsSync } from 'node:fs';
      register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(loader))}, import.meta.url);
      try {
        const loaded = await import(${JSON.stringify(entry)});
        if (${negative}) throw new Error('guard admitted application wrapper');
        if (typeof loaded.readInstallQuiescenceRead !== 'function') throw new Error('inventory core not loaded');
      } catch (error) {
        if (!${negative} || !String(error).includes('blocked application import')) throw error;
      }
      if (existsSync(${JSON.stringify(home)})) throw new Error('import initialized an application home');
    `], { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, CLEMENTINE_HOME: home } });
  try {
    const positive = run(pathToFileURL(path.join(root, 'src/dashboard/install-quiescence-read.ts')).href, false);
    assert.equal(positive.status, 0, `${positive.stderr}\n${positive.stdout}`);
    const negative = run(pathToFileURL(path.join(root, 'src/dashboard/install-quiescence.ts')).href, true);
    assert.equal(negative.status, 0, `${negative.stderr}\n${negative.stdout}`);
    assert.equal(existsSync(home), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('an unavailable supplied database remains unverified and nonzero without touching another dependency', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-install-read-failure-'));
  const base = path.join(temporary, 'uninitialized');
  let accesses = 0;
  const values = {
    BASE_DIR: base,
    WORKFLOW_RUNS_DIR: path.join(base, 'workflow-runs'),
    database: () => { accesses++; throw new Error('controlled database unavailable'); },
  };
  const reader = new Proxy(values, {
    get(target, key) {
      if (Object.hasOwn(target, key)) return target[key as keyof typeof target];
      throw new Error('unavailable snapshot must not continue into another callback');
    },
  }) as unknown as InstallQuiescenceReader;
  try {
    const result = readInstallQuiescenceRead({ nowMs: 1_000 }, reader);
    assert.equal(accesses, 1);
    assert.equal(result.quiescence.state, 'unverified');
    assert.equal(result.total, 1);
    assert.equal(result.currentWork.total, 0);
    assert.deepEqual(result.quiescence.issues, ['execution_inventory_unreadable']);
    assert.equal(existsSync(base), false, 'an observational failure must not initialize the selected paths');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('an invalid clock or inventory bound cannot observe stores or report idle', () => {
  const reader = new Proxy({}, { get() { throw new Error('invalid options must not observe dependencies'); } }) as InstallQuiescenceReader;
  for (const [options, issue] of [
    [{ nowMs: Number.NaN }, 'clock_unavailable'],
    [{ nowMs: 1_000, maxEntries: Number.NaN }, 'inventory_bound_invalid'],
  ] as const) {
    const result = readInstallQuiescenceRead(options, reader);
    assert.equal(result.quiescence.state, 'unverified');
    assert.equal(result.total, 1);
    assert.deepEqual(result.quiescence.issues, [issue]);
  }
});
