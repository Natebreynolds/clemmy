#!/usr/bin/env tsx
/**
 * Live latency/token COHORTS for the verified-memory loop — the percentile
 * protocol, not single observations.
 *
 *   COLD cohort: N samples, each in a FRESH scratch home (nothing learned,
 *   full discovery), one real brain turn asking a calendar question.
 *   WARM cohort: N samples in ONE scratch home seeded by a real cold turn,
 *   each a paraphrase turn (candidates + card present).
 *
 * Reports per cohort: attempted, succeeded, errored, p50/p90/p95 wall-clock,
 * model turns (assistant tool-call boundaries), discovery calls, provider
 * dispatches, and session token usage (uncached input+output as accrued by
 * the runtime's own accounting). Timeouts and errors stay in the attempted
 * count — a sample is never dropped to improve a percentile.
 *
 * Credentials are copied from the live home; the brain is forced ALL-IN BYO
 * so the live daemon's OAuth tokens are never touched. Reads only.
 *
 * Usage: npx tsx scripts/cohort-verified-memory-live.ts [samples=30]
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LIVE_HOME = path.join(os.homedir(), '.clementine-next');
const SAMPLES = Math.max(3, Number(process.argv[2] ?? 30));
if (!existsSync(path.join(LIVE_HOME, '.env'))) {
  console.error('COHORT ABORT: no live credentials (~/.clementine-next/.env).');
  process.exit(2);
}

interface Sample {
  ok: boolean;
  ms: number;
  toolCalls: number;
  discovery: number;
  dispatches: number;
  tokens: number;
  error?: string;
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function summarize(name: string, samples: Sample[]): Record<string, unknown> {
  const ok = samples.filter((s) => s.ok);
  const ms = ok.map((s) => s.ms);
  return {
    cohort: name,
    attempted: samples.length,
    succeeded: ok.length,
    errored: samples.length - ok.length,
    p50_ms: Math.round(pct(ms, 0.5)),
    p90_ms: Math.round(pct(ms, 0.9)),
    p95_ms: Math.round(pct(ms, 0.95)),
    meanModelTurns: ok.length ? (ok.reduce((a, s) => a + s.toolCalls, 0) / ok.length).toFixed(1) : null,
    meanDiscoveryCalls: ok.length ? (ok.reduce((a, s) => a + s.discovery, 0) / ok.length).toFixed(2) : null,
    meanProviderDispatches: ok.length ? (ok.reduce((a, s) => a + s.dispatches, 0) / ok.length).toFixed(2) : null,
    meanSessionTokens: ok.length ? Math.round(ok.reduce((a, s) => a + s.tokens, 0) / ok.length) : null,
  };
}

/** One turn in a CHILD process so every cold sample is a genuinely fresh
 *  process + home (no module-level caches smuggling warmth between samples). */
