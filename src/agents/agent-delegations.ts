/**
 * Slug-bound delegation tools for the autonomy loop.
 *
 * `delegate_task` + `complete_delegation` (team-tools) made delegated work
 * finishable, but only on the path Clementine drives: they read the acting
 * agent from the process-global `CLEMENTINE_TEAM_AGENT`, which cannot
 * distinguish agents in the shared daemon where every autonomy cycle runs in
 * one process. So a delegate could never pick up its own work on its own
 * cadence — every agent record listed `'delegation'` in `wakeTriggers` and
 * nothing consumed it.
 *
 * These tools bind the agent's slug at construction, the same way
 * `buildAgentCommsTools` fixed sender attribution, and write the SAME durable
 * delegation records the team tools and the execution controller already read.
 * No new primitive, no second store.
 *
 * The claim is a LEASE, not a lock. Two agents never share a queue (a
 * delegation belongs to exactly one `toAgent`), so the contention this actually
 * prevents is an agent racing ITSELF: cycles are minutes apart, and long work
 * can still be running when the next one wakes. Claiming stops the second cycle
 * from restarting in-flight work — but an expired lease is reclaimable, because
 * a cycle that dies mid-task must never strand the delegation forever.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';

import { DELEGATIONS_DIR } from '../tools/shared.js';
import type { RuntimeContextValue } from '../types.js';

/**
 * How long a claim holds before another cycle may take the work back. Chosen
 * to comfortably exceed a normal agent cadence (default 30 min) so healthy
 * long-running work is never stolen from itself, while still bounding how long
 * a crashed cycle can sit on a delegation.
 */
export const DELEGATION_CLAIM_LEASE_MS = 60 * 60_000;

interface DelegationRecord {
  id: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  expectedOutput: string;
  status: 'pending' | 'in_progress' | 'completed';
  result?: string;
  completedBy?: string;
  onBehalfOf?: string;
  claimedBy?: string;
  claimedAt?: string;
  createdAt: string;
  updatedAt: string;
}

function agentDir(slug: string): string {
  return path.join(DELEGATIONS_DIR, slug);
}

function filePath(slug: string, id: string): string {
  return path.join(agentDir(slug), `${id}.json`);
}

function readOwn(slug: string): DelegationRecord[] {
  try {
    return readdirSync(agentDir(slug))
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        try { return JSON.parse(readFileSync(path.join(agentDir(slug), file), 'utf-8')) as DelegationRecord; }
        catch { return null; }
      })
      .filter((record): record is DelegationRecord => record !== null);
  } catch {
    return [];
  }
}

function readOne(slug: string, id: string): DelegationRecord | null {
  const file = filePath(slug, id);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf-8')) as DelegationRecord; }
  catch { return null; }
}

function write(slug: string, record: DelegationRecord): void {
  writeFileSync(filePath(slug, record.id), JSON.stringify(record, null, 2), 'utf-8');
}

function leaseHeld(record: DelegationRecord, now: number): boolean {
  if (record.status !== 'in_progress' || !record.claimedAt) return false;
  const claimedAt = Date.parse(record.claimedAt);
  if (!Number.isFinite(claimedAt)) return false;
  return now - claimedAt < DELEGATION_CLAIM_LEASE_MS;
}

/**
 * Render an agent's open delegations for its cycle input. Returns '' when there
 * is nothing assigned, so a quiet agent's prompt gains no empty section.
 */
export function renderOpenDelegations(slug: string): string {
  const open = readOwn(slug).filter((record) => record.status !== 'completed');
  if (open.length === 0) return '';
  return [
    'Work delegated to you (claim it, do it, then record the result):',
    ...open.map((record) => {
      const held = leaseHeld(record, Date.now());
      const state = held ? 'IN PROGRESS (claimed by you)' : 'OPEN';
      return `- [${state}] ${record.id} from ${record.fromAgent}: ${record.task} | expected: ${record.expectedOutput}`;
    }),
  ].join('\n');
}


/**
 * Core claim transition, slug-bound in code. Shared by the SDK tool and the
 * runtime-engine cycle so both auth paths go through ONE owner. Lookup is
 * scoped to the agent's own queue, so another agent's work is not merely
 * refused — it is unreachable.
 */
export function claimDelegationFor(agentSlug: string, delegationId: string): string {
  const record = readOne(agentSlug, delegationId);
  if (!record) return `Delegation ${delegationId} is not assigned to you (not in your queue).`;
  if (record.status === 'completed') return `Delegation ${delegationId} is already completed.`;
  if (leaseHeld(record, Date.now())) {
    return `Delegation ${delegationId} is already in progress (claimed ${record.claimedAt}). Continue it rather than starting over.`;
  }
  const now = new Date().toISOString();
  write(agentSlug, { ...record, status: 'in_progress', claimedBy: agentSlug, claimedAt: now, updatedAt: now });
  return `Claimed delegation ${delegationId}: ${record.task}`;
}

/**
 * Core completion transition, slug-bound in code. The delegator acts on the
 * completion transition, so the first result is authoritative — a repeat
 * reports instead of rewriting history.
 */
export function completeDelegationFor(agentSlug: string, delegationId: string, result: string): string {
  const record = readOne(agentSlug, delegationId);
  if (!record) return `Delegation ${delegationId} is not assigned to you (not in your queue).`;
  if (record.status === 'completed') {
    return `Delegation ${delegationId} is already completed. Recorded result: ${record.result ?? '(none)'}`;
  }
  const now = new Date().toISOString();
  write(agentSlug, { ...record, status: 'completed', result, completedBy: agentSlug, updatedAt: now });
  return `Completed delegation ${delegationId} for ${record.fromAgent}.`;
}

/**
 * Delegation tools bound to one agent's slug. Attribution never depends on a
 * process-global, so two agents' tools cannot cross-write in a shared daemon.
 */
export function buildAgentDelegationTools(agentSlug: string): Tool<RuntimeContextValue>[] {
  const claim = tool({
    name: 'delegation_claim',
    description: 'Claim a task delegated to you before working on it, so a later cycle does not restart work already underway.',
    parameters: z.object({
      delegation_id: z.string().describe('The delegation id from your delegated-work list.'),
    }),
    execute: async ({ delegation_id }: { delegation_id: string }) =>
      claimDelegationFor(agentSlug, delegation_id),
  });

  const complete = tool({
    name: 'delegation_complete',
    description: 'Record the result of a task delegated to you. This is what tells the delegator the work is finished.',
    parameters: z.object({
      delegation_id: z.string().describe('The delegation id you are finishing.'),
      result: z.string().describe('The actual result — what was produced, not a promise to produce it.'),
    }),
    execute: async ({ delegation_id, result }: { delegation_id: string; result: string }) =>
      completeDelegationFor(agentSlug, delegation_id, result),
  });

  return [claim, complete] as Tool<RuntimeContextValue>[];
}
