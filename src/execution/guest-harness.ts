/**
 * Guest agent harnesses — run the user's REAL Claude Code / Codex CLI as a
 * full agent inside one of their local projects.
 *
 * This is the inverse profile of the claude-headless MODEL wire
 * (src/runtime/harness/claude-headless-model.ts): that path strips the CLI
 * down to a text-only reasoning boundary (slash commands off, tools off,
 * replacement system prompt) so Clem's own harness stays in charge. Here the
 * point is the opposite — the project's slash commands, skills, CLAUDE.md /
 * AGENTS.md, and .mcp.json wiring are exactly what produce the output the
 * user built that project for, so the guest harness runs COMPLETE, in the
 * project directory, on the user's own subscription auth. Clem orchestrates
 * (picks the project, writes the prompt, watches the stream, collects the
 * artifacts); the guest does the work.
 *
 * Effect model: the SPAWN is the gated effect. Callers must only pass
 * projects from the user's workspace roster, and the tool layer owns the
 * approval beat. Inside the run, Claude Code is bounded by an explicit
 * allowed-tools profile (never --dangerously-skip-permissions) and Codex by
 * its workspace-write sandbox.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { augmentPath, mergedSpawnEnv } from '../runtime/spawn-env.js';
import { resolveClaudeCliPath } from '../runtime/harness/claude-headless-model.js';
import { assertLiveModelTransportAllowed } from '../runtime/harness/live-model-guard.js';
import { recordModelUsage } from '../runtime/usage-log.js';

const logger = pino({ name: 'clementine.guest-harness' });

export type GuestHarnessId = 'claude' | 'codex';

export interface GuestRunEvent {
  kind: 'status' | 'assistant' | 'tool' | 'stderr';
  text: string;
}

export interface GuestRunOptions {
  harness: GuestHarnessId;
  /** Absolute path to the project. Callers MUST resolve this from the
   *  workspace roster — this module only re-checks it exists. */
  projectPath: string;
  /** The instruction, e.g. "/seo-audit https://example.com" or free text. */
  prompt: string;
  model?: string;
  /** Claude only — overrides the default allowed-tools profile. */
  allowedTools?: string[];
  timeoutMs?: number;
  sessionId?: string;
  /** Abort = the user's kill switch. The child gets SIGTERM, then SIGKILL. */
  signal?: AbortSignal;
  onEvent?: (event: GuestRunEvent) => void;
}

export interface GuestRunResult {
  ok: boolean;
  harness: GuestHarnessId;
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
  /** The guest agent's final message (empty when the run died early). */
  finalMessage: string;
  /** Project-relative paths created or modified during the run. */
  changedFiles: string[];
  durationMs: number;
  stderrTail: string;
}

/** Hours-scale HARD ceiling, not a pace-setter (owner directive 2026-07-30:
 *  sub-CLI handoffs can legitimately run 2–3 hours; a run's liveness is
 *  whether it is still emitting events, which the stall detector owns — see
 *  guest-run-jobs). The live incident: the old 30-minute default would have
 *  guillotined a healthy 35-minute brief right before its finish line. When
 *  this DOES fire it reports loudly down the origin lineage, never silently. */
export const GUEST_RUN_DEFAULT_TIMEOUT_MS = 4 * 60 * 60 * 1000;

type SpawnLike = typeof spawn;
let spawnImpl: SpawnLike = spawn;
/** Test seam — every test that can reach a guest run must stub this. */
export function setGuestHarnessSpawnForTest(fn: SpawnLike | null): void {
  spawnImpl = fn ?? spawn;
}

type BinaryResolver = (harness: GuestHarnessId) => string | null;
let binaryResolverOverride: BinaryResolver | null = null;
/** Test seam — augmentPath always re-adds the user's real bin dirs, so PATH
 *  games can't hide an installed CLI from a test; stub the resolver instead. */
