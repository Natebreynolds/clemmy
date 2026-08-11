#!/usr/bin/env node
import {
  compareAcceptedTurns,
  formatAcceptedTurnComparison,
  parseAcceptedTurnComparisonArgs,
} from './session-comparison.js';

const USAGE = `Usage:
  npm run measure:turns -- --baseline-session <id> --baseline-source <event-seq> \\
    --candidate-session <id> --candidate-source <event-seq> [--home <CLEMENTINE_HOME>]

Reads state/harness.db in SQLite readonly mode and token-usage NDJSON.
Exact usage requires the canonical accepted-source trace; legacy window rows
remain visible but are explicitly uncertified. Nothing is created or mutated.`;

try {
  const args = parseAcceptedTurnComparisonArgs(process.argv.slice(2));
  if ('help' in args) {
    console.log(USAGE);
  } else {
    console.log(formatAcceptedTurnComparison(compareAcceptedTurns(args)).trimEnd());
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(USAGE);
  process.exitCode = 1;
}
