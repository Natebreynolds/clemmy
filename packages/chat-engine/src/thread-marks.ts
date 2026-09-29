/**
 * Where something about a conversation changed between exchanges: the agent
 * answering it, the project it works in.
 *
 * Each message either states the value, or does not say. One mark per message
 * carries the value in force there, and the message a change belongs above.
 */
export interface ThreadChange<T> {
  /** The value in force at this message. */
  value: T;
  /** Set on the message the conversation changed at. */
  changed?: { to: T; from: T };
}

/**
 * `known[i]` is what message i states, undefined when it does not say.
 * `fallback` is the value before any message says. A change is marked on the
 * owner's message that started it, so the line sits above the question, not
 * between the question and its answer.
 */
export function threadChanges<T>(
  roles: readonly ('user' | 'assistant')[],
  known: readonly (T | undefined)[],
  fallback: T,
): ThreadChange<T>[] {
  const firstKnown = known.find((value) => value !== undefined);
  let current: T = firstKnown === undefined ? fallback : firstKnown;
  const marks: ThreadChange<T>[] = [];
  for (let i = 0; i < roles.length; i++) {
    const value = known[i];
    if (value !== undefined && value !== current) {
      // The reply names the change but the question before it did not: the
      // line belongs above that question.
      const at = roles[i] === 'assistant' && i > 0 && roles[i - 1] === 'user' && known[i - 1] === undefined
        ? i - 1
        : i;
      marks[at] = { value: marks[at] ? marks[at].value : value, changed: { to: value, from: current } };
      current = value;
    }
    marks[i] = { ...marks[i], value: current };
  }
  return marks;
}