export function setGuestHarnessBinaryResolverForTest(fn: BinaryResolver | null): void {
  binaryResolverOverride = fn;
}

/** Resolve a guest harness binary. The user's REAL PATH is searched first
 *  and augmentPath's discovered dirs only as a fallback: augmentation
 *  prepends every runtime-manager dir it finds, so with a full shell PATH
 *  it can shadow the user's active toolchain with a stale sibling install
 *  (live 07-30: nvm v24's codex 0.36.0 shadowed the active v22's 0.144.3
 *  and then choked on the user's current ~/.codex/config.toml). The
 *  fallback still covers bare Electron launches that inherit no user PATH. */
export function resolveGuestHarnessBinary(harness: GuestHarnessId): string | null {
  if (binaryResolverOverride) return binaryResolverOverride(harness);
  if (harness === 'claude') return resolveClaudeCliPath();
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  const original = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const augmentedOnly = augmentPath(process.env.PATH).split(path.delimiter)
    .filter((dir) => dir && !original.includes(dir));
  for (const dir of [...original, ...augmentedOnly]) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const candidate = path.join(dir, `codex${ext}`);
        if (existsSync(candidate)) return candidate;
      } catch {
        /* unreadable PATH entry — keep scanning */
      }
    }
  }
  return null;
}

export function guestHarnessAvailable(harness: GuestHarnessId): boolean {
  return resolveGuestHarnessBinary(harness) !== null;
}

/** Baseline Claude Code profile for a project run: the file/search/web tools
 *  plus Bash and the project's OWN MCP servers (read from its .mcp.json).
 *  Broad on purpose — the user approved the run and it executes as them, in
 *  their project — but always explicit, never skip-permissions: an unlisted
 *  tool fails visibly instead of running silently. */
export function defaultClaudeAllowedTools(projectPath: string): string[] {
  const tools = [
    'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
    'Glob', 'Grep', 'Bash',
    'WebFetch', 'WebSearch',
    'Task', 'TodoWrite', 'Skill',
  ];
  for (const server of readProjectMcpServers(projectPath)) tools.push(`mcp__${server}`);
  return tools;
}

export function readProjectMcpServers(projectPath: string): string[] {
  try {
    const raw = readFileSync(path.join(projectPath, '.mcp.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    return Object.keys(parsed.mcpServers ?? {});
  } catch {
    return [];
  }
}

export function buildGuestArgs(opts: {
  harness: GuestHarnessId;
  projectPath: string;
  prompt: string;
  model?: string;
  allowedTools?: string[];
  lastMessageFile?: string;
}): string[] {
  if (opts.harness === 'claude') {
    const allowed = opts.allowedTools?.length ? opts.allowedTools : defaultClaudeAllowedTools(opts.projectPath);
    const args = [
      '-p', opts.prompt,
      // stream-json in print mode requires --verbose (CLI enforces it).
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ...allowed,
    ];
    if (opts.model) args.push('--model', opts.model);
    return args;
  }
  const args = [
    'exec', '--json',
    '--sandbox', 'workspace-write',
    '--skip-git-repo-check',
    '-C', opts.projectPath,
  ];
  if (opts.model) args.push('-m', opts.model);
  // Long flag only: the -o short alias arrived in later codex versions
  // (0.36.0 rejects it; verified live), the long form works everywhere.
  if (opts.lastMessageFile) args.push('--output-last-message', opts.lastMessageFile);
  args.push(opts.prompt);
  return args;
}

const CHANGED_SCAN_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.turbo',
  '.venv', 'venv', '__pycache__', '.cache', 'coverage', 'target',
]);
const CHANGED_SCAN_MAX_DEPTH = 5;
const CHANGED_SCAN_MAX_FILES = 200;
const CHANGED_SCAN_MAX_DIRS = 2000;

/** Files created/modified since the run started, project-relative. A bounded
 *  metadata-only walk — never reads contents, never enters dependency dirs,
 *  and skips hydrate-on-demand cloud mounts where stat can stall. */
