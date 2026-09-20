import type { WorkflowTransformV1 } from '../memory/workflow-store.js';
import {
  executeWorkflowTransform,
  validateWorkflowTransform,
  WORKFLOW_TRANSFORM_MAX_SPEC_BYTES,
  WORKFLOW_TRANSFORM_MAX_VALUE_BYTES,
} from '../execution/workflow-transform.js';

export interface SpaceSourceTransform {
  id: string;
  transform: WorkflowTransformV1;
}

/** A pure pipeline over this read only. No workflow calls, model steps, or
 * access to other sources; the final output is the shared desktop/phone data. */
export function parseSpaceSourceTransforms(raw: unknown): SpaceSourceTransform[] {
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > WORKFLOW_TRANSFORM_MAX_SPEC_BYTES) {
    throw new Error('source transforms must be JSON within 64 KiB');
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new Error('source transforms must contain 1-16 steps');
  }
  const prior = new Set(['read']);
  return value.map((step) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)
      || Object.keys(step).some((key) => key !== 'id' && key !== 'transform')) {
      throw new Error('each source transform must contain only id and transform');
    }
    if (typeof step.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,59}$/.test(step.id)
      || ['__proto__', 'prototype', 'constructor'].includes(step.id) || prior.has(step.id)) {
      throw new Error('source transform IDs must be unique safe names; read is reserved');
    }
    const validation = validateWorkflowTransform(step.transform);
    if (!validation.ok) throw new Error(validation.errors.join(' '));
    for (const ref of validation.references) {
      if (ref.kind === 'input' && ref.source !== 'input.observed_at') {
        throw new Error('source transforms only expose input.observed_at');
      }
      if (ref.kind === 'step' && !prior.has(ref.stepId!)) {
        throw new Error(`source transform "${step.id}" refers to unavailable step "${ref.stepId}"`);
      }
    }
    prior.add(step.id);
    return { id: step.id, transform: validation.transform };
  });
}

export function transformSpaceSourceData(raw: unknown, data: unknown, observedAt: string): unknown {
  const steps = parseSpaceSourceTransforms(raw);
  const outputs: Record<string, unknown> = Object.create(null);
  outputs.read = data;
  let bytes = Buffer.byteLength(JSON.stringify(data) ?? '');
  if (bytes > WORKFLOW_TRANSFORM_MAX_VALUE_BYTES) throw new Error('source transform input exceeds 64 MiB');
  let result = data;
  for (const step of steps) {
    result = executeWorkflowTransform({ transform: step.transform, inputs: { observed_at: observedAt }, stepOutputs: outputs });
    bytes += Buffer.byteLength(JSON.stringify(result));
    if (bytes > WORKFLOW_TRANSFORM_MAX_VALUE_BYTES) throw new Error('source transform pipeline retained data exceeds 64 MiB');
    outputs[step.id] = result;
  }
  return result;
}
