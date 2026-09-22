/**
 * An approval card is read by a person: what will happen, to whom or where,
 * through which app — never the carrier envelope. Live 2026-09-22: a chat
 * send showed the work_call envelope (a cap:resolved requirement id, the
 * carrier name and an escaped args_json string) as its details. The carriers (work_call, composio_execute_tool) are unwrapped
 * here, once, for desktop and mobile alike; the raw arguments stay available
 * behind a disclosure.
 */
import { registeredToolkitOfSlug } from '../integrations/composio/toolkit-slug.js';

export interface ApprovalDetailLine {
  label: string;
  value: string;
  /** Long text: render as a paragraph, not an inline value. */
  long: boolean;
}

export interface ApprovalPresentation {
  /** "Send a message via Slack", "Write a file", … */
  action: string;
  app?: string;
  operation?: string;
  details: ApprovalDetailLine[];
  /** True when the details are the provider arguments (unwrapped), not a carrier envelope. */
  unwrapped: boolean;
}

const MAX_LINES = 14;
const MAX_VALUE_CHARS = 4_000;

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch { return text; }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Peel carriers until the provider-facing call is reached. */
export function unwrapApprovalCall(tool: string | null | undefined, args: unknown): { tool: string; operation?: string; args: unknown; unwrapped: boolean } {
  let name = (tool ?? '').trim();
  let current = parseJson(args);
  let unwrapped = false;
  for (let depth = 0; depth < 4; depth++) {
    const record = asRecord(current);
    if (!record) break;
    const tail = name.split('__').at(-1) ?? name;
    if (tail === 'work_call' && typeof record.name === 'string') {
      name = record.name;
      current = parseJson(record.args_json ?? record.args);
      unwrapped = true;
      continue;
    }
    if (tail === 'composio_execute_tool' && typeof record.tool_slug === 'string') {
      const inner = parseJson(record.arguments);
      return { tool: name, operation: record.tool_slug, args: inner ?? {}, unwrapped: true };
    }
    break;
  }
  return { tool: name, args: current, unwrapped };
}

function words(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function appLabel(operation: string | undefined, tool: string): string | undefined {
  if (operation) {
    const toolkit = registeredToolkitOfSlug(operation.toUpperCase()).trim();
    if (toolkit) return capitalize(toolkit.toLowerCase());
  }
  return undefined;
}

/** A provider id such as `<APP>_SEND_MESSAGE` → "send message"; "write_file" → "write file". */
function operationPhrase(operation: string | undefined, tool: string, app: string | undefined): string {
  const source = operation ?? tool.split('__').at(-1) ?? tool;
  let phrase = words(source);
  if (app) {
    const prefix = app.toLowerCase();
    if (phrase.startsWith(`${prefix} `)) phrase = phrase.slice(prefix.length + 1);
  }
  return phrase;
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
    return value.map((item) => (item === null ? '' : String(item))).filter(Boolean).join(', ');
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function detailLinesFor(args: unknown): ApprovalDetailLine[] {
  const record = asRecord(args);
  if (!record) {
    const text = valueText(args);
    return text ? [{ label: 'Details', value: text.slice(0, MAX_VALUE_CHARS), long: text.length > 120 }] : [];
  }
  const lines: ApprovalDetailLine[] = [];
  for (const [key, raw] of Object.entries(record)) {
    if (lines.length >= MAX_LINES) break;
    const text = valueText(raw);
    if (!text) continue;
    const clipped = text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
    lines.push({ label: capitalize(words(key)), value: clipped, long: clipped.length > 120 || clipped.includes('\n') });
  }
  // The message itself reads best last and in full.
  lines.sort((a, b) => Number(a.long) - Number(b.long));
  return lines;
}

export function presentApprovalForHumans(input: { tool?: string | null; args?: unknown; subject?: string }): ApprovalPresentation {
  const call = unwrapApprovalCall(input.tool, input.args);
  const app = appLabel(call.operation, call.tool);
  const phrase = operationPhrase(call.operation, call.tool, app);
  const action = capitalize(app ? `${phrase} via ${app}` : phrase || (input.subject ?? 'approve this action'));
  return {
    action,
    ...(app ? { app } : {}),
    ...(call.operation ? { operation: call.operation } : {}),
    details: detailLinesFor(call.args),
    unwrapped: call.unwrapped,
  };
}