export function scanChangedFiles(root: string, sinceMs: number): string[] {
  if (/\/Library\/CloudStorage\//.test(root) || /\/Library\/Mobile Documents\//.test(root)) return [];
  const changed: string[] = [];
  let dirsVisited = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > CHANGED_SCAN_MAX_DEPTH || changed.length >= CHANGED_SCAN_MAX_FILES) return;
    if (dirsVisited++ > CHANGED_SCAN_MAX_DIRS) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (changed.length >= CHANGED_SCAN_MAX_FILES) return;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!CHANGED_SCAN_SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        // 2s slack: some filesystems round mtimes down.
        if (statSync(full).mtimeMs >= sinceMs - 2000) changed.push(path.relative(root, full));
      } catch {
        /* transient file — the guest may still be cleaning up */
      }
    }
  };
  walk(root, 0);
  return changed.sort();
}

interface ParsedLine {
  event?: GuestRunEvent;
  finalMessage?: string;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; model?: string };
}

/** Claude Code --print stream-json events. */
function parseClaudeLine(raw: string): ParsedLine | null {
  let evt: any;
  try {
    evt = JSON.parse(raw);
  } catch {
    return null;
  }
  if (evt?.type === 'assistant' && Array.isArray(evt.message?.content)) {
    for (const block of evt.message.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return { event: { kind: 'assistant', text: block.text } };
      }
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        // Narration must carry REALITY (live 2026-07-30: eight bare
        // "tool: Bash" lines were useless to the user, the panel, and the
        // stall detector). Structural pick of the most informative input
        // field — no per-tool knowledge beyond common CLI arg names.
        const input = block.input && typeof block.input === 'object' ? block.input as Record<string, unknown> : {};
        const detail = [input.command, input.file_path, input.path, input.pattern, input.url, input.query, input.prompt, input.description]
          .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
          ?? Object.values(input).find((value): value is string => typeof value === 'string' && value.trim().length > 0);
        return { event: { kind: 'tool', text: detail ? `${block.name}: ${String(detail).slice(0, 200)}` : block.name } };
      }
    }
    return null;
  }
  if (evt?.type === 'result') {
    const usage = evt.usage && typeof evt.usage === 'object'
      ? {
        inputTokens: Number(evt.usage.input_tokens ?? 0),
        cachedInputTokens: Number(evt.usage.cache_read_input_tokens ?? 0),
        outputTokens: Number(evt.usage.output_tokens ?? 0),
        model: typeof evt.modelUsage === 'object' && evt.modelUsage ? Object.keys(evt.modelUsage)[0] : undefined,
      }
      : undefined;
    const finalMessage = typeof evt.result === 'string' ? evt.result
      : typeof evt.error === 'string' ? evt.error : '';
    return { finalMessage, usage };
  }
  return null;
}

/** Codex `exec --json` JSONL events — shapes drift across versions, so this
 *  is best-effort for narration; the authoritative final message comes from
 *  the -o last-message file. */
function parseCodexLine(raw: string): ParsedLine | null {
  let evt: any;
  try {
    evt = JSON.parse(raw);
  } catch {
    return null;
  }
  const item = evt?.item ?? evt?.msg;
  const type = item?.type ?? evt?.type;
  const text = typeof item?.text === 'string' ? item.text
    : typeof item?.message === 'string' ? item.message : '';
  if (typeof type !== 'string') return null;
  if (/agent_message/.test(type) && text.trim()) return { event: { kind: 'assistant', text } };
  if (/command|exec|tool|mcp/.test(type)) {
    const label = typeof item?.command === 'string' ? item.command : type;
    return { event: { kind: 'tool', text: String(label).slice(0, 200) } };
  }
  return null;
}

