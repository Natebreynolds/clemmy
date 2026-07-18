import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ExecutionStore, renderExecutionSummary } from '../execution/store.js';
import { WORKING_MEMORY_FILE } from './vault.js';
import { loadSessionBrief } from './session-briefs.js';
import type { SessionRecord } from '../types.js';
import { PlanStore } from '../planning/plan-store.js';
import { isUserFacingSession } from '../execution/scope.js';
import { getSession as getHarnessSession, listSessions, type SessionRow } from '../runtime/harness/eventlog.js';
import { pullRecentTurnsForHarnessHistory } from '../runtime/harness/session-transcript.js';

const SESSION_WORKING_MEMORY_DIR = path.join(path.dirname(WORKING_MEMORY_FILE), 'state', 'working-memory');


function workingMemoryDigest(sessionId: string): string {
  return createHash('sha1').update(sessionId).digest('hex');
}

export function workingMemoryPathForSession(sessionId: string): string {
  return path.join(SESSION_WORKING_MEMORY_DIR, `${workingMemoryDigest(sessionId)}.md`);
}

export function loadWorkingMemoryForSession(sessionId: string, maxChars = 3000): string | undefined {
  const filePath = workingMemoryPathForSession(sessionId);
  if (!existsSync(filePath)) return undefined;
  try {
    return readFileSync(filePath, 'utf-8').trim().slice(0, maxChars);
  } catch {
    return undefined;
  }
}

export interface ResolvedWorkingMemory {
  content: string;
  /** Label of the session this working memory came from (per-session source only). */
  sessionLabel?: string;
  /** Where the content came from: a live per-session file, the shared global file, or nothing. */
  source: 'session' | 'global' | 'none';
}

function sessionLabelFor(session: SessionRow): string {
  const title = (session.title ?? '').trim();
  if (title) return title;
  const channel = (session.channel ?? '').trim();
  if (channel) return channel;
  return session.id.slice(0, 12);
}

/**
 * Resolve the freshest working memory to display in the console's short-term
 * card. The canonical harness loop writes a per-session working-memory file
 * every turn and the shared global file only for user-facing sessions (and can
 * lag). Prefer the most-recently-updated user-facing session's per-session file;
 * fall back to the global file. Best-effort — never throws (the card must render
 * even if the event log is unavailable).
 */
export function resolveWorkingMemoryForConsole(maxChars = 4000): ResolvedWorkingMemory {
  try {
    // Only an active/paused CHAT can represent the console's live short-term
    // context. Workflow/execution rows may also have checkpoint files, but
    // showing one as the current conversation is both confusing and a context
    // leak. Rank by the file's own mtime: a session row can be touched by
    // bookkeeping after its working-memory snapshot was written.
    const candidates: Array<{ session: SessionRow; content: string; mtimeMs: number }> = [];
    for (const session of listSessions({ kind: 'chat', status: ['active', 'paused'], limit: 500 })) {
      if (!isUserFacingSession(session.id, session.channel ?? undefined)) continue;
      const content = loadWorkingMemoryForSession(session.id, maxChars);
      if (!content?.trim()) continue;
      let mtimeMs = 0;
      try { mtimeMs = statSync(workingMemoryPathForSession(session.id)).mtimeMs; } catch { /* keep deterministic fallback */ }
      candidates.push({ session, content, mtimeMs });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.session.updatedAt.localeCompare(a.session.updatedAt));
    const freshest = candidates[0];
    if (freshest) {
      return {
        content: freshest.content,
        sessionLabel: sessionLabelFor(freshest.session),
        source: 'session',
      };
    }
  } catch {
    // Fall through to the global file below.
  }
  try {
    const global = existsSync(WORKING_MEMORY_FILE)
      ? readFileSync(WORKING_MEMORY_FILE, 'utf-8').trim().slice(0, maxChars)
      : '';
    if (global) return { content: global, source: 'global' };
  } catch {
    // Console memory is observability, not a reason to fail the whole route.
  }
  return { content: '', source: 'none' };
}

