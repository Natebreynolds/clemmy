/**
 * Evolving procedural memory — auto-remember-on-success.
 *
 * Native MCP tools have no search step, so a clean success used to teach
 * nothing. Composio used to remember only when the model first searched.
 * This is the write path that lets the model stop calling
 * `tool_choice_remember`: on a CLEAN native-MCP or Composio execute success
 * during a known objective, record one canonical operation plus the
 * objective as a contextual alias.
 *
 * Pairs with the recall-aware scope behind ONE flag (CLEMMY_SCOPE_FROM_RECALL):
 * remember and recall ship together or neither compounds.
 *
 * Deliberately conservative (a poisoned memo surfaces via context injection, so
 * a wrong write is costly):
 *   - MCP + Composio execute, plus a generic host-CLI read (program +
 *     subcommand, non-mutating, actually successful). Shell builtins stay out.
 *   - Needs an ACTIVE OBJECTIVE (focus) as retrieval context. No focus → skip.
 *   - NEVER clobbers an active memo (peek-dedup).
 *   - Skips error/approval/unavailable results.
 * Best-effort + silent: learning is additive and must never break a tool call.
 */
import { getActiveObjective, getActiveObjectiveForSession } from '../../memory/focus.js';
import { peekToolChoice, rememberToolChoice } from '../../memory/tool-choice-store.js';
import { classifyToolError, detectStructuredToolFailure } from './tool-error-corrective.js';
import { listEvents } from './eventlog.js';
import { getToolOutputContext } from './tool-output-context.js';
import { harnessRunContextStorage } from './brackets.js';
import { classifyRuntimeToolEffect } from './tool-effect.js';

function recallFromSuccessEnabled(): boolean {
  return (process.env.CLEMMY_SCOPE_FROM_RECALL ?? 'on').toLowerCase() !== 'off';
}

function firstLine(text: string): string {
  return text.trimStart().split('\n', 1)[0] ?? '';
}

/** A clean native-MCP success worth remembering, or null. Native MCP tools are
 *  namespaced `<server>__<tool>` (and never the composio `cx_` dynamic tools). */
export function detectNativeMcpSuccess(
  toolName: string | null | undefined,
  resultStr: string | null | undefined,
): { identifier: string } | null {
  const name = toolName ?? '';
  const text = (resultStr ?? '').trim();
  if (!name || !text) return null;
  if (!name.includes('__') || name.startsWith('cx_')) return null;
  if (detectStructuredToolFailure(text).failed) return null;
  if (/^\s*(⚠️|error:)/i.test(text)) return null;
  const head = firstLine(text);
  if (classifyToolError(head) === 'permission_denied') return null;
  if (/\b(?:not\s+authenticated|authentication\s+(?:required|failed)|authorization\s+(?:required|failed)|(?:request|tool\s+call|operation)\s+refused)\b/i.test(head)) return null;
  if (/server_unavailable|approval_blocked|not[\s_]?found|\bfailed\b/i.test(head)) return null;
  return { identifier: name };
}

const COMPOSIO_SLUG_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

function objectArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function looksLikeCleanSuccess(resultStr: string | null | undefined): boolean {
  const text = (resultStr ?? '').trim();
  if (!text) return false;
  if (detectStructuredToolFailure(text).failed) return false;
  if (/^\s*(⚠️|error:)/i.test(text)) return false;
  const head = firstLine(text);
  if (classifyToolError(head) === 'permission_denied') return false;
  if (/\b(?:not\s+authenticated|authentication\s+(?:required|failed)|authorization\s+(?:required|failed)|(?:request|tool\s+call|operation)\s+refused)\b/i.test(head)) return false;
  if (/server_unavailable|approval_blocked|not[\s_]?found|\bfailed\b/i.test(head)) return false;
  return true;
}

export type RememberableSuccess = {
  identifier: string;
  kind: 'mcp' | 'composio' | 'cli';
  invocationTemplate?: string;
};

