/**
 * Approval registry — the addressable replacement for the implicit
 * "loadInterruptState() exists" check that was the entire approval
 * state machine before this module.
 *
 * Why this exists: the audit on 2026-05-18 found three orphan paused
 * sessions, including the "save Salesforce CLI rule to memory" approval
 * from earlier today. The user's "approve" landed on a different
 * paused session (the memory_search one) because the channel-level
 * routing assumed "the only paused session is the right one." With
 * multiple concurrent approvals — easy to reach in practice — that
 * heuristic loses work. The fix:
 *
 *   - Every `approval_requested` event also registers a row in
 *     `pending_approvals` with a short addressable ID (`apr-xy7q`)
 *     and an explicit `expires_at`.
 *   - The approval prompt shown to the user INCLUDES the ID so they
 *     can resolve a specific one ("approve apr-xy7q") when multiple
 *     are pending.
 *   - A background reaper expires stale rows, never silently leaves
 *     a session paused forever.
 *
 * This module is the data layer; the reaper, the chat-surface routing,
 * and the loop integration live in their own modules (reaper.ts,
 * discord-harness.ts, loop.ts).
 *
 * Gating: flag `HARNESS_APPROVAL_REGISTRY=on` controls whether the
 * channel-routing code consults this registry. The DB writes happen
 * regardless so a flag flip mid-session doesn't lose pending rows.
 */

import { randomBytes } from 'node:crypto';
import { listEvents, openEventLog } from './eventlog.js';
import { markNotificationsReadByApprovalId } from '../notifications.js';
import { updateToolChoiceOutcomeForIdentifier } from '../../memory/tool-choice-store.js';
import {
  getPendingAction,
  linkPendingActionApproval,
  markPendingActionApprovalResolved,
} from './pending-actions.js';
import { appendAuditRecord } from '../audit-ledger.js';
import {
  canonicalExternalWriteActionKey,
  externalWriteSemanticFingerprint,
} from './external-write-admission.js';
import { exactApprovalAuthorityMatches } from './approval-authority.js';
import {
  decodedToolArgs,
  extractComposioSlug,
  isComposioMultiplexerName,
  resolveToolInvocation,
  toolActionSegment,
} from '../../agents/tool-invocation.js';
import type { ExactOriginDeliveryTarget } from '../exact-origin-delivery.js';

/**
 * The tool-choice identifier an approval maps to (Thread 2 — outcome loop).
 * For the composio wrapper the proven choice stores the action SLUG (in args),
 * not the wrapper name; an MCP/CLI tool's name IS the stored identifier.
 */
function approvalChoiceIdentifier(tool: string | null, args: Record<string, unknown> | null): string | null {
  if (!tool) return null;
  if (tool === 'composio_execute_tool') {
    return args && typeof args.tool_slug === 'string' && args.tool_slug.trim() ? args.tool_slug.trim() : null;
  }
  return tool;
}

export type PendingApprovalStatus = 'pending' | 'resolved' | 'expired' | 'cancelled';
export type ApprovalResolution = 'approved' | 'rejected' | 'expired' | 'cancelled_by_user';

export interface PendingApprovalRow {
  approvalId: string;
  sessionId: string;
  channel: string | null;
  channelId: string | null;
  requestedAt: string;
  expiresAt: string;
  subject: string;
  tool: string | null;
  args: Record<string, unknown> | null;
  status: PendingApprovalStatus;
  resolution: ApprovalResolution | null;
  resolver: string | null;
  resolvedAt: string | null;
  /** Opaque workflow SDK key for exact-tool park/resume. Never user-authored. */
  resumeKey: string | null;
  /** Set atomically when an approved parked payload is reused. */
  consumedAt: string | null;
  /** Durable user-surface contract. Null means a normal formal approval card. */
  presentation: ConversationalApprovalPresentation | null;
}

export interface ConversationalApprovalPresentation {
  version: 1;
  kind: 'autonomous_send_consent';
  question: string;
  actionLabel: 'email' | 'message' | 'post' | 'send';
  target: string;
  subject: string | null;
  bodyPreview: string | null;
  resultUrl: string | null;
  sourceUserSeq: number;
  originReplyTarget: ExactOriginDeliveryTarget;
  originReplyTargetDigest: string;
  /** Provider conversation that displayed the question. This intentionally
   * stays distinct from originReplyTarget: Slack DM terminal delivery strips
   * threadTs, while a consent reply must remain in the pane/thread that asked. */
  conversationKey: string;
  audienceUserId: string;
  promptEventId: string | null;
  promptEventSeq: number | null;
  presentedAt: string | null;
  responseSourceUserSeq: number | null;
  responseUserId: string | null;
  /** Existing provider message selected before the live final edit. A crash
   * after binding can edit this exact message on boot instead of posting a
   * second question. Null means boot must use provider idempotency metadata. */
  transportTarget:
    | { provider: 'discord'; channelId: string; messageId: string }
    | { provider: 'slack'; channelId: string; messageTs: string; threadTs?: string }
    | null;
}

export type NewConversationalApprovalPresentation = Omit<
  ConversationalApprovalPresentation,
  'promptEventId' | 'promptEventSeq' | 'presentedAt' | 'responseSourceUserSeq' | 'responseUserId' | 'transportTarget'
>;

