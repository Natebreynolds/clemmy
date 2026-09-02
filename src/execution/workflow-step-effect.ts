/**
 * THE ONE structured-call side-effect classifier for workflow steps.
 *
 * Two copies of this decision lived in workflow-validator.ts (exported, used
 * by the runner for partition/send/expectedEffect) and workflow-enforce.ts
 * (private, feeding classifyStepSideEffect → dashboards, dry run, crash
 * resume, loop eligibility). They disagreed on one input: a read-evidence
 * slug the author declared write/send. The validator let the declaration
 * upgrade it (consent, receipt); enforce ignored the declaration (safe to
 * re-run on crash, loop-eligible) — both, in different places, on the same
 * step (census 2026-09-01, D3). One definition, the conservative one.
 *
 * Order: a real SEND slug (the irreversible-send predicate) is a send and no
 * declaration can downgrade it; a declaration can never fabricate a send;
 * read evidence may be upgraded to a write by a declared write/send; no verb
 * evidence (noun-shaped slug such as SLACK_CONVERSATIONS_HISTORY) honours a
 * declared read; everything else is a conservative write. `send` is a risk
 * consequence of the operation, not a label.
 */
import { composioSlugEffectEvidence } from '../integrations/composio/slug-effect.js';
import { isIrreversibleSendSlug } from '../runtime/harness/execution-gate.js';

export type StructuredCallSideEffectClass = 'read' | 'write' | 'send';

export function structuredCallSideEffectClass(step: {
  call?: { tool?: string } | undefined;
  sideEffect?: string | undefined;
}): StructuredCallSideEffectClass {
  const tool = step.call?.tool ?? '';
  const declared = step.sideEffect === 'read' || step.sideEffect === 'write' || step.sideEffect === 'send'
    ? step.sideEffect
    : undefined;
  // The slug's evidence is the FLOOR; an author's label can only strengthen it
  // (read → write → send), never downgrade it. A read verb is never a send —
  // TWITTER_GET_POST reads a post; the send-slug regex alone read "POST" as a
  // send (2026-09-02). A declared send on a non-send tool is still classified
  // send so the send gate sees it and refuses it as direct_send_tool_required
  // at validation — the author relabels; nothing crosses.
  const evidence = composioSlugEffectEvidence(tool);
  const floor: 'read' | 'write' | 'send' | 'unknown' = evidence === 'read'
    ? 'read'
    : isIrreversibleSendSlug(tool)
      ? 'send'
      : evidence === 'unknown'
        ? 'unknown'
        : 'write';
  if (floor === 'send' || declared === 'send') return 'send';
  if (floor === 'write') return 'write';
  if (floor === 'read') return declared === 'write' ? 'write' : 'read';
  return declared === 'read' ? 'read' : 'write';
}
