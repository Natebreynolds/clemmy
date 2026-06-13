import { ASSISTANT_NAME, OWNER_NAME, getRuntimeEnv } from '../config.js';
import { listActiveGoalSummaries } from '../memory/goals-list.js';
import type { MemoryContext } from '../types.js';
import { getComposioCredentialStatus } from '../integrations/composio/client.js';
import { renderFactsForInstructions } from '../memory/facts.js';
import { renderSourceMapForContext } from '../memory/source-map.js';
import { getRecallObjective } from '../memory/focus.js';
import { renderProfileForInstructions } from '../runtime/user-profile.js';
import { getProposalFeedback, renderProposalFeedback } from '../agents/proposal-feedback.js';
import { renderLearnedBlocks, renderAutonomy, renderCurrentTimeForInstructions, renderFocusForInstructions } from '../agents/harness-context.js';
import { renderSkillsIndex } from '../memory/skill-store.js';
import { renderMcpServersForInstructions } from '../runtime/mcp-config.js';
import { readConnectedClis } from '../integrations/cli-catalog/catalog.js';
import type { MessageIntent } from './message-intent.js';


/**
 * Align-then-execute guidance (the "intelligence" pillar of the converse →
 * preview → execute loop). Artifact-AGNOSTIC by design: it must NOT encode a
 * domain taxonomy (no draft-vs-send / email-specific verbs) — preview and
 * execute are the same machinery at two altitudes for ANY artifact. Exported so
 * a guard test can assert it stays present and taxonomy-free.
 */
export const EXECUTE_DIRECTIVE = 'ALIGN, THEN ACT IN THE SAME TURN. Once the user greenlights an agreed action ("go ahead", "do it", "let\'s get them ready", "make it happen"), CARRY IT OUT this turn using your tools and report the real result. Do NOT reply with a future-tense plan ("I\'ll prep those next", "going to put that together") and stop — a turn that promises work but produces no artifact is a failure. Either produce the actual result now, or, if something genuinely blocks you, name the SPECIFIC blocker and do the part you can. When the user asks to PREVIEW or "show me what you\'d make", produce a real representative SAMPLE of the actual output (one concrete example, not a description of it), then produce the full thing on their go-ahead. Same shape for ANY artifact — a report, a file, a dataset, a batch of messages.';

function section(title: string, body?: string): string {
  if (!body?.trim()) return '';
  return `## ${title}\n${body.trim()}`;
}

/** Pull the pinned "## Active Task" block out of the working-memory string, if
 *  present, so it can be surfaced even on a light (casual/meta) turn where the
 *  rest of working memory is intentionally withheld. */

function buildGoalsContext(): string {
  const goals = listActiveGoalSummaries({ limit: 8, sortByPriority: true });
  if (goals.length === 0) return '';
  return goals.map((g) => {
    const next = g.nextActions?.[0] ? ` → ${g.nextActions[0]}` : '';
    const due = g.targetDate ? ` (due ${g.targetDate})` : '';
    const status = g.status === 'blocked' ? ' [BLOCKED]' : '';
    return `- [${g.id}] ${g.title}${status}${due}${next}`;
  }).join('\n');
}