export async function runGuestHarness(opts: GuestRunOptions): Promise<GuestRunResult> {
  const startedAt = Date.now();
  const projectPath = path.resolve(opts.projectPath);
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    throw new Error(`Guest harness project path is not a directory: ${projectPath}`);
  }
  const binary = resolveGuestHarnessBinary(opts.harness);
  if (!binary) {
    throw new Error(
      `The ${opts.harness} CLI is not installed (or not on PATH). `
      + `Install it first — cli_setup can do this with the user's approval.`,
    );
  }
  if (spawnImpl === spawn) assertLiveModelTransportAllowed(`guest-harness:${opts.harness}`);

  const lastMessageFile = opts.harness === 'codex'
    ? path.join(projectPath, `.clem-guest-last-message-${startedAt}.txt`)
    : undefined;
  const args = buildGuestArgs({
    harness: opts.harness,
    projectPath,
    prompt: opts.prompt,
    model: opts.model,
    allowedTools: opts.allowedTools,
    lastMessageFile,
  });

  const env = mergedSpawnEnv();
  const parse = opts.harness === 'claude' ? parseClaudeLine : parseCodexLine;
  const timeoutMs = opts.timeoutMs ?? GUEST_RUN_DEFAULT_TIMEOUT_MS;

  logger.info({ harness: opts.harness, projectPath, promptPreview: opts.prompt.slice(0, 120) }, 'guest harness run starting');
  opts.onEvent?.({ kind: 'status', text: `Starting ${opts.harness} in ${path.basename(projectPath)}` });

  const child = spawnImpl(binary, args, { cwd: projectPath, env, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessByStdio<null, Readable, Readable>;

  let finalMessage = '';
  let usage: ParsedLine['usage'];
  let stderrTail = '';
  let timedOut = false;
  let killed = false;

  const terminate = () => {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 5000).unref();
  };
  const onAbort = () => {
    killed = true;
    opts.onEvent?.({ kind: 'status', text: 'Stopped by the user' });
    terminate();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(code);
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      opts.onEvent?.({ kind: 'status', text: `Timed out after ${Math.round(timeoutMs / 60000)} min — stopping the run` });
      terminate();
    }, timeoutMs);

    let stdoutBuffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8');
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf('\n');
        if (!line) continue;
        const parsed = parse(line);
        if (!parsed) continue;
        if (parsed.event) opts.onEvent?.(parsed.event);
        if (parsed.finalMessage !== undefined) finalMessage = parsed.finalMessage;
        if (parsed.usage) usage = parsed.usage;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-4000);
    });
    child.on('error', (err) => {
      stderrTail = (stderrTail + `\nspawn error: ${err.message}`).slice(-4000);
      settle(null);
    });
    child.on('close', (code) => settle(code));
  });

  if (opts.harness === 'codex' && lastMessageFile) {
    try {
      const fromFile = readFileSync(lastMessageFile, 'utf-8').trim();
      if (fromFile) finalMessage = fromFile;
    } catch {
      /* run died before writing it — keep whatever the stream gave us */
    }
    try { const { unlinkSync } = await import('node:fs'); unlinkSync(lastMessageFile); } catch { /* best-effort cleanup */ }
  }

  const durationMs = Date.now() - startedAt;
  if (usage) {
    recordModelUsage({
      sessionId: opts.sessionId || 'guest-harness',
      channel: 'guest-harness',
      model: usage.model || `${opts.harness}-guest`,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      durationMs,
    });
  }

  const changedFiles = scanChangedFiles(projectPath, startedAt).filter((f) => !f.startsWith('.clem-guest-last-message-'));
  const ok = exitCode === 0 && !timedOut && !killed;
  logger.info({ harness: opts.harness, exitCode, timedOut, killed, durationMs, changedFiles: changedFiles.length }, 'guest harness run finished');
  return { ok, harness: opts.harness, exitCode, timedOut, killed, finalMessage, changedFiles, durationMs, stderrTail };
}
