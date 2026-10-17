import { useEffect, useState } from 'react';
import { clemmy } from '@/lib/clemmy';
import { matchingMeetingLiveLine, type LiveMeetingCapture, type MeetingLiveLine } from '@/lib/meeting-live-transcript';

export function MeetingLiveTranscript({ capture }: { capture: LiveMeetingCapture }) {
  const [line, setLine] = useState<MeetingLiveLine | null>(null);
  useEffect(() => {
    setLine(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = clemmy()?.onRecallEvent?.((event) => {
      const next = matchingMeetingLiveLine(capture, event);
      if (next === undefined) return;
      clearTimeout(timer); setLine(next);
      if (next) timer = setTimeout(() => setLine(null), 20_000);
    });
    return () => { clearTimeout(timer); unsubscribe?.(); };
  }, [capture.windowId, capture.sdkUploadId, capture.recordingId]);
  return line ? <div className="mb-3 rounded-md bg-subtle px-3 py-2" aria-live="off">
    <p className="text-caption text-muted">Being transcribed · not final</p>
    <p className="mt-1 break-words text-small text-fg">{line.speaker ? `${line.speaker}: ` : ''}{line.text}</p>
  </div> : null;
}
