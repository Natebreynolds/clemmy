import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { GOALS_DIR } from '../tools/shared.js';
import { ExecutionStore } from '../execution/store.js';
import { createCheckIn, listOpenCheckIns, type CheckInUrgency } from './check-ins.js';

/**
 * Proactive check-in templates — user-configurable patterns that fire
 * autonomous reach-outs.
 *
 * Distinct from the reactive ask_user_question tool (where the agent
 * decides mid-cycle that it's stuck on info). Templates here are
 * user-curated: the user defines a trigger ("Monday morning",
 * "execution blocked > 24h"), the agent fires the matching question
 * when the trigger matches.
 *
 * Triggers in v1:
 *   - schedule  · cron expression
 *   - condition · one of: execution_blocked, goal_stale, inbox_backed_up
 *
 * Each template carries a cooldown so it doesn't re-fire repeatedly
 * while the trigger remains true.
 *
 * Storage: ~/.clementine-next/state/check-in-templates/*.json
 * Plus a per-template runtime state file recording lastFiredAt.
 *
 * Seeded templates ship DISABLED — users opt in from the dashboard,
 * which keeps a fresh install quiet.
 */

const logger = pino({ name: 'clementine-next.check-in-templates' });

const TEMPLATES_DIR = path.join(BASE_DIR, 'state', 'check-in-templates');
const STATE_FILE = path.join(BASE_DIR, 'state', 'check-in-templates-state.json');

export type TriggerKind = 'schedule' | 'execution_blocked' | 'goal_stale' | 'inbox_backed_up';

export interface CheckInTemplate {
  id: string;
  name: string;
  description: string;
  /** Slug of the agent that owns / fires this check-in. */
  agentSlug: string;
  trigger: TriggerKind;
  /** Required when trigger === 'schedule'. Five-field cron expression. */
  schedule?: string;
  /** Required when trigger === 'execution_blocked'. Hours an execution
   *  has to have been blocked before we fire. Default: 24. */
  blockedHours?: number;
  /** Required when trigger === 'goal_stale'. Days since the goal was
   *  last updated. Default: 7. */
  staleDays?: number;
  /** Required when trigger === 'inbox_backed_up'. Pending inbox count
   *  threshold. Default: 10. */
  inboxThreshold?: number;
  /** Question shown to the user. Supports {{placeholders}} substituted
   *  per trigger context — see renderQuestion(). */
  questionTemplate: string;
  urgency: CheckInUrgency;
  /** Minimum hours between firings, even if the trigger remains true.
   *  Schedule triggers usually want >=1h; condition triggers >=6h. */
  cooldownHours: number;
  enabled: boolean;
  /** Optional template version for future schema upgrades. */
  version: 'v1';
  createdAt: string;
  updatedAt: string;
  /** Reserved: tag set by the seeder so we don't double-seed. */
  seededId?: string;
}

interface TemplateRuntimeState {
  lastFiredAt?: string;
  lastTriggeredAt?: string;
  lastCheckInId?: string;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function templatePath(id: string): string {
  return path.join(TEMPLATES_DIR, `${id}.json`);
}

function readTemplate(id: string): CheckInTemplate | null {
  const filePath = templatePath(id);
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) as CheckInTemplate; }
  catch { return null; }
}

