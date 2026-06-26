/**
 * Repair and compact the task ledger.
 *
 * Dry run:
 *   npx tsx scripts/repair-completed-execution-task-ledger.ts
 *
 * Apply completed-owner repair:
 *   npx tsx scripts/repair-completed-execution-task-ledger.ts --apply
 *
 * Also close unowned stale rows with due dates on/before a cutoff:
 *   npx tsx scripts/repair-completed-execution-task-ledger.ts --close-unowned-before=2026-06-26 --apply
 */
import {
  formatTaskLedgerHygieneResult,
  runTaskLedgerHygiene,
} from '../src/tasks/task-ledger-hygiene.js';

const apply = process.argv.includes('--apply');
const closeUnownedBefore = process.argv
  .find((arg) => arg.startsWith('--close-unowned-before='))
  ?.split('=')[1];

const result = runTaskLedgerHygiene({ apply, closeUnownedBefore });
console.log(JSON.stringify(result, null, 2));
console.error(formatTaskLedgerHygieneResult(result));
