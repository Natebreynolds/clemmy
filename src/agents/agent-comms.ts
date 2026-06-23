import { tool } from '@openai/agents';
import type { Tool } from '@openai/agents';
import { z } from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { getRuntimeEnv } from '../config.js';
import {
  AGENT_INBOX_DIR,
  TEAM_COMMS_LOG,
  TEAM_REQUESTS_DIR,
  ensureDir,
  loadTeamAgents,
} from '../tools/shared.js';
import type { RuntimeContextValue } from '../types.js';

/**
 * Slice 3 — peer messaging for the SDK-native autonomy loop (v2).
 *
 * Two halves the v2 loop was missing (it explicitly punted on comms):
 *
 *  1. SEND — slug-bound tools (`agent_message` / `agent_request` /
 *     `agent_reply`). The legacy team_message tool attributes the sender
 *     from a PROCESS-GLOBAL env (`CLEMENTINE_TEAM_AGENT`), which is wrong
 *     in the shared v2 daemon where every agent runs in one process — they
 *     would all post as `clementine`. These tools bind the caller's slug at
 *     construction, so attribution is correct without touching team-tools.ts.
 *     They write the SAME `TEAM_COMMS_LOG` substrate the team tools + the
 *     console workspace already read — no new primitive.
 *
 *  2. DELIVER — `deliverTeamCommsToInboxes()` materializes comms-log
 *     entries into each recipient's inbox so the NEXT cycle picks them up.
 *     (This is the `syncAutonomyInputs` step that vanished with v1.)
 *
 * Guardrails: `canMessage` is enforced per send; a per-cycle send budget
 * caps runaway chatter; cross-cycle ping-pong is bounded by the agent
 * cadence (cycles are minutes apart). Everything is gated by
 * CLEMMY_V2_PEER_COMMS (default off → the v2 loop is byte-identical).
 */

const logger = pino({ name: 'clementine-next.agent-comms' });

const PRIMARY_SLUG = 'clementine';
const FLAG = 'CLEMMY_V2_PEER_COMMS';
const BUDGET_ENV = 'CLEMMY_V2_PEER_COMMS_BUDGET';
const DEFAULT_SEND_BUDGET = 3;
const DELIVER_WINDOW_MS = 24 * 60 * 60 * 1000; // don't flood inboxes with ancient backlog

export function peerCommsEnabled(): boolean {
  const raw = (getRuntimeEnv(FLAG, '') || '').trim().toLowerCase();
  return raw === 'on' || raw === '1' || raw === 'true';
}

function sendBudget(): number {
  const raw = Number(getRuntimeEnv(BUDGET_ENV, ''));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_SEND_BUDGET;
}

// -------- per-cycle send budget --------
// Reset at the start of each agent cycle; the slug-bound tools consume it.

const sendCounts = new Map<string, number>();

export function resetCommsCycle(slug: string): void {
  sendCounts.set(slug, 0);
}

function tryConsumeSend(slug: string): boolean {
  const max = sendBudget();
  const used = sendCounts.get(slug) ?? 0;
  if (used >= max) return false;
  sendCounts.set(slug, used + 1);
  return true;
}

// -------- comms-log substrate (same shape team-tools.ts writes) --------

interface TeamMessageRecord {
  id: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  timestamp: string;
  protocol: 'message' | 'request' | 'response';
  requestId?: string;
}

function appendTeamComms(record: TeamMessageRecord): void {
  ensureDir(path.dirname(TEAM_COMMS_LOG));
  appendFileSync(TEAM_COMMS_LOG, `${JSON.stringify(record)}\n`, 'utf-8');
}

function readTeamComms(): TeamMessageRecord[] {
  if (!existsSync(TEAM_COMMS_LOG)) return [];
  return readFileSync(TEAM_COMMS_LOG, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line) as TeamMessageRecord; } catch { return null; } })
    .filter((r): r is TeamMessageRecord => r !== null);
}

/** A sender may message a target if it's the primary orchestrator or the
 *  target is in its canMessage list. Mirrors team-tools' canSendTo but
 *  takes an EXPLICIT sender (no process-global env). */
