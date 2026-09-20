import type { PlanJson, PlanStructuredOutline } from './plan-artifacts.js';

function object(value: PlanJson | undefined): value is PlanStructuredOutline {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function omitDigest(row: PlanStructuredOutline, key: string): void {
  if (typeof row[key] === 'string' && /^[a-f0-9]{64}$/.test(row[key])) delete row[key];
}

/** Model context only. The immutable artifact remains the authority for host
 * validation and plan_task. Preserve all execution semantics and schemas;
 * opaque local validation digests do not help the model execute the plan. */
export function reviewedPlanModelView(outline: PlanStructuredOutline): PlanStructuredOutline {
  if (!Array.isArray(outline.preparedBindings)) return outline;
  return {
    ...outline,
    preparedBindings: outline.preparedBindings.map(binding => {
      if (!object(binding) || !object(binding.identity)) return binding;
      const identity = binding.identity;
      const definition = identity.definition;
      if (identity.kind !== 'local_registry' || !object(definition)
        || definition.version !== 1 || definition.provenance !== 'authorized_local_registry') return binding;
      const projectedDefinition = { ...definition };
      for (const key of ['schemaFingerprint', 'registrySemanticsFingerprint', 'envelopeFingerprint']) {
        omitDigest(projectedDefinition, key);
      }
      if (object(definition.descriptor)) {
        const descriptor = { ...definition.descriptor };
        omitDigest(descriptor, 'manifestDigest');
        projectedDefinition.descriptor = descriptor;
      }
      const projectedIdentity = { ...identity, definition: projectedDefinition };
      omitDigest(projectedIdentity, 'inputSchemaDigest');
      return { ...binding, identity: projectedIdentity };
    }),
  };
}
