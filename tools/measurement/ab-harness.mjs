/**
 * Labeled A/B harness for speed, token efficiency and accuracy.
 *
 * "Jev will be a game changer" is currently a hope with no number attached. Jev
 * is not live (no key in the vault or .env), so a clean no-Jev baseline can be
 * captured NOW and diffed the moment a key is pasted. Same shapes, same
 * measurements, one command.
 *
 * Measures the three things that decide the bet:
 *   SPEED     wall clock, and model time vs tool time vs unaccounted gap
 *   TOKENS    input / cached / UNCACHED (uncached is what is actually billed)
 *             plus tool_search rounds, since better ranking should mean fewer
 *   ACCURACY  the goal judge's own verdict, and whether a terminal was reached
 *
 *   node ab-harness.mjs capture <label>      # run the shapes, save a labeled run
 *   node ab-harness.mjs compare <a> <b>      # diff two labeled runs
 *
 * Read-only apart from the turns. Creates no workflow and no Space.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const HOME = process.env.HOME;
const PORT = 8520;
const DIR = new URL('./ab-runs/', import.meta.url).pathname;
const TOKEN = readFileSync(`${HOME}/.clementine-next/.env`, 'utf8')
  .split('\n').find((l) => l.startsWith('WEBHOOK_SECRET='))
  .split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');

/** Fixed shapes. Changing this list invalidates comparison against older runs,
 *  so the label records the set's own identity alongside the results. */
const SHAPES = [
  { key: 'zero-tool',  say: 'what is 41 times 19' },
  { key: 'one-read',   say: 'what is on my calendar tomorrow' },
  { key: 'multi-step', say: 'find tim in salesforce and tell me if he is on my calendar this week' },
  { key: 'ambiguous',  say: 'can you tidy that up for me' },
];
const SHAPE_SET_ID = SHAPES.map((s) => s.key).join('+');

const ev = () => new Database(`${HOME}/.clementine-next/state/harness.db`, { readonly: true });
const maxSeq = () => { const d = ev(); const r = d.prepare('SELECT MAX(seq) s FROM events').get(); d.close(); return r.s ?? 0; };
const j = (r) => { try { return JSON.parse(r.data_json); } catch { return {}; } };

function usageSince(sessionId, sinceIso) {
  const dir = `${HOME}/.clementine-next/state/token-usage`;
  const rows = [];
  if (!existsSync(dir)) return rows;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ndjson')).slice(-3)) {
    for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.source === sessionId && (!sinceIso || o.at > sinceIso)) rows.push(o);
    }
  }
  return rows;
}

function jevCallsIn(rows) {
  return rows.filter((r) => String(r.model || '').includes('jev')).length;
}

