/** The completion caller's existing output obligations. These flags come from
 * host review context, never from words in the review or retained tool data. */
export interface CompletionVerdictRepairContract {
  evidenceCoverage: boolean;
  memoryRequirement: boolean;
}

/** Completion's extra lines must not conflict with the generic system rule
 * that a verdict occupies exactly one line. No source data enters this rule. */
export function judgeVerdictRepairInstructions(
  instructions: string,
  completion?: CompletionVerdictRepairContract,
): string {
  if (!completion?.evidenceCoverage && !completion?.memoryRequirement) return instructions;
  return `${instructions}\n\nCOMPLETION VERDICT RESTATEMENT OUTPUT: The earlier one-line rule applies to the verdict line. In this restatement also emit${completion.evidenceCoverage ? ' the required NEEDS ALL OF line after DONE' : ''}${completion.evidenceCoverage && completion.memoryRequirement ? ' and' : ''}${completion.memoryRequirement ? ' the required MEMORY_REQUIREMENT JSON line' : ''}, in the same answer. These lines restate the original review; they do not establish new evidence or waive missing proof.`;
}

/** Restate the review already written, without a second evidence review.
 * Generic progress/checklist callers retain their original one-line grammar. */
export function judgeVerdictRepairPrompt(
  completeReview: string,
  completion?: CompletionVerdictRepairContract,
): string {
  const required = completion?.evidenceCoverage || completion?.memoryRequirement;
  return [
    'You already reviewed a response and wrote the review below, but it did not contain the required verdict line.',
    'Do not review again. From your own review, state the verdict now.',
    '',
    '[YOUR REVIEW]',
    completeReview,
    '[/YOUR REVIEW]',
    '',
    ...(required ? [
      'Reply with the verdict line in the format your instructions require, followed only by the required contract lines below, all in this same answer.',
      'Restate only conclusions and evidence bindings your complete review already established. Do not invent observations, inspected scopes, source refs, correction targets, digests or edits. If the review did not establish enough to accept completion, state INCOMPLETE with the missing evidence instead of DONE.',
      ...(completion?.evidenceCoverage ? [
        'After a DONE verdict, add exactly one line: NEEDS ALL OF: <exact result refs>, or NEEDS ALL OF: none only when the verdict rests on the inspected selection without any absence or whole-result claim.',
        'Use the exact refs and inspection scope established by your review. Omitted content remains uninspected; omitting it from this restatement never establishes coverage. If the required scope cannot be recovered from your review, report that evidence gap instead of accepting completion.',
      ] : []),
      ...(completion?.memoryRequirement ? [
        'Add exactly one separate MEMORY_REQUIREMENT: line containing the JSON assessment required by your existing memory contract. Preserve its exact established correction bindings. If a required correction target or edit was not established, use unresolved with an empty corrections array, never invent a binding or waive the correction.',
      ] : []),
    ] : ['Reply with EXACTLY ONE LINE and nothing else, in the verdict format your instructions require.']),
  ].join('\n');
}
