import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelBehaviorError } from '@openai/agents';
import {
  BASE_DIR as CONFIG_BASE_DIR,
  invalidateRuntimeConfigSnapshot,
} from '../config.js';
import { PlanStore } from '../planning/plan-store.js';
import { SessionStore } from '../memory/session-store.js';
import matter from 'gray-matter';
import {
  DAILY_NOTES_DIR,
  IDENTITY_FILE,
  INBOX_DIR,
  MEMORY_FILE,
  PEOPLE_DIR,
  PROJECTS_DIR,
  SOUL_FILE,
  SYSTEM_DIR,
  TASKS_DIR,
  TOPICS_DIR,
  VAULT_DIR,
  CRON_FILE,
  WORKFLOWS_DIR,
  WORKING_MEMORY_FILE,
  ensureTodayNote,
  ensureVaultScaffold,
} from '../memory/vault.js';
import {
  DEFAULT_TOOL_RESULT_MAX_CHARS,
  formatRecallableToolText,
  truncateToolText as truncateToolTextCanonical,
} from '../runtime/harness/tool-output-format.js';

export const plans = new PlanStore();
export const sessions = new SessionStore();
export const BASE_DIR = CONFIG_BASE_DIR;
export const GOALS_DIR = path.join(BASE_DIR, 'goals');
export const TASKS_FILE = path.join(TASKS_DIR, 'TASKS.md');
export const TIMERS_FILE = path.join(BASE_DIR, '.timers.json');
export const AGENTS_DIR = path.join(SYSTEM_DIR, 'agents');
export const TEAM_COMMS_LOG = path.join(BASE_DIR, 'logs', 'team-comms.jsonl');
export const TEAM_REQUESTS_DIR = path.join(BASE_DIR, 'team-requests');
export const DELEGATIONS_DIR = path.join(BASE_DIR, 'delegations');
export const PENDING_ACTIONS_DIR = path.join(BASE_DIR, 'pending-actions');
export const AGENT_STATE_DIR = path.join(BASE_DIR, 'agents-state');
export const AGENT_INBOX_DIR = path.join(BASE_DIR, 'agents-inbox');
export { INBOX_DIR };
export const CRON_RUNS_DIR = path.join(BASE_DIR, 'cron', 'runs');
export const CRON_TRIGGERS_DIR = path.join(BASE_DIR, 'cron', 'triggers');
export const CRON_PROGRESS_DIR = path.join(BASE_DIR, 'cron', 'progress');
export const WORKFLOW_RUNS_DIR = path.join(BASE_DIR, 'workflows', 'runs');

/**
 * Cap a single tool result so a runaway tool output (a 50KB file dump,
 * a giant JSON blob) doesn't fill the model's context. Defaults to
 * 4000 chars (~1000 tokens), which fits normal responses comfortably
 * but stops the worst offenders. Callers that genuinely need raw
 * fidelity (e.g. read_file with an explicit byte budget) can pass a
 * higher maxChars.
 *
 * Lowered 8000 → 4000 after the plan-timeout regression hit
 * a 1.4MB Codex request body that consistently SSE-truncated. Tool
 * returns accumulated unbounded across 31 history items; tighter
 * default keeps long sessions under Codex's request-size cliff.
 *
 * The truncation marker tells the model the response was cut and how
 * much was dropped, so it can choose to re-call with a narrower scope
 * (offset/limit, filter, more specific query) or call
 * `recall_tool_result` with the callId to pull the original full output from
 * disk without re-invoking the upstream tool.
 */
export function truncateToolText(text: string, maxChars: number = DEFAULT_TOOL_RESULT_MAX_CHARS): string {
  return truncateToolTextCanonical(text, maxChars);
}

export { DEFAULT_TOOL_RESULT_MAX_CHARS };

/** Keep a complete corrective schema small enough for the prompt's inline
 * tool-result presentation. Oversized schemas use discovery, never a slice. */
export const INVALID_INPUT_SCHEMA_GUIDANCE_MAX_CHARS = 4_000;

export interface TextToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface InvalidArgumentsTextResult extends TextToolResult {
  isError: true;
}

// Nominal in-process identity for a local tool's repairable argument refusal.
// The WeakSet is deliberately module-private: provider/model JSON can copy the
// public MCP shape, but it cannot manufacture the identity consumed by the
// local runtime bridge.
const INVALID_ARGUMENTS_TEXT_RESULTS = new WeakSet<object>();

export function textResult(
  text: string,
  options?: { maxChars?: number; isError?: boolean },
): TextToolResult {
  const capped = formatRecallableToolText(text, {
    maxChars: options?.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS,
  });
  return {
    content: [{ type: 'text', text: capped }],
    ...(options?.isError ? { isError: true } : {}),
  };
}

/**
 * Return ordinary MCP error content while retaining non-serializable nominal
 * proof that this exact in-process value is a repairable argument refusal.
 */
export function invalidArgumentsTextResult(
  text: string,
  options?: { maxChars?: number },
): InvalidArgumentsTextResult {
  const result = textResult(text, {
    ...(options?.maxChars === undefined ? {} : { maxChars: options.maxChars }),
    isError: true,
  }) as InvalidArgumentsTextResult;
  INVALID_ARGUMENTS_TEXT_RESULTS.add(result);
  return result;
}

