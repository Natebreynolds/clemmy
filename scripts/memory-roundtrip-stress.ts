/**
 * Memory round-trip stress harness — write → inject → recall → enforce.
 *
 * The goal's top focus: "no hole in the memory from injecting, retrieval."
 * Each scenario exercises the REAL memory path end-to-end (rememberFact →
 * the SQLite fact store → renderHarnessMemoryContext injection / recall /
 * constraint-guard enforcement) and asserts a round-trip property holds even
 * under load (many facts, many constraints, many pins). Offline, deterministic.
 *
 * Scenarios 1–5 verify the path is solid (they pass today). Scenarios 6–8
 * express the DESIRED behavior for the recency-cap holes — a power user who
 * accumulates >20 constraints / >12 pinned rules must not have an old-but-
 * critical SAFETY rule silently un-enforced or un-injected. They fail until
 * the cap fix lands, then guard it.
 *
 * Run: npx tsx scripts/memory-roundtrip-stress.ts
 * Exit 0 = every round-trip holds; exit 1 = a memory hole is present.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-memory-stress-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { rememberFact, setFactPinned, listConstraints, listPinnedFacts, searchFactsByText } = await import('../src/memory/facts.js');
const { openMemoryDb } = await import('../src/memory/db.js');
const { renderHarnessMemoryContext } = await import('../src/agents/harness-context.js');
const { findEmailSendConstraint, constraintsForToolkit } = await import('../src/runtime/harness/constraint-guard.js');
const { extractAutoMemoryCandidates } = await import('../src/memory/auto-capture.js');

function clearFacts(): void {
  openMemoryDb().prepare('DELETE FROM consolidated_facts').run();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Scenario {
  id: string;
  desc: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'pref-inject',
    desc: 'a stated preference is injected into the per-turn context',
    run: async () => {
      clearFacts();
      rememberFact({ kind: 'user', content: 'The user prefers concise, no-fluff replies with the answer first.', importance: 6 });
      const ctx = renderHarnessMemoryContext();
      return { ok: ctx.includes('concise, no-fluff'), detail: ctx.includes('concise, no-fluff') ? 'injected' : 'MISSING from context' };
    },
  },
  {
    id: 'pref-recall',
    desc: 'the same preference is retrievable via text recall',
    run: async () => {
      clearFacts();
      rememberFact({ kind: 'user', content: 'The user prefers concise, no-fluff replies with the answer first.', importance: 6 });
      const hits = searchFactsByText('concise replies answer first', 5);
      return { ok: hits.length > 0, detail: `${hits.length} recall hit(s)` };
    },
  },
  {
    id: 'pinned-survives-scored',
    desc: 'a pinned standing instruction survives even with 30 competing scored facts',
    run: async () => {
      clearFacts();
      const f = rememberFact({ kind: 'feedback', content: 'PINNED RULE ALPHA: always confirm the destination before any deploy.', importance: 9 });
      setFactPinned(f.id, true);
      for (let i = 0; i < 30; i += 1) rememberFact({ kind: 'project', content: `Scored filler fact number ${i} about an unrelated topic.`, importance: 3 });
      const ctx = renderHarnessMemoryContext();
      return { ok: ctx.includes('PINNED RULE ALPHA'), detail: ctx.includes('PINNED RULE ALPHA') ? 'pinned present' : 'pinned LOST under scored load' };
    },
  },
  {
    id: 'constraint-enforced-basic',
    desc: 'a single mailbox constraint is found by the enforcement path',
    run: async () => {
      clearFacts();
      rememberFact({ kind: 'constraint', content: 'Always send Outlook email only from nathan.reynolds@scorpion.co — never the default account.', importance: 9 });
      const hit = findEmailSendConstraint('OUTLOOK_SEND_EMAIL', {});
      return { ok: !!hit && hit.allowedAccount.includes('scorpion.co'), detail: hit ? `enforced (${hit.allowedAccount})` : 'NOT enforced' };
    },
  },
  {
    id: 'cross-session-global',
    desc: 'a fact written in one session is still injected in a later render (global memory)',
    run: async () => {
      clearFacts();
      rememberFact({ kind: 'user', content: 'The user runs a marketing agency called Breakthrough.', importance: 7 });
      renderHarnessMemoryContext(); // session A
      const ctxB = renderHarnessMemoryContext(); // session B
      return { ok: ctxB.includes('Breakthrough'), detail: ctxB.includes('Breakthrough') ? 'persists across renders' : 'LOST' };
    },
  },
  {
    id: 'HOLE-constraint-enforcement-cap',
    desc: 'an OLD critical mailbox constraint is still ENFORCED after 24 newer constraints accumulate',
    run: async () => {
      clearFacts();
      rememberFact({ kind: 'constraint', content: 'CRITICAL: always send Outlook email only from nathan.reynolds@scorpion.co.', importance: 10 });
      await sleep(15); // ensure the critical rule is strictly the oldest by updated_at
      for (let i = 0; i < 24; i += 1) rememberFact({ kind: 'constraint', content: `Minor rule ${i}: prefer the staging table for scratch writes.`, importance: 2 });
      const hit = findEmailSendConstraint('OUTLOOK_SEND_EMAIL', {});
      return { ok: !!hit && hit.allowedAccount.includes('scorpion.co'), detail: hit ? 'still enforced ✓' : `DROPPED — only the 20 newest of ${listConstraints(9999).length} constraints are enforced` };
    },
  },
  {
    id: 'HOLE-constraint-toolkit-cap',
    desc: 'an OLD outlook-bound constraint still binds to its toolkit after 24 newer constraints',
    run: async () => {
      clearFacts();
      rememberFact({ kind: 'constraint', content: 'CRITICAL: route all outlook sends through the shared compliance mailbox.', importance: 10 });
      await sleep(15);
      for (let i = 0; i < 24; i += 1) rememberFact({ kind: 'constraint', content: `Minor rule ${i}: keep airtable scratch records in the sandbox base.`, importance: 2 });
      const bound = constraintsForToolkit('outlook');
      return { ok: bound.length >= 1, detail: bound.length >= 1 ? 'still bound ✓' : 'DROPPED — old outlook rule fell out of the 20-cap before the toolkit filter' };
    },
  },
  {
    id: 'HOLE-pinned-cap',
    desc: 'an OLD high-importance pinned rule is still injected after 14 newer pins',
    run: async () => {
      clearFacts();
      const crit = rememberFact({ kind: 'feedback', content: 'PINNED CRITICAL: never deploy to a site not created this session.', importance: 10 });
      setFactPinned(crit.id, true);
      await sleep(15);
      for (let i = 0; i < 14; i += 1) {
        const f = rememberFact({ kind: 'feedback', content: `Minor pinned note ${i}: keep replies friendly.`, importance: 2 });
        setFactPinned(f.id, true);
      }
      // Honest test: does the high-importance critical rule survive the pinned
      // cap as a PINNED standing instruction (not merely leak via scored rank)?
      const stillPinned = listPinnedFacts(12).some((f) => f.id === crit.id);
      return { ok: stillPinned, detail: stillPinned ? 'still injected ✓' : `DROPPED from the pinned-12 (newest-first) though it is the highest-importance of ${listPinnedFacts(9999).length}` };
    },
  },
  {
    id: 'HOLE-pinned-injection-coverage',
    desc: 'a genuine OLD pinned rule still INJECTS when 19 newer EQUAL-importance pins exist (MEM-INJ-1)',
    run: async () => {
      clearFacts();
      // The live case: synthetic harness auto-pins and a genuine user rule all at
      // the default importance; the genuine one is older, so a hard newest-12 cap
      // evicted it from the "always apply" block. The char-budgeted render keeps all.
      const crit = rememberFact({ kind: 'feedback', content: 'GENUINE RULE: send invoices only from billing@acme.co.', importance: 5 });
      setFactPinned(crit.id, true);
      await sleep(15);
      for (let i = 0; i < 19; i += 1) {
        const f = rememberFact({ kind: 'feedback', content: `Synthetic auto-pin ${i}: you marked an objective complete and continued.`, importance: 5 });
        setFactPinned(f.id, true);
      }
      const ctx = renderHarnessMemoryContext();
      const present = ctx.includes('GENUINE RULE: send invoices');
      return { ok: present, detail: present ? 'genuine old pin still injected ✓' : 'DROPPED — newer synthetic pins crowded it out of the 12-cap' };
    },
  },
  {
    id: 'constraint-autocapture-roundtrip',
    desc: 'an auto-captured sender rule round-trips all the way to dispatch-gate enforcement',
    run: async () => {
      clearFacts();
      const cands = extractAutoMemoryCandidates('From now on always send Outlook email from nathan.reynolds@scorpion.co — never the default account.');
      const c = cands.find((x) => x.kind === 'constraint');
      if (!c) return { ok: false, detail: 'auto-capture did NOT classify the sender rule as a constraint' };
      rememberFact({ kind: 'constraint', content: c.content, importance: 9 });
      const hit = findEmailSendConstraint('OUTLOOK_SEND_EMAIL', {});
      return { ok: !!hit && hit.allowedAccount.includes('scorpion.co'), detail: hit ? 'auto-capture → enforced ✓' : 'captured but NOT enforced at dispatch' };
    },
  },
];

function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length); }

async function main(): Promise<void> {
  console.log('\nMemory round-trip stress — write → inject → recall → enforce\n');
  console.log('  ' + pad('SCENARIO', 34) + pad('RESULT', 10) + 'DETAIL');
  console.log('  ' + '-'.repeat(90));
  let pass = 0;
  for (const s of SCENARIOS) {
    let res: { ok: boolean; detail: string };
    try { res = await s.run(); } catch (e) { res = { ok: false, detail: 'ERROR: ' + (e instanceof Error ? e.message : String(e)) }; }
    if (res.ok) pass += 1;
    console.log('  ' + pad(s.id, 34) + pad(res.ok ? '✓ PASS' : '✗ FAIL', 10) + res.detail);
  }
  console.log('  ' + '-'.repeat(90));
  console.log(`\n  ${pass}/${SCENARIOS.length} memory round-trips hold.\n`);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  if (pass !== SCENARIOS.length) {
    console.error(`  ✗ ${SCENARIOS.length - pass} memory hole(s) present.\n`);
    process.exit(1);
  }
  console.log('  ✓ no memory holes.\n');
}

await main();
