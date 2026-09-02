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
  // A real SEND is a property of the operation, never of a label: the slug
  // predicate decides it and no declaration can downgrade it.
  if (isIrreversibleSendSlug(tool)) return 'send';
  const evidence = composioSlugEffectEvidence(tool);
  // Read evidence may be UPGRADED by a declared write/send — the author asks
  // for consent and a receipt on a call the verb says is a read. It becomes a
  // write: a label never fabricates a send (2026-07-20 draft trap — a stale
  // `send` on GMAIL_CREATE_DRAFT put draft creation behind the send gate).
  if (evidence === 'read') {
    return step.sideEffect === 'write' || step.sideEffect === 'send' ? 'write' : 'read';
  }
  // No verb evidence (noun-shaped slug such as SLACK_CONVERSATIONS_HISTORY):
  // an author-declared read is honoured. Everything else is a conservative write.
  if (evidence === 'unknown' && step.sideEffect === 'read') return 'read';
  return 'write';
}
