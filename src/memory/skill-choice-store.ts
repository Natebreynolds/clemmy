/**
 * Proven-skill memory: which STANDARD governs a task class the user repeats.
 *
 * The gap this closes (2026-07-31, live): skill selection was re-derived from
 * scratch on every single turn by lexical retrieval, so (a) an unlucky phrasing
 * silently lost the user's own standard, and (b) even a perfect match paid a
 * discovery round trip forever — the catalog scan and the read, every time. A
 * user's standards are the most repeated thing in their work; re-deriving them
 * per turn is the opposite of memory.
 *
 * The shape is deliberately the tool-choice memo's, because that primitive was
 * hardened for exactly this problem class: one file per intent, per machine,
 * an outcome ledger that lets retrieval prefer what actually works, and a
 * canonical invalidation path so a wrong standard can be retired without
 * deleting its history. What it does NOT share is the tool-choice NAMESPACE:
 * that store's records are dispatchable identifiers behind ~33 kind-branches,
 * and a skill is not a callable tool. Filing skills there risked a standard
 * being bound as a tool. Same discipline, separate drawer.
 *
 * Retrieval reuses the tool store's exported normalization (`wordTokens` /
 * `singularFold`) so plural tolerance and token folding behave identically
 * across both memories — one vocabulary, two drawers.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';
import { singularFold, wordTokens } from './tool-choice-store.js';

const SKILL_CHOICES_ROOT = path.join(BASE_DIR, 'memory', 'skill-choices');

/** A memo is only worth binding once the pairing has actually worked. */
export const SKILL_MEMO_MIN_SUCCESSES = 1;
/** Never-proven memos age out, mirroring the tool-memo reaper's window. */
export const DEAD_SKILL_MEMO_AGE_MS = 21 * 24 * 60 * 60 * 1000;

export interface SkillChoiceRecord {
  /** Task class this standard governs — a short slug, never a sentence. */
  intent: string;
  /** Installed skill name. Null once invalidated and not yet re-proven. */
  skill: string | null;
  successCount: number;
  failureCount: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  createdAt: string;
  /** Why it was retired, kept for inspection — retirement is never a delete. */
  invalidatedReason?: string;
  invalidatedAt?: string;
  filePath: string;
}

function machineDir(): string {
  return path.join(SKILL_CHOICES_ROOT, getMachineId());
}

function ensureMachineDir(): string {
  const dir = machineDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Task-class slugs stay SHORT and reusable. A pasted sentence is not a class:
 * it never matches a second time, so it is pure clutter that also crowds out
 * real memos (the tool store learned this the hard way — 61 sentence-slug
 * records had to be quarantined by hand).
 */
export function skillIntentSlugError(intent: string): string | null {
  const slug = (intent ?? '').trim();
  if (!slug) return 'intent is required — use a short task class like "outbound-email".';
  if (slug.length > 80) {
    return `intent "${slug.slice(0, 40)}…" is ${slug.length} chars — that is a sentence, not a task class. `
      + 'Use a short reusable slug (e.g. "outbound-email", "weekly-client-report").';
  }
  if (slug.split('-').length > 10) {
    return `intent "${slug.slice(0, 40)}…" has too many segments to ever match again. `
      + 'Use a short reusable slug (e.g. "outbound-email").';
  }
  return null;
}

export function normalizeSkillIntent(intent: string): string {
  return (intent ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function recordPath(intent: string): string {
  return path.join(ensureMachineDir(), `${normalizeSkillIntent(intent)}.json`);
}

function readRecord(filePath: string): SkillChoiceRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<SkillChoiceRecord>;
    if (!parsed || typeof parsed.intent !== 'string') return null;
    return {
      intent: parsed.intent,
      skill: typeof parsed.skill === 'string' ? parsed.skill : null,
      successCount: Number(parsed.successCount ?? 0),
      failureCount: Number(parsed.failureCount ?? 0),
      lastSuccessAt: parsed.lastSuccessAt,
      lastFailureAt: parsed.lastFailureAt,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      invalidatedReason: parsed.invalidatedReason,
      invalidatedAt: parsed.invalidatedAt,
      filePath,
    };
  } catch {
    return null;
  }
}

function writeRecord(record: SkillChoiceRecord): void {
  const { filePath, ...body } = record;
  writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf-8');
}

export function listSkillChoices(): SkillChoiceRecord[] {
  try {
    const dir = machineDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readRecord(path.join(dir, f)))
      .filter((r): r is SkillChoiceRecord => Boolean(r));
  } catch {
    return [];
  }
}

export function getSkillChoice(intent: string): SkillChoiceRecord | null {
  const file = path.join(machineDir(), `${normalizeSkillIntent(intent)}.json`);
  return existsSync(file) ? readRecord(file) : null;
}

