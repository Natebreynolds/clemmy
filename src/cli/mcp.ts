/**
 * Clementine as an MCP server another app can hand work to (Claude Desktop,
 * Cursor, Codex, any MCP client), over stdio.
 *
 * Bounded on purpose: give her a task, follow up in a conversation started
 * here, and see where one stands. The work happens in the running app,
 * through the chat route the desktop uses, so her brain, memory, connected
 * tools and the owner's approvals all apply. Nothing here approves a card or
 * answers a question for the owner, and nothing reads or writes a
 * conversation this entry did not start.
 *
 * From the installed app (stdout carries only the protocol):
 *   ELECTRON_RUN_AS_NODE=1 <app executable> <daemon>/dist/cli/mcp.js
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { WEBHOOK_PORT, WEBHOOK_SECRET } from '../config.js';
import { sendTaskToApp, type RunOutcome } from './run.js';

const CONVERSATION_PREFIX = 'console:mcp-';
const CONVERSATION_RE = /^console:mcp-[a-f0-9]{12}$/;
export const DEFAULT_WAIT_SECONDS = 50;
const NOT_RUNNING = 'Clementine is not running on this computer. Open the Clementine app, then try again.';

export type TaskStatus = 'answered' | 'working' | 'needs_owner' | 'stopped' | 'failed' | 'unreachable';

export interface TaskReport {
  status: TaskStatus;
  conversation: string;
  reply: string;
  /** What the owner is asked, when the task waits on them. */
  waitingOn?: 'approval' | 'answer';
}

export function newConversationId(): string {
  return `${CONVERSATION_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function isOwnConversation(id: string): boolean {
  return CONVERSATION_RE.test(id);
}

/** What a turn came to, in the words a calling agent acts on. */
export function reportFromOutcome(outcome: RunOutcome, conversation: string): TaskReport {
  if (outcome.status === 'answered') return { status: 'answered', conversation, reply: outcome.text };
  if (outcome.status === 'needs_you') {
    return { status: 'needs_owner', conversation, reply: outcome.text, waitingOn: outcome.pendingApprovalId ? 'approval' : 'answer' };
  }
  if (outcome.status === 'unreachable') return { status: 'unreachable', conversation, reply: '' };
  if (outcome.stoppedReason === 'timeout') return { status: 'working', conversation, reply: '' };
  return { status: 'failed', conversation, reply: outcome.text || outcome.error || '' };
}

interface DetailTurn { role?: string; text?: string; pausedOnApprovalId?: string | null;
  terminal?: { presentation?: { status?: string; kind?: string } } }

/** Where a conversation stands, from the app's own conversation record. */
export function reportFromDetail(detail: { session?: { running?: boolean }; turns?: DetailTurn[] }, conversation: string): TaskReport {
  const turns = Array.isArray(detail.turns) ? detail.turns : [];
  const last = [...turns].reverse().find((turn) => turn.role === 'assistant');
  const lastOwner = turns.map((turn) => turn.role).lastIndexOf('user');
  const answeredLatest = last ? turns.lastIndexOf(last) > lastOwner : false;
  const status = answeredLatest ? last?.terminal?.presentation?.status : undefined;
  // A reply's final presentation is the answer; the chat can still read as
  // running for a moment while its after-turn bookkeeping finishes.
  if (!answeredLatest || (!status && detail.session?.running)) return { status: 'working', conversation, reply: '' };
  const reply = last?.text ?? '';
  if (status === 'needs_input' || last?.pausedOnApprovalId) {
    return { status: 'needs_owner', conversation, reply,
      waitingOn: last?.pausedOnApprovalId || last?.terminal?.presentation?.kind === 'approval' ? 'approval' : 'answer' };
  }
  if (status === 'cancelled') return { status: 'stopped', conversation, reply };
  if (status === 'failed' || status === 'blocked') return { status: 'failed', conversation, reply };
  return { status: 'answered', conversation, reply };
}

export function describeReport(report: TaskReport, waitedSeconds?: number): string {
  const tail = `\n\n(conversation: ${report.conversation})`;
  switch (report.status) {
    case 'answered': return `${report.reply || 'Clementine finished without a written reply.'}${tail}`;
    case 'needs_owner': return `${report.reply ? `${report.reply}\n\n` : ''}Clementine is waiting on the owner ${report.waitingOn === 'approval'
      ? 'to approve what she is about to do' : 'to answer her question'}. The owner answers in the Clementine app; this connection cannot answer for them. Check back with clem_task_status.${tail}`;
    case 'working': return `Clementine is still working on it${waitedSeconds ? ` after ${waitedSeconds} s` : ''}. Check back with clem_task_status.${tail}`;
    case 'stopped': return `The owner stopped this task in the app.${report.reply ? ` Her last words: ${report.reply}` : ''}${tail}`;
    case 'failed': return `The task did not finish.${report.reply ? ` ${report.reply}` : ''}${tail}`;
    case 'unreachable': return NOT_RUNNING;
  }
}

export async function readTaskReport(conversation: string, doFetch: typeof fetch = fetch): Promise<TaskReport> {
  try {
    const response = await doFetch(`http://127.0.0.1:${WEBHOOK_PORT}/api/console/sessions/${encodeURIComponent(`harness:${conversation}`)}`,
      { headers: { Authorization: `Bearer ${WEBHOOK_SECRET}` } });
    if (response.status === 404) return { status: 'failed', conversation, reply: 'No such conversation started from here.' };
    if (!response.ok) return { status: 'unreachable', conversation, reply: '' };
    return reportFromDetail(await response.json() as Parameters<typeof reportFromDetail>[0], conversation);
  } catch {
    return { status: 'unreachable', conversation, reply: '' };
  }
}

