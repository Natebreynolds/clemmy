import { api, apiGet } from './api';
import { postChat } from './chat';

export interface MeetingHelpOffer {
  id: string; digest: string; question: string; why: string; quote: string;
  segmentIds: string[]; sourceDigest: string; createdAt: number; expiresAt: number;
  state: 'open' | 'lookup_prepared' | 'dismissed' | 'deferred' | 'expired' | 'research_queued';
  lookup?: { sessionId: string; clientRequestId: string; accepted?: boolean | null };
}
export interface MeetingHelpState {
  meetingId: string; enabled: boolean; version: number; checking: boolean;
  status: 'disabled' | 'watching' | 'offer' | 'unavailable' | 'completed';
  reason?: string; offer?: MeetingHelpOffer; recentOffers: MeetingHelpOffer[];
  keptOffers: MeetingHelpOffer[];
  retainedOfferCount: number; omittedOfferCount: number; heldOfferCount: number; skippedFinalSegments: number;
  nextCheckAt?: number;
  finalSegmentCount: number;
}
export interface PreparedMeetingHelp {
  meetingId: string; offerId: string; offerDigest: string; input: string;
  clientRequestId: string; privateOriginSessionId: string;
}
const endpoint = (id: string) => `/api/console/meetings/${encodeURIComponent(id)}/assistance`;
export const getMeetingHelp = (id: string) => apiGet<MeetingHelpState>(endpoint(id));
export const setMeetingHelp = (id: string, enabled: boolean, expectedVersion: number) => api<MeetingHelpState>(endpoint(id), {
  method: 'PATCH', body: JSON.stringify({ enabled, expectedVersion }),
});
export const checkMeetingHelp = (id: string) => api<MeetingHelpState>(`${endpoint(id)}/check`, { method: 'POST', body: '{}' });
export const decideMeetingHelp = (id: string, offer: MeetingHelpOffer, version: number, decision: 'lookup' | 'dismiss' | 'defer') =>
  api<{ state: MeetingHelpState; lookup?: PreparedMeetingHelp }>(`${endpoint(id)}/offers/${encodeURIComponent(offer.id)}`, {
    method: 'POST', body: JSON.stringify({ digest: offer.digest, version, decision }),
  });

/** Same request identity on every retry; transcript content never goes in a URL. */
export async function startMeetingHelp(lookup: PreparedMeetingHelp) {
  const accepted = await postChat(lookup.input, null, [], lookup.clientRequestId,
    undefined, undefined, undefined, undefined, undefined,
    { meetingId: lookup.meetingId, offerId: lookup.offerId, digest: lookup.offerDigest });
  if (accepted.sessionId !== lookup.privateOriginSessionId) throw new Error('The meeting lookup returned a different conversation. Reopen the meeting to check it.');
  return accepted;
}

export function meetingHelpNotice(state: Pick<MeetingHelpState, 'status' | 'checking' | 'reason'> & { finalSegmentCount?: number }): string {
  if (state.checking) return 'Checking the latest transcript for a useful question…';
  if (state.reason === 'transcript_changed') return 'The transcript changed. Turn suggestions off and on to use its current version.';
  if (state.reason === 'offer_history_capacity') return 'You have a full set of saved suggestions. The questions you kept are still here.';
  if (state.status === 'unavailable') return 'Clem couldn’t check the latest transcript. Your recording is unaffected.';
  if (state.status === 'completed') return 'The meeting has ended. Questions you kept are here for the follow-up.';
  if (state.status === 'disabled') return 'Suggestions are off. Turn them on for this meeting when you’d like a hand.';
  if (state.finalSegmentCount === 0) return 'Waiting for finalized transcript lines. Live transcription needs to be on when the recording starts.';
  return 'Clem can suggest a lookup when a useful question comes up. No suggestion yet.';
}