function cliCommandHead(command: string): string {
  const keep: string[] = [];
  for (const raw of command.trim().split(/\s+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (/^(?:&&|\|\||\||;)$/.test(token)) break;
    if (/^-/.test(token)) break;
    if (/^["'`]/.test(token) || token.includes('=') || token.includes('{{')) break;
    keep.push(token);
  }
  return keep.join(' ');
}

/** Shell builtins and interpreters that would poison procedural memory. */
const CLI_MEMORY_SKIP_PROGRAMS = new Set([
  'ls', 'cat', 'pwd', 'echo', 'date', 'which', 'whoami', 'env', 'printenv',
  'head', 'tail', 'wc', 'file', 'stat', 'type', 'true', 'false', 'sleep', 'cd',
  'git', 'rm', 'mv', 'cp', 'chmod', 'chown', 'mkdir', 'touch', 'ln', 'kill',
  'bash', 'sh', 'zsh', 'python', 'python3', 'node', 'perl', 'ruby',
]);
const CLI_MEMORY_MUTATION_TOKENS = new Set([
  'create', 'update', 'delete', 'upsert', 'insert', 'import', 'deploy', 'login',
  'auth', 'push', 'apply', 'set', 'put', 'post', 'patch', 'remove', 'destroy',
  'write', 'send', 'publish', 'merge', 'replace', 'rename', 'install', 'uninstall',
]);

function extractEmbeddedJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const slice = text.slice(start);
  try {
    const parsed = JSON.parse(slice) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    const end = slice.lastIndexOf('}');
    if (end <= 0) return null;
    try {
      const parsed = JSON.parse(slice.slice(0, end + 1)) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
}

/** Host CLI wrappers often print `exit_code: N` then JSON with numeric status. */
export function cliHostOutputLooksSuccessful(resultStr: string | null | undefined): boolean {
  if (!looksLikeCleanSuccess(resultStr)) return false;
  const text = (resultStr ?? '').trim();
  const exit = text.match(/(?:^|\n)\s*exit_code:\s*(-?\d+)\b/i);
  if (exit && Number(exit[1]) !== 0) return false;
  const json = extractEmbeddedJson(text);
  if (!json) return true;
  if (typeof json.status === 'number' && json.status !== 0) return false;
  if (json.ok === false || json.success === false || json.successful === false) return false;
  if (typeof json.name === 'string' && /error|exception|failure/i.test(json.name)) return false;
  return true;
}

function invocationTemplateFor(command: string, head: string): string {
  const withPlaceholders = command.replace(
    /(\s--[a-z][\w-]*)\s+(["'])(?:(?!\2)[\s\S]){12,}\2/gi,
    '$1 "{{arg}}"',
  );
  const beforePipe = withPlaceholders.split(/\s+(?:&&|\|\||\||;)\s+/)[0] ?? withPlaceholders;
  const trimmed = beforePipe.replace(/\s{2,}/g, ' ').trim();
  if (trimmed && trimmed !== command.trim()) return trimmed;
  const json = /\s--json\b/i.test(command) ? ' --json' : '';
  return `${head}${json}`;
}

function detectCliReadSuccess(
  toolName: string,
  args: Record<string, unknown>,
  resultStr: string | null | undefined,
): RememberableSuccess | null {
  const name = toolName.trim();
  let command = '';
  if (name === 'run_shell_command') {
    command = firstString(args, ['command']);
  } else if (name === 'work_call' || name === 'call_tool') {
    const inner = firstString(args, ['name', 'tool', 'tool_name']);
    if (inner !== 'run_shell_command') return null;
    const innerArgs = objectArgs(args.args ?? args.arguments ?? args.args_json);
    command = firstString(innerArgs, ['command']) || firstString(args, ['command']);
  }
  if (!command) return null;
  if (!cliHostOutputLooksSuccessful(resultStr)) return null;
  const effect = classifyRuntimeToolEffect('run_shell_command', { command }).effect;
  if (effect !== 'read' && effect !== 'compute') return null;
  const head = cliCommandHead(command);
  const tokens = head.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const program = tokens[0]!.toLowerCase();
  if (CLI_MEMORY_SKIP_PROGRAMS.has(program)) return null;
  if (tokens.slice(1).some((token) => CLI_MEMORY_MUTATION_TOKENS.has(token.toLowerCase()))) {
    return null;
  }
  return {
    identifier: program,
    kind: 'cli',
    invocationTemplate: invocationTemplateFor(command, head),
  };
}

export function detectRememberableSuccess(
  toolName: string | null | undefined,
  resultStr: string | null | undefined,
  args?: unknown,
): RememberableSuccess | null {
  const native = detectNativeMcpSuccess(toolName, resultStr);
  if (native) return { identifier: native.identifier, kind: 'mcp' };
  if (!looksLikeCleanSuccess(resultStr)) return null;

  const name = (toolName ?? '').trim();
  const record = objectArgs(args);
  const slugFrom = (source: Record<string, unknown>): string =>
    firstString(source, ['tool_slug', 'slug', 'toolSlug', 'composioSlug']);

  const cli = detectCliReadSuccess(name, record, resultStr);
  if (cli) return cli;

  if (name === 'composio_execute_tool') {
    const slug = slugFrom(record);
    return COMPOSIO_SLUG_RE.test(slug) ? { identifier: slug, kind: 'composio' } : null;
  }

  if (name === 'work_call' || name === 'call_tool') {
    const inner = firstString(record, ['name', 'tool', 'tool_name']);
    if (inner.includes('__') && !inner.startsWith('cx_')) {
      const nested = detectNativeMcpSuccess(inner, resultStr);
      return nested ? { identifier: nested.identifier, kind: 'mcp' } : null;
    }
    if (inner === 'composio_execute_tool') {
      const innerArgs = objectArgs(record.args ?? record.arguments ?? record.args_json);
      const slug = slugFrom(innerArgs) || slugFrom(record);
      return COMPOSIO_SLUG_RE.test(slug) ? { identifier: slug, kind: 'composio' } : null;
    }
    const slug = slugFrom(record);
    return COMPOSIO_SLUG_RE.test(slug) ? { identifier: slug, kind: 'composio' } : null;
  }

  return null;
}

/**
 * Best-effort: on a clean native-MCP or Composio success during an active
 * objective, record one canonical procedure (once), with the objective
 * retained as context.
 */
function recallContextPhrase(opts?: { sessionId?: string; sourceUserSeq?: number }): string {
  let sessionId = opts?.sessionId;
  try {
    const ambient = getToolOutputContext();
    const run = harnessRunContextStorage.getStore();
    sessionId = sessionId || ambient?.sessionId || run?.sessionId;
    const sourceUserSeq = opts?.sourceUserSeq
      || ambient?.sourceUserSeq
      || run?.sourceUserSeq;
    if (sessionId && Number.isSafeInteger(sourceUserSeq) && Number(sourceUserSeq) > 0) {
      const seq = Number(sourceUserSeq);
      const event = listEvents(sessionId, {
        sinceSeq: seq - 1,
        types: ['user_input_received'],
        limit: 1,
      }).find((row) => row.seq === seq);
      const display = typeof event?.data?.displayText === 'string' ? event.data.displayText : '';
      const text = typeof event?.data?.text === 'string' ? event.data.text : '';
      const phrase = (display || text).replace(/\s+/g, ' ').trim();
      if (phrase) return phrase.slice(0, 240);
    }
  } catch { /* session recall is additive */ }
  return (
    sessionId
      ? getActiveObjectiveForSession(sessionId)
      : getActiveObjective()
  )?.trim() ?? '';
}

function rememberableIntent(success: RememberableSuccess): string {
  if (success.kind === 'mcp') {
    return success.identifier.split('__', 2).join('.').toLowerCase().replace(/[^a-z0-9._-]+/g, '.');
  }
  if (success.kind === 'cli') {
    const head = (success.invocationTemplate ?? success.identifier)
      .split(/\s+--/)[0]
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '.')
      .replace(/^\.+|\.+$/g, '');
    return (head || success.identifier || 'cli.read').slice(0, 80);
  }
  return success.identifier.toLowerCase().replace(/[^a-z0-9._-]+/g, '.');
}

export function autoRememberOnSuccess(input: {
  toolName?: string | null;
  resultStr?: string | null;
  args?: unknown;
  sessionId?: string;
  sourceUserSeq?: number;
}): void {
  try {
    if (!recallFromSuccessEnabled()) return;
    const success = detectRememberableSuccess(input.toolName, input.resultStr, input.args);
    if (!success) return;
    const phrase = recallContextPhrase({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
    });
    if (!phrase) return;
    // The operation is the stable key. The accepted ask is a contextual alias
    // so the next paraphrase can retrieve this path without naming the tool.
    const intent = rememberableIntent(success);
    const existing = peekToolChoice(intent);
    // CLI aliases must still attach when the physical path is already known —
    // otherwise "net MRR we sold" never becomes retrievable after the first
    // successful sf query. Other kinds keep the no-clobber rule.
    if (existing?.choice && success.kind !== 'cli') return;
    rememberToolChoice({
      intent,
      description: success.kind === 'cli'
        ? `Auto-remembered: this local CLI read satisfied "${phrase.slice(0, 120)}".`
        : success.kind === 'mcp'
          ? 'Auto-remembered: this native MCP tool satisfied the active objective.'
        : 'Auto-remembered: this Composio action satisfied the active objective.',
      aliasSource: 'synthetic',
      aliases: [{
        intent: phrase,
        source: success.kind === 'mcp' ? 'native_mcp' : success.kind === 'cli' ? 'synthetic' : 'composio_search',
      }],
      choice: {
        kind: success.kind,
        identifier: success.identifier,
        ...(success.invocationTemplate ? { invocationTemplate: success.invocationTemplate } : {}),
        testEvidence: `auto-remembered after a successful ${success.identifier} call`,
      },
    });
  } catch {
    // Additive — a memory-write failure must never break the (already-succeeded) call.
  }
}
