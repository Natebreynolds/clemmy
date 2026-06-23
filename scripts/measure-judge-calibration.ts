/**
 * measure:judge-calibration — does each boundary judge agree with the human
 * gold set? (Lane A trust-layer P3). Runs the REAL cross-family judges over
 * src/runtime/eval/gold/judge-gold-set.json and reports Cohen's κ per
 * (judge-kind, judge-family) pairing.
 *
 * This is the one inherently-LIVE eval script (it calls models — same posture as
 * probe:judge:live): the κ math + gold set are CI-tested deterministically in
 * judge-calibration.test.ts; this measures the live judges.
 *
 * Run: npx tsx scripts/measure-judge-calibration.ts            (informational)
 *      npx tsx scripts/measure-judge-calibration.ts --strict   (exit 1 if any κ < 0.6)
 *
 * NOTE: a single run measures the pairing the ACTIVE brain resolves to (e.g.
 * Codex brain → Claude judge). To measure other pairings, switch the brain and
 * re-run. Default INFORMATIONAL per "guardrails inform, rarely block"; the hard
 * κ ≥ 0.6 gate (--strict) flips on after a 2-release bake + ~100 labels.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cohensKappa, kappaBand, KAPPA_GATE, type GoldSet, type GoldCase, type Label } from '../src/runtime/eval/judge-calibration.js';

const STRICT = process.argv.includes('--strict') || (process.env.JUDGE_CALIBRATION_STRICT || '').toLowerCase() === 'on';

const GOLD = JSON.parse(readFileSync(fileURLToPath(new URL('../src/runtime/eval/gold/judge-gold-set.json', import.meta.url)), 'utf8')) as GoldSet;

const [{ Agent, Runner }, { z }, { MODELS }, { normalizeZodForCodexStrict }, { resolveBoundaryJudge }, og, grounding, goalfid] = await Promise.all([
  import('@openai/agents'),
  import('zod'),
  import('../src/config.js'),
  import('../src/runtime/schema-normalizer.js'),
  import('../src/runtime/harness/debate-model.js'),
  import('../src/runtime/harness/output-grounding-gate.js'),
  import('../src/runtime/harness/grounding-gate.js'),
  import('../src/runtime/harness/goal-fidelity-gate.js'),
]);

const routing = resolveBoundaryJudge();
const judgeModel = routing.model ?? MODELS.fast;

type Src = { callId: string; tool: string | null; excerpt: string; createdAt: string };
const asSources = (input: Record<string, unknown>): Src[] =>
  ((input.sources as Array<{ callId: string; tool?: string | null; excerpt: string }>) ?? [])
    .map((s) => ({ callId: s.callId, tool: s.tool ?? null, excerpt: s.excerpt, createdAt: 'gold' }));

async function runJudge<T>(prompt: string, schema: T, name: string): Promise<unknown> {
  const agent = new Agent({
    name,
    instructions: 'Output only the structured verdict.',
    model: judgeModel,
    outputType: normalizeZodForCodexStrict(schema as never) as never,
    tools: [],
  });
  const runner = new Runner({ workflowName: `clementine-calibration-${name}` });
  const result = await runner.run(agent, prompt, { maxTurns: 1 });
  return result.finalOutput;
}

/** Run the real judge for one gold case → the binary verdict (pass = allow). */
async function judgeCase(c: GoldCase): Promise<Label> {
  if (c.judge === 'numeric_grounding') {
    const claims = og.extractNumericClaims(String(c.input.deliverable ?? ''));
    if (claims.length === 0) return 'pass';
    const schema = z.object({ verdict: z.enum(['grounded', 'contradicted', 'unverifiable']), offending: z.array(z.object({ figure: z.string(), kind: z.enum(['contradicted', 'no_source']), note: z.string() })), reason: z.string() });
    const out = z.object({ verdict: z.enum(['grounded', 'contradicted', 'unverifiable']) }).safeParse(await runJudge(og.buildOutputGroundingPrompt(claims, asSources(c.input)), schema, 'numeric-grounding'));
    return out.success && out.data.verdict === 'grounded' ? 'pass' : 'fail';
  }
  if (c.judge === 'grounding') {
    const schema = z.object({ grounded: z.boolean(), reason: z.string() });
    const out = z.object({ grounded: z.boolean() }).safeParse(await runJudge(grounding.buildGroundingPrompt(String(c.input.payload ?? ''), asSources(c.input)), schema, 'grounding'));
    return out.success && out.data.grounded ? 'pass' : 'fail';
  }
  // goal_fidelity
  const schema = z.object({ fulfills: z.boolean(), gap: z.string() });
  const out = z.object({ fulfills: z.boolean() }).safeParse(await runJudge(goalfid.buildGoalFidelityPrompt(c.input as never), schema, 'goal-fidelity'));
  return out.success && out.data.fulfills ? 'pass' : 'fail';
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length); }

console.log(`\n  Judge calibration — Cohen's κ vs the human gold set (${GOLD.cases.length} labels)`);
console.log(`  judge model: ${routing.modelId}  ·  family pairing: ${routing.brainFamily} brain → ${routing.judgeFamily} judge${routing.selfJudge ? ' (SELF-JUDGE — no cross-family available)' : ''}\n`);

// Group by judge kind; run each case's real judge; pair with the human label.
const byKind = new Map<string, Array<{ human: Label; judge: Label }>>();
let mismatchNotes: string[] = [];
for (const c of GOLD.cases) {
  let judged: Label;
  try { judged = await judgeCase(c); }
  catch (e) { console.error(`  ! ${c.id}: judge error — ${e instanceof Error ? e.message : String(e)}`); continue; }
  const arr = byKind.get(c.judge) ?? [];
  arr.push({ human: c.humanLabel, judge: judged });
  byKind.set(c.judge, arr);
  if (judged !== c.humanLabel) mismatchNotes.push(`${c.id}: human=${c.humanLabel} judge=${judged}`);
}

console.log('  ' + pad('JUDGE KIND', 20) + pad('N', 5) + pad('po', 8) + pad('κ', 9) + pad('BAND', 18) + 'GATE');
console.log('  ' + '-'.repeat(72));
let worstKappa = 1;
let measured = 0;
for (const [kind, pairs] of byKind) {
  const r = cohensKappa(pairs);
  if (!Number.isNaN(r.kappa)) { worstKappa = Math.min(worstKappa, r.kappa); measured += 1; }
  const gate = Number.isNaN(r.kappa) ? '—' : (r.kappa >= KAPPA_GATE ? `✓ ≥${KAPPA_GATE}` : `✗ <${KAPPA_GATE}`);
  console.log('  ' + pad(kind, 20) + pad(String(r.n), 5) + pad(r.po.toFixed(2), 8) + pad(r.kappa.toFixed(2), 9) + pad(kappaBand(r.kappa), 18) + gate);
}
console.log('  ' + '-'.repeat(72));
if (mismatchNotes.length) { console.log('\n  disagreements:'); for (const m of mismatchNotes) console.log('    · ' + m); }
console.log(`\n  worst κ across measured kinds: ${measured ? worstKappa.toFixed(2) : 'n/a'}  (gate ${KAPPA_GATE})\n`);

if (measured && worstKappa < KAPPA_GATE) {
  if (STRICT) { console.error(`  ✗ a judge κ is below ${KAPPA_GATE} — failing (strict).\n`); process.exit(1); }
  console.log(`  ⚠ a judge κ is below ${KAPPA_GATE} (informational — grow the gold set / re-baseline; --strict to gate).\n`);
} else if (measured) {
  console.log(`  ✓ every measured judge κ ≥ ${KAPPA_GATE}.\n`);
}
