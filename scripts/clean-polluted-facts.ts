/**
 * clean-polluted-facts — recoverable cleanup of long-term FACT memory that was
 * polluted by harness/judge/stall/grounding/outcome re-prompts and one-off test
 * prompts being stored as pinned "Standing prohibition" facts and injected into
 * every chat + voice prompt (root-caused 2026-06-23). The write-time fix
 * (auto-capture harness guard) prevents recurrence; this removes what's already
 * there.
 *
 * SAFE by construction:
 *   - NEVER touches kind='constraint' (the dispatch-gate Scorpion rules) or a
 *     small explicit protected-id allowlist.
 *   - Matches only harness/test SIGNATURES (reuses isHarnessInjectedInput) — not
 *     genuine user preferences/prohibitions.
 *   - Soft-delete only: setFactPinned(false) + forgetFact() (recoverable via
 *     reactivateFact / memory_restore). Default --dry-run.
 *
 * Run: CLEMENTINE_HOME=~/.clementine-next npx tsx scripts/clean-polluted-facts.ts            (dry run)
 *      CLEMENTINE_HOME=~/.clementine-next npx tsx scripts/clean-polluted-facts.ts --apply    (soft-delete)
 */
import { listAllFacts, setFactPinned, forgetFact, type ConsolidatedFact } from '../src/memory/facts.js';
import { isHarnessInjectedInput } from '../src/runtime/harness/objective-judge.js';

const APPLY = process.argv.includes('--apply');

// Never touch these (the genuine standing constraints the dispatch gate needs).
const PROTECTED_IDS = new Set<number>([1144, 1145, 1348]);

// Auto-capture content labels — strip to recover the original message.
const LABEL_RE = /^(Standing prohibition|User preference|Standing product feedback|Clementine requirement|Connected-app context|User explicitly asked Clementine to remember|Standing constraint):\s*/i;

// Harness/test signatures that no genuine user preference would contain. Tight
// on purpose — false negatives (leaving a junk fact) are safer than removing a
// real one.
const SIGNATURES: RegExp[] = [
  /independent verification check found it is NOT finished/i, // judge not-done re-prompt
  /Your previous response was prose, not an action/i,
  /Your previous response could not be parsed into the required structured decision/i,
  /Re-issue it now as the exact decision object/i,
  /auto-resolved that approval question under YOLO/i,
  /Pick the needed (?:local|local, shell)/i,                 // stall-retry tail
  /\bThis was a gate test\b/i,
  /name your model family \(Claude, GPT, or GLM\)/i,         // this session's brain test
  /Read-only test\. Pick THREE/i,
  /You are running a durable Clementine background task/i,
  /Relay the outcome|just finished — continue from here/i,    // outcome relay
  /Workflow synthesis pass|^Step:\s|\bworkflow:\s.*\bstep:\s/i,
];

function strip(content: string): string {
  return content.replace(LABEL_RE, '').trim();
}

function isPolluted(f: ConsolidatedFact): boolean {
  if (f.kind === 'constraint') return false;          // never the dispatch rules
  if (PROTECTED_IDS.has(f.id)) return false;
  const inner = strip(f.content);
  if (isHarnessInjectedInput(inner) || isHarnessInjectedInput(f.content)) return true;
  if (SIGNATURES.some((re) => re.test(f.content) || re.test(inner))) return true;
  // A bare single-word capture like "READY" (a test marker) — never a real fact.
  if (/^(User preference|Standing prohibition):\s*READY\.?$/i.test(f.content)) return true;
  return false;
}

const all = listAllFacts(10000).filter((f) => f.active);
const hits = all.filter(isPolluted);

console.log(`\nScanned ${all.length} active facts. Found ${hits.length} polluted (recoverable):\n`);
for (const f of hits) {
  console.log(`  - #${f.id} [${f.kind}${f.pinned ? ',pinned' : ''}] ${f.content.replace(/\s+/g, ' ').slice(0, 96)}`);
}
console.log(`\n(Protected constraints kept: ${all.filter((f) => f.kind === 'constraint').length} constraint facts + ids ${[...PROTECTED_IDS].join(',')}.)`);

if (!APPLY) {
  console.log(`\nDRY RUN — nothing changed. Re-run with --apply to soft-delete (recoverable).\n`);
  process.exit(0);
}

let done = 0;
for (const f of hits) {
  try {
    if (f.pinned) setFactPinned(f.id, false);
    if (forgetFact(f.id)) done += 1;
  } catch (e) {
    console.error(`  ! #${f.id} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log(`\nSoft-deleted ${done}/${hits.length} polluted facts (recoverable via reactivateFact / memory_restore).\n`);
