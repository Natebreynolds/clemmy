/**
 * Jev/judge agreement on the grounding gate, from the shadow ledger.
 *
 * The A/B harness answers speed and tokens. It cannot answer accuracy: equal
 * goal-judge counts mean the GOAL judge agreed, not that the grounding verdicts
 * matched. grounding-gate.ts now runs Jev in shadow — started before the real
 * judge, awaited after, so it costs no serialized latency — and records
 * { jevGrounded, judgeGrounded, agree, jevModel } on a guardrail_tripped event
 * with kind 'jev_grounding_shadow'. This reads that.
 *
 * The number that matters is not the agreement RATE, it is the DISAGREEMENT
 * SHAPE. A gate exists to stop a bad write, so the two directions are not
 * equally serious:
 *
 *   jev=grounded, judge=blocked  -> Jev would have LET A BAD WRITE THROUGH.
 *                                   This is the one that must be ~zero before
 *                                   Jev becomes authoritative here.
 *   jev=blocked, judge=grounded  -> Jev would have blocked good work. Costs a
 *                                   retry and some trust; it does not send an
 *                                   email that should not have gone.
 *
 *   node tools/measurement/jev-agreement.mjs [hoursBack]
 */
import Database from 'better-sqlite3';

const hours = Number(process.argv[2] ?? 72);
// created_at is TEXT — compare ISO to ISO. An integer bound matches every row
// because SQLite orders all integers before all text.
const since = new Date(Date.now() - hours * 3600e3).toISOString();

const db = new Database(`${process.env.HOME}/.clementine-next/state/harness.db`, { readonly: true });
const rows = db.prepare(`
  SELECT session_id, created_at, data_json
    FROM events
   WHERE type = 'guardrail_tripped'
     AND created_at > ?
     AND data_json LIKE '%jev_grounding_shadow%'
   ORDER BY seq ASC
`).all(since);
db.close();

if (rows.length === 0) {
  console.log(`No shadow verdicts in the last ${hours}h.`);
  console.log('Expected while no TYPESAFE_API_KEY is configured — tryJevGroundingVerdict');
  console.log('returns null without a key, so the shadow records nothing. This is not a');
  console.log('failure; it means the gate has not been exercised with Jev connected yet.');
  process.exit(0);
}

let agree = 0;
const jevWouldAllowBadWrite = [];
const jevWouldBlockGoodWork = [];
const models = new Map();
for (const row of rows) {
  let d; try { d = JSON.parse(row.data_json); } catch { continue; }
  if (typeof d.jevGrounded !== 'boolean' || typeof d.judgeGrounded !== 'boolean') continue;
  models.set(d.jevModel ?? '(unrecorded)', (models.get(d.jevModel ?? '(unrecorded)') ?? 0) + 1);
  if (d.agree === true || d.jevGrounded === d.judgeGrounded) { agree += 1; continue; }
  const entry = { at: row.created_at.slice(0, 19), session: row.session_id };
  if (d.jevGrounded && !d.judgeGrounded) jevWouldAllowBadWrite.push(entry);
  else jevWouldBlockGoodWork.push(entry);
}

const n = agree + jevWouldAllowBadWrite.length + jevWouldBlockGoodWork.length;
console.log(`── Jev grounding shadow · last ${hours}h · ${n} paired verdicts`);
console.log(`models: ${[...models].map(([m, c]) => `${m} x${c}`).join(', ')}`);
console.log(`\nagreement            ${agree}/${n}  (${n ? ((agree / n) * 100).toFixed(1) : '0.0'}%)`);
console.log(`UNSAFE disagreements ${jevWouldAllowBadWrite.length}   jev=grounded, judge=blocked`);
console.log(`safe disagreements   ${jevWouldBlockGoodWork.length}   jev=blocked, judge=grounded`);

if (jevWouldAllowBadWrite.length > 0) {
  console.log('\n!! Jev would have allowed a write the configured judge blocked:');
  for (const e of jevWouldAllowBadWrite.slice(0, 12)) console.log(`     ${e.at}  ${e.session}`);
  console.log('\n   Each of these is a send the gate exists to stop. Jev should not become');
  console.log('   authoritative on this gate while this count is non-zero.');
} else if (n > 0) {
  console.log('\nNo unsafe disagreement observed. That is the precondition for promoting');
  console.log('Jev here — necessary, not sufficient: judge how many writes were actually');
  console.log('exercised before reading a clean run as proof.');
}
