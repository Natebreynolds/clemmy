import { proactiveOfferContextForTurn } from '../runtime/proactive-offers.js';
/**
 * Persistent memory context for the 0.3 harness.
 *
 * v0.2 chat injects this stack into the assistant's system prompt
 * (src/assistant/instructions.ts buildAssistantInstructions). The
 * harness was missing it entirely — the Orchestrator and every
 * sub-agent started each turn blind to who the user is, what's in
 * working memory, what facts have been taught, and what goals are
 * active. Cross-channel "Clementine remembers me everywhere" only
 * works if the same persistent context is available to the harness
 * agents, not just the v0.2 chat path.
 *
 * Sources (the same ones v0.2 reads):
 *   - SOUL.md          → assistant personality / tone
 *   - IDENTITY.md      → who Clementine is
 *   - MEMORY.md        → long-term curated context
 *   - working-memory.md → recent / current focus, written by auto-capture
 *   - facts store      → renderFactsForInstructions (SQLite consolidated_facts, Stanford-ranked)
 *   - user profile     → renderProfileForInstructions
 *   - goals dir        → top active goals
 *
 * Each function is called fresh on every turn via the SDK's
 * instructions-as-function support (`getSystemPrompt` invokes it
 * every call). Edits to any of these files / stores surface
 * immediately on the next turn — no daemon restart, no cached
 * snapshot.
 */
import { loadMemoryContext } from '../memory/vault.js';
import { withInstructionMemory, type ModelMemoryManifestEntry } from '../runtime/harness/model-memory-evidence.js';
import { countActiveFacts, renderCorePoliciesForInstructions, renderFactsForInstructions, renderRecentlyLearnedForInstructions, searchFactsByText, type CorePolicyRender } from '../memory/facts.js';
import { getRuntimeEnv } from '../config.js';
import { getFocusSnapshot } from '../memory/focus.js';
import { renderRelevantSkillsForPrompt, renderSkillDiscoveryPrompt } from '../memory/skill-store.js';
import { renderToolChoicesForContext } from '../memory/tool-choice-store.js';
import { renderRunStrategiesForContext } from '../memory/run-strategy-store.js';
import { renderEstablishedDestinationsForContext } from '../runtime/harness/published-destinations.js';
import { renderSourceMapForContext } from '../memory/source-map.js';
import { listActiveGoalSummaries } from '../memory/goals-list.js';
import { loadWorkingMemoryForSession } from '../memory/working-memory.js';
import { listHeldTasks } from './plan-proposals.js';
import { loadUserProfile, renderProfileForInstructions } from '../runtime/user-profile.js';
import { loadProactivityPolicy } from './proactivity-policy.js';
import {
  modelParityEnabled,
  CACHE_BREAK_SENTINEL,
  CACHE_MEMORY_CONTEXT_SENTINEL,
  CACHE_MEMORY_APPEND_SENTINEL,
  CACHE_MEMORY_CORE_DELIM,
} from '../runtime/harness/model-wire-registry.js';
import { createHash } from 'node:crypto';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { renderRecentActionsForHarnessHistory } from '../runtime/harness/session-transcript.js';
import { appendFactRecallTrace } from '../memory/recall-trace.js';
import {
  renderResolvedActiveTaskContext,
  resolveActiveTaskContext,
} from '../runtime/harness/active-task-context.js';
import { classifyCurrentTaskInput } from '../runtime/harness/current-task-authority.js';

// Legacy chat and journey callers still import the focus-only view from this
// module. Keep that API while the harness itself consumes the richer shared
// active-task projection below.
export { renderFocusForInstructions } from '../runtime/harness/active-task-context.js';

function section(title: string, body: string | undefined | null): string {
  if (!body || !body.trim()) return '';
  return `## ${title}\n${body.trim()}`;
}

/**
 * Surface the user's approval posture (autoApproveScope) to the model. This is
 * the one piece of operational state the orchestrator was flying blind on:
 * without it, a YOLO user's Clem still defaults to caution — drafting
 * "require batch approval" steps and stopping to ask permission (via the
 * always-blocking ask_user_question) for actions she's already been told to do.
 * Telling her the posture is true state she lacked, not a prompt-hope rule.
 *
 * Two postures: 'yolo' → Auto-approve (the DEFAULT since 2026-07-20) renders the
 * standing-approval line; 'strict' → Approve/Supervised. 'workspace' stays the
 * hidden power-user line. (Legacy 'balanced' is coerced to 'strict' on read.)
 * An unknown value renders nothing (lean).
 */
