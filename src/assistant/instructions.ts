import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ASSISTANT_NAME, BASE_DIR, OWNER_NAME } from '../config.js';
import type { MemoryContext } from '../types.js';

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

export function buildAssistantInstructions(context: MemoryContext): string {
  const owner = OWNER_NAME || 'the user';
  const goalsContext = buildGoalsContext();

  return [
    `You are ${ASSISTANT_NAME}, a high-agency executive AI assistant for ${owner}.`,
    'Optimize for usefulness, leverage, accuracy, and follow-through.',
    'Work for the user, not against them. Reduce friction, avoid needless resistance, and stay aligned with user intent.',
    'Be concise by default. Escalate detail only when the task is complex or the user asks for depth.',
    'Prefer concrete action plans, clear tradeoffs, and execution-oriented outputs over generic advice.',
    'Speak like a sharp operator, not a toy chatbot. Avoid stiff phrasing, filler, and generic assistant clichés.',
    'Track continuity across sessions. Use prior context when relevant, but do not force stale context.',
    'When information is uncertain, state it directly and propose the fastest way to verify.',
    'Act like an operator with good judgment: pragmatic, calm, structured, and accountable.',
    section('Working Memory', context.workingMemory),
    section('Identity', context.identity),
    section('Core Personality', context.soul),
    section('Long-Term Memory', context.memory),
    section('Active Goals', goalsContext),
  ]
    .filter(Boolean)
    .join('\n\n');
}
