/**
 * Follow-ups: a message the owner sends while Clem works that cannot join the
 * running turn waits for it to end and is then sent as its own message,
 * instead of coming back refused ("send this again as a new message").
 *
 * Only an explicit refusal waits. Each code below is the server saying it
 * recorded nothing (the turn was finishing, had changed, or could not take a
 * mode change), so sending the same words later can never deliver them
 * twice. A lost response or any other failure keeps the old "couldn't
 * confirm" state, because the server may already hold that message.
 */
const WAITS_FOR_TURN_END = new Set([
  'RUN_NOT_ACTIVE',
  'STEER_NOTE_CUTOVER',
  'STEER_NOTE_OWNER_CHANGED',
  'STEER_NOTE_UNAVAILABLE',
  'TASK_MODE_CANNOT_CHANGE_ACTIVE_TURN',
]);

export function steerRefusalWaitsForTurnEnd(error: unknown): boolean {
  const failure = error as { status?: unknown; body?: unknown } | null | undefined;
  if (failure?.status !== 409 || !failure.body || typeof failure.body !== 'object') return false;
  const code = (failure.body as { code?: unknown }).code;
  return typeof code === 'string' && WAITS_FOR_TURN_END.has(code);
}

/** Whether a waiting message goes out by itself once the turn ends this way.
 *  After a finished or failed turn it does. After a question, a card or a
 *  plan it waits for the owner's tap, so it never answers one by accident;
 *  after a Stop it waits too, because Stop means stop. */
export function followUpSendsAfter(status: string | undefined): boolean {
  return status === 'complete' || status === 'failed';
}
