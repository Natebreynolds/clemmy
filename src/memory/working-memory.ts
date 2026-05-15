import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ExecutionStore, renderExecutionSummary } from '../execution/store.js';
import { WORKING_MEMORY_FILE } from './vault.js';
import { loadSessionBrief } from './session-briefs.js';
import type { SessionRecord } from '../types.js';
import { PlanStore } from '../planning/plan-store.js';
import { isUserFacingSession } from '../execution/scope.js';

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

  const content = sections.join('\n');
  mkdirSync(SESSION_WORKING_MEMORY_DIR, { recursive: true });
  writeFileSync(workingMemoryPathForSession(session.id), content);
  if (isUserFacingSession(session.id, session.channel)) {
    writeFileSync(WORKING_MEMORY_FILE, content);
  }
}

export function workingMemoryExists(): boolean {
  return existsSync(WORKING_MEMORY_FILE);
}
