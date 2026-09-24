import { createHash } from 'node:crypto';
import { getSession } from '../runtime/harness/eventlog.js';
import { publishProactiveOffer, type ProactiveOffer } from '../runtime/proactive-offers.js';
import { latestSkillLearningReceipt, loadSkill, skillLearningEvidenceStatus } from './skill-store.js';

/** Reuse the persisted distiller output and learning receipt. No synthesis,
 * no new session, and no invented audience for unattended/workflow origins. */
export function publishLearnedSkillOffer(name: string): ProactiveOffer | null {
  const skill = loadSkill(name);
  if (!skill || skill.frontmatter.tier !== 'draft'
    || skill.frontmatter.quarantined || skillLearningEvidenceStatus(skill) !== 'verified') return null;
  const receipt = latestSkillLearningReceipt(skill);
  if (!receipt) return null;
  const origin = getSession(receipt.sessionId);
  if (!origin || origin.kind !== 'chat' || !origin.userId) return null;
  const identity = createHash('sha256').update(JSON.stringify([origin.userId, name])).digest('hex');
  return publishProactiveOffer({
    id: `learned-skill-${identity}`,
    userId: origin.userId,
    kind: 'skill',
    title: `Review the ${name} skill`.slice(0, 200),
    summary: `I saved a draft skill from successful work: ${skill.frontmatter.description}`.slice(0, 4000),
    whyNow: 'The completed work produced a reusable procedure with a verified learning receipt. You can refine where it should apply.',
    evidenceRefs: [`skill:${name}`, `learning-source:${receipt.sourceId}`, `session:${receipt.sessionId}`],
    contextQuestion: 'Should this approach be a general preference, or stay specific to this work?',
    originSessionId: origin.id,
  });
}
