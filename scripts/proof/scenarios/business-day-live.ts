/**
 * Catalog scenario — business-day-live: the multi-employee claim, end to end.
 *
 * Every team capability has been proven in isolation: delegation round trips,
 * autonomous pickup, attribution, evidence provenance. Nothing yet proves the
 * composite that 3.0 actually promises — a small team covering parallel
 * workstreams like employees: two agents autonomously working their own
 * queues while Clementine handles the user's interactive request, nobody
 * touching anyone else's work, and every result labeled for what it is.
 *
 * Three parallel workstreams, one daemon, no orchestration by the scenario:
 *   1. ops agent    — delegated a checklist task, must complete it on its own
 *   2. analyst agent — delegated a summary task, must complete it on its own
 *   3. Clementine   — a live chat request, answered while the others work
 *
 * Catalog (not default) until the OAuth-autonomy repair-or-hold decision
 * lands; the checks are written against the contract, not the current tree.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { narrationCheck, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import { PROOF_CLIENT_COMPLETION_TIMEOUT_MS } from '../timeouts.js';

const OPS = 'proof-day-ops';
const ANALYST = 'proof-day-analyst';
const WAIT_MS = 300_000;
const POLL_MS = 5_000;

function seedAgent(home: string, slug: string, role: string): void {
  const dir = path.join(home, 'vault', '00-System', 'agents', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'agent.md'), [
    '---',
    `slug: ${slug}`,
    `name: ${slug}`,
    `description: Durable ${role} specialist for the business-day proof.`,
    'canMessage: []',
    'allowedTools: []',
    'tier: 2',
    'autonomyEnabled: true',
    'proactive: true',
    'cadenceMinutes: 30',
    '---',
    `You are the team ${role}. Finish work delegated to you and record real results.`,
  ].join('\n'), 'utf-8');
}

function seedDelegation(home: string, slug: string, id: string, task: string, expected: string): void {
  const dir = path.join(home, 'delegations', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id,
    fromAgent: 'clementine',
    toAgent: slug,
    task,
    expectedOutput: expected,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf-8');
}

function readDelegation(home: string, slug: string, id: string): Record<string, unknown> | null {
  const file = path.join(home, 'delegations', slug, `${id}.json`);
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>; }
  catch { return null; }
}

export const businessDayLive: ScenarioDef = {
  name: 'business-day-live',
  summary: 'two agents work their queues autonomously while Clementine handles chat — parallel, attributed, labeled',
  async run(daemon: DaemonHandle) {
    seedAgent(daemon.home, OPS, 'operations');
    seedAgent(daemon.home, ANALYST, 'analysis');
    seedDelegation(daemon.home, OPS, 'day-ops-1',
      'Write the Monday-morning open checklist for a coffee shop: exactly four numbered items.',
      'A numbered list of four items.');
    seedDelegation(daemon.home, ANALYST, 'day-an-1',
      'Summarize in exactly two sentences why weekly sales reviews beat monthly ones for a small team.',
      'Exactly two sentences.');
    appendFileSync(path.join(daemon.home, '.env'), `\nAUTONOMY_V2_AGENTS=${OPS},${ANALYST}\n`, 'utf-8');

    // Workstream 3: the user talks to Clementine WHILE the agents work.
    const chatSession = `proof-day-chat-${Date.now().toString(36)}`;
    const chat = await daemon.chat(
      'Quick one: give me a two-line status template I can paste into Slack each morning. No tools needed.',
      chatSession,
      PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
    );

    const deadline = Date.now() + WAIT_MS;
    let ops = readDelegation(daemon.home, OPS, 'day-ops-1');
    let analyst = readDelegation(daemon.home, ANALYST, 'day-an-1');
    while (Date.now() < deadline) {
      ops = readDelegation(daemon.home, OPS, 'day-ops-1');
      analyst = readDelegation(daemon.home, ANALYST, 'day-an-1');
      if (ops?.status === 'completed' && analyst?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    const checks: Check[] = [];
    checks.push(stormCheck(daemon.log()));
    checks.push({ name: 'chat workstream answered while agents worked', pass: chat.httpStatus === 200 && chat.text.trim().length > 20, detail: chat.text.slice(0, 160) });
    checks.push(narrationCheck(chat.text));

    for (const [label, record, slug] of [['ops', ops, OPS], ['analyst', analyst, ANALYST]] as const) {
      checks.push({
        name: `${label} agent completed its own workstream autonomously`,
        pass: record?.status === 'completed',
        detail: `status=${record?.status ?? 'missing'}`,
      });
      checks.push({
        name: `${label} result is real and attributed to the ${label} agent`,
        pass: typeof record?.result === 'string' && (record.result as string).trim().length > 10 && record?.completedBy === slug,
        detail: `completedBy=${record?.completedBy ?? 'MISSING'}; ${typeof record?.result === 'string' ? (record.result as string).slice(0, 120) : 'no result'}`,
      });
      checks.push({
        name: `${label} result carries evidence provenance`,
        pass: record?.resultEvidence === 'model_prose',
        detail: `resultEvidence=${record?.resultEvidence ?? 'MISSING'}`,
      });
    }

    // No cross-contamination: neither agent closed the other's work.
    checks.push({
      name: 'no agent touched a queue that was not its own',
      pass: ops?.completedBy !== ANALYST && analyst?.completedBy !== OPS,
      detail: `ops.completedBy=${ops?.completedBy ?? '—'} analyst.completedBy=${analyst?.completedBy ?? '—'}`,
    });

    return {
      checks,
      latency: [{ wallMs: chat.wallMs, ttftMs: null }],
      sessionId: chatSession,
      metrics: {
        turns: 1,
        opsCompletedBy: ops?.completedBy,
        analystCompletedBy: analyst?.completedBy,
      },
    };
  },
};
