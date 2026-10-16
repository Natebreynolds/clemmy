import { readWorkflow } from '../memory/workflow-store.js';
import {
  normalizedWorkflowConversationBinding,
  workflowConversationSlugFromSessionId,
  WORKFLOW_CONVERSATION_SESSION_PREFIX,
  type WorkflowConversationBinding,
} from '../shared/workflow-conversation.js';

export const WORKFLOW_CONVERSATION_CONTEXT_PREFIX = '[workflow-conversation]';
export const WORKFLOW_CONVERSATION_TOOLS = [
  'workflow_get', 'workflow_edit_step', 'workflow_update', 'workflow_revert_step',
  'workflow_run_status', 'workflow_set_enabled', 'workflow_run',
] as const;
export const WORKFLOW_CONVERSATION_HOT_TOOLS = ['workflow_get', 'workflow_edit_step'] as const;

/** Dedicated host metadata survives a conversation successor, never a run id. */
export function workflowConversationBindingForSession(
  sessionId: string,
  metadata?: Record<string, unknown> | null,
): WorkflowConversationBinding | null {
  const directSlug = workflowConversationSlugFromSessionId(sessionId);
  if (sessionId.startsWith(WORKFLOW_CONVERSATION_SESSION_PREFIX) && !directSlug) {
    throw new Error('This workflow conversation has an invalid identity. Open the workflow again.');
  }
  const raw = metadata?.__workflow_conversation;
  const retained = raw === undefined ? null : normalizedWorkflowConversationBinding(raw);
  if (raw !== undefined && !retained) {
    throw new Error('This workflow conversation has an invalid saved binding. Open the workflow again.');
  }
  if (directSlug && retained && retained.workflowSlug !== directSlug) {
    throw new Error('This conversation is bound to a different workflow. Open the workflow again.');
  }
  const rawBranch = metadata?.__accepted_source_branch;
  const branch = rawBranch && typeof rawBranch === 'object' && !Array.isArray(rawBranch)
    ? rawBranch as Record<string, unknown> : null;
  const canonicalRootSlug = branch?.version === 1 && typeof branch.rootSessionId === 'string'
    ? workflowConversationSlugFromSessionId(branch.rootSessionId) : null;
  if (canonicalRootSlug && retained && retained.workflowSlug !== canonicalRootSlug) {
    throw new Error('This conversation is bound to a different workflow. Open the workflow again.');
  }
  return retained ?? (directSlug ? { version: 1, rootSessionId: sessionId, workflowSlug: directSlug } : null);
}

/** Exact local catalog lookup only; a removed workflow never becomes a fuzzy match. */
export function requireWorkflowConversationTarget(binding: WorkflowConversationBinding): void {
  const checked = normalizedWorkflowConversationBinding(binding);
  if (!checked || !readWorkflow(checked.workflowSlug)) {
    throw new Error('This workflow is no longer available. Open an existing workflow to continue; this conversation is kept.');
  }
}

export function workflowConversationPrimer(binding: WorkflowConversationBinding): string {
  if (!normalizedWorkflowConversationBinding(binding)) throw new Error('Invalid workflow conversation binding.');
  const slug = JSON.stringify(binding.workflowSlug);
  return [
    `${WORKFLOW_CONVERSATION_CONTEXT_PREFIX} This is the ongoing conversation about the selected workflow with exact saved slug ${slug}. It is an editing conversation, not an executing workflow run. Unqualified references to “this workflow” mean this exact object; do not select a different workflow by a similar display name. This binding preserves conversation identity, not proof that the definition still exists. If a current native read says it is unavailable, say so; do not recreate it or substitute another workflow.`,
    `Inspect current saved contents through workflow_get(name=${slug}, section="metadata") for a bounded overview, or step="<id>" for the affected step. Read the full definition only when the change needs it. Reuse exact current information already read in this turn; before an edit, inspect the affected saved definition and preserve unrelated steps, resources, model pins and standing requirements. Do not treat older chat descriptions as the current definition.`,
    'For one step use workflow_edit_step; use workflow_update for a workflow-level change. Persist through native workflow tools, never a scratch file. The workflow-builder skill is available through skill_read when authoring or redesign needs its procedure. Use current connected tools and accounts; this conversation grants no tool, account, provider, send, execution or approval authority.',
    'A saved edit, queued test, enabled flag and accepted run are different facts. Report the native tool’s actual saved/test/run result, keep blocked or uncertain effects explicit, and do not run or enable a workflow merely because the user asked about it. Continue the existing exact approval or Stop/recovery path rather than replaying writes or starting a replacement run.',
  ].join('\n\n');
}