function buildIntegrationsContext(): string {
  const sections: string[] = [];
  try {
    const composio = getComposioCredentialStatus();
    if (!composio.enabled) {
      sections.push('Composio OAuth is not configured. MCP servers and local CLIs are still available. To connect apps (Gmail, Slack, Drive, Calendar, etc.) through Composio, point the user at the dashboard Connected Apps section.');
    } else {
      sections.push([
        'Composio OAuth is connected. Use the compact Composio broker tools instead of assuming per-action tools are visible.',
        '',
        'IMPORTANT — Composio exposes hundreds of actions per toolkit, so the runtime keeps token use low by not injecting every action schema into every call. If you need an action (listing/reading/searching messages, fetching files, querying records, sending email, etc.), do NOT conclude that the runtime "doesn\'t expose" it before searching.',
        '',
        'Discovery flow:',
        '  1. Call `composio_search_tools` with a query describing what you need (e.g. "outlook list unread messages today", "gmail search messages", "salesforce query accounts"). It returns matching slugs.',
        '  2. Call `composio_execute_tool` with the returned `tool_slug` and an `arguments` JSON string. This uses the connected OAuth account and respects the approval taxonomy.',
        '',
        'Only fall back to "I can\'t do that" after you\'ve actually searched. Use `composio_status` only to inspect what is connected.',
      ].join('\n'));
    }
  } catch {
    // Keep building the rest of the integration context.
  }

  try {
    sections.push(renderMcpServersForInstructions());
  } catch {
    // MCP discovery should never block assistant startup.
  }

  try {
    const cliBlock = renderConnectedCliForInstructions();
    if (cliBlock) sections.push(cliBlock);
  } catch {
    // Best-effort — connected-cli surfacing is enrichment, not load-bearing.
  }

  return sections.join('\n\n');
}

/**
 * Tell the agent which CLIs the user has explicitly connected via the
 * dashboard's CLI catalog. This is a stronger signal than "it's on $PATH"
 * — if it's here, the user wired it intentionally and the auth command +
 * doc URL are known. Renders nothing when the user hasn't connected any.
 */
function renderConnectedCliForInstructions(): string {
  const connected = readConnectedClis();
  const entries = Object.values(connected);
  if (entries.length === 0) return '';
  const lines = entries.map((c) => {
    const authHint = c.authCommand ? ` · auth: \`${c.authCommand}\`` : '';
    return `- \`${c.command}\` — ${c.name} (${c.vendor})${authHint}`;
  });
  return [
    'Connected CLIs (the user wired these via the dashboard — they are intentionally available, not random $PATH noise):',
    ...lines,
    'Call them via `run_shell_command`. If a CLI needs auth, run its auth command first; if that fails, surface the doc link rather than guessing flags.',
  ].join('\n');
}

/**
 * Channel-specific response style directives. Composes WITH the user's
 * preferred tone — these tell the model about the surface, not the
 * person. Discord renders poorly above ~1500 chars and butchers
 * markdown headers; CLI is fine with any length and full markdown;
 * webhooks usually want clean structured text.
 *
 * If the user's profile says terse and the channel is Discord, both
 * agree → very tight reply. If the user's profile says verbose but
 * the channel is Discord, the channel wins on length but the model
 * keeps the user's voice preference for tone.
 */
export function renderChannelDirective(channel?: string): string {
  const normalized = (channel ?? '').toLowerCase();
  if (normalized.startsWith('discord')) {
    return [
      'Channel guidance — Discord:',
      '- For conversational replies (acks, status updates, short answers, confirmations): keep under ~500 characters. Lead with the answer or status. No preamble. No "Here is what I found:" warmups.',
      '- For deliverables the user explicitly asked for (audits, reports, drafts, generated code, HTML, JSON exports, anything that is the substance of the request): produce the FULL artifact. Save it to disk via write_file under the user\'s workspace or ~/.clementine-next/tmp/<task>/ and reply with a short "done — saved to <absolute-path>" pointer. The artifact is the deliverable, the Discord message is the receipt. NEVER decline an artifact request with "I can\'t create files in this environment" — write_file is always available.',
      '- Avoid markdown headers (#, ##, ###) — Discord renders them awkwardly. Plain bold is fine.',
      '- Code blocks ARE welcome for code or commands.',
      '- If a long conversational answer truly needs more than ~1500 chars, split into 2–3 short turns rather than one wall of text. (Long ARTIFACTS go to disk per the rule above — they should never be pasted into Discord.)',
      '- Channel constraints take precedence over the user\'s verbose preference, but tone (casual/formal) still follows the profile.',
    ].join('\n');
  }
  if (normalized.startsWith('cli') || normalized.startsWith('chat')) {
    return [
      'Channel guidance — CLI:',
      '- Markdown renders cleanly here. Use it for structure when it helps.',
      '- Length flexibility: match the user\'s tone preference. Be terse for routine answers, thorough when depth is asked for.',
    ].join('\n');
  }
  if (normalized.startsWith('webhook') || normalized.startsWith('api')) {
    return [
      'Channel guidance — webhook/API:',
      '- Prefer clean structured replies. The consumer is usually a downstream system or operator script.',
      '- Skip pleasantries; lead with the deliverable.',
    ].join('\n');
  }
  if (normalized === 'agent') {
    // Autonomy cycles have their own input/instructions in autonomy-v2.ts.
    // Suppress channel guidance here — autonomy-v2 already drives the
    // shape of the output via outputType.
    return '';
  }
  return '';
}

