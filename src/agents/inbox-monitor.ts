/**
 * C2 — Ambient inbox watch (general, read-only).
 *
 * The first ambient layer: instead of only acting when asked, Clementine
 * periodically watches the user's connected mailbox(es) and surfaces ONLY the
 * messages that genuinely need them as "needs-you" cards. This is the 2026
 * "ambient agent" differentiator — but the make-or-break is *knowing when to
 * stay silent*, so it scores each unread message and surfaces a small, capped,
 * deduped set.
 *
 * Design (binding: general, never user-specific — see feedback_global_not_user_specific):
 *  - Works for ANY user with ANY connected mail provider. Mail connections are
 *    DISCOVERED at runtime (listConnectedToolkits) — no hardcoded inbox/pin.
 *  - Multiple accounts → readable mail connections are watched, and every
 *    surfaced item is LABELED with its source account (the connection id rides
 *    in metadata for routing) so it's visible, never buried in a guessed default.
 *    Stale connections that return hard Composio auth errors are backed off by
 *    connection id.
 *  - SURFACE-ONLY BY CONSTRUCTION: the monitor only ever calls a READ action and
 *    addNotification(). It never sends/replies/mutates — so it cannot act on the
 *    user's mail no matter what.
 *  - Gated: proactivity policy (enabled + quiet hours) + cadence + per-scan cap +
 *    dedup by message id. Default ON (validated behavior is the default); kill
 *    with CLEMMY_INBOX_MONITOR=off. Surfaces dashboard-only (silent) for v1 — no
 *    Discord/push of mail flags, so even a marginal card stays quiet.
 *
 * v2 (deferred): smarter scoring via recall (the user's known priorities) + an
 * LLM relevance pass; calendar/Slack monitors on the same pattern; per-user rules.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR, getRuntimeEnv } from '../config.js';
import { executeComposioTool, listConnectedToolkits } from '../integrations/composio/client.js';
import { addNotification, type NotificationRecord } from '../runtime/notifications.js';
import {
  clearConnectionSuppression,
  isConnectionSuppressed,
  pruneConnectionSuppressions,
  suppressConnectionAfterHardAuthFailure,
  type ComposioConnectionSuppression,
} from './composio-connection-suppression.js';
import { getProactivityPolicySnapshot, loadProactivityPolicy } from './proactivity-policy.js';
import { decideSurface, shouldSurface, surfaceDecisionV2Enabled, type SurfaceDecision } from './surface-decision.js';

const logger = pino({ name: 'clementine-next.inbox-monitor' });

const STATE_FILE = path.join(BASE_DIR, 'state', 'inbox-monitor.json');
const SURFACED_IDS_CAP = 500; // bound the dedup memory

export interface UnreadMessage {
  id: string;
  subject: string;
  fromName: string;
  fromAddress: string;
  receivedAt: string;
  preview: string;
  webLink?: string;
}

interface MailProvider {
  /** Composio read action slug. */
  slug: string;
  /** Build the read args for "recent unread, top N". */
  args: (top: number) => Record<string, unknown>;
  /** Normalize the provider response into UnreadMessage[] (defensive). */
  parse: (resp: unknown) => UnreadMessage[];
}

interface InboxMonitorState {
  lastScanAt?: string;
  surfacedIds: string[];
  suppressedConnections?: Record<string, ComposioConnectionSuppression>;
}

export interface InboxMonitorDeps {
  listConnections: typeof listConnectedToolkits;
  executeTool: typeof executeComposioTool;
  notify: (n: NotificationRecord) => void;
  config: () => InboxMonitorConfig;
  proactiveWorkAllowed: () => boolean;
  now: () => number;
  loadState: () => InboxMonitorState;
  saveState: (s: InboxMonitorState) => void;
}

// ── config (user-editable via the proactivity policy) ────────────────────────
export interface InboxMonitorConfig {
  enabled: boolean;
  intervalMs: number;
  maxPerScan: number;
  fetchTop: number;
}
/**
 * Read the live settings from the proactivity policy (what the user edits in the
 * dashboard: on/off, how often, how many per check). Active hours come from the
 * policy's quiet-hours window via proactiveWorkAllowed. CLEMMY_INBOX_MONITOR=off
 * is a hard kill-switch over the user's toggle. Default ON
 * (feedback_no_rollout_flags) — safe because surface-only + dashboard-only.
 */
function realConfig(): InboxMonitorConfig {
  const policy = loadProactivityPolicy();
  const killed = (getRuntimeEnv('CLEMMY_INBOX_MONITOR', 'on') || 'on').toLowerCase() === 'off';
  const fetchOverride = Number.parseInt(getRuntimeEnv('CLEMMY_INBOX_MONITOR_FETCH', '25') || '25', 10);
  return {
    enabled: policy.inboxWatchEnabled !== false && !killed,
    intervalMs: Math.max(1, policy.inboxWatchMinutes) * 60_000,
    maxPerScan: Math.max(1, policy.inboxWatchMax),
    fetchTop: Number.isFinite(fetchOverride) && fetchOverride >= 1 ? fetchOverride : 25,
  };
}

