/**
 * Binds memory scope to the runtime: which session is behind the work that
 * is running, and which project and agent that session works in.
 *
 * Importing this module installs the binding. It is imported by the entry
 * points of every lane that runs a turn, so a turn is never read without a
 * scope; a process that imports none of them reads memory as it always did.
 */
import { getAgentRecord } from '../../agents/agent-record.js';
import { sessionAgentState } from '../../agents/session-agent-state.js';
import { agentScopeKey, installMemoryScopeBinding, type MemoryScope } from '../../memory/memory-scope.js';
import { sessionProjectState } from '../../projects/session-project-state.js';
import { harnessRunContextStorage } from './brackets.js';
import { getSession } from './eventlog.js';
import { sessionTakesIdentity } from './session-composition.js';
import { getToolOutputContext } from './tool-output-context.js';

const CACHE_MS = 1_500;
const cache = new Map<string, { at: number; key: string; scope: MemoryScope | null }>();

function scopeFromRow(sessionId: string, depth: number): MemoryScope | null {
  const row = getSession(sessionId);
  if (!row) return null;
  const metadata = row.metadata ?? {};
  // A helper run works for the turn that started it and knows what it knows.
  const parent = typeof metadata.parentSessionId === 'string' ? metadata.parentSessionId.trim() : '';
  if (parent && parent !== sessionId && depth < 3 && (metadata.workerScope === true || metadata.source === 'delegated_worker')) {
    return scopeFromRow(parent, depth + 1);
  }
  if (!sessionTakesIdentity({ sessionId, sessionKind: row.kind, metadata })) return { projectId: null, agentKey: null };
  const { projectId } = sessionProjectState(metadata);
  const { agentId } = sessionAgentState(metadata);
  // The conversation's agent was deleted: it carries on as Clem.
  const agent = agentId ? getAgentRecord(agentId) : null;
  return { projectId, agentKey: agent ? agentScopeKey(agent) : null };
}

function scopeOfSession(sessionId: string): MemoryScope | null {
  const now = Date.now();
  const hit = cache.get(sessionId);
  if (hit && now - hit.at < CACHE_MS) return hit.scope;
  const scope = scopeFromRow(sessionId, 0);
  if (cache.size > 512) cache.clear();
  cache.set(sessionId, { at: now, key: sessionId, scope });
  return scope;
}

/** Drop what is remembered about a session's scope, after its agent or
 * project changed, so the next read sees the change at once. */
export function forgetSessionMemoryScope(sessionId?: string): void {
  if (sessionId) cache.delete(sessionId);
  else cache.clear();
}

function ambientSessionId(): string | null {
  const run = harnessRunContextStorage.getStore()?.sessionId?.trim();
  if (run) return run;
  const tool = getToolOutputContext()?.sessionId?.trim();
  if (tool) return tool;
  // The tool server of a lane that runs its tools in a process of their own
  // is started for one session and told which.
  const started = process.env.CLEMENTINE_MCP_SESSION_ID?.trim();
  return started || null;
}

installMemoryScopeBinding({ ambientSessionId, scopeOfSession });
