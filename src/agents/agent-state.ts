/**
 * Shared team-agent state + inbox READERS.
 *
 * Extracted from the deleted autonomy v1 engine (Phase-2 Wave 2). These are
 * pure read helpers the dashboard StateSnapshot needs (agent cards + pending
 * inbox counts); they are NOT autonomy-v1-specific — they read the same
 * team-agent / inbox / agent-state files that v2 and the team tools write.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_INBOX_DIR,
  AGENT_STATE_DIR,
  TeamAgentRecord,
  loadTeamAgents,
} from '../tools/shared.js';

const DEFAULT_WAKE_TRIGGERS = ['inbox', 'delegation', 'request', 'stale_tasks', 'daily_review', 'execution_review'];

type InboxItemType = 'message' | 'request' | 'delegation' | 'task_review' | 'daily_review' | 'system';

interface AgentInboxItem {
  id: string;
  type: InboxItemType;
  createdAt: string;
  status: 'pending' | 'processed';
  fromAgent?: string;
  sourceKey?: string;
  content: string;
  metadata?: Record<string, unknown>;
  processedAt?: string;
}

export interface AgentStateRecord {
  slug: string;
  lastRunAt?: string;
  lastWakeAt?: string;
  lastWakeReasons?: string[];
  lastSummary?: string;
  commitments?: string[];
  nextWakeAt?: string;
  lastError?: string;
}

function inboxFilePath(slug: string): string {
  return path.join(AGENT_INBOX_DIR, `${slug}.json`);
}

function loadJsonArray<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function loadInbox(slug: string): AgentInboxItem[] {
  return loadJsonArray<AgentInboxItem>(inboxFilePath(slug));
}

function defaultPrimaryAgent(teamAgents: TeamAgentRecord[]): TeamAgentRecord {
  return {
    slug: 'clementine',
    name: 'Clementine',
    description: 'Primary personal assistant and coordinator.',
    role: 'personal_assistant',
    canMessage: teamAgents.map((agent) => agent.slug),
    allowedTools: [],
    personality: 'You are Clementine, the primary assistant. Stay proactive, practical, and concise. Coordinate work across the team when helpful.',
    autonomyEnabled: true,
    proactive: true,
    cadenceMinutes: 30,
    wakeTriggers: DEFAULT_WAKE_TRIGGERS,
    tier: 2,
  };
}

/** The team's agents, always including the primary `clementine` coordinator. */
export function listAutonomyAgents(): TeamAgentRecord[] {
  const teamAgents = loadTeamAgents();
  const agents = [...teamAgents];
  if (!agents.some((agent) => agent.slug === 'clementine')) {
    agents.unshift(defaultPrimaryAgent(teamAgents));
  }
  return agents;
}

/** All persisted agent-state records (for the dashboard agent cards). */
export function listAgentStates(): AgentStateRecord[] {
  if (!existsSync(AGENT_STATE_DIR)) return [];
  return readdirSync(AGENT_STATE_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      try {
        return JSON.parse(readFileSync(path.join(AGENT_STATE_DIR, file), 'utf-8')) as AgentStateRecord;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is AgentStateRecord => entry !== null)
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

/** Per-agent pending-inbox counts (for the dashboard). */
export function listAgentInboxCounts(): Array<{ slug: string; pending: number }> {
  return listAutonomyAgents().map((agent) => ({
    slug: agent.slug,
    pending: loadInbox(agent.slug).filter((item) => item.status === 'pending').length,
  }));
}
