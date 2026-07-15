import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  MEMORY_SCHEMA_VERSION,
  migrateMemoryDatabaseHandle,
} from './db.js';
import {
  autoReconcileStrongEntityIdentifiersInDatabase,
  type EntityIdentifierReconciliationResult,
} from './entity-identity.js';
import {
  backfillGroundedFactEntityLinksInDatabase,
  backfillGroundedFactResourceLinksInDatabase,
  type GroundedFactEntityBackfillStats,
  type GroundedFactResourceBackfillStats,
} from './relations.js';
import {
  auditMemoryReadiness,
  formatMemoryReadinessReport,
  type MemoryReadinessReport,
} from './readiness.js';
import {
  backfillLegacyReflectionCandidatesInDatabase,
  type LegacyReflectionCandidateBackfillResult,
} from './reflection-candidates.js';
import { reapExpiredPendingReflectionsInDatabase } from './temporal-memory.js';

export interface MemoryMigrationInventory {
  facts: number;
  episodes: number;
  evidenceLinks: number;
  entities: number;
  factEntityLinks: number;
  resources: number;
  factResourceLinks: number;
}

export interface MemoryMigrationAuditSummary {
  action: string;
  affectedRows: number;
}

export interface MemoryMigrationRehearsalReport {
  reportVersion: 1;
  generatedAt: string;
  mode: 'read-only-source-copy-migration';
  ready: boolean;
  source: {
    path: string;
    schemaVersionBefore: number | null;
    schemaVersionAfter: number | null;
    bytesBefore: number;
    bytesAfter: number;
    sha256Before: string;
    sha256After: string;
    observedUnchanged: boolean;
    inventory: MemoryMigrationInventory;
  };
  copy: {
    path: string | null;
    deleted: boolean;
    schemaVersionBefore: number | null;
    schemaVersionAfter: number | null;
    migrationsApplied: number[];
    inventoryBefore: MemoryMigrationInventory;
    inventoryAfter: MemoryMigrationInventory;
    integrityMessages: string[];
    foreignKeyViolations: number;
    migrationAudit: MemoryMigrationAuditSummary[];
    preservation: {
      canonicalRowsPreserved: boolean;
      factEntityLinkDelta: number;
      factResourceLinkDelta: number;
    };
  };
  migration: {
    success: boolean;
    error: string | null;
    elapsedMs: number;
    identityReconciliation: EntityIdentifierReconciliationResult | null;
    groundedFactEntityBackfill: GroundedFactEntityBackfillStats | null;
    groundedFactResourceBackfill: GroundedFactResourceBackfillStats | null;
    legacyReflectionBackfill: LegacyReflectionCandidateBackfillResult | null;
    expiredLegacyReflectionBatches: number;
  };
  readiness: MemoryReadinessReport;
}

export interface RehearseMemoryMigrationOptions {
  /** Retain the disposable migrated copy so an operator can inspect it. */
  keepCopy?: boolean;
  /** Override only for deterministic tests/reporting. */
  now?: string;
}

const INVENTORY_TABLES = {
  facts: 'consolidated_facts',
  episodes: 'memory_episodes',
  evidenceLinks: 'fact_evidence',
  entities: 'entities',
  factEntityLinks: 'fact_entities',
  resources: 'resource_pointers',
  factResourceLinks: 'fact_resources',
} as const;

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function schemaVersion(db: Database.Database): number | null {
  if (!tableExists(db, 'schema_version')) return null;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null };
  return row.version == null ? 0 : Number(row.version);
}

function migrationVersions(db: Database.Database): number[] {
  if (!tableExists(db, 'schema_version')) return [];
  return (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>)
    .map((row) => Number(row.version));
}

