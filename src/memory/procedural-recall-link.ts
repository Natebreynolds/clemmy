/**
 * Per-recalled-intent outcome correlation — the keystone the 2026-06-21
 * measurement justified.
 *
 * MEASURED gap: the procedural-memory outcome loop is composio-ONLY (credits by
 * slug, composio-tools.ts). 0% of CLI memos and 0% of MCP memos have EVER been
 * outcome-scored — all 63 sit permanently at the neutral 0.5 prior, so they can
 * never be verified, ranked by proven success, or auto-invalidated. Crediting
 * them by their bare binary identifier (`netlify`) is unsafe — a `netlify status`
 * blip would penalize a good DEPLOY memo.
 *
 * The safe fill: correlate the SPECIFIC intent the agent RECALLED with the tool
 * call it then runs. The agent's flow is recall(intent) → immediately use the
 * returned invocation, so the first matching tool result after a recall is that
 * recall's outcome. We note each CLI/MCP recall in a small session-scoped buffer
 * and, on the next matching tool result, credit THAT intent and consume the
 * entry (one recall → at most one credit). Bounded + TTL'd so a stale recall can
 * never mis-credit a much-later call. Composio recalls are NOT correlated here
 * (their slug path already credits them — avoids double-counting).
 *
 * Best-effort: every function swallows errors; a correlation failure never
 * perturbs a tool call. Gated transitively by CLEMMY_PROCEDURAL_OUTCOMES (the
 * updateToolChoiceOutcome it calls is a no-op when that's off).
 */
import { updateToolChoiceOutcome } from './tool-choice-store.js';

interface PendingRecall {
  intent: string;
  identifier: string;
  atMs: number;
}

const TTL_MS = 5 * 60 * 1000;
const MAX_PER_SESSION = 16;
const pending = new Map<string, PendingRecall[]>();

export function _resetProceduralRecallLinkForTests(): void {
  pending.clear();
}

function prune(list: PendingRecall[], nowMs: number): PendingRecall[] {
  return list.filter((r) => nowMs - r.atMs <= TTL_MS).slice(-MAX_PER_SESSION);
}

/**
 * Record that the agent RECALLED a CLI/MCP proven path, so the next matching
 * tool result can be attributed to it. No-op for composio (its slug path already
 * credits outcomes) and for empty/invalid input.
 */
export function noteRecalledIntent(
  sessionId: string | undefined,
  intent: string,
  identifier: string | undefined,
  kind: string | undefined,
  nowMs: number = Date.now(),
): void {
  try {
    if (!sessionId || !intent || !identifier) return;
    if (kind !== 'cli' && kind !== 'mcp') return; // composio handled by its own slug path
    const list = prune(pending.get(sessionId) ?? [], nowMs);
    list.push({ intent, identifier: identifier.toLowerCase(), atMs: nowMs });
    pending.set(sessionId, prune(list, nowMs));
  } catch { /* best-effort */ }
}

/** Does a buffered recall's identifier match this executed command/tool name?
 *  Substring match (identifier inside the shell command, or === the MCP tool
 *  name); also matches on the identifier's leading token so `npx netlify-cli …`
 *  recalls credit an `npx`/`netlify` command. */
function identifierMatches(identifier: string, haystackLower: string): boolean {
  if (haystackLower.includes(identifier)) return true;
  const lead = identifier.split(/\s+/)[0];
  return lead.length >= 2 && haystackLower.includes(lead);
}

/**
 * Credit the most-recent buffered CLI/MCP recall whose identifier matches
 * `executed` (a shell command string or an MCP tool name), then CONSUME it (one
 * recall → one credit). Returns the credited intent, or null when nothing
 * matched. `succeeded` drives success vs failure on the specific recalled intent
 * — precise per-operation crediting, not coarse per-binary.
 */
export function creditMatchingRecall(
  sessionId: string | undefined,
  executed: string | undefined,
  succeeded: boolean,
  nowMs: number = Date.now(),
): string | null {
  try {
    if (!sessionId || !executed) return null;
    const list = prune(pending.get(sessionId) ?? [], nowMs);
    if (list.length === 0) { pending.set(sessionId, list); return null; }
    const haystack = executed.toLowerCase();
    // Most-recent matching recall (recall→immediate-use makes this the right one).
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (identifierMatches(list[i].identifier, haystack)) {
        const [credited] = list.splice(i, 1);
        pending.set(sessionId, list);
        updateToolChoiceOutcome(credited.intent, succeeded ? 'success' : 'failure');
        return credited.intent;
      }
    }
    pending.set(sessionId, list);
    return null;
  } catch {
    return null;
  }
}
