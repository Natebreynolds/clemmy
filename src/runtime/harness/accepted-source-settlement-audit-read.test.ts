/** The observational audit core must not initialize the application. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { auditAcceptedSourceSettlementTruthRead, type AcceptedSourceSettlementAuditReader } from './accepted-source-settlement-audit-read.js';

test('cold read-core import cannot open runtime stores or initialize an application home', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-settlement-read-cold-'));
  const home = path.join(temporary, 'must-stay-absent');
  const allowed = ['runtime/harness/accepted-source-settlement-audit-read.ts',
    'runtime/harness/accepted-source-kind.ts', 'runtime/harness/runtime-tool-identity.ts'];
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
        const normalized = filename.split(path.sep).join('/');
        if (normalized.includes('/node_modules/better-sqlite3/') || normalized.includes('/node_modules/@openai/')) throw new Error('blocked store/provider import');
      }
      return result;
    }`;
  const run = (entry: string, negative: boolean) => spawnSync(process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', `
      import { register } from 'node:module';
      import { existsSync } from 'node:fs';
      register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(loader))}, import.meta.url);
      try {
        const module = await import(${JSON.stringify(entry)});
        if (${negative}) throw new Error('guard admitted application wrapper');
        if (typeof module.auditAcceptedSourceSettlementTruthRead !== 'function') throw new Error('read entry not loaded');
      } catch (error) {
        if (!${negative} || !String(error).includes('blocked application import')) throw error;
      }
      if (existsSync(${JSON.stringify(home)})) throw new Error('import created application home');
    `], { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, CLEMENTINE_HOME: home } });
  try {
    const positive = run(pathToFileURL(path.join(root, 'src/runtime/harness/accepted-source-settlement-audit-read.ts')).href, false);
    assert.equal(positive.status, 0, `${positive.stderr}\n${positive.stdout}`);
    const negative = run(pathToFileURL(path.join(root, 'src/runtime/harness/accepted-source-settlement-audit.ts')).href, true);
    assert.equal(negative.status, 0, `${negative.stderr}\n${negative.stdout}`);
    assert.equal(existsSync(home), false);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

test('an unavailable supplied read snapshot remains storage_error rather than clean or empty success', () => {
  let accesses = 0;
  const reader = new Proxy({ database: () => { accesses++; throw new Error('controlled read snapshot unavailable'); } }, {
    get(target, key) {
      if (key === 'database') return target.database;
      throw new Error('read failure must not continue into another dependency');
    },
  }) as unknown as AcceptedSourceSettlementAuditReader;
  const result = auditAcceptedSourceSettlementTruthRead({ sessionId: 'controlled-read-source', sourceUserSeq: 1 }, reader);
  assert.equal(accesses, 1);
  assert.equal(result.status, 'storage_error');
  assert.match(result.reason, /controlled read snapshot unavailable/);
  assert.equal(result.facts.successfulBusinessSettlements, 0);
});
