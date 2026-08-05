/**
 * Run: npx tsx --test src/runtime/production-final-closeout.test.ts
 *
 * E0 red suite — production behavior/continuity/activity findings 31-38 plus
 * the repo-wide architecture gates (production reachability, no
 * phrase-shape long-task routing, no NUL bytes in tracked source). Red at
 * ac9ae24c; the permanent wiring contract once E4-E7 land.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

/** Tracked-source content scan. Pure fs — no silent dependence on an
 *  external binary whose absence would make a reachability gate vacuous. */
function trackedFiles(prefix: string): string[] {
  return execFileSync('git', ['ls-files', prefix], { cwd: ROOT, encoding: 'utf-8' })
    .split('\n')
    .filter((file) => /\.(ts|tsx|mts)$/.test(file));
}

function filesContaining(pattern: RegExp, prefix = 'src'): string[] {
  const matches: string[] = [];
  for (const file of trackedFiles(prefix)) {
    const absolute = path.join(ROOT, file);
    if (!existsSync(absolute)) continue;
    if (pattern.test(readFileSync(absolute, 'utf-8'))) matches.push(file);
  }
  return matches;
}

// ─── Finding 31: the read lane must have a production caller ─────────────────

test('F31: runColdToWarmRead is production-connected — a non-test caller exists outside the read-path directory', () => {
  const callers = filesContaining(/runColdToWarmRead|resolveAcceptedTurnRead/)
    .filter((file) => !file.includes('.test.') && !file.startsWith('src/runtime/read-path/'));
  assert.ok(callers.length > 0,
    'the release\'s principal feature is dormant: no production file consumes the read lane');
});

// ─── Finding 32: both brains share one accepted-turn resolver ────────────────

test('F32: the shared brain boundary (respond-bridge) routes both brains through one accepted-turn read resolver', () => {
  const bridge = readFileSync(path.join(ROOT, 'src', 'runtime', 'harness', 'respond-bridge.ts'), 'utf-8');
  assert.match(bridge, /acceptedTurnRead|readLaneResolver|resolveAcceptedTurnRead/,
    'respond-bridge.ts never consults the read resolver — wiring only loop.ts misses the Claude SDK/bridge brain split');
});

// ─── Finding 33: hard continuation, not history-reading instructions ─────────

test('F33: background handoff carries a durable continuation capsule id — not an instruction to read session_history and infer', () => {
  const backgroundTasks = readFileSync(path.join(ROOT, 'src', 'execution', 'background-tasks.ts'), 'utf-8');
  assert.match(backgroundTasks, /capsuleId|continuationCapsule|CAPSULE/,
    'the background task record carries no continuation capsule — completed work is still inferred from origin history prose');
});

// ─── Finding 34: the chat fanout node dispatches durable work ────────────────

test('F34: the compiled chat fanout node dispatches through the durable manifest adapter — not the mega-core under a shadow warning', () => {
  const compiler = readFileSync(path.join(ROOT, 'src', 'runtime', 'graph', 'turn-graph-compiler.ts'), 'utf-8');
  assert.equal(compiler.includes('multi_item_fanout_shadow_only'), false,
    'the fanout node still hosts the old core with a shadow-only warning — production workers appear only if the model chooses run_worker');
});

// ─── Finding 35: no whole-run item ceiling ───────────────────────────────────

test('F35: canonical items beyond the 256 worker-schema window route to durable workflow windows — never a refusal or subset', () => {
  const adapters = filesContaining(/durableManifestWindows|manifestWindow|dispositionToDurableWork/)
    .filter((file) => !file.includes('.test.'));
  assert.ok(adapters.length > 0,
    'no windowing adapter exists above the 256-item worker schema — a 514-item request is a refusal/subset risk');
});

// ─── Finding 36: server-owned privacy-safe activity labels ───────────────────

test('F36: the server projection emits privacy-safe human labels — console activity does not depend on raw tool args', () => {
  const projection = readFileSync(path.join(ROOT, 'src', 'runtime', 'graph', 'surface-projection.ts'), 'utf-8');
  assert.match(projection, /label|publicLabel|activityLabel/,
    'the surface projection carries no safe label field — the console derives activity from raw args the privacy projection strips');
});

// ─── Finding 37: transports consume worker/batch lifecycle ───────────────────

test('F37: the shared Slack/Discord transport progress reducer consumes the server activity projection', () => {
  // The shared presentation allowlist already NAMES worker event types; the
  // audited gap is that the transport milestone reducer (kickoff, rate-limited
  // milestone edits, final replacement) never consumes the server-owned
  // activity projection, so Slack/Discord progress cannot reflect real
  // worker/batch lifecycle.
  const consumers = filesContaining(/surface-projection|activityProjection|transportProgress/)
    .filter((file) => !file.includes('.test.')
      && (file.includes('discord') || file.includes('slack') || file.includes('channels/')));
  assert.ok(consumers.length > 0,
    'no Slack/Discord transport consumes the activity projection — milestone edits cannot reflect real fan-out');
});

// ─── Finding 38: staleness is lease truth, not wall-clock silence ────────────

test('F38: liveness/staleness derive from durable lease/heartbeat truth, not "no event for N seconds"', () => {
  const projection = readFileSync(path.join(ROOT, 'src', 'runtime', 'graph', 'surface-projection.ts'), 'utf-8');
  // The REQUIRED contract is a liveness DERIVATION: an exported function that
  // classifies a run as live/stale from durable lease/heartbeat/attempt truth.
  // A field comment mentioning a lease horizon is not a derivation.
  assert.match(projection, /export function derive(Run)?Liveness|export function livenessFor|staleBy(Lease|Heartbeat)/,
    'the projection exports no lease/heartbeat liveness derivation — 60 seconds of quiet provider work reads as idle');
});

// ─── Architecture gate: no phrase-shape long-task routing ────────────────────

test('GATE: automatic long-task routing carries no provider/service/task nouns and the data-pipeline regex classifier is retired from routing', () => {
  const suspects = filesContaining(/hasAutomaticDataPipelineShape/)
    .filter((file) => !file.includes('.test.') && !file.includes('final-closeout'));
  assert.deepEqual(suspects, [],
    `phrase-shape routing still decides workload disposition: ${suspects.join(', ')} — a typed WorkDisposition must replace service/verb matching`);
});

// ─── Architecture gate: no NUL bytes anywhere in tracked source ──────────────

test('GATE: no tracked source file contains a literal NUL byte', () => {
  const tracked = execFileSync('git', ['ls-files', 'src', 'scripts', 'apps'], { cwd: ROOT, encoding: 'utf-8' })
    .split('\n').filter((file) => /\.(ts|tsx|mts|mjs|js|json)$/.test(file));
  const offenders: string[] = [];
  for (const file of tracked) {
    const absolute = path.join(ROOT, file);
    if (!existsSync(absolute)) continue;
    if (readFileSync(absolute).includes(0)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `tracked source contains NUL bytes: ${offenders.join(', ')}`);
});
