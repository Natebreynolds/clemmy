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
const MAX_SESSIONS = 500;
const pending = new Map<string, PendingRecall[]>();

export function _resetProceduralRecallLinkForTests(): void {
  pending.clear();
}

function prune(list: PendingRecall[], nowMs: number): PendingRecall[] {
  return list.filter((r) => nowMs - r.atMs <= TTL_MS).slice(-MAX_PER_SESSION);
}

/** Write back a session's pruned list — or DELETE the key when it's empty so the
 *  module-level Map can't grow one permanent entry per session for the daemon's
 *  lifetime. Caps the Map at MAX_SESSIONS, evicting the session whose newest
 *  recall is oldest (best-effort LRU). */
function storeSession(sessionId: string, list: PendingRecall[]): void {
  if (list.length === 0) { pending.delete(sessionId); return; }
  pending.set(sessionId, list);
  if (pending.size > MAX_SESSIONS) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [k, v] of pending) {
      const newest = v.length > 0 ? v[v.length - 1].atMs : 0;
      if (newest < oldestAt) { oldestAt = newest; oldestKey = k; }
    }
    if (oldestKey && oldestKey !== sessionId) pending.delete(oldestKey);
  }
}

/** Does `token` appear as a WHOLE TOKEN (word-boundary delimited) in the
 *  haystack? Substring-with-boundaries — so a 2-char binary like `gh` matches
 *  `gh pr create` but NOT inside `highlight`/`debugging`. */
function tokenPresent(token: string, haystackLower: string): boolean {
  if (!token || token.length < 2) return false;
  for (let from = 0; ; ) {
    const idx = haystackLower.indexOf(token, from);
    if (idx < 0) return false;
    const before = idx === 0 ? '' : haystackLower[idx - 1];
    const after = idx + token.length >= haystackLower.length ? '' : haystackLower[idx + token.length];
    const boundedBefore = before === '' || /[^a-z0-9]/.test(before);
    const boundedAfter = after === '' || /[^a-z0-9]/.test(after);
    if (boundedBefore && boundedAfter) return true;
    from = idx + 1;
  }
}

/** The OPERATION tokens of an intent slug (everything except the identifier's
 *  own tokens), used to disambiguate two recalls that share a binary (e.g.
 *  `netlify.deploy` vs `netlify.status` both id `netlify`). */
function intentOpTokens(intent: string, identifier: string): string[] {
  const idToks = new Set(identifier.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return intent.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !idToks.has(t));
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
    storeSession(sessionId, prune(list, nowMs));
  } catch { /* best-effort */ }
}

/** Does a buffered recall's identifier match this executed command/tool name?
 *  WORD-BOUNDARY token match (the identifier as a whole token, or its leading
 *  token so `npx netlify-cli …` recalls match an `npx …` command) — so a short
 *  binary like `gh` matches `gh pr create` but NOT inside `highlight`. */
function identifierMatches(identifier: string, haystackLower: string): boolean {
  return tokenPresent(identifier, haystackLower) || tokenPresent(identifier.split(/\s+/)[0], haystackLower);
}

/**
 * Credit the buffered CLI/MCP recall that this tool result belongs to, then
 * CONSUME it (one recall → one credit). `succeeded` drives success vs failure on
 * that specific intent — precise PER-OPERATION crediting:
 *   - one recall matches the binary → credit it,
 *   - several share the binary (e.g. `netlify.deploy` + `netlify.status`) →
 *     disambiguate by which intent's OPERATION tokens appear in the executed
 *     command; if none distinguishes them (genuinely ambiguous), credit NOTHING
 *     rather than mis-attribute a `netlify status` outcome to a `netlify.deploy`
 *     memo (the exact hazard this module exists to prevent).
 * Returns the credited intent, or null when nothing matched / it was ambiguous.
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
    if (list.length === 0) { storeSession(sessionId, list); return null; }
    const haystack = executed.toLowerCase();
    const matches = list.map((r, i) => ({ r, i })).filter((m) => identifierMatches(m.r.identifier, haystack));
    if (matches.length === 0) { storeSession(sessionId, list); return null; }

    let chosen = matches[matches.length - 1].i; // default: most-recent (recall→immediate-use)
    if (matches.length > 1) {
      // Same binary recalled more than once — disambiguate by operation overlap.
      const scored = matches.map((m) => ({
        i: m.i,
        score: intentOpTokens(m.r.intent, m.r.identifier).filter((t) => tokenPresent(t, haystack)).length,
      }));
      const max = Math.max(...scored.map((s) => s.score));
      const top = scored.filter((s) => s.score === max);
      if (max <= 0 || top.length !== 1) { storeSession(sessionId, list); return null; } // ambiguous → don't mis-credit
      chosen = top[0].i;
    }

    const [credited] = list.splice(chosen, 1);
    storeSession(sessionId, list);
    updateToolChoiceOutcome(credited.intent, succeeded ? 'success' : 'failure');
    return credited.intent;
  } catch {
    return null;
  }
}
