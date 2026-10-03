#!/usr/bin/env node
import {
  compareAcceptedTurns,
  compareAcceptedTasks,
  formatAcceptedTurnComparison,
  formatAcceptedTaskComparison,
  parseMeasurementComparisonArgs,
} from './session-comparison.js';

const USAGE = `Usage:
  npm run measure:turns -- --baseline-session <id> --baseline-source <event-seq> \\
    --candidate-session <id> --candidate-source <event-seq> [--home <CLEMENTINE_HOME>] [--scope turn|task]

Reads state/harness.db in SQLite readonly mode and token-usage NDJSON.
Exact usage requires the canonical accepted-source trace; legacy window rows
remain visible but are explicitly uncertified. Nothing is created or mutated.
Default turn scope preserves accepted-turn accounting. Explicit --scope task
unions the root and durably proved approval continuations, includes their worker
and review usage once, and reports unproved cost and recorded waits separately.`;

try {
  const args = parseMeasurementComparisonArgs(process.argv.slice(2));
  if ('help' in args) {
    console.log(USAGE);
  } else {
    console.log((args.scope === 'task'
      ? formatAcceptedTaskComparison(compareAcceptedTasks(args))
      : formatAcceptedTurnComparison(compareAcceptedTurns(args))).trimEnd());
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(USAGE);
  process.exitCode = 1;
}
