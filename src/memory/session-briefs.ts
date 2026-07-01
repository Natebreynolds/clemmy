import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { ExecutionStore, renderExecutionSummary } from '../execution/store.js';
import { PlanStore } from '../planning/plan-store.js';
import type { SessionAutoBrief, SessionBriefRecord, SessionManualHandoff, SessionRecord } from '../types.js';
import { getSession as getHarnessSession } from '../runtime/harness/eventlog.js';
import { pullRecentTurnsForHarnessHistory } from '../runtime/harness/session-transcript.js';

const SESSION_BRIEFS_DIR = path.join(BASE_DIR, 'state', 'session-briefs');

function ensureSessionBriefsDir(): void {
  if (!existsSync(SESSION_BRIEFS_DIR)) {
    mkdirSync(SESSION_BRIEFS_DIR, { recursive: true });
  }
}

function briefPathForSession(sessionId: string): string {
  const digest = createHash('sha1').update(sessionId).digest('hex');
  return path.join(SESSION_BRIEFS_DIR, `${digest}.json`);
}

function cleanText(value: string, maxChars = 180): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function cleanList(values: string[], maxItems = 6, maxChars = 180): string[] {
  const seen = new Set<string>();
  const items: string[] = [];

  for (const raw of values) {
    const item = cleanText(raw, maxChars);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= maxItems) break;
  }

  return items;
}

function isLowSignalTurn(role: 'user' | 'assistant', text: string): boolean {
  const normalized = text.toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').trim();
  if (role === 'user') {
    return /^(approve|approved|approve all|approved all|reject|rejected|reject all|yes|yes to all|yep|yeah|no|go ahead|proceed|run it|do it|authorized|authorize|cancel|stop)$/i.test(normalized);
  }
  return /^approval required before i continue\.?\s+pending approval id:/i.test(text.trim());
}

function latestTurnText(session: SessionRecord, role: 'user' | 'assistant'): string | undefined {
  return [...session.turns]
    .reverse()
    .find((turn) => turn.role === role && !isLowSignalTurn(turn.role, turn.text))
    ?.text;
}

function listTurnTexts(session: SessionRecord, role: 'user' | 'assistant', limit: number, maxChars = 160): string[] {
  return cleanList(
    [...session.turns]
      .reverse()
      .filter((turn) => turn.role === role)
      .filter((turn) => !isLowSignalTurn(turn.role, turn.text))
      .map((turn) => turn.text),
    limit,
    maxChars,
  );
}

function listOpenQuestions(session: SessionRecord): string[] {
  return cleanList(
    [...session.turns]
      .reverse()
      .filter((turn) => turn.role === 'user')
      .filter((turn) => !isLowSignalTurn(turn.role, turn.text))
      .map((turn) => turn.text)
      .filter((text) => text.includes('?')),
    4,
    200,
  );
}

function buildActivePlanSummary(sessionId: string): string | undefined {
  const activePlan = new PlanStore().getActive(sessionId);
  if (!activePlan) return undefined;

  const currentStep = activePlan.steps.find((step) => step.status === 'in_progress');
  if (!currentStep) {
    return activePlan.title;
  }

  return `${activePlan.title} -> ${cleanText(currentStep.text, 160)}`;
}

function buildSummary(session: SessionRecord, activePlan?: string, activeExecution?: string): string {
  const firstMeaningfulUser = session.turns.find((turn) => turn.role === 'user' && !isLowSignalTurn(turn.role, turn.text))?.text;
  const latestUser = latestTurnText(session, 'user');
  const latestAssistant = latestTurnText(session, 'assistant');
  const parts: string[] = [];

  if (firstMeaningfulUser) {
    parts.push(`Started around: ${cleanText(firstMeaningfulUser, 140)}.`);
  }
  if (latestUser && latestUser !== firstMeaningfulUser) {
    parts.push(`Latest ask: ${cleanText(latestUser, 160)}.`);
  }
  if (latestAssistant) {
    parts.push(`Latest response: ${cleanText(latestAssistant, 180)}.`);
  }
  if (activePlan) {
    parts.push(`Active plan: ${activePlan}.`);
  }
  if (activeExecution) {
    parts.push(`Active execution: ${activeExecution}.`);
  }

  if (parts.length === 0) {
    return 'No prior activity.';
  }

  return cleanText(parts.join(' '), 700);
}

function buildAutoBrief(session: SessionRecord, manual?: SessionManualHandoff): SessionAutoBrief {
  const activePlan = buildActivePlanSummary(session.id);
  const activeExecution = new ExecutionStore().getActiveForSession(session.id);
  return {
    summary: buildSummary(session, activePlan, activeExecution ? renderExecutionSummary(activeExecution) : undefined),
    recentUserRequests: listTurnTexts(session, 'user', 4),
    recentAssistantActions: listTurnTexts(session, 'assistant', 3),
    openQuestions: listOpenQuestions(session),
    activePlan,
    nextStep: manual?.remaining[0] ?? activeExecution?.nextStep ?? activePlan ?? latestTurnText(session, 'user')?.slice(0, 180),
  };
}

