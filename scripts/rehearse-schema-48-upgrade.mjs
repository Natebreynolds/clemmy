#!/usr/bin/env node
/**
 * Disposable rehearsal of a production-shaped schema-45 database through the
 * actual openEventLog / configureHarnessRuntime / configureTypedExecutionRuntime
 * path. The live home is never opened with SQLite: a nonempty WAL refuses the
 * rehearsal, and an empty WAL makes a byte-copy of the main database a
 * transactionally consistent snapshot. Opening the live file would mutate -shm.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const liveHome = path.join(os.homedir(), '.clementine-next');
const liveDb = path.join(liveHome, 'state', 'harness.db');
const rehearsal = mkdtempSync(path.join(os.tmpdir(), 'clem-schema48-rehearsal-'));
const stateDir = path.join(rehearsal, 'state');
mkdirSync(stateDir, { recursive: true });
const copyDb = path.join(stateDir, 'harness.db');
writeFileSync(path.join(stateDir, 'machine-id'), 'rehearsal-machine\n');

function sha256File(filePath) {
  if (!existsSync(filePath)) return null;
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function fileMeta(filePath) {
  if (!existsSync(filePath)) return null;
  const st = statSync(filePath);
  return { sha256: sha256File(filePath), mtimeNs: st.mtimeNs, mtimeMs: st.mtimeMs, size: st.size };
}

function inspect(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const schema = db.prepare(
      `SELECT MIN(version) AS minVersion, MAX(version) AS maxVersion, COUNT(*) AS versionCount FROM schema_version`,
    ).get();
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all()
      .map((row) => row.name);
    const manifests = tables.includes('capability_manifests')
      ? db.prepare(`SELECT manifest_id AS manifestId, digest, lifecycle FROM capability_manifests`).all()
      : [];
    const plaintextPayload = tables.includes('physical_dispatch_authority_payload')
      ? db.prepare(`SELECT COUNT(*) AS n FROM physical_dispatch_authority_payload WHERE authority_json LIKE '%canonicalArgs%'`).get().n
      : 0;
    const plaintextAuthority = tables.includes('physical_dispatch_authority')
      ? (() => {
          const columns = new Set(
            db.prepare('PRAGMA table_info(physical_dispatch_authority)').all().map((row) => row.name),
          );
          if (!columns.has('authority_json')) return 0;
          return db.prepare(`SELECT COUNT(*) AS n FROM physical_dispatch_authority WHERE authority_json LIKE '%canonicalArgs%'`).get().n;
        })()
      : 0;
    return {
      schema,
      tables,
      manifests,
      plaintextPayloads: plaintextPayload,
      plaintextAuthority,
    };
  } finally {
    db.close();
  }
}

function sameManifestIds(before, after) {
  const beforeIds = new Set(before.map((row) => row.manifestId));
  for (const row of after) {
    if (!beforeIds.has(row.manifestId)) continue;
    const prior = before.find((entry) => entry.manifestId === row.manifestId);
    if (prior && prior.digest !== row.digest && prior.lifecycle === row.lifecycle) return false;
  }
  return true;
}

const liveBefore = {
  db: fileMeta(liveDb),
  wal: fileMeta(`${liveDb}-wal`),
  shm: fileMeta(`${liveDb}-shm`),
};

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
}

const report = {
  liveHome,
  rehearsalHome: rehearsal,
  copied: false,
  before: null,
  afterMigration: null,
  afterConfigure: null,
  catalogReadyFirst: null,
  catalogReadySecond: null,
  refusalsFirst: [],
  refusalsSecond: [],
  supersession: null,
  restartIdempotent: null,
  interruptedRecovered: null,
  liveUntouched: null,
  checks,
  rollback: 'discard the rehearsal directory; restore the pre-rehearsal backup if a live apply is later authorized',
  error: null,
};

try {
  if (!existsSync(liveDb)) {
    report.error = 'live harness.db is missing; rehearsal skipped';
  } else if ((liveBefore.wal?.size ?? 0) > 0) {
    report.error = 'live WAL is nonempty; refusing to copy an inconsistent snapshot or open the live database';
  } else {
    copyFileSync(liveDb, copyDb);
    report.copied = true;
    report.before = inspect(copyDb);
    const beforeMax = report.before.schema?.maxVersion ?? null;

    process.env.CLEMENTINE_HOME = rehearsal;
    process.env.HOME = rehearsal;
    process.env.CLEMENTINE_PRODUCTION_CATALOG = '1';
    process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
    process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
    process.env.CLEMMY_AUTHORITY_SEAL_KEY = process.env.CLEMMY_AUTHORITY_SEAL_KEY || 'ab'.repeat(32);
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'OPENAI_API_KEY',
      'COMPOSIO_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]) {
      delete process.env[key];
    }

    const eventlog = await import('../src/runtime/harness/eventlog.ts');
    const db = eventlog.openEventLog();
    eventlog.applyHarnessMigrations(db);
    report.afterMigration = inspect(copyDb);

    const runtime = await import('../src/runtime/semantic-boundary/configure-typed-execution-runtime.ts');
    const { configureHarnessRuntime } = await import('../src/runtime/harness/codex-client.ts');
    await configureHarnessRuntime();
    report.catalogReadyFirst = runtime.typedExecutionCatalogReady();
    report.refusalsFirst = [...runtime.typedExecutionCatalogRefusals()];
    runtime.configureTypedExecutionRuntime();
    report.catalogReadySecond = runtime.typedExecutionCatalogReady();
    report.refusalsSecond = [...runtime.typedExecutionCatalogRefusals()];
    report.afterConfigure = inspect(copyDb);

    const storeMod = await import('../src/runtime/harness/capability-manifest-store.ts');
    const manifestMod = await import('../src/runtime/harness/capability-manifest.ts');
    const store = storeMod.peekCapabilityManifestStore() ?? storeMod.resolveCapabilityManifestStore();
    const current = store.list().find((entry) => entry.manifest.lifecycle.state === 'current' && entry.manifest.effect === 'read');
    if (current) {
      const successor = manifestMod.attachSemanticContract({
        ...current.manifest,
        manifestId: `${current.manifest.manifestId}:v2`,
        definitionFingerprint: 'b'.repeat(64),
        lifecycle: { state: 'current' },
      });
      const first = storeMod.provisionVersionedCapabilityManifest(store, {
        predecessorId: current.manifest.manifestId,
        next: successor,
      });
      eventlog.closeEventLog();
      const reopened = eventlog.openEventLog();
      const restarted = storeMod.createCapabilityManifestStore([], { durable: true });
      const replay = storeMod.provisionVersionedCapabilityManifest(restarted, {
        predecessorId: current.manifest.manifestId,
        next: successor,
      });
      const fork = storeMod.provisionVersionedCapabilityManifest(restarted, {
        predecessorId: current.manifest.manifestId,
        next: manifestMod.attachSemanticContract({
          ...successor,
          manifestId: `${current.manifest.manifestId}:v3`,
          definitionFingerprint: 'c'.repeat(64),
        }),
      });
      const reinstall = restarted.install(current.manifest);
      report.supersession = {
        first: first.ok === true,
        replay: replay.ok === true && first.ok === true && replay.digest === first.digest,
        forkRefused: fork.ok === false,
        predecessorNotReinstalled: reinstall.ok === false,
      };
      report.restartIdempotent = report.supersession.replay === true;
      reopened.close?.();
    }

    const interrupted = path.join(rehearsal, 'interrupted.db');
    const src = new Database(copyDb);
    await src.backup(interrupted);
    src.close();
    const mid = new Database(interrupted);
    mid.prepare('DELETE FROM schema_version WHERE version = 48').run();
    mid.exec('DROP TABLE IF EXISTS physical_dispatch_authority_sealed');
    mid.close();
    const recovered = new Database(interrupted);
    eventlog.applyHarnessMigrations(recovered);
    const recoveredSchema = recovered.prepare(
      'SELECT MAX(version) AS version FROM schema_version',
    ).get();
    recovered.close();
    report.interruptedRecovered = recoveredSchema.version === 48;

    const firstRefusals = report.refusalsFirst.map((entry) => `${entry.manifestId}:${entry.reason}`).sort().join('|');
    const secondRefusals = report.refusalsSecond.map((entry) => `${entry.manifestId}:${entry.reason}`).sort().join('|');
    const after = report.afterConfigure ?? report.afterMigration;
    check('schema_45_to_48', beforeMax === 45 && after?.schema?.maxVersion === 48, {
      beforeMax,
      afterMax: after?.schema?.maxVersion ?? null,
    });
    check(
      'no_same_id_overwrite',
      sameManifestIds(report.before.manifests, after?.manifests ?? []),
      { before: report.before.manifests.length, after: after?.manifests.length ?? 0 },
    );
    check('ready_false_on_legacy_or_placeholder', report.catalogReadyFirst === false && report.catalogReadySecond === false, {
      first: report.catalogReadyFirst,
      second: report.catalogReadySecond,
    });
    check(
      'refusals_stable_across_configure',
      firstRefusals === secondRefusals && firstRefusals.length > 0,
      { first: report.refusalsFirst, second: report.refusalsSecond },
    );
    check(
      'placeholder_or_observation_refusal',
      report.refusalsSecond.some((entry) => entry.reason === 'placeholder_account' || entry.reason === 'observation_unavailable'),
      report.refusalsSecond,
    );
    check(
      'supersession_atomic_idempotent',
      report.supersession === null
        || (
          report.supersession.first === true
          && report.supersession.replay === true
          && report.supersession.forkRefused === true
          && report.supersession.predecessorNotReinstalled === true
        ),
      report.supersession,
    );
    check(
      'legacy_plaintext_scrubbed',
      (after?.plaintextPayloads ?? 0) === 0 && (after?.plaintextAuthority ?? 0) === 0,
      { payload: after?.plaintextPayloads, authority: after?.plaintextAuthority },
    );
    check('interrupted_migration_recovered', report.interruptedRecovered === true, {
      recovered: report.interruptedRecovered,
    });

    eventlog.closeEventLog();
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  const liveAfter = {
    db: fileMeta(liveDb),
    wal: fileMeta(`${liveDb}-wal`),
    shm: fileMeta(`${liveDb}-shm`),
  };
  const liveUntouched = liveBefore.db?.sha256 === liveAfter.db?.sha256
    && liveBefore.db?.size === liveAfter.db?.size
    && liveBefore.db?.mtimeNs === liveAfter.db?.mtimeNs
    && liveBefore.wal?.sha256 === liveAfter.wal?.sha256
    && liveBefore.wal?.size === liveAfter.wal?.size
    && liveBefore.wal?.mtimeNs === liveAfter.wal?.mtimeNs
    && liveBefore.shm?.sha256 === liveAfter.shm?.sha256
    && liveBefore.shm?.size === liveAfter.shm?.size
    && liveBefore.shm?.mtimeNs === liveAfter.shm?.mtimeNs;
  report.liveUntouched = liveUntouched;
  report.liveBefore = liveBefore;
  report.liveAfter = liveAfter;
  check('live_home_unchanged', liveUntouched === true, { liveBefore, liveAfter });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  rmSync(rehearsal, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
if (report.error || failed.length > 0) {
  process.stderr.write(`rehearsal failed: ${report.error ?? failed.map((entry) => entry.name).join(', ')}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