export function renderAutonomy(): string {
  try {
    const scope = loadProactivityPolicy().autoApproveScope;
    if (scope === 'yolo') {
      return [
        'YOLO — the user has granted STANDING APPROVAL for reversible work such as drafts, local files, workspace updates, and recoverable API writes. Irreversible external sends/posts/calls and destructive actions remain exceptions: they require one concrete human or certified grant at the execution gate.',
        'Do NOT stop to ask permission for reversible work, do NOT add redundant approval steps, and do NOT use ask_user_question to seek sign-off on work already requested — just do it, then report what landed and any assumption you made. For an irreversible action, queue the exact payload and let the one approval card own the pause; never ask once in prose and again at the tool gate.',
        'You MAY still ask a genuine clarifying question when a fact cannot be inferred — set ask_user_question purpose:"clarification" for those. An approval-shaped ask auto-resolves only so the execution gate can apply the real policy; it is not permission to bypass an irreversible-action card.',
      ].join(' ');
    }
    if (scope === 'workspace') {
      return 'Workspace — actions on files/paths inside the user\'s workspace are pre-approved. Proceed on those without asking; still confirm before reaching outside the workspace or making irreversible external writes.';
    }
    if (scope === 'strict') {
      // Supervised / Approve (legacy 'balanced' is coerced to 'strict' on read).
      return 'Supervised — get an explicit plan/approval from the user (request_approval) before any mutating or external-write action.';
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Render the current local date/time, anchored to the user's saved
 * timezone (or the daemon-host timezone if no profile timezone is set).
 *
 * Without this, the model has to guess today's date from training data
 * (which is wrong by months) or ask the user — both bad. Calendar /
 * scheduling / "what's on my agenda today" requests depend on the
 * agent knowing what *now* is.
 *
 * Output shape:
 *   "Today is 2026-05-20 (Wednesday), local time 18:53 (America/Los_Angeles)."
 *
 * Errors degrade silently — a malformed profile timezone falls back
 * to the system's resolved timezone; if even that fails, the line is
 * just omitted from the persistent context.
 */
/** The owner's clock, read once per render so every line of a turn agrees. */
function currentLocalTime(now = new Date()): { date: string; weekday: string; time: string; tz: string } | null {
  try {
    const profile = loadUserProfile();
    const tz = profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    // Use `en-CA` for ISO-style date (YYYY-MM-DD) — most locale-stable
    // option for date formatting across runtimes.
    const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
    const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    return { date: dateFmt.format(now), weekday: weekdayFmt.format(now), time: timeFmt.format(now), tz };
  } catch {
    return null;
  }
}

export function renderCurrentTimeForInstructions(): string {
  const t = currentLocalTime();
  if (!t) return '';
  return `Today is ${t.date} (${t.weekday}), local time ${t.time} (${t.tz}). Use this for any date/time math, never invent or guess.`;
}

/**
 * The owner's clock, stated once, LAST in the per-turn context so it sits next
 * to the user's message: a model weights the tokens nearest the message, and
 * a clock read thousands of tokens earlier is the one a greeting gets wrong.
 * It carries the date-math rule the separate Now line used to carry. Ten-odd
 * tokens, uncached by design like the rest of the per-turn context.
 */
export function renderRightNowStamp(now = new Date()): string {
  const t = currentLocalTime(now);
  if (!t) return '';
  return `Right now it is ${t.weekday}, ${t.date}, ${t.time} (${t.tz}). Use this for any date/time math, never invent or guess.`;
}

// Per-line bound for injected memory content (recall bullets, constraint
// bodies). A single runaway fact must not blow the volatile context tail —
// but the cut is MARKED so the model knows to fetch the full fact rather
// than treat the visible prefix as complete (an operative URL/id can sit
// past the bound).
const CONTEXT_LINE_MAX_CHARS = 1000;
function clipContextLine(text: string): string {
  const t = text.trim();
  return t.length <= CONTEXT_LINE_MAX_CHARS
    ? t
    : `${t.slice(0, CONTEXT_LINE_MAX_CHARS)} …[truncated — search memory for the full fact]`;
}
/** Standing goals are advisory and live in their own store; none is bound to
 *  a session (the session's own goal contract renders with Current Focus).
 *  The per-turn context therefore names how many there are and where to read
 *  them, not their text. */
function renderActiveGoals(): string {
  const goals = listActiveGoalSummaries({ limit: 1_000 });
  if (goals.length === 0) return '';
  const blocked = goals.filter((goal) => goal.status === 'blocked').length;
  return `${goals.length} standing goal${goals.length === 1 ? '' : 's'} on file${blocked > 0 ? ` (${blocked} blocked)` : ''}: advisory only, never the current request; goal_list reads them.`;
}

/**
 * Build the persistent-context block that gets prepended to every
 * harness agent's role-specific instructions. Read-only: returns a
 * string each call. Errors in any individual source degrade
 * gracefully — a missing vault doesn't take the agent down.
 */

/**
 * The LEARNED-context blocks (Recently Learned + Remembered Tool Choices) —
 * the half of Clem's self that grows from use. Defined ONCE here and shared by
 * BOTH the harness assembler (below) and the chat assembler
 * (assistant/instructions.ts), so the surface you talk to and the surface that
 * runs long work see the SAME learned tools/facts. North-star Move 2 (one self):
 * before this, only the harness path surfaced these, so chat re-discovered tools
 * it had already learned. `objective` scopes the tool-choice ranking (chat blends
 * message+focus, harness uses the active focus). Returns the two SECTION strings
 * separately so each caller keeps its own block ordering. Best-effort.
 */
export function renderLearnedBlocks(
  objective?: string,
  focusScope?: { resourceRef?: string | null },
  options: { request?: string } = {},
): { recentlyLearned: string; toolChoices: string; establishedDestinations: string } {
  let recentlyLearned = '';
  try {
    // Keep only a compact recency bridge here. Durable detail already lives in
    // the typed fact/episode stores and is retrieved by the unified primer; the
    // call ids are retained so the model can still reopen exact raw evidence.
    recentlyLearned = section('Recently Learned (last 24h)', renderRecentlyLearnedForInstructions(24, 8, 1000));
  } catch {
    recentlyLearned = '';
  }
  let toolChoices = '';
  try {
    toolChoices = section('Remembered Tool Choices', renderToolChoicesForContext(12, undefined, objective));
  } catch {
    toolChoices = '';
  }
  // Learning loop (DREAM): proven run SHAPES ride the same block as proven
  // tool picks — a strategy is the level above a tool choice. Additive: no
  // matching strategy → '' → identical context to before this existed.
  try {
    const strategies = section('Proven Run Strategies', renderRunStrategiesForContext(objective, 2, options.request));
    if (strategies) toolChoices = [toolChoices, strategies].filter(Boolean).join('\n\n');
  } catch { /* strategy recall is best-effort */ }
  // Established deploy targets for the project under active focus — the AGENT
  // side of the destination gate↔recall unification (2026-06-21): surface WHERE
  // this project deploys so the agent updates the same site explicitly instead
  // of re-discovering / minting a new one / tripping the provenance gate.
  return { recentlyLearned, toolChoices, establishedDestinations: renderEstablishedDestinationsSection(focusScope) };
}

function renderEstablishedDestinationsSection(focusScope?: { resourceRef?: string | null }): string {
  try {
    // User-turn callers pass an explicit scoped value (including null). The
    // legacy no-options form retains the old global behavior for non-turn
    // readers that have no session identity.
    const focusRef = focusScope === undefined
      ? getFocusSnapshot().active?.resource_ref
      : focusScope.resourceRef ?? undefined;
    return section('Established Deploy Targets', renderEstablishedDestinationsForContext(focusRef));
  } catch {
    return '';
  }
}

/** The accepted request and the focus proven current for this session: the
 *  objective every request-ranked memory block ranks by. */
function resolveRequestObjective(sessionId: string | undefined, acceptedInput: string) {
  const activeTaskContext = resolveActiveTaskContext({ sessionId, input: acceptedInput });
  const scopedFocus = activeTaskContext.focus?.disposition === 'active'
    ? activeTaskContext.focus
    : null;
  const focusObjective = scopedFocus
    ? [scopedFocus.title, scopedFocus.summary ?? ''].filter(Boolean).join(' ').trim()
    : '';
  const requestObjective = [acceptedInput.trim(), focusObjective]
    .filter(Boolean)
    .join('\n') || undefined;
  return { activeTaskContext, scopedFocus, requestObjective };
}

/**
 * The request-ranked blocks each ranked by its own matcher: Persistent Facts,
 * Recently Learned, Data Landscape and Remembered Tool Choices (with Proven
 * Run Strategies). The harness prompt sends these only when the shared ranker
 * gave no signal (renderTurnMemoryTail); the legacy composition always does.
 */
function renderRequestRankedBlocks(input: {
  requestObjective: string | undefined;
  acceptedInput: string;
  scopedFocus: { resourceRef?: string | null } | null;
  includeRememberedToolChoices?: boolean;
  omitCoreGroups: boolean;
}): Array<{ title: string; text: string }> {
  let facts = '';
  try {
    // The literal accepted request ranks first; only a focus proven current
    // for this session may refine it. Process-global focus never scopes a
    // different task branch.
    facts = renderFactsForInstructions(10, 2600, input.requestObjective, 'all', { omitCoreGroups: input.omitCoreGroups });
  } catch {
    facts = '';
  }
  // Learned context (Recently Learned + Remembered Tool Choices) — shared with
  // the chat assembler via renderLearnedBlocks so both surfaces see the same
  // learned tools/facts. RANKING OBJECTIVE = current message BLENDED with the
  // active focus, so a request with an unrelated focus still promotes the
  // tool memo that fits the request. The chat assembler blends the same way.
  const { recentlyLearned, toolChoices } = renderLearnedBlocks(
    input.requestObjective,
    { resourceRef: input.scopedFocus?.resourceRef ?? null },
    { request: input.acceptedInput },
  );
  // Source-map / landscape memory — a pointer-first index of WHERE the user's
  // data lives, scoped to the active objective. Off (flag) → ''.
  let dataLandscape = '';
  try {
    dataLandscape = renderSourceMapForContext(24, undefined, input.requestObjective);
  } catch {
    dataLandscape = '';
  }
  return [
    { title: 'Persistent Facts', text: section('Persistent Facts', facts) },
    { title: 'Recently Learned', text: recentlyLearned },
    { title: 'Data Landscape', text: section('Data Landscape', dataLandscape) },
    { title: 'Remembered Tool Choices', text: input.includeRememberedToolChoices === false ? '' : toolChoices },
  ];
}

/** Held-for-later tasks for THIS session, so the model can resurface one when
 *  the user references it ("pick up the Salesforce scrape"). Session-scoped so a
 *  held task from another chat never leaks in. '' when none. */
const HELD_TASKS_SHOWN = 3;
/** Session working memory is a checkpoint of the conversation so far; its
 *  full text stays in the session's record. */
const WORKING_MEMORY_PROMPT_MAX_CHARS = 600;

function clipLine(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function clipWorkingMemory(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed || trimmed.length <= WORKING_MEMORY_PROMPT_MAX_CHARS) return trimmed || undefined;
  return `${trimmed.slice(0, WORKING_MEMORY_PROMPT_MAX_CHARS).trimEnd()}\n… working memory clipped here; the full checkpoint stays in this conversation's record.`;
}

function renderHeldTasks(sessionId?: string): string {
  if (!sessionId) return '';
  try {
    const held = listHeldTasks(sessionId);
    if (held.length === 0) return '';
    const shown = held.slice(0, HELD_TASKS_SHOWN);
    return [
      'Tasks you agreed to HOLD for later (the user can resume one by reference — then call resume_held_task with its id):',
      ...shown.map((h) => `  - ${h.id} — ${clipLine(h.plan.objective, 160)}`),
      ...(held.length > shown.length ? [`  - …and ${held.length - shown.length} more held in this conversation.`] : []),
    ].join('\n');
  } catch {
    return '';
  }
}

// Query-driven recall: how many request-relevant facts to surface. Parity with
// the main harness loop's per-turn memory primer.
const QUERY_RECALL_LIMIT = 6;
function queryRecallEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BRAIN_QUERY_RECALL', 'on') ?? 'on').trim().toLowerCase() !== 'off';
}

/**
 * The blocks that change turn-to-turn within a single conversation — the current
 * time, the per-message query recall, the live focus/goals/held/working-memory.
 * Splitting these out (partition:'stable' vs 'volatile') lets a caller put the
 * STABLE memory in a cacheable system prefix and the VOLATILE tail in the
 * (never-cached) user turn, so the big stable context stops re-billing every turn
 * on the Claude lanes (Phase 3 #1, the largest token sink).
 */
const VOLATILE_CONTEXT_TITLES = new Set<string>([
  'Now',
  'Right Now',
  'Relevant To Your Request',
  'Relevant Skills',
  'Completed Actions This Conversation',
  'Working Memory',
  'Active Goals',
  'Held For Later',
  'Current Focus',
  'Offer Being Discussed',
]);

type HarnessMemoryContextOptions = {
  sessionId?: string;
  sourceUserSeq?: number;
  query?: string;
  /** Current accepted user input used only to decide whether a cross-session
   * focus summary is historical. Unlike `query`, this does not enable recall or
   * skill ranking. */
  focusInput?: string;
  partition?: 'all' | 'stable' | 'volatile';
  includeRememberedToolChoices?: boolean;
  includeSessionActions?: boolean;
  /** 'variable': everything the memory core (renderMemoryCore) does not
   *  carry, under the per-turn header. The harness prompt sends the core in
   *  its cached prefix and this after the cache boundary. */
  layout?: 'legacy' | 'variable';
};

export function renderHarnessMemoryContext(opts?: HarnessMemoryContextOptions): string {
  return composeHarnessMemoryContext(opts).text;
}

/** Sections that carry request-ranked memory; the rest of the per-turn
 *  context is the conversation's right-now state. */
const RELEVANT_CONTEXT_TITLES = new Set<string>([
  'Relevant To Your Request',
  'Relevant Skills',
  'Persistent Facts',
  'Recently Learned',
  'Data Landscape',
  'Remembered Tool Choices',
]);

function composeHarnessMemoryContext(opts?: HarnessMemoryContextOptions): { text: string; manifest: MemoryManifestEntry[] } {
  const variableLayout = opts?.layout === 'variable';
  let memContext;
  try {
    memContext = loadMemoryContext();
  } catch {
    memContext = {};
  }

  const partition = opts?.partition ?? 'all';
  const acceptedInput = opts?.focusInput ?? opts?.query ?? '';
  const inputDisposition = classifyCurrentTaskInput(acceptedInput);
  const { activeTaskContext, scopedFocus, requestObjective } = resolveRequestObjective(opts?.sessionId, acceptedInput);

  // PHANTOM IMPRESSIONS killed (COMPOUNDING wave): Persistent Facts is a
  // STABLE-partition block; rendering it on a volatile-only pass recorded an
  // impression per fact per turn for text the model never received — the
  // measured live inflation behind the 1,735:1 impression:use ratio. Render
  // (and count) only when the partition actually delivers the block. The
  // variable layout never delivers them: the turn's one ranked tail does.
  const rankedBlocks = partition !== 'volatile' && !variableLayout
    ? renderRequestRankedBlocks({
        requestObjective,
        acceptedInput,
        scopedFocus,
        includeRememberedToolChoices: opts?.includeRememberedToolChoices,
        omitCoreGroups: false,
      })
    : [];
  const rankedText = (title: string): string => rankedBlocks.find((block) => block.title === title)?.text ?? '';
  const establishedDestinations = renderEstablishedDestinationsSection({ resourceRef: scopedFocus?.resourceRef ?? null });

  let profile = '';
  try {
    profile = renderProfileForInstructions();
  } catch {
    profile = '';
  }

  // A pivot revokes the prior task's control authority; it does not erase what
  // happened in this conversation. Keep goals/held work visible as explicitly
  // advisory history while the typed Active Task projection below decides what
  // (if anything) may steer this turn.
  const goals = renderActiveGoals();
  const heldTasks = renderHeldTasks(opts?.sessionId);
  let offerContext = '';
  if (partition !== 'stable' && opts?.sessionId && opts.sourceUserSeq) {
    try { offerContext = proactiveOfferContextForTurn(opts.sessionId, opts.sourceUserSeq); }
    catch { /* Optional offer context cannot prevent ordinary chat. */ }
  }
  const sessionWorkingMemory = opts?.sessionId
    ? loadWorkingMemoryForSession(opts.sessionId)
    : undefined;
  const workingMemory = clipWorkingMemory(opts?.sessionId
    ? sessionWorkingMemory ?? (inputDisposition === 'resume' ? memContext.workingMemory : undefined)
    : memContext.workingMemory);
  let sessionActions = '';
  if (opts?.sessionId && opts.includeSessionActions !== false) {
    try {
      sessionActions = renderRecentActionsForHarnessHistory(openEventLog(), opts.sessionId);
    } catch {
      sessionActions = '';
    }
  }

  let skillDiscovery = '';
  let relevantSkills = '';
  if (partition !== 'volatile') {
    try { skillDiscovery = renderSkillDiscoveryPrompt(); } catch { skillDiscovery = ''; }
  }
  if (partition !== 'stable') {
    try { relevantSkills = renderRelevantSkillsForPrompt(opts?.query ?? ''); } catch { relevantSkills = ''; }
  }

  // Active task block — one typed projection composes Current Focus with this
  // session's exact active goal. It is rendered once per turn and remains in
  // the volatile partition for every provider lane.
  const activeTask = renderResolvedActiveTaskContext(activeTaskContext);

  // Query-driven recall (parity with the main harness loop's buildTurnMemoryPrimer):
  // surface the consolidated facts MOST RELEVANT to the user's CURRENT message. A
  // brain that runs on this self-assembled context (the Claude Agent SDK lane) only
  // got the GENERAL top-N "Persistent Facts" block, so it was blind to request-
  // specific knowledge — e.g. "priority account = Account.Priority_Account__c is true" —
  // and rediscovered it via tool thrash (2026-06-29). Recall it up front so the brain
  // KNOWS instead of relearning. Caller passes the user's message; kill-switch
  // CLEMMY_BRAIN_QUERY_RECALL. Empty query / flag off ⇒ '' (byte-identical).
  let requestRecall = '';
  const recallQuery = (opts?.query ?? '').replace(/\s+/g, ' ').trim();
  if (recallQuery && queryRecallEnabled()) {
    try {
      const hits = searchFactsByText(recallQuery, QUERY_RECALL_LIMIT);
      if (hits.length > 0) {
        requestRecall = hits.map((f) => `- ${clipContextLine(String(f.content ?? ''))}`).filter((l) => l.length > 2).join('\n');
        appendFactRecallTrace({
          surface: 'harness_query_recall',
          query: recallQuery,
          sessionId: opts?.sessionId,
          facts: hits.map((fact) => ({ fact, reason: 'lexical-query-match' })),
        });
      }
    } catch { requestRecall = ''; }
  }

  // Title each block so a caller can request only the STABLE half (cacheable
  // system prefix) or only the VOLATILE tail (sent in the user turn). Order is
  // preserved exactly, so partition:'all' is byte-identical to the prior output.
  const tagged: Array<{ title: string; text: string }> = [
    { title: 'Offer Being Discussed', text: section('Offer Being Discussed', offerContext) },
    { title: 'Autonomy', text: section('Autonomy', renderAutonomy()) },
    { title: 'Relevant To Your Request', text: section('Relevant To Your Request', requestRecall) },
    { title: 'Completed Actions This Conversation', text: section('Completed Actions This Conversation', sessionActions) },
    { title: 'User Preferences', text: section('User Preferences', profile) },
    { title: 'Persistent Facts', text: rankedText('Persistent Facts') },
    { title: 'Recently Learned', text: rankedText('Recently Learned') },
    { title: 'Data Landscape', text: rankedText('Data Landscape') },
    { title: 'Remembered Tool Choices', text: rankedText('Remembered Tool Choices') },
    { title: 'Established Destinations', text: establishedDestinations },
    { title: 'Working Memory', text: section('Working Memory', workingMemory) },
    { title: 'Identity', text: section('Identity', memContext.identity) },
    { title: 'Core Personality', text: section('Core Personality', memContext.soul) },
    { title: 'Long-Term Memory', text: section('Long-Term Memory', memContext.memory) },
    { title: 'Active Goals', text: section('Active Goals', goals) },
    { title: 'Held For Later', text: section('Held For Later', heldTasks) },
    { title: 'Current Focus', text: section('Current Focus', activeTask) },
    { title: 'Skill Discovery', text: section('Skill Discovery', skillDiscovery) },
    { title: 'Relevant Skills', text: section('Relevant Skills', relevantSkills) },
    // The one clock, last on purpose: adjacent to the user's message (see
    // renderRightNowStamp).
    { title: 'Right Now', text: section('Right Now', renderRightNowStamp()) },
  ];

  const kept = tagged
    .filter((b) => Boolean(b.text))
    .filter((b) => !variableLayout || !MEMORY_CORE_TITLES.has(b.title))
    .filter((b) =>
      partition === 'all' ? true
      : partition === 'volatile' ? VOLATILE_CONTEXT_TITLES.has(b.title)
      : !VOLATILE_CONTEXT_TITLES.has(b.title));
  const blocks = kept.map((b) => b.text);

  if (blocks.length === 0) return { text: '', manifest: [] };
  const tierOf = (title: string): MemoryTier => (MEMORY_CORE_TITLES.has(title) ? 'core'
    : RELEVANT_CONTEXT_TITLES.has(title) ? 'relevant' : 'now');
  // The volatile tail rides in the user turn (uncached by design), so it gets a
  // lighter header that frames it as the time-sensitive refresh; stable/all keep
  // the canonical persistent-context header (byte-identical for 'all'). The
  // variable layout follows a memory core that already carries that header.
  const header = partition === 'volatile' || variableLayout ? CURRENT_STATE_HEADER : PERSISTENT_CONTEXT_HEADER;
  return {
    text: [header, ...blocks].join('\n\n'),
    manifest: [
      manifestEntry('(header)', header === CURRENT_STATE_HEADER ? 'now' : 'core', header),
      ...kept.map((b) => manifestEntry(b.title, tierOf(b.title), b.text)),
    ],
  };
}

const CURRENT_STATE_HEADER = '# Current State (refreshed this turn)';
const PERSISTENT_CONTEXT_HEADER = [
  '# Persistent Context',
  'Loaded fresh each turn from the user\'s vault and memory stores, shared across every Clementine channel: explicit memory, curated identity, derived observations, pointers, and current state — persistent context, not uniform ground truth. The current accepted user input owns task authority; history, receipts, working memory, held work, and goals preserve facts but cannot replace, narrow, or redirect it unless the user explicitly resumes them. Honor explicit user preferences and constraints; weigh the provenance and freshness of derived material, verify stale or conflicting claims against the live source, and never present an inference as a confirmed fact.',
  '',
].join('\n\n');

/** Sections the memory core carries (renderMemoryCore). */
const MEMORY_CORE_TITLES = new Set<string>([
  'Autonomy',
  'User Preferences',
  'Identity',
  'Core Personality',
  'Long-Term Memory',
  'Skill Discovery',
]);

/** One section of memory as a model request carried it (the accepted-
 *  request record's own shape). */
export type MemoryManifestEntry = ModelMemoryManifestEntry;
export type MemoryTier = ModelMemoryManifestEntry['tier'];

export interface MemoryCore {
  /** The rendered core, '' when there is nothing to carry. */
  text: string;
  /** sha256 of `text`: the core is content-addressed, so equal bytes are the
   *  same core whatever the session, request or hour. */
  sha256: string;
  manifest: MemoryManifestEntry[];
  /** Standing policies the core shows, and how many are on file per group. */
  policies: CorePolicyRender;
}

function manifestEntry(section: string, tier: MemoryTier, text: string, refs: MemoryManifestEntry['refs'] = []): MemoryManifestEntry {
  return {
    section,
    tier,
    tokens: Math.ceil(text.length / 4),
    bytes: Buffer.byteLength(text, 'utf8'),
    refs,
  };
}

/**
 * The memory that applies to every request, rendered from content alone: who
 * Clementine is and how she speaks (identity, soul, curated long-term memory,
 * all as today), the owner's profile and approval posture, the standing
 * policies every request is held to (dispatch-enforced constraints, one line
 * each, and the core profile), and the pointer to skills. No clock, no
 * request, no ranking and no impressions go into it, and its order is the
 * stores' own, so the same memory renders the same bytes for every session
 * and turn. That is what lets it sit before the cache boundary: it is
 * re-billed only when the owner's memory changes.
 */
export function renderMemoryCore(): MemoryCore {
  let memContext: ReturnType<typeof loadMemoryContext>;
  try { memContext = loadMemoryContext(); } catch { memContext = {} as ReturnType<typeof loadMemoryContext>; }
  let profile = '';
  try { profile = renderProfileForInstructions(); } catch { profile = ''; }
  let policies: CorePolicyRender;
  try {
    policies = renderCorePoliciesForInstructions();
  } catch {
    policies = { text: '', refs: [], counts: { dispatchConstraint: 0, coreProfile: 0, promptInstruction: 0, standingPreference: 0 } };
  }
  let skillDiscovery = '';
  try { skillDiscovery = renderSkillDiscoveryPrompt(); } catch { skillDiscovery = ''; }
  const sections: Array<{ title: string; text: string; refs?: MemoryManifestEntry['refs'] }> = [
    { title: 'Autonomy', text: section('Autonomy', renderAutonomy()) },
    { title: 'User Preferences', text: section('User Preferences', profile) },
    { title: 'Standing Policies', text: section('Standing Policies', policies.text), refs: policies.refs },
    { title: 'Identity', text: section('Identity', memContext.identity) },
    { title: 'Core Personality', text: section('Core Personality', memContext.soul) },
    { title: 'Long-Term Memory', text: section('Long-Term Memory', memContext.memory) },
    { title: 'Skill Discovery', text: section('Skill Discovery', skillDiscovery) },
  ].filter((entry) => Boolean(entry.text));
  if (sections.length === 0) {
    return { text: '', sha256: createHash('sha256').update('').digest('hex'), manifest: [], policies };
  }
  const text = [PERSISTENT_CONTEXT_HEADER, ...sections.map((entry) => entry.text)].join('\n\n');
  return {
    text,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    manifest: [
      manifestEntry('(header)', 'core', PERSISTENT_CONTEXT_HEADER),
      ...sections.map((entry) => manifestEntry(entry.title, 'core', entry.text, entry.refs ?? [])),
    ],
    policies,
  };
}

/**
 * Prepend persistent context to a role's static rubric. Use this as
 * the `instructions` value on each harness Agent — the SDK calls it
 * once per turn via getSystemPrompt, so vault edits surface
 * immediately on the next turn.
 */
export function harnessInstructions(roleInstructions: string, opts?: {
  sessionId?: string;
  sourceUserSeq?: number;
  focusInput?: string;
  includeRememberedToolChoices?: boolean;
  includeSessionActions?: boolean;
  /** The saved agent this session works in: its standing instructions and
   *  pinned skills. Stable for the life of the session, so it joins the
   *  identity/rubric prefix before the cache boundary. */
  agentInstructions?: string;
  /** Per-accepted-turn rules, frozen authority and catalog disclosures. These
   *  remain model-visible but MUST sit after the stable rubric boundary. */
  volatileInstructions?: string;
  /** Memory-derived text assembled outside renderHarnessMemoryContext (for
   *  example workflow tool-choice recall). It shares the memory suffix rather
   *  than masquerading as current-turn policy. */
  volatileMemoryInstructions?: string;
}): () => string {
  // One constructed Agent represents one accepted turn/step activation but
  // may make several model calls. Snapshot memory at construction so tool
  // results appended during that activation cannot silently rewrite the
  // accepted-turn context, move the prompt-cache boundary, or make later model
  // cycles observe a different memory primer. The next genuine turn rebuilds
  // the Agent and therefore receives a fresh snapshot.
  // The core is content-addressed and joins the cached prefix after the
  // rubric; everything request- or time-dependent follows the boundary.
  const core = renderMemoryCore();
  const variable = composeHarnessMemoryContext({
    sessionId: opts?.sessionId,
    sourceUserSeq: opts?.sourceUserSeq,
    focusInput: opts?.focusInput,
    includeRememberedToolChoices: opts?.includeRememberedToolChoices,
    includeSessionActions: opts?.includeSessionActions,
    layout: 'variable',
  });
  const ctx = variable.text;
  const agentInstructions = opts?.agentInstructions?.trim() ?? '';
  const stableRole = [roleInstructions, agentInstructions].filter(Boolean).join('\n\n');
  const stablePrefix = core.text ? `${stableRole}${CACHE_MEMORY_CORE_DELIM}${core.text}` : stableRole;
  const volatileInstructions = opts?.volatileInstructions?.trim() ?? '';
  const volatileMemoryInstructions = opts?.volatileMemoryInstructions?.trim() ?? '';
  const historicalRole = [stableRole, volatileInstructions].filter(Boolean).join('\n\n');
  const dynamic = [
    volatileInstructions,
    ...(ctx ? [CACHE_MEMORY_CONTEXT_SENTINEL, ctx] : []),
    ...(volatileMemoryInstructions
      ? [CACHE_MEMORY_APPEND_SENTINEL, volatileMemoryInstructions]
      : []),
  ].filter(Boolean).join('\n\n');
  const legacyMemory = [core.text, ctx].filter(Boolean).join('\n\n');
  const rendered = modelParityEnabled() && dynamic
    // The rubric and the memory core precede the boundary. Every current-turn
    // authority/catalog byte and every per-turn memory byte follows it, so
    // changing either can invalidate only its own suffix rather than
    // re-billing policy; the core has its own marker so a wire can cache it
    // apart from the rubric.
    ? `${stablePrefix}\n\n${CACHE_BREAK_SENTINEL}\n\n${dynamic}`
    // Kill-switch/legacy path retains the historical order: memory first,
    // separator, then role + the per-turn instruction trailer.
    : [
        legacyMemory ? `${legacyMemory}\n\n---\n\n${historicalRole}` : historicalRole,
        volatileMemoryInstructions,
      ].filter(Boolean).join('\n\n');
  // Each fragment carries its sections, so the accepted-request record can
  // say what memory was sent, by tier, without re-reading any store.
  const instructions = withInstructionMemory(() => rendered, [
    { text: core.text, manifest: core.manifest, coreSha: core.sha256 },
    { text: ctx, manifest: variable.manifest },
    { text: volatileMemoryInstructions, manifest: [manifestEntry('(appended)', 'relevant', volatileMemoryInstructions)] },
  ]);
  const coreRefKeys = new Set<string>();
  for (const ref of core.policies.refs) {
    coreRefKeys.add(`policy:${ref.id}`);
    coreRefKeys.add(`fact:${ref.id}`);
  }
  memoryTailScopes.set(instructions, {
    sessionId: opts?.sessionId,
    focusInput: opts?.focusInput,
    includeRememberedToolChoices: opts?.includeRememberedToolChoices,
    coreRefKeys,
    policyCounts: core.policies.counts,
  });
  return instructions;
}

/** What the turn's ranked tail needs to know about the prompt it joins. */
export interface MemoryTailScope {
  sessionId?: string;
  focusInput?: string;
  includeRememberedToolChoices?: boolean;
  /** `type:id` of every policy the memory core already shows. */
  coreRefKeys: ReadonlySet<string>;
  policyCounts: CorePolicyRender['counts'];
}

const memoryTailScopes = new WeakMap<Function, MemoryTailScope>();

/** The tail scope of an agent's instructions when harnessInstructions built
 *  them; undefined for any other instructions, whose turns keep the plain
 *  memory primer. */
export function memoryTailScopeFor(instructions: unknown): MemoryTailScope | undefined {
  return typeof instructions === 'function' ? memoryTailScopes.get(instructions) : undefined;
}

/** Budget of the ranked tail: heading, rule, ranked lines and the one
 *  proven-run line together. The counts pointer is outside it. */
export const RANKED_TAIL_MAX_CHARS = 1_200;
/** How the tail picks from the shared ranker's hits: a hit must score at
 *  least half of the best one; up to two request-relevant standing policies
 *  are placed first whatever their rank; the core's policies are not
 *  repeated. */
export const RANKED_TAIL_RELATIVE_FLOOR = 0.5;
export const RANKED_TAIL_POLICY_SLOTS = 2;

/** What the shared ranker gave the turn. */
export type TurnMemorySignal =
  /** Ranked hits, already rendered as the tail's heading, rule and lines. */
  | { kind: 'ranked'; text: string; refs: Array<{ type: string; id: string }> }
  /** The ranker ran and nothing cleared it. */
  | { kind: 'empty' }
  /** The ranker is off, failed or ran out of time. */
  | { kind: 'no_signal'; primerText?: string };

export interface TurnMemoryTail {
  text: string;
  manifest: MemoryManifestEntry[];
}

function countsPointer(scope: MemoryTailScope): string {
  let facts = 0;
  try { facts = countActiveFacts(); } catch { facts = 0; }
  const parts = [
    facts > 0 ? `${facts} fact${facts === 1 ? '' : 's'}` : '',
    scope.policyCounts.promptInstruction > 0
      ? `${scope.policyCounts.promptInstruction} prompt-only rule${scope.policyCounts.promptInstruction === 1 ? '' : 's'}` : '',
    scope.policyCounts.standingPreference > 0
      ? `${scope.policyCounts.standingPreference} standing preference${scope.policyCounts.standingPreference === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  if (parts.length === 0) return '';
  return `_Memory on file beyond this view: ${parts.join(', ')}. memory_recall_all searches all of it for this request._`;
}

/**
 * The turn's one request-ranked memory tail, rendered after the ranker has
 * answered. It replaces the blocks that each ranked memory by their own
 * matcher (Persistent Facts' scored tail and request-ranked policies,
 * Recently Learned, Data Landscape, Remembered Tool Choices, Proven Run
 * Strategies) and the separate memory primer:
 *   - ranked: the ranker's hits (at most RANKED_TAIL_MAX_CHARS with one
 *     proven run that covers the request), then a counts pointer;
 *   - empty: the counts pointer alone;
 *   - no signal: the per-block rendering exactly as before, then whatever
 *     fallback primer the host built, so a blind ranker costs nothing.
 * Session breadcrumbs (`sessionPointers`) ride along in every case.
 */
export function renderTurnMemoryTail(
  scope: MemoryTailScope,
  signal: TurnMemorySignal,
  options: { request?: string; sessionPointers?: string } = {},
): TurnMemoryTail {
  const parts: Array<{ section: string; tier: MemoryTier; text: string; refs?: MemoryManifestEntry['refs'] }> = [];
  if (signal.kind === 'no_signal') {
    // A blind ranker must cost nothing: the per-block rendering stands in,
    // ranked by the same objective the prompt used before, minus the
    // policies the memory core already carries.
    const acceptedInput = scope.focusInput ?? options.request ?? '';
    const { scopedFocus, requestObjective } = resolveRequestObjective(scope.sessionId, acceptedInput);
    for (const block of renderRequestRankedBlocks({
      requestObjective,
      acceptedInput,
      scopedFocus,
      includeRememberedToolChoices: scope.includeRememberedToolChoices,
      omitCoreGroups: true,
    })) {
      if (block.text) parts.push({ section: block.title, tier: 'relevant', text: block.text });
    }
    if (signal.primerText) parts.push({ section: 'Memory Primer', tier: 'relevant', text: signal.primerText });
  } else {
    if (signal.kind === 'ranked' && signal.text) {
      parts.push({ section: 'Relevant To This Request', tier: 'relevant', text: signal.text, refs: signal.refs });
    }
    const strategy = signal.kind === 'ranked' && options.request
      ? renderRunStrategiesForContext(options.request, 1, options.request)
      : '';
    if (strategy) parts.push({ section: 'Proven Run Strategies', tier: 'relevant', text: section('Proven Run Strategies', strategy) });
    const pointer = countsPointer(scope);
    if (pointer) parts.push({ section: 'Memory Pointer', tier: 'relevant', text: pointer });
  }
  if (options.sessionPointers?.trim()) {
    parts.push({ section: 'Session Pointers', tier: 'now', text: options.sessionPointers.trim() });
  }
  const text = parts.map((part) => part.text).join('\n\n');
  return {
    text,
    manifest: parts.map((part) => manifestEntry(part.section, part.tier, part.text, part.refs ?? [])),
  };
}

/** The ranked tail's hit budget once the one proven-run line is set aside. */
export function rankedTailHitBudget(request: string): number {
  let strategy = '';
  try { strategy = section('Proven Run Strategies', renderRunStrategiesForContext(request, 1, request)); } catch { strategy = ''; }
  return Math.max(300, RANKED_TAIL_MAX_CHARS - (strategy ? strategy.length + 2 : 0));
}
