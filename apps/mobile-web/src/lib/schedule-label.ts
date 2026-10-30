/** When it runs, in words. A cron string is not an answer to "when". */
export function whenLabel(schedule: string | null): string {
  if (!schedule) return 'When asked';
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return schedule;
  const [minute, hour, dom, , dow] = parts;
  const at = (): string => {
    const h = Number(hour);
    const m = Number(minute);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return schedule;
    const suffix = h < 12 ? 'AM' : 'PM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
  };
  // Intervals in words; "*/5 * * * *" is not "Hourly" (2026-10-18).
  if (minute === '*' && hour === '*') return 'Every minute';
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === '*') return `Every ${everyMinutes[1]} min`;
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (everyHours) return everyHours[1] === '1' ? 'Hourly' : `Every ${everyHours[1]} hours`;
  if (hour.includes('*')) return 'Hourly';
  if (dow !== '*' && !dow.includes('*')) return `${daysLabel(dow)} · ${at()}`;
  if (dom !== '*' && !dom.includes('*')) return `Monthly · ${at()}`;
  return `Every day · ${at()}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The days a cron field names, as a person says them: "Weekdays",
 *  "Weekends", "Fridays", "Mon, Wed, Fri". */
function daysLabel(field: string): string {
  const picked = new Set<number>();
  const named = field.toUpperCase().replace(/SUN|MON|TUE|WED|THU|FRI|SAT/g, (day) => String(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].indexOf(day)));
  for (const part of named.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) { for (let d = Number(range[1]); d <= Number(range[2]); d += 1) picked.add(d % 7); continue; }
    if (/^\d$/.test(part)) { picked.add(Number(part) % 7); continue; }
    return field;
  }
  const days = [...picked].sort((a, b) => a - b);
  if (days.join() === '1,2,3,4,5') return 'Weekdays';
  if (days.join() === '0,6') return 'Weekends';
  if (days.length === 7) return 'Every day';
  if (days.length === 1) return ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][days[0]!]!;
  return days.map((d) => DAYS[d]).join(', ');
}
