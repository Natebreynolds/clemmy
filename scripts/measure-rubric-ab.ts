/**
 * LIVE A/B readout for the LEAN rubric (roadmap move ②).
 *
 * Reads the REAL event log (read-only) and compares the two arms the per-session
 * A/B buckets traffic into. To run the experiment: set CLEMMY_RUBRIC_VARIANT_AB=on
 * (optionally CLEMMY_RUBRIC_VARIANT_AB_RATIO=0.5) on the live daemon; each session
 * is deterministically assigned 'lean' or 'legacy' and every turn emits a
 * rubric_variant event carrying {arm, experiment, lane}. Then let interactive
 * traffic accumulate and re-run this.
 *
 * The lean rubric's win is a SMALLER SYSTEM-PROMPT PREFIX (~7.4K fewer tok/turn),
 * so unlike JIT the signal is lower INPUT tokens/call on the lean arm — joined
 * from the usage log per session. The default-flip rule: lean failure+stall ≤
 * legacy (+2pt tolerance) AND lean spends fewer input tokens/call. Measured on
 * real traffic, not guessed.
 *
 * Does NOT override CLEMENTINE_HOME — reads your live logs. Read-only.
 * Run: npx tsx scripts/measure-rubric-ab.ts
 */
import { openEventLog } from '../src/runtime/harness/eventlog.js';
import { listUsageDates, readUsageEventsForDate } from '../src/runtime/usage-log.js';

type Arm = 'lean' | 'legacy';

interface ArmStat {
  sessions: Set<string>;
  turns: number;
  completed: number;
  failed: number;
  stalled: number;
  limitHit: number;
}
const arms: Record<Arm, ArmStat> = {
  lean: { sessions: new Set(), turns: 0, completed: 0, failed: 0, stalled: 0, limitHit: 0 },
  legacy: { sessions: new Set(), turns: 0, completed: 0, failed: 0, stalled: 0, limitHit: 0 },
};

const db = openEventLog();

// 1) Arm assignment per session, from the experiment-tagged rubric_variant events.
const sessionArm = new Map<string, Arm>();
const laneFilter = (process.env.CLEMMY_RUBRIC_VARIANT_AB_LANE ?? '').trim();
const rows = db
  .prepare(`SELECT session_id, data_json FROM events WHERE type = 'rubric_variant' ORDER BY seq ASC`)
  .all() as Array<{ session_id: string; data_json: string }>;
for (const row of rows) {
  let data: { arm?: string; experiment?: boolean; lane?: string } = {};
  try { data = JSON.parse(row.data_json) as typeof data; } catch { continue; }
  if (!data.experiment || (data.arm !== 'lean' && data.arm !== 'legacy')) continue;
  if (laneFilter && (data.lane ?? 'codex') !== laneFilter) continue;
  sessionArm.set(row.session_id, data.arm); // stable per session (deterministic hash)
  arms[data.arm].turns += 1;
}
for (const [sid, arm] of sessionArm) arms[arm].sessions.add(sid);

const totalAbSessions = sessionArm.size;
if (totalAbSessions === 0) {
  console.log('\n  No rubric A/B sessions found yet.');
  console.log('  To start: set CLEMMY_RUBRIC_VARIANT_AB=on (optionally CLEMMY_RUBRIC_VARIANT_AB_RATIO=0.5)');
  console.log('  on the live daemon and let interactive chat traffic accumulate, then re-run this readout.');
  process.exit(0);
}

// 2) Outcome events for the A/B sessions only.
const OUTCOME_TYPES = ['run_completed', 'conversation_completed', 'run_failed', 'stuck_detected', 'conversation_limit_exceeded'];
const placeholders = OUTCOME_TYPES.map(() => '?').join(',');
const outcomeRows = db
  .prepare(`SELECT session_id, type FROM events WHERE type IN (${placeholders})`)
  .all(...OUTCOME_TYPES) as Array<{ session_id: string; type: string }>;
for (const row of outcomeRows) {
  const arm = sessionArm.get(row.session_id);
  if (!arm) continue;
  const s = arms[arm];
  if (row.type === 'run_completed' || row.type === 'conversation_completed') s.completed += 1;
  else if (row.type === 'run_failed') s.failed += 1;
  else if (row.type === 'stuck_detected') s.stalled += 1;
  else if (row.type === 'conversation_limit_exceeded') s.limitHit += 1;
}