async function jevStatus() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/console/jev`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) return { configured: null, enabled: null, keySource: 'unknown', httpStatus: res.status };
    const body = await res.json();
    return {
      configured: Boolean(body.configured),
      enabled: Boolean(body.enabled),
      keySource: body.keySource ?? 'unknown',
      model: body.model ?? null,
    };
  } catch (err) {
    return { configured: null, enabled: null, keySource: 'unreachable', error: String(err) };
  }
}

async function runShape(shape) {
  const before = maxSeq();
  const sinceIso = new Date().toISOString();
  const clientRequestId = randomUUID();
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${PORT}/api/harness/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, origin: `http://127.0.0.1:${PORT}` },
    body: JSON.stringify({ input: shape.say, clientRequestId }),
  });
  const posted = await res.json().catch(() => ({}));
  if (!res.ok) return { ...shape, error: `POST ${res.status}` };
  let sid = posted.sessionId ?? posted.session?.id ?? null;

  let terminal = null;
  for (let i = 0; i < 150; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const d = ev();
    const rows = d.prepare('SELECT seq,session_id,type,data_json FROM events WHERE seq > ? ORDER BY seq ASC').all(before);
    d.close();
    if (!sid) {
      const mine = rows.find((r) => { try { return JSON.parse(r.data_json).clientRequestId === clientRequestId; } catch { return false; } });
      if (mine) sid = mine.session_id;
    }
    if (sid) {
      const t = rows.find((r) => r.session_id === sid && ['conversation_completed', 'run_failed'].includes(r.type));
      if (t) { terminal = t; break; }
    }
  }
  const wallMs = Date.now() - started;

  const d = ev();
  const rows = d.prepare('SELECT seq,type,created_at,data_json FROM events WHERE seq > ? AND session_id = ? ORDER BY seq ASC').all(before, sid ?? '');
  d.close();

  // Provider (tool) time from dispatch pairs; model time from the usage ledger.
  let toolMs = 0;
  const open = new Map();
  for (const r of rows) {
    if (r.type === 'provider_dispatch_started') open.set(j(r).tool ?? r.seq, Date.parse(r.created_at));
    else if (r.type === 'provider_dispatch_settled') {
      const k = j(r).tool ?? null;
      const t0 = k !== null && open.has(k) ? open.get(k) : null;
      if (t0) { toolMs += Math.max(0, Date.parse(r.created_at) - t0); open.delete(k); }
    }
  }
  const u = usageSince(sid, sinceIso);
  const input = u.reduce((a, r) => a + (r.inputTokens ?? 0), 0);
  const cached = u.reduce((a, r) => a + (r.cachedInputTokens ?? 0), 0);
  const output = u.reduce((a, r) => a + (r.outputTokens ?? 0), 0);
  const modelMs = u.reduce((a, r) => a + (r.durationMs ?? 0), 0);
  const toolCalls = rows.filter((r) => r.type === 'tool_called').map((r) => j(r).tool).filter(Boolean);
  const t = terminal ? j(terminal) : {};
  const judged = rows.filter((r) => r.type === 'goal_alignment_judged').map((r) => j(r).fulfills);

  return {
    ...shape,
    sessionId: sid,
    wallMs,
    modelMs,
    toolMs,
    gapMs: Math.max(0, wallMs - modelMs - toolMs),
    modelCalls: u.length,
    input,
    cached,
    uncached: Math.max(0, input - cached),
    output,
    toolCalls: toolCalls.length,
    toolSearches: toolCalls.filter((n) => n === 'tool_search').length,
    jevCalls: jevCallsIn(u),
    status: t.presentation?.status ?? t.turnOutcome?.status ?? (terminal ? '?' : 'NO_TERMINAL'),
    judgeFulfills: judged.length ? judged.every(Boolean) : null,
    reply: String(t.reply ?? t.presentation?.text ?? '').replace(/\s+/g, ' ').slice(0, 160),
  };
}

const TOTALS = ['wallMs', 'modelMs', 'toolMs', 'gapMs', 'modelCalls', 'input', 'cached', 'uncached', 'output', 'toolCalls', 'toolSearches', 'jevCalls'];

function summarize(results) {
  const out = {};
  for (const k of TOTALS) out[k] = results.reduce((a, r) => a + (r[k] ?? 0), 0);
  out.terminals = results.filter((r) => r.status !== 'NO_TERMINAL' && !r.error).length;
  out.judgePass = results.filter((r) => r.judgeFulfills === true).length;
  out.judgeSeen = results.filter((r) => r.judgeFulfills !== null).length;
  return out;
}

const [mode, a, b] = process.argv.slice(2);
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

