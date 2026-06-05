import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ExecutionStore, renderExecutionSummary } from '../execution/store.js';
import { WORKING_MEMORY_FILE } from './vault.js';
import { loadSessionBrief } from './session-briefs.js';
import type { SessionRecord } from '../types.js';
import { PlanStore } from '../planning/plan-store.js';
import { isUserFacingSession } from '../execution/scope.js';
import { extractNamedResource } from './focus.js';

const SESSION_WORKING_MEMORY_DIR = path.join(path.dirname(WORKING_MEMORY_FILE), 'state', 'working-memory');

/**
 * Heading for the pinned "Active Task" block — the durable, same-turn-visible
 * home for a hard constraint the user states mid-chat ("send 25 emails to ONLY
 * this list: …"). It is the single source of truth Clem re-reads when she acts,
 * so she stops drifting to a different/stale list across many back-and-forth
 * turns. Distinct from the existing "## Focus" block (which carries the coarse
 * execution/plan focus, not the verbatim constraint parameters).
 */
const ACTIVE_TASK_HEADING = '## Active Task';

/**
 * How long a pinned Active Task stays binding before it is treated as stale and
 * dropped on the next turn-end refresh. Bounds the "stale spec poisons the next
 * task" risk without needing reliable completion detection (deferred). A fresh
 * full spec on a later turn replaces it sooner (last-writer-wins).
 */
const ACTIVE_TASK_TTL_MS = 6 * 60 * 60 * 1000;

export interface ActiveTaskSpec {
  /** ISO timestamp; drives the staleness window. */
  capturedAt: string;
  /** The mutating/outbound verb that triggered the pin (e.g. "send"). */
  verb?: string;
  /** Explicit count when stated ("25 emails"). */
  count?: number;
  /** The named recipient/target set, stored VERBATIM. Inline when small;
   *  large sets render as a bounded preview + count (pointer-first, no bloat). */
  recipients: string[];
  /**
   * A concrete resource LOCATOR for the list/target (a Google Sheets/Docs id or
   * URL). This is the compact "where it lives" pointer — pinned so that at
   * action time Clem pulls from THIS exact reference instead of re-discovering
   * (the real failure: she made fresh MCP calls and pulled the wrong list).
   */
  resourceRef?: string;
  /** "only" | "exactly" | "just" when the user constrained scope. */
  exclusivity?: string;
  /** The raw constraint clause (capped), for provenance. */
  constraintText: string;
}

/**
 * Recipients are inlined verbatim up to this many characters; beyond it the
 * block renders a bounded preview + "+N more" + a confirm nudge, so a large
 * pasted list never bloats every turn or overflows the working-memory read cap.
 * The compact resource pointer (resourceRef) is the preferred home for big sets.
 */
const RECIPIENT_INLINE_CHAR_BUDGET = 1500;

// A mutating / outbound verb whose parameters must be pinned so they survive
// the conversation. Mirrors the intent of plan-first's write-verb set; kept
// local so the memory layer stays self-contained (no harness import).
const TASK_VERB_RE =
  /\b(send|e-?mail|emails?|draft|message|dm|post|publish|reply|forward|create|add|invite|schedule|book|update|delete|remove)\b/i;
// Determiner that points at a specific list the user is naming.
const LIST_MARKER_RE = /\b(this|these|those|the following|the list|my list)\b/i;
// "only/exactly/just these" — an explicit exclusivity constraint.
const EXCLUSIVITY_RE = /\b(only|exactly|just)\b/i;
// An explicit count governing a plural-ish noun ("25 emails", "10 contacts").
const COUNT_RE = /\b(\d{1,4})\s+(?:[a-z][\w-]*\s+){0,2}?(emails?|recipients?|people|contacts?|messages?|names?|addresses|folks|clients?|customers?|leads?|invites?)\b/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// A plausible person/recipient name: 1–5 letter-tokens. Conservative so a
// chatty sentence ("send me your thoughts") doesn't read as a recipient.
const PLAUSIBLE_NAME_RE = /^[A-Za-z][A-Za-z.'’-]*(?:\s+[A-Za-z][A-Za-z.'’-]*){0,4}$/;

function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Pull the explicit recipient set out of a message. Prefers email addresses;
 * otherwise an enumerated list after a colon / list marker. Returns [] unless
 * there are at least two concrete recipients (the conservative bar that keeps
 * ordinary imperatives like "send the report" from being captured).
 */
