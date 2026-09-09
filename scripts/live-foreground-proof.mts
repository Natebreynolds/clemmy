/**
 * Drive an already running dev daemon through its real durable chat ingress.
 * Messages are explicit input files; this runner never infers or retries writes.
 * Receipt ownership, terminal state and effect counts come from the journal.
 *
 * node --import tsx scripts/live-foreground-proof.mts --messages /absolute/messages.json
 *   [--home /absolute/clem-home] [--session existing-session] [--out /absolute/report.json]
 *
 * messages.json is an array of strings or messages with explicit expectations.
 * Completion is the default. An intermediate clarification may explicitly
 * accept needs_input; blocked/failed turns always stop the sequence. Inspect
 * the actual question as well as these mechanical assertions.
 */
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { measureAcceptedTurn } from './session-comparison.js';
import { z } from 'zod';
import { checkLiveTurn, LiveProofMessageSchema, type LiveTurnFacts } from './lib/live-foreground-proof-assertions.js';
import { taskModeFields } from '../src/runtime/harness/task-mode.js';
import { fingerprintRuntimeSourceFromGit } from '../src/runtime/source-fingerprint.js';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
// A QUALIFICATION RUN IS NOT THE OWNER'S CONVERSATION HISTORY.
//
// This defaulted to the owner's personal home, so every proof run landed in the
// same session list they read on desktop and mobile. Measured 2026-09-07: 614 of
// 874 chat sessions in that home were driver runs — two of every three
// conversations the owner saw were mine, with no marker distinguishing them.
//
// The default is now a dedicated qualification home. Pass --home explicitly to
// aim somewhere else; running against the owner's own home is a deliberate act,
// never the path of least resistance.
const DEFAULT_PROOF_HOME = path.join(os.homedir(), '.clementine-next-live-proof');
const home = path.resolve(option('--home') ?? DEFAULT_PROOF_HOME);
const messagesPath = option('--messages');
if (!messagesPath) throw new Error('--messages /absolute/messages.json is required');
const messages = z.array(LiveProofMessageSchema).nonempty().parse(JSON.parse(readFileSync(messagesPath, 'utf8')));
const output = path.resolve(option('--out') ?? path.join('output', 'live-proofs', `${Date.now()}.json`));
const expectedFingerprint = option('--expected-source-fingerprint');
const expectedEntry = option('--expected-entry');
const mobileCredentialsPath = option('--mobile-credentials');
const mobileCredentials = mobileCredentialsPath ? z.object({
  cookie: z.string().min(1), deviceId: z.string().min(1), sessionFingerprint: z.string().min(1),
  privateKeyJwk: z.record(z.string(), z.unknown()),
}).strict().parse(JSON.parse(readFileSync(mobileCredentialsPath, 'utf8'))) : null;
const mobileKey = mobileCredentials ? createPrivateKey({ key: mobileCredentials.privateKeyJwk as never, format: 'jwk' }) : null;
if (expectedFingerprint && !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new Error('invalid expected source fingerprint');
const timeoutMs = Number(option('--timeout-ms') ?? 360_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000) {
  throw new Error('--timeout-ms must be between 1000 and 1800000');
}
const env = Object.fromEntries(readFileSync(path.join(home, '.env'), 'utf8').split('\n').flatMap((line) => {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  return match ? [[match[1]!, match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2')]] : [];
}));
const baseUrl = `http://127.0.0.1:${env.WEBHOOK_PORT || '8420'}`;
const secret = env.WEBHOOK_SECRET;
if (!secret) throw new Error('The dev home has no WEBHOOK_SECRET; no request submitted');
const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
const db = new Database(path.join(home, 'state', 'harness.db'), { readonly: true, fileMustExist: true });
let sessionId = option('--session');
const report: Record<string, unknown> = { version: 1, startedAt: new Date().toISOString(), baseUrl, home,
  surface: mobileCredentials ? 'authenticated_mobile_http' : 'desktop_http', turns: [] };
const turns = report.turns as Record<string, unknown>[];
function save(): void {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
async function api(url: string, body?: unknown, mobileRequestKey?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const method = body === undefined ? 'GET' : 'POST';
  let requestHeaders: Record<string, string> = headers;
  if (url.startsWith('/m/')) {
    if (!mobileCredentials || !mobileKey) throw new Error('Mobile proof credentials are required');
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encoded({ alg: 'ES256', typ: 'JWT' })}.${encoded({
      htm: method, htu: url.split('?')[0], iat: Math.floor(Date.now() / 1000),
      jti: randomUUID(), sfp: mobileCredentials.sessionFingerprint,
    })}`;
    const signature = sign('sha256', Buffer.from(unsigned), { key: mobileKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    requestHeaders = { 'content-type': 'application/json', cookie: mobileCredentials.cookie,
      'x-clem-device-proof': `${unsigned}.${signature}`,
      ...(mobileRequestKey ? { 'idempotency-key': mobileRequestKey } : {}) };
  }
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${url}`, {
    method, headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    // A slow daemon is evidence, not a driver failure: record the latency and
    // let the assertions judge it (live 2026-09-09: the post-terminal
    // build-info read exceeded 20 s after a 50-write turn).
    signal: AbortSignal.timeout(90_000),
  });
  const latencyMs = Date.now() - startedAt;
  ((report as { requestLatencies?: unknown[] }).requestLatencies ??= []).push({ at: new Date(startedAt).toISOString(), url, latencyMs, status: response.status });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
try {
  const build = await api('/api/console/build-info');
  if (build.status !== 200) throw new Error(`build-info HTTP ${build.status}; no request submitted`);
  if (expectedFingerprint && build.body.sourceFingerprint !== expectedFingerprint) throw new Error('intended candidate fingerprint is not serving; no request submitted');
  if (expectedEntry && build.body.entry !== expectedEntry) throw new Error('intended candidate entry is not serving; no request submitted');
  if (expectedEntry) {
    report.sourceFingerprintBefore = fingerprintRuntimeSourceFromGit({ repoRoot: path.dirname(path.dirname(expectedEntry)) });
    if (report.sourceFingerprintBefore !== build.body.sourceFingerprint) throw new Error('candidate source changed after boot; no request submitted');
  }
  report.candidateMatched = expectedFingerprint ? true : null;
  report.buildBefore = build.body;
  save();
  for (const { message, expect, taskMode } of messages) {
    const clientRequestId = `live-foreground-${randomUUID()}`;
    const requestId = mobileCredentials ? `mobile:${createHash('sha256').update(mobileCredentials.deviceId).update('\0').update(clientRequestId).digest('hex')}` : clientRequestId;
    const accepted = mobileCredentials
      ? await api('/m/api/chat/send', { message, async: true, ...taskModeFields(taskMode), ...(sessionId ? { sessionId } : {}) }, clientRequestId)
      : await api('/api/harness/chat', { input: message, clientRequestId, ...taskModeFields(taskMode), ...(sessionId ? { sessionId } : {}) });
    if (accepted.status !== 202 || (!mobileCredentials && accepted.body.clientRequestId !== clientRequestId)
      || (mobileCredentials && accepted.body.accepted !== true)
      || typeof accepted.body.runId !== 'string' || typeof accepted.body.sessionId !== 'string') {
      throw new Error(`chat not accepted as an exact new request: HTTP ${accepted.status}; ${JSON.stringify(accepted.body).slice(0, 500)}`);
    }
    const receipt = db.prepare('SELECT session_id, run_id FROM harness_chat_requests WHERE request_id = ?').get(requestId) as { session_id: string; run_id: string } | undefined;
    if (!receipt || receipt.session_id !== accepted.body.sessionId || receipt.run_id !== accepted.body.runId) {
      throw new Error('accepted HTTP identity has no matching durable request receipt');
    }
    sessionId = accepted.body.sessionId;
    const turn: Record<string, unknown> = { message, expect, ...taskModeFields(taskMode), clientRequestId, requestId, accepted: accepted.body, startedAt: new Date().toISOString() };
    turns.push(turn);
    save();
    console.log(JSON.stringify({ phase: 'accepted', sessionId, runId: accepted.body.runId, turn: turns.length }));
    const deadline = Date.now() + timeoutMs;
    let source: { seq: number; session_id: string } | undefined;
    let terminal: { seq: number; data_json: string } | undefined;
    let lastProgress = '';
    while (Date.now() < deadline) {
      // The accepted run identity remains stable even if the shared ingress
      // selects a same-principal successor rather than the requested session.
      const sources = db.prepare(`SELECT seq, session_id FROM events
        WHERE type = 'user_input_received' AND json_extract(data_json, '$.runId') = ?
        AND session_id = ? ORDER BY seq`).all(receipt.run_id, receipt.session_id) as Array<{ seq: number; session_id: string }>;
      if (sources.length > 1) throw new Error('ambiguous accepted user source');
      source = sources[0];
      if (source) {
        const terminals = db.prepare(`SELECT seq, data_json FROM events
          WHERE session_id = ? AND type = 'conversation_completed'
          AND json_extract(data_json, '$.sourceUserSeq') = ? ORDER BY seq`).all(source.session_id, source.seq) as Array<{ seq: number; data_json: string }>;
        if (terminals.length > 1) throw new Error('multiple terminals for exact accepted source');
        terminal = terminals[0];
        const progress = db.prepare(`SELECT
          (SELECT count(*) FROM model_request_provenance WHERE session_id = ? AND source_user_seq = ?) modelRequests,
          count(*) toolCalls FROM events WHERE session_id = ? AND type = 'tool_called'
          AND json_extract(data_json, '$.sourceUserSeq') = ? AND json_extract(data_json, '$.accounting') = 'top_level'`
        ).get(source.session_id, source.seq, source.session_id, source.seq) as Record<string, number>;
        const rendered = JSON.stringify(progress);
        if (rendered !== lastProgress) {
          console.log(JSON.stringify({ phase: 'progress', sourceUserSeq: source.seq, ...progress }));
          lastProgress = rendered;
        }
        if (terminal) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!source || !terminal) {
      // Never blindly repeat a possibly effected request after a timeout.
      turn.timedOut = true;
      if (typeof accepted.body.cancelEndpoint === 'string') {
        turn.cancelResult = await api(accepted.body.cancelEndpoint, { reason: 'live proof deadline reached' });
      } else if (mobileCredentials) {
        turn.cancelResult = await api(`/m/api/chat/sessions/${encodeURIComponent(sessionId!)}/cancel`, { clientRequestId });
      }
      save();
      throw new Error('exact terminal not observed before deadline; inspect saved receipt before any retry');
    }
    sessionId = source.session_id;
    turn.sourceUserSeq = source.seq;
    turn.sessionId = sessionId;
    turn.terminalSeq = terminal.seq;
    turn.terminal = JSON.parse(terminal.data_json);
    turn.measurement = measureAcceptedTurn(home, sessionId, source.seq);
    turn.modelRequests = (db.prepare('SELECT count(*) n FROM model_request_provenance WHERE session_id=? AND source_user_seq=?').get(sessionId, source.seq) as { n: number }).n;
    turn.settlements = db.prepare(`SELECT logical_tool_call_id, mutating, business_call, outcome_kind,
      execution_kind, outcome_detail, physical_crossing_count, host_crossing_count, requires_reconciliation
      FROM logical_call_settlements WHERE session_id=? AND source_user_seq=?`).all(sessionId, source.seq);
    turn.activatedPlans = (db.prepare(`SELECT count(*) n FROM events a
      JOIN events g ON g.id = json_extract(a.data_json, '$.graphEventId')
      WHERE a.session_id = ? AND a.type = 'accepted_task_authority_armed'
        AND json_extract(a.data_json, '$.sourceUserSeq') = ?
        AND g.session_id = a.session_id AND g.type = 'turn_graph_compiled'
        AND json_extract(g.data_json, '$.sourceUserSeq') = json_extract(a.data_json, '$.sourceUserSeq')
        AND json_extract(g.data_json, '$.graph.graphId') = json_extract(a.data_json, '$.graphId')
        AND json_extract(g.data_json, '$.graph.compiler.graphHash') = json_extract(a.data_json, '$.graphHash')`
      ).get(sessionId, source.seq) as { n: number }).n;
    turn.providerAcknowledgements = (db.prepare(`SELECT count(DISTINCT json_extract(data_json, '$.receiptId')) n
      FROM events WHERE session_id = ? AND type = 'evidence_receipt'
        AND json_extract(data_json, '$.sourceUserSeq') = ?
        AND json_extract(data_json, '$.proofKind') = 'provider_acknowledgement_v1'`
      ).get(sessionId, source.seq) as { n: number }).n;
    turn.finishedAt = new Date().toISOString();
    save();
    const measurement = turn.measurement as ReturnType<typeof measureAcceptedTurn>;
    console.log(JSON.stringify({ phase: 'terminal', sessionId, sourceUserSeq: source.seq, status: measurement.terminalStatus,
      wallMs: measurement.turnWallMs, modelRequests: turn.modelRequests, toolCalls: measurement.canonicalTopLevelToolCalls,
      searches: measurement.topLevelToolSearches }));
    if (!expect && measurement.terminalStatus !== 'done') throw new Error(`proof stopped on ${measurement.terminalStatus}; no next message submitted`);
    if (expect) {
      const data = turn.terminal as { presentation?: { text?: string }; reply?: string };
      const failures = checkLiveTurn(expect, {
        reply: data.presentation?.text ?? data.reply ?? '', terminalStatus: measurement.terminalStatus,
        modelRequests: turn.modelRequests as number, toolSearches: measurement.discoveryOperations,
        toolCalls: measurement.canonicalTopLevelToolCalls, wallMs: measurement.turnWallMs,
        perTool: measurement.perTool, settlements: turn.settlements as LiveTurnFacts['settlements'],
        activatedPlans: turn.activatedPlans as number, providerAcknowledgements: turn.providerAcknowledgements as number,
      });
      turn.assertions = { passed: failures.length === 0, failures };
      save();
      if (failures.length > 0) throw new Error(`task assertions failed: ${failures.join('; ')}`);
    }
  }
  report.buildAfter = (await api('/api/console/build-info')).body;
  if (JSON.stringify(report.buildBefore) !== JSON.stringify(report.buildAfter)) throw new Error('daemon build changed during proof');
  if (expectedEntry) {
    report.sourceFingerprintAfter = fingerprintRuntimeSourceFromGit({ repoRoot: path.dirname(path.dirname(expectedEntry)) });
    if (report.sourceFingerprintAfter !== report.sourceFingerprintBefore) throw new Error('candidate source changed during proof');
  }
  report.completed = true;
  report.assertionsPassed = messages.every((item) => item.expect !== undefined) ? true : null;
} catch (error) {
  report.completed = false;
  report.assertionsPassed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(JSON.stringify({ phase: 'failed', error: report.error }));
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  db.close();
  console.log(JSON.stringify({ report: output }));
}
