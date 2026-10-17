import { z } from 'zod';
import { readPreparedMeetingLookup, type PreparedMeetingLookup } from './meeting-assistance.js';

/** Reservation of a request id is not acceptance. Replay privileges require
 * the same immutable input and its own durably recorded user source. */
export function isAcceptedMeetingLookup(packet: PreparedMeetingLookup, inputHash: string,
  receipt: { sessionId: string; inputHash: string; requestId: string; runId: string } | null,
  source: { sessionId: string; type: string; data: Record<string, unknown> } | null): boolean {
  return Boolean(receipt && source && receipt.requestId === packet.clientRequestId
    && receipt.sessionId === packet.privateOriginSessionId && receipt.inputHash === inputHash
    && source.sessionId === receipt.sessionId && source.type === 'user_input_received'
    && source.data.requestId === receipt.requestId && source.data.clientRequestId === receipt.requestId
    && source.data.runId === receipt.runId && source.data.displayText === packet.input);
}

const reference = z.object({ meetingId: z.string().min(1).max(512), offerId: z.string().min(1).max(80),
  digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Only the owner's concrete prepared choice may seed this private task.
 * Text in a transcript or a guessed session id is never a handoff token. */
export function verifyMeetingLookupChat(input: {
  reference: unknown; text: string; clientRequestId: string; sessionId: string;
  acceptedSessionId?: string; acceptedReplay?: boolean;
}) {
  const ref = reference.parse(input.reference);
  if (input.acceptedReplay === true && !input.acceptedSessionId) {
    throw new Error('Meeting lookup replay requires the exact accepted conversation.');
  }
  const packet = readPreparedMeetingLookup(ref.meetingId, ref.offerId, ref.digest,
    { acceptedReplay: input.acceptedReplay === true });
  if ((input.sessionId && !input.acceptedSessionId)
    || packet.input !== input.text || packet.clientRequestId !== input.clientRequestId
    || (input.sessionId && input.sessionId !== packet.privateOriginSessionId)
    || (input.acceptedSessionId && input.acceptedSessionId !== packet.privateOriginSessionId)) {
    throw new Error('Meeting lookup does not match the exact owner choice.');
  }
  return packet;
}
