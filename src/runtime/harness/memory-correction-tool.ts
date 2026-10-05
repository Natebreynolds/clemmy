import { z } from 'zod';
import { applyExactFactPatches } from '../../memory/fact-observation.js';
import { correctFactExact } from '../../memory/fact-correction.js';
import { reviewFactCorrection } from '../../memory/fact-correction-review.js';
import { sameScope } from '../../memory/memory-scope.js';
import { currentLogicalCall } from './attempt-identity.js';
import { openEventLog } from './eventlog.js';
import { assertDispatchLeaseCurrent, currentDispatchLease } from './dispatch-lease.js';
import { getToolOutputContext } from './tool-output-context.js';
import { retainedFactObservation } from './memory-fact-read-evidence.js';
import { findRetainedCorrectionAssessment, intakeReplacementsForSource, readMemoryRequirementSource,
  retainMemoryRequirementAssessment } from './memory-completion-obligation.js';

export const memoryCorrectionInputSchema = z.object({
  readCallId: z.string().min(1).max(256),
  expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  edits: z.array(z.object({ before: z.string().min(1).max(20_000), after: z.string().max(20_000) }).strict()).min(1).max(8),
}).strict();

export type MemoryCorrectionInput = z.infer<typeof memoryCorrectionInputSchema>;

/** The existing logical-call ledger owns invocation/replay. Memory owns the
 * atomic old/new state and its exact-source evidence; neither a read nor a
 * caller-supplied fact id grants permission to change a standing record. */
export async function executeMemoryCorrection(input: {
  kind: string; content: string; correct: MemoryCorrectionInput;
  keepFor?: 'everywhere' | 'here';
}) {
  const context = getToolOutputContext();
  const logical = currentLogicalCall();
  const lease = currentDispatchLease();
  if (!context?.sessionId || !context.sourceUserSeq || !logical || !lease) {
    throw new Error('Correct this memory from its active conversation so the owner request and read can be verified.');
  }
  const identity = { sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq };
  const source = readMemoryRequirementSource(identity);
  if (!source || source.acceptedTaskId !== logical.acceptedTaskId) {
    throw new Error('The exact owner request and its original project context are unavailable.');
  }
  const call = openEventLog().prepare(`SELECT argument_digest FROM logical_tool_calls
    WHERE session_id = ? AND source_user_seq = ? AND accepted_task_id = ?
      AND logical_tool_call_id = ? AND tool_name = 'memory_remember' AND state = 'open'`)
    .get(identity.sessionId, identity.sourceUserSeq, logical.acceptedTaskId, logical.logicalToolCallId) as
      { argument_digest: string } | undefined;
  if (!call?.argument_digest) throw new Error('The correction has no admitted exact logical call.');
  const observation = retainedFactObservation({ ...identity, acceptedTaskId: logical.acceptedTaskId,
    readCallId: input.correct.readCallId });
  if (observation.digest !== input.correct.expectedDigest || observation.kind !== input.kind) {
    throw new Error('The target version or kind differs from the original read. Reopen the fact before correcting it.');
  }
  // The owner's message itself already replaced this fact when it was saved.
  const applied = intakeReplacementsForSource(identity).find(row => row.replaced.id === observation.id);
  if (applied) {
    return { status: 'already_in_effect' as const, reason: `Already in effect: when this message was saved, fact ${applied.replaced.id} was replaced by fact ${applied.by.id} ("${applied.by.content}") in the same scope. Nothing further to change.` };
  }
  if (input.keepFor && !sameScope(observation.scope,
    input.keepFor === 'everywhere' ? null : source.memoryScope)) {
    throw new Error('A correction retains the original stored scope. Omit keepFor; a scope move is a separate request.');
  }
  const replacement = applyExactFactPatches(observation.content, input.correct.edits);
  if (replacement.content !== input.content) {
    throw new Error('content must equal the exact edited original, preserving every unchanged part.');
  }
  let assessment = findRetainedCorrectionAssessment(source, input.correct);
  if (!assessment) {
    const review = await reviewFactCorrection({ ownerText: source.ownerText,
      currentContext: source.memoryScope, observation, edits: input.correct.edits,
      replacementContent: replacement.content });
    if (review.decision !== 'entailed') {
      throw new Error(`The requested correction is not established: ${review.reason}`);
    }
    assessment = retainMemoryRequirementAssessment({ source,
      assessment: { version: 1, kind: 'correct', corrections: [input.correct], reason: review.reason },
      review: { phase: 'prewrite', failedOpen: false, ownerQuote: review.ownerQuote ?? undefined,
        provenance: 'Configured memory boundary review; provider wire identity is not attested by this receipt.' } });
  }
  // The independent review awaited a provider. Reopen the same accepted source
  // and check cancellation before entering the synchronous memory transaction.
  const assertCurrent = () => {
    assertDispatchLeaseCurrent(lease);
    const fresh = readMemoryRequirementSource(identity);
    if (!fresh || fresh.sourceEventId !== source.sourceEventId
      || fresh.sourceContextDigest !== source.sourceContextDigest
      || fresh.objectiveDigest !== source.objectiveDigest) {
      throw new Error('The owner request or project context changed during correction review.');
    }
  };
  assertCurrent();
  return correctFactExact({ targetId: observation.id, expectedObservationDigest: observation.digest,
    patches: input.correct.edits, allowProtectedCorrection: true, assertCurrent,
    owner: { ...identity, sourceEventId: source.sourceEventId,
      sourceContextDigest: source.sourceContextDigest, logicalToolCallId: logical.logicalToolCallId,
      argumentsDigest: call.argument_digest, ownerText: source.ownerText,
      occurredAt: source.occurredAt, assessmentDigest: assessment.assessmentDigest } });
}
