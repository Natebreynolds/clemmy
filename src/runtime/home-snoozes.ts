/**
 * "Not now" on a decision: the item leaves Home for a while and stays pending
 * in Needs you. Declining is a separate, explicit choice — before this, "Not
 * now" on Home and in chat declined the item for good ("Declined — this won't
 * run"), which is not what the words say.
 *
 * Keys are the decision's own identity (`approval:<id>`, `plan:<id>`), so a
 * snooze from chat and a snooze from Home are the same snooze. Expired entries
 * are dropped on the next write; a snooze never changes the decision itself.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { BASE_DIR } from '../config.js';
import { atomicJsonMutate } from './atomic-json.js';

const SNOOZE_FILE = path.join(BASE_DIR, 'state', 'home-snoozes.json');

export const DEFAULT_SNOOZE_HOURS = 4;
const MAX_SNOOZE_HOURS = 72;

type SnoozeMap = Record<string, string>;

function readSnoozes(): SnoozeMap {
  if (!existsSync(SNOOZE_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(SNOOZE_FILE, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SnoozeMap : {};
  } catch {
    // Unreadable means nothing is snoozed; the item shows, which is the safe side.
    return {};
  }
}

export function isValidSnoozeKey(key: string): boolean {
  return /^(approval|plan):[A-Za-z0-9._:-]{1,160}$/.test(key);
}

/** Keys snoozed past `nowMs`. */
export function activeHomeSnoozes(nowMs = Date.now()): Map<string, string> {
  const active = new Map<string, string>();
  for (const [key, until] of Object.entries(readSnoozes())) {
    const untilMs = Date.parse(until);
    if (Number.isFinite(untilMs) && untilMs > nowMs) active.set(key, until);
  }
  return active;
}

export async function snoozeHomeItem(key: string, hours = DEFAULT_SNOOZE_HOURS, nowMs = Date.now()): Promise<string> {
  if (!isValidSnoozeKey(key)) throw new Error(`not a snoozable item: ${key}`);
  const clampedHours = Math.min(MAX_SNOOZE_HOURS, Math.max(0.25, Number.isFinite(hours) ? hours : DEFAULT_SNOOZE_HOURS));
  const until = new Date(nowMs + clampedHours * 3_600_000).toISOString();
  await atomicJsonMutate<SnoozeMap>(SNOOZE_FILE, (current) => {
    const next: SnoozeMap = {};
    for (const [existing, existingUntil] of Object.entries(current ?? {})) {
      if (Date.parse(existingUntil) > nowMs) next[existing] = existingUntil;
    }
    next[key] = until;
    return next;
  }, {});
  return until;
}
