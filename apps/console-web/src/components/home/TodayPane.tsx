import { Link } from 'react-router-dom';
import type { HomeToday, HomeTodayEvent } from '@/lib/home-data';
import { cn } from '@/lib/cn';
import { clockLabel } from './home-model';
import { LoadFailedLine, PaneCard, PaneRow, QuietLine, RowSkeleton, SectionHeader } from './HomeSection';

/** A read older than this says its time; a fresh one does not need to. */
const DISCLOSE_AFTER_MS = 30 * 60_000;

/**
 * TODAY — the next day of the owner's calendar, as the calendar watch last
 * read it (no calendar call of its own). The next meeting leads; an invite
 * still waiting on an answer says so and goes to Needs you, where the answer
 * is. A stale or failed read says how old the list is.
 */
export function TodayPane({ headingId, today, loading, error, onRetry, nowMs = Date.now(), maxRows = 6 }: {
  headingId: string;
  today: HomeToday | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  nowMs?: number;
  maxRows?: number;
}) {
  const asOfMs = today?.asOf ? Date.parse(today.asOf) : NaN;
  const old = Number.isFinite(asOfMs) && nowMs - asOfMs > DISCLOSE_AFTER_MS;
  const events = (today?.events ?? []).slice(0, maxRows);
  const nextIndex = events.findIndex((e) => e.startMs > nowMs);
  const todayKey = new Date(nowMs).toDateString();
  // In the evening the watch's next day is tomorrow: say so once in the
  // heading instead of on every row.
  const allTomorrow = events.length > 0 && events.every((e) => new Date(e.startMs).toDateString() !== todayKey);
  const more = (today?.events.length ?? 0) - events.length;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <SectionHeader
        id={headingId}
        label={allTomorrow ? 'Tomorrow' : 'Today'}
        aside={today && old && today.asOf ? <span>As of {clockLabel(today.asOf)}</span> : undefined}
      />
      <PaneCard>
        {loading ? (
          <RowSkeleton rows={3} />
        ) : error || !today ? (
          <LoadFailedLine what="your calendar" onRetry={onRetry} />
        ) : !today.connected ? (
          <QuietLine>Connect a calendar and Clem keeps your day here.</QuietLine>
        ) : events.length === 0 ? (
          <QuietLine>{today.asOf ? 'Nothing else on your calendar today.' : 'Clem hasn’t read your calendar yet.'}</QuietLine>
        ) : (
          <>
            {events.map((event, i) => <EventRow key={event.key} event={event} next={i === nextIndex} nowMs={nowMs} sayDay={!allTomorrow} />)}
            {more > 0 && <PaneRow className="text-caption text-faint">{more} more after that</PaneRow>}
          </>
        )}
        {today?.lastError && today.events.length > 0 && (
          <PaneRow className="text-caption text-warning">
            The last calendar read failed; this is the one before it{today.asOf ? `, from ${clockLabel(today.asOf)}` : ''}.
          </PaneRow>
        )}
      </PaneCard>
    </section>
  );
}

function place(location?: string): string {
  if (!location) return '';
  // A meeting link is where the meeting is, not something to read.
  return /^(https?:\/\/|www\.)/i.test(location.trim()) ? 'Online' : location;
}

function EventRow({ event, next, nowMs, sayDay }: { event: HomeTodayEvent; next: boolean; nowMs: number; sayDay: boolean }) {
  const start = new Date(event.startMs);
  const sameDay = start.toDateString() === new Date(nowMs).toDateString();
  const time = event.allDay ? 'All day' : start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const minutes = Math.round((event.startMs - nowMs) / 60_000);
  const soon = next && minutes > 0 && minutes <= 90 ? `In ${minutes} min` : '';
  const people = event.attendeeCount > 1 ? `${event.attendeeCount} people` : '';
  const meta = [soon, sayDay && !sameDay ? 'Tomorrow' : '', people, place(event.location)].filter(Boolean).join(' · ');
  const now = event.startMs <= nowMs && event.endMs > nowMs;
  return (
    <PaneRow className="items-start gap-4">
      <span className={cn('w-[4.5rem] shrink-0 pt-px text-small font-semibold tabular-nums', next || now ? 'text-primary' : 'text-fg')}>
        {now ? 'Now' : time}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-medium text-fg" title={event.title}>{event.title}</span>
        {(meta || event.needsReply) && (
          <span className="flex min-w-0 items-baseline gap-2 text-small">
            {event.needsReply && (
              <Link to="/inbox?tab=needs" className="shrink-0 font-semibold text-info hover:underline">Reply needed</Link>
            )}
            {meta && <span className={cn('min-w-0 truncate', soon ? 'text-primary' : 'text-muted')}>{meta}</span>}
          </span>
        )}
      </span>
    </PaneRow>
  );
}