export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export function isExpired(row: Pick<PendingApprovalRow, 'expiresAt'>, now: Date = new Date()): boolean {
  const expiresAt = Date.parse(row.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt < now.getTime();
}

/** How long an unanswered approval stays in the urgent "needs you" surfaces.
 * Long-TTL standing-grant asks (e.g. a 90-day CLI trust freeze) otherwise ride
 * the header until they expire — live 2026-08-09: two space-trust cards from
 * one afternoon haunted the header for days. Aging is presentation-only: the
 * row stays pending, approvable, and listed — it just stops counting as
 * urgent. An approval something is actively parked on never ages out. */
export const APPROVAL_HEADER_URGENT_WINDOW_MS = 48 * 60 * 60_000;

export function isApprovalStaleForHeader(
  row: Pick<PendingApprovalRow, 'requestedAt'>,
  opts: { boundToActiveWork?: boolean; now?: Date } = {},
): boolean {
  if (opts.boundToActiveWork) return false;
  const requested = Date.parse(row.requestedAt);
  if (!Number.isFinite(requested)) return false;
  return (opts.now ?? new Date()).getTime() - requested > APPROVAL_HEADER_URGENT_WINDOW_MS;
}

export function isActionable(row: PendingApprovalRow, now: Date = new Date()): boolean {
  return row.status === 'pending' && !isExpired(row, now);
}

/**
 * Generic post-resolution hook. A subsystem can react to an approval being
 * resolved WITHOUT this data layer importing it — keeps the registry
 * dependency-free (the comment at the top: "routing lives in their own
 * modules"). Workspaces use this to EXECUTE a gated Space action the moment the
 * user approves it: a button click has no agent turn to resume, so the work
 * must happen on resolve. Fires for every resolution (approved/rejected/
 * expired/cancelled) across every approve path — desktop, mobile, chat-dock —
 * because they all funnel through resolve(). Best-effort: a listener throwing
 * must never break resolution.
 */
export type ApprovalResolvedListener = (row: PendingApprovalRow) => void;
const resolvedListeners: ApprovalResolvedListener[] = [];

export function onApprovalResolved(listener: ApprovalResolvedListener): void {
  if (!resolvedListeners.includes(listener)) resolvedListeners.push(listener);
}

function emitResolved(row: PendingApprovalRow): void {
  for (const fn of resolvedListeners) {
    try { fn(row); } catch { /* a listener must never break resolution */ }
  }
}

export interface RegisterApprovalInput {
  sessionId: string;
  channel?: string | null;
  channelId?: string | null;
  subject: string;
  tool?: string | null;
  args?: Record<string, unknown> | null;
  ttlMs?: number;
  /** Opaque exact-payload key used only by durable workflow SDK parking. */
  resumeKey?: string | null;
  /** Preferred ordinary-question surface. Registration keeps it only when
   * this is the sole pending decision for the session; siblings atomically
   * demote every row to formal cards. */
  presentation?: NewConversationalApprovalPresentation | null;
}

interface ApprovalSqlRow {
  approval_id: string;
  session_id: string;
  channel: string | null;
  channel_id: string | null;
  requested_at: string;
  expires_at: string;
  subject: string;
  tool: string | null;
  args_json: string | null;
  status: PendingApprovalStatus;
  resolution: ApprovalResolution | null;
  resolver: string | null;
  resolved_at: string | null;
  resume_key: string | null;
  consumed_at: string | null;
  resend_consumed_at: string | null;
  presentation_json: string | null;
}

function parseConversationalPresentation(json: string | null): ConversationalApprovalPresentation | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<ConversationalApprovalPresentation>;
    if (
      value.version !== 1
      || value.kind !== 'autonomous_send_consent'
      || typeof value.question !== 'string'
      || !['email', 'message', 'post', 'send'].includes(String(value.actionLabel))
      || typeof value.target !== 'string'
      || !(value.subject === null || typeof value.subject === 'string')
      || !(value.bodyPreview === null || typeof value.bodyPreview === 'string')
      || !(value.resultUrl === null || typeof value.resultUrl === 'string')
      || !Number.isSafeInteger(value.sourceUserSeq)
      || Number(value.sourceUserSeq) <= 0
      || !value.originReplyTarget
      || typeof value.originReplyTarget !== 'object'
      || typeof value.originReplyTargetDigest !== 'string'
      || typeof value.conversationKey !== 'string'
      || !value.conversationKey.trim()
      || typeof value.audienceUserId !== 'string'
      || !(value.promptEventId === null || typeof value.promptEventId === 'string')
      || !(value.promptEventSeq === null || Number.isSafeInteger(value.promptEventSeq))
      || !(value.presentedAt === null || typeof value.presentedAt === 'string')
      || !(value.responseSourceUserSeq === null || Number.isSafeInteger(value.responseSourceUserSeq))
      || !(value.responseUserId === null || typeof value.responseUserId === 'string')
    ) return null;
    const target = value.transportTarget;
    const transportTarget = target && typeof target === 'object'
      && (
        (target.provider === 'discord' && typeof target.channelId === 'string' && typeof target.messageId === 'string')
        || (target.provider === 'slack' && typeof target.channelId === 'string' && typeof target.messageTs === 'string'
          && (target.threadTs === undefined || typeof target.threadTs === 'string'))
      )
      ? target as ConversationalApprovalPresentation['transportTarget']
      : null;
    return { ...value, transportTarget } as ConversationalApprovalPresentation;
  } catch {
    return null;
  }
}

function rowToPublic(row: ApprovalSqlRow): PendingApprovalRow {
  return {
    approvalId: row.approval_id,
    sessionId: row.session_id,
    channel: row.channel,
    channelId: row.channel_id,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    subject: row.subject,
    tool: row.tool,
    args: row.args_json ? safeParse(row.args_json) : null,
    status: row.status,
    resolution: row.resolution,
    resolver: row.resolver,
    resolvedAt: row.resolved_at,
    resumeKey: row.resume_key,
    consumedAt: row.consumed_at,
    presentation: parseConversationalPresentation(row.presentation_json),
  };
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const RESEND_APPROVAL_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RESEND_APPROVAL_RECIPIENT_KEY_RE =
  /(^|_)(to|to_email|recipient|recipients|email|emails|cc|bcc)$/i;
const RESEND_APPROVAL_SENDER_KEY_RE =
  /(^|_)(from|sender|reply_to|return_path|on_behalf_of)(_email|_emails|_address|_addresses)?$/i;
const RESEND_APPROVAL_ID_KEY_RE =
  /(^|_)(contact_id|record_id|lead_id|account_id|to_number|phone)$/i;
const RESEND_APPROVAL_PROVIDER_KEY_RE =
  /(^|_)(connected_account_id|connection_id|connector_id|user_id)$/i;

function normalizedResendApprovalKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

/**
 * Derive authority from the action the human actually approved. The registry's
 * wrapper name is not enough for Composio/call_tool approvals: their concrete
 * action lives in the byte-pinned args. Unknown or malformed wrappers fail
 * closed instead of becoming session-wide resend consent.
 */
function approvedResendActionKey(
  tool: string | null,
  args: Record<string, unknown> | null,
): string | null {
  const outerTool = tool?.trim();
  if (!outerTool) return null;
  const resolved = resolveToolInvocation(outerTool, args ?? {});
  if (!resolved.valid) return null;
  const approvedTool = resolved.toolName;
  const approvedArgs = decodedToolArgs(resolved.args) ?? {};
  const tail = toolActionSegment(approvedTool);

  if (isComposioMultiplexerName(approvedTool)) {
    const slug = extractComposioSlug(approvedArgs);
    return slug ? canonicalExternalWriteActionKey(approvedTool, slug) : null;
  }
  if (tail.startsWith('cx_')) {
    return canonicalExternalWriteActionKey(approvedTool, tail.slice('cx_'.length));
  }

  return canonicalExternalWriteActionKey(approvedTool, approvedTool);
}

/**
 * Extract only the same concrete identities used by the duplicate wall. Body
 * prose and subjects are deliberately excluded: an address mentioned in copy
 * is not approval to send to it. Values are normalized exactly, so
 * `notcasey@example.com` can never authorize `casey@example.com`.
 */
function approvedResendIdentityKeys(
  tool: string | null,
  args: Record<string, unknown>,
): Set<string> {
  const identities = new Set<string>();
  const visit = (
    value: unknown,
    keyHint?: string,
    rootString = false,
    inRecipientField = false,
  ): void => {
    if (value === null || value === undefined) return;
    const normalizedHint = keyHint === undefined
      ? undefined
      : normalizedResendApprovalKey(keyHint);
    const senderContext = normalizedHint !== undefined
      && RESEND_APPROVAL_SENDER_KEY_RE.test(normalizedHint);
    const recipientContext = !senderContext && inRecipientField;

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (
        (trimmed.startsWith('{') || trimmed.startsWith('['))
        && trimmed.length < 50_000
      ) {
        try {
          visit(JSON.parse(trimmed), undefined, false, recipientContext);
          return;
        } catch { /* plain string */ }
      }
      if (
        rootString
        || recipientContext
        || (
          normalizedHint
          && !senderContext
          && RESEND_APPROVAL_RECIPIENT_KEY_RE.test(normalizedHint)
        )
      ) {
        for (const match of value.match(RESEND_APPROVAL_EMAIL_RE) ?? []) {
          identities.add(match.toLowerCase());
        }
      }
      if (
        normalizedHint
        && RESEND_APPROVAL_ID_KEY_RE.test(normalizedHint)
        && !RESEND_APPROVAL_PROVIDER_KEY_RE.test(normalizedHint)
        && trimmed.length >= 3
        && trimmed.length <= 80
      ) {
        identities.add(trimmed.toLowerCase());
      }
      return;
    }

    const enteringRecipientField = recipientContext
      || (
        normalizedHint !== undefined
        && !senderContext
        && RESEND_APPROVAL_RECIPIENT_KEY_RE.test(normalizedHint)
      );
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child, keyHint, false, enteringRecipientField);
      }
      return;
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, key, false, enteringRecipientField);
      }
    }
  };

  visit(args);
  const normalizedTool = tool?.replace(/^mcp__/, '').toLowerCase() ?? '';
  if (normalizedTool.split('__').at(-1) === 'run_shell_command') {
    const command = typeof args.command === 'string' ? args.command : '';
    if (command) visit(command, undefined, true);
  }
  identities.delete('me');
  return identities;
}

