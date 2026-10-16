/** A conversation about a saved workflow, never a workflow execution session. */
export const WORKFLOW_CONVERSATION_SESSION_PREFIX = 'workflow-edit:';

export interface WorkflowConversationBinding {
  version: 1;
  rootSessionId: string;
  workflowSlug: string;
}

export function workflowConversationSessionId(workflowName: string): string | null {
  if (typeof workflowName !== 'string' || !workflowName || workflowName !== workflowName.trim()
    || workflowName === '.' || workflowName === '..' || /[/\\\u0000-\u001f\u007f]/.test(workflowName)) return null;
  try {
    const id = `${WORKFLOW_CONVERSATION_SESSION_PREFIX}${encodeURIComponent(workflowName)}`;
    return id.length <= 512 ? id : null;
  } catch { return null; }
}

export function workflowConversationSlugFromSessionId(sessionId: string): string | null {
  if (!sessionId.startsWith(WORKFLOW_CONVERSATION_SESSION_PREFIX)) return null;
  try {
    const slug = decodeURIComponent(sessionId.slice(WORKFLOW_CONVERSATION_SESSION_PREFIX.length));
    return workflowConversationSessionId(slug) === sessionId ? slug : null;
  } catch { return null; }
}

export function normalizedWorkflowConversationBinding(value: unknown): WorkflowConversationBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const binding = value as Partial<WorkflowConversationBinding>;
  if (binding.version !== 1 || typeof binding.workflowSlug !== 'string'
    || typeof binding.rootSessionId !== 'string'
    || workflowConversationSessionId(binding.workflowSlug) !== binding.rootSessionId) return null;
  return { version: 1, rootSessionId: binding.rootSessionId, workflowSlug: binding.workflowSlug };
}
