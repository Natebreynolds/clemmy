import { createFocus, getActiveFocus, listFocuses } from '../../memory/focus.js';
import { getSession, listEvents, type EventRow } from './eventlog.js';
import { listRunArtifacts, type RunArtifact } from './artifact-ledger.js';
import {
  actionTopologyRoleForRuntimeCall,
  canonicalRuntimeEffectiveToolName,
  classifyRuntimeToolEffect,
  projectCanonicalTopLevelToolEvents,
  unwrapRuntimeEffectiveToolIdentity,
} from './tool-effect.js';

const MIN_RESOURCE_HITS = 2;
const MIN_THREAD_TOOL_CALLS = 4;
const MIN_THREAD_USER_INPUTS = 2;
const MIN_SINGLE_TURN_THREAD_TOOL_CALLS = 8;
const MIN_CONVERSATIONAL_TURNS = 3;
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

const CASUAL_ONLY_RE =
  /^(?:hi|hey|hello|thanks|thank you|cool|great|nice|ok|okay|got it|sounds good|perfect|bye)[\s!.?]*$/i;
const CONTINUATION_LANGUAGE_RE =
  /(?:\b(?:what|how) about\b|^\s*(?:yes|no|maybe|also|instead|another|actually|that|those|these|it|let'?s|i (?:like|prefer|don'?t))\b)/i;
const CONVERSATION_STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'but', 'can', 'could', 'for',
  'from', 'have', 'help', 'into', 'just', 'like', 'maybe', 'more', 'need', 'not',
  'please', 'that', 'the', 'them', 'then', 'these', 'they', 'this', 'those',
  'want', 'what', 'when', 'where', 'which', 'with', 'would', 'you', 'your',
]);

function conversationTokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g)
      ?.filter((token) => !CONVERSATION_STOPWORDS.has(token))
      ?? [],
  );
}

/**
 * A real collaborative thread can become focus-worthy before any tool runs.
 * Require three substantive user turns plus either explicit continuation
 * language or a repeated topic token, so three unrelated one-off questions in
 * a long-lived channel do not automatically become one focus.
 */
function isSustainedCollaborativeConversation(events: EventRow[]): boolean {
  const messages = events
    .filter((event) => event.type === 'user_input_received')
    .map((event) => cleanLine((event.data as { text?: unknown }).text, 500))
    .filter((text) => text.length >= 12 && !CASUAL_ONLY_RE.test(text) && !isInternalBoilerplate(text));
  if (messages.length < MIN_CONVERSATIONAL_TURNS) return false;
  const recent = messages.slice(-6);
  if (recent.slice(1).some((text) => CONTINUATION_LANGUAGE_RE.test(text))) return true;
  const tokenTurns = new Map<string, number>();
  for (const message of recent) {
    for (const token of conversationTokens(message)) {
      tokenTurns.set(token, (tokenTurns.get(token) ?? 0) + 1);
    }
  }
  return [...tokenTurns.values()].some((count) => count >= 2);
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

function toolArguments(data: Record<string, unknown>): unknown {
  return data.arguments ?? data.args ?? data.input ?? {};
}

/** Resource extraction is authority-bearing: a URL merely transported inside
 * a control packet is historical context, not proof that this turn operated
 * on it. Accept only provider-backed business calls whose effective action is
 * itself Google Sheets/Docs-shaped. */
function resourceKindForTrustedBusinessCall(
  toolName: string,
  args: unknown,
): ResourceHit['kind'] | null {
  if (actionTopologyRoleForRuntimeCall(toolName, args) !== 'business') return null;
  const effectSource = classifyRuntimeToolEffect(toolName, args).source;
  if (effectSource !== 'composio' && effectSource !== 'native_mcp') return null;
  const effective = unwrapRuntimeEffectiveToolIdentity(toolName, args);
  const identity = canonicalRuntimeEffectiveToolName(effective.toolName) ?? effective.toolName ?? '';
  const shape = identity
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  if (/(?:GOOGLE_?SHEETS?|GOOGLESHEETS|SPREADSHEETS?)/.test(shape)) return 'sheet';
  if (/(?:GOOGLE_?DOCS?|GOOGLEDOCS)/.test(shape)) return 'doc';
  return null;
}

function canonicalLogicalCallId(event: EventRow): string {
  for (const key of ['canonicalCallId', 'logicalCallId', 'callId', 'call_id']) {
    const value = event.data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return event.id;
}

function verifiedArtifactHits(artifact: RunArtifact): ResourceHit[] {
  if (artifact.status !== 'bound' || !artifact.bindingVerifiedAt) return [];
  const hits: ResourceHit[] = [];
  if (artifact.uri) pushGoogleUrlHits(artifact.uri, hits);
  if (hits.length > 0 || !artifact.resourceId) return hits;
  const provider = artifact.provider.toLowerCase();
  if (artifact.kind === 'google_doc' || /google\s*docs?/.test(provider)) {
    hits.push({ kind: 'doc', ref: `https://docs.google.com/document/d/${artifact.resourceId}` });
  } else if (/google\s*sheets?|googlesheets/.test(provider)) {
    hits.push({ kind: 'sheet', ref: `https://docs.google.com/spreadsheets/d/${artifact.resourceId}` });
  }
  return hits;
}

function bestResource(events: EventRow[], sessionId: string): ResourceHit | null {
  const counts = new Map<string, { kind: string; count: number }>();
  const countedEvidence = new Set<string>();
  const countHits = (evidenceId: string, hits: ResourceHit[], expectedKind?: string): void => {
    for (const hit of hits) {
      if (expectedKind && hit.kind !== expectedKind) continue;
      const key = `${evidenceId}\0${hit.ref}`;
      if (countedEvidence.has(key)) continue;
      countedEvidence.add(key);
      const existing = counts.get(hit.ref);
      if (existing) existing.count += 1;
      else counts.set(hit.ref, { kind: hit.kind, count: 1 });
    }
  };

  for (const event of projectCanonicalTopLevelToolEvents(events, 'tool_called')) {
    const toolName = typeof event.data.tool === 'string' ? event.data.tool : '';
    if (!toolName) continue;
    const rawArgs = toolArguments(event.data);
    const expectedKind = resourceKindForTrustedBusinessCall(toolName, rawArgs);
    if (!expectedKind) continue;
    const effective = unwrapRuntimeEffectiveToolIdentity(toolName, rawArgs);
    const hits: ResourceHit[] = [];
    collectHitsFromValue(effective.args, hits);
    countHits(`call:${canonicalLogicalCallId(event)}`, hits, expectedKind);
  }
  for (const artifact of listRunArtifacts(sessionId)) {
    countHits(`artifact:${artifact.id}`, verifiedArtifactHits(artifact));
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
  const resource = bestResource(events, options.sessionId);
  const qualifiesForThreadFocus =
    (toolCalls >= MIN_THREAD_TOOL_CALLS && userInputs >= MIN_THREAD_USER_INPUTS)
    || toolCalls >= MIN_SINGLE_TURN_THREAD_TOOL_CALLS
    || isSustainedCollaborativeConversation(events);

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
