import { createFocus, getActiveFocus, listFocuses } from '../../memory/focus.js';
import { getSession, listEvents, type EventRow } from './eventlog.js';
import { projectCanonicalTopLevelToolEvents } from './tool-effect.js';

const MIN_RESOURCE_HITS = 2;
const MIN_THREAD_TOOL_CALLS = 4;
const MIN_THREAD_USER_INPUTS = 2;
const MIN_SINGLE_TURN_THREAD_TOOL_CALLS = 8;
const MAX_EVENT_SCAN = 240;

export interface MaybeAutoFocusOptions {
  sessionId: string;
  summaryHint?: unknown;
}

export interface AutoFocusResult {
  id: number;
  resourceRef: string;
  title: string;
}

interface ResourceHit {
  ref: string;
  kind: string;
}

function isDisabled(): boolean {
  return (process.env.CLEMMY_AUTO_FOCUS ?? 'on').toLowerCase() === 'off';
}

function cleanLine(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

/** Harness-internal boilerplate that must NEVER become the user's focus: the
 *  unparsed-decision apology and the synthetic stall/parse retry prompts. A
 *  proof run (2026-07-03) pinned "Clementine produced a response that couldn't
 *  be structured. Please ask again." as the ACTIVE focus — which then polluted
 *  every later turn's context. Patterns mirror loop.ts's synthetic-retry family
 *  (kept local: loop.ts imports this module, so importing back would cycle). */
const INTERNAL_BOILERPLATE_RE =
  /couldn't be structured|could not be parsed into the required structured decision|previous response was prose, not an action|did not make progress on the directive/i;

function isInternalBoilerplate(text: string): boolean {
  return INTERNAL_BOILERPLATE_RE.test(text);
}

function summaryFromOutput(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const line = cleanLine(v.reply ?? v.summary, 500);
    return isInternalBoilerplate(line) ? '' : line;
  }
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw) return '';
  let out: string;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    out = cleanLine(parsed.reply ?? parsed.summary, 500);
  } catch {
    out = cleanLine(raw, 500);
  }
  return isInternalBoilerplate(out) ? '' : out;
}

function latestConversationSummary(events: EventRow[]): string {
  for (const event of events.slice().reverse()) {
    if (event.type !== 'conversation_completed' && event.type !== 'conversation_step') continue;
    if (event.type === 'conversation_step') {
      const decision = (event.data as { decision?: unknown }).decision;
      const summary = summaryFromOutput(decision);
      if (summary) return summary;
      continue;
    }
    const summary = summaryFromOutput(event.data);
    if (summary) return summary;
  }
  return '';
}

function latestUserInput(events: EventRow[]): string {
  for (const event of events.slice().reverse()) {
    if (event.type !== 'user_input_received' && event.type !== 'turn_started') continue;
    const text = event.type === 'user_input_received'
      ? (event.data as { text?: unknown }).text
      : (event.data as { input?: unknown }).input;
    const cleaned = cleanLine(text, 120);
    // Synthetic retry prompts are recorded like inputs but are NOT the user's ask.
    if (cleaned && !isInternalBoilerplate(cleaned)) return cleaned;
  }
  return '';
}

function makeTitle(summary: string, fallback: string): string {
  const source = summary || fallback || 'Current work';
  return cleanLine(
    source
      .replace(/^(done|yes|sure|ok|okay|completed)[,.:; -]+/i, '')
      .replace(/^i (have |just |successfully )?/i, ''),
    100,
  ) || 'Current work';
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function pushGoogleUrlHits(text: string, hits: ResourceHit[]): void {
  const sheetUrl = /https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/g;
  const docUrl = /https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{20,})/g;
  for (const match of text.matchAll(sheetUrl)) {
    hits.push({ kind: 'sheet', ref: `https://docs.google.com/spreadsheets/d/${match[1]}` });
  }
  for (const match of text.matchAll(docUrl)) {
    hits.push({ kind: 'doc', ref: `https://docs.google.com/document/d/${match[1]}` });
  }
}

