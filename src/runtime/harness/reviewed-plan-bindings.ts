import { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } from '../../shared/closed-canonical-json.js';
import { resolveWorkTopologyJsonPointer } from '../graph/work-topology.js';
const object = (v: unknown): v is Record<string, any> => Boolean(v && typeof v === 'object' && !Array.isArray(v));

/** Resolve the declared durable tool result or explicitly model-authored compute
 * result. Model content never acquires independent verification here. */
export function resolveReviewedStepArguments(step: Record<string, any>, resolveProducer: (id: string) => unknown): Record<string, unknown> {
  if (!object(step.staticArguments) || !Array.isArray(step.dynamicBindings)) throw new Error('Reviewed argument contract is malformed.');
  const args = JSON.parse(closedCanonicalJson(step.staticArguments, SEALED_CALL_CANONICAL_LIMITS));
  const targets = new Set<string>();
  for (const binding of step.dynamicBindings) {
    if (!object(binding) || typeof binding.targetPath !== 'string' || !Array.isArray(step.dependsOn)
      || !step.dependsOn.includes(binding.producerStepId) || targets.has(binding.targetPath)) throw new Error('Reviewed dynamic binding is malformed or ambiguous.');
    targets.add(binding.targetPath);
    const producer = resolveProducer(binding.producerStepId);
    if (typeof binding.outputPath !== 'string' || (binding.outputPath !== '' && !binding.outputPath.startsWith('/'))) throw new Error('Reviewed producer path is invalid.');
    let cursor: unknown = producer;
    for (const part of (binding.outputPath === '' ? [] : binding.outputPath.slice(1).split('/')).map((part: string) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if ((!object(cursor) && !Array.isArray(cursor)) || !Object.hasOwn(cursor, part)) throw new Error(`Producer ${binding.producerStepId} did not return ${binding.outputPath}.`);
      cursor = (cursor as Record<string, unknown>)[part];
    }
    const result = resolveWorkTopologyJsonPointer(producer, binding.outputPath);
    if (!result.ok) throw new Error(`Producer ${binding.producerStepId} did not return ${binding.outputPath}.`);
    const type = Array.isArray(result.value) ? 'array' : result.value === null ? 'null' : typeof result.value;
    if (binding.expectedType && binding.expectedType !== 'json' && type !== binding.expectedType) throw new Error('Reviewed dynamic argument type does not match its settled producer.');
    const parts = binding.targetPath.slice(1).split('/').map((part: string) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!binding.targetPath.startsWith('/') || parts.some((part: string) => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Reviewed dynamic target is invalid.');
    let target: Record<string, unknown> = args;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(target, part) || (!object(target[part]) && !Array.isArray(target[part]))) throw new Error('Reviewed dynamic target parent must be explicitly declared.');
      target = target[part] as Record<string, unknown>;
    }
    const key = parts.at(-1)!;
    if (Object.hasOwn(target, key)) throw new Error('A reviewed argument cannot have both a static value and a dynamic binding.');
    target[key] = result.value;
  }
  return args;
}
