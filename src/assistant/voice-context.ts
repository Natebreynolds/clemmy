import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ASSISTANT_NAME, BASE_DIR, OWNER_NAME } from '../config.js';
import { renderFactsForInstructions } from '../memory/facts.js';
import { loadSessionBrief, renderSessionContinuity } from '../memory/session-briefs.js';
import { loadMemoryContext } from '../memory/vault.js';
import { loadWorkingMemoryForSession } from '../memory/working-memory.js';
import { renderProfileForInstructions } from '../runtime/user-profile.js';

const GOALS_DIR = path.join(BASE_DIR, 'goals');

interface GoalSummary {
  id: string;
  title: string;
  status: string;
  priority?: string;
  nextActions?: string[];
  targetDate?: string;
}

function section(title: string, body?: string, maxChars = 1800): string {
  const trimmed = body?.trim();
  if (!trimmed) return '';
  const clipped = trimmed.length > maxChars ? `${trimmed.slice(0, maxChars).trimEnd()}\n...` : trimmed;
  return `## ${title}\n${clipped}`;
}

function buildVoiceGoalsContext(): string {
  if (!existsSync(GOALS_DIR)) return '';
  try {
    const goals = readdirSync(GOALS_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        try {
          return JSON.parse(readFileSync(path.join(GOALS_DIR, file), 'utf-8')) as GoalSummary;
        } catch {
          return null;
        }
      })
      .filter((goal): goal is GoalSummary => Boolean(goal && (goal.status === 'active' || goal.status === 'blocked')))
      .slice(0, 6);

    return goals.map((goal) => {
      const next = goal.nextActions?.[0] ? ` | next: ${goal.nextActions[0]}` : '';
      const due = goal.targetDate ? ` | due: ${goal.targetDate}` : '';
      const blocked = goal.status === 'blocked' ? ' | blocked' : '';
      return `- [${goal.id}] ${goal.title}${blocked}${due}${next}`;
    }).join('\n');
  } catch {
    return '';
  }
}

export function buildRealtimeVoiceInstructions(sessionId = 'console:home'): string {
  const owner = OWNER_NAME || 'the user';
  const baseContext = loadMemoryContext();
  const sessionBrief = loadSessionBrief(sessionId);
  const sessionWorkingMemory = loadWorkingMemoryForSession(sessionId) ?? baseContext.workingMemory;
  const profile = renderProfileForInstructions();
  const facts = renderFactsForInstructions(8);
  const goals = buildVoiceGoalsContext();

  return [
    `You are ${ASSISTANT_NAME} Live, the low-latency voice interface for the user's local ${ASSISTANT_NAME} assistant.`,
    `You are speaking with ${owner}. You should feel like the same assistant they use in chat and Discord, not a separate voice bot.`,
    'Use the private context below to personalize tone, continuity, and references. Do not recite context unless the user asks.',
    'Speak naturally and briefly. Voice replies should usually be one or two short spoken paragraphs.',
    'Avoid dead air. When you need a moment, say a short status phrase instead of going silent.',
    'For casual conversation, lightweight questions, or quick status explanations, answer directly using this context when helpful.',
    'For any request that implies local computer control, opening apps, filesystem/project work, external tool use, Discord/workflow actions, memory writes, scheduling, long-running execution, approvals, or anything that should be tracked, call send_to_clementine with the exact user request.',
    'Before calling send_to_clementine, say one concise bridge phrase like "I will route that into the local agent now." Then call the tool. After tool output returns, summarize the result in plain language.',
    'If the user asks what you can do, explain that voice can talk naturally, but real work is routed into the local Clementine agent with dashboard and Discord visibility.',
    'Do not claim local work has been completed unless send_to_clementine returns that result. If approval is required, tell the user to approve it in Clementine.',
    section('User Preferences', profile, 1600),
    section('Persistent Facts', facts, 1400),
    section('Session Continuity', sessionBrief ? renderSessionContinuity(sessionBrief) : '', 1800),
    section('Working Memory', sessionWorkingMemory, 1800),
    section('Identity', baseContext.identity, 1400),
    section('Core Personality', baseContext.soul, 1600),
    section('Long-Term Memory', baseContext.memory, 1600),
    section('Active Goals', goals, 1200),
  ].filter(Boolean).join('\n\n');
}
