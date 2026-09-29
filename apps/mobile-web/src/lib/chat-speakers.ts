/**
 * Who wrote each reply, as a label above it.
 *
 * A conversation that only ever had Clem in it needs no names: every reply is
 * hers, and the thread reads as it always has. Once a saved agent has answered
 * anywhere in the thread, every exchange is named, Clem included, because the
 * owner can no longer assume who is speaking.
 *
 * The speaker of each message comes from the shared engine's thread marks
 * (agentThreadMarks): an agent's name, or null for Clem.
 */
interface MessageLike { role: 'user' | 'assistant'; approval?: unknown }
interface MarkLike { speaker: string | null }

/** One entry per message: the name to draw above it, or null for none. */
export function replySpeakers(
  messages: readonly MessageLike[],
  marks: ReadonlyArray<MarkLike | undefined>,
): Array<string | null> {
  const named = marks.some((mark) => Boolean(mark?.speaker?.trim()));
  const labels: Array<string | null> = messages.map(() => null);
  if (!named) return labels;
  let lastSpoken: string | null | undefined;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === 'user') {
      // A new exchange names its speaker again, even when it is the same one.
      lastSpoken = undefined;
      continue;
    }
    // A decision card is a request to the owner, not a reply somebody wrote.
    if (message.approval) continue;
    const speaker = marks[i]?.speaker?.trim() || null;
    if (lastSpoken !== undefined && lastSpoken === speaker) continue;
    labels[i] = speaker ?? 'Clem';
    lastSpoken = speaker;
  }
  return labels;
}
