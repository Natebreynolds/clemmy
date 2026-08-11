#!/usr/bin/env node
import {
  compareSessions,
  formatSessionComparison,
  parseSessionComparisonArgs,
} from './session-comparison.js';

const USAGE = `Usage:
  npm run measure:sessions -- --baseline <session-id> --candidate <session-id> [--home <CLEMENTINE_HOME>]

Reads state/harness.db in SQLite readonly mode and reads token-usage NDJSON.
It never creates, migrates, repairs, or appends to either store.`;

try {
  const args = parseSessionComparisonArgs(process.argv.slice(2));
  if ('help' in args) {
    console.log(USAGE);
  } else {
    console.log(formatSessionComparison(compareSessions(args)).trimEnd());
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(USAGE);
  process.exitCode = 1;
}