function canSend(senderSlug: string, targetSlug: string): boolean {
  if (senderSlug === PRIMARY_SLUG) return true;
  const sender = loadTeamAgents().find((a) => a.slug === senderSlug);
  return !!sender && sender.canMessage.includes(targetSlug);
}

// -------- inbox delivery (the missing syncAutonomyInputs) --------

interface InboxItem {
  id: string;
  type: string;
  content: string;
  sourceKey: string;
  createdAt: string;
  status: 'pending' | 'processed';
  fromAgent?: string;
  metadata?: Record<string, unknown>;
}

function enqueueInboxItem(slug: string, item: Omit<InboxItem, 'id' | 'createdAt' | 'status'>): boolean {
  ensureDir(AGENT_INBOX_DIR);
  const filePath = path.join(AGENT_INBOX_DIR, `${slug}.json`);
  let items: InboxItem[] = [];
  if (existsSync(filePath)) {
    try { items = JSON.parse(readFileSync(filePath, 'utf-8')) as InboxItem[]; } catch { items = []; }
  }
  if (items.some((i) => i.sourceKey === item.sourceKey)) return false; // dedup by sourceKey
  items.push({ ...item, id: randomUUID(), createdAt: new Date().toISOString(), status: 'pending' });
  writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf-8');
  return true;
}

/**
 * Materialize recent comms-log entries into recipient inboxes. Idempotent
 * (dedup by the comms record id as sourceKey). Returns how many fresh
 * items were delivered. Only entries from the last DELIVER_WINDOW_MS are
 * considered so flipping the flag on doesn't replay ancient backlog.
 */
export function deliverTeamCommsToInboxes(now = Date.now()): number {
  let delivered = 0;
  const known = new Set(loadTeamAgents().map((a) => a.slug));
  for (const record of readTeamComms()) {
    const ts = Date.parse(record.timestamp);
    if (Number.isFinite(ts) && now - ts > DELIVER_WINDOW_MS) continue;
    if (!known.has(record.toAgent)) continue; // dangling recipient
    const type = record.protocol === 'request' ? 'request' : record.protocol === 'response' ? 'message' : 'message';
    const ok = enqueueInboxItem(record.toAgent, {
      type,
      content: record.content,
      sourceKey: record.id,
      fromAgent: record.fromAgent,
      metadata: record.requestId ? { requestId: record.requestId, protocol: record.protocol } : { protocol: record.protocol },
    });
    if (ok) delivered++;
  }
  return delivered;
}

// -------- request/reply files (slug-bound reply) --------

function requestFilePath(id: string): string {
  return path.join(TEAM_REQUESTS_DIR, `${id}.json`);
}

interface RequestFile {
  id: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  createdAt: string;
  status: 'pending' | 'completed';
  response?: string;
  respondedAt?: string;
}

// -------- slug-bound SDK tools --------

/**
 * Build the peer-comms tools bound to ONE agent's slug. The slug is the
 * verified caller identity — never read from the environment.
 */
