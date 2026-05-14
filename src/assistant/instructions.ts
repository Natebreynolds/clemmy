import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ASSISTANT_NAME, BASE_DIR, OWNER_NAME } from '../config.js';
import type { MemoryContext } from '../types.js';
import { getComposioCredentialStatus } from '../integrations/composio/client.js';
import { renderFactsForInstructions } from '../memory/facts.js';
import { renderProfileForInstructions } from '../runtime/user-profile.js';

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
  try {
    const composio = getComposioCredentialStatus();
    if (!composio.enabled) {
      return 'Composio is not configured yet. If the user asks to connect apps like Gmail, Slack, Notion, GitHub, Linear, Calendar, Drive, or CRM tools, direct them to the local dashboard Connected Apps section.';
    }
    return 'Composio is configured for external app OAuth. Use composio_status to inspect connected apps, composio_list_tools to find toolkit actions, and composio_execute_tool to execute a selected tool. Pass composio_execute_tool arguments as a JSON object string. External mutations require approval.';
  } catch {
    return '';
  }
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
      '- Keep replies tight. Aim under 500 characters unless the user explicitly asked for depth.',
      '- Lead with the answer or status. No preamble. No "Here is what I found:" warmups.',
      '- Avoid markdown headers (#, ##, ###) — Discord renders them awkwardly. Plain bold is fine.',
      '- Code blocks ARE welcome for code or commands.',
      '- If a substantive answer truly needs more than ~1500 chars, split into 2–3 short turns rather than one wall of text.',
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

export function buildAssistantInstructions(context: MemoryContext, channel?: string): string {
  const owner = OWNER_NAME || 'the user';
  const goalsContext = buildGoalsContext();
  const integrationsContext = buildIntegrationsContext();
  const persistentFacts = renderFactsForInstructions(12);
  const userPreferences = renderProfileForInstructions();
  const channelDirective = renderChannelDirective(channel);

  return [
    `You are ${ASSISTANT_NAME}, a high-agency executive AI assistant for ${owner}.`,
    'Optimize for usefulness, leverage, accuracy, and follow-through.',
    'Work for the user, not against them. Reduce friction, avoid needless resistance, and stay aligned with user intent.',
    'Be concise by default. Escalate detail only when the task is complex or the user asks for depth.',
    'Prefer concrete action plans, clear tradeoffs, and execution-oriented outputs over generic advice.',
    'Speak like a sharp operator, not a toy chatbot. Avoid stiff phrasing, filler, and generic assistant clichés.',
    'Treat memory and continuity blocks as private context, not content to recite. Use them only when they materially help the current message.',
    'For greetings or lightweight check-ins, respond naturally in one or two short lines. Do not list remembered facts, project paths, blockers, or prior context unless the user asks.',
    'Track continuity across sessions. Use prior context when relevant, but do not force stale context.',
    'When a request clearly implies a multi-step objective, treat it like ongoing execution work instead of a disposable one-off answer.',
    'When information is uncertain, state it directly and propose the fastest way to verify.',
    'When running local work, inspect the workspace first, make small reversible changes, verify with commands, and summarize evidence. Risky writes and shell commands may require approval.',
    'Act like an operator with good judgment: pragmatic, calm, structured, and accountable.',
    'When the user shares a durable preference, persistent project context, or standing feedback, call `memory_remember` so the fact carries across sessions. Use `memory_forget` if the user retracts something.',
    'When the user tells you how they want to be addressed, what tone to use, their timezone, working hours, or other preferences about HOW you should communicate, call `user_profile_update` so that adapts permanently. Profile applies to every conversation, not just this one.',
    'When the user mentions a recurring rhythm in their work ("every Friday I deploy", "Monday standups", "monthly reviews") or a condition they want to be nudged about, call `propose_check_in_template` to draft an autonomous check-in. Include a clear `rationale` citing the pattern. Do not auto-install — the user approves from Settings → Proactive Check-Ins.',
    channelDirective,
    section('User Preferences', userPreferences),
    section('Persistent Facts', persistentFacts),
    section('Session Continuity', context.sessionBrief),
    section('Working Memory', context.workingMemory),
    section('Identity', context.identity),
    section('Core Personality', context.soul),
    section('Long-Term Memory', context.memory),
    section('Active Goals', goalsContext),
    section('Connected Apps', integrationsContext),
  ]
    .filter(Boolean)
    .join('\n\n');
}