// ── provider catalog (general, per-provider — NOT per-user) ──────────────────
function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}
function pick(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === 'object' && k in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}
/** Find the message array anywhere in a (possibly wrapped) composio response. */
function locateMessages(resp: unknown): unknown[] {
  return asArray(
    pick(resp, 'data', 'value') ??
    pick(resp, 'data', 'messages') ??
    pick(resp, 'data', 'response_data', 'value') ??
    pick(resp, 'value') ??
    pick(resp, 'messages') ??
    [],
  );
}
function str(x: unknown): string {
  return typeof x === 'string' ? x : '';
}

const OUTLOOK: MailProvider = {
  slug: 'OUTLOOK_LIST_MAIL_FOLDER_MESSAGES',
  args: (top) => ({
    mail_folder_id: 'inbox',
    filter: 'isRead eq false',
    orderby: 'receivedDateTime desc',
    top,
    // Composio expects `select` as a LIST (not a comma-string) — verified live.
    select: ['id', 'subject', 'from', 'receivedDateTime', 'bodyPreview', 'webLink'],
  }),
  parse: (resp) => locateMessages(resp).map((m) => ({
    id: str(pick(m, 'id')),
    subject: str(pick(m, 'subject')) || '(no subject)',
    fromName: str(pick(m, 'from', 'emailAddress', 'name')),
    fromAddress: str(pick(m, 'from', 'emailAddress', 'address')),
    receivedAt: str(pick(m, 'receivedDateTime')),
    preview: str(pick(m, 'bodyPreview')),
    webLink: str(pick(m, 'webLink')) || undefined,
  })).filter((m) => m.id),
};

const GMAIL: MailProvider = {
  slug: 'GMAIL_FETCH_EMAILS',
  args: (top) => ({ query: 'is:unread', max_results: top }),
  parse: (resp) => locateMessages(resp).map((m) => ({
    id: str(pick(m, 'messageId')) || str(pick(m, 'id')),
    subject: str(pick(m, 'subject')) || '(no subject)',
    fromName: str(pick(m, 'sender')) || str(pick(m, 'from')),
    fromAddress: str(pick(m, 'sender')) || str(pick(m, 'from')),
    receivedAt: str(pick(m, 'messageTimestamp')) || str(pick(m, 'date')),
    preview: str(pick(m, 'preview', 'body')) || str(pick(m, 'snippet')),
    webLink: undefined,
  })).filter((m) => m.id),
};

const PROVIDERS: Record<string, MailProvider> = { outlook: OUTLOOK, gmail: GMAIL };

