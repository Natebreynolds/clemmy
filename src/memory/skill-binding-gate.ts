/**
 * Binding load: a PROVEN standard must be in hand before bulk irreversible work.
 *
 * The failure this closes (2026-07-31, live): a user asked for fifty follow-up
 * emails; retrieval offered his standard only as a suggestion the model was free
 * to ignore, and fifty off-standard messages were produced in one pass. One bad
 * message is a correction; fifty is a trust event. Scale is what turns a soft
 * default into something that must actually hold.
 *
 * Deliberately narrow, on three axes, because a gate that fires wrongly is worse
 * than the defect it prevents:
 *
 *  - Only a PROVEN memo qualifies (a pairing that already worked). A fresh
 *    lexical guess is a suggestion and stays one — retrieval noise must never
 *    be able to hold a user's work.
 *  - Only BULK irreversible plans (write/send batches). Single writes keep their
 *    existing completion-time floor; the conversational beat covers intent.
 *  - It is ESCAPABLE from its own text by the weakest model: it names the exact
 *    skill and the exact call, and it clears permanently for the session the
 *    moment the skill is read. One extra call, never a stall.
 */
import { matchSkillChoices } from './skill-choice-store.js';
import { gatherSessionSkills } from '../runtime/harness/skill-execution.js';

export interface SkillBindingHold {
  skill: string;
  intent: string;
  successCount: number;
  message: string;
}

/**
 * Returns a hold when a proven standard governs this work and has NOT been
 * loaded in this session; null otherwise. Never throws — a bug in standards
 * enforcement must never block real work (fail-open, like every other floor).
 */
export function skillBindingHold(input: {
  sessionId: string;
  /** The batch's objective / the request being executed. */
  objective: string;
  /** True only for irreversible bulk work (write/send batches). */
  bulkIrreversible: boolean;
  itemCount?: number;
}): SkillBindingHold | null {
  try {
    if (!input.bulkIrreversible) return null;
    const objective = (input.objective ?? '').trim();
    if (!objective) return null;
    const [best] = matchSkillChoices(objective, 1);
    const skill = best?.record.skill;
    if (!skill) return null;
    const loaded = new Set(gatherSessionSkills(input.sessionId).map((s) => s.name));
    if (loaded.has(skill)) return null;
    const runs = best.record.successCount;
    const scale = input.itemCount && input.itemCount > 1 ? `${input.itemCount} items` : 'this batch';
    return {
      skill,
      intent: best.record.intent,
      successCount: runs,
      message:
        `Load the proven standard before running ${scale}. \`${skill}\` has governed "${best.record.intent}" `
        + `work ${runs} time${runs === 1 ? '' : 's'} and was NOT loaded in this session, so these payloads were `
        + 'built without it — at this scale that multiplies one deviation across every item. '
        + `Call \`skill_read("${skill}")\`, apply it to the payloads, then re-propose. `
        + `If it genuinely does not apply here, say so in your reply and re-propose unchanged — this check clears once the skill is read.`,
    };
  } catch {
    return null;
  }
}
