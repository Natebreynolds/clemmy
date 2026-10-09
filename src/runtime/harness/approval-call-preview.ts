import { scanSecrets } from './guardrails.js';
import { isPlainOrClementineLocalTool } from './runtime-tool-identity.js';
import type { InterruptionInfo } from './loop.js';
import { LocalFileSendRefusal, describeLocalFileToSend, looksLikeLocalFilePath, resolveLocalFileToSend } from '../local-file-sending.js';

/**
 * What an approval shows a person: the operation and the exact arguments it
 * would send. Also the small display helpers approval cards share.
 */

const APPROVAL_DISPLAY_JSON_MAX_CHARS = 256_000;

export function approvalJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > APPROVAL_DISPLAY_JSON_MAX_CHARS
  ) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}


/** How a card names the file(s) an argument would send from this computer;
 * undefined when the argument names no local file. A file that cannot be
 * sent says why. */
export function approvalFileLabel(raw: unknown): string | undefined {
  const paths = typeof raw === 'string' ? [raw]
    : Array.isArray(raw) && raw.length > 0 && raw.every((item) => typeof item === 'string') ? raw as string[]
      : [];
  const local = paths.filter((item) => looksLikeLocalFilePath(item));
  if (local.length === 0 || local.length !== paths.length) return undefined;
  return local.map((item) => {
    try {
      return describeLocalFileToSend(resolveLocalFileToSend(item));
    } catch (error) {
      const reason = error instanceof LocalFileSendRefusal ? error.message : 'it cannot be read';
      return `cannot be sent: ${reason}`;
    }
  }).join('; ');
}

export interface ApprovalCallPreview {
  operation: string;
  fields: Array<{ name: string; value: string; label?: string }>;
  /** Exact prepared members; display only, never approval authority. */
  items?: ApprovalCallPreview[];
  /** The pre-send check against the owner's standing rules, when one ran. */
  check?: { status: 'clear' | 'conflicts' | 'unavailable'; conflicts?: string[] };
  /** The card in Clem's words (the checker wrote them): her question to the
   *  owner and why a yes is needed. Display only. */
  ask?: string;
  why?: string;
}

const APPROVAL_PREVIEW_MAX_FIELDS = 16;
const APPROVAL_PREVIEW_TEXT_MAX_CHARS = 2_000;
const APPROVAL_PREVIEW_STRUCTURED_MAX_CHARS = 600;

function approvalPreviewValue(value: unknown, complete = false): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    return !complete && text.length > APPROVAL_PREVIEW_TEXT_MAX_CHARS
      ? `${text.slice(0, APPROVAL_PREVIEW_TEXT_MAX_CHARS)}… (${text.length - APPROVAL_PREVIEW_TEXT_MAX_CHARS} more characters)`
      : text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return null;
  try {
    const json = JSON.stringify(value);
    if (!json || json === '{}' || json === '[]') return null;
    return !complete && json.length > APPROVAL_PREVIEW_STRUCTURED_MAX_CHARS
      ? `${json.slice(0, APPROVAL_PREVIEW_STRUCTURED_MAX_CHARS)}…`
      : json;
  } catch {
    return null;
  }
}

/**
 * What an approval would actually do, from the exact frozen arguments the
 * registry holds: the operation and each argument the provider receives, so
 * the owner approves the content itself, never an operation's name alone.
 * Display only: authority and resume keep pinning the untouched arguments,
 * and a value that looks like a secret is withheld.
 */
export function approvalCallPreview(info: InterruptionInfo, unwrapWorkCall = true, complete = false): ApprovalCallPreview | null {
  const args = (info.args ?? {}) as Record<string, unknown>;
  // Both carriers hold the real call as { name, args_json }: work_call for
  // planned work, call_tool for a schema-on-demand (MCP) operation.
  if (unwrapWorkCall && (
    isPlainOrClementineLocalTool(info.toolName, 'work_call')
    || isPlainOrClementineLocalTool(info.toolName, 'call_tool')
  )) {
    const targetName = typeof args.name === 'string' ? args.name.trim() : '';
    const targetArgs = approvalJsonRecord(args.args_json);
    return targetName && targetArgs
      ? approvalCallPreview({ ...info, toolName: targetName, args: targetArgs }, false, complete)
      : null;
  }
  const slug = typeof args.tool_slug === 'string' ? args.tool_slug.trim() : '';
  const operation = truncate((slug ? humanizeComposioSlug(slug) : '') || info.toolName, 80);
  const provider = slug ? approvalJsonRecord(args.arguments) ?? {} : args;
  const fields: ApprovalCallPreview['fields'] = [];
  for (const [name, raw] of Object.entries(provider)) {
    if (!complete && fields.length >= APPROVAL_PREVIEW_MAX_FIELDS) break;
    const value = approvalPreviewValue(raw, complete);
    if (value === null) continue;
    const secret = scanSecrets(value).length > 0;
    // A file on this computer is named exactly (name, size, folder), so the
    // owner sees which file leaves before saying yes.
    const label = secret ? undefined : approvalFileLabel(raw) ?? info.previewLabels?.[value];
    fields.push({
      name: truncate(name, 80),
      value: secret ? '[withheld: looks like a secret]' : value,
      ...(label ? { label: truncate(label, 300) } : {}),
    });
  }
  return {
    operation,
    fields,
    ...(info.previewCheck
      ? {
          check: {
            status: info.previewCheck.status,
            ...(info.previewCheck.conflicts?.length ? { conflicts: [...info.previewCheck.conflicts] } : {}),
          },
          ...(info.previewCheck.ask ? { ask: info.previewCheck.ask } : {}),
          ...(info.previewCheck.why ? { why: info.previewCheck.why } : {}),
        }
      : {}),
  };
}

