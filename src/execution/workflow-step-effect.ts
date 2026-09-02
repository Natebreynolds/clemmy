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
  // KNOWN slug evidence is authoritative in both directions: a real send is a
  // send whatever the label says, and a known read or reversible write is
  // never a send whatever the label says (a stale `send` on CREATE_DRAFT is
  // the 2026-07-20 draft trap). A label may strengthen a known read to a
  // write — the author knows their call. A read verb is never a send:
  // TWITTER_GET_POST reads a post; the send-slug regex alone read "POST" as
  // a send (2026-09-02). Only an UNKNOWN carrier (a dynamic multiplexer)
  // takes the label at face value, so a declared send reaches the send gate
  // and is refused there as direct_send_tool_required.
  const evidence = composioSlugEffectEvidence(tool);
  if (evidence === 'read') return declared === 'write' || declared === 'send' ? 'write' : 'read';
  if (isIrreversibleSendSlug(tool)) return 'send';
  if (evidence === 'write') return 'write';
  if (declared === 'read') return 'read';
  if (declared === 'send') return 'send';
  return 'write';
}
