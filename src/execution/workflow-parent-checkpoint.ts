/** Immutable replay input for the parent of a sealed workflow group.
 * A checkpoint is context, never execution or effect authority. Recovery must
 * revalidate the source, group, current schemas and existing call ledger.
 */
import { createHash } from 'node:crypto';
import type { AgentInputItem } from '@openai/agents';
import type { boundAgentCapabilityEnvelope } from '../agents/capability-envelope.js';
import type { McpToolScope } from '../runtime/mcp-tool-scope.js';
import type { CapabilityBindingRevision } from '../runtime/graph/admission-envelope.js';
import type { AgentRebuildContext } from '../agents/agent-rebuild-context.js';
import { appendEvent, listEvents, openEventLog } from '../runtime/harness/eventlog.js';
import { readActiveWorkflowOriginGroup, workflowOriginSourceGroupId } from './workflow-origin-group.js';

export interface WorkflowParentCheckpoint {
  version: 1;
  sessionId: string;
  sourceUserSeq: number;
  sourceGroupId: string;
  history: AgentInputItem[];
  lastResponseId?: string;
  modelId?: string;
  envelope: NonNullable<ReturnType<typeof boundAgentCapabilityEnvelope>>;
  /** Selected schemas at handoff, not the entire admitted universe. Recovery
   * can revalidate this selection without rediscovering every acquired tool.
   * This historical revision must never be rebound as current authority. */
  bindingRevision?: CapabilityBindingRevision;
  rebuildContext?: AgentRebuildContext;
  mcpToolScope?: McpToolScope | null;
}

const EVENT = 'workflow_parent_checkpoint';
const digest = (value: WorkflowParentCheckpoint) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function exactSource(input: Pick<WorkflowParentCheckpoint,
  'sessionId' | 'sourceUserSeq' | 'sourceGroupId'>): boolean {
  const source = listEvents(input.sessionId, { sinceSeq: input.sourceUserSeq - 1,
    types: ['user_input_received'], limit: 1 })[0];
  if (source?.seq !== input.sourceUserSeq || source.role !== 'user' || source.data.synthetic === true) return false;
  return input.sourceGroupId === workflowOriginSourceGroupId(input);
}

function exactGroup(input: CheckpointIdentity): boolean {
  if (!exactSource(input)) return false;
  const group = readActiveWorkflowOriginGroup(input.sourceGroupId);
  return Boolean(group && group.sealed.originSessionId === input.sessionId
    && group.sealed.sourceUserSeq === input.sourceUserSeq
    && group.publicDispatch.sourceGroupDigest === input.sourceGroupDigest);
}

type CheckpointIdentity = Pick<WorkflowParentCheckpoint, 'sessionId' | 'sourceUserSeq' | 'sourceGroupId'>
  & { sourceGroupDigest: string };

export function readWorkflowParentCheckpoint(input: CheckpointIdentity): WorkflowParentCheckpoint | null {
  if (!exactGroup(input)) return null;
  const rows = listEvents(input.sessionId, { types: [EVENT] }).filter(event =>
    event.role === 'system' && event.data.sourceUserSeq === input.sourceUserSeq
    && event.data.sourceGroupId === input.sourceGroupId);
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const value = row.data.checkpoint as WorkflowParentCheckpoint | undefined;
  if (!value || value.version !== 1 || value.sessionId !== input.sessionId
    || value.sourceUserSeq !== input.sourceUserSeq || value.sourceGroupId !== input.sourceGroupId
    || !Array.isArray(value.history)
    || !value.envelope || row.data.digest !== digest(value)) return null;
  return value;
}

export function checkpointWorkflowParent(input: Omit<WorkflowParentCheckpoint, 'version'>): void {
  if (!exactSource(input)) throw new Error('workflow parent checkpoint has no exact accepted source');
  const checkpoint: WorkflowParentCheckpoint = { version: 1, ...input };
  const fingerprint = digest(checkpoint);
  openEventLog().transaction(() => {
    const prior = listEvents(input.sessionId, { types: [EVENT] }).filter(event =>
      event.data.sourceUserSeq === input.sourceUserSeq && event.data.sourceGroupId === input.sourceGroupId);
    if (prior.length) {
      if (prior.length !== 1 || prior[0]!.data.digest !== fingerprint
        || JSON.stringify(prior[0]!.data.checkpoint) !== JSON.stringify(checkpoint)) throw new Error('workflow parent checkpoint conflicts with its immutable predecessor');
      return;
    }
    appendEvent({ sessionId: input.sessionId, turn: 0, role: 'system', type: EVENT,
      data: { sourceUserSeq: input.sourceUserSeq, sourceGroupId: input.sourceGroupId,
        digest: fingerprint, checkpoint } });
  }).immediate();
}