/**
 * Turn a Composio slug shaped `<TOOLKIT>_<OBJECT>_<VERB>_<OBJECT>` into a
 * human phrase: "Create Outlook calendar event".
 *
 * Heuristic: known toolkit prefixes are capitalized; known verbs are
 * moved to the front; the rest is title-cased.
 */
export function humanizeComposioSlug(slug: string): string {
  if (!slug) return '';
  const parts = slug.split('_').filter(Boolean).map((p) => p.toLowerCase());
  if (parts.length === 0) return '';

  const TOOLKITS: Record<string, string> = {
    outlook: 'Outlook', gmail: 'Gmail', slack: 'Slack', instagram: 'Instagram',
    salesforce: 'Salesforce', github: 'GitHub', linear: 'Linear', notion: 'Notion',
    trello: 'Trello', supabase: 'Supabase', stripe: 'Stripe', composio: 'Composio',
    discord: 'Discord', google: 'Google', drive: 'Drive', calendar: 'Calendar',
    sheets: 'Sheets', figma: 'Figma',
  };
  const VERBS = new Set([
    'create', 'list', 'get', 'search', 'update', 'delete', 'send', 'post',
    'fetch', 'read', 'write', 'add', 'remove', 'find', 'query', 'sync',
    'invite', 'cancel', 'archive', 'star', 'unstar', 'reply',
  ]);

  const toolkit = parts[0];
  const toolkitLabel = TOOLKITS[toolkit] ?? toolkit[0].toUpperCase() + toolkit.slice(1);

  // Find the first verb in the slug; treat everything after as the object.
  let verbIndex = -1;
  for (let i = 1; i < parts.length; i += 1) {
    if (VERBS.has(parts[i])) { verbIndex = i; break; }
  }
  if (verbIndex === -1) {
    return [toolkitLabel, ...parts.slice(1)].join(' ');
  }
  const verb = parts[verbIndex][0].toUpperCase() + parts[verbIndex].slice(1);
  const object = parts.slice(1, verbIndex).concat(parts.slice(verbIndex + 1)).join(' ');
  return object ? `${verb} ${toolkitLabel} ${object}` : `${verb} ${toolkitLabel}`;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

/**
 * EDIT BY HAND. The card shows the call's fields (`approvalCallPreview`); the
 * owner may retype one before saying yes. Apply those edits back onto the
 * exact stored arguments along the same unwrapping the preview used — a
 * work_call/call_tool carrier's `args_json`, then a Composio `arguments`
 * JSON string — so what runs is exactly what the card showed, edited. Only
 * fields the preview showed can be edited; unknown names are refused.
 */
export function approvalArgsWithFieldEdits(
  args: Record<string, unknown> | null | undefined,
  edits: Record<string, string>,
): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  const names = Object.keys(edits);
  if (names.length === 0) return { ok: false, reason: 'no fields were edited' };
  const base = (args ?? {}) as Record<string, unknown>;
  const carrier = typeof base.name === 'string' && typeof base.args_json === 'string';
  const target = carrier ? approvalJsonRecord(base.args_json) : { ...base };
  if (!target) return { ok: false, reason: 'the stored call could not be read' };
  const slug = typeof target.tool_slug === 'string' ? target.tool_slug.trim() : '';
  const provider = slug ? approvalJsonRecord(target.arguments) : target;
  if (!provider) return { ok: false, reason: 'the stored call could not be read' };
  for (const name of names) {
    if (!(name in provider)) return { ok: false, reason: `"${name}" is not a field of this call` };
    if (typeof provider[name] !== 'string' && typeof provider[name] !== 'number' && typeof provider[name] !== 'boolean') {
      return { ok: false, reason: `"${name}" is not a plain value and cannot be edited here` };
    }
    provider[name] = edits[name];
  }
  if (slug) {
    const rebuilt = { ...target, arguments: JSON.stringify(provider) };
    return { ok: true, args: carrier ? { ...base, args_json: JSON.stringify(rebuilt) } : rebuilt };
  }
  return { ok: true, args: carrier ? { ...base, args_json: JSON.stringify(provider) } : provider };
}