function inventory(db: Database.Database): MemoryMigrationInventory {
  const result = {} as MemoryMigrationInventory;
  for (const [key, table] of Object.entries(INVENTORY_TABLES) as Array<
    [keyof MemoryMigrationInventory, string]
  >) {
    result[key] = tableExists(db, table)
      ? Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
      : 0;
  }
  return result;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function migrationAudit(db: Database.Database): MemoryMigrationAuditSummary[] {
  if (!tableExists(db, 'memory_migration_audit')) return [];
  return (db.prepare(`
    SELECT action, SUM(affected_rows) AS affected_rows
    FROM memory_migration_audit
    GROUP BY action
    ORDER BY action
  `).all() as Array<{ action: string; affected_rows: number }>).map((row) => ({
    action: row.action,
    affectedRows: Number(row.affected_rows),
  }));
}

/**
 * Rehearse the exact production migration path without opening the source in
 * write mode. SQLite's backup API snapshots committed WAL state into a
 * temporary database; migrations and readiness checks run only on that copy.
 */
export async function rehearseMemoryMigration(
  databasePath: string,
  options: RehearseMemoryMigrationOptions = {},
): Promise<MemoryMigrationRehearsalReport> {
  const started = Date.now();
  const generatedAt = options.now ?? new Date().toISOString();
  const sourcePath = path.resolve(databasePath);
  if (!existsSync(sourcePath)) throw new Error(`Memory database does not exist: ${sourcePath}`);

  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'clementine-memory-migration-'));
  const copyPath = path.join(tempDirectory, 'memory-rehearsal.db');
  const sourceBytesBefore = statSync(sourcePath).size;
  const sourceShaBefore = await sha256File(sourcePath);
  let sourceDb: Database.Database | null = null;
  let copyDb: Database.Database | null = null;

  try {
    sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
    sourceDb.pragma('query_only = ON');
    const sourceSchemaBefore = schemaVersion(sourceDb);
    const sourceInventory = inventory(sourceDb);

    // `backup` is a consistent SQLite snapshot and includes transactions that
    // have committed to WAL without checkpointing or mutating the source.
    await sourceDb.backup(copyPath);
    sourceDb.close();
    sourceDb = null;

    copyDb = new Database(copyPath, { fileMustExist: true });
    copyDb.pragma('foreign_keys = ON');
    copyDb.pragma('busy_timeout = 5000');
    const copySchemaBefore = schemaVersion(copyDb);
    const copyInventoryBefore = inventory(copyDb);
    const versionsBefore = new Set(migrationVersions(copyDb));
    let migrationSuccess = false;
    let migrationError: string | null = null;
    let identityReconciliation: EntityIdentifierReconciliationResult | null = null;
    let groundedFactEntityBackfill: GroundedFactEntityBackfillStats | null = null;
    let groundedFactResourceBackfill: GroundedFactResourceBackfillStats | null = null;
    let legacyReflectionBackfill: LegacyReflectionCandidateBackfillResult | null = null;
    let expiredLegacyReflectionBatches = 0;

    try {
      migrateMemoryDatabaseHandle(copyDb);
      // First upgraded boot projects exact pre-v26 extractor buffers into the
      // claim-level ledger before bounded expiry. Rehearse that deterministic
      // projection on the copy so readiness reports the real post-boot review
      // queue instead of an impossible freshly-migrated zero.
      legacyReflectionBackfill = backfillLegacyReflectionCandidatesInDatabase(copyDb);
      expiredLegacyReflectionBatches = reapExpiredPendingReflectionsInDatabase(copyDb, generatedAt);
      // The installed daemon performs this same exact-identifier finalization
      // after creating a reversible backup. A rehearsal copy is already
      // disposable, so run it directly and audit the resulting redirects.
      identityReconciliation = autoReconcileStrongEntityIdentifiersInDatabase(copyDb, 10_000);
      // The installed daemon performs this backup-first immediately after an
      // upgrade. Rehearse it on the same disposable copy so stored-truth graph
      // coverage is proven before release, not deferred to a nightly job.
      groundedFactEntityBackfill = backfillGroundedFactEntityLinksInDatabase(copyDb, { factLimit: 50_000 });
      groundedFactResourceBackfill = backfillGroundedFactResourceLinksInDatabase(copyDb, { factLimit: 50_000 });
      migrationSuccess = true;
    } catch (error) {
      migrationError = errorMessage(error);
    }

    const copySchemaAfter = schemaVersion(copyDb);
    const copyInventoryAfter = inventory(copyDb);
    const migrationsApplied = migrationVersions(copyDb).filter((version) => !versionsBefore.has(version));
    const integrityMessages = (copyDb.pragma('integrity_check') as Array<{ integrity_check: string }>)
      .map((row) => row.integrity_check);
    const foreignKeyViolations = (copyDb.pragma('foreign_key_check') as unknown[]).length;
    const auditRows = migrationAudit(copyDb);
    copyDb.close();
    copyDb = null;

    const readiness = auditMemoryReadiness(copyPath, {
      now: generatedAt,
      expectedSchemaVersion: MEMORY_SCHEMA_VERSION,
    });
    const sourceBytesAfter = statSync(sourcePath).size;
    const sourceShaAfter = await sha256File(sourcePath);

    // Reopen read-only after the whole rehearsal. This catches accidental
    // schema mutation even if an external writer changed the file fingerprint.
    sourceDb = new Database(sourcePath, { readonly: true, fileMustExist: true });
    sourceDb.pragma('query_only = ON');
    const sourceSchemaAfter = schemaVersion(sourceDb);
    sourceDb.close();
    sourceDb = null;

    const integrityOk = integrityMessages.length === 1 && integrityMessages[0] === 'ok';
    const sourceObservedUnchanged = sourceBytesBefore === sourceBytesAfter
      && sourceShaBefore === sourceShaAfter
      && sourceSchemaBefore === sourceSchemaAfter;
    const canonicalRowsPreserved = copyInventoryAfter.facts === copyInventoryBefore.facts
      && copyInventoryAfter.episodes === copyInventoryBefore.episodes
      && copyInventoryAfter.evidenceLinks === copyInventoryBefore.evidenceLinks
      && copyInventoryAfter.entities === copyInventoryBefore.entities
      && copyInventoryAfter.resources === copyInventoryBefore.resources;
    const keepCopy = options.keepCopy ?? false;

    const report: MemoryMigrationRehearsalReport = {
      reportVersion: 1,
      generatedAt,
      mode: 'read-only-source-copy-migration',
      ready: migrationSuccess
        && integrityOk
        && foreignKeyViolations === 0
        && canonicalRowsPreserved
        && sourceObservedUnchanged
        && readiness.ready,
      source: {
        path: sourcePath,
        schemaVersionBefore: sourceSchemaBefore,
        schemaVersionAfter: sourceSchemaAfter,
        bytesBefore: sourceBytesBefore,
        bytesAfter: sourceBytesAfter,
        sha256Before: sourceShaBefore,
        sha256After: sourceShaAfter,
        observedUnchanged: sourceObservedUnchanged,
        inventory: sourceInventory,
      },
      copy: {
        path: keepCopy ? copyPath : null,
        deleted: !keepCopy,
        schemaVersionBefore: copySchemaBefore,
        schemaVersionAfter: copySchemaAfter,
        migrationsApplied,
        inventoryBefore: copyInventoryBefore,
        inventoryAfter: copyInventoryAfter,
        integrityMessages,
        foreignKeyViolations,
        migrationAudit: auditRows,
        preservation: {
          canonicalRowsPreserved,
          factEntityLinkDelta: copyInventoryAfter.factEntityLinks - copyInventoryBefore.factEntityLinks,
          factResourceLinkDelta: copyInventoryAfter.factResourceLinks - copyInventoryBefore.factResourceLinks,
        },
      },
      migration: {
        success: migrationSuccess,
        error: migrationError,
        elapsedMs: Date.now() - started,
        identityReconciliation,
        groundedFactEntityBackfill,
        groundedFactResourceBackfill,
        legacyReflectionBackfill,
        expiredLegacyReflectionBatches,
      },
      readiness,
    };

    if (!keepCopy) rmSync(tempDirectory, { recursive: true, force: true });
    return report;
  } catch (error) {
    try { if (sourceDb?.open) sourceDb.close(); } catch { /* best effort */ }
    try { if (copyDb?.open) copyDb.close(); } catch { /* best effort */ }
    rmSync(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function formatMemoryMigrationRehearsalReport(report: MemoryMigrationRehearsalReport): string {
  const lines = [
    `Memory migration rehearsal: ${report.ready ? 'READY' : 'WITHHELD'}`,
    `Source: ${report.source.path}`,
    `Mode: ${report.mode}`,
    `Source schema: ${report.source.schemaVersionBefore ?? 'unknown'} -> ${report.source.schemaVersionAfter ?? 'unknown'} (source ${report.source.observedUnchanged ? 'unchanged' : 'changed during observation'})`,
    `Copy schema: ${report.copy.schemaVersionBefore ?? 'unknown'} -> ${report.copy.schemaVersionAfter ?? 'unknown'} (expected ${MEMORY_SCHEMA_VERSION})`,
    `Migrations applied on copy: ${report.copy.migrationsApplied.join(', ') || 'none'}`,
    `Copy integrity: ${report.copy.integrityMessages.join('; ')}; foreign-key violations: ${report.copy.foreignKeyViolations}`,
    `Canonical rows: ${report.copy.preservation.canonicalRowsPreserved ? 'preserved' : 'changed unexpectedly'}; fact/entity link delta ${report.copy.preservation.factEntityLinkDelta}, fact/resource link delta ${report.copy.preservation.factResourceLinkDelta}`,
    `Copy: ${report.copy.deleted ? 'deleted after rehearsal' : report.copy.path}`,
    `Migration: ${report.migration.success ? 'succeeded' : `failed — ${report.migration.error ?? 'unknown error'}`}`,
    `Identity finalization: ${report.migration.identityReconciliation ? `${report.migration.identityReconciliation.groupsMerged} group(s) merged, ${report.migration.identityReconciliation.entitiesRedirected} redirect(s)` : 'not run'}`,
    `Legacy claim ledger: ${report.migration.legacyReflectionBackfill ? `${report.migration.legacyReflectionBackfill.candidatesInserted} candidate(s) projected from ${report.migration.legacyReflectionBackfill.batchesBackfilled} extraction batch(es), ${report.migration.expiredLegacyReflectionBatches} expired` : 'not run'}`,
    `Grounded graph backfill: ${report.migration.groundedFactEntityBackfill ? `${report.migration.groundedFactEntityBackfill.promoted} fact/entity link(s) promoted` : 'fact/entity not run'}; ${report.migration.groundedFactResourceBackfill ? `${report.migration.groundedFactResourceBackfill.promoted} fact/resource link(s) promoted` : 'fact/resource not run'} from surviving excerpts`,
    '',
    formatMemoryReadinessReport(report.readiness),
  ];
  return lines.join('\n');
}