/**
 * Record that `skill` governed `intent` on a run that actually worked. Evidence
 * accrues rather than overwriting: a pairing earns its authority. A DIFFERENT
 * skill for a known class resets the ledger — the new pairing must prove itself
 * on its own record, exactly like a changed tool identifier does.
 */
export function rememberSkillChoice(input: {
  intent: string;
  skill: string;
  nowIso?: string;
}): SkillChoiceRecord {
  const slugError = skillIntentSlugError(input.intent);
  if (slugError) throw new Error(slugError);
  const skill = (input.skill ?? '').trim();
  if (!skill) throw new Error('skill is required');
  const now = input.nowIso ?? new Date().toISOString();
  const intent = normalizeSkillIntent(input.intent);
  const existing = getSkillChoice(intent);
  const sameSkill = existing?.skill === skill;
  const record: SkillChoiceRecord = {
    intent,
    skill,
    successCount: sameSkill ? existing.successCount + 1 : 1,
    failureCount: sameSkill ? existing.failureCount : 0,
    lastSuccessAt: now,
    lastFailureAt: sameSkill ? existing.lastFailureAt : undefined,
    createdAt: existing?.createdAt ?? now,
    filePath: recordPath(intent),
  };
  writeRecord(record);
  return record;
}

/**
 * Retire a proven pairing. The record survives with its ledger and a reason so
 * the history stays inspectable — this is the ONLY supported retirement path,
 * because a hand-rolled overwrite elsewhere would resurrect the old choice from
 * whatever layer re-derives it (the tool store's exact trap).
 */
export function invalidateSkillChoice(intent: string, reason: string, nowIso?: string): boolean {
  const record = getSkillChoice(intent);
  if (!record || !record.skill) return false;
  writeRecord({
    ...record,
    skill: null,
    failureCount: record.failureCount + 1,
    lastFailureAt: nowIso ?? new Date().toISOString(),
    invalidatedReason: reason.slice(0, 300),
    invalidatedAt: nowIso ?? new Date().toISOString(),
  });
  return true;
}

export interface SkillChoiceMatch {
  record: SkillChoiceRecord;
  score: number;
  matchedTerms: string[];
}

/**
 * Find the proven standard for a request. Deliberately conservative: the class
 * slug's own words must appear in the request, because a memo that binds on one
 * weak overlap is worse than no memo — it would silently impose the wrong
 * standard, which is precisely the failure this whole layer exists to prevent.
 */
export function matchSkillChoices(request: string, limit = 2): SkillChoiceMatch[] {
  const requestTokens = wordTokens(request);
  if (requestTokens.size === 0) return [];
  const matches: SkillChoiceMatch[] = [];
  for (const record of listSkillChoices()) {
    if (!record.skill || record.successCount < SKILL_MEMO_MIN_SUCCESSES) continue;
    const intentTokens = [...new Set(
      record.intent.split('-').map(singularFold).filter((t) => t.length >= 3),
    )];
    if (intentTokens.length === 0) continue;
    const matched = intentTokens.filter((t) => requestTokens.has(t));
    // Every class word must be present for a single-word class; multi-word
    // classes need at least two, so "outbound-email" never binds on "email".
    const required = intentTokens.length === 1 ? 1 : 2;
    if (matched.length < required) continue;
    matches.push({
      record,
      score: matched.length * 10 + Math.min(20, record.successCount),
      matchedTerms: matched,
    });
  }
  return matches
    .sort((a, b) => b.score - a.score || b.record.successCount - a.record.successCount)
    .slice(0, Math.max(1, limit));
}

/**
 * One line naming the standard that governs this request, or ''. This is what
 * turns an invisible default into something the user can see and correct — and
 * it costs a single line instead of a discovery round trip.
 */
export function renderProvenSkillForPrompt(request: string): string {
  const [best] = matchSkillChoices(request, 1);
  if (!best?.record.skill) return '';
  const runs = best.record.successCount;
  return `Proven standard for this kind of work: \`${best.record.skill}\` `
    + `(worked ${runs} previous run${runs === 1 ? '' : 's'} for "${best.record.intent}"). `
    + `Load it with \`skill_read("${best.record.skill}")\` before producing the deliverable, and say which standard you are using. `
    + 'If it does not fit this request, ignore it and pick a better match.';
}

/** Retire memos that never proved out, so a bad guess cannot linger forever. */
export function reapDeadSkillChoices(nowMs = Date.now()): number {
  let reaped = 0;
  for (const record of listSkillChoices()) {
    if (!record.skill || record.successCount > 0) continue;
    const created = Date.parse(record.createdAt);
    if (!Number.isFinite(created) || nowMs - created < DEAD_SKILL_MEMO_AGE_MS) continue;
    if (invalidateSkillChoice(record.intent, 'auto-retired: never proven', new Date(nowMs).toISOString())) {
      reaped += 1;
    }
  }
  return reaped;
}