function parseRecipients(text: string): string[] {
  const emails = text.match(EMAIL_RE);
  if (emails && emails.length >= 2) return dedupePreserveOrder(emails);

  // Enumerated names — look at the clause after the last colon if present
  // (that's where "…this list: Alice, Bob, …" puts them), else the whole text.
  const colon = text.lastIndexOf(':');
  const tail = colon >= 0 && colon < text.length - 1 ? text.slice(colon + 1) : text;
  const items = tail
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const names = items.filter((item) => item.length <= 60 && PLAUSIBLE_NAME_RE.test(item));
  if (names.length >= 2) return dedupePreserveOrder(names);

  return emails && emails.length >= 1 ? dedupePreserveOrder(emails) : [];
}

/**
 * Deterministic, no-LLM detector for an "action-with-parameters" turn: a
 * mutating verb co-occurring with a concrete recipient/target set. Returns a
 * spec to pin, or null. Conservative by construction — resolves ambiguity to
 * "no spec" so it never over-constrains a later turn (forward-only).
 */
export function detectActiveTask(message: string): ActiveTaskSpec | null {
  const text = (message ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 8) return null;
  if (!TASK_VERB_RE.test(text)) return null;

  const recipients = parseRecipients(text);
  const resourceRef = extractNamedResource(text) ?? undefined;
  const hasMarker = LIST_MARKER_RE.test(text);
  const countMatch = COUNT_RE.exec(text);
  const parsedCount = countMatch ? Number.parseInt(countMatch[1], 10) : NaN;
  const count = Number.isFinite(parsedCount) ? parsedCount : undefined;
  const exclusivity = EXCLUSIVITY_RE.test(text) && hasMarker
    ? (text.match(EXCLUSIVITY_RE)?.[0]?.toLowerCase())
    : undefined;

  // Fire only with a CONCRETE target signal alongside the mutating verb:
  //  - an enumerated recipient set (>=2), OR
  //  - a concrete resource locator (sheet/doc id or URL), OR
  //  - a list reference ("this/that list") qualified by a count or exclusivity
  //    (the "send 25 emails to this list" shape) — pinned even when the exact
  //    list is UNRESOLVED, so the params persist and Clem is told to confirm
  //    WHICH list before pulling, rather than re-discovering and guessing.
  const hasConcreteTarget =
    recipients.length >= 2
    || Boolean(resourceRef)
    || (hasMarker && (count !== undefined || Boolean(exclusivity)));
  if (!hasConcreteTarget) return null;

  const verbMatch = text.match(TASK_VERB_RE);
  return {
    capturedAt: new Date().toISOString(),
    verb: verbMatch ? verbMatch[0].toLowerCase() : undefined,
    count,
    recipients,
    resourceRef,
    exclusivity,
    constraintText: text.slice(0, 1500),
  };
}

function renderActiveTaskSection(spec: ActiveTaskSpec): string {
  const lines = [
    `${ACTIVE_TASK_HEADING} (binding — use the EXACT target below; pull it from the pinned reference and do NOT re-discover, search, or substitute another list; the latest stated version wins)`,
  ];
  const meta: string[] = [];
  if (spec.verb) meta.push(`Action: ${spec.verb}`);
  if (spec.count != null) meta.push(`Count: ${spec.count}`);
  if (spec.exclusivity) meta.push(`Scope: ${spec.exclusivity} these`);
  if (meta.length) lines.push(meta.join(' | '));

  // Compact "where it lives" pointer — the preferred, no-bloat home for the
  // list. At action time Clem must pull from THIS exact locator.
  if (spec.resourceRef) {
    lines.push(`Resource (pull from THIS exact reference — do not search for a list): ${spec.resourceRef}`);
  }

  if (spec.recipients.length) {
    const joined = spec.recipients.join(', ');
    if (joined.length <= RECIPIENT_INLINE_CHAR_BUDGET) {
      lines.push(`Recipients (verbatim — do not substitute or re-derive): ${joined}`);
    } else {
      // Bounded preview so a large pasted list neither bloats every turn nor
      // overflows the read cap (which would silently drop names = drift).
      let preview = '';
      let included = 0;
      for (const recipient of spec.recipients) {
        if (preview.length + recipient.length + 2 > RECIPIENT_INLINE_CHAR_BUDGET) break;
        preview += (preview ? ', ' : '') + recipient;
        included += 1;
      }
      const remaining = spec.recipients.length - included;
      lines.push(
        `Recipients: ${preview} … +${remaining} more (large list — confirm the exact full set, or store it as a referenced list/sheet, before sending; do NOT substitute a different list).`,
      );
    }
  }

  // Referenced a list but we could not resolve a concrete locator or set —
  // clarify, don't guess (the real failure was guessing via re-discovery).
  if (!spec.resourceRef && spec.recipients.length === 0) {
    lines.push('List reference: UNRESOLVED — confirm WHICH list with the user before pulling it; do not guess or search.');
  }

  if (spec.constraintText) lines.push(`Stated: ${spec.constraintText}`);
  lines.push(`Captured: ${spec.capturedAt}`);
  return lines.join('\n');
}

