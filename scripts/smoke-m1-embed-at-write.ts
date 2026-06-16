/**
 * smoke-m1-embed-at-write.ts — live verification of M1 (embed-at-write) against
 * the REAL OpenAI embedding model.
 *
 *   npx tsx scripts/smoke-m1-embed-at-write.ts
 *
 * Proves the felt win: a fact you JUST stated is semantically recallable in the
 * SAME session (by paraphrase, minimal shared tokens) — instead of being
 * invisible to semantic recall until the ~2-min nightly backfill tick.
 *
 * Uses an isolated temp CLEMENTINE_HOME so it never touches the real memory DB;
 * pulls the real OPENAI_API_KEY from ~/.clementine-next/.env so embeddings work.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Resolve the real OpenAI key from the user's env file (if not already in env).
if (!process.env.OPENAI_API_KEY) {
  try {
    const envText = readFileSync(path.join(os.homedir(), '.clementine-next', '.env'), 'utf8');
    const m = envText.match(/^OPENAI_API_KEY=(.*)$/m);
    if (m) process.env.OPENAI_API_KEY = m[1].replace(/^["']|["']$/g, '').trim();
  } catch { /* fall through — smoke will report embeddings unavailable */ }
}

// Isolated temp home BEFORE importing config/db.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-m1-smoke-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { resetMemoryDb, openMemoryDb } = await import('../src/memory/db.js');
const { rememberFact } = await import('../src/memory/facts.js');
const { embedQuery, cosine, loadFactEmbeddings, isEmbeddingsEnabled } = await import('../src/memory/embeddings.js');
const { triggerEmbedAtWrite, _resetEmbedAtWriteForTest } = await import('../src/memory/reflection.js');

let pass = 0, fail = 0;
const ok = (m: string) => { console.log(`   \x1b[32m✓\x1b[0m ${m}`); pass++; };
const no = (m: string, d = '') => { console.log(`   \x1b[31m✗\x1b[0m ${m}${d ? ' — ' + d : ''}`); fail++; };

console.log('\n\x1b[1m== M1 embed-at-write smoke (real embeddings) ==\x1b[0m');

resetMemoryDb();
openMemoryDb();

if (!isEmbeddingsEnabled()) {
  no('embeddings not enabled (need OPENAI_API_KEY) — cannot verify');
  rmSync(TMP_HOME, { recursive: true, force: true });
  process.exit(1);
}
ok('embeddings enabled (real model)');

// User just told Clementine two things this turn.
const coffee = rememberFact({ kind: 'user', content: 'Nathan takes his coffee with oat milk and no sugar.' });
const deploy = rememberFact({ kind: 'reference', content: 'The staging deploy runs nightly at 2am via cron.' });

// Before embed-at-write: the just-written facts have NO vectors (semantic recall blind).
const beforeVec = loadFactEmbeddings([coffee.id, deploy.id]).size;
if (beforeVec === 0) ok('just-written facts have NO vector yet (the pre-M1 gap)');
else no('expected no vectors immediately after write', `got ${beforeVec}`);

// M1: embed-at-write runs promptly (here, explicitly; in prod it fires from consolidateFact).
_resetEmbedAtWriteForTest();
await triggerEmbedAtWrite();

const after = loadFactEmbeddings([coffee.id, deploy.id]);
if (after.size === 2) ok('embed-at-write gave BOTH new facts vectors right away (no 2-min wait)');
else no('expected both facts embedded', `got ${after.size}`);

// The real felt win: a paraphrased query (minimal shared tokens) semantically
// recalls the coffee fact over the unrelated deploy fact — in the same session.
const q = 'what does he like in his morning latte?';
const qv = await embedQuery(q);
if (!qv) { no('query embedding failed'); }
else {
  const coffeeVec = after.get(coffee.id)!;
  const deployVec = after.get(deploy.id)!;
  const coffeeSim = cosine(qv, coffeeVec);
  const deploySim = cosine(qv, deployVec);
  if (coffeeSim > deploySim)
    ok(`paraphrase recall works: coffee fact ${coffeeSim.toFixed(3)} > deploy fact ${deploySim.toFixed(3)} for "${q}"`);
  else
    no('paraphrase recall', `coffee ${coffeeSim.toFixed(3)} !> deploy ${deploySim.toFixed(3)}`);
}

rmSync(TMP_HOME, { recursive: true, force: true });
console.log(`\n\x1b[1m== ${pass} passed, ${fail} failed ==\x1b[0m\n`);
process.exit(fail ? 1 : 0);
