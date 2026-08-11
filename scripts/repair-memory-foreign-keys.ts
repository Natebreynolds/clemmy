#!/usr/bin/env tsx
import {
  inspectMemoryForeignKeyRepair,
  repairMemoryForeignKeyOrphans,
} from '../src/memory/foreign-key-repair.js';
import { formatMemoryReadinessReport } from '../src/memory/readiness.js';

function readArg(name: string): string | undefined {
  const prefixed = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (prefixed) return prefixed.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const databasePath = readArg('db');
const apply = process.argv.includes('--apply');
const exclusive = process.argv.includes('--exclusive');
const json = process.argv.includes('--json');

if (!databasePath) {
  console.error('Usage: npm run repair:memory-fk -- --db /path/to/memory.db [--apply --exclusive] [--json]');
  console.error('Dry-run is the default. The database path is mandatory; live memory is never selected implicitly.');
  process.exitCode = 2;
} else {
  const plan = inspectMemoryForeignKeyRepair(databasePath);
  if (!apply) {
    if (json) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.log(`Memory FK repair dry run: ${plan.databasePath}`);
      console.log(plan.reason);
      for (const finding of plan.findings) {
        console.log(
          `- ${finding.table} rowid=${finding.rowId ?? 'n/a'} `
          + `${finding.childColumn ?? '?'} -> ${finding.parent} `
          + `[${finding.onDelete ?? 'unknown'}] ${finding.repair ?? 'UNSAFE'}`,
        );
      }
      if (plan.findings.length > 0 && plan.safeToApply) {
        console.log('No changes made. Stop the daemon, then re-run with --apply --exclusive.');
      }
    }
    if (!plan.safeToApply) process.exitCode = 1;
  } else if (!exclusive) {
    console.error('Apply refused: --exclusive confirms the daemon and every other writer are stopped.');
    process.exitCode = 2;
  } else {
    const result = repairMemoryForeignKeyOrphans(databasePath);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (!result.applied) {
      console.log(`No repair needed: ${result.databasePath}`);
    } else {
      console.log(`Repaired ${result.repairedRows} orphan row(s).`);
      console.log(`Pre-repair backup: ${result.backupPath} (${result.backupBytes} bytes)`);
      console.log(formatMemoryReadinessReport(result.readinessAfter));
    }
  }
}
