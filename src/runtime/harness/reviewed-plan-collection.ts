/** A reviewed operation repeated over exact records. Collection metadata is
 * compiled to the existing per-member ledger; it never selects a capability. */
import { z } from 'zod';
import { closedCanonicalJson, SEALED_CALL_CANONICAL_LIMITS } from '../../shared/closed-canonical-json.js';

export const PlanCollectionSchema = z.object({
  items: z.array(z.unknown()).min(1).optional().describe('Records already known at review time. Omit when producerStepId supplies them during execution.'),
  producerStepId: z.string().min(1).optional().describe('Source step during Execute. A single read supplies its complete records. A repeated tool step supplies {memberId, result} records with the same durable member IDs. result is the retained inner tool value, not a call_tool/work_call wrapper: for text use /result directly, not /result/output or /result/content. Traverse further only when the actual result is an object with those fields. For interpretation or reshaping, use a compute step and bind its recorded output to a later tool.'),
  memberIdPath: z.string().default('').describe('JSON pointer to a stable string ID, for example /id (include the leading slash), or empty when each record is its own ID.'),
  bindings: z.array(z.object({ itemPath: z.string().default('').describe('JSON pointer within each record, for example /content, or empty for the whole record.'), targetPath: z.string().startsWith('/').describe('JSON pointer into the tool arguments, for example /content.') }).strict()).min(1),
}).strict();
export type PlanCollection = z.infer<typeof PlanCollectionSchema>;
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));

export function planPointer(value: unknown, pointer: string): unknown {
  if (pointer !== '' && (!pointer.startsWith('/') || /~(?![01])/u.test(pointer))) throw new Error('A plan binding needs an exact JSON pointer.');
  let current = value;
  for (const part of (pointer === '' ? [] : pointer.slice(1).split('/')).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (['__proto__', 'prototype', 'constructor'].includes(part) || ((!object(current) && !Array.isArray(current)) || !Object.hasOwn(current, part))) throw new Error(`Reviewed result has no own value at ${pointer}.`);
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function reviewedCollectionMembers(collection: PlanCollection, records: unknown[]) {
  const members = records.map(record => {
    const id = planPointer(record, collection.memberIdPath);
    if (typeof id !== 'string' || !id.trim() || id.length > 256) throw new Error('Each reviewed collection member needs a stable string ID.');
    return { id, record };
  });
  if (new Set(members.map(member => member.id)).size !== members.length) throw new Error('Reviewed collection member IDs must be unique.');
  return members;
}

export function bindReviewedCollectionItem(args: Record<string, unknown>, collection: PlanCollection, record: unknown) {
  const result = JSON.parse(closedCanonicalJson(args, SEALED_CALL_CANONICAL_LIMITS)) as Record<string, unknown>;
  for (const binding of collection.bindings) {
    const value = planPointer(record, binding.itemPath);
    if (!binding.targetPath.startsWith('/') || /~(?![01])/u.test(binding.targetPath)) throw new Error('A collection target needs an exact JSON pointer.');
    const parts = binding.targetPath.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Collection target is invalid.');
    let parent = result;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(parent, part) || (!object(parent[part]) && !Array.isArray(parent[part]))) throw new Error('Collection target parent must be a prepared object.');
      parent = parent[part] as Record<string, unknown>;
    }
    const key = parts.at(-1)!;
    if (Object.hasOwn(parent, key)) throw new Error('A collection argument cannot also have a static or producer-bound value.');
    parent[key] = value;
  }
  return result;
}

export function planCollectionUniverseId(stepId: string) { return `members:${stepId}`; }

/** Repeated stages share their producer's member universe. Results change,
 * but the reviewed work items do not become a new guessed collection. */
export function reviewedCollectionRoot(stepId: string, steps: ReadonlyMap<string, { id: string; forEach?: PlanCollection }>): string {
  const seen = new Set<string>();
  let current = stepId;
  while (true) {
    if (seen.has(current)) throw new Error('Reviewed collection dependencies are cyclic.');
    seen.add(current);
    const step = steps.get(current);
    if (!step?.forEach) throw new Error(`Reviewed collection ${current} is missing.`);
    const producer = step.forEach.producerStepId && steps.get(step.forEach.producerStepId);
    if (!producer || !producer.forEach) return current;
    current = producer.id;
  }
}
