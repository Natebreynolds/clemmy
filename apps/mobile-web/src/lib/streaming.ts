/**
 * Token-streaming reducer for the chat transcript stream.
 *
 * Deltas arrive as `stream_token` rows on the public `event` frames — there is
 * no separate `delta` frame (the screen originally listened for one the server
 * never emitted, so the streaming bubble sat dead while every stream_token
 * cleared it — live 2026-08-04). A stream_token is CONSUMED here: appended to
 * the provisional text and kept out of the transcript merge. Any other event
 * ends the provisional text (the real message owns the screen from there).
 */
export interface StreamFrameResult {
  /** Next provisional streaming text to display. */
  streaming: string;
  /** True when the event was a token delta and must NOT merge into the transcript. */
  consumed: boolean;
}

export function reduceStreamingText(
  current: string,
  event: { type: string; data?: Record<string, unknown> },
): StreamFrameResult {
  if (event.type === 'stream_token') {
    const delta = typeof event.data?.delta === 'string' ? event.data.delta : '';
    return { streaming: current + delta, consumed: true };
  }
  return { streaming: '', consumed: false };
}
