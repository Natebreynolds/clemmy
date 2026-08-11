import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { auditMemoryReadiness, type MemoryReadinessReport } from './readiness.js';

interface ForeignKeyViolationRow {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

interface ForeignKeyDefinitionRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

export interface MemoryForeignKeyRepairFinding {
  table: string;
  rowId: number | null;
  parent: string;
  foreignKeyId: number;
  childColumn: string | null;
  onDelete: string | null;
  repair: 'delete_orphan' | 'clear_reference' | null;
}

export interface MemoryForeignKeyRepairPlan {
  databasePath: string;
  readinessBefore: MemoryReadinessReport;
  safeToApply: boolean;
  reason: string;
  findings: MemoryForeignKeyRepairFinding[];
}

export interface MemoryForeignKeyRepairResult {
  databasePath: string;
  applied: boolean;
  repairedRows: number;
  backupPath: string | null;
  backupBytes: number;
  readinessBefore: MemoryReadinessReport;
  readinessAfter: MemoryReadinessReport;
}

type SafeRepair = 'delete_orphan' | 'clear_reference';

/**
 * Only actions already declared by the current schema are repairable. The
 * supersession self-reference predates an ON DELETE action, so it receives the
 * conservative equivalent of SET NULL: the retired fact remains retired and
 * only its impossible pointer is detached.
 */
const SAFE_FACT_REFERENCES = new Map<string, { column: string; onDelete: string; repair: SafeRepair }>([
  ['consolidated_facts', { column: 'superseded_by_fact_id', onDelete: 'NO ACTION', repair: 'clear_reference' }],
  ['entity_edge_evidence', { column: 'source_fact_id', onDelete: 'SET NULL', repair: 'clear_reference' }],
  ['entity_observations', { column: 'source_fact_id', onDelete: 'SET NULL', repair: 'clear_reference' }],
  ['fact_embeddings', { column: 'fact_id', onDelete: 'CASCADE', repair: 'delete_orphan' }],
  ['fact_entities', { column: 'fact_id', onDelete: 'CASCADE', repair: 'delete_orphan' }],
  ['fact_evidence', { column: 'fact_id', onDelete: 'CASCADE', repair: 'delete_orphan' }],
  ['fact_resources', { column: 'fact_id', onDelete: 'CASCADE', repair: 'delete_orphan' }],
  ['fact_validity_intervals', { column: 'fact_id', onDelete: 'CASCADE', repair: 'delete_orphan' }],
  ['memory_policies', { column: 'fact_id', onDelete: 'CASCADE', repair: 'delete_orphan' }],
  ['memory_reflection_candidates', { column: 'resulting_fact_id', onDelete: 'SET NULL', repair: 'clear_reference' }],
]);

function readinessCheck(report: MemoryReadinessReport, id: string) {
  return report.checks.find((item) => item.id === id);
}

function foreignKeyRows(db: Database.Database): ForeignKeyViolationRow[] {
  return db.pragma('foreign_key_check') as ForeignKeyViolationRow[];
}

function classifyFinding(
  db: Database.Database,
  row: ForeignKeyViolationRow,
): MemoryForeignKeyRepairFinding {
  const safe = SAFE_FACT_REFERENCES.get(row.table);
  let definition: ForeignKeyDefinitionRow | undefined;
  if (/^[a-z0-9_]+$/i.test(row.table)) {
    definition = (db.pragma(`foreign_key_list(${row.table})`) as ForeignKeyDefinitionRow[])
      .find((item) => item.id === row.fkid);
  }
  const matches = Boolean(
    safe
    && row.parent === 'consolidated_facts'
    && definition?.table === 'consolidated_facts'
    && definition.from === safe.column
    && definition.to === 'id'
    && definition.on_delete.toUpperCase() === safe.onDelete,
  );
  return {
    table: row.table,
    rowId: row.rowid,
    parent: row.parent,
    foreignKeyId: row.fkid,
    childColumn: definition?.from ?? null,
    onDelete: definition?.on_delete ?? null,
    repair: matches ? safe!.repair : null,
  };
}

/**
 * Produce a read-only repair plan for an explicitly named database. This is
 * the default CLI behavior: no implicit live path and no writes.
 */
export function inspectMemoryForeignKeyRepair(databasePath: string): MemoryForeignKeyRepairPlan {
  const resolvedPath = path.resolve(databasePath);
  const readinessBefore = auditMemoryReadiness(resolvedPath);
  const prerequisites = ['database_open', 'schema_current', 'sqlite_integrity'];
  const failedPrerequisite = prerequisites
    .map((id) => readinessCheck(readinessBefore, id))
    .find((item) => !item || item.status !== 'pass');
  if (failedPrerequisite) {
    return {
      databasePath: resolvedPath,
      readinessBefore,
      safeToApply: false,
      reason: `Repair refused because ${failedPrerequisite.label} is ${failedPrerequisite.status}.`,
      findings: [],
    };
  }

  const db = new Database(resolvedPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  try {
    const findings = foreignKeyRows(db).map((row) => classifyFinding(db, row));
    const unsafe = findings.filter((finding) => finding.repair === null);
    return {
      databasePath: resolvedPath,
      readinessBefore,
      safeToApply: unsafe.length === 0,
      reason: findings.length === 0
        ? 'No foreign-key violations; no repair is needed.'
        : unsafe.length > 0
          ? `${unsafe.length} violation(s) do not match a declared safe fact-delete action.`
          : `${findings.length} orphan(s) can be repaired by the schema-declared delete action.`,
      findings,
    };
  } finally {
    db.close();
  }
}

function backupDestination(databasePath: string, now: string): string {
  const dir = path.join(path.dirname(databasePath), 'backups', 'foreign-key-repair');
  mkdirSync(dir, { recursive: true });
  const stamp = now.replace(/[:.]/g, '-');
  let candidate = path.join(dir, `memory-before-fk-repair-${stamp}.db`);
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = path.join(dir, `memory-before-fk-repair-${stamp}-${suffix}.db`);
    suffix += 1;
  }
  return candidate;
}

function quoteSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function applyKnownRepairs(db: Database.Database): number {
  let changed = 0;
  for (const [table, action] of SAFE_FACT_REFERENCES) {
    if (action.repair === 'delete_orphan') {
      changed += Number(db.prepare(`
        DELETE FROM "${table}"
        WHERE "${action.column}" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM consolidated_facts parent
            WHERE parent.id = "${table}"."${action.column}"
          )
      `).run().changes ?? 0);
    } else {
      changed += Number(db.prepare(`
        UPDATE "${table}"
        SET "${action.column}" = NULL
        WHERE "${action.column}" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM consolidated_facts parent
            WHERE parent.id = "${table}"."${action.column}"
          )
      `).run().changes ?? 0);
    }
  }
  return changed;
}

/**
 * Backup-first, idempotent repair for orphan rows created by a hard fact delete
 * that ran with foreign-key enforcement disabled. Callers must provide an
 * explicit path and ensure the daemon/concurrent writers are stopped.
 */
export function repairMemoryForeignKeyOrphans(
  databasePath: string,
  options: { now?: string } = {},
): MemoryForeignKeyRepairResult {
  const plan = inspectMemoryForeignKeyRepair(databasePath);
  if (!plan.safeToApply) throw new Error(`Memory FK repair refused: ${plan.reason}`);
  if (plan.findings.length === 0) {
    return {
      databasePath: plan.databasePath,
      applied: false,
      repairedRows: 0,
      backupPath: null,
      backupBytes: 0,
      readinessBefore: plan.readinessBefore,
      readinessAfter: plan.readinessBefore,
    };
  }

  const db = new Database(plan.databasePath, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  let backupPath: string | null = null;
  let backupBytes = 0;
  try {
    // The snapshot is complete before BEGIN IMMEDIATE makes the first source
    // mutation. Failure to create or validate it aborts without changing data.
    backupPath = backupDestination(plan.databasePath, options.now ?? new Date().toISOString());
    db.exec(`VACUUM INTO '${quoteSqlString(backupPath)}'`);
    const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = backup.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error('pre-repair backup failed SQLite integrity_check');
      }
    } finally {
      backup.close();
    }
    backupBytes = statSync(backupPath).size;
    if (backupBytes <= 0) throw new Error('pre-repair backup is empty');

    db.pragma('foreign_keys = ON');
    db.exec('BEGIN IMMEDIATE');
    let repairedRows = 0;
    try {
      const lockedFindings = foreignKeyRows(db).map((row) => classifyFinding(db, row));
      if (lockedFindings.some((finding) => finding.repair === null)) {
        throw new Error('foreign-key findings changed and now include an unsafe violation');
      }
      repairedRows = applyKnownRepairs(db);
      const remaining = foreignKeyRows(db);
      if (remaining.length > 0) {
        throw new Error(`repair would leave ${remaining.length} foreign-key violation(s)`);
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw error;
    }
    db.close();

    const readinessAfter = auditMemoryReadiness(plan.databasePath);
    const fkAfter = readinessCheck(readinessAfter, 'foreign_key_integrity');
    if (!fkAfter || fkAfter.status !== 'pass') {
      throw new Error('repair committed but the read-only readiness audit still reports FK violations');
    }
    return {
      databasePath: plan.databasePath,
      applied: true,
      repairedRows,
      backupPath,
      backupBytes,
      readinessBefore: plan.readinessBefore,
      readinessAfter,
    };
  } finally {
    if (db.open) db.close();
  }
}
