/**
 * `clementine run "<task>"` — one task through the RUNNING app, for scripts
 * and CI.
 *
 *   clementine run "<task>" [--chat <id>] [--json] [--timeout <seconds>]
 *
 * The task goes through the installed daemon's own chat route, so it is the
 * same accepted turn the desktop sends: same brain, consent, memory and
 * records, and never a second process writing the live home. The reply is
 * printed as text (or one JSON object with --json) and the exit code says
 * how the turn ended, so a script can branch on it:
 *
 *   0  answered
 *   2  Clem needs the owner (a question, or a card to approve) — the reply
 *      says what; answer in the app or with `clementine run --chat <id> "<answer>"`
 *   1  the turn failed, or hit its turn or token budget
 *   4  the app is not running, or refused the connection
 */
import { randomUUID } from 'node:crypto';
import { WEBHOOK_PORT, WEBHOOK_SECRET } from '../config.js';

export interface RunCliOptions {
  task: string;
  chat?: string;
  json: boolean;
  timeoutSeconds: number;
}

/** A frame of the chat route's NDJSON reply. Only the fields the CLI reads. */
export interface ChatStreamFrame {
  type: string;
  text?: string;
  sessionId?: string;
  pendingApprovalId?: string | null;
  stoppedReason?: string;
  error?: string;
  tool?: string;
}

export interface RunOutcome {
  status: 'answered' | 'needs_you' | 'failed' | 'unreachable';
  exitCode: 0 | 1 | 2 | 4;
  sessionId: string | null;
  text: string;
  stoppedReason: string | null;
  pendingApprovalId: string | null;
  error: string | null;
}

export const RUN_EXIT_ANSWERED = 0;
export const RUN_EXIT_FAILED = 1;
export const RUN_EXIT_NEEDS_YOU = 2;
export const RUN_EXIT_UNREACHABLE = 4;

export function parseRunArgs(args: readonly string[]): RunCliOptions | { error: string } {
  const options: RunCliOptions = { task: '', json: false, timeoutSeconds: 900 };
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--chat') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) return { error: '--chat needs a conversation id' };
      options.chat = value; index += 1; continue;
    }
    if (arg === '--timeout') {
      const value = Number(args[index + 1]);
      if (!Number.isFinite(value) || value <= 0) return { error: '--timeout needs a number of seconds' };
      options.timeoutSeconds = value; index += 1; continue;
    }
    if (arg.startsWith('--')) return { error: `unknown option ${arg}` };
    words.push(arg);
  }
  options.task = words.join(' ').trim();
  if (!options.task) return { error: 'run needs the task to do, in quotes' };
  return options;
}

/** Split an NDJSON body into frames; a bad line is skipped, never fatal. */
export function parseChatStreamFrames(body: string): ChatStreamFrame[] {
  const frames: ChatStreamFrame[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') frames.push(parsed as ChatStreamFrame);
    } catch { /* a partial or foreign line is not a frame */ }
  }
  return frames;
}

/** What the turn came to, from its frames. Pure, so the mapping is pinned. */
export function runOutcomeFromFrames(frames: readonly ChatStreamFrame[], fallbackSessionId: string | null = null): RunOutcome {
  const done = [...frames].reverse().find((frame) => frame.type === 'done');
  const error = [...frames].reverse().find((frame) => frame.type === 'error');
  const sessionId = done?.sessionId ?? frames.find((frame) => typeof frame.sessionId === 'string')?.sessionId ?? fallbackSessionId;
  if (!done) {
    return { status: 'failed', exitCode: RUN_EXIT_FAILED, sessionId, text: '', stoppedReason: null, pendingApprovalId: null,
      error: error?.error ?? 'the turn ended without a reply' };
  }
  const stoppedReason = typeof done.stoppedReason === 'string' ? done.stoppedReason : null;
  const pendingApprovalId = typeof done.pendingApprovalId === 'string' && done.pendingApprovalId ? done.pendingApprovalId : null;
  const text = typeof done.text === 'string' ? done.text : '';
  if (pendingApprovalId || stoppedReason === 'pending-approval' || stoppedReason === 'awaiting-input') {
    return { status: 'needs_you', exitCode: RUN_EXIT_NEEDS_YOU, sessionId, text, stoppedReason, pendingApprovalId, error: null };
  }
  if (stoppedReason === null || stoppedReason === 'success' || stoppedReason === 'in-progress') {
    return { status: 'answered', exitCode: RUN_EXIT_ANSWERED, sessionId, text, stoppedReason, pendingApprovalId: null, error: null };
  }
  return { status: 'failed', exitCode: RUN_EXIT_FAILED, sessionId, text, stoppedReason, pendingApprovalId: null, error: error?.error ?? null };
}

