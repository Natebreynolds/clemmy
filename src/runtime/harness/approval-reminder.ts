/**
 * One reminder for an approval nobody has answered.
 *
 * A formal approval card pauses work until the owner decides, and its notice
 * goes out once, when the card is raised. Nothing brought it back after that.
 * Live 2026-09-25: a card for a time-sensitive message was raised, its
 * channel copies were held back for 56 minutes because chat views were open,
 * the notice went unread, and the message missed its moment. Across the live
 * registry, 154 of 173 approvals were answered within 30 minutes; the rest
 * waited hours or days.
 *
 * So a formal approval still pending and actionable 30 minutes after it was
 * requested gets exactly one reminder, carrying what the card shows and how
 * long it has waited. The approval row records that the reminder went out, so
 * neither a restart nor a pruned notification can send a second one.
 *
 * Where it goes: the code cannot tell which surface the owner used most
 * recently. Desktop chat input records no surface, and the live-viewer ledger
 * counts any open chat view as "present", which is exactly what held the live
 * notice back. So the reminder takes the routes the original notice took (the
 * destinations it named, then the configured, fallback and desktop routes
 * every notice resolves), and the delivery worker neither holds it behind
 * that presence signal nor lets a still-held original copy follow it.
 *
 * A deadline written inside the request is not read here: only a model can
 * decide what the text means, so this reminder is time-based.
 */

import pino from 'pino';
import * as approvalRegistry from './approval-registry.js';
import { approvalCallPreview, type ApprovalCallPreview } from './approval-call-preview.js';
import { listEvents } from './eventlog.js';
import { pendingActionApprovalViewFromArgs } from './pending-action-view.js';
import { approvalPreviewProjection } from './public-presentation.js';
import { activeHomeSnoozes } from '../home-snoozes.js';
import {
  addNotification,
  EXPLICIT_DESTINATION_METADATA_KEYS,
  loadNotifications,
  type NotificationRecord,
} from '../notifications.js';

const logger = pino({ name: 'clementine-next.approval-reminder' });

/** An unanswered formal approval is reminded once, this long after it was requested. */
export const APPROVAL_REMINDER_AFTER_MS = 30 * 60_000;

const REMINDER_MAX_FIELDS = 6;
const REMINDER_FIELD_MAX_CHARS = 240;
const REMINDER_TITLE_MAX_CHARS = 120;
const REMINDER_BODY_MAX_CHARS = 1_400;

/** The stable notification id of an approval's one reminder. A retry after a
 * crash between sending and recording reuses it, so it never lands twice. */
export function approvalReminderNotificationId(approvalId: string): string {
  return `approval-reminder-${approvalId}`;
}

/** What the original notice said the approval belongs to, for display. */
const ORIGINAL_CONTEXT_KEYS = ['workflowName', 'stepId'] as const;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** "markdown_text" → "Markdown text": an argument name as a label. */
function fieldLabel(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : name;
}

/** "31 minutes", "1 hour", "5 hours": how long the card has waited. */
export function waitedPhrase(waitedMs: number): string {
  const minutes = Math.max(1, Math.round(waitedMs / 60_000));
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * What the card shows: first the preview the host attached to the card when
 * it was raised (it names the ids it shows), then a queued action's own view,
 * then a fresh preview of the exact frozen call the row holds.
 */
function cardPreview(row: approvalRegistry.PendingApprovalRow): ApprovalCallPreview | null {
  try {
    const cards = listEvents(row.sessionId, { types: ['approval_requested'] });
    for (let index = cards.length - 1; index >= 0; index -= 1) {
      const data = cards[index]!.data as Record<string, unknown>;
      if (data.approvalId !== row.approvalId) continue;
      const shown = approvalPreviewProjection(data.preview);
      if (shown) return shown.preview;
      break;
    }
  } catch { /* the registry row below still describes the call */ }
  try {
    const action = pendingActionApprovalViewFromArgs(row.args);
    if (action) {
      const fields = [
        { name: 'target', value: action.targetSummary },
        { name: 'preview', value: action.preview },
      ].filter((field) => typeof field.value === 'string' && field.value.trim());
      return { operation: clip(oneLine(action.title || row.subject), 80), fields };
    }
  } catch { /* fall through to the frozen call */ }
  if (!row.tool) return null;
  try {
    return approvalCallPreview({ toolName: row.tool, args: row.args, rawArgs: '' });
  } catch {
    return null;
  }
}

/** The reminder's words: what is waiting, for how long, and what it holds.
 * The headline is the card's own header (its subject); the preview's fields
 * are what the card lists under it. */
export function approvalReminderCopy(input: {
  subject: string;
  preview: ApprovalCallPreview | null;
  waitedMs: number;
}): { title: string; body: string } {
  const operation = oneLine(input.preview?.operation ?? '');
  const headline = oneLine(input.subject) || operation || 'an approval';
  const title = clip(`Still waiting on you: ${headline}`, REMINDER_TITLE_MAX_CHARS);
  const lines = [
    `Clem has been waiting ${waitedPhrase(input.waitedMs)} for your answer. Nothing happens until you decide.`,
  ];
  const fields = input.preview?.fields ?? [];
  const shown = fields.slice(0, REMINDER_MAX_FIELDS).map((field) => {
    const value = oneLine(field.value);
    const label = field.label ? oneLine(field.label) : '';
    return clip(`${fieldLabel(field.name)}: ${label ? `${label} (${value})` : value}`, REMINDER_FIELD_MAX_CHARS);
  });
  if (shown.length > 0) {
    lines.push('', ...shown);
    if (fields.length > shown.length) lines.push(`…and ${fields.length - shown.length} more`);
  } else if (operation && operation !== headline) {
    lines.push('', clip(operation, REMINDER_FIELD_MAX_CHARS));
  }
  return { title, body: clip(lines.join('\n'), REMINDER_BODY_MAX_CHARS) };
}

/** The notice first raised for this approval, if it is still in the store. */
function originalNotices(approvalIds: ReadonlySet<string>): Map<string, NotificationRecord> {
  const found = new Map<string, NotificationRecord>();
  for (const item of loadNotifications()) {
    const approvalId = item.metadata?.approvalId;
    if (
      item.kind !== 'approval'
      || typeof approvalId !== 'string'
      || !approvalIds.has(approvalId)
      || item.metadata?.approvalReminder === true
    ) continue;
    const prior = found.get(approvalId);
    // The host's own card notice uses `approval-<id>`; prefer it over copies.
    if (!prior || item.id === `approval-${approvalId}`) found.set(approvalId, item);
  }
  return found;
}

function carriedMetadata(original: NotificationRecord | undefined): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  // The destinations the original named, so the reminder reaches the same
  // places, and what it said the approval belongs to.
  for (const key of [...EXPLICIT_DESTINATION_METADATA_KEYS, ...ORIGINAL_CONTEXT_KEYS]) {
    const value = original?.metadata?.[key];
    if (typeof value === 'string' && value.trim()) carried[key] = value;
  }
  return carried;
}

