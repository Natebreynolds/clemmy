/**
 * CLI surface for the 0.3 harness — a local smoke test path for
 * driving the Orchestrator end-to-end without touching the existing
 * v0.2 daemon channels.
 *
 *   clementine harness run "<prompt>"     One turn through the loop.
 *   clementine harness events <session>   Pretty-print all events.
 *
 * `run` creates a HarnessSession (kind=chat), builds the
 * Orchestrator, drives runTurn(), prints emitted events live, and
 * exits with the final OrchestratorDecision. If the agent calls
 * request_approval, the turn pauses (status=awaiting_approval) and
 * we print the pending approval — resume from a follow-up turn is
 * not wired yet.
 *
 * Requires OPENAI_API_KEY (or codex auth) to actually invoke the
 * Runner. Without it, the SDK will fail loudly.
 */
import { setDefaultOpenAIKey } from '@openai/agents';
import { buildOrchestratorAgent } from '../agents/orchestrator.js';
import { OPENAI_API_KEY } from '../config.js';
import {
  createSession,
  listEvents,
  getSession,
  type EventRow,
} from '../runtime/harness/eventlog.js';
import { runTurn } from '../runtime/harness/loop.js';

interface HarnessRunOptions {
  prompt: string;
  maxTurns?: number;
}

/**
 * One-turn execution. Returns the session id and the loop's status
 * so the caller can decide what to print.
 */
async function harnessRun(opts: HarnessRunOptions): Promise<number> {
  // The harness Runner uses the SDK's default OpenAI client. Wire
  // the API key explicitly so we get a clear error here instead of
  // a confusing 401 mid-run. Codex-native auth isn't supported by
  // the harness yet — that's a follow-up.
  if (!OPENAI_API_KEY) {
    process.stderr.write(
      'harness run: OPENAI_API_KEY is not set.\n' +
        '  Set it on env (export OPENAI_API_KEY=sk-...) or in your .env file.\n' +
        '  Codex-native auth is not yet wired through the harness.\n',
    );
    return 2;
  }
  setDefaultOpenAIKey(OPENAI_API_KEY);

  const session = createSession({
    kind: 'chat',
    metadata: { source: 'cli', invokedAt: new Date().toISOString() },
  });
  process.stdout.write(`harness session: ${session.id}\n`);
  process.stdout.write(`> ${opts.prompt}\n\n`);

  const agent = await buildOrchestratorAgent();
  const result = await runTurn({
    agent,
    sessionId: session.id,
    input: opts.prompt,
    maxTurns: opts.maxTurns,
  });

  // Print events emitted during this turn (the loop also persisted
  // them to SQLite — this is the live view of what happened).
  const events = listEvents(session.id).filter((ev) => ev.turn === result.turn);
  printEvents(events);

  process.stdout.write(`\nstatus: ${result.status}\n`);
  if (result.error) process.stdout.write(`error: ${result.error}\n`);
  if (result.finalOutput !== undefined) {
    process.stdout.write('finalOutput:\n');
    process.stdout.write(formatFinalOutput(result.finalOutput) + '\n');
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
  for (const ev of events) {
    const ts = ev.createdAt.slice(11, 19); // HH:MM:SS
    const head = `[${ts}] turn ${ev.turn} ${ev.role}.${ev.type}`;
    const detail = formatEventData(ev.type, ev.data);
    if (detail) {
      process.stdout.write(`${head}  ${detail}\n`);
    } else {
      process.stdout.write(`${head}\n`);
    }
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
  clementine harness run "<prompt>" [--max-turns N]
  clementine harness events <session-id>
`;

export async function runHarnessCli(args: string[]): Promise<number> {
  const sub = args[0] ?? '';
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (sub === 'run') {
    const { prompt, maxTurns } = parseRunArgs(args.slice(1));
    if (!prompt) {
      process.stderr.write('harness run: missing prompt\n');
      process.stderr.write(USAGE);
      return 2;
    }
    return harnessRun({ prompt, maxTurns });
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

function parseRunArgs(args: string[]): { prompt: string; maxTurns?: number } {
  const promptParts: string[] = [];
  let maxTurns: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--max-turns') {
      const n = Number(args[++i]);
      if (Number.isFinite(n) && n > 0) maxTurns = Math.floor(n);
      continue;
    }
    promptParts.push(a);
  }
  return { prompt: promptParts.join(' ').trim(), maxTurns };
}
