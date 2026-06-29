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
import { renderFactsForInstructions, renderRecentlyLearnedForInstructions, listConstraints, searchFactsByText } from '../memory/facts.js';
import { getRuntimeEnv } from '../config.js';
import { getActiveObjective, getFocusSnapshot } from '../memory/focus.js';
import { renderSkillsIndex } from '../memory/skill-store.js';
import { renderToolChoicesForContext } from '../memory/tool-choice-store.js';
import { renderEstablishedDestinationsForContext } from '../runtime/harness/published-destinations.js';
import { renderSourceMapForContext } from '../memory/source-map.js';
import { listActiveGoalSummaries } from '../memory/goals-list.js';
import { listHeldTasks } from './plan-proposals.js';
import { loadUserProfile, renderProfileForInstructions } from '../runtime/user-profile.js';
import { loadProactivityPolicy } from './proactivity-policy.js';
import { modelParityEnabled, CACHE_BREAK_SENTINEL } from '../runtime/harness/model-wire-registry.js';

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
 * `balanced` (the default the static instructions already assume) renders
 * nothing, so the common case is byte-identical and the block stays lean.
 */
export function renderAutonomy(): string {
  try {
    const scope = loadProactivityPolicy().autoApproveScope;
    if (scope === 'yolo') {
      return [
        'YOLO — the user has granted STANDING APPROVAL for every action except the hard catastrophic-danger denylist (deleting data, destructive shell, etc.). You ALREADY have permission to send, draft, write, update, post, and deploy.',
        'So do NOT stop to ask permission to proceed, do NOT add "await/require approval" steps to a plan, and do NOT use ask_user_question to get sign-off on work you were asked to do — just do it, then report what you did and any assumption you made. Reusing an approved template or the same approach as the items already handled counts as proceeding, not a blocker.',
        'You MAY still ask a genuine clarifying question when you truly cannot infer something you need to act — set ask_user_question purpose:"clarification" for those (they still pause). An "approval" purpose will NOT pause in this mode (it auto-resolves to "proceed"). If you ever need a real human decision, use request_approval (it auto-approves here and keeps you moving) — never ask_user_question to seek sign-off.',
      ].join(' ');
    }
    if (scope === 'workspace') {
      return 'Workspace — actions on files/paths inside the user\'s workspace are pre-approved. Proceed on those without asking; still confirm before reaching outside the workspace or making irreversible external writes.';
    }
    if (scope === 'strict') {
      return 'Careful — get an explicit plan/approval from the user (request_approval) before any mutating or external-write action.';
    }
    return ''; // balanced: the assumed default; no extra line needed
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
export function renderCurrentTimeForInstructions(): string {
  try {
    const profile = loadUserProfile();
    const tz = profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const now = new Date();
    // Use `en-CA` for ISO-style date (YYYY-MM-DD) — most locale-stable
    // option for date formatting across runtimes.
    const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' });
    const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const date = dateFmt.format(now);
    const weekday = weekdayFmt.format(now);
    const time = timeFmt.format(now);
    return `Today is ${date} (${weekday}), local time ${time} (${tz}). Use this for any date/time math, never invent or guess.`;
  } catch {
    return '';
  }
}

/**
 * Render the Current Focus block (active / stale / parked). Extracted so BOTH
 * the harness self-assembler and the chat assembler emit the SAME focus surface
 * (CANON-SELFASM) — chat previously had none, forcing a focus_get every turn.
 * Returns the inner content (wrap with section('Current Focus', …)); '' on no
 * focus or error.
 */
export function renderFocusForInstructions(): string {
  let focus = '';
  try {
    const snap = getFocusSnapshot();
    if (snap.active && !snap.needsConfirm) {
      focus = [
        `ACTIVE focus #${snap.active.id}: ${snap.active.title}`,
        `Summary: ${snap.active.summary}`,
        `Resource: ${snap.active.resource_ref}${snap.active.resource_kind ? ` (${snap.active.resource_kind})` : ''}`,
        `Last touched: ${snap.active.last_touched_at}`,
      ].join('\n');
      if (snap.parked.length > 0) {
        focus += `\n\nParked (resumable via focus_activate):\n`
          + snap.parked.slice(0, 5).map((p) => `  - #${p.id} ${p.title}`).join('\n');
      }
    } else if (snap.active && snap.needsConfirm) {
      focus = [
        'No confirmed active focus.',
        `STALE focus #${snap.active.id}: ${snap.active.title}`,
        `Summary: ${snap.active.summary}`,
        `Resource: ${snap.active.resource_ref}${snap.active.resource_kind ? ` (${snap.active.resource_kind})` : ''}`,
        `Last touched: ${snap.active.last_touched_at}`,
        'Do not treat the stale focus as authoritative. If the user is clearly continuing it, call focus_touch(id). If the user moved on or asks for unrelated work, call focus_clear(id, resolution:"abandoned") or focus_park(id, reason) before proceeding.',
      ].join('\n');
      if (snap.parked.length > 0) {
        focus += `\n\nParked (resumable via focus_activate):\n`
          + snap.parked.slice(0, 5).map((p) => `  - #${p.id} ${p.title}`).join('\n');
      }
    } else if (snap.parked.length > 0) {
      focus = 'No active focus. Parked threads (resumable):\n'
        + snap.parked.slice(0, 5).map((p) => `  - #${p.id} ${p.title} — ${p.summary}`).join('\n');
    }
  } catch {
    focus = '';
  }
  return focus;
}

const CONSTRAINTS_SHOWN = 20;
function renderActiveConstraints(): string {
  try {
    // listConstraints() (no arg) returns ALL active constraints — the same set
    // the dispatch gate enforces. We DISPLAY the most important CONSTRAINTS_SHOWN
    // (importance-ranked), but never silently hide the rest: a count note makes
    // clear they're still ACTIVE and ENFORCED, so the model never assumes a
    // constraint it doesn't see has lapsed.
    const all = listConstraints();
    if (all.length === 0) return '';
    const shown = all.slice(0, CONSTRAINTS_SHOWN);
    let out = shown.map((c) => `- ${c.content}`).join('\n');
    if (all.length > shown.length) {
      out += `\n_(+${all.length - shown.length} more standing constraints are ACTIVE and ENFORCED on tool dispatch, not all shown here.)_`;
    }
    return out;
  } catch {
    return '';
  }
}

function renderActiveGoals(): string {
  const goals = listActiveGoalSummaries({ limit: 8, sortByPriority: true });
  if (goals.length === 0) return '';
  return goals
    .map((g) => {
      const next = g.nextActions?.[0] ? ` → ${g.nextActions[0]}` : '';
      const due = g.targetDate ? ` (due ${g.targetDate})` : '';
      const status = g.status === 'blocked' ? ' [BLOCKED]' : '';
      return `- [${g.id}] ${g.title}${status}${due}${next}`;
    })
    .join('\n');
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
export function renderLearnedBlocks(objective?: string): { recentlyLearned: string; toolChoices: string; establishedDestinations: string } {
  let recentlyLearned = '';
  try {
    recentlyLearned = section('Recently Learned (last 24h)', renderRecentlyLearnedForInstructions(24, 15));
  } catch {
    recentlyLearned = '';
  }
  let toolChoices = '';
  try {
    toolChoices = section('Remembered Tool Choices', renderToolChoicesForContext(12, undefined, objective));
  } catch {
    toolChoices = '';
  }
  // Established deploy targets for the project under active focus — the AGENT
  // side of the destination gate↔recall unification (2026-06-21): surface WHERE
  // this project deploys so the agent updates the same site explicitly instead
  // of re-discovering / minting a new one / tripping the provenance gate.
  let establishedDestinations = '';
  try {
    const focusRef = getFocusSnapshot().active?.resource_ref;
    establishedDestinations = section('Established Deploy Targets', renderEstablishedDestinationsForContext(focusRef));
  } catch {
    establishedDestinations = '';
  }
  return { recentlyLearned, toolChoices, establishedDestinations };
}

/** Held-for-later tasks for THIS session, so the model can resurface one when
 *  the user references it ("pick up the Salesforce scrape"). Session-scoped so a
 *  held task from another chat never leaks in. '' when none. */
function renderHeldTasks(sessionId?: string): string {
  if (!sessionId) return '';
  try {
    const held = listHeldTasks(sessionId);
    if (held.length === 0) return '';
    return [
      'Tasks you agreed to HOLD for later (the user can resume one by reference — then call resume_held_task with its id):',
      ...held.slice(0, 8).map((h) => `  - ${h.id} — ${h.plan.objective}`),
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

export function renderHarnessMemoryContext(opts?: { sessionId?: string; query?: string }): string {
  let memContext;
  try {
    memContext = loadMemoryContext();
  } catch {
    memContext = {};
  }

  let facts = '';
  try {
    // Move 1 (scoped recall): scope injected facts to the active focus's
    // objective so an off-topic fact can't leak into a focused session.
    // getActiveObjective() returns undefined when there's no focus or the
    // flag is off → identical to the global ranking (no regression).
    facts = renderFactsForInstructions(10, 2600, getActiveObjective());
  } catch {
    facts = '';
  }

  // Learned context (Recently Learned + Remembered Tool Choices) — shared with
  // the chat assembler via renderLearnedBlocks so both surfaces see the same
  // learned tools/facts. Scoped to the active focus objective. Returns
  // SECTION-wrapped strings, placed below at their existing positions.
  const { recentlyLearned, toolChoices, establishedDestinations } = renderLearnedBlocks(getActiveObjective());

  // Source-map / landscape memory — a pointer-first index of WHERE the user's
  // data lives, scoped to the active objective. Off (flag) → ''.
  let dataLandscape = '';
  try {
    dataLandscape = renderSourceMapForContext(24, undefined, getActiveObjective());
  } catch {
    dataLandscape = '';
  }

  let profile = '';
  try {
    profile = renderProfileForInstructions();
  } catch {
    profile = '';
  }

  const goals = renderActiveGoals();
  const heldTasks = renderHeldTasks(opts?.sessionId);
  const nowLine = renderCurrentTimeForInstructions();

  let skills = '';
  try {
    skills = renderSkillsIndex();
  } catch {
    skills = '';
  }

  // Current Focus block — surfaced in persistent context so the model
  // has at-a-glance awareness without a focus_get tool call. The
  // instructions still require focus_get at turn start for the most
  // current state (the persistent block is rendered once per turn).
  const focus = renderFocusForInstructions();

  const constraints = renderActiveConstraints();

  // Query-driven recall (parity with the main harness loop's buildTurnMemoryPrimer):
  // surface the consolidated facts MOST RELEVANT to the user's CURRENT message. A
  // brain that runs on this self-assembled context (the Claude Agent SDK lane) only
  // got the GENERAL top-N "Persistent Facts" block, so it was blind to request-
  // specific knowledge — e.g. "market leader = Account.Market_Leader__c is true" —
  // and rediscovered it via tool thrash (2026-06-29). Recall it up front so the brain
  // KNOWS instead of relearning. Caller passes the user's message; kill-switch
  // CLEMMY_BRAIN_QUERY_RECALL. Empty query / flag off ⇒ '' (byte-identical).
  let requestRecall = '';
  const recallQuery = (opts?.query ?? '').replace(/\s+/g, ' ').trim();
  if (recallQuery && queryRecallEnabled()) {
    try {
      const hits = searchFactsByText(recallQuery, QUERY_RECALL_LIMIT);
      if (hits.length > 0) requestRecall = hits.map((f) => `- ${String(f.content ?? '').trim()}`).filter((l) => l.length > 2).join('\n');
    } catch { requestRecall = ''; }
  }

  const blocks = [
    // Current date/time goes FIRST so the model reads it before any
    // other context. Without this the model defaults to its training
    // cutoff for date math, which is months stale.
    section('Now', nowLine),
    section('Autonomy', renderAutonomy()),
    section('Standing Constraints', constraints),
    section('Relevant To Your Request', requestRecall),
    section('User Preferences', profile),
    section('Persistent Facts', facts),
    recentlyLearned,
    section('Data Landscape', dataLandscape),
    toolChoices,
    establishedDestinations,
    section('Working Memory', memContext.workingMemory),
    section('Identity', memContext.identity),
    section('Core Personality', memContext.soul),
    section('Long-Term Memory', memContext.memory),
    section('Active Goals', goals),
    section('Held For Later', heldTasks),
    section('Current Focus', focus),
    section('Available Skills', skills),
  ].filter(Boolean);

  if (blocks.length === 0) return '';
  return [
    '# Persistent Context',
    'This block is loaded fresh each turn from the user\'s vault and memory stores. Treat it as ground truth about who the user is and what they\'re working on — it is the same persistent memory the chat dock and voice surfaces use, so what you learn here carries across every Clementine channel.',
    '',
    ...blocks,
  ].join('\n\n');
}

/**
 * Prepend persistent context to a role's static rubric. Use this as
 * the `instructions` value on each harness Agent — the SDK calls it
 * once per turn via getSystemPrompt, so vault edits surface
 * immediately on the next turn.
 */
export function harnessInstructions(roleInstructions: string, opts?: { sessionId?: string }): () => string {
  return () => {
    const ctx = renderHarnessMemoryContext({ sessionId: opts?.sessionId });
    if (!ctx) return roleInstructions;
    // Parity (default): STABLE role instructions FIRST so the whole prefix
    // (identity + role + tools) can be prompt-cached; the per-turn DYNAMIC
    // memory context goes AFTER the cache-break sentinel. Brains that don't
    // cache (Codex/BYO) strip the sentinel back to a `---` separator at their
    // wire. Legacy order (dynamic-first) restored when parity is off.
    if (modelParityEnabled()) {
      return `${roleInstructions}\n\n${CACHE_BREAK_SENTINEL}\n\n${ctx}`;
    }
    return `${ctx}\n\n---\n\n${roleInstructions}`;
  };
}