if (mode === 'capture') {
  if (!a) { console.error('usage: ab-harness.mjs capture <label>'); process.exit(1); }
  const intervention = await jevStatus();
  console.log(`capturing "${a}"   shapes: ${SHAPE_SET_ID}   jev configured=${intervention.configured} enabled=${intervention.enabled} source=${intervention.keySource}\n`);
  const results = [];
  for (const shape of SHAPES) {
    const r = await runShape(shape);
    results.push(r);
    console.log(`  ${shape.key.padEnd(11)} ${String((r.wallMs / 1000).toFixed(1)).padStart(6)}s  `
      + `uncached ${String(r.uncached ?? 0).padStart(7)}  searches ${r.toolSearches ?? 0}  jev ${r.jevCalls ?? 0}  ${r.status ?? r.error}`);
  }
  const totals = summarize(results);
  const claimsNoJev = /no-?jev|jev-off/i.test(a);
  // A control is contaminated when Jev RAN, not when a key merely exists. The
  // first version tested `configured`, which rejected the only clean way to run
  // this: same key in the vault, same everything, CLEMMY_JEV flipped. Requiring
  // an absent key would change key-presence AND the flag between arms, so a
  // difference could not be attributed to either. `enabled` is the intervention;
  // `configured` is the environment, and the environment should match.
  const contaminated = claimsNoJev && (totals.jevCalls > 0 || intervention.enabled === true);
  const run = {
    label: a,
    shapeSet: SHAPE_SET_ID,
    capturedAt: new Date().toISOString(),
    intervention,
    contaminated,
    results,
    totals,
  };
  writeFileSync(`${DIR}/${a}.json`, JSON.stringify(run, null, 2) + '\n');
  if (contaminated) {
    console.log(`CONTAMINATED: label "${a}" claims Jev off but configured=${intervention.configured} jevCalls=${totals.jevCalls}`);
  }
  console.log(`\nsaved ${DIR}/${a}.json`);
  const t = run.totals;
  console.log(`totals: wall ${(t.wallMs / 1000).toFixed(1)}s  model ${(t.modelMs / 1000).toFixed(1)}s  `
    + `tool ${(t.toolMs / 1000).toFixed(1)}s  gap ${(t.gapMs / 1000).toFixed(1)}s`);
  console.log(`        uncached ${t.uncached}  cached ${t.cached}  output ${t.output}  searches ${t.toolSearches}`);
  console.log(`        terminals ${t.terminals}/${results.length}  judge ${t.judgePass}/${t.judgeSeen}`);
} else if (mode === 'compare') {
  if (!a || !b) { console.error('usage: ab-harness.mjs compare <a> <b>'); process.exit(1); }
  const A = JSON.parse(readFileSync(`${DIR}/${a}.json`, 'utf8'));
  const B = JSON.parse(readFileSync(`${DIR}/${b}.json`, 'utf8'));
  if (A.shapeSet !== B.shapeSet) {
    console.log(`REFUSED: different shape sets (${A.shapeSet} vs ${B.shapeSet}) — not comparable.`);
    process.exit(2);
  }
  const aJev = A.totals.jevCalls ?? A.results.reduce((n, r) => n + (r.jevCalls ?? 0), 0);
  const bJev = B.totals.jevCalls ?? B.results.reduce((n, r) => n + (r.jevCalls ?? 0), 0);
  if (A.contaminated || B.contaminated || (/no-?jev|jev-off/i.test(A.label) && aJev > 0) || (/no-?jev|jev-off/i.test(B.label) && bJev > 0)) {
    console.log('REFUSED: a labeled no-Jev control actually ran Jev. Do not treat this pair as causal.');
    console.log('  A clean control is: key still in the vault, CLEMMY_JEV=off, daemon RESTARTED');
    console.log('  (getRuntimeEnv reads process.env first, so editing .env alone changes nothing),');
    console.log('  and /api/console/jev reporting enabled=false with jevCalls=0.');
    console.log(`  ${A.label} jevCalls=${aJev} contaminated=${Boolean(A.contaminated)}`);
    console.log(`  ${B.label} jevCalls=${bJev} contaminated=${Boolean(B.contaminated)}`);
    process.exit(2);
  }
  const pct = (x, y) => (x === 0 ? (y === 0 ? '0%' : 'n/a') : `${(((y - x) / x) * 100).toFixed(1)}%`);
  console.log(`${a}  ->  ${b}    shapes: ${A.shapeSet}\n`);
  console.log('metric          ' + a.padStart(12) + b.padStart(12) + '       change');
  for (const k of TOTALS) {
    const x = A.totals[k] ?? 0, y = B.totals[k] ?? 0;
    console.log(`  ${k.padEnd(14)}${String(x).padStart(12)}${String(y).padStart(12)}       ${pct(x, y)}`);
  }
  console.log(`  ${'terminals'.padEnd(14)}${String(A.totals.terminals).padStart(12)}${String(B.totals.terminals).padStart(12)}`);
  console.log(`  ${'judgePass'.padEnd(14)}${String(A.totals.judgePass).padStart(12)}${String(B.totals.judgePass).padStart(12)}`);
  console.log('\nper shape (wall s / uncached tokens / tool_search rounds):');
  for (const shape of A.results) {
    const other = B.results.find((r) => r.key === shape.key) ?? {};
    console.log(`  ${shape.key.padEnd(11)} ${(shape.wallMs / 1000).toFixed(1)}s -> ${((other.wallMs ?? 0) / 1000).toFixed(1)}s   `
      + `${shape.uncached} -> ${other.uncached ?? 0}   ${shape.toolSearches} -> ${other.toolSearches ?? 0}`);
  }
  console.log('\nAccuracy is the one this cannot settle alone: equal judge counts mean the');
  console.log('goal judge agreed both times, not that the grounding verdicts matched. That');
  console.log('needs Jev and the existing judge run SIDE BY SIDE on the same turn.');
} else {
  console.error('usage: ab-harness.mjs capture <label> | compare <a> <b>');
  process.exit(1);
}
