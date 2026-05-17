/**
 * CLI surface for the 0.3 harness — a local smoke test path for
 * driving the Orchestrator end-to-end without touching the existing
 * v0.2 daemon channels.
 *
 *   clementine harness run "<prompt>"     Multi-step conversation through the loop.
 *   clementine harness events <session>   Pretty-print all events.
 *
 * `run` creates a HarnessSession (kind=chat), builds the
 * Orchestrator, drives runConversation() — which auto-continues
 * across turns until the Orchestrator emits done=true or a budget
 * trips — and prints each emitted event live as it lands in the
 * event log. This exercises the same code path the desktop chat
 * dock and Discord harness use, so a green smoke test means
 * auto-continuation actually works, not just one turn.
 *
 * Authenticates via codex OAuth (`clementine auth login-native`).
 * Raw OPENAI_API_KEYs are intentionally NOT accepted.
 */
import { buildOrchestratorAgent } from '../agents/orchestrator.js';
import { configureHarnessRuntime } from '../runtime/harness/codex-client.js';
import {
  createSession,
  listEvents,
  getSession,
  type EventRow,
} from '../runtime/harness/eventlog.js';
import { runConversation } from '../runtime/harness/loop.js';
import { actionBus } from '../runtime/action-bus.js';

interface HarnessRunOptions {
  prompt: string;
  maxTurns?: number;
  maxSteps?: number;
}

/**
 * Multi-step execution. Subscribes to the actionBus for live event
 * printing, then drives runConversation until terminal state.
 */
async function harnessRun(opts: HarnessRunOptions): Promise<number> {
  const auth = await configureHarnessRuntime();
  if (!auth.ok) {
    process.stderr.write(`harness run: ${auth.reason}\n`);
    return 2;
  }

  const session = createSession({
    kind: 'chat',
    metadata: { source: 'cli', invokedAt: new Date().toISOString() },
  });
  process.stdout.write(`harness session: ${session.id}\n`);
  process.stdout.write(`> ${opts.prompt}\n\n`);

  // Live event printing. The conversation persists every event to
  // SQLite AND fans out on the actionBus; subscribing here gives the
  // user real-time progress instead of a silent wait followed by a
  // dump.
  const unsubscribe = actionBus.subscribe((bus) => {
    if (bus.kind !== 'harness.event') return;
    if (bus.sessionId !== session.id) return;
    printEvent(bus.event);
  });

  let result;
  try {
    const agent = await buildOrchestratorAgent();
    result = await runConversation({
      agent,
      sessionId: session.id,
      input: opts.prompt,
      maxSteps: opts.maxSteps,
      maxTurns: opts.maxTurns,
    });
  } finally {
    unsubscribe();
  }

  process.stdout.write(`\nstatus: ${result.status}\n`);
  process.stdout.write(`steps:  ${result.steps}\n`);
  if (result.error) process.stdout.write(`error: ${result.error}\n`);
  if (result.lastDecision) {
    process.stdout.write('lastDecision:\n');
    process.stdout.write(formatFinalOutput(result.lastDecision) + '\n');
  }
  process.stdout.write(`\nreplay with: clementine harness events ${session.id}\n`);

  if (result.status === 'failed') return 1;
  return 0;
}

function harnessShowEvents(sessionId: string): number {
  const row = getSession(sessionId);
  if (!row) {
    process.stderr.write(`no session ${sessionId}\n`);
    return 1;
  }
  process.stdout.write(`session ${row.id} (${row.kind}, ${row.status})\n`);
  process.stdout.write(`created: ${row.createdAt}\n\n`);
  printEvents(listEvents(sessionId));
  return 0;
}

// ---------- formatting ----------

function printEvents(events: EventRow[]): void {
  for (const ev of events) printEvent(ev);
}

function printEvent(ev: EventRow): void {
  const ts = ev.createdAt.slice(11, 19); // HH:MM:SS
  const head = `[${ts}] turn ${ev.turn} ${ev.role}.${ev.type}`;
  const detail = formatEventData(ev.type, ev.data);
  if (detail) {
    process.stdout.write(`${head}  ${detail}\n`);
  } else {
    process.stdout.write(`${head}\n`);
  }
}

function formatEventData(type: string, data: Record<string, unknown> | null): string {
  if (!data) return '';
  // Pick a small set of "headline" fields per event type so the
  // stream stays scannable. Full payload is in SQLite for replay.
  switch (type) {
    case 'turn_started':
      return shorten(String(data.input ?? ''));
    case 'tool_call':
      return `${String(data.tool ?? '?')}(${shorten(String(data.args ?? ''))})`;
    case 'tool_result':
      return `${String(data.tool ?? '?')} → ${shorten(String(data.output ?? ''))}`;
    case 'handoff':
      return `${String(data.from ?? '?')} → ${String(data.to ?? '?')}`;
    case 'approval_requested':
      return `${String(data.subject ?? '?')}${data.destructive ? ' [destructive]' : ''}`;
    case 'awaiting_user_input':
      return shorten(String(data.question ?? ''));
    case 'guardrail_tripped':
      return `${String(data.name ?? '?')}: ${shorten(String(data.reason ?? ''))}`;
    case 'turn_completed':
      return data.summary ? shorten(String(data.summary)) : '';
    case 'turn_failed':
      return shorten(String(data.error ?? ''));
    default:
      return shorten(JSON.stringify(data));
  }
}

function shorten(text: string, max = 80): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + '…';
}

function formatFinalOutput(value: unknown): string {
  if (value == null) return String(value);
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ---------- argv dispatch ----------

const USAGE = `Usage:
  clementine harness run "<prompt>" [--max-turns N] [--max-steps N]
  clementine harness events <session-id>
`;

export async function runHarnessCli(args: string[]): Promise<number> {
  const sub = args[0] ?? '';
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (sub === 'run') {
    const { prompt, maxTurns, maxSteps } = parseRunArgs(args.slice(1));
    if (!prompt) {
      process.stderr.write('harness run: missing prompt\n');
      process.stderr.write(USAGE);
      return 2;
    }
    return harnessRun({ prompt, maxTurns, maxSteps });
  }

  if (sub === 'events') {
    const sessionId = args[1];
    if (!sessionId) {
      process.stderr.write('harness events: missing session id\n');
      return 2;
    }
    return harnessShowEvents(sessionId);
  }

  process.stderr.write(`harness: unknown subcommand "${sub}"\n`);
  process.stderr.write(USAGE);
  return 2;
}

function parseRunArgs(args: string[]): {
  prompt: string;
  maxTurns?: number;
  maxSteps?: number;
} {
  const promptParts: string[] = [];
  let maxTurns: number | undefined;
  let maxSteps: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--max-turns') {
      const n = Number(args[++i]);
      if (Number.isFinite(n) && n > 0) maxTurns = Math.floor(n);
      continue;
    }
    if (a === '--max-steps') {
      const n = Number(args[++i]);
      if (Number.isFinite(n) && n > 0) maxSteps = Math.floor(n);
      continue;
    }
    promptParts.push(a);
  }
  return { prompt: promptParts.join(' ').trim(), maxTurns, maxSteps };
}
