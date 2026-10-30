import { groupAttentionReports } from '@clem/chat-engine';
import { mobileWorkflowPath, WORKFLOW_WIDGET_SLUG } from './workflow-widget';
import type { ApprovalRow, AttentionItem, InboxNotification } from './api';

export interface ApprovalDetailRow {
  label: string;
  value: string;
  long: boolean;
}

const DETAIL_LABELS: Record<string, string> = {
  to: 'To',
  recipient: 'Recipient',
  recipients: 'Recipients',
  account: 'Account',
  company: 'Company',
  channel: 'Channel',
  subject: 'Subject',
  title: 'Title',
  body: 'Message',
  message: 'Message',
  text: 'Message',
  stage: 'Stage',
  amount: 'Amount',
  close_date: 'Close date',
  date: 'Date',
  start: 'Starts',
  end: 'Ends',
  attendees: 'Attendees',
  file: 'File',
  path: 'File',
  url: 'Link',
};

const DETAIL_ORDER = Object.keys(DETAIL_LABELS);
const MAX_DETAIL_FIELDS = 20;
const MAX_COLLECTION_ITEMS = 20;
const MAX_DETAIL_DEPTH = 3;
const MAX_DETAIL_VALUE_CHARS = 4_000;

function words(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentenceCase(value: string): string {
  const clean = words(value);
  return clean ? clean[0].toUpperCase() + clean.slice(1).toLowerCase() : '';
}

function truncateDetail(value: string): string {
  return value.length > MAX_DETAIL_VALUE_CHARS
    ? `${value.slice(0, MAX_DETAIL_VALUE_CHARS - 1)}…`
    : value;
}

function boundedJsonValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return truncateDetail(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DETAIL_DEPTH) return '[More detail omitted]';
  seen.add(value);
  if (Array.isArray(value)) {
    const rows = value.slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => boundedJsonValue(item, depth + 1, seen));
    if (value.length > MAX_COLLECTION_ITEMS) rows.push(`[${value.length - MAX_COLLECTION_ITEMS} more items omitted]`);
    return rows;
  }
  const result: Record<string, unknown> = {};
  let included = 0;
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (included >= MAX_COLLECTION_ITEMS) {
      result.__more__ = 'Additional fields omitted';
      break;
    }
    result[key] = boundedJsonValue((value as Record<string, unknown>)[key], depth + 1, seen);
    included += 1;
  }
  return result;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return truncateDetail(value.trim()) || '—';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return truncateDetail(value.join('\n')) || '—';
  }
  try {
    return truncateDetail(JSON.stringify(boundedJsonValue(value, 0, new WeakSet()), null, 2));
  } catch {
    return truncateDetail(String(value));
  }
}

export function approvalKindLabel(tool: string | null): string {
  const normalized = (tool ?? '').toLowerCase();
  // Consequence outranks provider. `GMAIL_DELETE_MESSAGE` is a destructive
  // action, not merely “Email.”
  if (/delete|remove|revoke/.test(normalized)) return 'Sensitive change';
  if (/outlook|gmail|email/.test(normalized)) return 'Email';
  if (/salesforce|hubspot|crm/.test(normalized)) return 'CRM update';
  if (/slack|teams|discord|message|post/.test(normalized)) return 'Message';
  if (/calendar|event|meeting/.test(normalized)) return 'Calendar';
  if (/sheet|excel|airtable/.test(normalized)) return 'Spreadsheet';
  return 'Action';
}

export function approvalQuestion(subject: string): string {
  const clean = subject.trim().replace(/[.?!]+$/, '');
  if (!clean) return 'I have an action ready. Should I go ahead?';
  const action = clean[0].toLocaleLowerCase() + clean.slice(1);
  return `I’m ready to ${action}. Should I go ahead?`;
}