/**
 * Send the one reminder for every formal approval that is due. Called from
 * the approval reaper's periodic sweep (and its boot sweep), after expiry has
 * settled, so an expired or closed approval is never reminded. Returns the
 * approvals reminded by this pass.
 */
export function remindUnansweredApprovals(
  options: { now?: Date } = {},
): approvalRegistry.PendingApprovalRow[] {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  // Past the urgent window an ask no longer counts as urgent anywhere
  // (isApprovalStaleForHeader), so it is not re-raised either. This also
  // keeps a long-idle daemon from waking to a burst of old reminders.
  const due = approvalRegistry.listPendingAwaitingReminder(
    new Date(nowMs - APPROVAL_REMINDER_AFTER_MS),
    now,
  ).filter((row) => (
    // A conversational consent question is owned by its chat thread; a
    // reminder card would bypass the exact reply it waits for.
    approvalRegistry.isFormalApprovalSurface(row)
    && approvalRegistry.isActionable(row, now)
    && !approvalRegistry.isApprovalStaleForHeader(row, { now })
  ));
  if (due.length === 0) return [];

  // "Not now" is the owner's answer about timing: the reminder waits until
  // the snooze ends, and still goes out only once.
  let snoozed = new Map<string, string>();
  try { snoozed = activeHomeSnoozes(nowMs); } catch { /* unreadable: nothing is snoozed */ }
  const eligible = due.filter((row) => !snoozed.has(`approval:${row.approvalId}`));
  if (eligible.length === 0) return [];

  let originals = new Map<string, NotificationRecord>();
  try {
    originals = originalNotices(new Set(eligible.map((row) => row.approvalId)));
  } catch { /* no original routes: configured destinations still apply */ }

  const reminded: approvalRegistry.PendingApprovalRow[] = [];
  for (const row of eligible) {
    const waitedMs = Math.max(0, nowMs - Date.parse(row.requestedAt));
    try {
      const copy = approvalReminderCopy({ subject: row.subject, preview: cardPreview(row), waitedMs });
      addNotification({
        id: approvalReminderNotificationId(row.approvalId),
        kind: 'approval',
        title: copy.title,
        body: copy.body,
        createdAt: now.toISOString(),
        read: false,
        metadata: {
          ...carriedMetadata(originals.get(row.approvalId)),
          approvalId: row.approvalId,
          sessionId: row.sessionId,
          tool: row.tool,
          approvalReminder: true,
          requestedAt: row.requestedAt,
          waitedMinutes: Math.round(waitedMs / 60_000),
        },
      });
    } catch (err) {
      // Not recorded, so the next sweep retries under the same stable id.
      logger.warn(
        { err: err instanceof Error ? err.message : err, approvalId: row.approvalId },
        'approval reminder could not be written; retrying next sweep',
      );
      continue;
    }
    if (approvalRegistry.markApprovalReminded(row.approvalId, now)) {
      reminded.push({ ...row, remindedAt: now.toISOString() });
    }
  }
  return reminded;
}