/**
 * Two-rule discipline directive for action/tool-intent turns. Distilled
 * from the multica-ai/andrej-karpathy-skills CLAUDE.md framework, kept
 * to the rules Clemmy didn't already enforce — value-vs-complexity and
 * goal-driven verification are already present elsewhere (auto-memory
 * + Planner schema) and re-stating them is pure token cost.
 *
 * Gated: only injected on `action` and `tool_intent` turns. Casual,
 * lookup, and meta_clarify turns get no extra prompt — they don't have
 * the change/edit failure modes these rules guard against.
 */
/**
 * P3 unified scope gate (flag UNIFIED_SCOPE_GATE, default off). Conservative,
 * high-precision detector for possessive / relative scope markers — the
 * "WHO/WHICH is implied, not stated" words. Deliberately does NOT try to
 * detect bare named entities (too many false positives). Exported for tests.
 */
const SCOPE_MARKER_RE = /\b(my|our|mine|ours|the usual|the same|as before|like last time)\b/i;
export function hasScopedLanguage(message: string): boolean {
  return SCOPE_MARKER_RE.test(message ?? '');
}

function scopeGateEnabled(): boolean {
  return (getRuntimeEnv('UNIFIED_SCOPE_GATE', 'off') ?? 'off').toLowerCase() === 'on';
}

export function renderActionDisciplineDirective(intent?: MessageIntent, message = ''): string {
  const actiony = intent === 'action' || intent === 'tool_intent';
  // P3: a scoped READ (lookup with possessive/relative language like "my"/
  // "our"/"the usual") carries the same silent-scope-drop risk as an action
  // ("show MY accounts" → all accounts). Gate it too when the flag is on.
  // Flag-off → action/tool_intent only (byte-identical to today).
  const scopedLookup = scopeGateEnabled() && intent === 'lookup' && hasScopedLanguage(message);
  if (!actiony && !scopedLookup) return '';
  return [
    'Action discipline (this turn is editing / multi-step work):',
    '- RESOLVE SCOPE BEFORE YOU QUERY OR MUTATE. If the request uses possessive or relative scope ("my", "our", "mine", "the usual", "again", or a bare person / account / project / list name) or is otherwise ambiguous about WHO or WHICH records it covers, do NOT guess. FIRST call memory_recall (scoped to the request) to resolve it — e.g. "my accounts" means the ones the user owns, not everyone\'s; "the usual sheet" means a specific known sheet. If recall does not resolve the scope, ask ONE concise clarifying question before running the query or mutation. Never silently drop a scope filter (like an owner filter) or invent one — resolve it, then speak the result in plain language, not the raw field expression.',
    '- Surface tradeoffs. If two interpretations of the request lead to materially different work, name them in one sentence and pick one — don\'t silently choose. Name your load-bearing assumptions inline rather than burying them in a diff.',
    '- Touch only what the request requires. Don\'t refactor adjacent code, fix unrelated formatting, or sneak in "while-I\'m-here" cleanups. Match the existing style even when you\'d write it differently. If you notice unrelated dead code, mention it, don\'t delete it.',
  ].join('\n');
}

