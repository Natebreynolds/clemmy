/**
 * Set up next: the one part of Clementine Clem offers to help set up, from
 * what is actually set up right now.
 *
 * Something set up but broken comes first; then the parts that unlock the most
 * for a new owner. One suggestion at a time, so Home never turns into a
 * checklist. The owner can open its place, ask Clem to walk them through it,
 * move it to later or say never; a part that becomes set up simply stops
 * being suggested.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../tools/shared.js';
import type { AppAbility } from '../runtime/app-guide/abilities.js';
import { APP_PLACES } from '../runtime/app-guide/app-places.js';

export interface FromClemSetup {
  ability: string;
  name: string;
  unlocks: string;
  detail: string;
  state: 'not_set_up' | 'needs_attention';
  place: string;
  placeName: string;
  /** When Clem first suggested it: a stable time, so her words are written once. */
  since: string;
}

/** The order a new owner gains the most from. Adding your own tool servers
 *  is offered only when one stops answering. */
const SUGGEST_ORDER = ['brain', 'second-model', 'phone', 'phone-alerts', 'meetings', 'apps', 'calendar-watch', 'jev'];

export function pickSetupSuggestion(
  abilities: readonly AppAbility[],
  hidden: (key: string) => boolean,
): AppAbility | null {
  const open = abilities.filter((ability) => !hidden(setupRowKey(ability.id)));
  const broken = open.find((ability) => ability.state === 'needs_attention');
  if (broken) return broken;
  for (const id of SUGGEST_ORDER) {
    const missing = open.find((ability) => ability.id === id && ability.state === 'not_set_up');
    if (missing) return missing;
  }
  return null;
}

export function setupRowKey(abilityId: string): string {
  return `setup:${abilityId}`;
}

const SETUP_FILE = path.join(BASE_DIR, 'state', 'from-clem-setup.json');

function loadFirstSeen(): Record<string, string> {
  try {
    if (!existsSync(SETUP_FILE)) return {};
    const raw = JSON.parse(readFileSync(SETUP_FILE, 'utf-8')) as { version?: number; first?: Record<string, string> };
    return raw.version === 1 && raw.first && typeof raw.first === 'object' ? raw.first : {};
  } catch {
    return {};
  }
}

function rememberFirstSeen(abilityId: string, at: string): string {
  const first = loadFirstSeen();
  if (first[abilityId]) return first[abilityId]!;
  first[abilityId] = at;
  try {
    mkdirSync(path.dirname(SETUP_FILE), { recursive: true });
    const tmp = `${SETUP_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, first }, null, 2));
    renameSync(tmp, SETUP_FILE);
  } catch { /* the suggestion still shows; its words may be written again */ }
  return at;
}

const ABILITIES_TTL_MS = 5 * 60_000;
let cached: { at: number; abilities: AppAbility[] } | null = null;

/** The live setup state, read at most every few minutes: Home polls often and
 *  each read touches several stores. */
async function currentAbilities(nowMs: number): Promise<AppAbility[]> {
  if (cached && nowMs - cached.at < ABILITIES_TTL_MS) return cached.abilities;
  const { appAbilitiesFromFacts, readAppAbilityFacts } = await import('../runtime/app-guide/abilities.js');
  const abilities = appAbilitiesFromFacts(await readAppAbilityFacts());
  cached = { at: nowMs, abilities };
  return abilities;
}

export async function readSetupSuggestion(
  hidden: (key: string) => boolean,
  nowMs = Date.now(),
): Promise<FromClemSetup | null> {
  let abilities: AppAbility[];
  try { abilities = await currentAbilities(nowMs); } catch { return null; }
  const pick = pickSetupSuggestion(abilities, hidden);
  if (!pick || (pick.state !== 'not_set_up' && pick.state !== 'needs_attention')) return null;
  const place = APP_PLACES.find((row) => row.id === pick.place);
  return {
    ability: pick.id, name: pick.name, unlocks: pick.unlocks, detail: pick.detail, state: pick.state,
    place: pick.place, placeName: place?.name ?? pick.place,
    since: rememberFirstSeen(`${pick.id}:${pick.state}`, new Date(nowMs).toISOString()),
  };
}

export function _resetSetupSuggestionCacheForTests(): void {
  cached = null;
}
