/**
 * eval:promote — snapshot a failed session into the pending eval corpus, or list
 * what's pending (Lane A Phase 4b). Closes the loop: production failures become
 * candidate regression cases for the pass^k suite.
 *
 * Run: npx tsx scripts/eval-promote.ts <sessionId>   # snapshot one session
 *      npx tsx scripts/eval-promote.ts --list          # list pending cases
 */
import { snapshotFailureTrajectory, listPendingCorpus } from '../src/runtime/eval/eval-corpus-promote.js';

if (process.argv.includes('--list')) {
  const pending = listPendingCorpus();
  console.log(`\n  pending eval cases: ${pending.length}\n`);
  for (const c of pending) {
    console.log(`  ${c.id}  [${c.failureKinds.join(', ')}]  ${c.toolCount} tools  ${c.capturedAt}`);
  }
  console.log('');
} else {
  const sessionId = process.argv[2];
  if (!sessionId) { console.error('usage: tsx scripts/eval-promote.ts <sessionId> | --list'); process.exit(2); }
  const c = snapshotFailureTrajectory(sessionId);
  if (!c) { console.log(`\n  ${sessionId}: no real failure — not promoted.\n`); }
  else { console.log(`\n  promoted ${c.id}  [${c.failureKinds.join(', ')}]  ${c.spans.length} spans, ${c.toolCount} tools\n`); }
}
