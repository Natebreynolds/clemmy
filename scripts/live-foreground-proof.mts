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
import { measureAcceptedTask, measureAcceptedTurn } from './session-comparison.js';
import { z } from 'zod';
import { checkLiveTurn, LiveProofMessageSchema, type LiveTurnFacts } from './lib/live-foreground-proof-assertions.js';
import { taskModeFields } from '../src/runtime/harness/task-mode.js';
import { fingerprintRuntimeSourceFromGit } from '../src/runtime/source-fingerprint.js';
import { readCredentialFileSync, readCredentialSourceFileSync } from '../src/runtime/credential-private-filesystem.js';
import { captureProofTaskCloseout, parseProofHomeAuth, proofAcceptanceMetadata, proofAcceptedSource, proofBuildIdentity,
  proofDesktopCancellationTarget, proofFailureReason, proofLoopbackRequestUrl, proofRequestOperation,
  proofResponseObject, proofTransport, ProofRunnerFailure, sameProofBuildIdentity, unavailableProofTaskCloseout,
  type ProofBuildIdentity, type ProofRequestReceipt } from './lib/live-proof-closeout.js';

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
const mobileCredentialsSchema = z.object({
  cookie: z.string().min(1), deviceId: z.string().min(1), sessionFingerprint: z.string().min(1),
  privateKeyJwk: z.record(z.string(), z.unknown()),
}).strict();
const mobileCredentials = (() => {
  try { return mobileCredentialsPath ? mobileCredentialsSchema.parse(JSON.parse(readFileSync(mobileCredentialsPath, 'utf8'))) : null; }
  catch { throw new Error('The selected mobile proof credential file could not be read safely; no request submitted.'); }
})();
const mobileKey = (() => {
  try { return mobileCredentials ? createPrivateKey({ key: mobileCredentials.privateKeyJwk as never, format: 'jwk' }) : null; }
  catch { throw new Error('The selected mobile proof signing key is unusable; no request submitted.'); }
})();
if (expectedFingerprint && !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new Error('invalid expected source fingerprint');
const timeoutMs = Number(option('--timeout-ms') ?? 360_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1_800_000) {
  throw new Error('--timeout-ms must be between 1000 and 1800000');
}
let auth: ReturnType<typeof parseProofHomeAuth>;
try {
  auth = parseProofHomeAuth({ envText: readCredentialSourceFileSync(path.join(home, '.env')),
    vaultText: readCredentialFileSync(path.join(home, 'state', 'secrets-vault.json')) });
} catch { throw new Error('The selected home’s local webhook authentication could not be read safely; no request submitted.'); }
const baseUrl = `http://127.0.0.1:${auth.port}`;
const secret = auth.secret;
const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
const db = new Database(path.join(home, 'state', 'harness.db'), { readonly: true, fileMustExist: true });
let sessionId = option('--session');
const report: Record<string, unknown> = { version: 1, startedAt: new Date().toISOString(), baseUrl, home,
  surface: mobileCredentials ? 'authenticated_mobile_http' : 'desktop_http', turns: [],
  taskAccounting: { qualification: 'unqualified', allLegUsageCertified: false, totals: 'recorded_lower_bound',
    providerPricedCost: 'not_measured', actualBilling: 'not_measured',
    note: 'Final task entries are measured separately for each exact accepted source and may overlap. Do not sum them or treat recorded usage as complete cost. Linked precursors may predate this runner window and require their own serving evidence.' } };
const turns = report.turns as Record<string, unknown>[];
let pinnedBuild: ProofBuildIdentity | undefined;
let measurementStartedAt: string | undefined;
function save(): void {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
async function api(url: string, body?: unknown, mobileRequestKey?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const requestUrl = proofLoopbackRequestUrl(baseUrl, url);
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
  let status: number | null = null;
  let failureReason: string | undefined;
  try {
    const response = await proofTransport(() => fetch(requestUrl, {
      method, headers: requestHeaders,
      redirect: 'error',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // A slow daemon is evidence, not a driver failure: record the latency and
      // let the assertions judge it (live 2026-09-09: the post-terminal
      // build-info read exceeded 20 s after a 50-write turn).
      signal: AbortSignal.timeout(90_000),
    }));
    status = response.status;
    return { status, body: await proofResponseObject(() => response.json()) };
  } catch (error) { failureReason = proofFailureReason(error); throw error; }
  finally {
    ((report as { requestLatencies?: unknown[] }).requestLatencies ??= []).push({
      at: new Date(startedAt).toISOString(), operation: proofRequestOperation(url), method,
      latencyMs: Date.now() - startedAt, status, ...(failureReason ? { failureReason } : {}),
    });
  }
}
function requestReceipt(requestId: string): ProofRequestReceipt | null {
  const receipt = db.prepare('SELECT session_id, run_id FROM harness_chat_requests WHERE request_id = ?').get(requestId) as
    { session_id: string; run_id: string } | undefined;
  return receipt ? { sessionId: receipt.session_id, runId: receipt.run_id } : null;
}
function acceptedSource(receipt: ProofRequestReceipt, returned?: ProofRequestReceipt, knownSourceUserSeq?: number) {
  const sources = db.prepare(`SELECT seq, session_id, role, data_json FROM events
    WHERE type = 'user_input_received' AND json_extract(data_json, '$.runId') = ?
      AND session_id = ? ORDER BY seq LIMIT 2`).all(receipt.runId, receipt.sessionId) as
    Array<{ seq: number; session_id: string; role: string; data_json: string }>;
  return proofAcceptedSource({ receipt, returned, sources, knownSourceUserSeq });
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
  pinnedBuild = proofBuildIdentity(build.body);
  measurementStartedAt = new Date().toISOString();
  report.candidateMatched = expectedFingerprint ? true : null;
  report.buildBefore = pinnedBuild;
  save();
  for (const { message, expect, taskMode } of messages) {
    if (turns.length > 0) {
      const beforeTurn = await api('/api/console/build-info');
      if (beforeTurn.status !== 200 || !sameProofBuildIdentity(pinnedBuild, proofBuildIdentity(beforeTurn.body))) {
        throw new Error('daemon build/process changed before the next proof request; no next message submitted');
      }
    }
    const clientRequestId = `live-foreground-${randomUUID()}`;
    const requestId = mobileCredentials ? `mobile:${createHash('sha256').update(mobileCredentials.deviceId).update('\0').update(clientRequestId).digest('hex')}` : clientRequestId;
    // Record only this runner's freshly generated request nonce before I/O.
    // A lost HTTP reply may still have a durable accepted request to account.
    const turn: Record<string, unknown> = { message, expect, ...taskModeFields(taskMode), clientRequestId, requestId,
      startedAt: new Date().toISOString(), acceptanceVerified: false };
    turns.push(turn);
    save();
    const response = mobileCredentials
      ? await api('/m/api/chat/send', { message, async: true, ...taskModeFields(taskMode), ...(sessionId ? { sessionId } : {}) }, clientRequestId)
      : await api('/api/harness/chat', { input: message, clientRequestId, ...taskModeFields(taskMode), ...(sessionId ? { sessionId } : {}) });
    turn.acceptanceHttpStatus = response.status;
    const accepted = proofAcceptanceMetadata({ ...response, clientRequestId, mobile: !!mobileCredentials });
    if (!accepted) {
      turn.rejectionReason = 'exact_acceptance_shape_unavailable';
      throw new ProofRunnerFailure('chat_not_accepted');
    }
    turn.accepted = accepted;
    turn.returnedIdentity = { sessionId: accepted.sessionId, runId: accepted.runId };
    const receipt = requestReceipt(requestId);
    if (!receipt || receipt.sessionId !== accepted.sessionId || receipt.runId !== accepted.runId) {
      throw new Error('accepted HTTP identity has no matching durable request receipt');
    }
    turn.acceptanceVerified = true;
    turn.receiptIdentity = receipt;
    sessionId = accepted.sessionId;
    save();
    console.log(JSON.stringify({ phase: 'accepted', sessionId, runId: accepted.runId, turn: turns.length }));
    const deadline = Date.now() + timeoutMs;
    let source: ReturnType<typeof acceptedSource> = null;
    let terminal: { seq: number; data_json: string } | undefined;
    let lastProgress = '';
    while (Date.now() < deadline) {
      // The accepted run identity remains stable even if the shared ingress
      // selects a same-principal successor rather than the requested session.
      source = acceptedSource(receipt, turn.returnedIdentity as ProofRequestReceipt,
        typeof turn.sourceUserSeq === 'number' ? turn.sourceUserSeq : undefined);
      if (source) {
        turn.sourceUserSeq = source.seq;
        turn.sessionId = source.sessionId;
        const terminals = db.prepare(`SELECT seq, data_json FROM events
          WHERE session_id = ? AND type = 'conversation_completed'
          AND json_extract(data_json, '$.sourceUserSeq') = ? ORDER BY seq`).all(source.sessionId, source.seq) as Array<{ seq: number; data_json: string }>;
        if (terminals.length > 1) throw new Error('multiple terminals for exact accepted source');
        terminal = terminals[0];
        const progress = db.prepare(`SELECT
          (SELECT count(*) FROM model_request_provenance WHERE session_id = ? AND source_user_seq = ?) modelRequests,
          count(*) toolCalls FROM events WHERE session_id = ? AND type = 'tool_called'
          AND json_extract(data_json, '$.sourceUserSeq') = ? AND json_extract(data_json, '$.accounting') = 'top_level'`
        ).get(source.sessionId, source.seq, source.sessionId, source.seq) as Record<string, number>;
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
      let cancelRoute: string | null = null;
      try {
        const currentReceipt = requestReceipt(requestId);
        if (currentReceipt?.sessionId === receipt.sessionId && currentReceipt.runId === receipt.runId) {
          if (mobileCredentials) {
            cancelRoute = `/m/api/chat/sessions/${encodeURIComponent(receipt.sessionId)}/cancel`;
          } else {
            const currentSource = acceptedSource(currentReceipt, turn.returnedIdentity as ProofRequestReceipt,
              typeof turn.sourceUserSeq === 'number' ? turn.sourceUserSeq : undefined);
            if (currentSource) {
              const attempts = db.prepare(`SELECT attempt_id, session_id, run_id, source_user_seq, status, finished_at
                FROM run_attempts WHERE session_id = ? AND run_id = ? AND source_user_seq = ?
                  AND finished_at IS NULL ORDER BY started_at LIMIT 2`).all(receipt.sessionId, receipt.runId, currentSource.seq);
              const target = proofDesktopCancellationTarget({ receipt: currentReceipt, source: currentSource,
                attempts: attempts as Parameters<typeof proofDesktopCancellationTarget>[0]['attempts'] });
              if (target) { cancelRoute = target.route; turn.cancelAttemptId = target.attemptId; }
            }
          }
        }
      } catch { /* Unknown ownership never broadens cancellation. */ }
      if (cancelRoute) {
        const cancelled = await api(cancelRoute, mobileCredentials ? { clientRequestId } : { reason: 'live proof deadline reached' });
        turn.cancelResult = { status: cancelled.status, acknowledgement: cancelled.body.ok === true ? 'reported_ok' : 'unconfirmed' };
      } else {
        turn.cancelResult = { status: 'not_sent', reason: 'exact_owned_cancellation_target_unavailable', reconciliationNeeded: true };
      }
      save();
      throw new Error('exact terminal not observed before deadline; inspect saved receipt before any retry');
    }
    sessionId = source.sessionId;
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
  report.completed = true;
  report.assertionsPassed = messages.every((item) => item.expect !== undefined) ? true : null;
} catch (error) {
  report.completed = false;
  report.assertionsPassed = false;
  report.error = proofFailureReason(error);
  process.exitCode = 1;
  console.error(JSON.stringify({ phase: 'failed', error: report.error }));
} finally {
  // This closeout runs after assertion/transport/time-limit failures too. No
  // retry, restart, tick or model/tool dispatch is part of accounting.
  for (const turn of turns) {
    try {
      const receipt = requestReceipt(String(turn.requestId));
      if (!receipt) {
        turn.taskCloseout = unavailableProofTaskCloseout('durable_request_receipt_unavailable');
        continue;
      }
      const source = acceptedSource(receipt, (turn.receiptIdentity ?? turn.returnedIdentity) as ProofRequestReceipt | undefined,
        typeof turn.sourceUserSeq === 'number' ? turn.sourceUserSeq : undefined);
      if (!source) {
        turn.taskCloseout = unavailableProofTaskCloseout('accepted_source_unavailable_at_closeout');
        continue;
      }
      turn.sessionId = source.sessionId;
      turn.sourceUserSeq = source.seq;
      turn.closeoutAcceptance = turn.acceptanceVerified === true ? 'http_and_journal' : 'journal_only_response_unconfirmed';
      turn.taskCloseout = captureProofTaskCloseout(source, () => measureAcceptedTask(home, source.sessionId, source.seq));
    } catch { turn.taskCloseout = unavailableProofTaskCloseout('durable_accepted_source_identity_unavailable'); }
  }
  if (pinnedBuild) {
    try {
      const after = await api('/api/console/build-info');
      if (after.status !== 200) throw new Error('closeout identity unavailable');
      const identity = proofBuildIdentity(after.body);
      report.buildAfter = identity;
      if (!sameProofBuildIdentity(pinnedBuild, identity)) throw new Error('closeout identity changed');
      if (expectedEntry) {
        report.sourceFingerprintAfter = fingerprintRuntimeSourceFromGit({ repoRoot: path.dirname(path.dirname(expectedEntry)) });
        if (report.sourceFingerprintAfter !== report.sourceFingerprintBefore) throw new Error('candidate source changed');
      }
      report.measurementWindow = { scope: 'runner_request_window', startedAt: measurementStartedAt, endedAt: new Date().toISOString(), identityStatus: 'unchanged' };
    } catch {
      report.measurementWindow = { scope: 'runner_request_window', startedAt: measurementStartedAt, endedAt: new Date().toISOString(), identityStatus: 'unavailable_or_changed' };
      report.completed = false; report.assertionsPassed = false; process.exitCode = 1;
      report.closeoutIdentityError = 'The same exact build/process could not be proved throughout the measurement window.';
    }
  }
  report.finishedAt = new Date().toISOString();
  save();
  db.close();
  console.log(JSON.stringify({ report: output }));
}