/**
 * Tiered context (north-star: lean, cacheable prompt). When ON, the STABLE
 * Constitution (voice + reasoning rules + SOUL + identity + profile) stays in
 * the cached `instructions` prefix, and the DYNAMIC per-turn blocks (facts,
 * tool-choices, working-memory, …) move to the per-turn input tail via
 * buildTurnContextBlock — so the prefix caches and the model isn't waded
 * through ~8K of re-sent, mostly-irrelevant context every turn. Default OFF →
 * byte-identical legacy prompt until validated. CLEMMY_TIERED_CONTEXT=on enables.
 */
export function tieredContextEnabled(): boolean {
  // getRuntimeEnv (not process.env) so the documented ~/.clementine-next/.env
  // path flips it too, matching the sibling scopeGateEnabled flag in this file.
  return (getRuntimeEnv('CLEMMY_TIERED_CONTEXT', 'off') ?? 'off').toLowerCase() === 'on';
}

// CANON-SELFASM kill-switch (default ON). The chat assembler historically
// omitted four blocks the harness always injects — Now/date, Autonomy, Current
// Focus, Available Skills — so chat/Discord-default/mobile/bg turns did date
// math against the training cutoff and never saw the active focus or installed
// skills. We port them byte-faithfully from the harness (same render functions).
export function chatContextParityEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_CHAT_CONTEXT_PARITY', 'on') ?? 'on').toLowerCase() !== 'off';
}

