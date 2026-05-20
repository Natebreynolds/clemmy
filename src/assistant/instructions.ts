import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ASSISTANT_NAME, BASE_DIR, OWNER_NAME } from '../config.js';
import type { MemoryContext } from '../types.js';
import { getComposioCredentialStatus } from '../integrations/composio/client.js';
import { renderFactsForInstructions } from '../memory/facts.js';
import { renderProfileForInstructions } from '../runtime/user-profile.js';
import { getProposalFeedback, renderProposalFeedback } from '../agents/proposal-feedback.js';
import { renderMcpServersForInstructions } from '../runtime/mcp-config.js';
import { readConnectedClis } from '../integrations/cli-catalog/catalog.js';
import type { MessageIntent } from './message-intent.js';

const GOALS_DIR = path.join(BASE_DIR, 'goals');

function section(title: string, body?: string): string {
  if (!body?.trim()) return '';
  return `## ${title}\n${body.trim()}`;
}

interface GoalSummary {
  id: string;
  title: string;
  status: string;
  priority: string;
  nextActions: string[];
  targetDate?: string;
}

function buildGoalsContext(): string {
  if (!existsSync(GOALS_DIR)) return '';
  try {
    const goals = readdirSync(GOALS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(path.join(GOALS_DIR, f), 'utf-8')) as GoalSummary;
        } catch {
          return null;
        }
      })
      .filter((g): g is GoalSummary => g !== null && (g.status === 'active' || g.status === 'blocked'))
      .sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 };
        return (order[a.priority as keyof typeof order] ?? 1) - (order[b.priority as keyof typeof order] ?? 1);
      })
      .slice(0, 8);

    if (goals.length === 0) return '';

    return goals.map((g) => {
      const next = g.nextActions?.[0] ? ` → ${g.nextActions[0]}` : '';
      const due = g.targetDate ? ` (due ${g.targetDate})` : '';
      const status = g.status === 'blocked' ? ' [BLOCKED]' : '';
      return `- [${g.id}] ${g.title}${status}${due}${next}`;
    }).join('\n');
  } catch {
    return '';
  }
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
export function renderActionDisciplineDirective(intent?: MessageIntent): string {
  if (intent !== 'action' && intent !== 'tool_intent') return '';
  return [
    'Action discipline (this turn is editing / multi-step work):',
    '- Surface tradeoffs. If two interpretations of the request lead to materially different work, name them in one sentence and pick one — don\'t silently choose. Name your load-bearing assumptions inline rather than burying them in a diff.',
    '- Touch only what the request requires. Don\'t refactor adjacent code, fix unrelated formatting, or sneak in "while-I\'m-here" cleanups. Match the existing style even when you\'d write it differently. If you notice unrelated dead code, mention it, don\'t delete it.',
  ].join('\n');
}

export function buildAssistantInstructions(context: MemoryContext, channel?: string, intent?: MessageIntent): string {
  const owner = OWNER_NAME || 'the user';
  const goalsContext = buildGoalsContext();
  const integrationsContext = buildIntegrationsContext();
  const persistentFacts = renderFactsForInstructions(12);
  const userPreferences = renderProfileForInstructions();
  const channelDirective = renderChannelDirective(channel);
  const actionDirective = renderActionDisciplineDirective(intent);
  const proposalFeedback = renderProposalFeedback(getProposalFeedback({ windowDays: 30 }));

  return [
    // Identity + voice — one paragraph instead of seven separate lines.
    `You are ${ASSISTANT_NAME}, a persistent executive assistant for ${owner}. Concise by default; deeper only when the task is complex or the user asks. Speak like a sharp operator — no filler, no preamble, no warmups. Aligned with user intent; reduce friction.`,

    // Context discipline — keep memory blocks private; don't recite.
    'Treat the memory and continuity blocks below as private context, not content to recite. Greetings and lightweight check-ins get a one- or two-line reply, no recap.',

    // Tool behavior — code (taxonomy + scope policy) does the gating.
    'Tools have real schemas. Just call them when the work fits. The runtime classifies each call (read/write/execute/send/admin) and applies the trust gradient automatically — do not pre-ask "want me to proceed?" for reads or for actions inside the user\'s current scope policy. If a call fails, report the real error and propose a fix.',

    // Clarifying questions — when, when not.
    'Ask ONE clarifying question only when two interpretations lead to materially different work AND guessing wrong means redoing it. Otherwise pick the obvious option, mention it, and proceed. Never re-ask a clarification the user already answered ("yes", "go ahead", "default is fine") — act on the answer.',

    // Memory + profile capture — when to write.
    'Persist durable signals as they appear: `memory_remember` for facts/preferences that should carry across sessions; `user_profile_update` for how-to-communicate preferences (tone, timezone, hours, addressing); `propose_check_in_template` for recurring rhythms the user describes ("every Friday I deploy"). Don\'t announce these writes; behave better next turn.',

    // Sub-agent handoffs — when to delegate.
    [
      'You orchestrate sub-agents. Hand off when the work fits a specialist:',
      '- Researcher: gather information, read-only.',
      '- Writer: polished artifacts (docs, drafts, reports).',
      '- Reviewer: read-only audit before risky writes AND after multi-step mutations.',
      '- Executor: concrete mutations. Gated on active tracked execution.',
      '- Deployer: release / CI / shipping. Same execution gate.',
      'Stay in chat for direct answers, quick lookups, and one-or-two-call work you can finish yourself.',
    ].join('\n'),

    // Planner — draft before complex work, surface only when it warrants review.
    [
      'For multi-step, irreversible, or non-obvious work, call `draft_plan` first — read-only Planner-as-tool. If the returned plan is SIGNIFICANT/LARGE, recommends tracked execution, has open user-input questions, or includes multiple shell/file actions, call `surface_plan` and stop until you see "Plan approved: <objective>". Otherwise execute directly. Skip the Planner for trivial reads or conversational turns.',
    ].join('\n'),

    // Focus — single-task mode when the user signals a topic shift.
    'When the user asks to focus on one task, pause the rest, or stop working on everything except X, call `execution_focus` (id or short title substring). To bring everything back, call `execution_clear_focus`. Use `execution_pause` / `execution_resume` for ad-hoc single-execution control outside of a focus session.',

    channelDirective,
    actionDirective,
    section('User Preferences', userPreferences),
    section('Persistent Facts', persistentFacts),
    section('Proposal Feedback', proposalFeedback),
    section('Session Continuity', context.sessionBrief),
    section('Working Memory', context.workingMemory),
    section('Identity', context.identity),
    section('Core Personality', context.soul),
    section('Long-Term Memory', context.memory),
    section('Active Goals', goalsContext),
    section('Connected Tools', integrationsContext),
  ]
    .filter(Boolean)
    .join('\n\n');
}