const ACTIVE_TASK_SECTION_RE = /## Active Task[\s\S]*?(?=\n## |$)/;

/** Write/replace the Active Task section in the per-session file synchronously
 *  (last-writer-wins). Placed right after the file header so it stays within
 *  the 3000-char read window. Best-effort — never throws. */
export function writeActiveTaskSection(sessionId: string, spec: ActiveTaskSpec): void {
  try {
    const filePath = workingMemoryPathForSession(sessionId);
    const body = renderActiveTaskSection(spec).trimEnd();
    let existing = '';
    if (existsSync(filePath)) {
      try { existing = readFileSync(filePath, 'utf-8'); } catch { existing = ''; }
    }

    let next: string;
    if (ACTIVE_TASK_SECTION_RE.test(existing)) {
      next = existing.replace(ACTIVE_TASK_SECTION_RE, `${body}\n`);
    } else if (/^# Working Memory/.test(existing)) {
      next = existing.replace(/^(# Working Memory\n+)/, `$1${body}\n\n`);
    } else if (existing.trim()) {
      next = `${body}\n\n${existing}`;
    } else {
      next = `# Working Memory\n\n${body}\n`;
    }

    mkdirSync(SESSION_WORKING_MEMORY_DIR, { recursive: true });
    writeFileSync(filePath, next);
  } catch {
    // best-effort; pinning a constraint must never break a turn.
  }
}

function parseCapturedAt(sectionText: string): number | undefined {
  const match = sectionText.match(/Captured:\s*(\S+)/);
  if (!match) return undefined;
  const ts = Date.parse(match[1]);
  return Number.isNaN(ts) ? undefined : ts;
}

/** Return the LIVE (non-stale) Active Task section text for a session, or
 *  undefined if absent or past its TTL. */
export function readActiveTaskSection(sessionId: string): string | undefined {
  try {
    const filePath = workingMemoryPathForSession(sessionId);
    if (!existsSync(filePath)) return undefined;
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(ACTIVE_TASK_SECTION_RE);
    if (!match) return undefined;
    const section = match[0];
    const capturedAt = parseCapturedAt(section);
    if (capturedAt !== undefined && Date.now() - capturedAt > ACTIVE_TASK_TTL_MS) {
      // Past the 6h TTL — but keep the pin alive while the session still has a
      // live tracked execution. A multi-hour in-flight job must not drop its
      // binding constraint at 6h and re-open drift. Best-effort: any error
      // falls through to the normal drop.
      let hasLiveExecution = false;
      try {
        hasLiveExecution = Boolean(new ExecutionStore().getActiveForSession(sessionId));
      } catch {
        hasLiveExecution = false;
      }
      if (!hasLiveExecution) return undefined; // stale — let the next refresh drop it
    }
    return section.trimEnd();
  } catch {
    return undefined;
  }
}

/** Cheap probe for the memory-budget override: does a live Active Task spec
 *  exist for this session? */
export function hasActiveTaskSection(sessionId: string): boolean {
  return readActiveTaskSection(sessionId) !== undefined;
}

/**
 * The pinned Active Task for a SPECIFIC origin session, as plaintext, for
 * carrying into DELEGATED work (a background task, a fanned-out worker) so the
 * delegate acts on the EXACT target instead of re-discovering it. Keyed by the
 * spawning session id and read from THAT session's per-session file — never the
 * global working-memory file, never a "most-recent any-session" read — so one
 * session's recipient list can never leak into an unrelated job. Returns
 * undefined when there's no live (non-stale) pin. Defensively length-capped.
 */
export function getActiveTaskForDelegation(originSessionId: string): string | undefined {
  if (!originSessionId) return undefined;
  const section = readActiveTaskSection(originSessionId);
  if (!section) return undefined;
  return section.length > 2000 ? `${section.slice(0, 2000)}…` : section;
}

/**
 * Parse the live Active Task section back into a structured spec (reverses
 * renderActiveTaskSection). Single source of truth — the section IS the store;
 * this lets code read the pinned params (the `active_task` tool's `update`
 * merge, and the execution-brief hand-off) without a parallel JSON store.
 * Returns undefined if no live (non-stale) section exists. For a bounded
 * large-list preview, only the previewed recipients are recoverable (large
 * sets should carry a resourceRef anyway). Best-effort — never throws.
 */
export function parseActiveTaskSection(sessionId: string): ActiveTaskSpec | undefined {
  try {
    const section = readActiveTaskSection(sessionId);
    if (!section) return undefined;
    const verbMatch = section.match(/Action:\s*([^|\n]+?)(?:\s*\||\n|$)/);
    const countMatch = section.match(/Count:\s*(\d+)/);
    const scopeMatch = section.match(/Scope:\s*(\w+)\s+these/);
    const refMatch = section.match(/Resource \(pull from THIS exact reference[^)]*\):\s*(.+)/);
    const recipientsMatch = section.match(/Recipients \(verbatim[^)]*\):\s*(.+)/);
    const capturedMatch = section.match(/Captured:\s*(\S+)/);
    const statedMatch = section.match(/Stated:\s*(.+)/);
    const count = countMatch ? Number.parseInt(countMatch[1], 10) : undefined;
    return {
      capturedAt: capturedMatch?.[1] ?? new Date().toISOString(),
      verb: verbMatch?.[1]?.trim() || undefined,
      count: count !== undefined && Number.isFinite(count) ? count : undefined,
      recipients: recipientsMatch ? recipientsMatch[1].split(/,\s*/).map((r) => r.trim()).filter(Boolean) : [],
      resourceRef: refMatch?.[1]?.trim() || undefined,
      exclusivity: scopeMatch?.[1]?.toLowerCase() || undefined,
      constraintText: statedMatch?.[1]?.trim() ?? '',
    };
  } catch {
    return undefined;
  }
}

