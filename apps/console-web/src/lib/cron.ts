/**
 * Turn a 5-field cron expression into a friendly, plain-English schedule
 * — no raw cron shown to the user. Covers the common shapes Clementine
 * authors (daily, weekday, weekend, specific days, hourly windows,
 * every-N-minutes/hours). Falls back to "a custom schedule" rather than
 * ever exposing the expression.
 */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function fmtTime(h: number, m: number): string {
  const am = h < 12;
  const hr = h % 12 === 0 ? 12 : h % 12;
  const mm = m.toString().padStart(2, '0');
  return `${hr}:${mm} ${am ? 'AM' : 'PM'}`;
}

function describeDays(dow: string): string | null {
  if (dow === '*' || dow === '?') return 'Every day';
  if (dow === '1-5') return 'Every weekday';
  if (dow === '0,6' || dow === '6,0' || dow === '0,7') return 'Every weekend';
  const parts = dow.split(',').map((d) => Number(d.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 7);
  if (parts.length === 0) return null;
  const names = parts.map((n) => DAY_NAMES[n === 7 ? 0 : n]);
  if (names.length === 1) return `Every ${names[0]}`;
  return `Every ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function humanizeCron(expr?: string | null, timezone?: string): string {
  if (!expr || typeof expr !== 'string') return 'On demand';
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return 'A custom schedule';
  const [min, hour, dom, , dow] = parts;
  const tz = timezone ? ` (${timezone.replace(/_/g, ' ')})` : '';

  // Every N minutes.
  let mm = /^\*\/(\d+)$/.exec(min);
  if (mm && hour === '*') return `Every ${mm[1]} minutes${tz}`;
  // Every N hours.
  const hm = /^\*\/(\d+)$/.exec(hour);
  if (hm) return `Every ${hm[1]} hours${tz}`;
  // Top of every hour.
  if (hour === '*' && /^\d+$/.test(min)) return `Every hour at :${min.padStart(2, '0')}${tz}`;

  // Hourly within a window: "M H1-H2 * * *".
  const range = /^(\d+)-(\d+)$/.exec(hour);
  if (range && /^\d+$/.test(min)) {
    const start = fmtTime(Number(range[1]), Number(min));
    const end = fmtTime(Number(range[2]), Number(min));
    const days = describeDays(dow);
    const dayPart = days && days !== 'Every day' ? `${days.toLowerCase()}, ` : '';
    return `Hourly ${dayPart}${start}–${end}${tz}`;
  }

  // Single daily time.
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const time = fmtTime(Number(hour), Number(min));
    if (dom !== '*' && /^\d+$/.test(dom)) return `Monthly on the ${ordinal(Number(dom))} at ${time}${tz}`;
    const days = describeDays(dow);
    if (days) return `${days} at ${time}${tz}`;
    return `Daily at ${time}${tz}`;
  }

  return `A custom schedule${tz}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** The host/browser's IANA time zone, e.g. "America/Denver". */
export function detectedTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** The full IANA zone list (native) for a Timezone dropdown, with a sane fallback. */
export function timezoneOptions(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (typeof fn === 'function') return fn('timeZone');
  } catch { /* fall through */ }
  return [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
    'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Sao_Paulo',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Moscow',
    'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo',
    'Australia/Sydney', 'Pacific/Auckland', 'UTC',
  ];
}

// ─── Schedule model ↔ cron (for the friendly days+time picker) ───────
export type ScheduleMode = 'manual' | 'daily' | 'weekdays' | 'weekends' | 'days' | 'hourly' | 'custom';

export interface ScheduleModel {
  mode: ScheduleMode;
  time: string;       // "HH:MM" (24h) for daily/weekly modes
  days: number[];     // 0=Sun … 6=Sat (for 'days')
  startHour: number;  // for 'hourly'
  endHour: number;    // for 'hourly'
  minute: number;     // minute for 'hourly'
  raw: string;        // original expr (for 'custom')
}

const pad = (n: number) => String(n).padStart(2, '0');

export function parseCron(expr?: string | null): ScheduleModel {
  const base: ScheduleModel = { mode: 'manual', time: '09:00', days: [1, 2, 3, 4, 5], startHour: 7, endHour: 19, minute: 0, raw: '' };
  if (!expr || typeof expr !== 'string' || !expr.trim()) return base;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return { ...base, mode: 'custom', raw: expr.trim() };
  const [min, hour, dom, , dow] = parts;

  const range = /^(\d+)-(\d+)$/.exec(hour);
  if (range && /^\d+$/.test(min) && dom === '*' && (dow === '*' || dow === '?')) {
    return { ...base, mode: 'hourly', startHour: Number(range[1]), endHour: Number(range[2]), minute: Number(min) };
  }

  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*') {
    const time = `${pad(Number(hour))}:${pad(Number(min))}`;
    if (dow === '*' || dow === '?') return { ...base, mode: 'daily', time };
    if (dow === '1-5') return { ...base, mode: 'weekdays', time };
    if (['0,6', '6,0', '0,7'].includes(dow)) return { ...base, mode: 'weekends', time };
    const days = dow.split(',').map((d) => Number(d.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 7).map((n) => (n === 7 ? 0 : n));
    if (days.length) return { ...base, mode: 'days', time, days };
  }
  return { ...base, mode: 'custom', raw: expr.trim() };
}

export function buildCron(m: ScheduleModel): string {
  if (m.mode === 'manual') return '';
  if (m.mode === 'custom') return m.raw.trim();
  if (m.mode === 'hourly') {
    const s = Math.min(m.startHour, m.endHour);
    const e = Math.max(m.startHour, m.endHour);
    return `${m.minute} ${s}-${e} * * *`;
  }
  const [h, min] = m.time.split(':').map((x) => Number(x));
  const hh = Number.isFinite(h) ? h : 9;
  const mm = Number.isFinite(min) ? min : 0;
  if (m.mode === 'daily') return `${mm} ${hh} * * *`;
  if (m.mode === 'weekdays') return `${mm} ${hh} * * 1-5`;
  if (m.mode === 'weekends') return `${mm} ${hh} * * 0,6`;
  // days
  const days = m.days.length ? [...m.days].sort((a, b) => a - b) : [1, 2, 3, 4, 5];
  return `${mm} ${hh} * * ${days.join(',')}`;
}
