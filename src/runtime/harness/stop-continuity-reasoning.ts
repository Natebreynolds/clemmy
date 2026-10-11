/** Reasoning guidance for execution and for analysis of Stop/Continue cases.
 * Facts, control ownership and effect authority still come from their own
 * exact receipts; this text grants no new execution or recall authority.
 * Keep the full policy in authenticated continuation context and review;
 * the shorter shared rubric cue is not a replacement for those bindings. */
export const STOP_CONTINUITY_REASONING_GUIDANCE = [
  'STOP / CONTINUE REASONING: apply these distinctions both when executing and when explaining scenarios. Separate retained observations from current effects. Logical effect identity survives attempts and successors: keep settled successes; never repeat them merely because a new source, attempt or run exists.',
  'An uncertain effect remains unresolved without settlement of that exact prior operation, or a recorded provider idempotency contract covering the same operation, key, account and target. A same-key retry also requires current accepted-source authority and normal gates; a recorded key alone is not that contract. A fresh empty read or absent target alone does not prove that the prior operation never happened; missing rows or receipts are not no-dispatch proof. If unresolved, pause without repeating it.',
  'Before-dispatch Stop requires positive exact no-dispatch evidence, not inference from an absent record. That evidence proves no prior effect, not new permission: remaining work still needs the current accepted source and normal gates.',
  'Control follows exact session, accepted source, attempt and run ownership, not recency. A stale Stop must not stop a different active attempt. Resolve Continue from its durable parent-to-successor selector: repeated Continue rejoins the already admitted successor and its result rather than repeating work.',
  'Reuse retained reads only with their exact source/result digest bindings and same-principal current read authority. Showing all retained bytes does not establish exhaustive source coverage; unknown completeness stays unknown. Preserve the whole effective objective, standing instructions and contrary evidence; a settled effect alone does not prove whole-task completion.',
].join('\n');

/** General cue for every conversation brain; exact execution proofs are still
 * host-owned, and authenticated handoffs/reviews receive the full guide. */
export const STOP_CONTINUITY_RUBRIC_GUIDANCE =
  'STOP / CONTINUE — track logical effects across attempts. Reuse settled success; never replay it. Uncertain outcomes need exact-operation settlement or a recorded provider same-key/account/target idempotency contract plus current authority/gates; missing rows or empty targets prove neither non-dispatch nor safety. Repeated Continue rejoins its durable successor. Stop targets exact session/source/attempt/run, never recency.';
