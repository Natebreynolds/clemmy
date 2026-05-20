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
 *   - facts store      → renderFactsForInstructions (Pinecone-backed embedding memory)
 *   - user profile     → renderProfileForInstructions
 *   - goals dir        → top active goals
 *
 * Each function is called fresh on every turn via the SDK's
 * instructions-as-function support (`getSystemPrompt` invokes it
 * every call). Edits to any of these files / stores surface
 * immediately on the next turn — no daemon restart, no cached
 * snapshot.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { loadMemoryContext } from '../memory/vault.js';
import { renderFactsForInstructions } from '../memory/facts.js';
import { renderProfileForInstructions } from '../runtime/user-profile.js';

const GOALS_DIR = path.join(BASE_DIR, 'goals');

interface GoalSummary {
  id: string;
  title: string;
  status: string;
  priority: string;
  nextActions?: string[];
  targetDate?: string;
}

function section(title: string, body: string | undefined | null): string {
  if (!body || !body.trim()) return '';
  return `## ${title}\n${body.trim()}`;
}

function renderActiveGoals(): string {
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
        const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
        return (order[a.priority] ?? 1) - (order[b.priority] ?? 1);
      })
      .slice(0, 8);
    if (goals.length === 0) return '';
    return goals
      .map((g) => {
        const next = g.nextActions?.[0] ? ` → ${g.nextActions[0]}` : '';
        const due = g.targetDate ? ` (due ${g.targetDate})` : '';
        const status = g.status === 'blocked' ? ' [BLOCKED]' : '';
        return `- [${g.id}] ${g.title}${status}${due}${next}`;
      })
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * Build the persistent-context block that gets prepended to every
 * harness agent's role-specific instructions. Read-only: returns a
 * string each call. Errors in any individual source degrade
 * gracefully — a missing vault doesn't take the agent down.
 */
export function renderHarnessMemoryContext(): string {
  let memContext;
  try {
    memContext = loadMemoryContext();
  } catch {
    memContext = {};
  }

  let facts = '';
  try {
    facts = renderFactsForInstructions();
  } catch {
    facts = '';
  }

  let profile = '';
  try {
    profile = renderProfileForInstructions();
  } catch {
    profile = '';
  }

  const goals = renderActiveGoals();

  const blocks = [
    section('User Preferences', profile),
    section('Persistent Facts', facts),
    section('Working Memory', memContext.workingMemory),
    section('Identity', memContext.identity),
    section('Core Personality', memContext.soul),
    section('Long-Term Memory', memContext.memory),
    section('Active Goals', goals),
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
export function harnessInstructions(roleInstructions: string): () => string {
  return () => {
    const ctx = renderHarnessMemoryContext();
    return ctx ? `${ctx}\n\n---\n\n${roleInstructions}` : roleInstructions;
  };
}
