#!/usr/bin/env tsx
import {
  formatMemoryMigrationRehearsalReport,
  rehearseMemoryMigration,
} from '../src/memory/migration-rehearsal.js';

function readArg(name: string): string | undefined {
  const prefixed = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (prefixed) return prefixed.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const databasePath = readArg('db');
const json = process.argv.includes('--json');
const keepCopy = process.argv.includes('--keep-copy');

if (!databasePath) {
  console.error('Usage: npm run rehearse:memory -- --db /path/to/memory.db [--json] [--keep-copy]');
  console.error('The database path is required; the source is opened read-only and only a temporary copy is migrated.');
  process.exitCode = 2;
} else {
  try {
    const report = await rehearseMemoryMigration(databasePath, { keepCopy });
    console.log(json ? JSON.stringify(report, null, 2) : formatMemoryMigrationRehearsalReport(report));
    if (!report.ready) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