// 3) Token cost per arm, joined from the usage log by session (the headline:
//    the lean prefix should mean fewer INPUT tokens/call).
const usageByArm: Record<Arm, { input: number; cached: number; output: number; calls: number }> = {
  lean: { input: 0, cached: 0, output: 0, calls: 0 },
  legacy: { input: 0, cached: 0, output: 0, calls: 0 },
};
for (const day of listUsageDates()) {
  const events = readUsageEventsForDate(new Date(`${day}T12:00:00Z`));
  for (const ev of events) {
    const arm = sessionArm.get(ev.source);
    if (!arm) continue;
    usageByArm[arm].input += ev.inputTokens || 0;
    usageByArm[arm].cached += ev.cachedInputTokens || 0;
    usageByArm[arm].output += ev.outputTokens || 0;
    usageByArm[arm].calls += 1;
  }
}
const haveUsage = usageByArm.lean.calls > 0 && usageByArm.legacy.calls > 0;
const avgInput = (a: { input: number; calls: number }): number => (a.calls > 0 ? a.input / a.calls : 0);
const hitRate = (a: { input: number; cached: number }): number => (a.input > 0 ? a.cached / a.input : 0);

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : 'n/a';
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  LIVE A/B READOUT: LEAN rubric vs legacy (codex/native lane)');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  A/B sessions: ${totalAbSessions}  (lean ${arms.lean.sessions.size} · legacy ${arms.legacy.sessions.size})`);

for (const arm of ['lean', 'legacy'] as const) {
  const s = arms[arm];
  const outcomes = s.completed + s.failed + s.stalled + s.limitHit;
  console.log(`\n  ── ${arm.toUpperCase()} ──`);
  console.log(`    sessions: ${s.sessions.size} · turns(tagged): ${s.turns}`);
  console.log(`    completed: ${s.completed} (${pct(s.completed, outcomes)})  ·  failed: ${s.failed} (${pct(s.failed, outcomes)})  ·  stalled: ${s.stalled}  ·  limit: ${s.limitHit}`);
  if (usageByArm[arm].calls > 0) {
    console.log(`    avg input tok/call: ${Math.round(avgInput(usageByArm[arm]))}  ·  cache-hit ${(hitRate(usageByArm[arm]) * 100).toFixed(1)}%  over ${usageByArm[arm].calls} calls`);
  }
}

// 4) Verdict: lean must not be WORSE on failure/stall, and should cost fewer input tokens/call.
const leanOut = arms.lean.completed + arms.lean.failed + arms.lean.stalled + arms.lean.limitHit;
const legOut = arms.legacy.completed + arms.legacy.failed + arms.legacy.stalled + arms.legacy.limitHit;
const leanBad = leanOut > 0 ? (arms.lean.failed + arms.lean.stalled) / leanOut : 0;
const legBad = legOut > 0 ? (arms.legacy.failed + arms.legacy.stalled) / legOut : 0;
const tokDelta = haveUsage ? avgInput(usageByArm.lean) - avgInput(usageByArm.legacy) : 0;

console.log('\n══════════════════════════════════════════════════════════════');
if (haveUsage) {
  console.log(`  token Δ (lean − legacy): ${tokDelta >= 0 ? '+' : ''}${Math.round(tokDelta)} input tok/call ${tokDelta < 0 ? '(lean cheaper ✓)' : '(lean NOT cheaper — investigate)'}`);
}
if (totalAbSessions < 40) {
  console.log(`  ⏳ Only ${totalAbSessions} A/B sessions — too few to decide. Keep accumulating (aim ≥40/arm).`);
} else if (leanBad <= legBad + 0.02 && haveUsage && tokDelta < 0) {
  console.log(`  ✅ SHIP CANDIDATE: lean failure+stall ${(leanBad * 100).toFixed(1)}% ≤ legacy ${(legBad * 100).toFixed(1)}% (+2pt tol) AND ${Math.round(-tokDelta)} fewer input tok/call.`);
  console.log('     Soak one more release, then flip DEFAULT_RUBRIC_VARIANT to "lean" and retire the A/B flag.');
} else if (leanBad > legBad + 0.02) {
  console.log(`  ⚠️ HOLD: lean failure+stall ${(leanBad * 100).toFixed(1)}% > legacy ${(legBad * 100).toFixed(1)}% — the prune dropped a load-bearing rule. Investigate before default-on.`);
} else {
  console.log(`  ⚠️ HOLD: reliability parity holds, but the token win isn't confirmed yet${haveUsage ? '' : ' (no usage events matched — let A/B sessions drive real model calls)'}.`);
}
