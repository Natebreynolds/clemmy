#!/usr/bin/env tsx
import { auditMemoryReadiness, formatMemoryReadinessReport } from '../src/memory/readiness.js';

function readArg(name: string): string | undefined {
  const prefixed = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (prefixed) return prefixed.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const databasePath = readArg('db');
const json = process.argv.includes('--json');

if (!databasePath) {
  console.error('Usage: npm run audit:memory -- --db /path/to/memory.db [--json]');
  console.error('The database path is required so this command never silently targets live memory.');
  process.exitCode = 2;
} else {
  const report = auditMemoryReadiness(databasePath);
  console.log(json ? JSON.stringify(report, null, 2) : formatMemoryReadinessReport(report));
  if (!report.ready) process.exitCode = 1;
}