function runTurnInChild(home: string, sessionId: string, message: string, answerAccount: boolean): Sample {
  const script = `
    process.env.CLEMENTINE_HOME = ${JSON.stringify(home)};
    process.env.MODEL_ROUTING_MODE = 'all_in';
    process.env.CLEMMY_LOCAL_EMBEDDINGS = 'on';
    const { respondPreferHarness } = await import(${JSON.stringify(path.resolve('src/runtime/harness/respond-bridge.js'))});
    const eventlog = await import(${JSON.stringify(path.resolve('src/runtime/harness/eventlog.js'))});
    const t0 = performance.now();
    let error = '';
    async function turn(message) {
      const res = await respondPreferHarness('home', { message, sessionId: ${JSON.stringify(sessionId)} },
        async (req) => ({ text: '(legacy fallback)', sessionId: req.sessionId }));
      return res;
    }
    try {
      let res = await turn(${JSON.stringify(message)});
      if (${answerAccount} && /which|choose|account/i.test(res.text ?? '')) {
        res = await turn('Use the first one.');
      }
      if (res.stoppedReason === 'error') error = 'turn errored';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const ms = performance.now() - t0;
    const events = eventlog.listEvents(${JSON.stringify(sessionId)});
    const tool = events.filter((e) => e.type === 'tool_called');
    const named = (re) => tool.filter((e) => re.test(String((e.data ?? {}).tool ?? ''))).length;
    let tokens = 0;
    try { tokens = eventlog.getSessionTokensUsed(${JSON.stringify(sessionId)}); } catch {}
    console.log('SAMPLE ' + JSON.stringify({
      ok: !error, ms, toolCalls: tool.length,
      discovery: named(/composio_search|composio_list_tools|get_raw_tool_details|tool_search/),
      dispatches: named(/composio_execute_tool/),
      tokens, error: error || undefined,
    }));
  `;
  const scriptPath = path.join(home, 'cohort-turn.mts');
  writeFileSync(scriptPath, script, 'utf-8');
  try {
    const stdout = execFileSync('npx', ['tsx', scriptPath], { encoding: 'utf-8', timeout: 240_000 });
    const line = stdout.split('\n').find((l) => l.startsWith('SAMPLE '));
    if (!line) return { ok: false, ms: 0, toolCalls: 0, discovery: 0, dispatches: 0, tokens: 0, error: 'no sample line' };
    return JSON.parse(line.slice('SAMPLE '.length)) as Sample;
  } catch (err) {
    return {
      ok: false, ms: 240_000, toolCalls: 0, discovery: 0, dispatches: 0, tokens: 0,
      error: err instanceof Error ? err.message.slice(0, 120) : 'spawn failed',
    };
  }
}

function freshHome(tag: string): string {
  const home = mkdtempSync(path.join(os.tmpdir(), `clem-cohort-${tag}-`));
  mkdirSync(path.join(home, 'state'), { recursive: true });
  copyFileSync(path.join(LIVE_HOME, '.env'), path.join(home, '.env'));
  if (existsSync(path.join(LIVE_HOME, 'state', 'secrets-vault.json'))) {
    copyFileSync(path.join(LIVE_HOME, 'state', 'secrets-vault.json'), path.join(home, 'state', 'secrets-vault.json'));
  }
  writeFileSync(path.join(home, 'state', 'machine-id'), `cohort-${tag}\n`);
  return home;
}

// COLD: every sample is a fresh home AND a fresh process.
const coldSamples: Sample[] = [];
for (let i = 0; i < SAMPLES; i += 1) {
  const home = freshHome(`cold${i}`);
  const sample = runTurnInChild(home, `cohort-cold-${i}`, "What's on my calendar tomorrow?", true);
  coldSamples.push(sample);
  console.error(`cold ${i + 1}/${SAMPLES}: ${sample.ok ? `${Math.round(sample.ms)}ms` : `ERR ${sample.error}`}`);
}

// WARM: one home, seeded by a real cold turn, then N paraphrase samples
// (fresh process each, so the durable stores — not process caches — carry
// the warmth; the local model reloads per process like a restarted daemon).
const warmHome = freshHome('warm');
const seed = runTurnInChild(warmHome, 'cohort-warm-seed', "What's on my calendar tomorrow?", true);
console.error(`warm seed: ${seed.ok ? `${Math.round(seed.ms)}ms` : `ERR ${seed.error}`}`);
const paraphrases = [
  'What does my day look like tomorrow?',
  'Anything on deck tomorrow?',
  'How busy am I tomorrow?',
];
const warmSamples: Sample[] = [];
for (let i = 0; i < SAMPLES; i += 1) {
  const sample = runTurnInChild(
    warmHome, `cohort-warm-${i}`, paraphrases[i % paraphrases.length]!, true,
  );
  warmSamples.push(sample);
  console.error(`warm ${i + 1}/${SAMPLES}: ${sample.ok ? `${Math.round(sample.ms)}ms` : `ERR ${sample.error}`}`);
}

console.log(JSON.stringify({
  samplesPerCohort: SAMPLES,
  cold: summarize('cold', coldSamples),
  warm: summarize('warm', warmSamples),
  rawColdMs: coldSamples.map((s) => (s.ok ? Math.round(s.ms) : `ERR:${s.error}`)),
  rawWarmMs: warmSamples.map((s) => (s.ok ? Math.round(s.ms) : `ERR:${s.error}`)),
}, null, 2));