interface ResendApprovalCandidate {
  tool: string | null;
  args_json: string | null;
  resolved_at: string | null;
}

function resendApprovalMatches(
  candidate: ResendApprovalCandidate,
  needle: string,
  priorSendAtIso: string | undefined,
  requestedActionKey: string,
): boolean {
  if (
    priorSendAtIso
    && (!candidate.resolved_at || candidate.resolved_at <= priorSendAtIso)
  ) return false;
  if (!candidate.args_json) return false;
  const args = safeParse(candidate.args_json);
  if (!args) return false;

  const approvedActionKey = approvedResendActionKey(candidate.tool, args);
  if (!approvedActionKey || approvedActionKey !== requestedActionKey) return false;

  if (needle.startsWith('payload:semantic-v1:')) {
    return `payload:${externalWriteSemanticFingerprint(approvedActionKey, args)}` === needle;
  }
  return approvedResendIdentityKeys(candidate.tool, args).has(needle);
}

function pendingActionIdFromArgs(args: Record<string, unknown> | null): string | null {
  const direct = args?.pendingActionId ?? args?.pending_action_id;
  return typeof direct === 'string' && direct.trim() ? direct.trim() : null;
}

function ensurePendingActionApprovalLinked(row: PendingApprovalRow): PendingApprovalRow {
  const pendingActionId = pendingActionIdFromArgs(row.args);
  if (!pendingActionId) return row;
  const action = getPendingAction(pendingActionId);
  if (!action || action.sessionId !== row.sessionId) {
    throw new Error('approval-registry: pending action does not belong to this session');
  }
  linkPendingActionApproval(pendingActionId, row.approvalId);
  const linked = getPendingAction(pendingActionId);
  if (
    !linked
    || linked.sessionId !== row.sessionId
    || linked.approvalId !== row.approvalId
    || !['approval_requested', 'approved'].includes(linked.status)
  ) {
    throw new Error('approval-registry: pending action link could not be verified');
  }
  return row;
}

/** Boot/retry repair for the safe registration order: SQLite identity commits
 * first, then the frozen file record links. No question may be projected until
 * this returns a byte-matching link. */
export function reconcileLinkedPendingActionRegistration(row: PendingApprovalRow): PendingApprovalRow | null {
  try {
    return ensurePendingActionApprovalLinked(row);
  } catch {
    return null;
  }
}

function ensureResumableRowMatchesInput(
  row: PendingApprovalRow,
  input: RegisterApprovalInput & { resumeKey: string },
): PendingApprovalRow {
  if (!exactApprovalAuthorityMatches(row, {
    approvalId: '',
    sessionId: input.sessionId,
    tool: input.tool ?? null,
    args: input.args ?? null,
    resumeKey: input.resumeKey,
  })) {
    throw new Error('approval-registry: resume key collision across approval authority');
  }
  return ensurePendingActionApprovalLinked(row);
}

/**
 * Generate a short prefixed approval ID. Format: `apr-xy7q` (4 chars
 * base36 hex-ish, distinct enough for the surface display + tight
 * enough for the user to type). Collisions are checked by the PK.
 */
function newApprovalId(): string {
  // 24 bits → ~16M space; we pick 4 base36 chars (~1.6M) which is
  // plenty for concurrent approvals on a single machine.
  const bytes = randomBytes(3);
  let n = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    out.push((n % 36).toString(36));
    n = Math.floor(n / 36);
  }
  return `apr-${out.join('')}`;
}

/**
 * Register a new pending approval. Returns the row (with the freshly
 * generated approval ID). Called from the harness loop at the same
 * point as `approval_requested` event emission.
 */