/**
 * A native tool outcome that CHANGED NOTHING — "already exists", an empty
 * draft, a malformed transform. Same shape as the repairable-argument refusal
 * above and for the same reason: ordinary MCP error content on the wire, plus a
 * module-private nominal identity that provider or model JSON cannot forge.
 *
 * `isError: true` is deliberate belt-and-braces. If a carrier ever reshapes the
 * value and the in-process identity is lost, the settlement still reads a
 * structured failure and lands on `unknown` — inert — instead of the
 * `succeeded, mutating=1` that made the ledger show a write that never happened.
 */
/** A producer-owned no-effect failure can need something other than argument
 * repair. This metadata is deliberately nominal; serialized lookalikes carry
 * neither no-effect proof nor retry authority. */
export interface LocalNonWriteClassification {
  kind: 'invalid_arguments' | 'input_required' | 'auth_failure' | 'unknown';
  providerStatus?: number;
}
/** The same nominal no-effect fact on a throwing internal adapter boundary. */
export class LocalNonWriteError extends Error {
  constructor(message: string, readonly status: string, readonly classification: LocalNonWriteClassification) {
    super(message); this.name = 'LocalNonWriteError';
  }
}

export type LocalFailureEffect = 'uncertain' | 'acknowledged';
/** A failed operation can retain a known earlier effect without claiming the
 * whole task succeeded. Only host code can mint this nominal fact. */
export class LocalExecutionFailureError extends Error {
  constructor(message: string, readonly effect: LocalFailureEffect) {
    super(message); this.name = 'LocalExecutionFailureError';
  }
}
const EXECUTION_FAILURE_EFFECTS = new WeakMap<object, LocalFailureEffect>();
export function executionFailureTextResult(text: string, effect: LocalFailureEffect): TextToolResult {
  const result = textResult(text, { isError: true });
  EXECUTION_FAILURE_EFFECTS.set(result, effect);
  return result;
}
export function localExecutionFailureEffect(result: unknown): LocalFailureEffect | undefined {
  return result && typeof result === 'object' ? EXECUTION_FAILURE_EFFECTS.get(result) : undefined;
}

const NON_WRITE_TEXT_RESULTS = new WeakMap<object, { status: string; classification?: LocalNonWriteClassification }>();

export function nonWriteTextResult(
  status: string,
  text: string,
  options?: { maxChars?: number; classification?: LocalNonWriteClassification },
): TextToolResult {
  const result = textResult(text, {
    ...(options?.maxChars === undefined ? {} : { maxChars: options.maxChars }),
    isError: true,
  });
  const token = /^[a-z0-9_]{1,32}$/.test(status) ? status : 'non_write';
  NON_WRITE_TEXT_RESULTS.set(result, {
    status: token,
    ...(options?.classification ? { classification: Object.freeze({ ...options.classification }) } : {}),
  });
  // Deliberately NO serialized `ok:false` marker. It looks identical to an
  // ordinary failed write, so reading it back as no-effect proof would let a
  // mutation of unknown fate be retried. The local bridge carries this outcome
  // in a nominal class instead, which nothing outside the process can forge.
  return result;
}

/** The status token of an in-process non-write outcome, or null. */
export function localNonWriteStatus(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  return NON_WRITE_TEXT_RESULTS.get(result as object)?.status ?? null;
}

export function localNonWriteClassification(result: unknown): LocalNonWriteClassification | undefined {
  if (!result || typeof result !== 'object') return undefined;
  return NON_WRITE_TEXT_RESULTS.get(result as object)?.classification;
}

export type SdkToolInputValidationError = ModelBehaviorError & {
  originalError?: unknown;
  toolInvocation?: {
    input?: unknown;
  };
};

/**
 * The SDK's InvalidToolInputError is intentionally not exported from its
 * package root. Identify that private subtype by its exported nominal base and
 * the two own fields its constructor assigns, never by constructor/message
 * spelling. This guard is used only at the SDK errorFunction boundary where
 * validation ran before execute — the one place a tool can still say, with
 * nominal certainty, that its body never started. Every local, shell, carrier
 * and provider tool shares this single detector so the settlement kernel never
 * has to read the laundered prose.
 */
export function isSdkToolInputValidationError(error: unknown): error is SdkToolInputValidationError {
  if (!(error instanceof ModelBehaviorError)) return false;
  if (
    !Object.prototype.hasOwnProperty.call(error, 'originalError')
    || !Object.prototype.hasOwnProperty.call(error, 'toolInvocation')
  ) return false;
  const invocation = (error as SdkToolInputValidationError).toolInvocation;
  return Boolean(
    invocation
    && typeof invocation === 'object'
    && Object.prototype.hasOwnProperty.call(invocation, 'input'),
  );
}

/**
 * Actionable guidance for an input-validation failure on a tool surface. The
 * SDK default ("Invalid JSON input for tool") names nothing the model can
 * correct — observed live (proof workspace-build, 2026-07-27): three blind
 * space_save retries with large payloads, then a silently degraded static
 * deliverable. Name the violated paths and point at the schema so the next
 * retry is a corrected retry, not a guess. Lives beside the nominal detector so
 * every surface renders the same repair text.
 */
