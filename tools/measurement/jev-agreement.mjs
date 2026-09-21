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
  // Two different reasons for zero, and they call for different action. Say
  // which, rather than reporting a blank that reads as a clean result.
  let keyed = false;
  try {
    const { readFileSync } = await import('node:fs');
    const vault = readFileSync(`${process.env.HOME}/.clementine-next/state/secrets-vault.json`, 'utf8');
    keyed = /typesafe/i.test(vault);
  } catch { /* absence of a vault is absence of a key */ }
  try {
    const { readFileSync } = await import('node:fs');
    keyed = keyed || /^TYPESAFE_API_KEY=.+/m.test(readFileSync(`${process.env.HOME}/.clementine-next/.env`, 'utf8'));
  } catch { /* no .env is fine */ }

  console.log(`No shadow verdicts in the last ${hours}h.`);
  if (!keyed) {
    console.log('No Jev key is configured, so tryJevGroundingVerdict returns null and the');
    console.log('shadow records nothing. Paste a key to start collecting.');
  } else {
    console.log('A Jev key IS configured, so this is not a wiring problem: the grounding');
    console.log('gate only fires on an IRREVERSIBLE EXTERNAL WRITE that has session');
    console.log('artifacts to verify against. Ordinary chat traffic never reaches it.');
    console.log('');
    console.log('So agreement cannot be measured by using Clem normally — it needs real');
    console.log('sends. Until some happen, this is an untested gate with a live key, not');
    console.log('a gate with a clean record.');
  }
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
