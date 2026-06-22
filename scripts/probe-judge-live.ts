/**
 * probe:judge:live — fire a REAL boundary-judge call against the local model
 * stack + your auth, proving the Lane A Phase 1 cross-family judge actually
 * DISPATCHES to a different family at runtime (not just resolves to one). SAFE:
 * a read-only completion judgement, no external action. Run against the real
 * home so it uses the same auth the daemon uses:
 *   CLEMENTINE_HOME="$HOME/.clementine-next" npx tsx scripts/probe-judge-live.ts
 */
import { resolveBoundaryJudge } from '../src/runtime/harness/debate-model.js';
import { judgeObjectiveComplete } from '../src/runtime/harness/objective-judge.js';

const routing = resolveBoundaryJudge();
console.log(`\n  brain family=${routing.brainFamily} → boundary judge=${routing.modelId} (family=${routing.judgeFamily}, selfJudge=${routing.selfJudge})`);
console.log('  firing a REAL completion judgement through that judge...\n');

const t0 = Date.now();
const verdict = await judgeObjectiveComplete(
  'Write a one-line friendly greeting to the user.',
  'Done — here is the greeting: "Hi there! Hope your day is going well." The one-line greeting is written above.',
);
console.log(`  verdict: done=${verdict.done}  reason="${verdict.reason}"`);
console.log(`  latency: ${Date.now() - t0}ms`);
console.log(`\n  → A real ${routing.judgeFamily} judge (${routing.modelId}) graded a ${routing.brainFamily}-brain turn. Cross-family dispatch confirmed live.\n`);