export function describeInvalidToolInput(
  error: unknown,
  toolName: string,
  /** How many violated paths to name (default 5). A packet-shaped tool whose
   * every required field can be absent at once passes its full field count so
   * one refusal names the whole repair instead of five fields per round. */
  options?: {
    maxIssues?: number;
    /** The trusted caller's current parser schema, never invocation values or
     * capability authority. Omitted keeps the existing discovery fallback. */
    inputSchema?: unknown;
    /** Budget for the complete guidance, after the caller's error prefix. */
    maxChars?: number;
  },
): string | null {
  if (!error || typeof error !== 'object') return null;
  if ((error as { name?: unknown }).name !== 'InvalidToolInputError') return null;
  const original = (error as { originalError?: unknown }).originalError;
  const rawIssues = original && typeof original === 'object'
    ? (original as { issues?: unknown }).issues
    : undefined;
  const maxIssues = Number.isSafeInteger(options?.maxIssues) && (options?.maxIssues ?? 0) > 0
    ? options!.maxIssues as number
    : 5;
  const issues = Array.isArray(rawIssues)
    ? (rawIssues as Array<{ path?: unknown; message?: unknown }>).slice(0, maxIssues).map((issue) => {
        const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${path}: ${String(issue.message ?? 'invalid')}`;
      })
    : [];
  const cause = issues.length > 0
    ? ` — ${issues.join('; ')}`
    : ' — the input was not parseable JSON (rebuild the arguments as ONE compact JSON object; escape embedded quotes/newlines once, not twice)';
  // A field that takes a JSON-encoded string and was sent the object itself
  // has one exact repair, built from what was sent. Named only, the model
  // re-sent it encoded twice (live 10-02, call_tool args_json: {} then "\"{}\"").
  const sent = (error as { toolInvocation?: { input?: unknown } }).toolInvocation?.input;
  const repairs = Array.isArray(rawIssues)
    ? (rawIssues as Array<{ path?: unknown; code?: unknown; expected?: unknown }>).slice(0, maxIssues).flatMap((issue) => {
        if (issue.code !== 'invalid_type' || issue.expected !== 'string' || !Array.isArray(issue.path) || issue.path.length === 0) return [];
        const value = invocationValueAt(sent, issue.path);
        if (!value || typeof value !== 'object') return [];
        const encoded = JSON.stringify(JSON.stringify(value));
        const path = issue.path.join('.');
        return [encoded.length <= 400
          ? `${path} takes the object as one JSON-encoded string, encoded once: send ${path} as ${encoded}`
          : `${path} takes the object as one JSON-encoded string, encoded once, not the object itself`];
      })
    : [];
  const diagnostic = `The arguments for ${toolName} did not match its schema${cause}. `
    + (repairs.length > 0 ? `${repairs.join('. ')}. ` : '');
  const budget = Math.min(INVALID_INPUT_SCHEMA_GUIDANCE_MAX_CHARS,
    Number.isSafeInteger(options?.maxChars) && (options?.maxChars ?? -1) >= 0
      ? options!.maxChars as number : DEFAULT_TOOL_RESULT_MAX_CHARS);
  try {
    if (options?.inputSchema && typeof options.inputSchema === 'object' && !Array.isArray(options.inputSchema)) {
      const schema = JSON.stringify(options.inputSchema);
      const complete = `${diagnostic}Use this current input schema and retry once with corrected arguments. No schema search is needed.\nInput schema (complete):\n${schema}`;
      // A cut JSON schema can invent an allowed field or hide a required one.
      // Include the entire schema or keep the familiar discovery fallback.
      if (complete.length <= budget) return complete;
    }
  } catch { /* Unserializable metadata keeps the ordinary discovery fallback. */ }
  return diagnostic
    + `Call tool_search with the exact query "${toolName}" to get the full input schema, then retry once with corrected arguments.`;
}

/** The value the model sent at one path, read from the invocation's own input. */
function invocationValueAt(input: unknown, path: readonly unknown[]): unknown {
  let value: unknown = input;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  for (const key of path) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[String(key)];
  }
  return value;
}

export function isInvalidArgumentsTextResult(
  value: unknown,
): value is InvalidArgumentsTextResult {
  return Boolean(value && typeof value === 'object' && INVALID_ARGUMENTS_TEXT_RESULTS.has(value));
}

/**
 * Did the HARNESS refuse this call, rather than the tool answering it?
 *
 * The four transport truths — succeeded, failed before dispatch, may have
 * executed, needs clarification — are all recorded correctly in the ledger and
 * then collapse to one at the MCP boundary, because a local tool result never
 * carries `isError`. The consumer already reads it
 * (`claude-agent-sdk.ts`: `ok: !result?.isError`); nothing has ever set it.
 *
 * Live 2026-08-09: a pre-dispatch schema refusal naming the exact missing field
 * arrived as an ordinary successful result, and the identical payload was sent
 * again. A refusal that reads as an answer cannot teach.
 *
 * Detection keys on the harness's OWN typed refusal markers — the prefixes it
 * writes when it declines — never on tool names, slugs, or providers. A tool
 * that genuinely returns the word "refused" in its data is unaffected, because
 * these markers are structural and always lead the result.
 */
export function isHarnessRefusalText(text: string): boolean {
  const head = text.slice(0, 240);
  return /^\s*(?:\{\s*")?(?:Tool call refused by harness|\[provider-dispatch:not-started:)/i.test(head)
    || /"error"\s*:\s*"(?:requires_readmission|arg_validation|not_allowed|unknown_tool)"/i.test(head);
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function safeTitle(title: string): string {
  return title.replace(/[<>:"/\\|?*]/g, '').trim();
}

export function noteFolderForType(noteType: 'person' | 'project' | 'topic' | 'task' | 'inbox'): string {
  switch (noteType) {
    case 'person':
      return PEOPLE_DIR;
    case 'project':
      return PROJECTS_DIR;
    case 'topic':
      return TOPICS_DIR;
    case 'task':
      return TASKS_DIR;
    case 'inbox':
      return INBOX_DIR;
  }
}

export function resolveMemoryTarget(target: string): string {
  const shortcuts: Record<string, string> = {
    soul: SOUL_FILE,
    memory: MEMORY_FILE,
    identity: IDENTITY_FILE,
    working_memory: WORKING_MEMORY_FILE,
    today: ensureTodayNote(),
  };

  if (shortcuts[target]) return shortcuts[target];

  // Recall results intentionally expose the durable source path so an agent can
  // load the evidence instead of trusting a snippet. Those paths are absolute,
  // while memory_read historically accepted only vault-relative targets and
  // silently prefixed an absolute path with VAULT_DIR. Accept absolute paths
  // only when they remain inside the vault; never turn memory_read into an
  // arbitrary filesystem reader.
  if (path.isAbsolute(target)) {
    const resolved = path.resolve(target);
    const vaultRoot = path.resolve(VAULT_DIR);
    if (resolved === vaultRoot || resolved.startsWith(`${vaultRoot}${path.sep}`)) return resolved;
  }

  return path.join(VAULT_DIR, target);
}

export function readText(filePath: string, fallback: string): string {
  if (!existsSync(filePath)) return fallback;
  try {
    // Return the complete source to textResult so it can retain the exact
    // output before producing a bounded, recallable model projection.
    return readFileSync(filePath, 'utf-8');
  } catch {
    return fallback;
  }
}

export function replaceFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
}

export function appendTodayNote(content: string): string {
  ensureVaultScaffold();
  const notePath = ensureTodayNote();
  const existing = readFileSync(notePath, 'utf-8');
  const timestamp = new Date().toISOString().slice(11, 16);
  const updated = `${existing.trimEnd()}\n- ${timestamp} ${content.trim()}\n`;
  writeFileSync(notePath, updated, 'utf-8');
  return path.basename(notePath);
}

export function ensureToolDirectories(): void {
  ensureVaultScaffold();
  ensureDir(path.join(BASE_DIR, 'tools'));
  ensureDir(path.join(BASE_DIR, 'plugins'));
  ensureDir(path.join(BASE_DIR, 'mcp'));
  ensureDir(GOALS_DIR);
  ensureDir(SYSTEM_DIR);
  ensureDir(AGENTS_DIR);
  ensureDir(DAILY_NOTES_DIR);
  ensureDir(INBOX_DIR);
  ensureDir(TASKS_DIR);
  ensureDir(path.dirname(TEAM_COMMS_LOG));
  ensureDir(TEAM_REQUESTS_DIR);
  ensureDir(DELEGATIONS_DIR);
  ensureDir(PENDING_ACTIONS_DIR);
  ensureDir(AGENT_STATE_DIR);
  ensureDir(AGENT_INBOX_DIR);
  ensureDir(path.join(BASE_DIR, 'state'));
  ensureDir(path.dirname(CRON_RUNS_DIR));
  ensureDir(CRON_RUNS_DIR);
  ensureDir(CRON_TRIGGERS_DIR);
  ensureDir(CRON_PROGRESS_DIR);
  ensureDir(WORKFLOW_RUNS_DIR);
  ensureDir(WORKFLOWS_DIR);
}

export interface ParsedTask {
  id: string;
  rawLine: string;
  status: 'pending' | 'completed';
  description: string;
  priority: 'high' | 'medium' | 'low';
  dueDate: string;
  project: string;
}

function normalizeTaskPriority(raw: string): 'high' | 'medium' | 'low' {
  if (raw === 'high' || raw === 'low') return raw;
  return 'medium';
}

export function ensureTasksFile(): void {
  ensureDir(TASKS_DIR);
  if (!existsSync(TASKS_FILE)) {
    writeFileSync(
      TASKS_FILE,
      [
        '---',
        'type: tasks',
        '---',
        '',
        '# Tasks',
        '',
        '## Pending',
        '',
        '## Completed',
        '',
      ].join('\n'),
      'utf-8',
    );
  }
}

export function parseTasks(body: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  let section: 'pending' | 'completed' = 'pending';

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '## Pending') {
      section = 'pending';
      continue;
    }
    if (trimmed === '## Completed') {
      section = 'completed';
      continue;
    }
    if (!trimmed.startsWith('- [')) continue;

    const idMatch = trimmed.match(/\{(T-\d+)\}/);
    const dueMatch = trimmed.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
    const projectMatch = trimmed.match(/#project:(\S+)/);
    const priorityMatch = trimmed.match(/!!(high|medium|low)/);
    const checked = /^\s*-\s+\[[xX]\]/.test(line);
    const cleanDescription = trimmed
      .replace(/^- \[[ xX]\]\s*/, '')
      .replace(/\{T-\d+\}\s*/, '')
      .replace(/\s*!!(high|medium|low)/g, '')
      .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/\s*#project:\S+/g, '')
      .trim();

    tasks.push({
      id: idMatch?.[1] ?? '',
      rawLine: line,
      status: checked || section === 'completed' ? 'completed' : 'pending',
      description: cleanDescription,
      priority: normalizeTaskPriority(priorityMatch?.[1] ?? 'medium'),
      dueDate: dueMatch?.[1] ?? '',
      project: projectMatch?.[1] ?? '',
    });
  }

  return tasks;
}

export function nextTaskId(body: string): string {
  const matches = [...body.matchAll(/\{T-(\d+)\}/g)];
  const maxId = matches.reduce((max, match) => Math.max(max, parseInt(match[1], 10)), 0);
  return `T-${String(maxId + 1).padStart(3, '0')}`;
}

/** What a project can DO when a guest agent harness runs inside it —
 *  slash commands and skills the user has built there, plus the wiring
 *  (MCP servers, AGENTS.md) each harness picks up from the directory. */
export interface WorkspaceProjectCapabilities {
  /** Slash-command names from .claude/commands (no leading slash;
   *  one nesting level maps to Claude Code's "dir:name" namespacing). */
  commands: string[];
  /** Skill directory names under .claude/skills. */
  skills: string[];
  /** .mcp.json present — the project brings its own MCP servers/creds. */
  hasMcp: boolean;
  /** AGENTS.md present — the Codex CLI reads it as project instructions. */
  hasAgentsMd: boolean;
}

export interface WorkspaceProject {
  name: string;
  path: string;
  type: string;
  description: string;
  hasClaude: boolean;
  capabilities: WorkspaceProjectCapabilities;
}

const DEFAULT_WORKSPACE_CANDIDATES = [
  'Desktop',
  'Documents',
  'Developer',
  'Projects',
  'projects',
  'repos',
  'Repos',
  'src',
  'code',
  'Code',
  'work',
  'Work',
  'dev',
  'Dev',
  'github',
  'GitHub',
  // GitHub Desktop's default clone folder (macOS and Windows) and Visual
  // Studio's default on Windows.
  path.join('Documents', 'GitHub'),
  path.join('source', 'repos'),
];

/** Windows moves Desktop and Documents into OneDrive when folder backup is
 *  on; the profile's own Desktop and Documents are then near-empty shells. */
function oneDriveRoots(): string[] {
  if (process.platform !== 'win32') return [];
  const roots = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']
    .map((key) => process.env[key]?.trim())
    .filter((value): value is string => Boolean(value && path.isAbsolute(value)));
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

/** The folders a home with no chosen workspace list works in by default. */
function defaultWorkspaceLocations(): string[] {
  const home = os.homedir();
  return [
    ...DEFAULT_WORKSPACE_CANDIDATES.map((candidate) => path.join(home, candidate)),
    ...oneDriveRoots().flatMap((root) => ['Desktop', 'Documents', path.join('Documents', 'GitHub')].map((candidate) => path.join(root, candidate))),
  ];
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// A folder someone works in with an agent says so in its instructions file
// even when it holds no code manifest (a proposal or research folder).
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', 'CMakeLists.txt', 'AGENTS.md', 'CLAUDE.md'];

export function readBaseEnv(): Record<string, string> {
  const envPath = path.join(BASE_DIR, '.env');
  if (!existsSync(envPath)) return {};

  const result: Record<string, string> = {};
  for (const rawLine of readFileSync(envPath, 'utf-8').split('\n')) {
    // Strip leading whitespace + trailing \r only — DO NOT strip
    // trailing whitespace on the value. Some folder names have
    // significant trailing spaces, and the workspace list breaks
    // if we collapse them silently.
    const line = rawLine.replace(/^\s+|\r+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1);
    result[key] = value;
  }
  return result;
}

export function updateEnvKey(key: string, value: string): void {
  const envPath = path.join(BASE_DIR, '.env');
  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf-8').split('\n') : [];
  let updated = false;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith(`${key}=`)) {
      lines[index] = `${key}=${value}`;
      updated = true;
      break;
    }
  }

  if (!updated) {
    lines.push(`${key}=${value}`);
  }

  writeFileSync(envPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf-8');

  // Mirror into the live process env. getRuntimeEnv() reads process.env BEFORE
  // the .env file (config.ts), so a file-only write is INVISIBLE this session
  // whenever the key was already present in process.env at boot — the next
  // getRuntimeEnv() keeps returning the stale value. That made settings writes
  // (e.g. the worker/judge role picker via CLEMMY_MODEL_ROLES) appear to "revert"
  // in the UI: the file got the new value but the running snapshot didn't. A
  // handful of call sites worked around this by manually setting process.env[key]
  // after the call; doing it here fixes the whole class once, for every caller.
  process.env[key] = value;
  invalidateRuntimeConfigSnapshot('environment');
  if (key === 'WORKSPACE_DIRS') clearWorkspaceProjectCache();
}

/**
 * Remove a key from the BASE_DIR/.env file AND the live process.env, so the
 * next getRuntimeEnv() falls back to the code default (or a lower-precedence
 * .env). The inverse of updateEnvKey — used by the developer flags panel to
 * "reset to default" without writing an explicit value (which would otherwise
 * pin the flag even after the code default changes).
 */
export function removeEnvKey(key: string): void {
  const envPath = path.join(BASE_DIR, '.env');
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    const kept = lines.filter((line) => !line.startsWith(`${key}=`));
    if (kept.length !== lines.length) {
      writeFileSync(envPath, `${kept.join('\n').replace(/\n+$/, '')}\n`, 'utf-8');
    }
  }
  delete process.env[key];
  invalidateRuntimeConfigSnapshot('environment');
}

export function getWorkspaceDirs(): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  const env = readBaseEnv();
  // Split but DON'T pre-trim — some folder names have significant
  // trailing whitespace (real project paths in the wild end with
  // a stray space). We can't tell from the CSV whether " /foo" is
  // "user added spaces around the comma" or "/foo has a leading
  // space in its real name", so the resolver below tries both
  // forms.
  const configuredEntries = (env.WORKSPACE_DIRS ?? '')
    .split(',')
    .filter((entry) => entry.length > 0);

  const add = (raw: string): void => {
    // Try as-written first (preserves trailing whitespace in folder
    // names), then fall back to trimmed (handles the common
    // ", "-separated CSV pattern). Stop at the first one that exists
    // on disk so we don't double-register the same folder.
    const candidates = raw !== raw.trim() ? [raw, raw.trim()] : [raw];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const expanded = candidate.startsWith('~')
        ? candidate.replace('~', os.homedir())
        : candidate;
      const resolved = path.resolve(expanded);
      if (seen.has(resolved)) return;
      try {
        if (!existsSync(resolved) || !statSync(resolved).isDirectory()) continue;
      } catch {
        continue;
      }
      seen.add(resolved);
      dirs.push(resolved);
      return;
    }
  };

  if (configuredEntries.length > 0) {
    for (const dir of configuredEntries) add(dir);
    return dirs;
  }

  for (const location of defaultWorkspaceLocations()) add(location);

  return dirs;
}

/**
 * Adds one folder to the folders Clementine may work in. With no list chosen
 * yet, the folders in use are the defaults: they are kept, never replaced by
 * the one folder added (adding a folder used to drop Desktop and Documents).
 */
export function addWorkspaceDir(dir: string): string[] {
  const absolute = path.resolve(dir);
  if (absolute.includes(',')) throw new Error('A folder whose path contains a comma cannot be added to the workspace list.');
  const configured = (readBaseEnv().WORKSPACE_DIRS ?? '').split(',').filter((entry) => entry.length > 0);
  const base = configured.length > 0 ? configured : getWorkspaceDirs();
  if (base.some((entry) => path.resolve(entry.trim() || entry) === absolute)) return base;
  const next = [...base, absolute];
  updateEnvKey('WORKSPACE_DIRS', next.join(','));
  return next;
}

function detectProjectType(entries: string[]): string {
  if (entries.includes('package.json')) return 'node';
  if (entries.includes('pyproject.toml')) return 'python';
  if (entries.includes('Cargo.toml')) return 'rust';
  if (entries.includes('go.mod')) return 'go';
  return 'unknown';
}

/**
 * macOS CloudStorage paths (OneDrive, Google Drive, iCloud File Provider, etc.)
 * back files with on-demand hydration — read() can block indefinitely while
 * the OS pulls the file down. There is no sync I/O timeout in Node, so the
 * only safe option is to skip these paths entirely for nice-to-have reads.
 *
 * `~/Desktop` is the most common offender: OneDrive Known Folder Move
 * symlinks `~/Desktop` to `~/Library/CloudStorage/OneDrive-*`. We canonicalize
 * via realpath so the check catches paths that *resolve* into CloudStorage,
 * not just literal CloudStorage paths.
 */
function isCloudStoragePath(dirPath: string): boolean {
  // Windows OneDrive files can be cloud-only placeholders: reading one
  // downloads it synchronously. Listing a folder does not.
  if (oneDriveRoots().some((root) => isWithin(dirPath, root))) return true;
  const literal = /\/Library\/CloudStorage\//.test(dirPath) || /\/Library\/Mobile Documents\//.test(dirPath);
  if (literal) return true;
  try {
    // realpath is a path-resolution syscall only — it does not pull file
    // contents, so it stays fast even on hydrated-on-demand backings.
    const resolved = realpathSync(dirPath);
    return /\/Library\/CloudStorage\//.test(resolved) || /\/Library\/Mobile Documents\//.test(resolved);
  } catch {
    return false;
  }
}

/** Bound per-list payloads: a runaway commands/skills dir must not bloat
 *  the cached project list the dashboard polls every 30s. */
const MAX_CAPABILITY_ENTRIES = 40;

function detectCapabilities(dirPath: string, entries: string[]): WorkspaceProjectCapabilities {
  const caps: WorkspaceProjectCapabilities = {
    commands: [],
    skills: [],
    hasMcp: entries.includes('.mcp.json'),
    hasAgentsMd: entries.includes('AGENTS.md'),
  };
  // readdir is metadata-only, but stay out of hydrate-on-demand cloud
  // mounts entirely — same policy as extractDescription above.
  if (!entries.includes('.claude') || isCloudStoragePath(dirPath)) return caps;

  try {
    const commandsDir = path.join(dirPath, '.claude', 'commands');
    const names: string[] = [];
    for (const entry of readdirSync(commandsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        names.push(entry.name.slice(0, -3));
      } else if (entry.isDirectory()) {
        try {
          for (const nested of readdirSync(path.join(commandsDir, entry.name))) {
            if (nested.endsWith('.md')) names.push(`${entry.name}:${nested.slice(0, -3)}`);
          }
        } catch {
          // Unreadable namespace dir — skip it.
        }
      }
    }
    caps.commands = names.sort().slice(0, MAX_CAPABILITY_ENTRIES);
  } catch {
    // No commands dir.
  }

  try {
    caps.skills = readdirSync(path.join(dirPath, '.claude', 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_CAPABILITY_ENTRIES);
  } catch {
    // No skills dir.
  }

  return caps;
}

function extractDescription(dirPath: string, entries: string[]): string {
  if (isCloudStoragePath(dirPath)) return '';

  if (entries.includes('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dirPath, 'package.json'), 'utf-8')) as { description?: string };
      if (pkg.description) return pkg.description;
    } catch {
      // Ignore malformed package.json
    }
  }

  for (const readmeName of ['README.md', 'readme.md', 'README']) {
    if (!entries.includes(readmeName)) continue;
    try {
      const lines = readFileSync(path.join(dirPath, readmeName), 'utf-8').split('\n');
      const line = lines.find((entry) => {
        const trimmed = entry.trim();
        return trimmed && !trimmed.startsWith('#');
      });
      if (line) return line.trim().slice(0, 200);
    } catch {
      // Ignore unreadable README.
    }
  }

  return '';
}

// listWorkspaceProjects walks every configured workspace dir + a fan
// of macOS standard locations, stat'ing each subdir against
// PROJECT_MARKERS. With Spotlight/iCloud-mirrored dirs this can take
// 30+ seconds — way too slow for the dashboard which calls it on
// every projects-panel open. Cache the unfiltered list and re-filter
// in-process. TTL is short so projects added during the session
// surface within a minute.
const PROJECT_LIST_CACHE_TTL_MS = 60_000;
let projectListCache: { at: number; projects: WorkspaceProject[] } | null = null;

let discoverableCache: { at: number; projects: WorkspaceProject[] } | null = null;

export function clearWorkspaceProjectCache(): void {
  projectListCache = null;
  discoverableCache = null;
}

/** The project a folder is, when it carries a project marker; null otherwise. */
function projectAt(candidate: string): WorkspaceProject | null {
  try {
    if (!statSync(candidate).isDirectory()) return null;
    const subEntries = readdirSync(candidate);
    if (!PROJECT_MARKERS.some((marker) => subEntries.includes(marker))) return null;
    return {
      name: path.basename(candidate),
      path: path.resolve(candidate),
      type: detectProjectType(subEntries),
      description: extractDescription(candidate, subEntries),
      hasClaude: existsSync(path.join(candidate, '.claude', 'CLAUDE.md')),
      capabilities: detectCapabilities(candidate, subEntries),
    };
  } catch {
    return null;
  }
}

export function listWorkspaceProjects(filter?: string): WorkspaceProject[] {
  if (projectListCache && Date.now() - projectListCache.at < PROJECT_LIST_CACHE_TTL_MS) {
    const filtered = filter
      ? projectListCache.projects.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
      : projectListCache.projects;
    return filtered;
  }
  const projects: WorkspaceProject[] = [];
  const seen = new Set<string>();

  for (const workspaceDir of getWorkspaceDirs()) {
    let entries: string[] = [];
    try {
      entries = readdirSync(workspaceDir);
    } catch {
      continue;
    }

    const candidates = [workspaceDir, ...entries.map((entry) => path.join(workspaceDir, entry))];
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) continue;
      const project = projectAt(candidate);
      if (!project) continue;
      seen.add(resolved);
      projects.push(project);
    }
  }

  const sorted = projects.sort((left, right) => left.name.localeCompare(right.name));
  projectListCache = { at: Date.now(), projects: sorted };
  if (filter) {
    return sorted.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));
  }
  return sorted;
}

/** Force the projects cache to refresh on next call. */
export function invalidateWorkspaceProjectsCache(): void {
  projectListCache = null;
  discoverableCache = null;
}

// Folders in a home that never hold a project someone keeps there: system,
// media and per-app folders (Windows profile junctions included).
const NOT_PROJECT_HOME_FOLDERS = new Set([
  'appdata', 'application data', 'applications', 'library', 'pictures', 'music', 'movies', 'videos', 'public',
  'saved games', 'searches', 'links', 'contacts', 'favorites', '3d objects', 'cookies', 'local settings',
  'my documents', 'nethood', 'printhood', 'recent', 'sendto', 'start menu', 'templates', 'node_modules',
]);
const MOST_DISCOVERY_ENTRIES = 500;
const MOST_DISCOVERED_PROJECTS = 100;

/**
 * Project folders kept where people usually keep them (directly in the home
 * folder, and in the usual places like Documents\GitHub, source\repos and
 * OneDrive) that are NOT yet among the folders Clementine may work in. They
 * are offered for linking; linking one adds that one folder. One level deep,
 * marker-checked, cloud-only files never read, cached like the roster.
 */
export function listDiscoverableProjects(): WorkspaceProject[] {
  if (discoverableCache && Date.now() - discoverableCache.at < PROJECT_LIST_CACHE_TTL_MS) return discoverableCache.projects;
  const granted = getWorkspaceDirs();
  const containers = [os.homedir(), ...defaultWorkspaceLocations()];
  const projects: WorkspaceProject[] = [];
  const seen = new Set<string>();
  for (const container of containers) {
    let entries: string[];
    try { entries = readdirSync(container); } catch { continue; }
    for (const entry of entries.slice(0, MOST_DISCOVERY_ENTRIES)) {
      if (projects.length >= MOST_DISCOVERED_PROJECTS) break;
      if (entry.startsWith('.') || entry.startsWith('$') || NOT_PROJECT_HOME_FOLDERS.has(entry.toLowerCase())
        || /^onedrive\b/i.test(entry) || entry.includes(',')) continue;
      const candidate = path.resolve(container, entry);
      if (seen.has(candidate) || granted.some((dir) => isWithin(candidate, dir))) continue;
      seen.add(candidate);
      const project = projectAt(candidate);
      if (project) projects.push(project);
    }
  }
  const sorted = projects.sort((left, right) => left.name.localeCompare(right.name));
  discoverableCache = { at: Date.now(), projects: sorted };
  return sorted;
}

export interface TeamAgentRecord {
  slug: string;
  name: string;
  description: string;
  role?: string;
  channelName?: string;
  canMessage: string[];
  allowedTools: string[];
  model?: string;
  project?: string;
  tier?: number;
  autonomyEnabled?: boolean;
  proactive?: boolean;
  cadenceMinutes?: number;
  wakeTriggers?: string[];
  /** Skills this agent reaches for first; bound into a turn by agent-record.ts. */
  skills?: string[];
  /** Workflows this agent reaches for first; bound into a turn by agent-record.ts. */
  workflows?: string[];
  /** Tool families a turn inside this agent is narrowed to. Empty = the turn's usual surface. */
  tools?: string[];
  /** Space or project whose memory this agent works within. */
  memoryScope?: string;
  /** Where the record came from: chat, console, phone, plugin. */
  createdFrom?: string;
  createdAt?: string;
  updatedAt?: string;
  personality: string;
}

export function slugifyAgentName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function agentFilePath(slug: string): string {
  return path.join(AGENTS_DIR, slug, 'agent.md');
}

export function loadTeamAgents(): TeamAgentRecord[] {
  if (!existsSync(AGENTS_DIR)) return [];

  const agents: TeamAgentRecord[] = [];
  for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const slug = entry.name;
    const filePath = agentFilePath(slug);
    if (!existsSync(filePath)) continue;

    try {
      const parsed = matter(readFileSync(filePath, 'utf-8'));
      const data = parsed.data as Record<string, unknown>;
      agents.push({
        slug,
        name: typeof data.name === 'string' ? data.name : slug,
        description: typeof data.description === 'string' ? data.description : '',
        role: typeof data.role === 'string' ? data.role : undefined,
        channelName: typeof data.channelName === 'string' ? data.channelName : undefined,
        canMessage: Array.isArray(data.canMessage) ? data.canMessage.map(String).filter(Boolean) : [],
        allowedTools: Array.isArray(data.allowedTools) ? data.allowedTools.map(String).filter(Boolean) : [],
        model: typeof data.model === 'string' ? data.model : undefined,
        project: typeof data.project === 'string' ? data.project : undefined,
        tier: typeof data.tier === 'number' ? data.tier : undefined,
        // A record that says nothing about waking gets no cadence. Fields the
        // file leaves unsaid stay unsaid; the runtime that reads them decides.
        autonomyEnabled: typeof data.autonomyEnabled === 'boolean' ? data.autonomyEnabled : undefined,
        proactive: typeof data.proactive === 'boolean' ? data.proactive : false,
        cadenceMinutes: typeof data.cadenceMinutes === 'number' ? data.cadenceMinutes : undefined,
        wakeTriggers: Array.isArray(data.wakeTriggers) ? data.wakeTriggers.map(String).filter(Boolean) : undefined,
        skills: Array.isArray(data.skills) ? data.skills.map(String).filter(Boolean) : [],
        workflows: Array.isArray(data.workflows) ? data.workflows.map(String).filter(Boolean) : [],
        tools: Array.isArray(data.tools) ? data.tools.map(String).filter(Boolean) : [],
        memoryScope: typeof data.memoryScope === 'string' ? data.memoryScope : undefined,
        createdFrom: typeof data.createdFrom === 'string' ? data.createdFrom : undefined,
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
        personality: parsed.content.trim(),
      });
    } catch {
      continue;
    }
  }

  return agents.sort((left, right) => left.slug.localeCompare(right.slug));
}

export function writeTeamAgent(agent: TeamAgentRecord): void {
  const filePath = agentFilePath(agent.slug);
  ensureDir(path.dirname(filePath));

  const frontmatter: Record<string, unknown> = {
    name: agent.name,
    description: agent.description,
  };
  if (agent.role) frontmatter.role = agent.role;
  if (agent.channelName) frontmatter.channelName = agent.channelName;
  if (agent.canMessage.length > 0) frontmatter.canMessage = agent.canMessage;
  if (agent.allowedTools.length > 0) frontmatter.allowedTools = agent.allowedTools;
  if (agent.model) frontmatter.model = agent.model;
  if (agent.project) frontmatter.project = agent.project;
  if (agent.tier !== undefined) frontmatter.tier = agent.tier;
  if (agent.autonomyEnabled !== undefined) frontmatter.autonomyEnabled = agent.autonomyEnabled;
  if (agent.proactive !== undefined) frontmatter.proactive = agent.proactive;
  if (agent.cadenceMinutes !== undefined) frontmatter.cadenceMinutes = agent.cadenceMinutes;
  if (agent.wakeTriggers && agent.wakeTriggers.length > 0) frontmatter.wakeTriggers = agent.wakeTriggers;
  if (agent.skills && agent.skills.length > 0) frontmatter.skills = agent.skills;
  if (agent.workflows && agent.workflows.length > 0) frontmatter.workflows = agent.workflows;
  if (agent.tools && agent.tools.length > 0) frontmatter.tools = agent.tools;
  if (agent.memoryScope) frontmatter.memoryScope = agent.memoryScope;
  if (agent.createdFrom) frontmatter.createdFrom = agent.createdFrom;
  if (agent.createdAt) frontmatter.createdAt = agent.createdAt;
  if (agent.updatedAt) frontmatter.updatedAt = agent.updatedAt;

  // Write-then-rename: a torn agent.md would make the agent vanish from the
  // list, and these are the user's own definitions.
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, matter.stringify(agent.personality || `You are ${agent.name}.`, frontmatter), 'utf-8');
  renameSync(temp, filePath);
}
