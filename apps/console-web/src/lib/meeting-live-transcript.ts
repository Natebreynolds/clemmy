export interface LiveMeetingCapture { windowId: string; sdkUploadId?: string; recordingId?: string }
export interface MeetingLiveLine { text: string; speaker?: string; at: string }

/** Transient display only. A matching window alone cannot identify a capture. */
export function matchingMeetingLiveLine(capture: LiveMeetingCapture, event: Record<string, unknown>): MeetingLiveLine | null | undefined {
  if (event.windowId !== capture.windowId || !capture.windowId) return undefined;
  const exact = capture.sdkUploadId ? event.sdkUploadId === capture.sdkUploadId
    : capture.recordingId ? event.recordingId === capture.recordingId : false;
  if (!exact || (event.type !== 'transcript-partial' && event.type !== 'transcript')) return undefined;
  if (event.type === 'transcript') return null;
  if (typeof event.text !== 'string' || !event.text.trim() || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) return undefined;
  return { text: event.text.slice(0, 4000), ...(typeof event.speaker === 'string' ? { speaker: event.speaker.slice(0, 200) } : {}), at: event.at };
}