/** Remove the Active Task section (e.g. on completion/pivot). Best-effort. */
export function dropActiveTaskSection(sessionId: string): void {
  try {
    const filePath = workingMemoryPathForSession(sessionId);
    if (!existsSync(filePath)) return;
    const content = readFileSync(filePath, 'utf-8');
    if (!ACTIVE_TASK_SECTION_RE.test(content)) return;
    writeFileSync(filePath, content.replace(ACTIVE_TASK_SECTION_RE, '').replace(/\n{3,}/g, '\n\n'));
  } catch {
    // best-effort.
  }
}

/**
 * Pin a stated action constraint synchronously at turn start. Detects an
 * action-with-parameters turn and writes/replaces the Active Task section
 * (last-writer-wins). On a turn with no detectable spec it does nothing, so any
 * existing spec is carried forward by refreshWorkingMemory. Best-effort.
 */
export function reconcileActiveTask(sessionId: string, message: string): void {
  try {
    const spec = detectActiveTask(message);
    if (spec) writeActiveTaskSection(sessionId, spec);
  } catch {
    // best-effort; a capture failure must never break a turn.
  }
}

function workingMemoryDigest(sessionId: string): string {
  return createHash('sha1').update(sessionId).digest('hex');
}

export function workingMemoryPathForSession(sessionId: string): string {
  return path.join(SESSION_WORKING_MEMORY_DIR, `${workingMemoryDigest(sessionId)}.md`);
}

export function loadWorkingMemoryForSession(sessionId: string, maxChars = 3000): string | undefined {
  const filePath = workingMemoryPathForSession(sessionId);
  if (!existsSync(filePath)) return undefined;
  try {
    return readFileSync(filePath, 'utf-8').trim().slice(0, maxChars);
  } catch {
    return undefined;
  }
}