/** A long hex digest, optionally named by its algorithm. Shape only. */
function isContentFingerprint(value: unknown): boolean {
  return typeof value === 'string' && /^(?:sha(?:1|256|384|512):)?[0-9a-f]{32,}$/i.test(value.trim());
}

export function approvalDetails(row: Pick<ApprovalRow, 'args'>): ApprovalDetailRow[] {
  if (!row.args || typeof row.args !== 'object' || Array.isArray(row.args)) {
    const value = displayValue(row.args);
    return value === '—' ? [] : [{ label: 'Details', value, long: value.length > 100 }];
  }
  const args = row.args as Record<string, unknown>;
  const keys: string[] = [];
  let omitted = false;
  let fingerprinted = false;
  for (const key in args) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    // A content fingerprint pins the exact bytes approved; it is not read.
    if (isContentFingerprint(args[key])) { fingerprinted = true; continue; }
    if (keys.length >= MAX_DETAIL_FIELDS) {
      omitted = true;
      break;
    }
    keys.push(key);
  }
  keys.sort((a, b) => {
    const ai = DETAIL_ORDER.indexOf(a.toLowerCase());
    const bi = DETAIL_ORDER.indexOf(b.toLowerCase());
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b);
  });
  const rows = keys.map((key) => {
    const value = displayValue(args[key]);
    const lower = key.toLowerCase();
    return {
      label: DETAIL_LABELS[lower] ?? sentenceCase(key),
      value,
      long: ['body', 'message', 'text', 'content', 'prompt'].includes(lower) || value.length > 120,
    };
  });
  if (fingerprinted) rows.push({ label: 'Version check', value: 'Locked to this exact version', long: false });
  if (omitted) rows.push({
    label: 'Additional fields',
    value: 'Additional details omitted on mobile. Review the full approval on the desktop if needed.',
    long: true,
  });
  return rows;
}

/** A preview is the host's recorded review, not a summary inferred from args.
 * Legacy flat actions can still be reviewed on the phone when every value fits
 * the readable presenter. An opaque carrier or clipped value needs the full
 * desktop review; a short content preview cannot establish its whole scope. */
/** A calendar time as the card shows it: wall time in its own zone, never
 *  re-read in the phone's zone (which can move an event to another day). */
