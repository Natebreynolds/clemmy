/**
 * Procedural-memory measurement — the "measure before building" pass for the
 * tool-choice / resource-memory work (2026-06-21).
 *
 * Answers, from REAL data, the questions that decide whether (and how) to build
 * the per-recalled-intent outcome loop + consolidation + verified-first surfacing:
 *
 *   1. RECALL HIT-RATE — when the agent recalls a proven path, does it hit? And
 *      how much is FUZZY (a fragile near-match) vs exact? (telemetry)
 *   2. RE-LEARN / FRAGMENTATION — how often does it REMEMBER a new intent vs
 *      reuse one (a high remember:recall_hit ratio = it keeps inventing new
 *      intents instead of reusing canonical ones). (telemetry)
 *   3. OUTCOME-LOOP COVERAGE — what share of memos have EVER been outcome-scored
 *      (success/failure observed)? Split by kind (cli vs composio vs mcp) to test
 *      the claim that the loop is composio-only and CLI memos sit unverified at
 *      the neutral 0.5 prior. (memo store)
 *   4. OPERATION FRAGMENTATION — how many distinct memos pile up per (tool,
 *      operation) — the "7 netlify memos" shape. (memo store)
 *
 * Read-only. Run: npx tsx scripts/measure-procedural-memory.ts [--days N]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../src/config.js';
import { listToolChoices, computeChoiceScore } from '../src/memory/tool-choice-store.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const days = Math.max(1, Number.parseInt(arg('days') ?? '30', 10) || 30);
const pct = (a: number, b: number): string => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '—');
const pad = (s: string | number, w: number): string => String(s).padStart(w);
const lpad = (s: string, w: number): string => (s.length >= w ? s.slice(0, w) : s.padEnd(w));

// ─────────────────────────────────────────────────────────────────
// 1+2. Telemetry — tool_choice action events from the tool-events log.
// ─────────────────────────────────────────────────────────────────
const EVENT_DIR = path.join(BASE_DIR, 'state', 'tool-events');
const actionCounts: Record<string, number> = {};
let telemetryFiles = 0;
if (existsSync(EVENT_DIR)) {
  const files = readdirSync(EVENT_DIR).filter((f) => f.endsWith('.ndjson')).sort().slice(-days);
  telemetryFiles = files.length;
  for (const f of files) {
    for (const line of readFileSync(path.join(EVENT_DIR, f), 'utf8').split('\n')) {
      if (!line.includes('"tool_choice"')) continue;
      let e: { argsSummary?: string } | undefined;
      try { e = JSON.parse(line); } catch { continue; }
      const m = e?.argsSummary?.match(/action=([a-z_]+)/);
      if (m) actionCounts[m[1]] = (actionCounts[m[1]] ?? 0) + 1;
    }
  }
}
const c = (k: string): number => actionCounts[k] ?? 0;
const hits = c('recall_hit') + c('recall_hit_fuzzy');
const recalls = hits + c('recall_miss');
const remembers = c('remember') + c('remember_rejected_failed');

console.log(`\n═══ Procedural-memory measurement — last ${telemetryFiles} day(s) of telemetry ═══`);
console.log(`\n1) RECALL`);
console.log(`   recalls: ${recalls}  (hit ${c('recall_hit')} · fuzzy-hit ${c('recall_hit_fuzzy')} · miss ${c('recall_miss')})`);
console.log(`   hit-rate: ${pct(hits, recalls)}   fuzzy share of hits: ${pct(c('recall_hit_fuzzy'), hits)}  (fuzzy = fragile near-match)`);
console.log(`\n2) RE-LEARN / FRAGMENTATION`);
console.log(`   remembers: ${remembers}  (rejected-as-failed by the new guard: ${c('remember_rejected_failed')})`);
console.log(`   remember : recall_hit ratio = ${recalls > 0 ? (remembers / Math.max(1, c('recall_hit'))).toFixed(2) : '—'}  (>1 ⇒ inventing new intents faster than reusing them)`);
console.log(`   outcome events fed: pos ${c('outcome_pos')} · neg ${c('outcome_neg')} · auto_invalidate ${c('auto_invalidate')}`);

// ─────────────────────────────────────────────────────────────────
// 3+4. Memo store — outcome coverage + operation fragmentation.
// ─────────────────────────────────────────────────────────────────
const memos = listToolChoices();
const byKind: Record<string, { total: number; scored: number; active: number }> = {};
let scoredTotal = 0;
const OP_RE = /\b(deploy|publish|create|send|update|insert|delete|query|list|search|read|get|draft|scrape|connect|upload|fetch)\b/i;
const opClusters = new Map<string, string[]>(); // (identifier + operation) → intents

for (const rec of memos) {
  const ch = rec.choice;
  const kind = ch?.kind ?? (rec.fallbacks[0]?.kind ?? 'unknown');
  const k = byKind[kind] ?? { total: 0, scored: 0, active: 0 };
  k.total += 1;
  if (ch) k.active += 1;
  const hasOutcome = !!ch && ((ch.successCount ?? 0) + (ch.failureCount ?? 0) + (ch.approvalCount ?? 0) + (ch.rejectionCount ?? 0)) > 0;
  if (hasOutcome) { k.scored += 1; scoredTotal += 1; }
  byKind[kind] = k;

  // Operation cluster key: identifier + first operation verb in intent/template.
  const id = (ch?.identifier ?? 'none').toLowerCase();
  const opM = (rec.intent + ' ' + (ch?.invocationTemplate ?? '')).match(OP_RE);
  const op = opM ? opM[1].toLowerCase() : 'other';
  const key = `${id} · ${op}`;
  const arr = opClusters.get(key) ?? [];
  arr.push(rec.intent);
  opClusters.set(key, arr);
}

console.log(`\n3) OUTCOME-LOOP COVERAGE  (memos that have EVER been success/failure-scored)`);
console.log(`   total memos: ${memos.length}   ever-scored: ${scoredTotal} (${pct(scoredTotal, memos.length)})  ← the rest sit at the neutral 0.5 prior (unverified)`);
console.log(`   kind            memos   active   ever-scored`);
for (const [kind, v] of Object.entries(byKind).sort((a, b) => b[1].total - a[1].total)) {
  console.log(`   ${lpad(kind, 14)} ${pad(v.total, 6)} ${pad(v.active, 8)} ${pad(`${v.scored} (${pct(v.scored, v.total)})`, 13)}`);
}

console.log(`\n4) OPERATION FRAGMENTATION  (distinct memos per tool+operation — the "7 netlify memos" shape)`);
const fragmented = [...opClusters.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);
if (fragmented.length === 0) {
  console.log('   none — every (tool, operation) has a single canonical memo.');
} else {
  console.log(`   ${fragmented.length} (tool, operation) pairs have >1 memo:`);
  for (const [key, intents] of fragmented.slice(0, 12)) {
    console.log(`   ${lpad(key, 26)} ${pad(intents.length, 3)} memos: ${intents.map((i) => i).slice(0, 4).join(' | ')}${intents.length > 4 ? ' …' : ''}`);
  }
}
console.log('');
