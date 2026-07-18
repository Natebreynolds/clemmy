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
 * TWO crediting paths, tried in order (both safe, neither bare-binary):
 *
 *  1. EXPLICIT RECALL (precise). When the agent calls `tool_choice_recall`, we
 *     note that SPECIFIC intent in a small session-scoped buffer; the next
 *     matching tool result credits it and consumes the entry (one recall → at
 *     most one credit). Bounded + TTL'd so a stale recall can't mis-credit a
 *     much-later call.
 *
 *  2. STORE FALLBACK (the 0%-coverage fix). The dominant path is NOT an explicit
 *     recall — proven choices are INJECTED into context every turn (the rubric
 *     tells the agent to read those and SKIP `tool_choice_recall`), so the buffer
 *     is usually empty and path 1 never fires (the precise cause of the measured
 *     0% CLI/MCP coverage). When no noted recall matches, we match the executed
 *     command against the STORE itself — but ONLY on a precise, operation-
 *     confirmed, UNIQUE winner: a CLI memo whose binary AND a distinctive
 *     operation token (from its intent slug or invocation template) both appear,
 *     or an MCP memo whose tool-name matches exactly. Binary-only or ambiguous
 *     (two same-binary memos the command can't disambiguate) credits NOTHING —
 *     the `netlify status` hazard the bare-binary approach couldn't avoid. This
 *     fires for EVERY surface (chat, harness, worker) because it lives at the
 *     shared tool-result boundary, no per-turn assembly threading required.
 *
 * Composio is NOT correlated here either way (its slug path already credits it —
 * avoids double-counting).
 *
 * Best-effort: every function swallows errors; a correlation failure never
 * perturbs a tool call. Gated by CLEMMY_PROCEDURAL_OUTCOMES (the store fallback
 * checks it up front; the updateToolChoiceOutcome it calls is also a no-op off).
 */
import {
  beginToolProcedureUse,
  completeToolProcedureUse,
  _resetToolProcedureUsesForTests,
  updateToolProcedureOutcome,
  listToolChoices,
  isProceduralOutcomesEnabled,
  type ToolChoiceRecord,
} from './tool-choice-store.js';

interface PendingRecall {
  intent: string;
  identifier: string;
  kind: 'cli' | 'mcp';
  invocationTemplate?: string;
  procedureId?: string;
  useId?: string;
  atMs: number;
}

const TTL_MS = 5 * 60 * 1000;
const MAX_PER_SESSION = 16;
const MAX_SESSIONS = 500;
const pending = new Map<string, PendingRecall[]>();

/** A failure that is TRANSIENT (rate-limit, overload, network blip) rather than a
 *  real tool rejection. CLI/MCP failure signal flows into proven-path scores now,
 *  and a single flaky window must NOT teach a good path a failure (3 strikes
 *  auto-invalidate it). Shared by every credit site so the rule lives once. */
export function isTransientFailure(text: string): boolean {
  return /\b(?:429|502|503|rate.?limit(?:ed)?|overloaded|temporarily unavailable|timed?\s?out|etimedout|econnreset|econnrefused|enotfound|socket hang up)\b/i.test(text);
}

export function _resetProceduralRecallLinkForTests(): void {
  pending.clear();
  _resetToolProcedureUsesForTests();
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

function shellSegments(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { current += ch; escaped = true; continue; }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      if (current.trim()) out.push(current.trim());
      current = '';
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i += 1;
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function shellTokens(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(segment)) !== null) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(["'\\ ])/g, '$1'));
  }
  return tokens;
}

function normalizedExecutable(value: string): string {
  let raw = value.trim().toLowerCase().replace(/\\/g, '/');
  raw = raw.slice(raw.lastIndexOf('/') + 1).replace(/\.(?:cmd|exe|bat)$/i, '');
  raw = raw.replace(/@(?:latest|next|\d+(?:\.\d+){0,2}(?:-[a-z0-9.-]+)?)$/i, '');
  if (value.startsWith('@')) {
    const [scope, pkg = ''] = value.toLowerCase().split('/', 2);
    raw = pkg === 'cli' ? scope.replace(/^@/, '') : pkg.replace(/-cli$/, '');
  }
  return raw.replace(/[-_]cli$/, '');
}

interface CliInvocation {
  executable: string;
  args: string[];
}

function invocationFromSegment(segment: string): CliInvocation | null {
  const tokens = shellTokens(segment);
  if (tokens.length === 0) return null;
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  if (tokens[i] === 'env') {
    i += 1;
    while (i < tokens.length && (tokens[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) i += 1;
  }
  if (tokens[i] === 'sudo') {
    i += 1;
    // Stay conservative for complex sudo option/value forms: if the next token
    // is still an option, decline causal attribution instead of guessing.
    if (tokens[i]?.startsWith('-')) return null;
  }
  while (tokens[i] === 'command' || tokens[i] === 'exec' || tokens[i] === 'nohup') i += 1;
  if (i >= tokens.length) return null;

  const runner = normalizedExecutable(tokens[i]);
  if (runner === 'npx' || runner === 'bunx') {
    i += 1;
    while (i < tokens.length && tokens[i].startsWith('-')) i += 1;
    if (i >= tokens.length) return null;
    return { executable: normalizedExecutable(tokens[i]), args: tokens.slice(i + 1) };
  }
  if (runner === 'npm' && tokens[i + 1]?.toLowerCase() === 'exec') {
    i += 2;
    while (i < tokens.length && tokens[i].startsWith('-')) i += 1;
    if (i >= tokens.length) return null;
    return { executable: normalizedExecutable(tokens[i]), args: tokens.slice(i + 1) };
  }
  if ((runner === 'pnpm' || runner === 'yarn') && /^(?:dlx|exec)$/.test(tokens[i + 1]?.toLowerCase() ?? '')) {
    i += 2;
    while (i < tokens.length && tokens[i].startsWith('-')) i += 1;
    if (i >= tokens.length) return null;
    return { executable: normalizedExecutable(tokens[i]), args: tokens.slice(i + 1) };
  }
  return { executable: runner, args: tokens.slice(i + 1) };
}

function cliInvocations(command: string, identifier: string): CliInvocation[] {
  const wanted = normalizedExecutable(identifier);
  if (!wanted) return [];
  return shellSegments(command)
    .map(invocationFromSegment)
    .filter((invocation): invocation is CliInvocation => invocation?.executable === wanted);
}

function templateOperationPrefix(identifier: string, template: string | undefined): string[] {
  if (!template) return [];
  const invocation = cliInvocations(template, identifier)[0];
  if (!invocation) return [];
  const prefix: string[] = [];
  for (const raw of invocation.args) {
    const token = raw.toLowerCase();
    if (!token || token === '...' || token.startsWith('-') || /\{\{|\$[A-Za-z_{]/.test(token)) break;
    prefix.push(token);
    if (prefix.length >= 3) break;
  }
  return prefix;
}

function invocationMatchesTemplate(identifier: string, executed: string, template: string | undefined): number {
  const prefix = templateOperationPrefix(identifier, template);
  if (prefix.length === 0) return 0;
  for (const invocation of cliInvocations(executed, identifier)) {
    const actual = invocation.args.slice(0, prefix.length).map((token) => token.toLowerCase());
    if (prefix.every((token, index) => actual[index] === token)) return prefix.length;
  }
  return 0;
}

/** The OPERATION tokens of an intent slug (everything except the identifier's
 *  own tokens), used to disambiguate two recalls that share a binary (e.g.
 *  `netlify.deploy` vs `netlify.status` both id `netlify`). */
function intentOpTokens(intent: string, identifier: string): string[] {
  const idToks = new Set(identifier.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return intent.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !idToks.has(t));
}

/**
 * Causal operation evidence for a buffered CLI recall. A concrete invocation
 * template is authoritative: it must match and may not be rescued by fuzzy
 * intent words. Older/vague recalls with no concrete template fall back to
 * whole-token operation overlap from the intent slug.
 */
function pendingCliOperationScore(recall: PendingRecall, executed: string): number {
  const prefix = templateOperationPrefix(recall.identifier, recall.invocationTemplate);
  if (prefix.length > 0) {
    return invocationMatchesTemplate(recall.identifier, executed, recall.invocationTemplate) * 100;
  }
  return intentOpTokens(recall.intent, recall.identifier)
    .filter((token) => tokenPresent(token, executed))
    .length;
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
    const use = beginToolProcedureUse(intent, sessionId);
    const invocationTemplate = listToolChoices().find((record) => record.intent === intent)?.choice?.invocationTemplate;
    list.push({
      intent,
      identifier: identifier.toLowerCase(),
      kind,
      invocationTemplate,
      procedureId: use?.procedureId,
      useId: use?.useId,
      atMs: nowMs,
    });
    storeSession(sessionId, prune(list, nowMs));
  } catch { /* best-effort */ }
}

/** Does a CLI identifier occupy an executable position in this shell command?
 * Filenames, arguments, and quoted prose never count as causal procedure use. */
function identifierMatches(identifier: string, haystackLower: string): boolean {
  return cliInvocations(haystackLower, identifier).length > 0;
}

/** Score a stored CLI/MCP memo against an executed command / tool name. Returns
 *  a POSITIVE score only on a precise match (CLI: binary present AND ≥1 operation
 *  token; MCP: tool-name present, 2 when it's the whole haystack). 0 = not a
 *  precise candidate (binary-only, or no match) → never credited. composio is
 *  skipped (its slug path credits it). */
function scoreStoreCandidate(rec: ToolChoiceRecord, haystackLower: string): number {
  const choice = rec.choice;
  if (!choice) return 0;
  const id = choice.identifier.toLowerCase();
  if (choice.kind === 'mcp') {
    if (!tokenPresent(id, haystackLower)) return 0;
    return id === haystackLower.trim() ? 2 : 1;
  }
  if (choice.kind === 'cli') {
    if (!identifierMatches(id, haystackLower)) return 0;
    // No explicit recall means no causal-use signal. Require the stored
    // invocation template's executable + operation prefix to match exactly;
    // fuzzy intent tokens or incidental filenames (`package.json`,
    // `netlify.toml`) are never evidence that the CLI procedure ran.
    return invocationMatchesTemplate(id, haystackLower, choice.invocationTemplate);
  }
  return 0; // composio handled by its slug path
}

/**
 * STORE FALLBACK: with no noted recall to consume, attribute this tool result to
 * the one stored CLI/MCP memo it precisely and UNAMBIGUOUSLY represents. Credits
 * only a unique positive-scoring winner; a tie (two same-binary memos the command
 * can't tell apart) or a binary-only brush credits nothing. Gated up front by the
 * outcomes kill-switch so it does zero store I/O when the feature is off.
 * Returns the credited intent, or null.
 */
function creditFromStore(executed: string, succeeded: boolean): string | null {
  try {
    if (!isProceduralOutcomesEnabled()) return null;
    const haystack = executed.toLowerCase();
    let best: { intent: string; procedureId?: string; score: number } | null = null;
    let tied = false;
    for (const rec of listToolChoices()) {
      const score = scoreStoreCandidate(rec, haystack);
      if (score <= 0) continue;
      if (!best || score > best.score) { best = { intent: rec.intent, procedureId: rec.procedureId, score }; tied = false; }
      else if (score === best.score) { tied = true; }
    }
    if (!best || tied) return null; // nothing precise, or ambiguous → never mis-credit
    if (!best.procedureId) return null;
    updateToolProcedureOutcome(best.procedureId, succeeded ? 'success' : 'failure', best.intent);
    return best.intent;
  } catch {
    return null;
  }
}

/**
 * Credit the buffered CLI/MCP recall that this tool result belongs to, then
 * CONSUME it (one recall → one credit). `succeeded` drives success vs failure on
 * that specific intent — precise PER-OPERATION crediting:
 *   - one CLI recall still needs operation evidence → credit it only when the
 *     deterministic template prefix (or, for an old vague memo, intent operation)
 *     matches,
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
    if (list.length === 0) { storeSession(sessionId, list); return creditFromStore(executed, succeeded); }
    const haystack = executed.toLowerCase();
    const matches = list.map((r, i) => ({
      r,
      i,
      score: r.kind === 'cli' ? pendingCliOperationScore(r, haystack) : 0,
    })).filter((m) =>
      m.r.kind === 'mcp'
        ? tokenPresent(m.r.identifier, haystack)
        : identifierMatches(m.r.identifier, haystack) && m.score > 0);
    if (matches.length === 0) { storeSession(sessionId, list); return creditFromStore(executed, succeeded); }

    let chosen = matches[matches.length - 1].i; // default: most-recent (recall→immediate-use)
    if (matches.length > 1) {
      // Same binary recalled more than once — disambiguate by operation overlap.
      const scored = matches.map((m) => ({
        i: m.i,
        score: m.r.kind === 'cli'
          ? m.score
          : (m.r.identifier === haystack.trim() ? 1 : 0),
      }));
      const max = Math.max(...scored.map((s) => s.score));
      const top = scored.filter((s) => s.score === max);
      if (max <= 0 || top.length !== 1) { storeSession(sessionId, list); return null; } // ambiguous → don't mis-credit
      chosen = top[0].i;
    }

    const [credited] = list.splice(chosen, 1);
    storeSession(sessionId, list);
    if (credited.useId) {
      completeToolProcedureUse(credited.useId, succeeded ? 'success' : 'failure');
    } else if (credited.procedureId) {
      updateToolProcedureOutcome(credited.procedureId, succeeded ? 'success' : 'failure', credited.intent);
    } else {
      return null;
    }
    return credited.intent;
  } catch {
    return null;
  }
}
