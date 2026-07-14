export interface MeetingTiming {
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
}

function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

function relativeTimeAt(value: string | undefined, nowMs: number): string {
  if (!value) return '';
  const startedAt = Date.parse(value);
  if (!Number.isFinite(startedAt)) return '';
  const diff = nowMs - startedAt;
  if (diff < 60_000) return 'now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function meetingTimeLabel(meeting: MeetingTiming, nowMs = Date.now()): string {
  const explicitDuration = meeting.durationSeconds;
  if (typeof explicitDuration === 'number' && Number.isFinite(explicitDuration) && explicitDuration >= 0) {
    return formatElapsed(Math.floor(explicitDuration));
  }

  const startedAt = Date.parse(meeting.startedAt ?? '');
  const endedAt = Date.parse(meeting.endedAt ?? '');
  if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt) {
    return formatElapsed(Math.floor((endedAt - startedAt) / 1000));
  }

  // Active/incomplete meetings retain the existing relative-time display.
  return relativeTimeAt(meeting.startedAt, nowMs);
}
