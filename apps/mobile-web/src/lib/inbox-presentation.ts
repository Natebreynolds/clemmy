import type { ApprovalRow, InboxNotification } from './api';

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

export function approvalDetails(row: Pick<ApprovalRow, 'args'>): ApprovalDetailRow[] {
  if (!row.args || typeof row.args !== 'object' || Array.isArray(row.args)) {
    const value = displayValue(row.args);
    return value === '—' ? [] : [{ label: 'Details', value, long: value.length > 100 }];
  }
  const args = row.args as Record<string, unknown>;
  const keys: string[] = [];
  let omitted = false;
  for (const key in args) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
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
  if (omitted) rows.push({
    label: 'Additional fields',
    value: 'Additional details omitted on mobile. Review the full approval on the desktop if needed.',
    long: true,
  });
  return rows;
}

export function notificationLabel(row: Pick<InboxNotification, 'kind' | 'needsAttention' | 'read'>): string {
  if (row.needsAttention && !row.read) return 'Clem needs you';
  switch (row.kind) {
    case 'workflow': return 'Flow';
    case 'cron': return 'Scheduled update';
    case 'approval': return row.read ? 'Handled' : 'Approval';
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

export function notificationDedupeKey(row: InboxNotification): string {
  // A title or workflow name is presentation, not identity: one workflow can
  // have two unrelated blockers with the same generic title. Until a durable
  // server-owned issue key exists, the exact notification id is the only safe
  // collapse/dismiss boundary.
  return `notification:${row.id}`;
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
}> {
  const seen = new Map<string, { row: InboxNotification; earlier: number }>();
  for (const row of rows) {
    const key = notificationDedupeKey(row);
    const existing = seen.get(key);
    if (existing) existing.earlier += 1;
    else seen.set(key, { row, earlier: 0 });
  }
  return [...seen.values()];
}