const reportShape = {
  status: z.enum(['answered', 'working', 'needs_owner', 'stopped', 'failed', 'unreachable']),
  conversation: z.string(),
  reply: z.string(),
  waitingOn: z.enum(['approval', 'answer']).optional(),
};

const result = (report: TaskReport, waitedSeconds?: number) => ({
  content: [{ type: 'text' as const, text: describeReport(report, waitedSeconds) }],
  structuredContent: { ...report },
  ...(report.status === 'unreachable' || report.status === 'failed' ? { isError: true } : {}),
});

export function createClementineMcpServer(doFetch: typeof fetch = fetch): McpServer {
  const server = new McpServer({ name: 'clementine', version: '1.0.0' });

  server.registerTool('clem_task', {
    title: 'Hand Clementine a task',
    description: 'Give Clementine, the owner\'s personal assistant running on this computer, a task, or a follow-up in a '
      + 'conversation started with this tool. She does it in her app with her own memory, connected apps and tools, and '
      + 'answers here. Anything that needs the owner (approving what she is about to do, or a question) waits for the owner '
      + 'in her app; this tool says so and cannot answer for them. If she is still working when the wait ends, check later '
      + 'with clem_task_status.',
    inputSchema: {
      task: z.string().min(1).max(8000).describe('What to do, in plain words, as you would ask a person.'),
      conversation: z.string().optional().describe('A conversation id this tool returned, to follow up in it.'),
      wait_seconds: z.number().int().min(5).max(600).optional()
        .describe(`How long to wait for her reply before returning (default ${DEFAULT_WAIT_SECONDS}).`),
    },
    outputSchema: reportShape,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ task, conversation, wait_seconds }, extra) => {
    if (conversation && !isOwnConversation(conversation)) {
      return result({ status: 'failed', conversation, reply: 'That conversation was not started from here; start a new task instead.' });
    }
    const id = conversation ?? newConversationId();
    const wait = wait_seconds ?? DEFAULT_WAIT_SECONDS;
    const progressToken = extra?._meta?.progressToken;
    const started = Date.now();
    const beat = progressToken === undefined ? null : setInterval(() => {
      void extra.sendNotification({ method: 'notifications/progress', params: { progressToken,
        progress: Math.min(wait, Math.round((Date.now() - started) / 1000)), total: wait, message: 'Clementine is working on it' } })
        .catch(() => undefined);
    }, 10_000);
    try {
      const outcome = await sendTaskToApp({ task, sessionId: id, timeoutSeconds: wait, requestPrefix: 'mcp' }, doFetch);
      return result(reportFromOutcome(outcome, id), wait);
    } finally {
      if (beat) clearInterval(beat);
    }
  });

  server.registerTool('clem_task_status', {
    title: 'Check on a Clementine task',
    description: 'Where a task handed to Clementine with clem_task stands: still working, answered (with her reply), '
      + 'waiting on the owner, stopped, or failed.',
    inputSchema: { conversation: z.string().describe('The conversation id clem_task returned.') },
    outputSchema: reportShape,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ conversation }) => {
    if (!isOwnConversation(conversation)) {
      return result({ status: 'failed', conversation, reply: 'That conversation was not started from here.' });
    }
    return result(await readTaskReport(conversation, doFetch));
  });

  return server;
}

function isEntry(): boolean {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isEntry()) {
  // Anything printed to stdout would break the protocol; a stray log goes to stderr.
  console.log = console.error;
  await createClementineMcpServer().connect(new StdioServerTransport());
}
