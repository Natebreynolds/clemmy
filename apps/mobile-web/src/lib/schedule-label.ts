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
    const suffix = h < 12 ? 'am' : 'pm';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return m === 0 ? `${hour12}${suffix}` : `${hour12}:${String(m).padStart(2, '0')}${suffix}`;
  };
  if (hour.includes('*')) return 'Hourly';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (dow !== '*' && !dow.includes('*')) {
    const day = days[Number(dow)] ?? dow;
    return `${day} ${at()}`;
  }
  if (dom !== '*' && !dom.includes('*')) return `Monthly ${at()}`;
  return `Daily ${at()}`;
}