function buildSessionSummary(session: SessionRecord): string {
  const turns = session.turns.slice(-6);
  if (turns.length === 0) {
    return 'No recent conversation.';
  }

  return turns
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text.replace(/\s+/g, ' ').slice(0, 180)}`)
    .join('\n');
}

function buildPlanSummary(sessionId: string): string {
  const plans = new PlanStore().list(3, sessionId);
  if (plans.length === 0) return 'No active plans.';

  return plans.map((plan) => {
    const active = plan.steps.find((step) => step.status === 'in_progress');
    const done = plan.steps.filter((step) => step.status === 'done').length;
    return `- ${plan.title} (${done}/${plan.steps.length} complete)${active ? ` | active: ${active.text}` : ''}`;
  }).join('\n');
}

function buildActiveTaskFocus(session: SessionRecord): string {
  const execution = new ExecutionStore().getActiveForSession(session.id);
  if (execution) {
    return `Tracked execution: ${renderExecutionSummary(execution)}`;
  }

  const active = new PlanStore().getActive(session.id);
  if (!active) {
    return 'No active deep task. Keep the next useful move visible.';
  }

  const currentStep = active.steps.find((step) => step.status === 'in_progress');
  if (!currentStep) {
    return `Plan active: ${active.title}. Review remaining steps and decide the next move.`;
  }

  return `Active deep task: ${active.title}. Current step: ${currentStep.text}`;
}

function buildSessionHandoff(session: SessionRecord): string {
  const brief = loadSessionBrief(session.id);
  if (!brief?.manual) {
    return 'No manual handoff recorded for this session.';
  }

  const lines = [`Last saved handoff: ${brief.manual.pausedAt}`];
  if (brief.manual.remaining.length > 0) {
    lines.push(...brief.manual.remaining.slice(0, 4).map((item) => `- [ ] ${item}`));
  }
  if (brief.manual.blockers.length > 0) {
    lines.push(...brief.manual.blockers.slice(0, 3).map((item) => `- blocker: ${item}`));
  }
  return lines.join('\n');
}

export function refreshWorkingMemory(session: SessionRecord): void {
  const sections = [
    '# Working Memory',
    '',
    '## Current Session',
    buildSessionSummary(session),
    '',
    '## Active Plans',
    buildPlanSummary(session.id),
    '',
    '## Session Handoff',
    buildSessionHandoff(session),
    '',
    '## Focus',
    buildActiveTaskFocus(session),
    '',
  ];

  const baseContent = sections.join('\n');

  // Carry forward a LIVE Active Task section written synchronously at turn
  // start. Without this, the full-file rewrite here clobbers it and the
  // constraint drift returns (the top regression). It is placed FIRST so it
  // survives the 3000-char read window, and kept OUT of the GLOBAL file so one
  // session's verbatim recipient list never leaks into the harness/other
  // surfaces (which read the global WORKING_MEMORY_FILE).
  const activeTask = readActiveTaskSection(session.id);
  const perSessionContent = activeTask
    ? ['# Working Memory', '', activeTask, '', ...sections.slice(2)].join('\n')
    : baseContent;

  mkdirSync(SESSION_WORKING_MEMORY_DIR, { recursive: true });
  writeFileSync(workingMemoryPathForSession(session.id), perSessionContent);
  if (isUserFacingSession(session.id, session.channel)) {
    writeFileSync(WORKING_MEMORY_FILE, baseContent);
  }
}

export function workingMemoryExists(): boolean {
  return existsSync(WORKING_MEMORY_FILE);
}

/**
 * P2-F — lightweight between-turn checkpoint. `refreshWorkingMemory` only
 * runs at the END of a `respond` call, so a run that aborts mid-tool-loop
 * (e.g. a wall-clock abort) persists nothing. This writes/updates a compact
 * `## In-flight Checkpoint` section in the per-session working-memory file
 * after a substantive turn, so a later retry / watchdog re-spawn resumes
 * from progress instead of zero. Deterministic, no LLM, best-effort — a
 * write failure must never break a turn. Non-destructive: it only replaces
 * the checkpoint section, leaving any existing working-memory content intact
 * (a normal turn-end `refreshWorkingMemory` overwrites the whole file again).
 */
export function checkpointWorkingMemory(
  sessionId: string,
  progress: { lastText?: string; toolCallsTotal?: number; turn?: number },
): void {
  try {
    const filePath = workingMemoryPathForSession(sessionId);
    const checkpointSection = [
      '## In-flight Checkpoint',
      `Updated: ${new Date().toISOString()}`,
      progress.turn !== undefined ? `Turn: ${progress.turn}` : null,
      progress.toolCallsTotal !== undefined ? `Tool calls so far: ${progress.toolCallsTotal}` : null,
      progress.lastText ? `Latest: ${progress.lastText.replace(/\s+/g, ' ').slice(0, 500)}` : null,
    ].filter(Boolean).join('\n');

    let existing = '';
    if (existsSync(filePath)) {
      try { existing = readFileSync(filePath, 'utf-8'); } catch { existing = ''; }
    }

    let next: string;
    if (/## In-flight Checkpoint/.test(existing)) {
      next = existing.replace(/## In-flight Checkpoint[\s\S]*?(?=\n## |$)/, `${checkpointSection}\n`);
    } else if (existing.trim()) {
      next = `${existing.trimEnd()}\n\n${checkpointSection}\n`;
    } else {
      next = `# Working Memory\n\n${checkpointSection}\n`;
    }

    mkdirSync(SESSION_WORKING_MEMORY_DIR, { recursive: true });
    writeFileSync(filePath, next);
  } catch {
    // best-effort; a checkpoint write must never break or fail a turn.
  }
}