function buildSessionSummary(session: SessionRecord): string {
  try {
    if (getHarnessSession(session.id)) {
      const turns = pullRecentTurnsForHarnessHistory(session.id, 3);
      if (turns.length > 0) {
        return turns
          .slice(-6)
          .map((turn) => `${turn.who === 'user' ? 'User' : 'Assistant'}: ${turn.text.replace(/\s+/g, ' ').slice(0, 180)}`)
          .join('\n');
      }
    }
  } catch {
    // Fall back to the supplied legacy session below.
  }
  const turns = session.turns.slice(-6);
  if (turns.length === 0) {
    return 'No recent conversation.';
  }

  return turns
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text.replace(/\s+/g, ' ').slice(0, 180)}`)
    .join('\n');
}

function buildPlanSummary(sessionId: string): string {
  const plans = new PlanStore().list(3, sessionId);
  if (plans.length === 0) return 'No active plans.';

  return plans.map((plan) => {
    const active = plan.steps.find((step) => step.status === 'in_progress');
    const done = plan.steps.filter((step) => step.status === 'done').length;
    return `- ${plan.title} (${done}/${plan.steps.length} complete)${active ? ` | active: ${active.text}` : ''}`;
  }).join('\n');
}

function buildActiveTaskFocus(session: SessionRecord): string {
  const execution = new ExecutionStore().getActiveForSession(session.id);
  if (execution) {
    return `Tracked execution: ${renderExecutionSummary(execution)}`;
  }

  const active = new PlanStore().getActive(session.id);
  if (!active) {
    return 'No active deep task. Keep the next useful move visible.';
  }

  const currentStep = active.steps.find((step) => step.status === 'in_progress');
  if (!currentStep) {
    return `Plan active: ${active.title}. Review remaining steps and decide the next move.`;
  }

  return `Active deep task: ${active.title}. Current step: ${currentStep.text}`;
}

function buildSessionHandoff(session: SessionRecord): string {
  const brief = loadSessionBrief(session.id);
  if (!brief?.manual) {
    return 'No manual handoff recorded for this session.';
  }

  const lines = [`Last saved handoff: ${brief.manual.pausedAt}`];
  if (brief.manual.remaining.length > 0) {
    lines.push(...brief.manual.remaining.slice(0, 4).map((item) => `- [ ] ${item}`));
  }
  if (brief.manual.blockers.length > 0) {
    lines.push(...brief.manual.blockers.slice(0, 3).map((item) => `- blocker: ${item}`));
  }
  return lines.join('\n');
}

export function refreshWorkingMemory(session: SessionRecord, opts: { writeGlobal?: boolean } = {}): void {
  // writeGlobal defaults to true so the legacy respond()/execution callers keep
  // their long-standing contract (they own the shared global working-memory.md).
  // The harness path passes writeGlobal:false — see refreshWorkingMemoryForSession.
  const { writeGlobal = true } = opts;
  const sections = [
    '# Working Memory',
    '',
    '## Current Session',
    buildSessionSummary(session),
    '',
    '## Active Plans',
    buildPlanSummary(session.id),
    '',
    '## Session Handoff',
    buildSessionHandoff(session),
    '',
    '## Focus',
    buildActiveTaskFocus(session),
    '',
  ];

  const baseContent = sections.join('\n');

  const perSessionContent = baseContent;

  mkdirSync(SESSION_WORKING_MEMORY_DIR, { recursive: true });
  writeFileSync(workingMemoryPathForSession(session.id), perSessionContent);
  if (writeGlobal && isUserFacingSession(session.id, session.channel)) {
    writeFileSync(WORKING_MEMORY_FILE, baseContent);
  }
}

/**
 * Harness-facing entry point for the canonical turn loop, which carries a
 * sessionId + channel rather than a full legacy SessionRecord. refreshWorkingMemory
 * reads only id/channel plus turns — and turns are only a fallback that the
 * harness path never reaches (buildSessionSummary pulls recent turns from the
 * harness transcript by id). This builds the minimal record so the harness keeps
 * the PER-SESSION working memory fresh each turn — which the harness injects
 * (harness-context.ts) and the console short-term card reads
 * (resolveWorkingMemoryForConsole).
 *
 * Deliberately `writeGlobal:false`: the harness must NOT overwrite the shared
 * global working-memory.md, which the `working_memory` agent tool owns as a
 * durable model-authored scratchpad. Clobbering it every turn would collapse
 * that tool's cross-turn persistence to zero. The per-session file is all the
 * harness injection + console need.
 */
export function refreshWorkingMemoryForSession(sessionId: string, channel?: string): void {
  const now = new Date().toISOString();
  refreshWorkingMemory({ id: sessionId, channel, createdAt: now, updatedAt: now, turns: [] }, { writeGlobal: false });
}

export function workingMemoryExists(): boolean {
  return existsSync(WORKING_MEMORY_FILE);
}

/**
 * Garbage-collect stale ORPHANED per-session working-memory files. The canonical
 * loop writes state/working-memory/<sha1(sessionId)>.md every turn, while the
 * session reaper intentionally preserves active/paused/pinned/archived rows.
 * Therefore age alone is not deletion authority: an old but resumable session
 * must keep its context. A file is eligible only when it is older than the TTL
 * AND no corresponding harness session row survives. These files live OUTSIDE
 * the indexed vault, so removing them never touches embeddings/vault_chunks.
 * Best-effort — never throws.
 */
export function reapStaleWorkingMemory(maxAgeDays?: number): number {
  const env = process.env.CLEMMY_SESSION_TTL_DAYS;
  const ttl = maxAgeDays ?? (env ? Math.max(1, Math.min(365, Number(env))) : 14);
  if (!Number.isFinite(ttl) || ttl <= 0) return 0;
  if (!existsSync(SESSION_WORKING_MEMORY_DIR)) return 0;
  const cutoff = Date.now() - Math.floor(ttl) * 24 * 60 * 60 * 1000;
  const retainedFiles = new Set<string>();
  try {
    // listSessions caps one page at 500, so page until exhausted. Hashing the
    // surviving ids lets us compare against the privacy-preserving filenames
    // without needing to reverse the SHA-1.
    for (let offset = 0; ; offset += 500) {
      const page = listSessions({ limit: 500, offset });
      for (const session of page) retainedFiles.add(path.basename(workingMemoryPathForSession(session.id)));
      if (page.length < 500) break;
    }
  } catch {
    // If the session store is unavailable, fail closed: deleting nothing is
    // safer than orphaning resumable sessions.
    return 0;
  }
  let removed = 0;
  try {
    for (const entry of readdirSync(SESSION_WORKING_MEMORY_DIR)) {
      if (!entry.endsWith('.md')) continue;
      if (retainedFiles.has(entry)) continue;
      const filePath = path.join(SESSION_WORKING_MEMORY_DIR, entry);
      try {
        if (statSync(filePath).mtimeMs < cutoff) {
          unlinkSync(filePath);
          removed++;
        }
      } catch {
        // Unreadable/again-removed entry — skip it, never fail the sweep.
      }
    }
  } catch {
    // Directory vanished mid-sweep; nothing to do.
  }
  return removed;
}

/**
 * P2-F — lightweight between-turn checkpoint. `refreshWorkingMemory` only
 * runs at the END of a `respond` call, so a run that aborts mid-tool-loop
 * (e.g. a wall-clock abort) persists nothing. This writes/updates a compact
 * `## In-flight Checkpoint` section in the per-session working-memory file
 * after a substantive turn, so a later retry / watchdog re-spawn resumes
 * from progress instead of zero. Deterministic, no LLM, best-effort — a
 * write failure must never break a turn. Non-destructive: it only replaces
 * the checkpoint section, leaving any existing working-memory content intact
 * (a normal turn-end `refreshWorkingMemory` overwrites the whole file again).
 */
