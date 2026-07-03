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
  /\bMEMTOK-\d{6,}\b/i,
];

const LABELLED_ONE_OFF_SIGNATURES: RegExp[] = [
  /\bread[- ]only(?:\s+live)?\s+smoke\b|\bsmoke\s+test\b/i,
  /\blive\s+read[- ]only\s+validation\b|\bread[- ]only\s+live\s+validation\b/i,
  /\blive\s+validation(?:\s+only)?\b|\bvalidation\s+only\b/i,
  /\bdo\s+not\s+(?:save|store|remember|capture|persist)\s+(?:this|it|that|the request|this request)?\s*(?:as|to|in)?\s*(?:a\s+)?(?:memory|durable memory|long[- ]term memory)?\b/i,
  /\blive\s+(?:local\s+)?safety\s+validation\b/i,
  /\byou\s+must\s+call\s+composio_\w+\b.*\bdo\s+not\s+call\s+composio_\w+\b.*\bdo\s+not\s+make\s+any\s+external\s+changes\b/i,
  /\bwrite exactly SAFETY_PROBE_OK\b.*\bclementine-live-safety-probe(?:-\d+)?\.txt\b/i,
  /\bstress\s+test\s*\(?(?:read[- ]only)?\)?/i,
  /\bread[- ]only\s+(?:task|on my inbox|—|-)/i,
  /\bjust\s+draft\b.*\bdon'?t\s+send\b/i,
  /\bdraft\b.*\bdon'?t\s+send\b/i,
  /\bdon'?t\s+need\s+to\s+ask\s+first\b.*\bgo ahead and send\b/i,
  /\bcheck\b.*\bscorpion calendar\b.*\bconfirm which Outlook connection\b.*\bdo not create\b/i,
  /\bcan you check\b.*\b(?:via my calendar|my (?:outlook )?calendar|outlook inbox|scorpion calendar)\b.*\b(?:today|tomorrow|tmrw|tmr|this week)\b/i,
  /\bdo i have anything\b.*\bcalendar\b.*\b(?:today|tomorrow|tmrw|tmr|this week)\b/i,
  /\bdo i have\b.*\b(?:outlook|gmail|google calendar|calendar)\b.*\b(?:connected|connection|usable|stale|right now|currently)\b/i,
  /\bread[- ]only\b.*\buse the available tools\b.*\binstead of saying tools are unavailable\b/i,
  /\bcall dispatch_background_task\b.*\bdo not use any tools\b/i,
  /\breply with the single word READY\b/i,
  /\bUse run_tool_program \(write ONE program\b/i,
  /\bremember exactly:\s*my smoke marker is MEMTOK-\d{6,}\b/i,
  /\bmy smoke marker is MEMTOK-\d{6,}\b/i,
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
  if (LABEL_RE.test(f.content) && LABELLED_ONE_OFF_SIGNATURES.some((re) => re.test(f.content) || re.test(inner))) return true;
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
