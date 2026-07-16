/**
 * Evolving procedural memory — auto-remember-on-success (native MCP).
 *
 * The Composio half ("a working slug memorizes itself") shipped in v0.5.52,
 * keyed on the search query. Native MCP tools have NO search step, so their
 * successes were NEVER recorded — meaning recall could never compound for the
 * dominant tool family (Airtable/Slack/Notion/Gmail/…). This is the missing
 * commit half: on a CLEAN native-MCP success during a known objective, record
 * one canonical MCP operation plus the objective as a contextual alias, so the
 * recall-aware scoper can re-surface that server without turning project prose
 * into the physical procedure key.
 *
 * Pairs with the recall-aware scope behind ONE flag (CLEMMY_SCOPE_FROM_RECALL):
 * remember and recall ship together or neither compounds.
 *
 * Deliberately conservative (a poisoned memo surfaces via context injection, so
 * a wrong write is costly):
 *   - NATIVE MCP ONLY. CLI auto-remember is intentionally skipped — shell
 *     builtins (ls/cat/git) would poison the store, and the user's CLIs are
 *     already $PATH-discoverable. (MCP is the family the scoper actually gated.)
 *   - Needs an ACTIVE OBJECTIVE (focus) as retrieval context. No focus → skip.
 *   - NEVER clobbers an active memo (peek-dedup), mirroring the Composio half.
 *   - Skips error/approval/unavailable results.
 * Best-effort + silent: learning is additive and must never break a tool call.
 */
import { getActiveObjective } from '../../memory/focus.js';
import { peekToolChoice, rememberToolChoice } from '../../memory/tool-choice-store.js';

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
  if (/^\s*(⚠️|error:)/i.test(text)) return null;
  const head = firstLine(text);
  if (/server_unavailable|approval_blocked|not[\s_]?found|\bfailed\b/i.test(head)) return null;
  return { identifier: name };
}

/**
 * Best-effort: on a clean native-MCP success during an active objective, record
 * one canonical MCP procedure (once), with the objective retained as context.
 */
export function autoRememberOnSuccess(input: {
  toolName?: string | null;
  resultStr?: string | null;
}): void {
  try {
    if (!recallFromSuccessEnabled()) return;
    const success = detectNativeMcpSuccess(input.toolName, input.resultStr);
    if (!success) return;
    const objective = getActiveObjective();
    if (!objective || !objective.trim()) return; // need a stable key
    // The operation is the stable key. Objective prose is a contextual alias:
    // useful for semantic recall, but never allowed to define/bloat procedure
    // identity or auto-bind a workflow by itself.
    const [server = 'mcp', operation = 'tool'] = success.identifier.split('__', 2);
    const intent = `${server}.${operation}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '.');
    const existing = peekToolChoice(intent);
    if (existing?.choice) return; // never clobber an active memo
    rememberToolChoice({
      intent,
      description: 'Auto-remembered: this native MCP tool satisfied the active objective.',
      aliasSource: 'synthetic',
      aliases: [{ intent: objective.trim(), source: 'native_mcp' }],
      choice: {
        kind: 'mcp',
        identifier: success.identifier,
        testEvidence: `auto-remembered after a successful ${success.identifier} call`,
      },
    });
  } catch {
    // Additive — a memory-write failure must never break the (already-succeeded) call.
  }
}
