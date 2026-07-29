/**
 * Selectable live release proof — a natural user send crosses the complete
 * pending-action graph without touching a real provider:
 *
 *   natural request → exact local queue → one card → reject (zero dispatch)
 *   fresh request → one card → approve → pending_action_execute → one shim call
 *   duplicate approval + server replay → still one shim call
 *
 * The proof-local Composio CLI is the final provider boundary. It records the
 * raw `-d` argv bytes it receives, allowing the scorer to compare those bytes
 * with the exact argument string stored in the pending action. This is stronger
 * than inferring success from model prose or a harness `tool_returned` event.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  narrationCheck,
  openHarnessDb,
  sessionMetrics,
  stormCheck,
} from '../score.js';
import type {
  Check,
  DaemonHandle,
  ScenarioDef,
} from '../types.js';

const TOOL_SLUG = 'GMAIL_SEND_EMAIL';
const PAYLOAD_LOG = 'proof-composio-payloads.log';
const SLUG_LOG = 'proof-composio-dispatches.log';
const TERMINAL_ACTION_STATUSES = new Set([
  'rejected',
  'expired',
  'cancelled',
  'executed',
  'failed',
]);

export interface ProofComposioPayloadObservation {
  slug: string;
  /** Raw `-d` argument bytes as observed by the proof-local CLI shim. */
  payload: string;
}

export interface ExactProviderPayloadResult {
  pass: boolean;
  exactCount: number;
  slugDispatchCount: number;
}

interface PendingActionFile {
  id: string;
  status: string;
  kind: string;
  toolName: string;
  sessionId: string | null;
  approvalId: string | null;
  approvedBy?: string | null;
  payloadHash: string;
  payload: unknown;
  resultSummary?: string | null;
}

interface ExpectedEmail {
  to: string;
  subject: string;
  body: string;
}

interface ApprovalAuditRow {
  approval_id: string;
  session_id: string;
  status: string;
  resolution: string | null;
  tool: string | null;
  args_json: string | null;
}

interface ApprovalAudit {
  id: string;
  status: string;
  resolution: string | null;
  tool: string | null;
  pendingActionId: string | null;
}

interface ApprovalEventAudit {
  approvalId: string | null;
  pendingActionId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readText(file: string): string {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}

/**
 * Parse the provider-observation log. Production proof shims write TSV because
 * argv JSON cannot contain a literal tab/newline; JSON rows remain accepted for
 * self-test fixtures and backwards-compatible forensic tooling.
 */
export function parseProofComposioPayloadLog(raw: string): ProofComposioPayloadObservation[] {
  const rows: ProofComposioPayloadObservation[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { slug?: unknown; payload?: unknown };
      if (
        typeof parsed.slug === 'string'
        && parsed.slug.trim()
        && typeof parsed.payload === 'string'
      ) {
        rows.push({ slug: parsed.slug.trim(), payload: parsed.payload });
        continue;
      }
    } catch {
      // The real shim uses TSV; fall through without normalizing payload bytes.
    }
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const slug = line.slice(0, tab).trim();
    if (!slug) continue;
    rows.push({ slug, payload: line.slice(tab + 1) });
  }
  return rows;
}

export function exactProviderPayloadObservation(
  expectedPayload: string,
  observations: ProofComposioPayloadObservation[],
  slug = TOOL_SLUG,
): ExactProviderPayloadResult {
  const forSlug = observations.filter((row) => row.slug === slug);
  const exactCount = forSlug.filter((row) => row.payload === expectedPayload).length;
  return {
    pass: forSlug.length === 1 && exactCount === 1,
    exactCount,
    slugDispatchCount: forSlug.length,
  };
}

function proofProviderObservations(home: string): ProofComposioPayloadObservation[] {
  return parseProofComposioPayloadLog(readText(path.join(home, PAYLOAD_LOG)));
}

