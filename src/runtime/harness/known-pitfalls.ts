/**
 * Pre-flight ERROR LIBRARY — surface "last time this failed because X" BEFORE
 * the model acts, instead of after it repeats the mistake.
 *
 * The lessons already exist: skill-distiller mints recovery tips from
 * failed-then-corrected trajectories and the improvement proposer appends
 * observed pitfalls — both land in a skill's "## Pitfalls (observed)" section.
 * But that text was only reachable through an on-demand skill_read, so a turn
 * that never loaded the skill repeated the known mistake. This module extracts
 * the freshest pitfall lines for the skills a turn is likely to use, bounded
 * hard (a warning line, not a context dump). Consumed by BOTH lanes: the
 * context packet (Codex/orchestrator) and the Claude brain turn context.
 */
import { loadSkill } from '../../memory/skill-store.js';

const PITFALL_HEADING_RE = /^##\s+Pitfalls\b/i;
const MAX_LINE_CHARS = 200;

/** Bullet lines under a "## Pitfalls" heading, oldest→newest (append order). */
export function extractPitfallLines(body: string): string[] {
  const lines = body.split('\n');
  const out: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (PITFALL_HEADING_RE.test(line)) { inSection = true; continue; }
    if (inSection && /^#{1,6}\s/.test(line)) { inSection = false; continue; }
    if (inSection && line.startsWith('- ')) {
      const text = line.slice(2).trim();
      if (text) out.push(text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS - 1)}…` : text);
    }
  }
  return out;
}

/**
 * One bounded "Known pitfalls" block for the given (already-ranked) skills, or
 * null when none of them carry lessons. Newest lessons win (they reflect the
 * current tool/data reality); at most `maxLines` total so this stays a nudge.
 */
export function pitfallsForSkills(
  skillNames: string[],
  opts: { maxSkills?: number; maxLines?: number } = {},
): string | null {
  const maxSkills = opts.maxSkills ?? 2;
  const maxLines = opts.maxLines ?? 2;
  const collected: string[] = [];
  try {
    for (const name of skillNames.slice(0, maxSkills)) {
      if (collected.length >= maxLines) break;
      let body = '';
      try { body = loadSkill(name)?.body ?? ''; } catch { continue; }
      if (!body) continue;
      const pitfalls = extractPitfallLines(body);
      for (const line of pitfalls.slice(-maxLines).reverse()) {
        if (collected.length >= maxLines) break;
        collected.push(`- [${name}] ${line}`);
      }
    }
  } catch { return null; }
  if (collected.length === 0) return null;
  return `Known pitfalls (learned from past failures — avoid repeating them):\n${collected.join('\n')}`;
}
