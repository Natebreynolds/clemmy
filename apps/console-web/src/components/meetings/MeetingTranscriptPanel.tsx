import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { clemmy } from '@/lib/clemmy';
import { cn } from '@/lib/cn';
import type { LiveMeetingCapture } from '@/lib/meeting-live-transcript';
import {
  createMeetingTranscriptStream, emptyMeetingTranscriptStream, meetingTranscriptAtBottom,
  meetingTranscriptCaptureKey, type MeetingTranscriptSegment, type MeetingTranscriptStreamState,
} from '@/lib/meeting-transcript-panel';

export interface MeetingTranscriptPanelProps {
  capture: LiveMeetingCapture;
  segments: readonly MeetingTranscriptSegment[];
  recording: boolean;
  connection?: 'connected' | 'disconnected' | 'unknown';
  readError?: boolean;
  onFinal(): void;
  className?: string;
  headerTitle?: string;
}

const PAGE_SIZE = 200;
const clock = (value?: string) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : undefined;

function TranscriptLine({ text, speaker, timestamp, pending }: {
  text: string; speaker?: string; timestamp?: string; pending?: string;
}) {
  const time = clock(timestamp);
  return <li className="min-w-0 py-3 first:pt-1">
    {(speaker || time || pending) && <div className="mb-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-caption text-muted">
      {speaker && <span className="min-w-0 break-words font-semibold text-fg [overflow-wrap:anywhere]">{speaker}</span>}
      {time && <time dateTime={timestamp} className="tabular-nums">{time}</time>}
      {pending && <span>{pending}</span>}
    </div>}
    <p className="max-w-prose whitespace-pre-wrap break-words text-body text-fg [overflow-wrap:anywhere]">{text}</p>
  </li>;
}

/** The conversation is the main view. Native interim words are temporary and
 * never promoted to saved lines without the selected meeting's own readback. */