function canonicalSessionForBrief(session: SessionRecord): SessionRecord {
  try {
    const row = getHarnessSession(session.id);
    if (!row) return session;
    const turns = pullRecentTurnsForHarnessHistory(session.id, 20).map((turn) => ({
      role: turn.who === 'user' ? 'user' as const : 'assistant' as const,
      text: turn.text,
      createdAt: turn.at,
    }));
    if (turns.length === 0) return session;
    return {
      ...session,
      userId: row.userId ?? session.userId,
      channel: row.channel ?? session.channel,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      title: row.title ?? row.objective ?? session.title,
      turns,
    };
  } catch {
    return session;
  }
}

export function loadSessionBrief(sessionId: string): SessionBriefRecord | null {
  ensureSessionBriefsDir();
  const filePath = briefPathForSession(sessionId);
  if (!existsSync(filePath)) return null;

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as SessionBriefRecord;
  } catch {
    return null;
  }
}

function saveSessionBrief(brief: SessionBriefRecord): void {
  ensureSessionBriefsDir();
  writeFileSync(briefPathForSession(brief.sessionId), JSON.stringify(brief, null, 2), 'utf-8');
}

export function refreshSessionBrief(session: SessionRecord): SessionBriefRecord {
  const canonicalSession = canonicalSessionForBrief(session);
  const existing = loadSessionBrief(session.id);
  const brief: SessionBriefRecord = {
    sessionId: canonicalSession.id,
    userId: canonicalSession.userId,
    channel: canonicalSession.channel,
    createdAt: existing?.createdAt ?? canonicalSession.createdAt,
    updatedAt: canonicalSession.updatedAt,
    auto: buildAutoBrief(canonicalSession, existing?.manual),
    manual: existing?.manual,
  };
  saveSessionBrief(brief);
  return brief;
}

export function saveSessionManualHandoff(input: {
  session: SessionRecord;
  completed: string[];
  remaining: string[];
  decisions?: string[];
  blockers?: string[];
  context?: string;
}): SessionBriefRecord {
  const manual: SessionManualHandoff = {
    pausedAt: new Date().toISOString(),
    completed: cleanList(input.completed, 12, 180),
    remaining: cleanList(input.remaining, 12, 180),
    decisions: cleanList(input.decisions ?? [], 12, 180),
    blockers: cleanList(input.blockers ?? [], 12, 180),
    context: cleanText(input.context ?? '', 1200),
  };

  const canonicalSession = canonicalSessionForBrief(input.session);
  const brief: SessionBriefRecord = {
    sessionId: canonicalSession.id,
    userId: canonicalSession.userId,
    channel: canonicalSession.channel,
    createdAt: loadSessionBrief(canonicalSession.id)?.createdAt ?? canonicalSession.createdAt,
    updatedAt: canonicalSession.updatedAt,
    auto: buildAutoBrief(canonicalSession, manual),
    manual,
  };
  saveSessionBrief(brief);
  return brief;
}

function renderListSection(title: string, items: string[], prefix = '- '): string {
  if (items.length === 0) return '';
  return [`## ${title}`, ...items.map((item) => `${prefix}${item}`)].join('\n');
}

export function renderSessionContinuity(brief: SessionBriefRecord | null, maxChars = 2600): string {
  if (!brief) return '';

  // Decision-relevant blocks FIRST — the explicit resume pointer (Next Best
  // Step) and the user-authored handoff (Manual Context) — so they survive the
  // tail cut; the long auto-lists ride the tail where truncation costs least.
  // (They used to render LAST and vanished first on a busy session.)
  const sections = [
    `## Summary\n${brief.auto.summary}`,
    brief.auto.nextStep ? `## Next Best Step\n${brief.auto.nextStep}` : '',
    brief.manual?.context ? `## Manual Context\n${brief.manual.context}` : '',
    renderListSection('Recent User Requests', brief.auto.recentUserRequests),
    renderListSection('Open Questions', brief.auto.openQuestions),
    brief.auto.activePlan ? `## Active Plan\n${brief.auto.activePlan}` : '',
    brief.manual?.remaining?.length ? renderListSection('Open Loops From Last Handoff', brief.manual.remaining, '- [ ] ') : '',
    brief.manual?.blockers?.length ? renderListSection('Blockers', brief.manual.blockers) : '',
  ].filter(Boolean);

  const joined = sections.join('\n\n').trim();
  return joined.length > maxChars ? `${joined.slice(0, maxChars).trim()}\n…(continuity truncated)` : joined;
}

export function renderSessionResume(session: SessionRecord, brief: SessionBriefRecord | null): string {
  const sections = [
    `Session: ${session.id}`,
    `Updated: ${session.updatedAt}`,
    brief?.manual?.pausedAt ? `Last handoff: ${brief.manual.pausedAt}` : '',
    '',
    renderSessionContinuity(brief, 3200),
  ].filter(Boolean);

  const transcript = session.turns
    .slice(-12)
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`)
    .join('\n');

  if (transcript) {
    sections.push('', 'Recent turns:', transcript);
  }

  return sections.join('\n');
}

export function listSessionBriefs(limit = 20): SessionBriefRecord[] {
  ensureSessionBriefsDir();
  return readdirSync(SESSION_BRIEFS_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      try {
        return JSON.parse(readFileSync(path.join(SESSION_BRIEFS_DIR, entry), 'utf-8')) as SessionBriefRecord;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is SessionBriefRecord => entry !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

export function countSessionBriefs(): number {
  ensureSessionBriefsDir();
  return readdirSync(SESSION_BRIEFS_DIR).filter((entry) => entry.endsWith('.json')).length;
}
