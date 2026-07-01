import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ExecutionStore, renderExecutionSummary } from '../execution/store.js';
import { WORKING_MEMORY_FILE } from './vault.js';
import { loadSessionBrief } from './session-briefs.js';
import type { SessionRecord } from '../types.js';
import { PlanStore } from '../planning/plan-store.js';
import { isUserFacingSession } from '../execution/scope.js';
import { getSession as getHarnessSession } from '../runtime/harness/eventlog.js';
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

export function refreshWorkingMemory(session: SessionRecord): void {
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
  if (isUserFacingSession(session.id, session.channel)) {
    writeFileSync(WORKING_MEMORY_FILE, baseContent);
  }
}

export function workingMemoryExists(): boolean {
  return existsSync(WORKING_MEMORY_FILE);
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
