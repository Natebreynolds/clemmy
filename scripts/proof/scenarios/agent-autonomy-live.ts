/**
 * Scenario — agent-autonomy-live: an agent wakes on its own and finishes work.
 *
 * Until now this loop had ZERO live coverage — and could not have any, because
 * the only autonomy engine needed a raw OpenAI API key that OAuth-primary
 * installs (the shipped default) never have. With the runtime engine, agent
 * cycles run through the same brain the daemon is provisioned with, so this
 * scenario finally closes the "works while you're away" claim on BOTH OAuths.
 *
 * Shape: seed a durable agent and a delegation for it on disk, opt the agent
 * in via the proof home's own `.env` (getRuntimeEnv reads it per call — no
 * daemon flag plumbing), then DO NOTHING. No chat turn. The daemon's 15s tick
 * must wake the agent, the agent must see its queue, do the work, and record
 * the result — attributed to itself, not to Clementine.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';

const SLUG = 'proof-autonomist';
const DELEGATION_ID = 'auto1';
// Long enough for one cycle PLUS one bounded failure-retry (90s backoff): a
// transient provider blip mid-cycle must not red the gate when the retry
// succeeds honestly. Severe sustained weather still reds it — that is correct.
const WAIT_MS = 300_000;
const POLL_MS = 5_000;

function seedAgent(home: string): void {
  const dir = path.join(home, 'vault', '00-System', 'agents', SLUG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'agent.md'), [
    '---',
    `slug: ${SLUG}`,
    'name: Proof Autonomist',
    'description: Durable analysis specialist used to prove autonomous pickup.',
    'canMessage: []',
    'allowedTools: []',
    'tier: 2',
    'autonomyEnabled: true',
    'proactive: true',
    'cadenceMinutes: 30',
    '---',
    'You are Proof Autonomist. Finish work delegated to you and record real results.',
  ].join('\n'), 'utf-8');
}

function seedDelegation(home: string): void {
  const dir = path.join(home, 'delegations', SLUG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${DELEGATION_ID}.json`), JSON.stringify({
    id: DELEGATION_ID,
    fromAgent: 'clementine',
    toAgent: SLUG,
    task: 'List exactly three risks of deploying on a Friday afternoon.',
    expectedOutput: 'A numbered list of three risks.',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
}

function readDelegation(home: string): Record<string, unknown> | null {
  const file = path.join(home, 'delegations', SLUG, `${DELEGATION_ID}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>; }
  catch { return null; }
}

function readAgentState(home: string): Record<string, unknown> | null {
  const file = path.join(home, 'agents-state', `${SLUG}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>; }
  catch { return null; }
}

export const agentAutonomyLive: ScenarioDef = {
  name: 'agent-autonomy-live',
  summary: 'seed agent + delegation → no chat turn → daemon tick wakes agent → work completes',
  async run(daemon: DaemonHandle) {
    seedAgent(daemon.home);
    seedDelegation(daemon.home);
    // Opt the agent in through the home's own .env — read per call by
    // getRuntimeEnv, so no restart is required.
    appendFileSync(path.join(daemon.home, '.env'), `\nAUTONOMY_V2_AGENTS=${SLUG}\n`, 'utf-8');

    // The point of the scenario: NO chat turn. Autonomy has to happen to us.
    const deadline = Date.now() + WAIT_MS;
    let record = readDelegation(daemon.home);
    while (Date.now() < deadline) {
      record = readDelegation(daemon.home);
      if (record?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    // The cycle writes agent state AFTER its turn finishes; the delegation
    // completes DURING the turn. Give the state file a bounded grace window so
    // the audit-trail checks measure the engine, not this race.
    let state = readAgentState(daemon.home);
    const stateDeadline = Date.now() + 60_000;
    while ((!state?.lastRunAt) && Date.now() < stateDeadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      state = readAgentState(daemon.home);
    }

    const checks: Check[] = [];
    checks.push(stormCheck(daemon.log()));
    checks.push({
      name: 'the agent woke without any user turn',
      pass: Boolean(state?.lastRunAt),
      detail: state ? `lastRunAt=${state.lastRunAt} reasons=${JSON.stringify(state.lastWakeReasons)}` : 'no agent state written',
    });
    checks.push({
      name: 'delegated work reached completed autonomously',
      pass: record?.status === 'completed',
      detail: `status=${record?.status ?? 'missing'}`,
    });
    checks.push({
      name: 'a real result was recorded',
      pass: typeof record?.result === 'string' && (record.result as string).trim().length > 10,
      detail: typeof record?.result === 'string' ? (record.result as string).slice(0, 200) : 'no result',
    });
    checks.push({
      name: 'attributed to the agent itself, not Clementine',
      pass: record?.completedBy === SLUG,
      detail: `completedBy=${record?.completedBy ?? 'MISSING'}`,
    });
    checks.push({
      name: 'the cycle left a summary for the audit trail',
      pass: typeof state?.lastSummary === 'string' && (state.lastSummary as string).length > 0,
      detail: typeof state?.lastSummary === 'string' ? (state.lastSummary as string).slice(0, 160) : 'no summary',
    });

    return {
      checks,
      latency: [{ wallMs: 0, ttftMs: null }],
      sessionId: `agent:${SLUG}`,
      metrics: {
        turns: 0,
        completedBy: record?.completedBy,
        wakeReasons: state?.lastWakeReasons,
      },
    };
  },
};
