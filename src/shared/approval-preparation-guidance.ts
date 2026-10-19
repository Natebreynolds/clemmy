/** One model-facing preparation contract; it grants no execution authority. */
export const FORMAL_APPROVAL_PREPARATION_GUIDANCE =
  'Prepared formal card: discover missing `pending_action_queue` schema; queue exact payload with `approvalIntent:"request_now"` before execution or a generic approval question.';

export const SEALED_APPROVAL_GUIDANCE =
  'Already sealed work stays on `work_call`; never queue it again. The host validates consent.';

export const CLARIFICATION_APPROVAL_GUIDANCE =
  'This question tool gathers missing facts or choices; it does not create a formal execution card or grant execution consent. '
  + FORMAL_APPROVAL_PREPARATION_GUIDANCE + ' ' + SEALED_APPROVAL_GUIDANCE;