export function register(input: RegisterApprovalInput): PendingApprovalRow {
  const pendingActionId = pendingActionIdFromArgs(input.args ?? null);
  if (pendingActionId) {
    const pendingAction = getPendingAction(pendingActionId);
    if (!pendingAction || pendingAction.sessionId !== input.sessionId) {
      throw new Error('approval-registry: pending action does not belong to this session');
    }
  }
  const db = openEventLog();
  const now = new Date();
  const ttl = input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl);

  const insert = db.transaction((): PendingApprovalRow => {
    // A second independent decision means neither question can safely own a
    // bare conversational reply. Demote all existing rows before inserting the
    // sibling, and never mark the new row conversational in that state.
    const conversationKey = input.presentation?.conversationKey ?? null;
    const siblingRows = db.prepare(`
      SELECT approval_id
        FROM pending_approvals
       WHERE status = 'pending'
         AND (
           session_id = ?
           OR (? IS NOT NULL AND json_extract(presentation_json, '$.conversationKey') = ?)
           OR (? IS NOT NULL AND ? IS NOT NULL AND channel = ? AND channel_id = ?)
         )
    `).all(
      input.sessionId,
      conversationKey,
      conversationKey,
      input.channel ?? null,
      input.channelId ?? null,
      input.channel ?? null,
      input.channelId ?? null,
    ) as Array<{ approval_id: string }>;
    const sibling = siblingRows.length > 0;
    if (sibling) {
      const placeholders = siblingRows.map(() => '?').join(',');
      db.prepare(
        `UPDATE pending_approvals SET presentation_json = NULL WHERE approval_id IN (${placeholders})`,
      ).run(...siblingRows.map((row) => row.approval_id));
    }
    const presentation = !sibling && input.presentation
      ? JSON.stringify({
          ...input.presentation,
          promptEventId: null,
          promptEventSeq: null,
          presentedAt: null,
          responseSourceUserSeq: null,
          responseUserId: null,
          transportTarget: null,
        } satisfies ConversationalApprovalPresentation)
      : null;

    // Retry on collision (extremely unlikely but the PK enforces it).
    for (let attempt = 0; attempt < 4; attempt++) {
      const approvalId = newApprovalId();
      try {
        db.prepare(`
          INSERT INTO pending_approvals
            (approval_id, session_id, channel, channel_id, requested_at,
             expires_at, subject, tool, args_json, status, resume_key, presentation_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(
          approvalId,
          input.sessionId,
          input.channel ?? null,
          input.channelId ?? null,
          now.toISOString(),
          expiresAt.toISOString(),
          input.subject,
          input.tool ?? null,
          input.args ? JSON.stringify(input.args) : null,
          input.resumeKey ?? null,
          presentation,
        );
        const row = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?').get(approvalId) as ApprovalSqlRow;
        return rowToPublic(row);
      } catch (err) {
        if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') continue;
        throw err;
      }
    }
    throw new Error('approval-registry: failed to generate a unique approval ID after 4 attempts');
  });
  // Commit the SQLite identity before touching the file-backed PendingAction.
  // A hard death can now leave only a DB row plus the exact frozen PA, which a
  // retry/reconciler can deterministically link. The old order wrote a PA link
  // inside an uncommitted SQLite transaction and could leave a dangling id to
  // a rolled-back row. Callers receive (and may surface) only a verified link.
  return ensurePendingActionApprovalLinked(insert.immediate());
}

/**
 * Register one durable workflow approval for an exact payload. The partial
 * unique index makes this idempotent under process/thread races: a second
 * caller receives the already-pending row and must not surface another card.
 */
export function registerResumable(
  input: RegisterApprovalInput & { resumeKey: string },
): { row: PendingApprovalRow; created: boolean } {
  const db = openEventLog();
  const existing = db.prepare(`
    SELECT * FROM pending_approvals
     WHERE resume_key = ? AND status = 'pending'
     ORDER BY requested_at DESC, rowid DESC
     LIMIT 1
  `).get(input.resumeKey) as ApprovalSqlRow | undefined;
  if (existing) {
    return {
      row: ensureResumableRowMatchesInput(rowToPublic(existing), input),
      created: false,
    };
  }

  try {
    return { row: register(input), created: true };
  } catch (err) {
    // Another process may have inserted the same pending resume key between
    // the lookup and INSERT. Return that row; any other failure remains loud.
    const code = (err as { code?: string }).code ?? '';
    if (!code.startsWith('SQLITE_CONSTRAINT')) throw err;
    const raced = db.prepare(`
      SELECT * FROM pending_approvals
       WHERE resume_key = ? AND status = 'pending'
       ORDER BY requested_at DESC, rowid DESC
       LIMIT 1
    `).get(input.resumeKey) as ApprovalSqlRow | undefined;
    if (!raced) throw err;
    return {
      row: ensureResumableRowMatchesInput(rowToPublic(raced), input),
      created: false,
    };
  }
}

export type ResumableApprovalClaim =
  | { state: 'none' }
  | { state: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'consumed' | 'pending_action_owned'; row: PendingApprovalRow };

/** Read-only state inspection for host-owned PendingActions. A native SDK
 * retry must be able to observe the conversational row without spending its
 * one-shot grant; only the PendingAction execution claim owns dispatch. */
export function inspectResumableApproval(resumeKey: string): ResumableApprovalClaim {
  const row = openEventLog().prepare(`
    SELECT * FROM pending_approvals
     WHERE resume_key = ?
     ORDER BY requested_at DESC, rowid DESC
     LIMIT 1
  `).get(resumeKey) as ApprovalSqlRow | undefined;
  if (!row) return { state: 'none' };
  const current = rowToPublic(row);
  if (current.status === 'pending' && isExpired(current)) return { state: 'expired', row: current };
  if (current.status === 'pending') return { state: 'pending', row: current };
  if (current.resolution === 'rejected') return { state: 'rejected', row: current };
  if (current.resolution === 'expired' || current.status === 'expired') return { state: 'expired', row: current };
  if (current.resolution === 'cancelled_by_user' || current.status === 'cancelled') return { state: 'cancelled', row: current };
  if (current.resolution !== 'approved') return { state: 'expired', row: current };
  return { state: current.consumedAt ? 'consumed' : 'approved', row: current };
}

/**
 * Inspect and, for an approved row, atomically consume the exact-payload grant.
 * Only the first caller receives `approved`; every later caller sees `consumed`.
 * Rejected/expired/cancelled decisions remain terminal for this parked step and
 * can never be replaced by a silently minted approval. A live WAIT caller may
 * also provide the exact card id it awaited so a newer same-key row cannot be
 * selected during the poll-to-claim race window.
 */
export function claimResumableApproval(
  resumeKey: string,
  expectedApprovalId?: string,
): ResumableApprovalClaim {
  const db = openEventLog();
  const claim = db.transaction((): ResumableApprovalClaim => {
    // WAIT callers already know the exact card they awaited. Constraining the
    // atomic claim by that id prevents a newer same-payload card from being
    // consumed in its place between the poll result and this transaction.
    const row = expectedApprovalId
      ? db.prepare(`
          SELECT * FROM pending_approvals
           WHERE resume_key = ? AND approval_id = ?
           LIMIT 1
        `).get(resumeKey, expectedApprovalId) as ApprovalSqlRow | undefined
      : db.prepare(`
          SELECT * FROM pending_approvals
           WHERE resume_key = ?
           ORDER BY requested_at DESC, rowid DESC
           LIMIT 1
        `).get(resumeKey) as ApprovalSqlRow | undefined;
    if (!row) return { state: 'none' };

    const current = rowToPublic(row);
    // A conversational decision belongs to its immutable PendingAction. This
    // registry API historically minted authority for replaying the original
    // raw tool call; returning a distinct inert state closes that duplicate
    // dispatch door centrally for every present and future caller.
    if (current.presentation) return { state: 'pending_action_owned', row: current };
    if (current.status === 'pending' && isExpired(current)) {
      const expired = resolve(current.approvalId, 'expired', 'approval-resume');
      return { state: 'expired', row: expired.row ?? current };
    }
    if (current.status === 'pending') return { state: 'pending', row: current };
    if (current.resolution === 'rejected') return { state: 'rejected', row: current };
    if (current.resolution === 'expired' || current.status === 'expired') return { state: 'expired', row: current };
    if (current.resolution === 'cancelled_by_user' || current.status === 'cancelled') {
      return { state: 'cancelled', row: current };
    }
    if (current.resolution !== 'approved') return { state: 'expired', row: current };
    if (current.consumedAt) return { state: 'consumed', row: current };

    const consumedAt = new Date().toISOString();
    const changes = db.prepare(`
      UPDATE pending_approvals
         SET consumed_at = ?
       WHERE approval_id = ?
         AND status = 'resolved'
         AND resolution = 'approved'
         AND consumed_at IS NULL
    `).run(consumedAt, current.approvalId).changes;
    const claimed = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(current.approvalId) as ApprovalSqlRow;
    return {
      state: changes === 1 ? 'approved' : 'consumed',
      row: rowToPublic(claimed),
    };
  });
  return claim();
}

/**
 * Claim the newest resolved-approved, unconsumed approval for a SESSION,
 * restricted to replay-supported tools. This is the re-admission twin of
 * `claimResumableApproval`: that one matches by exact-payload hash, which a
 * re-run model that re-composes its payload can never reproduce (the 2026-07-21
 * approve→re-ask treadmill: 3 approvals granted, 0 consumed, nothing sent).
 * On re-admission the runner claims the APPROVED payload itself and replays it
 * verbatim — same atomic one-shot consume, so a racing duplicate re-admission
 * can never double-execute, and rejected/expired rows are never touched.
 */
export function claimApprovedUnconsumedForSession(
  sessionId: string,
  opts: { tools: string[] },
): PendingApprovalRow | null {
  if (opts.tools.length === 0) return null;
  const db = openEventLog();
  const placeholders = opts.tools.map(() => '?').join(',');
  const claim = db.transaction((): PendingApprovalRow | null => {
    const row = db.prepare(`
      SELECT * FROM pending_approvals
       WHERE session_id = ?
         AND status = 'resolved'
         AND resolution = 'approved'
         AND consumed_at IS NULL
         AND tool IN (${placeholders})
       ORDER BY resolved_at DESC, rowid DESC
       LIMIT 1
    `).get(sessionId, ...opts.tools) as ApprovalSqlRow | undefined;
    if (!row) return null;
    const current = rowToPublic(row);
    const changes = db.prepare(`
      UPDATE pending_approvals
         SET consumed_at = ?
       WHERE approval_id = ?
         AND status = 'resolved'
         AND resolution = 'approved'
         AND consumed_at IS NULL
    `).run(new Date().toISOString(), current.approvalId).changes;
    if (changes !== 1) return null;
    const claimed = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(current.approvalId) as ApprovalSqlRow;
    return rowToPublic(claimed);
  });
  return claim();
}

/**
 * S2 (gate audit 2026-07-23): does this session hold a HUMAN-approved consent
 * that covers RE-sending to `target`, granted AFTER the prior send? Read-only
 * (never consumes). The time scope is the contract: the ORIGINAL batch
 * approval predates the first send and therefore can never authorize a
 * duplicate — only a FRESH approval naming the same target does.
 */
export function hasApprovedResendConsent(
  sessionId: string,
  target: string,
  priorSendAtIso: string | undefined,
  actionKey?: string,
): boolean {
  const needle = target.trim().toLowerCase();
  const requestedActionKey = actionKey?.trim().toLowerCase() ?? '';
  if (!needle || !requestedActionKey) return false;
  try {
    const db = openEventLog();
    const rows = db.prepare(`
      SELECT tool, args_json, resolved_at FROM pending_approvals
       WHERE session_id = ?
         AND status = 'resolved'
         AND resolution = 'approved'
         AND resend_consumed_at IS NULL
       ORDER BY resolved_at DESC, rowid DESC
       LIMIT 25
    `).all(sessionId) as ResendApprovalCandidate[];
    for (const row of rows) {
      if (resendApprovalMatches(
        row,
        needle,
        priorSendAtIso,
        requestedActionKey,
      )) return true;
    }
  } catch { /* fail toward the wall — no consent found */ }
  return false;
}

/**
 * Atomically claim one fresh human approval for a deliberate duplicate send.
 * `consumed_at` belongs to the approval/replay gate and may already be set for
 * this same call; `resend_consumed_at` is the duplicate wall's independent
 * one-shot. The conditional UPDATE makes the claim safe across processes.
 */
export function claimApprovedResendConsent(
  sessionId: string,
  target: string,
  priorSendAtIso: string | undefined,
  actionKey?: string,
): boolean {
  const needle = target.trim().toLowerCase();
  const requestedActionKey = actionKey?.trim().toLowerCase() ?? '';
  if (!needle || !requestedActionKey) return false;
  try {
    const db = openEventLog();
    const claim = db.transaction((): boolean => {
      const rows = db.prepare(`
        SELECT approval_id, tool, args_json, resolved_at
          FROM pending_approvals
         WHERE session_id = ?
           AND status = 'resolved'
           AND resolution = 'approved'
           AND resend_consumed_at IS NULL
         ORDER BY resolved_at DESC, rowid DESC
         LIMIT 25
      `).all(sessionId) as Array<{
        approval_id: string;
        tool: string | null;
        args_json: string | null;
        resolved_at: string | null;
      }>;
      const row = rows.find((candidate) => resendApprovalMatches(
        candidate,
        needle,
        priorSendAtIso,
        requestedActionKey,
      ));
      if (!row) return false;
      const changes = db.prepare(`
        UPDATE pending_approvals
           SET resend_consumed_at = ?
         WHERE approval_id = ?
           AND resend_consumed_at IS NULL
           AND status = 'resolved'
           AND resolution = 'approved'
      `).run(new Date().toISOString(), row.approval_id).changes;
      return changes === 1;
    });
    return claim();
  } catch {
    // Fail toward the duplicate wall.
    return false;
  }
}

/**
 * Look up an approval by ID. Returns undefined when not found.
 */
export function get(approvalId: string): PendingApprovalRow | undefined {
  const db = openEventLog();
  const row = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
    .get(approvalId) as ApprovalSqlRow | undefined;
  return row ? rowToPublic(row) : undefined;
}

/**
 * List approvals that match the filter. Used by the chat-surface
 * routing to figure out whether a bare "approve" should resolve THIS
 * channel's one-and-only pending, OR demand an explicit `apr-xxx`
 * code because there are several.
 *
 * Default filter: `status='pending'`. Pass `status: 'any'` to include
 * resolved/expired rows (the dashboard panel uses this for history).
 */
export interface ListFilter {
  status?: PendingApprovalStatus | 'any';
  sessionId?: string;
  channelId?: string;
  channel?: string;
}

export function listPending(filter: ListFilter = {}): PendingApprovalRow[] {
  const db = openEventLog();
  const conditions: string[] = [];
  const params: unknown[] = [];
  const status = filter.status ?? 'pending';
  if (status !== 'any') {
    conditions.push('status = ?');
    params.push(status);
  }
  if (filter.sessionId) {
    conditions.push('session_id = ?');
    params.push(filter.sessionId);
  }
  if (filter.channelId) {
    conditions.push('channel_id = ?');
    params.push(filter.channelId);
  }
  if (filter.channel) {
    conditions.push('channel = ?');
    params.push(filter.channel);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM pending_approvals ${where} ORDER BY requested_at DESC`)
    .all(...params) as ApprovalSqlRow[];
  return rows.map(rowToPublic);
}

/** True when a row belongs on formal approval-card surfaces. A conversational
 * send still pauses execution in this registry, but presenting it as a card or
 * accepting a dashboard/mobile approval would bypass the exact reply source. */
export function isFormalApprovalSurface(row: PendingApprovalRow): boolean {
  return row.presentation?.kind !== 'autonomous_send_consent';
}

/** The only public dependency a pending approval may expose. Conversational
 * consent keeps its approval id private and projects the frozen exact-action
 * question; every other row retains the formal approval-card contract. */
export type PendingApprovalUserDependency =
  | { kind: 'approval'; approvalId: string }
  | { kind: 'input'; question: string };

export function projectPendingApprovalUserDependency(
  row: PendingApprovalRow,
): PendingApprovalUserDependency {
  return isFormalApprovalSurface(row)
    ? { kind: 'approval', approvalId: row.approvalId }
    : { kind: 'input', question: row.presentation!.question };
}

/** Stable provider idempotency identity shared by the first live question and
 * every restart redelivery. It is derived from the durable approval identity,
 * never from a replaceable prompt event id. */
export function conversationalApprovalDeliveryKey(approvalId: string): string {
  return `send-consent:${approvalId}`;
}

export function bindConversationalApprovalTransportTarget(input: {
  approvalId: string;
  target: NonNullable<ConversationalApprovalPresentation['transportTarget']>;
}): PendingApprovalRow | null {
  const db = openEventLog();
  const tx = db.transaction((): PendingApprovalRow | null => {
    const row = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(input.approvalId) as ApprovalSqlRow | undefined;
    if (!row || row.status !== 'pending') return row ? rowToPublic(row) : null;
    const presentation = parseConversationalPresentation(row.presentation_json);
    if (!presentation) return rowToPublic(row);
    if (presentation.transportTarget && JSON.stringify(presentation.transportTarget) !== JSON.stringify(input.target)) {
      throw new Error('conversational approval transport target conflicts with its durable message');
    }
    db.prepare('UPDATE pending_approvals SET presentation_json = ? WHERE approval_id = ? AND status = \'pending\'')
      .run(JSON.stringify({ ...presentation, transportTarget: input.target }), input.approvalId);
    return rowToPublic(db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(input.approvalId) as ApprovalSqlRow);
  });
  return tx.immediate();
}

/** Bind the durable ordinary question to its exact public event and record
 * successful transport delivery. Until this succeeds, bare replies cannot
 * select the row; a restart can safely re-present it. */
export function markConversationalApprovalPresented(input: {
  approvalId: string;
  promptEventId: string;
  promptEventSeq: number;
  presentedAt?: string;
}): PendingApprovalRow | null {
  const db = openEventLog();
  const presentedAt = input.presentedAt ?? new Date().toISOString();
  const tx = db.transaction((): PendingApprovalRow | null => {
    const row = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(input.approvalId) as ApprovalSqlRow | undefined;
    if (!row || row.status !== 'pending') return row ? rowToPublic(row) : null;
    const presentation = parseConversationalPresentation(row.presentation_json);
    if (!presentation) return rowToPublic(row);
    if (
      presentation.promptEventId !== null
      && (
        presentation.promptEventId !== input.promptEventId
        || presentation.promptEventSeq !== input.promptEventSeq
      )
    ) throw new Error('conversational approval presentation conflicts with its durable prompt');
    db.prepare(`
      UPDATE pending_approvals
         SET presentation_json = ?
       WHERE approval_id = ? AND status = 'pending'
    `).run(JSON.stringify({
      ...presentation,
      promptEventId: input.promptEventId,
      promptEventSeq: input.promptEventSeq,
      presentedAt: presentation.presentedAt ?? presentedAt,
    } satisfies ConversationalApprovalPresentation), input.approvalId);
    const updated = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(input.approvalId) as ApprovalSqlRow;
    return rowToPublic(updated);
  });
  return tx.immediate();
}

/** SQLite CAS guarding the one public prompt-event append for a conversational
 * row. `promptEventId === ''` is an internal in-progress sentinel and is never
 * reply-eligible; bind replaces it with the exact persisted event. A daemon
 * crash leaves the sentinel safely reprojectable on boot. */
export function claimConversationalApprovalPromptSurface(approvalId: string): boolean {
  const db = openEventLog();
  const tx = db.transaction((): boolean => {
    const raw = db.prepare('SELECT presentation_json FROM pending_approvals WHERE approval_id = ? AND status = \'pending\'')
      .get(approvalId) as { presentation_json: string | null } | undefined;
    const presentation = parseConversationalPresentation(raw?.presentation_json ?? null);
    if (!presentation || presentation.promptEventId !== null) return false;
    const changed = db.prepare(`
      UPDATE pending_approvals SET presentation_json = ?
       WHERE approval_id = ? AND status = 'pending' AND presentation_json = ?
    `).run(JSON.stringify({ ...presentation, promptEventId: '' }), approvalId, raw!.presentation_json).changes;
    return changed === 1;
  });
  return tx.immediate();
}

/** Bind the immutable question event before transport I/O. Delivery success is
 * recorded separately, so a crash before the first edit remains re-presentable
 * and cannot accept a reply. */
export function bindConversationalApprovalPrompt(input: {
  approvalId: string;
  promptEventId: string;
  promptEventSeq: number;
}): PendingApprovalRow | null {
  const db = openEventLog();
  const tx = db.transaction((): PendingApprovalRow | null => {
    const row = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(input.approvalId) as ApprovalSqlRow | undefined;
    if (!row || row.status !== 'pending') return row ? rowToPublic(row) : null;
    const presentation = parseConversationalPresentation(row.presentation_json);
    if (!presentation) return rowToPublic(row);
    if (
      presentation.promptEventId !== null
      && presentation.promptEventId !== ''
      && presentation.presentedAt !== null
      && (
        presentation.promptEventId !== input.promptEventId
        || presentation.promptEventSeq !== input.promptEventSeq
      )
    ) throw new Error('conversational approval prompt conflicts with its durable event');
    const prompt = db.prepare('SELECT session_id, type, data_json FROM events WHERE id = ?')
      .get(input.promptEventId) as { session_id: string; type: string; data_json: string } | undefined;
    const promptData = prompt ? safeParse(prompt.data_json) : null;
    if (
      !prompt
      || prompt.session_id !== row.session_id
      || prompt.type !== 'approval_requested'
      || promptData?.approvalId !== input.approvalId
      || promptData?.approvalPresentation !== 'conversation'
    ) throw new Error('conversational approval prompt event is not exact');
    db.prepare('UPDATE pending_approvals SET presentation_json = ? WHERE approval_id = ? AND status = \'pending\'')
      .run(JSON.stringify({
        ...presentation,
        promptEventId: input.promptEventId,
        promptEventSeq: input.promptEventSeq,
      } satisfies ConversationalApprovalPresentation), input.approvalId);
    return rowToPublic(db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(input.approvalId) as ApprovalSqlRow);
  });
  return tx.immediate();
}

/** Atomic reply claim. This is selection authority, not execution authority:
 * registry.resolve still owns the approved/rejected transition afterward. */
export function claimConversationalApprovalReply(input: {
  approvalId: string;
  sourceUserSeq: number;
  userId: string;
  conversationKey: string;
  decision: 'approve' | 'reject';
}): PendingApprovalRow | null {
  const db = openEventLog();
  const tx = db.transaction((): PendingApprovalRow | null => {
    const row = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(input.approvalId) as ApprovalSqlRow | undefined;
    if (!row || row.status !== 'pending') return null;
    const presentation = parseConversationalPresentation(row.presentation_json);
    if (
      !presentation
      || !presentation.presentedAt
      || !presentation.promptEventId
      || !presentation.promptEventSeq
      || presentation.responseSourceUserSeq !== null
      || presentation.responseUserId !== null
      || presentation.audienceUserId !== input.userId
      || presentation.conversationKey !== input.conversationKey
      || input.sourceUserSeq <= presentation.promptEventSeq
    ) return null;
    const prompt = db.prepare(
      `SELECT id, seq, session_id, type, data_json FROM events WHERE id = ?`,
    ).get(presentation.promptEventId) as {
      id: string; seq: number; session_id: string; type: string; data_json: string;
    } | undefined;
    const response = db.prepare(
      `SELECT seq, session_id, type, role, data_json FROM events WHERE seq = ?`,
    ).get(input.sourceUserSeq) as {
      seq: number; session_id: string; type: string; role: string; data_json: string;
    } | undefined;
    const promptData = prompt ? safeParse(prompt.data_json) : null;
    const responseData = response ? safeParse(response.data_json) : null;
    if (
      !prompt
      || prompt.seq !== presentation.promptEventSeq
      || prompt.session_id !== row.session_id
      || prompt.type !== 'approval_requested'
      || promptData?.approvalId !== input.approvalId
      || promptData?.approvalPresentation !== 'conversation'
      || !response
      || response.session_id !== row.session_id
      || response.type !== 'user_input_received'
      || response.role !== 'user'
      || responseData?.synthetic === true
      || responseData?.source !== 'channel_send_consent'
      || responseData?.approvalId !== input.approvalId
      || responseData?.decision !== input.decision
      || responseData?.userId !== input.userId
      || responseData?.conversationKey !== input.conversationKey
    ) return null;
    const intervening = db.prepare(`
      SELECT 1 AS present
        FROM events
       WHERE session_id = ?
         AND type = 'user_input_received'
         AND seq > ?
         AND seq < ?
         AND COALESCE(json_extract(data_json, '$.synthetic'), 0) != 1
       LIMIT 1
    `).get(row.session_id, presentation.promptEventSeq, input.sourceUserSeq);
    if (intervening) return null;
    const changes = db.prepare(`
      UPDATE pending_approvals
         SET presentation_json = ?
       WHERE approval_id = ?
         AND status = 'pending'
         AND presentation_json = ?
    `).run(JSON.stringify({
      ...presentation,
      responseSourceUserSeq: input.sourceUserSeq,
      responseUserId: input.userId,
    } satisfies ConversationalApprovalPresentation), input.approvalId, row.presentation_json).changes;
    if (changes !== 1) return null;
    return rowToPublic(db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(input.approvalId) as ApprovalSqlRow);
  });
  return tx.immediate();
}

/** Claim the exact reply and decide the row in one SQLite transaction. This
 * removes both crash cuts between response CAS and resolution. File-backed PA
 * promotion happens after commit and is reconciled idempotently on ingress or
 * boot from the canonical row. */
export function resolveConversationalApprovalReply(input: {
  approvalId: string;
  sourceUserSeq: number;
  userId: string;
  conversationKey: string;
  decision: 'approve' | 'reject';
  resolver: string;
}): ResolveResult {
  const db = openEventLog();
  const decided = db.transaction((): ResolveResult => {
    const row = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(input.approvalId) as ApprovalSqlRow | undefined;
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status !== 'pending') return { ok: false, reason: 'already_resolved', row: rowToPublic(row) };
    const presentation = parseConversationalPresentation(row.presentation_json);
    if (
      !presentation
      || !presentation.presentedAt
      || !presentation.promptEventId
      || !presentation.promptEventSeq
      || presentation.responseSourceUserSeq !== null
      || presentation.responseUserId !== null
      || presentation.audienceUserId !== input.userId
      || presentation.conversationKey !== input.conversationKey
      || input.sourceUserSeq <= presentation.promptEventSeq
    ) return { ok: false, reason: 'already_resolved' };
    const prompt = db.prepare('SELECT id, seq, session_id, type, data_json FROM events WHERE id = ?')
      .get(presentation.promptEventId) as { id: string; seq: number; session_id: string; type: string; data_json: string } | undefined;
    const response = db.prepare('SELECT seq, session_id, type, role, data_json FROM events WHERE seq = ?')
      .get(input.sourceUserSeq) as { seq: number; session_id: string; type: string; role: string; data_json: string } | undefined;
    const promptData = prompt ? safeParse(prompt.data_json) : null;
    const responseData = response ? safeParse(response.data_json) : null;
    if (
      !prompt
      || prompt.seq !== presentation.promptEventSeq
      || prompt.session_id !== row.session_id
      || prompt.type !== 'approval_requested'
      || promptData?.approvalId !== input.approvalId
      || promptData?.approvalPresentation !== 'conversation'
      || !response
      || response.session_id !== row.session_id
      || response.type !== 'user_input_received'
      || response.role !== 'user'
      || responseData?.synthetic === true
      || responseData?.source !== 'channel_send_consent'
      || responseData?.approvalId !== input.approvalId
      || responseData?.decision !== input.decision
      || responseData?.userId !== input.userId
      || responseData?.conversationKey !== input.conversationKey
    ) return { ok: false, reason: 'already_resolved' };
    const intervening = db.prepare(`
      SELECT 1 AS present FROM events
       WHERE session_id = ? AND type = 'user_input_received'
         AND seq > ? AND seq < ?
         AND COALESCE(json_extract(data_json, '$.synthetic'), 0) != 1
       LIMIT 1
    `).get(row.session_id, presentation.promptEventSeq, input.sourceUserSeq);
    if (intervening) return { ok: false, reason: 'already_resolved' };
    const now = new Date().toISOString();
    const nextPresentation: ConversationalApprovalPresentation = {
      ...presentation,
      responseSourceUserSeq: input.sourceUserSeq,
      responseUserId: input.userId,
    };
    const changes = db.prepare(`
      UPDATE pending_approvals
         SET presentation_json = ?, status = 'resolved', resolution = ?, resolver = ?, resolved_at = ?
       WHERE approval_id = ? AND status = 'pending' AND presentation_json = ?
    `).run(
      JSON.stringify(nextPresentation),
      input.decision === 'approve' ? 'approved' : 'rejected',
      input.resolver,
      now,
      input.approvalId,
      row.presentation_json,
    ).changes;
    if (changes !== 1) {
      const reread = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
        .get(input.approvalId) as ApprovalSqlRow;
      return { ok: false, reason: 'already_resolved', row: rowToPublic(reread) };
    }
    const updated = db.prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(input.approvalId) as ApprovalSqlRow;
    return { ok: true, row: rowToPublic(updated) };
  }).immediate();
  if (decided.ok && decided.row) finalizeResolvedRow(decided.row);
  return decided;
}

export interface TaggedConversationalApprovalReply {
  sourceUserSeq: number;
  userId: string;
  conversationKey: string;
  decision: 'approve' | 'reject';
  runId: string;
}

/** Recover the exact B event written before a process died ahead of the reply
 * CAS. This is deliberately read-only: ingress can adopt the original runId
 * and use the normal atomic resolver, while boot can perform that same resolver
 * itself. More than one candidate (including a Yes/No race) is ambiguous and
 * stays fail-closed. */
export function taggedConversationalApprovalReply(
  row: PendingApprovalRow,
): TaggedConversationalApprovalReply | null {
  const presentation = row.presentation;
  if (
    row.status !== 'pending'
    || !presentation?.presentedAt
    || !presentation.promptEventId
    || !presentation.promptEventSeq
    || presentation.responseSourceUserSeq !== null
    || presentation.responseUserId !== null
  ) return null;
  const promptEventSeq = presentation.promptEventSeq;
  const candidates = listEvents(row.sessionId, { types: ['user_input_received'] })
    .filter((event) => event.seq > promptEventSeq)
    .filter((event) => (
      event.role === 'user'
      && event.data.synthetic !== true
      && event.data.source === 'channel_send_consent'
      && event.data.approvalId === row.approvalId
      && (event.data.decision === 'approve' || event.data.decision === 'reject')
      && event.data.userId === presentation.audienceUserId
      && event.data.conversationKey === presentation.conversationKey
      && typeof event.data.runId === 'string'
      && event.data.runId.trim()
    ));
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  const firstReal = listEvents(row.sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq > promptEventSeq && event.role === 'user' && event.data.synthetic !== true);
  if (firstReal?.seq !== candidate.seq) return null;
  return {
    sourceUserSeq: candidate.seq,
    userId: candidate.data.userId as string,
    conversationKey: candidate.data.conversationKey as string,
    decision: candidate.data.decision as 'approve' | 'reject',
    runId: candidate.data.runId as string,
  };
}

/** A changed/unrelated immediate reply must not leave a stale frozen version
 * waiting to capture a later bare Yes. This removes conversational addressing;
 * the still-pending row remains visible as a formal exact card for audit/manual
 * disposition. */
export function invalidateConversationalApprovalReply(approvalId: string): boolean {
  return openEventLog().prepare(`
    UPDATE pending_approvals
       SET presentation_json = NULL
     WHERE approval_id = ?
       AND status = 'pending'
       AND presentation_json IS NOT NULL
  `).run(approvalId).changes === 1;
}

/**
 * Convenience predicate. Used by every "is this session paused?"
 * call-site so the answer is single-sourced — no more three
 * disagreeing definitions of "paused".
 */
export function hasPending(sessionId: string): boolean {
  const db = openEventLog();
  const row = db
    .prepare("SELECT 1 AS hit FROM pending_approvals WHERE session_id = ? AND status = 'pending' LIMIT 1")
    .get(sessionId) as { hit: number } | undefined;
  return !!row;
}

/**
 * Resolve a pending approval. Atomic — if another caller resolved it
 * first, the second caller's `resolve` returns `{ ok: false, reason }`
 * so they can surface "already resolved by <resolver>" instead of
 * silently overwriting.
 */
export interface ResolveResult {
  ok: boolean;
  reason?: 'already_resolved' | 'not_found' | 'expired';
  row?: PendingApprovalRow;
}

function conversationConsentForRow(
  row: PendingApprovalRow,
): { by: 'human'; evidence: import('./pending-actions.js').PendingActionApprovalEvidence } | undefined {
  const presentation = row.presentation;
  return row.resolution === 'approved'
    && presentation?.promptEventId
    && presentation.promptEventSeq
    && presentation.responseSourceUserSeq
    && presentation.responseUserId
    ? {
        by: 'human',
        evidence: {
          kind: 'conversation',
          approvalId: row.approvalId,
          promptEventId: presentation.promptEventId,
          promptEventSeq: presentation.promptEventSeq,
          responseSourceUserSeq: presentation.responseSourceUserSeq,
          sourceUserSeq: presentation.sourceUserSeq,
          responderUserId: presentation.responseUserId,
          conversationKey: presentation.conversationKey,
          originReplyTargetDigest: presentation.originReplyTargetDigest,
        },
      }
    : undefined;
}

/** Reconcile the durable file-backed action from the canonical SQLite
 * decision. Safe to call at ingress, immediately after resolve, and on boot. */
export function reconcileLinkedPendingActionResolution(row: PendingApprovalRow): boolean {
  const pendingActionId = pendingActionIdFromArgs(row.args);
  if (!pendingActionId || !row.resolution || row.status === 'pending') return false;
  const pendingAction = getPendingAction(pendingActionId);
  if (!pendingAction || pendingAction.sessionId !== row.sessionId || pendingAction.approvalId !== row.approvalId) {
    return false;
  }
  const resolution = row.resolution;
  try {
    markPendingActionApprovalResolved(
      pendingActionId,
      resolution,
      row.approvalId,
      conversationConsentForRow(row),
    );
  } catch {
    // The SQLite decision remains canonical. A transient transition-lock DB
    // failure is pre-provider and retryable by the conversational settler.
    return false;
  }
  const reconciled = getPendingAction(pendingActionId);
  if (!reconciled || reconciled.approvalId !== row.approvalId) return false;
  if (resolution === 'approved') {
    return reconciled.status === 'approved'
      && reconciled.approvedBy === 'human'
      && reconciled.approvalEvidence?.kind === (row.presentation ? 'conversation' : 'card');
  }
  const expected = resolution === 'rejected' ? 'rejected'
    : resolution === 'expired' ? 'expired'
      : 'cancelled';
  return reconciled.status === expected;
}

function finalizeResolvedRow(publicRow: PendingApprovalRow): void {
  try {
    markNotificationsReadByApprovalId(publicRow.approvalId, {
      approvalStatus: publicRow.status,
      approvalResolution: publicRow.resolution,
      approvalResolver: publicRow.resolver,
    });
  } catch { /* registry decision remains canonical */ }
  if (publicRow.resolution === 'approved' || publicRow.resolution === 'rejected') {
    try {
      const id = approvalChoiceIdentifier(publicRow.tool, publicRow.args);
      if (id) updateToolChoiceOutcomeForIdentifier(id, publicRow.resolution);
    } catch { /* best-effort */ }
  }
  try { reconcileLinkedPendingActionResolution(publicRow); } catch { /* boot/ingress retries */ }
  try {
    appendAuditRecord({
      at: publicRow.resolvedAt ?? new Date().toISOString(),
      kind: 'approval_resolved',
      sessionId: publicRow.sessionId,
      approvalId: publicRow.approvalId,
      subject: publicRow.subject,
      tool: publicRow.tool,
      resolution: publicRow.resolution,
      resolvedBy: publicRow.resolver ?? null,
    });
  } catch { /* the ledger never blocks resolution */ }
  emitResolved(publicRow);
}

export function resolve(
  approvalId: string,
  resolution: ApprovalResolution,
  resolver: string,
): ResolveResult {
  const db = openEventLog();
  const existing = db
    .prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
    .get(approvalId) as ApprovalSqlRow | undefined;
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'pending') return { ok: false, reason: 'already_resolved', row: rowToPublic(existing) };

  // Atomic conditional update — only succeeds if status is still
  // 'pending'. Two racers can't both win.
  const nextStatus: PendingApprovalStatus = resolution === 'expired' ? 'expired' : 'resolved';
  const now = new Date().toISOString();
  const changes = db
    .prepare(`
      UPDATE pending_approvals
         SET status      = ?,
             resolution  = ?,
             resolver    = ?,
             resolved_at = ?
       WHERE approval_id = ?
         AND status      = 'pending'
    `)
    .run(nextStatus, resolution, resolver, now, approvalId).changes;
  if (changes === 0) {
    const reread = db
      .prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
      .get(approvalId) as ApprovalSqlRow;
    return { ok: false, reason: 'already_resolved', row: rowToPublic(reread) };
  }
  const row = db
    .prepare('SELECT * FROM pending_approvals WHERE approval_id = ?')
    .get(approvalId) as ApprovalSqlRow;
  const publicRow = rowToPublic(row);
  finalizeResolvedRow(publicRow);
  return { ok: true, row: publicRow };
}

/**
 * Reaper helper. Finds pending rows past their expiry and marks them
 * expired. Returns the rows that were just expired so the caller can
 * emit user-facing notifications + clear interrupt state on each one.
 *
 * Idempotent: calling this twice for the same row is a no-op the
 * second time (the conditional UPDATE only fires when status='pending').
 */
export function expireStaleApprovals(now: Date = new Date()): PendingApprovalRow[] {
  const db = openEventLog();
  const candidates = db
    .prepare("SELECT * FROM pending_approvals WHERE status = 'pending' AND expires_at < ?")
    .all(now.toISOString()) as ApprovalSqlRow[];

  const expired: PendingApprovalRow[] = [];
  for (const row of candidates) {
    const result = resolve(row.approval_id, 'expired', 'reaper');
    if (result.ok && result.row) expired.push(result.row);
  }
  return expired;
}


/** Send slugs a HUMAN previously approved in the given sessions (any run).
 *  Standing-consent graduation for scheduled workflows (owner feedback,
 *  2026-07-24): a saved + enabled + scheduled workflow whose declared send a
 *  person approved once keeps running unattended with that same slug
 *  auto-approved in scope; a rejection stays one-shot — never a standing
 *  block. Best-effort: an unreadable registry returns []. */
export function approvedSendSlugsForSessions(sessionIds: string[]): string[] {
  if (sessionIds.length === 0) return [];
  try {
    const db = openEventLog();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT args_json FROM pending_approvals
       WHERE session_id IN (${placeholders})
         AND resolution = 'approved'
    `).all(...sessionIds) as Array<{ args_json: string | null }>;
    const slugs = new Set<string>();
    for (const row of rows) {
      try {
        const args = JSON.parse(row.args_json ?? '{}') as { tool_slug?: unknown; args?: { tool_slug?: unknown } };
        const slug = typeof args.tool_slug === 'string' ? args.tool_slug
          : typeof args.args?.tool_slug === 'string' ? args.args.tool_slug : '';
        if (slug.trim()) slugs.add(slug.trim().toUpperCase());
      } catch { /* one unreadable row never poisons the rest */ }
    }
    return [...slugs];
  } catch {
    return [];
  }
}