export function MeetingTranscriptPanel({ capture, segments, recording, connection, readError,
  onFinal, className, headerTitle = 'Live transcript' }: MeetingTranscriptPanelProps) {
  const contentId = useId();
  const titleId = useId();
  const captureKey = meetingTranscriptCaptureKey(capture);
  const [expanded, setExpanded] = useState(true);
  const [view, setView] = useState<{ captureKey: string; stream: MeetingTranscriptStreamState }>(() => ({ captureKey, stream: emptyMeetingTranscriptStream() }));
  const [page, setPage] = useState<{ captureKey: string; end: number | null }>(() => ({ captureKey, end: null }));
  const [following, setFollowing] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const controller = useRef<ReturnType<typeof createMeetingTranscriptStream> | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const persisted = useMemo(() => segments.filter(segment => segment && typeof segment.text === 'string'
    && segment.isFinal !== false && !!segment.text.trim()), [segments]);
  const latestSegments = useRef(persisted);
  latestSegments.current = persisted;
  const stream = recording && expanded && view.captureKey === captureKey ? view.stream : emptyMeetingTranscriptStream();
  const pageEnd = page.captureKey === captureKey ? page.end : null;
  const end = pageEnd === null ? persisted.length : Math.min(pageEnd, persisted.length);
  const start = Math.max(0, end - PAGE_SIZE);
  const latestPage = pageEnd === null;
  const visible = persisted.slice(start, end);

  useEffect(() => {
    setPage({ captureKey, end: null });
    follow.current = true; setFollowing(true);
  }, [captureKey]);

  useEffect(() => {
    setView({ captureKey, stream: emptyMeetingTranscriptStream() });
    if (!expanded || !recording) return;
    // Capture this callback with its meeting, rather than borrowing another
    // selection's refresh callback if a late event arrives during navigation.
    const refreshThisMeeting = onFinalRef.current;
    const streamController = createMeetingTranscriptStream({
      capture,
      subscribe: listener => clemmy()?.onRecallEvent?.(listener),
      onState: next => setView({ captureKey, stream: next }),
      onFinal: refreshThisMeeting,
    });
    controller.current = streamController;
    streamController.reconcile(latestSegments.current);
    return () => { streamController.dispose(); if (controller.current === streamController) controller.current = null; };
  }, [captureKey, expanded, recording]);

  useEffect(() => { controller.current?.reconcile(persisted); }, [persisted]);

  useLayoutEffect(() => {
    if (expanded && latestPage && follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [captureKey, expanded, latestPage, persisted, stream]);

  useEffect(() => {
    if (!expanded || typeof ResizeObserver === 'undefined' || !content.current) return;
    const observer = new ResizeObserver(() => {
      if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [captureKey, expanded]);

  const jumpToLatest = () => {
    follow.current = true; setFollowing(true); setPage({ captureKey, end: null });
    if (latestPage && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  };
  const showPage = (nextEnd: number) => {
    if (nextEnd >= persisted.length) { jumpToLatest(); return; }
    follow.current = false; setFollowing(false); setPage({ captureKey, end: nextEnd });
    if (scroll.current) scroll.current.scrollTop = 0;
  };
  const status = !recording ? 'Saved transcript'
    : connection === 'disconnected' ? 'Connection interrupted'
      : stream.partial || stream.acknowledged.length > 0 ? 'Receiving transcript'
        : connection === 'connected' ? 'Transcript connected'
          : persisted.length > 0 ? 'Saved lines shown below' : 'Waiting for transcript';

  return <section aria-labelledby={titleId} className={cn('min-w-0 max-sm:[&_button]:min-h-11', className)}>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h3 id={titleId} className="text-h3 text-fg">{headerTitle}</h3>
        <p className="mt-1 text-caption text-muted">{status}</p>
      </div>
      <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={contentId} onClick={() => {
        if (!expanded) jumpToLatest();
        setExpanded(value => !value);
      }}>
        {expanded ? <><ChevronUp size={16} aria-hidden />Hide transcript</> : <><ChevronDown size={16} aria-hidden />Show transcript</>}
      </Button>
    </div>
    {expanded && <div id={contentId} className="mt-4 min-w-0">
      {readError && <p className="mb-3 text-small text-warning" role="status">The transcript couldn’t refresh. Showing the last saved lines.</p>}
      {recording && connection === 'disconnected' && <p className="mb-3 text-small text-warning">Live updates are interrupted. Saved lines remain available here.</p>}
      {persisted.length > 0 && (start > 0 || !latestPage) && <nav aria-label="Transcript pages" className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <Button size="sm" variant="ghost" disabled={start === 0} onClick={() => showPage(start)}>Earlier lines</Button>
        <span className="text-caption tabular-nums text-muted">Lines {start + 1}–{end} of {persisted.length}</span>
        {!latestPage && <Button size="sm" variant="ghost" onClick={() => showPage(end + PAGE_SIZE)}>Later lines</Button>}
      </nav>}
      <div ref={scroll} tabIndex={0} role="region" aria-label="Meeting transcript" aria-live="off"
        className="h-[min(32rem,60dvh)] min-h-56 min-w-0 overflow-y-auto overscroll-contain rounded-md bg-surface px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:px-4"
        onScroll={() => { if (scroll.current) { const atBottom = latestPage && meetingTranscriptAtBottom(scroll.current); follow.current = atBottom; setFollowing(atBottom); } }}>
        <div ref={content} className="min-w-0">
          {visible.length > 0 || (latestPage && (stream.acknowledged.length > 0 || stream.partial)) ? <ol className="divide-y divide-border">
            {visible.map((segment, index) => <TranscriptLine key={segment.id ?? segment.eventId ?? `saved:${start + index}`}
              text={segment.text} speaker={typeof segment.speaker === 'string' ? segment.speaker : undefined} timestamp={segment.timestamp} />)}
            {latestPage && stream.acknowledged.map(line => <TranscriptLine key={`received:${line.key}`} text={line.text} speaker={line.speaker}
              timestamp={line.at} pending="Received · updating transcript" />)}
            {latestPage && stream.partial && <TranscriptLine key="partial" text={stream.partial.text} speaker={stream.partial.speaker}
              timestamp={stream.partial.at} pending="Being transcribed · not final" />}
          </ol> : <p className="max-w-prose py-6 text-small text-muted">{recording ? 'Waiting for transcript. Words will appear here when transcription arrives.' : 'No saved transcript lines are available for this meeting yet.'}</p>}
        </div>
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-caption text-muted">{stream.unconfirmed.length > 0 ? 'Some recent lines haven’t appeared in the saved transcript yet.'
          : recording ? 'Live words can change until they are final.' : 'Showing the saved transcript available for this meeting.'}</p>
        {(!following || !latestPage) && <Button size="sm" variant="secondary" onClick={jumpToLatest}><ArrowDown size={15} aria-hidden />Jump to latest</Button>}
      </div>
    </div>}
  </section>;
}
