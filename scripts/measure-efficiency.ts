/**
 * Efficiency readout — make the harness's own token/cache efficiency legible.
 *
 * Reads the usage log (~/.clementine-next/state/token-usage/*.ndjson) and prints
 * the numbers every "measure-first" efficiency decision needs but that nothing
 * surfaced before:
 *   - prompt cache-hit-rate (cachedInputTokens / inputTokens), SEGMENTED by kind
 *     so the INTERACTIVE-chat rate is isolated from boot `warmup` traffic (which
 *     otherwise dominates volume and skews the headline number),
 *   - token spend + avg latency by kind / model / top sources,
 *   - the component breakdown of a turn's prompt (rubric / memory / packet /
 *     tools) — emitted by the assembly instrumentation when present.
 *
 * Why: the audit found the harness is already near the efficiency frontier, and
 * the one real gap was OBSERVABILITY — you couldn't answer "what's our
 * interactive cache-hit-rate?" or "where do my tokens go each turn?". This is
 * the readout that answers both, so the remaining opportunities (rubric prune,
 * JIT promotion, worker-return cap) are decided from data, not guesses.
 *
 * Run:  npx tsx scripts/measure-efficiency.ts [--days N] [--date YYYY-MM-DD]
 */
import { readUsageEventsForDate, listUsageDates, rollupUsage, classifyUsageKind, type UsageEvent } from '../src/runtime/usage-log.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const days = Math.max(1, Number.parseInt(arg('days') ?? '7', 10) || 7);
const explicitDate = arg('date');

function datesToRead(): string[] {
  if (explicitDate) return [explicitDate];
  const all = listUsageDates(); // newest-first
  return all.slice(0, days);
}

function loadEvents(): UsageEvent[] {
  const out: UsageEvent[] = [];
  for (const d of datesToRead()) {
    // listUsageDates yields YYYY-MM-DD; parse as UTC midnight so the right file is read.
    const date = new Date(`${d}T12:00:00Z`);
    out.push(...readUsageEventsForDate(date));
  }
  // TRUST the stored kind (it was classified at WRITE time WITH the channel —
  // which isn't persisted, so re-deriving from source alone would lose chat
  // events classified purely by channel, e.g. cli/electron with a prefix-less
  // sessionId, mis-bucketing them as 'other'). The ONLY read-side override is
  // reclassifying historical `warmup-*` events to the `warmup` kind (added after
  // some were already written as 'other'). Read-side view only; disk untouched.
  return out.map((e) => (e.source?.startsWith('warmup') && e.kind !== 'warmup'
    ? { ...e, kind: classifyUsageKind(e.source, undefined) }
    : e));
}

const pct = (a: number, b: number): string => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '—');
const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
const pad = (s: string | number, w: number): string => String(s).padStart(w);
const lpad = (s: string, w: number): string => s.length >= w ? s.slice(0, w) : s.padEnd(w);

const events = loadEvents();
const dates = datesToRead();

if (events.length === 0) {
  console.log(`No usage events found for ${explicitDate ?? `the last ${days} day(s)`}.`);
  console.log(`(usage log: ~/.clementine-next/state/token-usage/*.ndjson — populated as the daemon drives model calls.)`);
  process.exit(0);
}

// Reuse the canonical rollup so the readout and the dashboard agree exactly.
// rollupUsage's hour-bucket is per-day; for a multi-day window we only consume
// its kind/model/source/cache aggregates, which are window-correct.
const r = rollupUsage(events);

const avgLatencyByKind = new Map<string, { sum: number; n: number }>();
for (const ev of events) {
  if (typeof ev.durationMs === 'number') {
    const a = avgLatencyByKind.get(ev.kind) ?? { sum: 0, n: 0 };
    a.sum += ev.durationMs; a.n += 1;
    avgLatencyByKind.set(ev.kind, a);
  }
}
const avgMs = (kind: string): string => {
  const a = avgLatencyByKind.get(kind);
  return a && a.n > 0 ? `${Math.round(a.sum / a.n)}ms` : '—';
};

console.log(`\n═══ Harness efficiency readout — ${explicitDate ?? `last ${dates.length} day(s)`} (${dates[dates.length - 1] ?? '?'} … ${dates[0] ?? '?'}) ═══`);
console.log(`events ${events.length} · input ${k(r.totalInputTokens)} · cached ${k(r.totalCachedInputTokens)} · output ${k(r.totalOutputTokens)}`);
console.log(`OVERALL cache-hit-rate: ${pct(r.totalCachedInputTokens, r.totalInputTokens)}  (confounded if 'warmup'/'other' dominate — read the chat row below)`);

console.log(`\nBY KIND            calls    inputTok   cachedTok    hit%     avgLatency`);
for (const [kind, v] of Object.entries(r.byKind).sort((a, b) => b[1].inputTokens - a[1].inputTokens)) {
  const star = kind === 'chat' ? ' ←interactive' : '';
  console.log(`${lpad(kind, 16)} ${pad(v.calls, 6)} ${pad(k(v.inputTokens), 11)} ${pad(k(v.cachedInputTokens), 11)} ${pad(pct(v.cachedInputTokens, v.inputTokens), 8)} ${pad(avgMs(kind), 12)}${star}`);
}

console.log(`\nBY MODEL           calls    inputTok   cachedTok    hit%`);
for (const [model, v] of Object.entries(r.byModel).sort((a, b) => b[1].inputTokens - a[1].inputTokens)) {
  console.log(`${lpad(model, 16)} ${pad(v.calls, 6)} ${pad(k(v.inputTokens), 11)} ${pad(k(v.cachedInputTokens), 11)} ${pad(pct(v.cachedInputTokens, v.inputTokens), 8)}`);
}

console.log(`\nTOP SOURCES        calls      tokens   kind`);
for (const s of r.bySource.slice(0, 10)) {
  console.log(`${lpad(s.source.replace(/[-:][0-9a-f]{6,}.*$/i, '…'), 16)} ${pad(s.calls, 6)} ${pad(k(s.tokens), 11)}   ${s.kind}`);
}

// Component breakdown (A2) — emitted by the prompt-assembly instrumentation when
// present on events. Absent until A2 lands; show a hint rather than a blank.
const withComponents = events.filter((e) => (e as { promptComponents?: unknown }).promptComponents);
if (withComponents.length > 0) {
  const agg: Record<string, number> = {};
  for (const e of withComponents) {
    const comp = (e as { promptComponents?: Record<string, number> }).promptComponents ?? {};
    for (const [name, toks] of Object.entries(comp)) agg[name] = (agg[name] ?? 0) + (toks || 0);
  }
  const total = Object.values(agg).reduce((a, b) => a + b, 0);
  console.log(`\nPROMPT COMPONENTS  (avg share of the assembled prompt, ${withComponents.length} turns)`);
  for (const [name, toks] of Object.entries(agg).sort((a, b) => b[1] - a[1])) {
    console.log(`${lpad(name, 16)} ${pad(k(Math.round(toks / withComponents.length)), 11)} ${pad(pct(toks, total), 8)}`);
  }
} else {
  console.log(`\nPROMPT COMPONENTS: (none recorded — assembly instrumentation A2 not yet emitting promptComponents)`);
}

console.log('');
