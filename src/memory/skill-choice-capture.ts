/**
 * Turn a working run into a proven standard — the write half of skill memory.
 *
 * The class key is DERIVED FROM EVIDENCE, never invented: it is the overlap
 * between the user's request and the skill's own declared vocabulary, which is
 * exactly what made the skill a candidate in the first place. That matters
 * because slugs minted from raw user prose never match a second time and become
 * permanent clutter (the tool store had to quarantine 61 such records by hand).
 * Deriving from the shared vocabulary keeps the key short, stable across
 * phrasings, and meaningful to a human reading the file.
 *
 * Conservative by construction: exactly one skill loaded (two loaded skills give
 * no evidence about which one governed), the skill must have been a retrieval
 * candidate for THIS request, and the turn must have done real work. A memo
 * asserts "this standard worked here" — anything weaker would impose the wrong
 * standard on every future run of the class, which is worse than no memory.
 */
import { findRelevantSkills } from './skill-store.js';
import { rememberSkillChoice, skillIntentSlugError } from './skill-choice-store.js';

/** Class-key words are the request∩skill overlap, longest-first, capped so the
 *  slug stays a class ("outbound-email") and never becomes a sentence. */
export const MAX_CLASS_TOKENS = 3;

export function deriveSkillClassKey(request: string, skillName: string): string | null {
  let matches: ReturnType<typeof findRelevantSkills> = [];
  try {
    matches = findRelevantSkills(request, { maxSkills: 8 });
  } catch {
    return null;
  }
  const hit = matches.find((m) => m.skill.name === skillName);
  if (!hit) return null;
  const tokens = [...new Set(hit.matchedTerms)]
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, MAX_CLASS_TOKENS)
    .sort();
  if (tokens.length === 0) return null;
  const slug = tokens.join('-');
  return skillIntentSlugError(slug) ? null : slug;
}

export interface CaptureProvenSkillInput {
  request: string;
  /** Skills whose bodies were actually loaded this turn. */
  loadedSkillNames: string[];
  /** True only when the turn did real work and reached a clean end. */
  workingRun: boolean;
  nowIso?: string;
}

/** Returns the class key it recorded, or null. Never throws. */
export function captureProvenSkill(input: CaptureProvenSkillInput): string | null {
  try {
    if (!input.workingRun) return null;
    const loaded = [...new Set(input.loadedSkillNames.filter(Boolean))];
    if (loaded.length !== 1) return null;
    const skillName = loaded[0];
    const intent = deriveSkillClassKey(input.request, skillName);
    if (!intent) return null;
    rememberSkillChoice({ intent, skill: skillName, nowIso: input.nowIso });
    return intent;
  } catch {
    return null;
  }
}
