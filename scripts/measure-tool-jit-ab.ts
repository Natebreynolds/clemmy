/**
 * Phase 1.2 — LIVE A/B readout for JIT tool loading.
 *
 * Reads the REAL event log (read-only) and compares the two arms the live A/B
 * buckets sessions into (set CLEMMY_TOOL_JIT_AB=on on the daemon; each session is
 * deterministically assigned 'jit' or 'control' and tagged with a tool_jit_scope
 * event carrying {arm, experiment, jitActive, droppedCount}). Reports, per arm:
 *   - session count + avg tools dropped (token savings, jit arm only),
 *   - outcome QUALITY: completion / failure / stall rates,
 * so the default-on decision is "jit ≤ control on every regression metric AND
 * better on tokens" — measured on real traffic, not guessed.
 *
 * Does NOT override CLEMENTINE_HOME — it must read your live event log. Read-only.
 * Run: npx tsx scripts/measure-tool-jit-ab.ts
 */
import { openEventLog } from '../src/runtime/harness/eventlog.js';

const TOK_PER_TOOL = 302; // ~ JIT-able avg wire size (50,766 chars / 42 tools / 4)

interface ArmStat {
  sessions: Set<string>;
  jitTurns: number;
  droppedTotal: number;
  completed: number;
  failed: number;
  stalled: number;
  limitHit: number;
}
const arms: Record<'jit' | 'control', ArmStat> = {
  jit: { sessions: new Set(), jitTurns: 0, droppedTotal: 0, completed: 0, failed: 0, stalled: 0, limitHit: 0 },
  control: { sessions: new Set(), jitTurns: 0, droppedTotal: 0, completed: 0, failed: 0, stalled: 0, limitHit: 0 },
};

const db = openEventLog();

// 1) Arm assignment per session, from the experiment-tagged tool_jit_scope events.
const sessionArm = new Map<string, 'jit' | 'control'>();
const jitRows = db
  .prepare(`SELECT session_id, data_json FROM events WHERE type = 'tool_jit_scope' ORDER BY seq ASC`)
  .all() as Array<{ session_id: string; data_json: string }>;
for (const row of jitRows) {
  let data: { arm?: string; experiment?: boolean; droppedCount?: number } = {};
  try { data = JSON.parse(row.data_json) as typeof data; } catch { continue; }
  if (!data.experiment || (data.arm !== 'jit' && data.arm !== 'control')) continue;
  const arm = data.arm;
  sessionArm.set(row.session_id, arm); // stable per session; last write fine (deterministic)
  arms[arm].jitTurns += 1;
  arms[arm].droppedTotal += data.droppedCount ?? 0;
}
for (const [sid, arm] of sessionArm) arms[arm].sessions.add(sid);

const totalAbSessions = sessionArm.size;
if (totalAbSessions === 0) {
  console.log('\n  No A/B sessions found yet.');
  console.log('  To start: set CLEMMY_TOOL_JIT_AB=on (optionally CLEMMY_TOOL_JIT_AB_RATIO=0.5) on the');
  console.log('  live daemon and let interactive chat traffic accumulate, then re-run this readout.');
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

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : 'n/a';
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  PHASE 1.2 — LIVE A/B READOUT: JIT tool loading');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  A/B sessions: ${totalAbSessions}  (jit ${arms.jit.sessions.size} · control ${arms.control.sessions.size})`);

for (const arm of ['jit', 'control'] as const) {
  const s = arms[arm];
  const outcomes = s.completed + s.failed + s.stalled + s.limitHit;
  console.log(`\n  ── ${arm.toUpperCase()} ──`);
  console.log(`    sessions: ${s.sessions.size} · turns(tagged): ${s.jitTurns}`);
  if (arm === 'jit') {
    const avgDropped = s.jitTurns > 0 ? s.droppedTotal / s.jitTurns : 0;
    console.log(`    avg tools dropped/turn: ${avgDropped.toFixed(1)}  ≈ ${Math.round(avgDropped * TOK_PER_TOOL)} tok/turn saved`);
  } else {
    console.log(`    avg tools dropped/turn: 0 (full surface — the baseline)`);
  }
  console.log(`    completed: ${s.completed} (${pct(s.completed, outcomes)})  ·  failed: ${s.failed} (${pct(s.failed, outcomes)})  ·  stalled: ${s.stalled}  ·  limit: ${s.limitHit}`);
}

// 3) Verdict: jit must not be WORSE on failure/stall, and should save tokens.
const jitOut = arms.jit.completed + arms.jit.failed + arms.jit.stalled + arms.jit.limitHit;
const ctlOut = arms.control.completed + arms.control.failed + arms.control.stalled + arms.control.limitHit;
const jitBad = jitOut > 0 ? (arms.jit.failed + arms.jit.stalled) / jitOut : 0;
const ctlBad = ctlOut > 0 ? (arms.control.failed + arms.control.stalled) / ctlOut : 0;
console.log('\n══════════════════════════════════════════════════════════════');
if (totalAbSessions < 40) {
  console.log(`  ⏳ Only ${totalAbSessions} A/B sessions — too few to decide. Keep accumulating (aim ≥40/arm).`);
} else if (jitBad <= ctlBad + 0.02 && arms.jit.droppedTotal > 0) {
  console.log(`  ✅ SHIP CANDIDATE: jit failure+stall ${(jitBad * 100).toFixed(1)}% ≤ control ${(ctlBad * 100).toFixed(1)}% (+2pt tol), and it saves tokens.`);
  console.log('     Soak one more release, then flip CLEMMY_TOOL_JIT default-on and retire the A/B flag.');
} else {
  console.log(`  ⚠️ HOLD: jit failure+stall ${(jitBad * 100).toFixed(1)}% vs control ${(ctlBad * 100).toFixed(1)}% — investigate the regressions before default-on.`);
}
