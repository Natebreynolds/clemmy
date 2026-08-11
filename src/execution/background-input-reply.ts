import {
  classifyClarificationAnswer,
  type ClarificationAnswerClassification,
} from '../runtime/harness/task-continuity-runtime.js';

export type BackgroundInputReplyDecision =
  | {
      kind: 'resume';
      classification: ClarificationAnswerClassification;
    }
  | {
      kind: 'declined';
      classification: ClarificationAnswerClassification;
    }
  | {
      kind: 'fresh_turn';
    };

/**
 * Bind a message only to the exact question a background task parked on.
 *
 * This deliberately shares the foreground continuation classifier: a short
 * answer may fill a bounded slot or select an offered option, while a decline,
 * compound correction, question, or unrelated request never inherits the old
 * task's execution authority.
 */
export function classifyBackgroundInputReply(input: {
  message: string;
  question?: string;
  options?: readonly string[];
}): BackgroundInputReplyDecision {
  const question = input.question?.trim();
  if (!question) return { kind: 'fresh_turn' };

  const classification = classifyClarificationAnswer(input.message, {
    kind: 'clarification',
    question,
    options: (input.options ?? [])
      .filter((option): option is string => typeof option === 'string')
      .map((option) => option.trim())
      .filter(Boolean)
      .slice(0, 8),
  });
  if (!classification) return { kind: 'fresh_turn' };
  if (classification.disposition === 'declined') {
    return { kind: 'declined', classification };
  }
  if (classification.disposition === 'declined_with_new_task') {
    // The fresh clause belongs to the foreground chat. Feeding the whole
    // compound message back into the parked task would revive the very work
    // the user just declined.
    return { kind: 'fresh_turn' };
  }
  return { kind: 'resume', classification };
}
