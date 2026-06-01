/**
 * Evolving procedural memory — auto-invalidate-on-failure.
 *
 * The commit half ("a working tool memorizes itself") shipped for Composio in
 * v0.5.52. This is the inverse, the EVOLVE half the owner asked for: a
 * remembered tool choice that FAILS at execution must self-correct, not keep
 * being recalled and re-failed. Without this, a stale memo (a revoked
 * connection, an uninstalled CLI, an offline MCP server) is a permanent
 * trap — exactly the "memory is a bunch of stale old context" failure mode.
 *
 * Mechanism (single hook in hooks.onToolEnd, all three tool families):
 *   detect a HARD failure → map the failing tool to its stored identifier →
 *   if EXACTLY ONE active memo points at it, invalidate that memo (move the
 *   choice to fallbacks, clear active). The next run sees a null choice and
 *   rediscovers. Silent + best-effort: self-correction must never break a run.
 *
 * Why identifier-match against the active store (not "the choice recalled this
 * turn"): the dominant recall path is CONTEXT INJECTION — the agent reads the
 * proven tool from the persistent block and calls it WITHOUT ever calling
 * tool_choice_recall — so there is no per-turn "recalled" signal to key on.
 * Identifier-match covers both paths with no new plumbing.
 *
 * Conservative by design — we only invalidate on signals that mean the tool
 * itself is broken/gone, never on a transient or argument-level error:
 *   - Composio: a `⚠️ … FAILED` corrective — NOT `NOT FOUND` (wrong arg/id, the
 *     tool is fine; handled by the v0.5.48 nudge + v0.5.49 id-index).
 *   - CLI: `command not found` / `: not found` / `EPERM … uv_cwd` (binary gone /
 *     TCC-clamped) — NOT a plain non-zero exit (a bad flag is user error).
 *   - MCP: `server_unavailable` — NOT `approval_blocked` (a gate, not a break).
 * Ambiguity (two intents → the same identifier) → skip; a wrong auto-forget is
 * worse than a missed one.
 */
import {
  listToolChoices,
  invalidateToolChoice,
  type ToolChoiceKind,
} from '../../memory/tool-choice-store.js';

interface FailedToolCall {
  kind: ToolChoiceKind;
  identifier: string;
  reason: string;
}

function firstLine(text: string): string {
  return text.trimStart().split('\n', 1)[0] ?? '';
}

function parseArgsObject(args: unknown): Record<string, unknown> | undefined {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === 'string' && args.trim()) {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* not JSON — no usable args */
    }
  }
  return undefined;
}

const COMPOSIO_HEADER_SLUG_RE = /slug=([A-Za-z0-9_]+)/;

function detectComposioFailure(
  toolName: string,
  args: Record<string, unknown> | undefined,
  resultStr: string,
): FailedToolCall | null {
  const isComposio = toolName === 'composio_execute_tool' || toolName.startsWith('cx_');
  if (!isComposio) return null;
  const head = firstLine(resultStr);
  if (!head.startsWith('⚠️')) return null; // success path returns the body unchanged
  if (/NOT[\s_]?FOUND/i.test(head)) return null; // arg/discovery problem, tool is fine
  if (!/FAILED/i.test(head)) return null; // only hard failures
  // Slug: prefer the explicit arg (composio_execute_tool), else the corrective
  // header (`slug=…`, which cx_<slug> and the gateway both print).
  let slug: string | undefined;
  const argSlug = args?.tool_slug;
  if (typeof argSlug === 'string' && argSlug.length > 0) slug = argSlug;
  if (!slug) slug = COMPOSIO_HEADER_SLUG_RE.exec(head)?.[1];
  if (!slug) return null;
  return { kind: 'composio', identifier: slug, reason: head.slice(0, 200) };
}

const CLI_BINARY_GONE_RE = /(command not found|: not found|EPERM:\s*operation not permitted,?\s*uv_cwd)/i;

function detectCliFailure(
  toolName: string,
  args: Record<string, unknown> | undefined,
  resultStr: string,
): FailedToolCall | null {
  if (toolName !== 'run_shell_command') return null;
  if (!CLI_BINARY_GONE_RE.test(resultStr)) return null; // conservative: binary-gone only
  const command = args?.command;
  if (typeof command !== 'string') return null;
  const bin = command.trim().split(/\s+/)[0];
  if (!bin) return null;
  return { kind: 'cli', identifier: bin, reason: `CLI "${bin}" unavailable on this machine` };
}

function detectMcpFailure(toolName: string, resultStr: string): FailedToolCall | null {
  // Native MCP tools are namespaced `<server>__<tool>`.
  if (!/__/.test(toolName)) return null;
  if (/approval_blocked/i.test(resultStr)) return null; // an approval gate is not a broken server
  if (!/server_unavailable/i.test(resultStr)) return null;
  return { kind: 'mcp', identifier: toolName, reason: 'MCP server unavailable' };
}

/**
 * Best-effort: on a detected HARD tool failure, invalidate the single matching
 * active tool-choice memo so the next run rediscovers. Never throws.
 */
export function autoInvalidateOnFailure(input: {
  toolName?: string | null;
  args?: unknown;
  resultStr?: string | null;
}): void {
  try {
    const toolName = input.toolName;
    const resultStr = input.resultStr;
    if (!toolName || !resultStr) return;
    const args = parseArgsObject(input.args);
    const failed =
      detectComposioFailure(toolName, args, resultStr) ||
      detectCliFailure(toolName, args, resultStr) ||
      detectMcpFailure(toolName, resultStr);
    if (!failed) return;
    // Single-active-match only — ambiguity is left to the agent.
    const matches = listToolChoices().filter(
      (r) => r.choice && r.choice.kind === failed.kind && r.choice.identifier === failed.identifier,
    );
    if (matches.length !== 1) return;
    invalidateToolChoice(matches[0].intent, failed.reason, { automatic: true });
  } catch {
    // Self-correction is additive — its failure must never break the tool call.
  }
}