export function buildAgentCommsTools(senderSlug: string): Tool<RuntimeContextValue>[] {
  const overBudget = () =>
    `Message budget reached for this cycle (max ${sendBudget()}). Note the intent in your summary and continue next cycle.`;

  const message = tool({
    name: 'agent_message',
    description: 'Send a one-way message to another team agent you are allowed to message (see your canMessage list). It lands in their inbox next cycle.',
    parameters: z.object({
      to_agent: z.string().describe('Target agent slug.'),
      message: z.string().describe('The message content.'),
    }),
    execute: async ({ to_agent, message }: { to_agent: string; message: string }) => {
      const target = loadTeamAgents().find((a) => a.slug === to_agent);
      if (!target) return `Target agent not found: ${to_agent}`;
      if (to_agent === senderSlug) return 'You cannot message yourself.';
      if (!canSend(senderSlug, to_agent)) return `Not authorized to message '${to_agent}'. Add it to canMessage first.`;
      if (!tryConsumeSend(senderSlug)) return overBudget();
      const id = randomBytes(4).toString('hex');
      appendTeamComms({ id, fromAgent: senderSlug, toAgent: to_agent, content: message, timestamp: new Date().toISOString(), protocol: 'message' });
      return `Message queued for ${target.name} (${to_agent}).`;
    },
  });

  const request = tool({
    name: 'agent_request',
    description: 'Ask another team agent for something and track it as a structured request they can reply to.',
    parameters: z.object({
      to_agent: z.string().describe('Target agent slug.'),
      request: z.string().describe('What you need from them.'),
    }),
    execute: async ({ to_agent, request: body }: { to_agent: string; request: string }) => {
      const target = loadTeamAgents().find((a) => a.slug === to_agent);
      if (!target) return `Target agent not found: ${to_agent}`;
      if (to_agent === senderSlug) return 'You cannot request from yourself.';
      if (!canSend(senderSlug, to_agent)) return `Not authorized to message '${to_agent}'.`;
      if (!tryConsumeSend(senderSlug)) return overBudget();
      const id = randomBytes(4).toString('hex');
      ensureDir(TEAM_REQUESTS_DIR);
      const payload: RequestFile = { id, fromAgent: senderSlug, toAgent: to_agent, content: body, createdAt: new Date().toISOString(), status: 'pending' };
      writeFileSync(requestFilePath(id), JSON.stringify(payload, null, 2), 'utf-8');
      appendTeamComms({ id: randomBytes(4).toString('hex'), fromAgent: senderSlug, toAgent: to_agent, content: body, timestamp: new Date().toISOString(), protocol: 'request', requestId: id });
      return `Request ${id} queued for ${target.name} (${to_agent}).`;
    },
  });

  const reply = tool({
    name: 'agent_reply',
    description: 'Reply to a pending request that was assigned to you (its request id is in the inbox item metadata).',
    parameters: z.object({
      request_id: z.string().describe('The request id to reply to.'),
      response: z.string().describe('Your response.'),
    }),
    execute: async ({ request_id, response }: { request_id: string; response: string }) => {
      const filePath = requestFilePath(request_id);
      if (!existsSync(filePath)) return `Request not found: ${request_id}`;
      let req: RequestFile;
      try { req = JSON.parse(readFileSync(filePath, 'utf-8')) as RequestFile; } catch { return `Could not read request: ${request_id}`; }
      if (req.toAgent !== senderSlug) return `Request ${request_id} is not assigned to you.`;
      if (!tryConsumeSend(senderSlug)) return overBudget();
      writeFileSync(filePath, JSON.stringify({ ...req, status: 'completed', response, respondedAt: new Date().toISOString() }, null, 2), 'utf-8');
      appendTeamComms({ id: randomBytes(4).toString('hex'), fromAgent: senderSlug, toAgent: req.fromAgent, content: response, timestamp: new Date().toISOString(), protocol: 'response', requestId: request_id });
      return `Replied to request ${request_id}.`;
    },
  });

  return [message, request, reply] as Tool<RuntimeContextValue>[];
}

/** Short instruction block injected into an agent's prompt when peer comms
 *  is enabled — replaces the v2 "comms not available" punt. */
export function commsInstructionBlock(agentSlug: string): string {
  const agent = loadTeamAgents().find((a) => a.slug === agentSlug);
  const targets = agentSlug === PRIMARY_SLUG
    ? 'any team agent'
    : (agent?.canMessage.length ? agent.canMessage.join(', ') : 'no one yet (your canMessage list is empty)');
  return [
    'Team messaging is available this cycle:',
    `- You can message: ${targets}.`,
    '- `agent_message` for a one-way note, `agent_request` to ask for something, `agent_reply` to answer a request assigned to you (id in the inbox item).',
    `- Keep it purposeful — there is a per-cycle send budget (max ${sendBudget()}). Don\'t ping-pong; if you\'re waiting on a reply, note it and move on.`,
    '- Inbox items tagged from=<agent> are messages from teammates; act on them or reply.',
  ].join('\n');
}

export function logCommsDelivery(count: number): void {
  if (count > 0) logger.info({ delivered: count }, 'peer-comms: delivered inbox items');
}
