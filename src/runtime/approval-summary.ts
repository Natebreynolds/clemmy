import type { PendingApproval } from '../types.js';
import { listEvents as listHarnessEvents } from './harness/eventlog.js';

/**
 * Build a short human-readable description of what a pending approval
 * actually does. Without this, the Discord approval card shows only
 * "Approval <uuid> for run_shell_command" — a meaningless string of hex
 * that gives the user no idea what they're approving.
 *
 * Reads the toolCall arguments from `approval.state` and renders a
 * per-tool preview. The dashboard sidebar and Discord both call this
 * so the message is consistent everywhere.
 */
export function summarizeApprovalAction(approval: PendingApproval): string {
  const args = extractToolArgs(approval);
  const tool = approval.toolName;
  if (!args) return `${tool} (no preview available)`;
  switch (tool) {
    case 'run_shell_command':
    case 'shell': {
      const command = pickString(args, ['command', 'cmd']);
      const cwd = pickString(args, ['cwd', 'workingDirectory']);
      const where = cwd ? ` in \`${trim(cwd, 80)}\`` : '';
      return command ? `\`${trim(command, 240)}\`${where}` : `${tool} (no command)`;
    }
    case 'write_file':
    case 'edit_file': {
      const file = pickString(args, ['file_path', 'path', 'filePath']);
      return file ? `write \`${trim(file, 200)}\`` : `${tool}`;
    }
    case 'composio_execute_tool': {
      const slug = pickString(args, ['tool_slug', 'slug']);
      const inner = renderNestedArgs(args.arguments);
      return slug ? `${slug}${inner ? ` ${inner}` : ''}` : `${tool}`;
    }
    case 'discord_channel_send':
    case 'send_message':
    case 'notify_user':
    case 'discord_dm': {
      const to = pickString(args, ['channelId', 'userId', 'channel', 'to']);
      const text = pickString(args, ['message', 'content', 'text', 'body']);
      return `to ${to || '(channel)'}: ${trim(text, 200)}`;
    }
    case 'send_email':
    case 'gmail_send':
    case 'outlook_send_email': {
      const to = pickString(args, ['to', 'recipient']);
      const subject = pickString(args, ['subject', 'title']);
      return `email \`${trim(to, 80)}\`: ${trim(subject, 160)}`;
    }
    case 'goal_create':
    case 'goal_update':
    case 'task_add':
    case 'task_update': {
      const title = pickString(args, ['title', 'description', 'text', 'name']);
      return title ? trim(title, 220) : `${tool}`;
    }
    case 'request_approval': {
      // v0.5.20 Bug J — render subject + reason + preview so the user
      // sees WHAT they are approving in the Discord card body, not
      // just the generic step name. Preview can be (a) provided
      // explicitly by the model via the `preview` arg, OR (b)
      // auto-enriched by the runtime from the session's recent
      // tool_returned events. The auto path means workflows + ad-hoc
      // approvals get content visibility without per-workflow edits
      // or relying on the model to remember to populate preview.
      const subject = pickString(args, ['subject']);
      const reason = pickString(args, ['reason']);
      const explicit = args.preview as ApprovalPreview | undefined | null;
      const preview = explicit ?? autoInferPreview(approval);
      const lines: string[] = [];
      if (subject) lines.push(trim(subject, 240));
      if (reason) lines.push(`_Why:_ ${trim(reason, 240)}`);
      if (preview) {
        const countStr = typeof preview.count === 'number' ? `**${preview.count} item${preview.count === 1 ? '' : 's'}**` : '';
        const samples = Array.isArray(preview.samples) ? preview.samples.slice(0, 5) : [];
        if (countStr || samples.length > 0) {
          lines.push('');
          if (countStr) lines.push(countStr);
          for (const s of samples) {
            const label = s?.label ? `**${trim(s.label, 30)}:**` : '•';
            const value = s?.value ? trim(s.value, 160) : '';
            const sec = s?.secondary ? ` _(${trim(s.secondary, 120)})_` : '';
            lines.push(`${label} ${value}${sec}`);
          }
          if (preview.inferred) {
            lines.push('_(auto-inferred from recent tool output)_');
          }
        }
      }
      return lines.length > 0 ? lines.join('\n') : `${tool}`;
    }
    default: {
      return trim(JSON.stringify(args), 260);
    }
  }
}

interface ToolCallEnvelope {
  arguments?: string | Record<string, unknown>;
}