function proofProviderSlugs(home: string): string[] {
  return readText(path.join(home, SLUG_LOG))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readPendingActions(home: string): PendingActionFile[] {
  const dir = path.join(home, 'pending-actions');
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => {
        try {
          const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as PendingActionFile;
          return parsed?.id ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function pendingActionInnerArgs(action: PendingActionFile | null): {
  raw: string | null;
  parsed: Record<string, unknown> | null;
  slug: string | null;
} {
  const outer = asRecord(action?.payload);
  const slug = typeof outer?.tool_slug === 'string' ? outer.tool_slug : null;
  const value = outer?.arguments;
  if (typeof value === 'string') {
    try {
      return { raw: value, parsed: asRecord(JSON.parse(value)), slug };
    } catch {
      return { raw: value, parsed: null, slug };
    }
  }
  // This fallback makes malformed/object-shaped records diagnosable, but the
  // live exact-dispatch check still requires a string because that is the
  // composio_execute_tool contract and the byte source seen by the provider.
  return {
    raw: value && typeof value === 'object' ? JSON.stringify(value) : null,
    parsed: asRecord(value),
    slug,
  };
}

function actionMatchesEmail(action: PendingActionFile, expected: ExpectedEmail): boolean {
  const inner = pendingActionInnerArgs(action);
  return inner.slug === TOOL_SLUG
    && inner.parsed?.to === expected.to
    && inner.parsed.subject === expected.subject
    && inner.parsed.body === expected.body;
}

function exactEmailShape(action: PendingActionFile | null, expected: ExpectedEmail): boolean {
  if (!action || action.toolName !== 'composio_execute_tool' || action.kind !== 'external_send') return false;
  const inner = pendingActionInnerArgs(action);
  if (inner.slug !== TOOL_SLUG || !inner.raw || !inner.parsed) return false;
  return Object.keys(inner.parsed).sort().join(',') === 'body,subject,to'
    && inner.parsed.to === expected.to
    && inner.parsed.subject === expected.subject
    && inner.parsed.body === expected.body;
}

function naturalSendPrompt(expected: ExpectedEmail): string {
  return [
    'Please send this exact email through my connected Gmail account now.',
    `The connected integration already selected the ${TOOL_SLUG} action, so use that action rather than searching for a different one.`,
    '',
    `To: ${expected.to}`,
    `Subject: ${expected.subject}`,
    `Body: ${expected.body}`,
    '',
    'Keep those three values exact; do not add a signature, greeting, footer, or other fields.',
  ].join('\n');
}

function approvalAudits(home: string, sessionId: string): ApprovalAudit[] {
  const db = openHarnessDb(home);
  try {
    const rows = db.prepare(
      `SELECT approval_id, session_id, status, resolution, tool, args_json
         FROM pending_approvals
        WHERE session_id = ?
        ORDER BY requested_at ASC`,
    ).all(sessionId) as ApprovalAuditRow[];
    return rows.map((row) => {
      let pendingActionId: string | null = null;
      if (row.args_json) {
        try {
          const args = JSON.parse(row.args_json) as {
            pendingActionId?: unknown;
            pending_action_id?: unknown;
          };
          const value = args.pendingActionId ?? args.pending_action_id;
          if (typeof value === 'string' && value.trim()) pendingActionId = value.trim();
        } catch {
          // Missing exact authority remains null and fails the check.
        }
      }
      return {
        id: row.approval_id,
        status: row.status,
        resolution: row.resolution,
        tool: row.tool,
        pendingActionId,
      };
    });
  } finally {
    db.close();
  }
}

function approvalEventAudits(home: string, sessionId: string): ApprovalEventAudit[] {
  const db = openHarnessDb(home);
  try {
    const rows = db.prepare(
      `SELECT data_json
         FROM events
        WHERE session_id = ? AND type = 'approval_requested'
        ORDER BY seq ASC`,
    ).all(sessionId) as Array<{ data_json: string }>;
    return rows.map((row) => {
      try {
        const data = JSON.parse(row.data_json) as {
          approvalId?: unknown;
          pendingAction?: { id?: unknown };
        };
        return {
          approvalId: typeof data.approvalId === 'string' ? data.approvalId : null,
          pendingActionId: typeof data.pendingAction?.id === 'string' ? data.pendingAction.id : null,
        };
      } catch {
        return { approvalId: null, pendingActionId: null };
      }
    });
  } finally {
    db.close();
  }
}

async function waitForActionTerminal(
  home: string,
  id: string,
  timeoutMs: number,
): Promise<PendingActionFile | null> {
  const deadline = Date.now() + timeoutMs;
  let last: PendingActionFile | null = null;
  while (Date.now() < deadline) {
    last = readPendingActions(home).find((action) => action.id === id) ?? null;
    if (last && TERMINAL_ACTION_STATUSES.has(last.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

function actionDetail(action: PendingActionFile | null): string {
  if (!action) return 'missing';
  return JSON.stringify({
    id: action.id,
    status: action.status,
    approvalId: action.approvalId,
    approvedBy: action.approvedBy,
    toolName: action.toolName,
    payloadHash: action.payloadHash,
    resultSummary: action.resultSummary?.slice(0, 180),
  });
}

export const pendingActionExactOnce: ScenarioDef = {
  name: 'pending-action-exact-once',
  summary: 'natural send → reject zero → fresh approve exact once → replay inert',
  routeExpectation: 'exact-brain',
  async run(daemon: DaemonHandle) {
    const nonce = Date.now().toString(36);
    const sessionId = `proof-exact-once-${nonce}`;
    const rejectedEmail: ExpectedEmail = {
      to: `proof+reject-${nonce}@example.com`,
      subject: `Proof reject ${nonce}`,
      body: `Reject path ${nonce}: this proof payload must never reach the provider shim.`,
    };
    const approvedEmail: ExpectedEmail = {
      to: `proof+approve-${nonce}@example.com`,
      subject: `Proof exact once ${nonce}`,
      body: `Approve path ${nonce}: this proof payload must reach the provider shim exactly once.`,
    };
    const checks: Check[] = [];
    const startedAt = Date.now();

    // Make only the proof-local CLI "connected" and invalidate the daemon's
    // status snapshots exactly as the real Connect surface does.
    writeFileSync(path.join(daemon.home, 'proof-composio-connected'), 'connected\n', 'utf8');
    const refreshed = await daemon.request('POST', '/api/composio/refresh', {});
    checks.push({
      name: 'proof-only Composio shim connected',
      pass: refreshed.status === 200,
      detail: `refresh status ${refreshed.status}`,
    });
    const providerBaseline = proofProviderObservations(daemon.home).length;
    const slugBaseline = proofProviderSlugs(daemon.home).length;

    const rejectTurn = await daemon.chat(naturalSendPrompt(rejectedEmail), sessionId, 420_000);
    const rejectActions = readPendingActions(daemon.home)
      .filter((action) => action.sessionId === sessionId && actionMatchesEmail(action, rejectedEmail));
    const rejectedQueued = rejectActions[0] ?? null;
    const rejectCardId = rejectedQueued?.approvalId ?? rejectTurn.pendingApprovalId ?? '';
    const rejectCardsBefore = approvalAudits(daemon.home, sessionId)
      .filter((row) => row.pendingActionId === rejectedQueued?.id);
    const rejectEventsBefore = approvalEventAudits(daemon.home, sessionId)
      .filter((event) => event.pendingActionId === rejectedQueued?.id);

    checks.push({ name: 'reject request returned HTTP 200', pass: rejectTurn.httpStatus === 200, detail: `status ${rejectTurn.httpStatus}` });
    checks.push(narrationCheck(rejectTurn.text));
    checks.push({
      name: 'natural reject request queued one exact action',
      pass: rejectActions.length === 1 && exactEmailShape(rejectedQueued, rejectedEmail),
      detail: `matches=${rejectActions.length}; ${actionDetail(rejectedQueued)}; payload=${JSON.stringify(rejectedQueued?.payload ?? null)}`,
    });
    checks.push({
      name: 'reject request opened one exact formal card',
      pass: Boolean(
        rejectedQueued?.id
        && rejectCardId
        && rejectedQueued.approvalId === rejectCardId
        && rejectTurn.pendingApprovalId === rejectCardId
        && rejectCardsBefore.length === 1
        && rejectCardsBefore[0]?.id === rejectCardId
        && rejectCardsBefore[0].status === 'pending'
        && rejectCardsBefore[0].tool === 'request_approval'
        && rejectEventsBefore.length === 1
        && rejectEventsBefore[0]?.approvalId === rejectCardId
      ),
      detail: JSON.stringify({
        response: rejectTurn.pendingApprovalId ?? null,
        action: rejectedQueued ? { id: rejectedQueued.id, approvalId: rejectedQueued.approvalId } : null,
        cards: rejectCardsBefore,
        events: rejectEventsBefore,
      }),
    });

    const rejectStatus = rejectCardId ? await daemon.approve(rejectCardId, 'reject') : 0;
    const rejectedFinal = rejectedQueued
      ? await waitForActionTerminal(daemon.home, rejectedQueued.id, 30_000)
      : null;
    // Give an erroneously scheduled async resume a narrow chance to expose
    // itself before the fresh request begins.
    await new Promise((resolve) => setTimeout(resolve, 750));
    let rejectMetrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      try { rejectMetrics = sessionMetrics(db, sessionId); } finally { db.close(); }
    } catch {
      // Missing metrics fails closed below.
    }
    const observationsAfterReject = proofProviderObservations(daemon.home).slice(providerBaseline);
    const slugsAfterReject = proofProviderSlugs(daemon.home).slice(slugBaseline);
    checks.push({
      name: 'human rejection terminated the queued action',
      pass: rejectStatus < 300
        && rejectedFinal?.status === 'rejected'
        && rejectedFinal.approvedBy == null,
      detail: `HTTP ${rejectStatus}; ${actionDetail(rejectedFinal)}`,
    });
    checks.push({
      name: 'reject path produced zero dispatch',
      pass: observationsAfterReject.length === 0
        && slugsAfterReject.length === 0
        && rejectMetrics != null
        && rejectMetrics.externalWrites === 0
        && (rejectMetrics.logicalToolCalls.pending_action_execute ?? 0) === 0
        && (rejectMetrics.logicalToolCalls.composio_execute_tool ?? 0) === 0,
      detail: JSON.stringify({
        providerObservations: observationsAfterReject,
        providerSlugs: slugsAfterReject,
        externalWrites: rejectMetrics?.externalWrites ?? null,
        logicalTools: rejectMetrics?.logicalToolCalls ?? null,
      }),
    });

    const approveTurn = await daemon.chat(
      `New, separate request after the rejected one:\n${naturalSendPrompt(approvedEmail)}`,
      sessionId,
      420_000,
    );
    const allSessionActions = readPendingActions(daemon.home)
      .filter((action) => action.sessionId === sessionId);
    const approvedMatches = allSessionActions.filter((action) => actionMatchesEmail(action, approvedEmail));
    const approvedQueued = approvedMatches[0] ?? null;
    const approveCardId = approvedQueued?.approvalId ?? approveTurn.pendingApprovalId ?? '';
    const cardsBeforeApprove = approvalAudits(daemon.home, sessionId)
      .filter((row) => row.pendingActionId === approvedQueued?.id);
    const eventsBeforeApprove = approvalEventAudits(daemon.home, sessionId)
      .filter((event) => event.pendingActionId === approvedQueued?.id);

    checks.push({ name: 'fresh approve request returned HTTP 200', pass: approveTurn.httpStatus === 200, detail: `status ${approveTurn.httpStatus}` });
    checks.push(narrationCheck(approveTurn.text));
    checks.push({
      name: 'fresh request queued one new exact action',
      pass: approvedMatches.length === 1
        && exactEmailShape(approvedQueued, approvedEmail)
        && approvedQueued?.id !== rejectedQueued?.id
        && allSessionActions.length === 2,
      detail: `approve matches=${approvedMatches.length}; session actions=${allSessionActions.length}; ${actionDetail(approvedQueued)}`,
    });
    checks.push({
      name: 'fresh request opened one new formal card',
      pass: Boolean(
        approvedQueued?.id
        && approveCardId
        && approvedQueued.approvalId === approveCardId
        && approveTurn.pendingApprovalId === approveCardId
        && approveCardId !== rejectCardId
        && cardsBeforeApprove.length === 1
        && cardsBeforeApprove[0]?.id === approveCardId
        && cardsBeforeApprove[0].status === 'pending'
        && cardsBeforeApprove[0].tool === 'request_approval'
        && eventsBeforeApprove.length === 1
        && eventsBeforeApprove[0]?.approvalId === approveCardId
      ),
      detail: JSON.stringify({
        response: approveTurn.pendingApprovalId ?? null,
        action: approvedQueued ? { id: approvedQueued.id, approvalId: approvedQueued.approvalId } : null,
        cards: cardsBeforeApprove,
        events: eventsBeforeApprove,
      }),
    });

    const approvalStartedAt = Date.now();
    const approveStatus = approveCardId ? await daemon.approve(approveCardId, 'approve') : 0;
    const approvedFinal = approvedQueued
      ? await waitForActionTerminal(daemon.home, approvedQueued.id, 300_000)
      : null;
    const approvalResumeWallMs = Date.now() - approvalStartedAt;
    let finalMetrics = null;
    try {
      const db = openHarnessDb(daemon.home);
      try { finalMetrics = sessionMetrics(db, sessionId); } finally { db.close(); }
    } catch {
      // Missing metrics fails closed below.
    }
    const finalObservations = proofProviderObservations(daemon.home).slice(providerBaseline);
    const finalSlugs = proofProviderSlugs(daemon.home).slice(slugBaseline);
    const approvedArgs = pendingActionInnerArgs(approvedFinal ?? approvedQueued).raw ?? '';
    const exactProvider = exactProviderPayloadObservation(approvedArgs, finalObservations);

    checks.push({
      name: 'approval auto-resumed pending_action_execute',
      pass: approveStatus < 300
        && approvedFinal?.status === 'executed'
        && approvedFinal.approvedBy === 'human'
        && (finalMetrics?.logicalToolCalls.pending_action_execute ?? 0) === 1,
      detail: `HTTP ${approveStatus}; pending_action_execute × ${finalMetrics?.logicalToolCalls.pending_action_execute ?? 0}; ${actionDetail(approvedFinal)}`,
    });
    checks.push({
      name: 'provider observed one byte-identical queued payload',
      pass: Boolean(approvedArgs)
        && exactProvider.pass
        && finalObservations.length === 1
        && finalSlugs.length === 1
        && finalSlugs[0] === TOOL_SLUG,
      detail: JSON.stringify({
        queuedArgs: approvedArgs,
        observations: finalObservations,
        slugs: finalSlugs,
        exactProvider,
      }),
    });
    checks.push({
      name: 'rejected payload never reached the provider',
      pass: finalObservations.every((row) => !row.payload.includes(rejectedEmail.to)),
      detail: JSON.stringify(finalObservations),
    });

    // Replay both public authorities after terminal success. The approval route
    // must reject the duplicate card resolution, while the exact card/action
    // execution endpoint may return an idempotent skipped result. Neither may
    // append a second provider observation.
    const duplicateApprovalStatus = approveCardId
      ? await daemon.approve(approveCardId, 'approve')
      : 0;
    const replay = approvedQueued && approveCardId
      ? await daemon.request(
          'POST',
          `/api/console/pending-actions/${encodeURIComponent(approvedQueued.id)}/approve-execute`,
          { approvalId: approveCardId },
        )
      : { status: 0, json: {} };
    await new Promise((resolve) => setTimeout(resolve, 500));
    const observationsAfterReplay = proofProviderObservations(daemon.home).slice(providerBaseline);
    const slugsAfterReplay = proofProviderSlugs(daemon.home).slice(slugBaseline);
    const replayBody = asRecord(replay.json);
    const recordAfterReplay = approvedQueued
      ? readPendingActions(daemon.home).find((action) => action.id === approvedQueued.id) ?? null
      : null;
    checks.push({
      name: 'duplicate approval and replay stayed exactly once',
      pass: duplicateApprovalStatus === 409
        && replay.status < 300
        && replayBody?.status === 'skipped'
        && observationsAfterReplay.length === 1
        && slugsAfterReplay.length === 1
        && recordAfterReplay?.status === 'executed',
      detail: JSON.stringify({
        duplicateApprovalStatus,
        replayStatus: replay.status,
        replayBody,
        observations: observationsAfterReplay,
        slugs: slugsAfterReplay,
        record: recordAfterReplay ? { id: recordAfterReplay.id, status: recordAfterReplay.status } : null,
      }),
    });

    const finalCards = approvalAudits(daemon.home, sessionId);
    checks.push({
      name: 'two requests retained exactly two human decisions',
      pass: finalCards.length === 2
        && finalCards.some((row) => row.id === rejectCardId && row.resolution === 'rejected')
        && finalCards.some((row) => row.id === approveCardId && row.resolution === 'approved'),
      detail: JSON.stringify(finalCards),
    });
    checks.push(stormCheck(daemon.log()));

    const metricLatencies = finalMetrics?.latency ?? [];
    return {
      checks,
      // Three provider turns share one conversational session: reject request,
      // fresh approve request, and the approval-resume directive. The exact
      // route scorer therefore requires at least three explicit route markers.
      latency: [
        { wallMs: rejectTurn.wallMs, ttftMs: metricLatencies[0]?.ttftMs ?? finalMetrics?.firstByteMs ?? null },
        { wallMs: approveTurn.wallMs, ttftMs: metricLatencies[1]?.ttftMs ?? null },
        { wallMs: approvalResumeWallMs, ttftMs: metricLatencies[2]?.ttftMs ?? null },
      ],
      sessionId,
      metrics: {
        wallMs: Date.now() - startedAt,
        actions: allSessionActions.length,
        providerDispatches: observationsAfterReplay.length,
        pendingActionExecuteCalls: finalMetrics?.logicalToolCalls.pending_action_execute ?? null,
        totalLogicalToolCalls: finalMetrics?.toolCallTotal ?? null,
        tokensUsed: finalMetrics?.tokensUsed ?? null,
      },
    };
  },
};
