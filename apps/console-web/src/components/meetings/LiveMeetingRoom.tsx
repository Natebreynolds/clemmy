import { useEffect, useId, useState, type ReactNode } from 'react';
import { Square, Video } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { MeetingCompanion } from './MeetingCompanion';
import { MeetingTranscriptPanel } from './MeetingTranscriptPanel';
import type { LiveMeetingCapture } from '@/lib/meeting-live-transcript';
import type { MeetingTranscriptSegment } from '@/lib/meeting-transcript-panel';

function useElapsed(startedAt: string) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { setNow(Date.now()); const tick = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(tick); }, [startedAt]);
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${hours}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(hours ? 2 : 1, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A private companion to the call. Opening it never enables recording,
 * suggestions or research, and only saved capture identity enables Stop. */
export function LiveMeetingRoom({ meetingId, title, platform, startedAt, capture, segments, connection,
  transcriptReadError, statusReadError, deliveryIncomplete, busy, onStop, onFinal, notes }: {
  meetingId: string; title: string; platform?: string; startedAt: string;
  capture: LiveMeetingCapture; segments: readonly MeetingTranscriptSegment[];
  connection: 'connected' | 'disconnected' | 'unknown'; transcriptReadError: boolean; statusReadError: boolean;
  deliveryIncomplete: boolean; busy: boolean; onStop(): void; onFinal(): void; notes: ReactNode;
}) {
  const elapsed = useElapsed(startedAt);
  const [mobileView, setMobileView] = useState<'transcript' | 'clem'>('transcript');
  const transcriptId = useId();
  const companionId = useId();
  return <section aria-label="Current meeting" className="min-w-0 pb-6">
    <header className="mb-6 min-w-0 border-b border-border pb-5">
      <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
          {statusReadError ? <span className="font-semibold text-warning">Recording status unavailable</span> : <>
            <span className="inline-flex items-center gap-2 font-semibold text-fg"><span className="h-2 w-2 rounded-full bg-danger" aria-hidden />Recording</span>
            <span className="tabular-nums" aria-label={`Recording duration ${elapsed}`}>{elapsed}</span>
          </>}
          {platform && <span className="inline-flex items-center gap-1.5"><Video size={14} aria-hidden />{platform}</span>}
        </div>
        <Button variant="secondary" size="sm" className="min-h-11 shrink-0" disabled={busy} onClick={onStop}><Square size={14} aria-hidden />{busy ? 'Stopping…' : 'Stop recording'}</Button>
      </div>
      <h2 className="break-words text-h1 text-fg [overflow-wrap:anywhere]">{title}</h2>
      <p className="mt-2 max-w-prose text-small text-muted">Your transcript, notes and a little help from Clem.</p>
    </header>
    {statusReadError && <p className="mb-5 text-small text-warning" role="status">Recording status couldn’t refresh. Saved words remain below; the recording may still be running.</p>}
    {deliveryIncomplete && <p className="mb-5 text-small text-warning" role="status">Some live lines couldn’t be saved. The transcript may have gaps until a complete copy is recovered.</p>}
    <div className="mb-5 flex gap-1 rounded-lg bg-subtle p-1 lg:hidden" role="group" aria-label="Meeting view">
      <Button className="min-w-0 flex-1" variant={mobileView === 'transcript' ? 'secondary' : 'ghost'} aria-pressed={mobileView === 'transcript'} aria-controls={transcriptId} onClick={() => setMobileView('transcript')}>Transcript</Button>
      <Button className="min-w-0 flex-1" variant={mobileView === 'clem' ? 'secondary' : 'ghost'} aria-pressed={mobileView === 'clem'} aria-controls={companionId} onClick={() => setMobileView('clem')}>From Clem</Button>
    </div>
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(19rem,1fr)]">
      <div id={transcriptId} className={cn('min-w-0', mobileView !== 'transcript' && 'hidden lg:block')}>
        <MeetingTranscriptPanel capture={capture} segments={segments} recording connection={connection} readError={transcriptReadError} onFinal={onFinal} />
        <details className="group/notes mt-5 min-w-0 border-t border-border pt-3">
          <summary className="min-h-11 cursor-pointer py-2 text-small font-semibold text-fg">Your meeting notes</summary>
          <p className="mb-3 max-w-prose text-caption text-muted">Keep an action, a question or something to follow up on.</p>
          {notes}
        </details>
      </div>
      <aside id={companionId} className={cn('min-w-0', mobileView !== 'clem' && 'hidden lg:block')} aria-label="Private meeting assistance">
        <MeetingCompanion key={meetingId} meetingId={meetingId} active presentation="live" />
      </aside>
    </div>
  </section>;
}