function writeTemplate(template: CheckInTemplate): void {
  ensureDir(TEMPLATES_DIR);
  const tmp = `${templatePath(template.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(template, null, 2), 'utf-8');
  renameSync(tmp, templatePath(template.id));
}

interface StateShape {
  version: 'v1';
  entries: Record<string, TemplateRuntimeState>;
}

function readState(): StateShape {
  if (!existsSync(STATE_FILE)) return { version: 'v1', entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    if (parsed && parsed.version === 'v1' && parsed.entries) return parsed as StateShape;
  } catch { /* fall through */ }
  return { version: 'v1', entries: {} };
}

function writeState(state: StateShape): void {
  ensureDir(path.dirname(STATE_FILE));
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, STATE_FILE);
}

// ─── Public CRUD ────────────────────────────────────────────────

export interface CreateTemplateInput {
  name: string;
  description?: string;
  agentSlug?: string;
  trigger: TriggerKind;
  schedule?: string;
  blockedHours?: number;
  staleDays?: number;
  inboxThreshold?: number;
  questionTemplate: string;
  urgency?: CheckInUrgency;
  cooldownHours?: number;
  enabled?: boolean;
  seededId?: string;
}

export function listCheckInTemplates(): CheckInTemplate[] {
  if (!existsSync(TEMPLATES_DIR)) return [];
  const items: CheckInTemplate[] = [];
  for (const entry of readdirSync(TEMPLATES_DIR)) {
    if (!entry.endsWith('.json')) continue;
    try { items.push(JSON.parse(readFileSync(path.join(TEMPLATES_DIR, entry), 'utf-8')) as CheckInTemplate); }
    catch { continue; }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export function getCheckInTemplate(id: string): CheckInTemplate | null {
  return readTemplate(id);
}

export function createCheckInTemplate(input: CreateTemplateInput): CheckInTemplate {
  const now = new Date().toISOString();
  const template: CheckInTemplate = {
    id: input.seededId ?? `tpl-${randomUUID().slice(0, 8)}`,
    name: input.name.trim(),
    description: (input.description ?? '').trim(),
    agentSlug: input.agentSlug?.trim() || 'clementine',
    trigger: input.trigger,
    schedule: input.trigger === 'schedule' ? input.schedule : undefined,
    blockedHours: input.trigger === 'execution_blocked' ? (input.blockedHours ?? 24) : undefined,
    staleDays: input.trigger === 'goal_stale' ? (input.staleDays ?? 7) : undefined,
    inboxThreshold: input.trigger === 'inbox_backed_up' ? (input.inboxThreshold ?? 10) : undefined,
    questionTemplate: input.questionTemplate.trim(),
    urgency: input.urgency ?? 'normal',
    cooldownHours: input.cooldownHours ?? (input.trigger === 'schedule' ? 1 : 12),
    enabled: input.enabled ?? false,
    version: 'v1',
    createdAt: now,
    updatedAt: now,
    seededId: input.seededId,
  };
  writeTemplate(template);
  return template;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string;
  trigger?: TriggerKind;
  schedule?: string;
  blockedHours?: number;
  staleDays?: number;
  inboxThreshold?: number;
  questionTemplate?: string;
  urgency?: CheckInUrgency;
  cooldownHours?: number;
  enabled?: boolean;
}

export function updateCheckInTemplate(id: string, patch: UpdateTemplateInput): CheckInTemplate | null {
  const existing = readTemplate(id);
  if (!existing) return null;
  const merged: CheckInTemplate = {
    ...existing,
    ...patch,
    id: existing.id,
    version: 'v1',
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  } as CheckInTemplate;
  writeTemplate(merged);
  return merged;
}

export function deleteCheckInTemplate(id: string): boolean {
  const filePath = templatePath(id);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  const state = readState();
  delete state.entries[id];
  writeState(state);
  return true;
}

export function getTemplateState(id: string): TemplateRuntimeState {
  return readState().entries[id] ?? {};
}

function recordTemplateFired(id: string, checkInId: string): void {
  const state = readState();
  state.entries[id] = {
    ...state.entries[id],
    lastFiredAt: new Date().toISOString(),
    lastCheckInId: checkInId,
  };
  writeState(state);
}

// ─── Trigger evaluation ────────────────────────────────────────

/**
 * Parse a 5-field cron expression and decide whether it matches the
 * given date. Mirrors the daemon's cron matcher so the semantics are
 * identical across the codebase.
 */
function fieldMatch(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !Number.isNaN(step) && step > 0 && value % step === 0;
  }
  for (const part of field.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (!Number.isNaN(a) && !Number.isNaN(b) && value >= a && value <= b) return true;
    } else if (parseInt(part, 10) === value) {
      return true;
    }
  }
  return false;
}

export function cronMatches(expr: string, at: Date = new Date()): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  return (
    fieldMatch(min, at.getMinutes()) &&
    fieldMatch(hour, at.getHours()) &&
    fieldMatch(dom, at.getDate()) &&
    fieldMatch(mon, at.getMonth() + 1) &&
    fieldMatch(dow, at.getDay())
  );
}

interface GoalRecord {
  id: string;
  title: string;
  status: 'active' | 'paused' | 'completed' | 'blocked';
  updatedAt?: string;
  blockers?: string[];
}

function readGoalsForCheck(): GoalRecord[] {
  if (!existsSync(GOALS_DIR)) return [];
  const goals: GoalRecord[] = [];
  for (const file of readdirSync(GOALS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try { goals.push(JSON.parse(readFileSync(path.join(GOALS_DIR, file), 'utf-8')) as GoalRecord); }
    catch { continue; }
  }
  return goals;
}

interface TriggerContext {
  triggeredAt: string;
  /** Free-form metadata about WHY the trigger fired — substituted into the
   *  question template via {{summary}}. */
  summary: string;
  details: Record<string, unknown>;
}

function evaluateTrigger(template: CheckInTemplate, now: Date): TriggerContext | null {
  if (template.trigger === 'schedule') {
    if (!template.schedule) return null;
    if (!cronMatches(template.schedule, now)) return null;
    return {
      triggeredAt: now.toISOString(),
      summary: `scheduled at ${now.toISOString().slice(0, 16).replace('T', ' ')}`,
      details: { schedule: template.schedule },
    };
  }

  if (template.trigger === 'execution_blocked') {
    const threshold = template.blockedHours ?? 24;
    const cutoff = now.getTime() - threshold * 60 * 60 * 1000;
    const executions = new ExecutionStore().list(40)
      .filter((e) => e.status === 'blocked')
      .filter((e) => {
        const ts = e.updatedAt ?? e.lastActivityAt ?? e.createdAt;
        if (!ts) return false;
        return new Date(ts).getTime() <= cutoff;
      });
    if (executions.length === 0) return null;
    const first = executions[0];
    return {
      triggeredAt: now.toISOString(),
      summary: `${executions.length} execution${executions.length === 1 ? '' : 's'} blocked >${threshold}h`,
      details: {
        executionId: first.id,
        executionTitle: first.title,
        blocker: first.blocker,
      },
    };
  }

  if (template.trigger === 'goal_stale') {
    const threshold = template.staleDays ?? 7;
    const cutoff = now.getTime() - threshold * 24 * 60 * 60 * 1000;
    const stale = readGoalsForCheck()
      .filter((g) => g.status === 'active')
      .filter((g) => {
        const ts = g.updatedAt;
        if (!ts) return true;
        return new Date(ts).getTime() <= cutoff;
      });
    if (stale.length === 0) return null;
    const first = stale[0];
    return {
      triggeredAt: now.toISOString(),
      summary: `${stale.length} goal${stale.length === 1 ? '' : 's'} stale >${threshold}d`,
      details: { goalId: first.id, goalTitle: first.title },
    };
  }

  if (template.trigger === 'inbox_backed_up') {
    const threshold = template.inboxThreshold ?? 10;
    const open = listOpenCheckIns().length;
    // We use open check-ins as the inbox proxy in v1 — closest signal
    // that's already first-class. Future variants can read agent
    // inbox files directly.
    if (open < threshold) return null;
    return {
      triggeredAt: now.toISOString(),
      summary: `${open} open check-ins (threshold ${threshold})`,
      details: { count: open, threshold },
    };
  }

  return null;
}

export function renderQuestion(template: CheckInTemplate, context: TriggerContext): string {
  const placeholders: Record<string, string> = {
    summary: context.summary,
    date: new Date().toISOString().slice(0, 10),
    time: new Date().toISOString().slice(11, 16),
    executionTitle: String(context.details.executionTitle ?? ''),
    blocker: String(context.details.blocker ?? ''),
    goalTitle: String(context.details.goalTitle ?? ''),
    count: String(context.details.count ?? ''),
  };
  return template.questionTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    placeholders[key] !== undefined ? placeholders[key] : `{{${key}}}`,
  );
}

function isCooldownElapsed(template: CheckInTemplate, state: TemplateRuntimeState, now: Date): boolean {
  if (!state.lastFiredAt) return true;
  const elapsed = now.getTime() - new Date(state.lastFiredAt).getTime();
  const cooldown = Math.max(0, template.cooldownHours) * 60 * 60 * 1000;
  return elapsed >= cooldown;
}

export interface ProcessCheckInTemplatesResult {
  evaluated: number;
  triggered: number;
  fired: string[];   // check-in ids
  skipped: { templateId: string; reason: string }[];
}

/**
 * Daemon-tick entry point. Walks every enabled template, evaluates its
 * trigger, fires a CheckInRecord when the trigger is hot and the
 * cooldown has elapsed. Idempotent within a cycle.
 */
export function processProactiveCheckIns(now: Date = new Date()): ProcessCheckInTemplatesResult {
  const result: ProcessCheckInTemplatesResult = { evaluated: 0, triggered: 0, fired: [], skipped: [] };
  for (const template of listCheckInTemplates()) {
    if (!template.enabled) continue;
    result.evaluated++;

    const triggerContext = evaluateTrigger(template, now);
    if (!triggerContext) continue;
    result.triggered++;

    const state = getTemplateState(template.id);
    if (!isCooldownElapsed(template, state, now)) {
      result.skipped.push({ templateId: template.id, reason: 'cooldown not elapsed' });
      continue;
    }

    try {
      const question = renderQuestion(template, triggerContext);
      const record = createCheckIn({
        agentSlug: template.agentSlug,
        question,
        urgency: template.urgency,
        contextSummary: triggerContext.summary,
      });
      recordTemplateFired(template.id, record.id);
      result.fired.push(record.id);
      logger.info({ templateId: template.id, templateName: template.name, checkInId: record.id }, 'proactive check-in fired');
    } catch (err) {
      logger.warn({ err, templateId: template.id }, 'failed to fire proactive check-in');
      result.skipped.push({ templateId: template.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/**
 * Manually fire a template — used by the dashboard's "Test fire"
 * button. Bypasses the trigger check but still respects cooldown
 * (unless `bypassCooldown` is true).
 */
export function testFireTemplate(id: string, options: { bypassCooldown?: boolean } = {}): { ok: boolean; checkInId?: string; reason?: string } {
  const template = readTemplate(id);
  if (!template) return { ok: false, reason: 'template not found' };
  if (!options.bypassCooldown) {
    const state = getTemplateState(id);
    if (!isCooldownElapsed(template, state, new Date())) {
      return { ok: false, reason: 'cooldown not elapsed' };
    }
  }
  const now = new Date();
  const fauxContext: TriggerContext = {
    triggeredAt: now.toISOString(),
    summary: `manual test fire at ${now.toISOString().slice(0, 16)}`,
    details: {},
  };
  try {
    const question = renderQuestion(template, fauxContext);
    const record = createCheckIn({
      agentSlug: template.agentSlug,
      question,
      urgency: template.urgency,
      contextSummary: 'TEST · manual fire from dashboard',
    });
    recordTemplateFired(template.id, record.id);
    return { ok: true, checkInId: record.id };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Seed library ──────────────────────────────────────────────

/**
 * Built-in templates seeded the first time the daemon (or dashboard)
 * boots. All start DISABLED — the user opts in. We use a stable
 * `seededId` so re-runs don't duplicate.
 */
export const SEED_TEMPLATES: CreateTemplateInput[] = [
  {
    seededId: 'seed-monday-kickoff',
    name: 'Monday morning kickoff',
    description: 'Asks what is on your plate at the start of the week.',
    agentSlug: 'clementine',
    trigger: 'schedule',
    schedule: '0 9 * * 1',
    questionTemplate: "Good morning. It's Monday — what are the top 1–3 things you want to ship this week, and is anything in the way before you start?",
    urgency: 'normal',
    cooldownHours: 20,
  },
  {
    seededId: 'seed-friday-wrap',
    name: 'Friday afternoon wrap-up',
    description: 'End-of-week check on what shipped vs what slipped.',
    agentSlug: 'clementine',
    trigger: 'schedule',
    schedule: '0 16 * * 5',
    questionTemplate: 'End of the week. What got done that you want recorded, what slipped, and what should I carry over to Monday?',
    urgency: 'normal',
    cooldownHours: 20,
  },
  {
    seededId: 'seed-blocked-execution',
    name: 'Stuck execution nudge',
    description: 'Fires when a tracked execution has been blocked for over a day.',
    agentSlug: 'clementine',
    trigger: 'execution_blocked',
    blockedHours: 24,
    questionTemplate: '{{summary}}. Most recent: "{{executionTitle}}" — blocker: "{{blocker}}". Want me to drop it, work around it, or escalate?',
    urgency: 'high',
    cooldownHours: 12,
  },
  {
    seededId: 'seed-goal-drift',
    name: 'Goal drift check',
    description: 'Surfaces goals that have not been touched in a week.',
    agentSlug: 'clementine',
    trigger: 'goal_stale',
    staleDays: 7,
    questionTemplate: '{{summary}}. Top stale goal: "{{goalTitle}}". Still active, or should I retire it / change scope?',
    urgency: 'normal',
    cooldownHours: 48,
  },
  {
    seededId: 'seed-inbox-backlog',
    name: 'Inbox triage',
    description: 'Asks for a pass when open check-ins pile up.',
    agentSlug: 'clementine',
    trigger: 'inbox_backed_up',
    inboxThreshold: 10,
    questionTemplate: 'You have {{count}} open check-ins waiting on you. Want a 5-minute triage pass — I can group them or dismiss the stale ones?',
    urgency: 'low',
    cooldownHours: 12,
  },
];

let seededOnce = false;

/**
 * Idempotent — only seeds when the templates directory is empty OR when
 * a specific seededId is missing. New install gets the full set; later
 * runs add only newly-added seeds without overwriting user edits.
 */
export function ensureSeedTemplates(): { created: string[]; skipped: string[] } {
  if (seededOnce) return { created: [], skipped: [] };
  seededOnce = true;
  ensureDir(TEMPLATES_DIR);
  const existing = listCheckInTemplates();
  const seededIds = new Set(existing.map((t) => t.seededId).filter(Boolean) as string[]);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const seed of SEED_TEMPLATES) {
    if (!seed.seededId) continue;
    if (seededIds.has(seed.seededId)) { skipped.push(seed.seededId); continue; }
    // Use seededId as the actual template id for stability.
    const template = createCheckInTemplate({ ...seed, enabled: false });
    created.push(template.id);
  }
  return { created, skipped };
}
