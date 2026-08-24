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

  const options = (input.options ?? [])
    .filter((option): option is string => typeof option === 'string')
    .map((option) => option.trim())
    .filter(Boolean)
    .slice(0, 8);

  const classification = classifyClarificationAnswer(input.message, {
    kind: 'clarification',
    question,
    options,
  });
  if (!classification) {
    // Background ingress has a stronger fact than the generic legacy phrase
    // classifier: the exact, durable option list that was shown to this
    // origin. Bind only an unambiguous literal option or its 1-based ordinal.
    // This restores "Production" / "2" without turning a generic short reply
    // into inherited task authority.
    const answer = input.message.replace(/\s+/g, ' ').trim();
    if (!answer || answer.length > 280 || answer.split(/\s+/).length > 24) {
      return { kind: 'fresh_turn' };
    }
    const choiceKey = (value: string): string => value.toLowerCase().replace(/[.!]+$/g, '').trim();
    const exact = options.filter((option) => choiceKey(option) === choiceKey(answer));
    if (exact.length === 1) {
      return {
        kind: 'resume',
        classification: { disposition: 'selected', selectedOption: exact[0] },
      };
    }
    const ordinalWords: Record<string, number> = {
      first: 1,
      second: 2,
      third: 3,
      fourth: 4,
      fifth: 5,
      sixth: 6,
      seventh: 7,
      eighth: 8,
    };
    const ordinalMatch = choiceKey(answer).match(/^(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|[1-8])(?:\s+(?:one|option|choice))?$/);
    const ordinal = ordinalMatch
      ? (ordinalWords[ordinalMatch[1]] ?? Number.parseInt(ordinalMatch[1], 10))
      : 0;
    if (ordinal >= 1 && ordinal <= options.length) {
      return {
        kind: 'resume',
        classification: { disposition: 'selected', selectedOption: options[ordinal - 1] },
      };
    }
    return { kind: 'fresh_turn' };
  }
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