export function checkpointWorkingMemory(
  sessionId: string,
  progress: { lastText?: string; toolCallsTotal?: number; turn?: number },
): void {
  try {
    const filePath = workingMemoryPathForSession(sessionId);
    const checkpointSection = [
      '## In-flight Checkpoint',
      `Updated: ${new Date().toISOString()}`,
      progress.turn !== undefined ? `Turn: ${progress.turn}` : null,
      progress.toolCallsTotal !== undefined ? `Tool calls so far: ${progress.toolCallsTotal}` : null,
      progress.lastText ? `Latest: ${progress.lastText.replace(/\s+/g, ' ').slice(0, 500)}` : null,
    ].filter(Boolean).join('\n');

    let existing = '';
    if (existsSync(filePath)) {
      try { existing = readFileSync(filePath, 'utf-8'); } catch { existing = ''; }
    }

    let next: string;
    if (/## In-flight Checkpoint/.test(existing)) {
      next = existing.replace(/## In-flight Checkpoint[\s\S]*?(?=\n## |$)/, `${checkpointSection}\n`);
    } else if (existing.trim()) {
      next = `${existing.trimEnd()}\n\n${checkpointSection}\n`;
    } else {
      next = `# Working Memory\n\n${checkpointSection}\n`;
    }

    mkdirSync(SESSION_WORKING_MEMORY_DIR, { recursive: true });
    writeFileSync(filePath, next);
  } catch {
    // best-effort; a checkpoint write must never break or fail a turn.
  }
}