export function buildAssistantInstructions(context: MemoryContext, channel?: string, intent?: MessageIntent, message?: string): string {
  const owner = OWNER_NAME || 'the user';
  const channelDirective = renderChannelDirective(channel);
  const actionDirective = renderActionDisciplineDirective(intent, message);
  const userPreferences = section('User Preferences', renderProfileForInstructions());
  const proposalFeedback = section('Proposal Feedback', renderProposalFeedback(getProposalFeedback({ windowDays: 30 })));
  const identity = section('Identity', context.identity);
  const soul = section('Core Personality', context.soul);
  const longTermMemory = section('Long-Term Memory', context.memory);
  const connectedTools = section('Connected Tools', buildIntegrationsContext());

  // CANON-SELFASM parity blocks (chat was missing all four vs the harness).
  // Now/date + Current Focus are DYNAMIC (per-turn); Autonomy + Available Skills
  // are stable enough to ride the cached Tier-1 prefix.
  const parityOn = chatContextParityEnabled();
  const nowBlock = parityOn ? section('Now', renderCurrentTimeForInstructions()) : '';
  const autonomyBlock = parityOn ? section('Autonomy', renderAutonomy()) : '';
  const focusBlock = parityOn ? section('Current Focus', renderFocusForInstructions()) : '';
  let skillsBlock = '';
  if (parityOn) {
    try { skillsBlock = section('Available Skills', renderSkillsIndex()); } catch { skillsBlock = ''; }
  }

  // ── Tier-1: stable Constitution — voice + reasoning rules + SOUL/identity/
  //    profile. Stable across turns → caches. Always present every turn. ──
  const identityVoice = `You are ${ASSISTANT_NAME}, a persistent executive assistant for ${owner}. Concise by default; deeper only when the task is complex or the user asks. Speak like a sharp operator — no filler, no preamble, no warmups. Aligned with user intent; reduce friction.`;
  const contextDiscipline = 'Treat the memory and continuity blocks below as private context, not content to recite. Greetings and lightweight check-ins get a one- or two-line reply, no recap. Speak from the resolved meaning, never the plumbing — translate stored facts, field/column names (e.g. `Market_Leader__c`), and internal labels ("current focus", "boundary", "scope filter") into plain business language ("accounts that aren\'t market leaders yet"), and never narrate your own process or safety steps ("confirming before I write", "for approval, not send"). Field names and slugs belong only inside a concrete data-operation you are describing, never in conversation.';
  const toolBehavior = 'Tools have real schemas. Just call them when the work fits. The runtime classifies each call (read/write/execute/send/admin) and applies the trust gradient automatically — do not pre-ask "want me to proceed?" for reads or for actions inside the user\'s current scope policy. If a call fails, report the real error and propose a fix.';
  const clarify = 'Ask ONE clarifying question only when two interpretations lead to materially different work AND guessing wrong means redoing it. Otherwise pick the obvious option, mention it, and proceed. Never re-ask a clarification the user already answered ("yes", "go ahead", "default is fine") — act on the answer.';
  const executeDirective = EXECUTE_DIRECTIVE;
  const capture = 'Persist durable signals as they appear: `memory_remember` for facts/preferences that should carry across sessions; `user_profile_update` for how-to-communicate preferences (tone, timezone, hours, addressing); `propose_check_in_template` for recurring rhythms the user describes ("every Friday I deploy"). Don\'t announce these writes; behave better next turn.';
  const handoffs = [
    'You orchestrate sub-agents. Hand off when the work fits a specialist:',
    '- Researcher: gather information, read-only.',
    '- Writer: polished artifacts (docs, drafts, reports).',
    '- Reviewer: read-only audit before risky writes AND after multi-step mutations.',
    '- Executor: concrete mutations. Gated on active tracked execution.',
    '- Deployer: release / CI / shipping. Same execution gate.',
    'Stay in chat for direct answers, quick lookups, and one-or-two-call work you can finish yourself.',
  ].join('\n');
  const planner = 'Keep clarify / plan / act conversational inside the main loop. Use `draft_plan` only for explicit planning requests, genuinely large/irreversible work, complex local/multi-artifact work where the user benefits from seeing your approach, or batch external writes that need a reviewed scope. If the returned plan has open `needsUserInput` questions, ask the user the shortest necessary clarification first; do NOT call `surface_plan` and do NOT show approval buttons for an incomplete plan. If the plan is executable and SIGNIFICANT/LARGE, recommends tracked execution, or includes multiple external writes, call `surface_plan` and stop until you see "Plan approved: <objective>". If the plan is executable, moderate, and safe/local/read-only, call `share_plan` to show the working plan without approval buttons, then continue. Skip the Planner for trivial reads and natural conversation.';
  const focus = 'When the user asks to focus on one task, pause the rest, or stop working on everything except X, call `execution_focus` (id or short title substring). To bring everything back, call `execution_clear_focus`. Use `execution_pause` / `execution_resume` for ad-hoc single-execution control outside of a focus session.';
  const reportBack = 'BACKGROUND OUTCOME REPORT-BACK — the recent transcript may contain a synthetic line that starts with `[workflow run <id> …]` or `[background task <id> …]`. That is a job you dispatched to run in the background REPORTING ITS OUTCOME (completed / needs attention / FAILED) — it is NOT a user message and must NEVER be silently absorbed. The user fired it off and moved on to other work; they are relying on you to tell them when it lands. SURFACE it proactively: on a completion, give them the result + any link/IDs it produced; on a FAILED / needs-attention outcome, first finish whatever the user just asked for, then flag it in one non-blocking line ("— heads up: your <name> flow finished but needs attention / failed at <step> — want me to retry?"). Do not re-surface an outcome you have already reported to the user.';

  // Pinned/standing facts are Tier-1 — ALWAYS present (even on a casual turn),
  // so a durable rule the user set never silently drops. Scored facts ride the
  // Tier-2 tail (intent-gated). objective omitted: standing rules always apply.
  // Pinned facts are now rendered in full (exempt from the cap) inside
  // renderFactsForInstructions; this budget only bounds the (empty here) scored
  // tail. Kept generous as defense-in-depth so a large standing block survives
  // even if the exempt-pinned logic ever changes.
  const standingFacts = renderFactsForInstructions(12, 2000, undefined, 'pinned');

  const tier1 = [
    identityVoice, contextDiscipline, toolBehavior, clarify, executeDirective, capture, handoffs, planner, focus, reportBack,
    channelDirective, actionDirective, userPreferences, standingFacts, proposalFeedback,
    // Stable parity blocks (Now/Focus are dynamic → per-turn tail, not here).
    autonomyBlock, skillsBlock,
    identity, soul, longTermMemory, connectedTools,
  ];

  if (tieredContextEnabled()) {
    // Tiered: only the stable Constitution lands in the cached system prompt.
    // The dynamic blocks go to the per-turn input tail (buildTurnContextBlock).
    return tier1.filter(Boolean).join('\n\n');
  }

  // Legacy (flag OFF): the original interleaved prompt — byte-identical to the
  // pre-tiering chat path (reverts the always-on learned-blocks injection too).
  const persistentFacts = section('Persistent Facts', renderFactsForInstructions(12, 2600, getRecallObjective(message)));
  const dataLandscape = section('Data Landscape', renderSourceMapForContext(24, undefined, getRecallObjective(message)));
  return [
    // Date FIRST so the model reads it before any other context (matches harness).
    nowBlock,
    identityVoice, contextDiscipline, toolBehavior, clarify, executeDirective, capture, handoffs, planner, focus, reportBack,
    channelDirective, actionDirective,
    autonomyBlock,
    userPreferences,
    persistentFacts,
    dataLandscape,
    proposalFeedback,
    section('Session Continuity', context.sessionBrief),
    section('Working Memory', context.workingMemory),
    identity,
    soul,
    longTermMemory,
    section('Active Goals', buildGoalsContext()),
    focusBlock,
    skillsBlock,
    connectedTools,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Tier-2: the DYNAMIC, per-turn context that used to bloat the system prompt
 * (and bust the cache). Returned for the per-turn INPUT tail when tiered context
 * is ON; '' when OFF (legacy keeps these inside the instructions). This is where
 * scoped facts, remembered tool-choices, working memory, etc. live now — adjacent
 * to the user message, not in the cached prefix. (Step 2 will additionally gate
 * these by intent so casual turns skip them; Step 1 includes them every turn.)
 */
export function buildTurnContextBlock(context: MemoryContext, intent?: MessageIntent, message?: string): string {
  if (!tieredContextEnabled()) return '';
  // Step 2: casual greetings / meta turns don't need the working context — keep
  // them lean. The standing/pinned facts live in Tier-1, so nothing durable is
  // lost here. Every WORKING turn (action/lookup/tool) + all workflow runs get
  // the full block.
  //
  // Insurance (the gate rides on an imperfect intent classifier): rather than
  // sending NOTHING on a "casual" turn — which would leave a MIS-classified
  // working request blind to facts + proven tools — send a one-line pointer so
  // the model knows the context is one call away the moment the turn turns real.
  if (intent === 'casual' || intent === 'meta_clarify') {
    const pointer = 'Context for this turn (private — use as needed, do not recite): any standing facts are above. If this turns into real work, pull your saved facts and proven tools first (memory_search_facts, tool_choice_recall, working_memory, goal_list) — they exist even though they are not inlined on this lightweight turn.';
    // A pinned Active Task is binding even on a casual/approval turn ("ok",
    // "go ahead") — surface it so the model never acts blind to the list it
    // was told to use. Other working-memory content stays out on light turns.
    return pointer;
  }
  const objective = getRecallObjective(message);
  const { recentlyLearned, toolChoices } = renderLearnedBlocks(objective);
  // CANON-SELFASM: Now/date + Current Focus are DYNAMIC, so in tiered mode they
  // ride the per-turn tail (Autonomy + Available Skills are stable → Tier-1).
  const parityOn = chatContextParityEnabled();
  const blocks = [
    parityOn ? section('Now', renderCurrentTimeForInstructions()) : '',
    // 'scored' — pinned facts are already in Tier-1; avoid double-rendering.
    section('Persistent Facts', renderFactsForInstructions(12, 2600, objective, 'scored')),
    recentlyLearned,
    section('Data Landscape', renderSourceMapForContext(24, undefined, objective)),
    toolChoices,
    section('Session Continuity', context.sessionBrief),
    section('Working Memory', context.workingMemory),
    section('Active Goals', buildGoalsContext()),
    parityOn ? section('Current Focus', renderFocusForInstructions()) : '',
  ].filter(Boolean);
  if (blocks.length === 0) return '';
  return ['Context for this turn (private — use as needed, do not recite):', ...blocks].join('\n\n');
}