function wallTime(value: string, timeOnly = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) return null;
  const date = new Date(`${value.length === 16 ? `${value}:00` : value}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit',
    ...(timeOnly ? {} : { weekday: 'short', month: 'short', day: 'numeric' } as const) }).format(date);
}

/** A start, an end and their time zone read as one "When" line: "Thu, Oct 30,
 *  1:00 PM – 1:45 PM · America/Los_Angeles". Anything that does not parse
 *  exactly stays as the rows it came in. */
function readableWhen(rows: ApprovalDetailRow[]): ApprovalDetailRow[] {
  const find = (pattern: RegExp) => rows.find((row) => pattern.test(row.label.trim()));
  const start = find(/^start(?:\s*date\s*time|\s*time)?$/i);
  const end = find(/^end(?:\s*date\s*time|\s*time)?$/i);
  const zone = find(/^time\s*zone$/i);
  if (!start || !end) return rows;
  const from = wallTime(start.value.trim());
  const sameDay = start.value.trim().slice(0, 10) === end.value.trim().slice(0, 10);
  const to = wallTime(end.value.trim(), sameDay);
  if (!from || !to || end.value.trim() <= start.value.trim()) return rows;
  const when = { label: 'When', value: `${from} – ${to}${zone ? ` · ${zone.value.trim()}` : ''}`, long: false };
  const before = rows.slice(0, rows.indexOf(start)).filter((row) => row !== end && row !== zone).length;
  const rest = rows.filter((row) => row !== start && row !== end && row !== zone);
  return [...rest.slice(0, before), when, ...rest.slice(before)];
}

export function approvalCardReview(row: Pick<ApprovalRow, 'args' | 'preview' | 'presentation' | 'contentPreview'>): {
  preview: ApprovalRow['preview'] | null;
  details: ApprovalDetailRow[];
  draft: string;
  complete: boolean;
} {
  const recorded = row.preview;
  const preview = recorded?.items?.length ? recorded : recorded?.fields?.some(field => field.name !== 'Prepared actions')
    ? { operation: recorded.operation, fields: [], items: [recorded] }
    : null;
  const args = row.args;
  const values = args && typeof args === 'object' && !Array.isArray(args)
    ? Object.entries(args as Record<string, unknown>) : null;
  const structuredText = (value: string) => {
    if (!/^\s*[\[{]/.test(value)) return false;
    try { return typeof JSON.parse(value) === 'object'; } catch { return false; }
  };
  const scalar = (value: unknown) => value === null || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)
    || typeof value === 'string' && value.length <= MAX_DETAIL_VALUE_CHARS
      && !structuredText(value);
  const carrierField = (name: string) => /^(?:args(?:[ _-]?json)?|arguments|payload|request|call|tool(?:[ _-]?(?:name|slug))?|requirement(?:[ _-]?id)?)$/i.test(name.trim());
  const placeholder = (value: string) => /^\s*\[(?:withheld|redacted|omitted|more detail)/i.test(value);
  const materialField = (field: NonNullable<ApprovalRow['preview']>['fields'][number]) => {
    const value = field.value.trim();
    return field.name !== 'Prepared actions' && Boolean(value) && !isContentFingerprint(value) && !placeholder(value)
      && Boolean(field.label?.trim() || field.display?.trim() || !field.detail && !(carrierField(field.name) && structuredText(value)));
  };
  const opaquePreparedField = (field: NonNullable<ApprovalRow['preview']>['fields'][number]) => {
    const value = field.value.trim();
    return isContentFingerprint(value) || placeholder(value) || /…\s*\(\d+ more characters\)$/.test(value)
      || carrierField(field.name) && structuredText(value)
      || /^(?:name|tool(?:[ _-]?(?:name|slug))?)$/i.test(field.name) && /^(?:work_call|composio_execute_tool)$/.test(value);
  };
  const preparedComplete = preview?.items?.every(item => item.fields.some(materialField)
    && !item.fields.some(opaquePreparedField)) === true;
  const complete = preparedComplete || Boolean(!preview && values && !row.presentation?.unwrapped
    && values.length > 0 && values.length <= MAX_DETAIL_FIELDS
    && values.every(([, value]) => !isContentFingerprint(value) && (scalar(value)
      || Array.isArray(value) && value.length <= MAX_COLLECTION_ITEMS
        && value.every(item => typeof item === 'string' && scalar(item))
        && value.join('\n').length <= MAX_DETAIL_VALUE_CHARS)));
  const readableDetail = (line: ApprovalDetailRow) => {
    const value = line.value.trim();
    const opaque = value.length >= 20 && !/\s/.test(value) && !/[@/\\]/.test(value)
      && !/\.[A-Za-z0-9]{1,6}$/.test(value) && /^[A-Za-z0-9+=_\-.:]+$/.test(value);
    return Boolean(value) && !carrierField(line.label) && !/\bids?$/i.test(line.label)
      && !structuredText(value) && !isContentFingerprint(value) && !placeholder(value) && !opaque
      && !/\b(?:work_call|composio_execute_tool|args_json|tool_slug|requirement_id|connection_id)\b|cap:resolved/i.test(value);
  };
  // An incomplete review may show a readable server summary, never the carrier
  // arguments that could not be represented. The computer owns its full review.
  const shownPreview = complete ? preview : null;
  const details = readableWhen(shownPreview ? [] : complete ? approvalDetails(row)
    : (row.presentation?.details ?? []).filter(readableDetail));
  const draft = row.contentPreview?.body?.trim() ?? '';
  const draftPrefix = draft.replace(/(?:…|\.{3})$/, '').trimEnd();
  const draftAlreadyRecorded = Boolean(shownPreview && draftPrefix && shownPreview.items?.some(item => item.fields.some(field =>
    /(?:body|message|content|description|text)/i.test(field.name) && field.value.trim().startsWith(draftPrefix))));
  return { preview: shownPreview, details,
    draft: draftAlreadyRecorded || !complete && structuredText(draft) ? '' : draft, complete };
}

/** A notification title as the card shows it: a leading emoji is a status
 *  icon ("📅 Reply needed", "⚠️ Workflow …") and the card already says what
 *  kind of row it is. */
export function notificationTitle(title: string | null | undefined): string {
  return (title ?? '').replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '').trim();
}

/** What a needs-you card is about, from its server key: the same words the
 *  desktop's pills use ("Reply", "Stopped", "Your answer"). */
export function needsYouCardLabel(row: Pick<InboxNotification, 'needsYouKey'>): string {
  const key = row.needsYouKey ?? '';
  if (key.startsWith('calendar:')) return 'Meeting · reply needed';
  if (key.startsWith('flow:')) return 'Flow · stopped';
  if (/^(session|task|checkin|workflow):/.test(key)) return 'Clem · your answer';
  return 'Update · needs you';
}

export function notificationLabel(row: Pick<InboxNotification, 'kind' | 'needsAttention' | 'read' | 'approvalOutcome' | 'approvalOutcomeLabel'>): string {
  if (row.needsAttention && !row.read) return 'Clem needs you';
  switch (row.kind) {
    case 'workflow': return 'Flow';
    case 'cron': return 'Scheduled update';
    // What became of the approval, from the daemon; "Handled" only meant opened.
    case 'approval': return row.approvalOutcome === 'waiting' ? 'Needs your OK' : row.approvalOutcomeLabel ?? 'Approval';
    case 'execution': return 'Work update';
    default: return 'Update';
  }
}

/**
 * The run an Inbox row opens — the SAME one the push for that row opens.
 *
 * `sessionId` is the originating CONVERSATION (a reply belongs there). For a
 * background task that is not the run: background-tasks.ts sets sessionId to
 * the chat that asked and runSessionId to `background:<id>`. "Open run" keyed
 * on sessionId therefore opened the origin transcript rendered as a run, while
 * the push for the same notification opened the actual run.
 *
 * This is deliberately the same preference order as pushTargetUrl in
 * src/runtime/notification-delivery.ts (runSessionId, then sessionId), so one
 * notification can only ever have one run destination. Null means this row is
 * about no run at all — and then no "Open run" affordance may be offered.
 */
export function notificationRunTarget(
  row: Pick<InboxNotification, 'context'>,
): string | null {
  const runSession = row.context.runSessionId;
  if (typeof runSession === 'string' && runSession.trim()) return runSession;
  const session = row.context.sessionId;
  if (typeof session === 'string' && session.trim()) return session;
  return null;
}

/** Workflow reports need not have a chat session. Review their existing saved
 * definition; a run ID alone never invents a chat destination or grants work. */
export function notificationWorkflowHref(
  row: Pick<InboxNotification, 'needsYouKey' | 'lifecycle'>,
  canonical?: Pick<AttentionItem, 'key' | 'workflowSlug' | 'lifecycle'>,
): string | null {
  const key = row.needsYouKey;
  if (!key?.startsWith('flow:')) return null;
  const exact = canonical?.key === key && canonical.lifecycle.generation === row.lifecycle?.generation
    ? canonical.workflowSlug : undefined;
  const slug = exact ?? key.slice('flow:'.length);
  return WORKFLOW_WIDGET_SLUG.test(slug) ? mobileWorkflowPath(slug) : null;
}

export function notificationDedupeKey(row: InboxNotification): string {
  // A title or workflow name is presentation, not identity: one workflow can
  // have two unrelated blockers with the same generic title. The server now
  // owns the identity (dashboard/needs-you.ts `needsYouKey`: a stopped
  // workflow, a calendar item, a chat run) and counts by it; a daemon that
  // does not send one leaves each row on its own.
  return row.needsYouKey ?? `notification:${row.id}`;
}

export function trustScopeSummary(scope: {
  recipients: readonly string[];
  domains: readonly string[];
}): string {
  const sections: string[] = [];
  if (scope.recipients.length > 0) {
    sections.push(`exact recipients ${scope.recipients.join(', ')}`);
  }
  if (scope.domains.length > 0) {
    sections.push(`anyone at ${scope.domains.join(', ')}`);
  }
  return sections.join('; ') || 'this exact scope';
}

/** A proactive digest that merely repeats still-open approval cards is
 * navigation context, not another decision. */
export function notificationIsRepresentedByApprovals(
  row: Pick<InboxNotification, 'context'>,
  activeApprovalIds: ReadonlySet<string>,
): boolean {
  const related = row.context.relatedApprovalIds ?? [];
  return related.length > 0 && related.every((id) => activeApprovalIds.has(id));
}

export function collapseAttentionNotifications(rows: InboxNotification[]): Array<{
  row: InboxNotification;
  earlier: number;
  reports: InboxNotification[];
}> {
  return groupAttentionReports(rows, row => ({ id: row.id, attentionKey: row.needsYouKey,
    generation: row.lifecycle?.generation })).map(group => ({ row: group.reports[0], earlier: group.reports.length - 1, reports: group.reports }));
}

// ─── clearing ──────────────────────────────────────────────────────────────
//
// "I don't see the ability to clear certain things." — the owner, 2026-09-06,
// with 200 of 200 notifications unread on his machine. Nothing had ever marked
// one read and the phone offered no verb that scaled, so the count could only
// grow, and the app read as an accusation.
//
// The two rules these functions exist to hold:
//   CLEARING IS NOT DECIDING. A cleared row is marked read. It approves,
//   rejects, and answers nothing.
//   NEVER CLEAR WHAT THE USER HAS NOT SEEN. The scope is a list of exact ids
//   taken from the rows on screen, and it names its own size out loud.

/** A row a clear could touch. Structural, so callers can pass the feed. */
export type ClearableRow = Pick<InboxNotification, 'id' | 'read' | 'needsAttention'>
  & Partial<Pick<InboxNotification, 'workflowCapability'>>;

export interface ClearScope {
  /** The exact rows this clear will mark read — never a filter, never "all". */
  ids: string[];
  count: number;
  /** The button's own words, naming the size so the tap can't surprise. */
  label: string;
}

/**
 * What a bulk clear on the Updates tab would touch.
 *
 * Two rows are held back even when a caller passes the whole feed, so the
 * safety does not depend on the caller's filter being right:
 *  - anything still flagged as needing the user, which is a DECISION and must
 *    be answered or dismissed one at a time, with its consequences on screen;
 *  - a workflow capability gate, which is the only exact chooser for a parked
 *    run and is retired by that run, not by a tap (the daemon refuses it too).
 */
export function updatesClearScope(rows: readonly ClearableRow[]): ClearScope {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.read || row.needsAttention || row.workflowCapability) continue;
    ids.push(row.id);
  }
  return {
    ids,
    count: ids.length,
    label: `Clear ${ids.length} update${ids.length === 1 ? '' : 's'}`,
  };
}

/**
 * Show a row as read before the daemon has said so.
 *
 * Optimistic because it is reversible: marking read changes presentation only,
 * and if the request fails the caller drops the id and the row comes straight
 * back. Returns the SAME array when nothing applies, so an unrelated refresh
 * cannot churn the list.
 */
export function applyLocalReads<T extends { id: string; read: boolean }>(
  rows: readonly T[],
  clearedIds: ReadonlySet<string>,
): T[] {
  if (clearedIds.size === 0) return rows as T[];
  let touched = false;
  const next = rows.map((row) => {
    if (row.read || !clearedIds.has(row.id)) return row;
    touched = true;
    return { ...row, read: true };
  });
  return touched ? next : (rows as T[]);
}

/** Why the daemon left one row alone. Mirrors NotificationReadHeldReason. */
export type ClearHeldReason = 'awaiting_you' | 'capability_gate' | 'not_found';

/**
 * What to tell the user after a clear — the counts the daemon actually
 * reported, never the count that was asked for. A held-back row is named
 * rather than swallowed: that is the difference between clearing and deciding.
 *
 * EACH REASON GETS ITS OWN SENTENCE, because they are not the same fact and a
 * receipt that blurs them renders a falsehood. The first version said "N still
 * need an answer, so they stayed in Needs you" about every held row, which was
 * wrong two ways: a `not_found` row is one that no longer exists — calling it
 * an answer the user owes is inventing an obligation — and an `awaiting_you`
 * row is, by construction, one the phone was showing on UPDATES (the scope
 * filter and the daemon floor use different predicates, and the held set is
 * exactly where they disagree), so naming a tab it is not on sends the user
 * looking in the wrong place. Nothing here names a tab.
 */
export function clearReceipt(result: {
  clearedCount: number;
  heldCount: number;
  held?: ReadonlyArray<{ reason: ClearHeldReason }>;
}): string {
  const { clearedCount, heldCount } = result;
  const counts = { awaiting_you: 0, capability_gate: 0, not_found: 0 };
  for (const row of result.held ?? []) {
    if (row.reason in counts) counts[row.reason] += 1;
  }
  // A caller that reports a heldCount without the reasons still gets a true
  // sentence: "kept" claims only that they were not cleared.
  const unattributed = Math.max(0, heldCount - (counts.awaiting_you + counts.capability_gate + counts.not_found));
  const held: string[] = [];
  if (counts.awaiting_you > 0) {
    held.push(counts.awaiting_you === 1
      ? '1 still needs an answer, so it stayed unread.'
      : `${counts.awaiting_you} still need an answer, so they stayed unread.`);
  }
  if (counts.capability_gate > 0) {
    held.push(counts.capability_gate === 1
      ? '1 is waiting on an account choice, so it stayed unread.'
      : `${counts.capability_gate} are waiting on an account choice, so they stayed unread.`);
  }
  if (counts.not_found > 0) {
    held.push(counts.not_found === 1
      ? '1 was already gone.'
      : `${counts.not_found} were already gone.`);
  }
  if (unattributed > 0) {
    held.push(unattributed === 1 ? '1 was kept.' : `${unattributed} were kept.`);
  }
  const heldText = held.join(' ');
  if (clearedCount === 0) {
    return heldCount > 0 ? `Nothing was cleared. ${heldText}` : 'Those updates were already read.';
  }
  const cleared = `Cleared ${clearedCount} update${clearedCount === 1 ? '' : 's'}.`;
  return heldCount > 0
    ? `${cleared} ${heldText}`
    : `${cleared} Nothing was decided — they stay in your history.`;
}

/**
 * How a workspace choice renders on a phone. Up to three existing Workspaces
 * are buttons the thumb can tell apart; more than that is a picker, because a
 * stack of ten full-width orange buttons (live 09-26) is a wall, not a choice.
 * "Prepare a new one" is always its own button.
 */
export function workspaceChoiceLayout(choices: ReadonlyArray<{ kind: string }>): 'buttons' | 'picker' {
  return choices.filter((choice) => choice.kind === 'existing').length > 3 ? 'picker' : 'buttons';
}

/** The Workspace's name alone; the identifier is a caption, never part of the title. */
export function workspaceChoiceTitle(choice: { label: string; workspaceId: string }): string {
  const label = choice.label.trim();
  const suffix = ` (${choice.workspaceId})`;
  return label.endsWith(suffix) ? label.slice(0, -suffix.length).trim() : label;
}
