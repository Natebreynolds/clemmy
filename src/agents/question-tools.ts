import { z } from 'zod';
import { stableJsonDigest } from '../shared/stable-json-digest.js';

/** Disclosure contract only; never approval or execution authority. */
export const QUESTION_TOOL_WIRE_EDITIONS = ['legacy_v1', 'clarification_v2'] as const;
export type QuestionToolWireEdition = typeof QUESTION_TOOL_WIRE_EDITIONS[number];
export function parseQuestionToolWireEdition(value: unknown): QuestionToolWireEdition | null {
  return value === 'legacy_v1' || value === 'clarification_v2' ? value : null;
}

export interface ConditionalApprovalPreparationRepair {
  kind: 'conditional_formal_approval_preparation';
  applies_when: 'formal_card_required_and_work_not_already_sealed';
  authority: 'none';
  action_performed: false;
  preparation_tool: {
    carrier: 'call_tool';
    name: 'pending_action_queue';
    input_schema: Record<string, unknown>;
    schema_sha256: string;
    schema_is_permission: false;
  };
}

/**
 * Disclose the registered deferred schema after a typed legacy approval ask.
 * This is preparation guidance only: the question has no exact action identity,
 * so it cannot select an action, construct arguments, or decide a card is owed.
 * The ordinary carrier still validates current schema, ownership and consent.
 */
export function conditionalApprovalPreparationRepair(
  currentQueueSchema: z.ZodTypeAny | undefined,
): ConditionalApprovalPreparationRepair | null {
  if (!currentQueueSchema) return null;
  try {
    const schema = z.toJSONSchema(currentQueueSchema, { io: 'input', unrepresentable: 'throw' });
    if (
      schema.type !== 'object'
      || !schema.properties
      || typeof schema.properties !== 'object'
      || Array.isArray(schema.properties)
    ) return null;
    return {
      kind: 'conditional_formal_approval_preparation',
      applies_when: 'formal_card_required_and_work_not_already_sealed',
      authority: 'none',
      action_performed: false,
      preparation_tool: {
        carrier: 'call_tool',
        name: 'pending_action_queue',
        input_schema: schema,
        schema_sha256: stableJsonDigest(schema),
        schema_is_permission: false,
      },
    };
  } catch {
    // Missing/unrepresentable schema is not a reason to invent a contract.
    return null;
  }
}
