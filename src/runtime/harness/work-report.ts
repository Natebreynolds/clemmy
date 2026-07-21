/**
 * ALWAYS REPORT BACK (northstar). When a turn does real work but the model emits no
 * reply text, the user must still learn what happened — never a silent
 * "(Finished without a written reply.)". This synthesizes an honest, human report
 * from the durable `external_write` events the turn recorded.
 *
 * Effect-anchored + GENERAL: the description keys off the write's shapeKey/slug
 * (SEND / CREATE / UPDATE / …), never a specific tool name, so it covers email, chat,
 * SMS, CRM, files — anything. A pure ack (no writes) reports nothing (returns null),
 * so we don't fabricate a report where there is genuinely nothing to say.
 */
import type { EventRow } from './eventlog.js';

/** Humanize ONE recorded external write into a report line. */
export function describeExternalWrite(shapeKey: string | undefined, toolName: string, targets: string[]): string {
  const key = (shapeKey || toolName || 'action').toUpperCase();
  const to = targets.length
    ? ` to ${targets.slice(0, 5).join(', ')}${targets.length > 5 ? ` (+${targets.length - 5} more)` : ''}`
    : '';
  if (/DRAFT/.test(key) && !/SEND|PUBLISH/.test(key)) return `Created a draft${to}`;
  if (/SEND|EMAIL|DELIVER|DISPATCH|DM\b|MESSAGE|SMS|TEXT/.test(key)) return `Sent a message${to}`;
  if (/PUBLISH|POST|TWEET/.test(key)) return `Published a post${to}`;
  if (/CREATE|ADD|INSERT|UPSERT/.test(key)) return `Created a record${to}`;
  if (/UPDATE|PATCH|EDIT|MODIFY|SET_/.test(key)) return `Updated a record${to}`;
  if (/DELETE|REMOVE|ARCHIVE|TRASH/.test(key)) return `Deleted a record${to}`;
  if (/UPLOAD|SAVE|WRITE/.test(key)) return `Saved a file${to}`;
  return `Ran ${key.toLowerCase().replace(/_/g, ' ')}${to}`;
}

/**
 * Build a report from a list of external_write events (the caller scopes them to the
 * current turn/run). Returns null when there is nothing durable to report.
 */
export function synthesizeWorkReport(writes: readonly EventRow[]): string | null {
  if (!writes || writes.length === 0) return null;
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const w of writes) {
    const d = (w.data ?? {}) as { shapeKey?: string; toolName?: string; targets?: unknown };
    const targets = Array.isArray(d.targets) ? d.targets.filter((t): t is string => typeof t === 'string') : [];
    const line = `• ${describeExternalWrite(d.shapeKey, d.toolName ?? '', targets)}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  if (lines.length === 0) return null;
  return `I finished — here's what I did this turn:\n${lines.join('\n')}`;
}