// ── scoring: "does this need the user?" (transparent heuristic, v1) ──────────
// Automated/bulk senders — never a needs-you.
const BULK_SENDER = /no-?reply|do-?not-?reply|noreply|donotreply|mailer-?daemon|postmaster|bounce|notifications?@|newsletter@?|marketing@|promo(tion)?s?@|deals?@|mailer@|updates?@|digest@|sales@|hello@|team@|info@|news@|social@|community@|accounts?@|billing@|members?@/i;
// Promotional / marketing / survey CONTENT — excluded even from a real-looking
// sender. This is the make-or-break "stay silent" filter: live testing showed a
// loose heuristic surfaces satisfaction surveys, sales blasts, and "FREE" promos.
const PROMO = /\b(free|sale|\d+\s*%\s*off|% off|discount|coupon|special offer|priced to move|limited[- ]time|act now|buy now|shop now|order now|unsubscribe|newsletter|webinar|register (now|today)|how was (our|your)|rate (your|our)|take (our|the) survey|customer survey|new arrivals|clearance|exclusive (offer|deal)|save big|don'?t miss)\b/i;
// A DIRECT ask of the recipient (a bare "?" is too weak — surveys/promos have them).
const STRONG_ASK = /\b(can|could|would) you\b|please (review|approve|confirm|respond|reply|sign|send|advise|complete|fill|let me know)|let me know|need(s)? your|your (input|feedback|approval|review|thoughts|sign-?off|response|reply|availability|decision|go-?ahead)|waiting (on|for) (you|your)|get back to me|circle back|are you (free|available|able)|when (can|are) you/i;
const URGENT = /\b(urgent|asap|eod|end of day|by (today|tomorrow|cob)|deadline|time-?sensitive|action required|overdue|past due|final notice|needs? (your )?(help|attention|response|sign))\b/i;
const REPLY_THREAD = /^(re|fw|fwd)\s*:/i;

export interface MessageScore {
  needsYou: boolean;
  reasons: string[];
  score: number;
  /** The surface-decision verdict (only set under CLEMMY_SURFACE_DECISION_V2) —
   *  drives triage typing + the anti-firehose gate. */
  decision?: SurfaceDecision;
}
export function scoreMessage(m: UnreadMessage): MessageScore {
  const hay = `${m.subject} ${m.preview}`;
  // Hard exclusions first — bulk sender or promo/survey content never needs you,
  // no matter what urgency words it contains.
  if (!m.fromAddress) return { needsYou: false, reasons: [], score: 0 };
  if (BULK_SENDER.test(`${m.fromAddress} ${m.fromName}`)) return { needsYou: false, reasons: [], score: 0 };
  if (PROMO.test(hay)) return { needsYou: false, reasons: [], score: 0 };

  const hasAsk = STRONG_ASK.test(hay);
  const hasUrgent = URGENT.test(hay);
  const replyQ = REPLY_THREAD.test(m.subject) && /\?/.test(hay);
  const reasons: string[] = [];
  if (hasAsk) reasons.push('asks you something');
  if (hasUrgent) reasons.push('time-sensitive');
  // A reply in a thread the user is on, that contains a question, likely needs
  // them even without a canned ask phrase.
  if (replyQ) reasons.push('a reply in your thread');

  // V2: feed the multi-axis surface-decision scorer instead of the binary
  // reasons.length. risk=0.4 → an inbox item routes to ask/escalate (surface to
  // the user) vs watch/ignore (stay silent) — never autonomous 'act'.
  if (surfaceDecisionV2Enabled()) {
    const v = decideSurface({
      urgency: hasUrgent ? 0.85 : 0.1,
      impact: hasAsk ? 0.7 : replyQ ? 0.6 : 0.15,
      specificity: hasAsk ? 0.8 : replyQ ? 0.55 : 0.2,
      novelty: 0.8,
      risk: 0.4,
      confidence: hasAsk ? 0.8 : hasUrgent ? 0.6 : 0.4,
      conflict: 0,
    });
    return { needsYou: shouldSurface(v.decision), reasons, score: reasons.length, decision: v.decision };
  }
  return { needsYou: reasons.length > 0, reasons, score: reasons.length };
}

// ── state ───────────────────────────────────────────────────────────────────
function loadStateReal(): InboxMonitorState {
  if (!existsSync(STATE_FILE)) return { surfacedIds: [] };
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as InboxMonitorState;
    return { lastScanAt: s.lastScanAt, surfacedIds: Array.isArray(s.surfacedIds) ? s.surfacedIds : [] };
  } catch { return { surfacedIds: [] }; }
}
function saveStateReal(s: InboxMonitorState): void {
  const dir = path.dirname(STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf-8');
}

const REAL_DEPS: InboxMonitorDeps = {
  listConnections: listConnectedToolkits,
  executeTool: executeComposioTool,
  notify: addNotification,
  config: realConfig,
  proactiveWorkAllowed: () => getProactivityPolicySnapshot().proactiveWorkAllowed,
  now: () => Date.now(),
  loadState: loadStateReal,
  saveState: saveStateReal,
};

function accountLabel(conn: { accountEmail?: string; accountName?: string; slug: string }): string {
  return conn.accountEmail || conn.accountName || conn.slug;
}

/**
 * One ambient scan: for each readable connected mailbox, read unread, score,
 * and surface the top needs-you items (capped, deduped, dashboard-only).
 * Connections with hard Composio auth failures are backed off by connection id
 * so stale accounts do not spam the logs. Returns the number of items surfaced.
 * Best-effort: never throws.
 */
export async function processInboxMonitor(deps: InboxMonitorDeps = REAL_DEPS): Promise<number> {
  const cfg = deps.config();
  if (!cfg.enabled) return 0; // inbox-watch toggled off (or kill-switch)
  if (!deps.proactiveWorkAllowed()) return 0; // proactivity disabled / quiet hours

  const nowMs = deps.now();
  const state = deps.loadState();
  if (state.lastScanAt && nowMs - Date.parse(state.lastScanAt) < cfg.intervalMs) return 0;

  let connections: Awaited<ReturnType<typeof listConnectedToolkits>>;
  try {
    connections = await deps.listConnections();
  } catch (err) {
    logger.warn({ err }, 'inbox-monitor: could not list connections');
    return 0;
  }
  // General: every connection whose provider we know how to read. NOT filtered
  // by status — Composio's status flag is unreliable (a working mailbox can
  // report EXPIRED if not hit recently; filtering it would silently stop
  // watching a usable inbox). A genuinely-dead connection surfaces as a read
  // error in the per-mailbox try/catch below. No hardcoded inbox; multiple
  // accounts are all watched + labeled. Hard Composio auth failures are
  // suppressed after the attempted read, so false EXPIRED labels can still work.
  const mailboxes = connections.filter((c) => PROVIDERS[c.slug]);
  if (mailboxes.length === 0) return 0;

  const surfaced = new Set(state.surfacedIds);
  const seenKeys = new Set<string>(); // every unread key seen this scan (window refresh)
  const candidates: Array<{ msg: UnreadMessage; score: MessageScore; label: string; connectionId: string; slug: string }> = [];

  for (const box of mailboxes) {
    if (isConnectionSuppressed(state, box.connectionId, nowMs)) {
      logger.debug({ slug: box.slug, connectionId: box.connectionId }, 'inbox-monitor: skipping suppressed mailbox');
      continue;
    }
    const provider = PROVIDERS[box.slug];
    let resp: unknown;
    try {
      resp = await deps.executeTool(provider.slug, provider.args(cfg.fetchTop), box.connectionId || undefined);
    } catch (err) {
      const suppression = suppressConnectionAfterHardAuthFailure(state, box.connectionId, err, nowMs);
      if (suppression) {
        logger.warn({
          err,
          slug: box.slug,
          connectionId: box.connectionId,
          reason: suppression.reason,
          suppressUntil: suppression.suppressUntil,
        }, 'inbox-monitor: suppressing mailbox after hard auth failure');
      } else {
        logger.warn({ err, slug: box.slug }, 'inbox-monitor: read failed for a mailbox');
      }
      continue;
    }
    clearConnectionSuppression(state, box.connectionId);
    for (const msg of provider.parse(resp)) {
      const key = `${box.connectionId}:${msg.id}`;
      seenKeys.add(key);
      if (surfaced.has(key)) continue; // already surfaced — don't re-card
      const score = scoreMessage(msg);
      if (!score.needsYou) continue;
      candidates.push({ msg, score, label: accountLabel(box), connectionId: box.connectionId, slug: box.slug });
    }
  }

  // Surface the highest-signal first; newest breaks ties (under the cap).
  candidates.sort((a, b) => (b.score.score - a.score.score) || (Date.parse(b.msg.receivedAt || '') || 0) - (Date.parse(a.msg.receivedAt || '') || 0));
  const toSurface = candidates.slice(0, cfg.maxPerScan);
  for (const c of toSurface) {
    const key = `${c.connectionId}:${c.msg.id}`;
    deps.notify(buildNeedsYouNotification(c.msg, c.score, c.label, c.connectionId, c.slug, nowMs));
    surfaced.add(key);
  }

  // Persist only the surfaced ids that are STILL unread this scan (seenKeys) —
  // so a sticky still-unread message keeps its dedup entry instead of aging out
  // of a fixed-size window and re-surfacing as a duplicate. Read/deleted ones
  // drop out naturally (they won't reappear in the unread list). Cap is a backstop.
  const persisted = [...surfaced].filter((k) => seenKeys.has(k)).slice(-SURFACED_IDS_CAP);
  deps.saveState({
    lastScanAt: new Date(nowMs).toISOString(),
    surfacedIds: persisted,
    suppressedConnections: pruneConnectionSuppressions(state, nowMs),
  });

  if (toSurface.length > 0) {
    logger.info({ surfaced: toSurface.length, scanned: mailboxes.length }, 'inbox-monitor surfaced needs-you items');
  }
  return toSurface.length;
}

export function buildNeedsYouNotification(
  m: UnreadMessage,
  score: MessageScore,
  label: string,
  connectionId: string,
  slug: string,
  nowMs: number,
): NotificationRecord {
  const sender = m.fromName || m.fromAddress || 'someone';
  const subject = m.subject.length > 80 ? `${m.subject.slice(0, 77)}...` : m.subject;
  const bodyLines = [
    m.preview ? m.preview.slice(0, 280) : null,
    `Why it needs you: ${score.reasons.join(', ')}`,
    `Account: ${label}`,
  ].filter((l): l is string => l !== null);
  return {
    id: `inbox-${connectionId}-${m.id}`, // stable → notification-layer dedup too
    kind: 'execution',
    title: `📥 ${sender}: ${subject}`,
    body: bodyLines.join('\n').trim(),
    createdAt: new Date(nowMs).toISOString(),
    read: false,
    // Dashboard-only for v1 — surface as a needs-you card; do NOT push mail
    // flags out to Discord/web-push.
    silent: true,
    metadata: {
      needsAttention: true,
      source: 'inbox-monitor',
      account: label,
      provider: slug,
      connectionId,
      messageId: m.id,
      webLink: m.webLink,
      receivedAt: m.receivedAt,
      reasons: score.reasons,
    },
  };
}