function extractToolArgs(approval: PendingApproval): Record<string, unknown> | undefined {
  if (!approval.state) return undefined;
  try {
    const parsed = JSON.parse(approval.state) as { toolCall?: ToolCallEnvelope };
    const toolCall = parsed.toolCall;
    if (!toolCall) return undefined;
    if (typeof toolCall.arguments === 'string') {
      try {
        return JSON.parse(toolCall.arguments) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
    if (toolCall.arguments && typeof toolCall.arguments === 'object') {
      return toolCall.arguments as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Legibility for a workflow APPROVAL GATE (and, in unattended/yolo mode, the audit
 * stream). At gate time the step has not run, so there are no tool args to render —
 * but the step DEFINITION is the resolved action. Show what the step will DO (side
 * effect + tools + its instruction) so the approver sees the real action instead of
 * an opaque "approve step <id>". Same legibility, whether shown for a human to
 * approve (gated) or recorded as Clem acts (yolo). Reuses `trim`.
 */
export function describeWorkflowStepAction(step: {
  id: string;
  prompt?: string;
  intent?: string;
  sideEffect?: 'read' | 'write' | 'send';
  allowedTools?: string[];
}): string {
  const effect = step.sideEffect === 'send' ? 'SEND' : step.sideEffect === 'write' ? 'WRITE' : 'READ';
  const tools = (step.allowedTools ?? []).filter((t) => typeof t === 'string' && t.trim().length > 0);
  const toolsPart = tools.length > 0 ? ` via ${tools.slice(0, 6).join(', ')}${tools.length > 6 ? ', …' : ''}` : '';
  const instruction = (step.prompt ?? step.intent ?? '').replace(/\s+/g, ' ').trim();
  const instrPart = instruction ? ` — ${trim(instruction, 240)}` : '';
  return `${effect}${toolsPart}${instrPart}`;
}

function pickString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function renderNestedArgs(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      return trim(JSON.stringify(JSON.parse(raw)), 200);
    } catch {
      return trim(raw, 200);
    }
  }
  if (raw && typeof raw === 'object') {
    return trim(JSON.stringify(raw), 200);
  }
  return '';
}

function trim(input: string, max: number): string {
  const clean = input.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// ─────────────────────────────────────────────────────────────────
// Approval CONTENT preview (Slice 2) — when an approval publishes content
// (an IG/social post, an email), pull the draft BODY + IMAGE out of the tool
// args so the user reviews the actual post in the Approvals card, not a one-line
// "approve INSTAGRAM_CREATE_POST" summary. Best-effort + heuristic across tool
// arg shapes (incl. composio's nested `arguments`); returns undefined when there's
// no reviewable content. Never throws.
// ─────────────────────────────────────────────────────────────────

const CONTENT_BODY_KEYS = ['caption', 'body', 'text', 'message', 'content', 'post', 'html', 'description', 'status'];
const CONTENT_IMAGE_KEYS = [
  'image_url', 'imageUrl', 'media_url', 'mediaUrl', 'image', 'media', 'media_urls',
  'photo', 'thumbnail', 'thumbnail_url', 'attachment_url', 'picture', 'cover_url',
];

export interface ApprovalContentPreview {
  body?: string;
  imageUrl?: string;
}

function looksLikeImageUrl(s: string): boolean {
  const t = s.trim();
  if (/^data:image\//i.test(t)) return true;
  if (/^https?:\/\//i.test(t)) {
    return /\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)(\?|#|$)/i.test(t)
      || /(image|img|photo|media|cdn|imgur|cloudinary|unsplash|instagram|fbcdn|googleusercontent)/i.test(t);
  }
  return /^\/?[\w./-]+\.(png|jpe?g|gif|webp|bmp|svg|heic|avif)$/i.test(t); // local path
}

function pickLongestString(record: Record<string, unknown>, keys: string[]): string {
  let best = '';
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'string' && v.trim().length > best.length) best = v;
  }
  return best.trim();
}

function pickImageUrl(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'string' && looksLikeImageUrl(v)) return v.trim();
    if (Array.isArray(v)) {
      const first = v.find((x) => typeof x === 'string' && looksLikeImageUrl(x));
      if (typeof first === 'string') return first.trim();
    }
  }
  return '';
}

export function extractApprovalContentPreview(
  _tool: string | null,
  args: Record<string, unknown> | null | undefined,
): ApprovalContentPreview | undefined {
  try {
    if (!args || typeof args !== 'object') return undefined;
    // composio_execute_tool nests the real fields under `arguments` (string|object).
    let inner: Record<string, unknown> = args;
    const nested = (args as Record<string, unknown>).arguments;
    if (typeof nested === 'string') {
      try { const p = JSON.parse(nested); if (p && typeof p === 'object') inner = p as Record<string, unknown>; } catch { /* keep args */ }
    } else if (nested && typeof nested === 'object') {
      inner = nested as Record<string, unknown>;
    }
    const rawBody = pickLongestString(inner, CONTENT_BODY_KEYS);
    const imageUrl = pickImageUrl(inner, CONTENT_IMAGE_KEYS);
    if (!rawBody && !imageUrl) return undefined;
    const out: ApprovalContentPreview = {};
    if (rawBody) {
      // Preserve line structure (a post body has it); just cap length.
      const clean = rawBody.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
      out.body = clean.length > 1500 ? `${clean.slice(0, 1499)}…` : clean;
    }
    if (imageUrl) out.imageUrl = imageUrl;
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Short human-readable preview of a live tool_called event for the
 * status line (chat dock + Discord progress). Capped tight (~70 chars)
 * so it fits in a one-line label. Where `summarizeApprovalAction`
 * formats a multi-line approval card, this is for "what is the agent
 * doing RIGHT NOW" — the user wants to know "running pwd && ls" not
 * "run_shell_command(args={command: ...})". Without it, a 7-call
 * sequence of run_shell_command shows up as the bare tool name 7 times
 * and the user can't tell anything's progressing.
 *
 * `argsRaw` accepts either the JSON string emitted by the SDK or the
 * already-parsed object — both are common shapes at call sites.
 */
export function previewToolCall(toolName: string, argsRaw: unknown): string {
  const args = parseArgs(argsRaw);
  if (!args) return toolName;
  const MAX = 70;
  switch (toolName) {
    case 'run_shell_command':
    case 'shell': {
      const command = pickString(args, ['command', 'cmd']);
      if (!command) return toolName;
      return `running: ${trim(command, MAX)}`;
    }
    case 'write_file':
    case 'edit_file': {
      const file = pickString(args, ['file_path', 'path', 'filePath']);
      return file ? `writing ${trim(file, MAX)}` : toolName;
    }
    case 'read_file': {
      const file = pickString(args, ['file_path', 'path', 'filePath']);
      return file ? `reading ${trim(file, MAX)}` : toolName;
    }
    case 'composio_execute_tool': {
      const slug = pickString(args, ['tool_slug', 'slug']);
      return slug ? `composio · ${trim(slug, MAX - 10)}` : toolName;
    }
    case 'composio_search_tools': {
      const query = pickString(args, ['query', 'q']);
      return query ? `searching composio · "${trim(query, MAX - 22)}"` : toolName;
    }
    case 'memory_recall':
    case 'tool_choice_recall': {
      const intent = pickString(args, ['intent', 'query', 'q']);
      return intent ? `recall · ${trim(intent, MAX - 9)}` : toolName;
    }
    case 'memory_search': {
      const query = pickString(args, ['query', 'q']);
      return query ? `memory search · "${trim(query, MAX - 17)}"` : toolName;
    }
    case 'skill_read':
    case 'skill_list': {
      const name = pickString(args, ['name', 'skill', 'filter']);
      return name ? `${toolName} · ${trim(name, MAX - toolName.length - 3)}` : toolName;
    }
    case 'discord_channel_send':
    case 'send_message':
    case 'notify_user':
    case 'discord_dm': {
      const title = pickString(args, ['title', 'subject']);
      const text = pickString(args, ['message', 'content', 'text', 'body']);
      return title || text ? `notify · ${trim(title || text, MAX - 9)}` : toolName;
    }
    case 'send_email':
    case 'gmail_send':
    case 'outlook_send_email': {
      const to = pickString(args, ['to', 'recipient']);
      return to ? `emailing ${trim(to, MAX - 9)}` : toolName;
    }
    case 'draft_plan': {
      const input = pickString(args, ['input', 'objective', 'goal']);
      return input ? `planning · ${trim(input, MAX - 11)}` : toolName;
    }
    case 'request_approval': {
      const subject = pickString(args, ['subject', 'reason']);
      return subject ? `requesting approval · ${trim(subject, MAX - 22)}` : toolName;
    }
    case 'goal_create':
    case 'goal_update':
    case 'task_add':
    case 'task_update': {
      const title = pickString(args, ['title', 'description', 'text', 'name']);
      return title ? `${toolName} · ${trim(title, MAX - toolName.length - 3)}` : toolName;
    }
    default: {
      return toolName;
    }
  }
}

function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────
// v0.5.20 Bug J — automatic approval-preview enrichment
// ─────────────────────────────────────────────────────────────────
//
// The model SHOULD pass `preview` on request_approval for batch
// actions, but prompt rules are unreliable. Workflows authored
// before this feature existed don't have it either. So the runtime
// scans the approval's session for batch-shaped recent tool output
// and synthesizes a preview automatically. No per-tool curation
// — generic detection over JSON arrays in tool_returned results.
//
// Detection heuristic (cheap):
//   1. Walk the LAST 10 tool_returned events for the approval's session
//      in DESC order (newest first).
//   2. For each, try to parse the result as JSON. If it contains an
//      array of objects (or nested array under common keys like
//      `data`, `values`, `drafts`, `rows`, `items`, `records`,
//      `messages`, `emails`), treat that as the batch.
//   3. From the first record, infer field names for a "primary"
//      label (subject/title/name) and a "secondary" label
//      (recipient/email/account/id).
//   4. Build samples[] from the first 5 records.
//
// Returns null if nothing batch-shaped is found — in which case the
// approval card just renders subject + reason like before. Safe
// fallback; no regression.

export interface ApprovalPreview {
  count?: number | null;
  samples?: Array<{
    label?: string;
    value?: string;
    secondary?: string | null;
  }> | null;
  /** Marker for the renderer to surface a "(auto-inferred)" footer. */
  inferred?: boolean;
}

const BATCH_CONTAINER_KEYS = [
  'data', 'values', 'drafts', 'rows', 'items', 'records',
  'messages', 'emails', 'tasks', 'results', 'updates',
];
const PRIMARY_FIELD_HINTS = [
  'subject', 'title', 'name', 'summary', 'text', 'message',
  'description', 'value', 'label',
];
const SECONDARY_FIELD_HINTS = [
  'to', 'recipient', 'recipients', 'email', 'account', 'accountName',
  'rowNumber', 'row', 'id', 'draftId', 'outlookDraftId', 'webLink', 'url',
];

function autoInferPreview(approval: PendingApproval): ApprovalPreview | null {
  if (!approval.sessionId) return null;
  let recent: ReturnType<typeof listHarnessEvents>;
  try {
    recent = listHarnessEvents(approval.sessionId, {
      types: ['tool_returned'],
      limit: 10,
      desc: true,
    });
  } catch {
    return null;
  }
  // Walk newest-first.
  for (let i = recent.length - 1; i >= 0; i--) {
    const evt = recent[i];
    const data = evt.data as { tool?: string; result?: unknown } | undefined;
    if (!data?.result) continue;
    const batch = extractBatch(data.result);
    if (!batch || batch.length === 0) continue;
    return buildPreviewFromBatch(batch);
  }
  return null;
}

function extractBatch(result: unknown): Array<Record<string, unknown>> | null {
  // Result can be a string (JSON-encoded) or already an object.
  let parsed: unknown = result;
  if (typeof result === 'string') {
    // Skip short strings — almost certainly not a batch payload.
    if (result.length < 30) return null;
    try { parsed = JSON.parse(result); } catch { return null; }
  }
  return findArrayOfObjects(parsed, 4);
}

function findArrayOfObjects(value: unknown, depthBudget: number): Array<Record<string, unknown>> | null {
  if (depthBudget <= 0 || value == null) return null;
  if (Array.isArray(value)) {
    // Must be array of objects (not scalars / not nested arrays).
    if (value.length >= 2 && value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
      return value as Array<Record<string, unknown>>;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  // Try common container keys first.
  for (const key of BATCH_CONTAINER_KEYS) {
    if (key in obj) {
      const found = findArrayOfObjects(obj[key], depthBudget - 1);
      if (found) return found;
    }
  }
  // Then any other key.
  for (const k of Object.keys(obj)) {
    if (BATCH_CONTAINER_KEYS.includes(k)) continue;
    const found = findArrayOfObjects(obj[k], depthBudget - 1);
    if (found) return found;
  }
  return null;
}

function buildPreviewFromBatch(batch: Array<Record<string, unknown>>): ApprovalPreview {
  const count = batch.length;
  const first = batch[0];
  const primaryKey = pickFieldName(first, PRIMARY_FIELD_HINTS);
  const secondaryKey = pickFieldName(first, SECONDARY_FIELD_HINTS, primaryKey);
  const samples = batch.slice(0, 5).map((item) => {
    const value = primaryKey ? coerceToString(item[primaryKey]) : coerceToString(Object.values(item)[0]);
    const secondary = secondaryKey ? coerceToString(item[secondaryKey]) : null;
    return {
      label: primaryKey ? toTitleCase(primaryKey) : 'Item',
      value: value ?? '(empty)',
      secondary: secondary ?? null,
    };
  });
  return { count, samples, inferred: true };
}

function pickFieldName(
  record: Record<string, unknown>,
  hints: string[],
  exclude?: string | null,
): string | null {
  const keys = Object.keys(record);
  const norm = (s: string) => s.toLowerCase().replace(/[_\s-]/g, '');
  for (const hint of hints) {
    const target = norm(hint);
    const match = keys.find((k) => norm(k) === target && k !== exclude);
    if (match) return match;
  }
  // Fallback to the first non-excluded string-valued key.
  for (const k of keys) {
    if (k === exclude) continue;
    const v = record[k];
    if (typeof v === 'string' && v.length > 0) return k;
  }
  return null;
}

function coerceToString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.length > 0 ? v : null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v).slice(0, 200); } catch { return null; }
}

function toTitleCase(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
