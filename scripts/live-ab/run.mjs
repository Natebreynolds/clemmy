#!/usr/bin/env node
// Live A/B runner: drives the installed app on the live home through the real
// chat ingress, one fresh session per test and pass, and keeps each pass's
// proof receipt. Compare two labels with compare.mjs.
//   node scripts/live-ab/run.mjs --label B6 --expect-sha <served gitSha> [--passes 2] [--only id,id] [--out <results dir>]
//
// Each pass gets its own fixture folder (<label>-p<pass>), so a later pass
// never sees files an earlier one wrote. Daemon quiet is sampled before and
// after every turn from a fresh liveness record of the served process; a
// missing or stale record is "unknown", which the comparison treats as
// contended. Wall time and the receipt's cumulative model work are recorded
// side by side; their difference is not host time and is not computed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const label = arg('--label'); const expectSha = arg('--expect-sha'); const passes = Number(arg('--passes') ?? 2);
if (!label || !/^[A-Za-z0-9-]+$/.test(label) || !expectSha) throw new Error('--label <name> and --expect-sha <sha> are required');
const resultsRoot = path.resolve(arg('--out') ?? path.join(repo, 'output', 'live-ab', 'results'));
const home = path.join(os.homedir(), '.clementine-next');
const env = Object.fromEntries(readFileSync(path.join(home, '.env'), 'utf8').split('\n').flatMap((l) => {
  const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l.trim()); return m ? [[m[1], m[2].trim().replace(/^(['"])(.*)\1$/, '$2')]] : [];
}));
const base = `http://127.0.0.1:${env.WEBHOOK_PORT || '8420'}`;
const buildInfo = () => fetch(`${base}/api/console/build-info`, { headers: { authorization: `Bearer ${env.WEBHOOK_SECRET}` } }).then((r) => r.json());
const info = await buildInfo();
if (!String(info.gitSha).startsWith(expectSha)) throw new Error(`daemon serves ${info.gitSha}, not ${expectSha}; nothing submitted`);

const fixtureRoot = path.join(os.homedir(), 'clem-fixtures', 'live-ab');
mkdirSync(fixtureRoot, { recursive: true });
const SOURCE = 'live A/B fixture source\n';
writeFileSync(path.join(fixtureRoot, 'source.txt'), SOURCE);

const only = arg('--only')?.split(',');
const tests = JSON.parse(readFileSync(path.join(here, 'tests.json'), 'utf8')).filter((t) => !only || only.includes(t.id));
if (!tests.length) throw new Error('--only matched no test');

const liveness = path.join(home, 'logs', 'desktop', 'daemon-liveness.json');
const BUSY = /memory_maintenance|calendar_watch|noticing|work_review|workflow|suggestions/;
/** What the served daemon is doing now, or "unknown" when its record is missing or stale. */
function sampleDaemon() {
  try {
    const age = Date.now() - statSync(liveness).mtimeMs;
    const d = JSON.parse(readFileSync(liveness, 'utf8'));
    if (age > 30_000 || (info.pid && d.pid && d.pid !== info.pid)) return { liveness: 'unknown', busy: [], load: os.loadavg()[0] };
    const names = [d.phase?.name, ...(d.inFlight ?? []).map((x) => x.name)].filter(Boolean);
    return { liveness: 'fresh', busy: names.filter((n) => BUSY.test(n)), load: os.loadavg()[0] };
  } catch {
    return { liveness: 'unknown', busy: [], load: os.loadavg()[0] };
  }
}
async function quiet() {
  const started = Date.now();
  for (;;) {
    const s = sampleDaemon();
    if (s.liveness === 'fresh' && s.busy.length === 0) return { waitedMs: Date.now() - started, ...s };
    if (Date.now() - started > 600_000) return { waitedMs: Date.now() - started, ...s };
    await new Promise((r) => setTimeout(r, 5000));
  }
}

const outDir = path.join(resultsRoot, label); mkdirSync(outDir, { recursive: true });
const summary = { label, gitSha: info.gitSha, sourceFingerprint: info.sourceFingerprint, startedAt: new Date().toISOString(), tests: [] };
for (let pass = 1; pass <= passes; pass++) {
  const fixtureLabel = `${label}-p${pass}`;
  const fixtureDir = path.join(fixtureRoot, fixtureLabel);
  rmSync(fixtureDir, { recursive: true, force: true });
  for (const t of tests) {
    const start = await quiet();
    const sub = (s) => s.replaceAll('{LABEL}', fixtureLabel).replaceAll('{FIXTURES}', '~/clem-fixtures/live-ab');
    const msg = { message: sub(t.message), expect: JSON.parse(sub(JSON.stringify(t.expect))) };
    const msgFile = path.join(outDir, `${t.id}.p${pass}.messages.json`); writeFileSync(msgFile, JSON.stringify([msg], null, 2));
    const out = path.join(outDir, `${t.id}.p${pass}.json`);
    const started = Date.now();
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/live-foreground-proof.mts', '--messages', msgFile, '--home', home, '--out', out, '--timeout-ms', '600000'],
      { cwd: repo, encoding: 'utf8', timeout: 660_000 });
    const end = sampleDaemon();
    const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
    const turn = report?.turns?.[0] ?? {};
    const m = turn.measurement ?? {};
    const row = {
      id: t.id, pass, fixture: fixtureLabel,
      quietWaitMs: start.waitedMs, liveness: start.liveness === 'fresh' && end.liveness === 'fresh' ? 'fresh' : 'unknown',
      busyAtStart: start.busy, busyAtEnd: end.busy, loadAtStart: start.load, loadAtEnd: end.load,
      exit: run.status, error: run.status === 0 ? null : (run.stderr || run.stdout || '').trim().split('\n').slice(-2).join(' | ').slice(0, 300),
      terminal: turn.terminal?.turnOutcome?.status ?? m.terminalStatus ?? null,
      assertionsPassed: turn.assertions?.passed ?? null, failures: turn.assertions?.failures ?? [],
      modelRequests: turn.modelRequests ?? null, toolCalls: m.canonicalTopLevelToolCalls ?? null,
      promptTokens: m.promptTokens ?? null, uncachedInputTokens: m.uncachedInputTokens ?? null, outputTokens: m.outputTokens ?? null,
      wallMs: m.turnWallMs ?? null, cumulativeModelWorkMs: m.sdkDurationMs ?? null, driverMs: Date.now() - started,
      usageCertified: m.usageAttributionCertified ?? null, uncertifiedUsageCalls: m.uncertifiedUsageCalls ?? null,
      sessionId: turn.accepted?.sessionId ?? null, reply: String(turn.terminal?.reply ?? '').slice(0, 600),
    };
    summary.tests.push(row);
    console.log(JSON.stringify({ label, pass, id: t.id, terminal: row.terminal, assertionsPassed: row.assertionsPassed, rounds: row.modelRequests, promptTokens: row.promptTokens, wallMs: row.wallMs, liveness: row.liveness, busyAtEnd: row.busyAtEnd }));
    writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  }
  // What the reply cannot prove: the exact bytes each pass wrote.
  const read = (name) => (existsSync(path.join(fixtureDir, name)) ? readFileSync(path.join(fixtureDir, name), 'utf8') : null);
  const copied = read('source.txt');
  const note = read('note.md');
  (summary.fixtures ??= []).push({
    pass, fixture: fixtureLabel,
    copyExact: copied === null ? null : copied === SOURCE,
    noteExact: note === null ? null : note.trim() === `fixture note ${fixtureLabel}`,
  });
}
summary.finishedAt = new Date().toISOString();
summary.servedAtEnd = (await buildInfo().catch(() => ({}))).gitSha ?? null;
if (summary.servedAtEnd !== info.gitSha) summary.identityChanged = true;
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ label, done: true, fixtures: summary.fixtures, identityChanged: summary.identityChanged ?? false }));