function pushIdHits(obj: Record<string, unknown>, hits: ResourceHit[]): void {
  const spreadsheetId = obj.spreadsheet_id ?? obj.spreadsheetId;
  if (typeof spreadsheetId === 'string' && spreadsheetId.length >= 20) {
    hits.push({ kind: 'sheet', ref: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` });
  }
  const documentId = obj.document_id ?? obj.documentId;
  if (typeof documentId === 'string' && documentId.length >= 20) {
    hits.push({ kind: 'doc', ref: `https://docs.google.com/document/d/${documentId}` });
  }
  const displayUrl = obj.display_url ?? obj.webViewLink ?? obj.url;
  if (typeof displayUrl === 'string') pushGoogleUrlHits(displayUrl, hits);
}

function collectHitsFromValue(value: unknown, hits: ResourceHit[], depth = 0): void {
  if (depth > 4 || value == null) return;
  if (typeof value === 'string') {
    pushGoogleUrlHits(value, hits);
    const parsed = parseJsonObject(value);
    if (parsed) collectHitsFromValue(parsed, hits, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) collectHitsFromValue(item, hits, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    pushIdHits(obj, hits);
    for (const key of ['arguments', 'result', 'data', 'output']) {
      if (key in obj) collectHitsFromValue(obj[key], hits, depth + 1);
    }
  }
}

function bestResource(events: EventRow[]): ResourceHit | null {
  const counts = new Map<string, { kind: string; count: number }>();
  for (const event of projectCanonicalTopLevelToolEvents(events)) {
    const hits: ResourceHit[] = [];
    collectHitsFromValue(event.data, hits);
    for (const hit of hits) {
      const existing = counts.get(hit.ref);
      if (existing) existing.count += 1;
      else counts.set(hit.ref, { kind: hit.kind, count: 1 });
    }
  }

  let best: { ref: string; kind: string; count: number } | null = null;
  for (const [ref, info] of counts.entries()) {
    if (info.count < MIN_RESOURCE_HITS) continue;
    if (!best || info.count > best.count) best = { ref, ...info };
  }
  return best ? { ref: best.ref, kind: best.kind } : null;
}

function hasNonTerminalFocusForSession(sessionId: string): boolean {
  return listFocuses({ includeTerminal: false, limit: 50 })
    .some((row) => row.related_session_id === sessionId);
}

/**
 * Best-effort focus safety net. The model should still call focus_set
 * when it knows the user's working resource. This catches the cases
 * where a long chat clearly becomes ongoing work but the model skips
 * focus_get/focus_set, leaving the dashboard and future turns with no
 * attention pointer at all.
 */
export function maybeAutoFocusSession(options: MaybeAutoFocusOptions): AutoFocusResult | null {
  if (isDisabled()) return null;
  const session = getSession(options.sessionId);
  if (!session || session.kind !== 'chat') return null;
  if (getActiveFocus()) return null;
  if (hasNonTerminalFocusForSession(options.sessionId)) return null;

  const events = listEvents(options.sessionId, { limit: MAX_EVENT_SCAN, desc: true });
  const toolCalls = projectCanonicalTopLevelToolEvents(events, 'tool_called').length;
  const userInputs = events.filter((event) => event.type === 'user_input_received').length;
  const resource = bestResource(events);
  const qualifiesForThreadFocus =
    (toolCalls >= MIN_THREAD_TOOL_CALLS && userInputs >= MIN_THREAD_USER_INPUTS)
    || toolCalls >= MIN_SINGLE_TURN_THREAD_TOOL_CALLS;

  if (!resource && !qualifiesForThreadFocus) return null;

  const summary = summaryFromOutput(options.summaryHint)
    || latestConversationSummary(events)
    || latestUserInput(events)
    || session.objective
    || session.title
    || `Working thread ${options.sessionId}`;
  const title = makeTitle(summary, session.title ?? latestUserInput(events));
  const focus = createFocus({
    resourceRef: resource?.ref ?? `session:${options.sessionId}`,
    title,
    summary,
    resourceKind: resource?.kind ?? 'thread',
    relatedSessionId: options.sessionId,
    metadata: { source: 'harness_auto_focus' },
  });

  return {
    id: focus.id,
    resourceRef: focus.resource_ref,
    title: focus.title,
  };
}