export function formatRunOutcome(outcome: RunOutcome, json: boolean): string {
  if (json) return JSON.stringify(outcome);
  const lines: string[] = [];
  if (outcome.text) lines.push(outcome.text);
  if (outcome.status === 'needs_you') {
    lines.push('', outcome.pendingApprovalId
      ? `Clem needs your OK (approval ${outcome.pendingApprovalId}); open the app, or answer with: clementine run --chat ${outcome.sessionId ?? '<id>'} "<your answer>"`
      : `Clem asked a question; answer with: clementine run --chat ${outcome.sessionId ?? '<id>'} "<your answer>"`);
  } else if (outcome.status === 'failed') {
    lines.push('', `The turn did not finish${outcome.stoppedReason ? ` (${outcome.stoppedReason})` : ''}${outcome.error ? `: ${outcome.error}` : '.'}`);
  } else if (outcome.status === 'unreachable') {
    lines.push(outcome.error ?? 'Clementine is not running.');
  }
  if (outcome.sessionId && !json) lines.push('', `conversation ${outcome.sessionId}`);
  return lines.join('\n');
}

export async function runCliTask(options: RunCliOptions, io: { fetch?: typeof fetch; stdout: (text: string) => void } = { stdout: (text) => process.stdout.write(`${text}\n`) }): Promise<number> {
  const doFetch = io.fetch ?? fetch;
  const sessionId = options.chat ?? `console:run-${randomUUID().slice(0, 12)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutSeconds * 1000);
  let outcome: RunOutcome;
  try {
    const response = await doFetch(`http://127.0.0.1:${WEBHOOK_PORT}/api/console/home/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WEBHOOK_SECRET}` },
      body: JSON.stringify({ message: options.task, sessionId, clientRequestId: `cli:${randomUUID()}` }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      outcome = { status: 'unreachable', exitCode: RUN_EXIT_UNREACHABLE, sessionId, text: '', stoppedReason: null, pendingApprovalId: null,
        error: response.status === 401 ? 'The app refused the connection: run this as the user the app runs as.' : `The app answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` };
    } else {
      outcome = runOutcomeFromFrames(parseChatStreamFrames(await response.text()), sessionId);
    }
  } catch (error) {
    const aborted = controller.signal.aborted;
    outcome = { status: aborted ? 'failed' : 'unreachable', exitCode: aborted ? RUN_EXIT_FAILED : RUN_EXIT_UNREACHABLE, sessionId, text: '',
      stoppedReason: aborted ? 'timeout' : null, pendingApprovalId: null,
      error: aborted ? `no reply within ${options.timeoutSeconds} s; the turn may still be running in the app` : `Clementine is not running on port ${WEBHOOK_PORT} (${error instanceof Error ? error.message : String(error)}).` };
  } finally { clearTimeout(timer); }
  io.stdout(formatRunOutcome(outcome, options.json));
  return outcome.exitCode;
}

export async function runRunCli(args: string[]): Promise<number> {
  const parsed = parseRunArgs(args);
  if ('error' in parsed) {
    process.stderr.write(`run: ${parsed.error}\nusage: clementine run "<task>" [--chat <id>] [--json] [--timeout <seconds>]\n`);
    return RUN_EXIT_FAILED;
  }
  return runCliTask(parsed);
}
