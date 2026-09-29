import type { ApprovalPreview } from './types.js';

type Field = ApprovalPreview['fields'][number];

export function approvalFieldText(field: Field): string {
  if (field.label) return `${field.label} · ${field.value}`;
  if (field.name === 'attendees_info') {
    try {
      const values: unknown = JSON.parse(field.value);
      if (Array.isArray(values) && values.length && values.every(v => v && typeof v === 'object'
        && typeof v.email === 'string' && Object.keys(v).every(k => ['email', 'name', 'type'].includes(k)))) {
        return values.map(v => `${v.name ? `${v.name} · ` : ''}${v.email}${v.type ? ` (${v.type})` : ''}`).join('\n');
      }
      if (Array.isArray(values) && values.length && values.every(v => v && typeof v === 'object'
        && typeof v.emailAddress === 'object' && typeof v.emailAddress?.address === 'string'
        && Object.keys(v).every(k => ['emailAddress', 'type'].includes(k))
        && Object.keys(v.emailAddress).every(k => ['address', 'name'].includes(k)))) {
        return values.map(v => `${v.emailAddress.name ? `${v.emailAddress.name} · ` : ''}${v.emailAddress.address}${v.type ? ` (${v.type})` : ''}`).join('\n');
      }
    } catch { /* Keep unfamiliar schemas exact and visible. */ }
  }
  return field.value;
}

/** Calendar wall times are already in the displayed zone. Never reinterpret
 * them in the device zone, which can move an all-day event to yesterday. */
function wallDate(value: string, dateOnly = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) return null;
  const date = new Date(`${value}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
    ...(!dateOnly ? { hour: 'numeric', minute: '2-digit' } as const : {}) }).format(date);
}

export function approvalReview(preview: ApprovalPreview) {
  const items = preview.items;
  if (!items?.length) return null;
  // Deduplicate only exact fields, including labels. A different recipient or
  // setting stays on the individual action where the person can see it.
  const common = items[0]!.fields.filter(field => !['subject', 'title', 'start_datetime', 'end_datetime'].includes(field.name)
    && items.every(item => item.fields.some(other => JSON.stringify(other) === JSON.stringify(field))));
  return {
    common: [...preview.fields.filter(field => field.name !== 'Prepared actions'), ...common],
    items: items.map(item => {
      const fields = item.fields.filter(field => !common.some(shared => JSON.stringify(shared) === JSON.stringify(field)));
      const get = (key: string) => item.fields.find(field => field.name === key)?.value;
      const title = get('subject') ?? get('title') ?? item.operation;
      const start = get('start_datetime');
      const end = get('end_datetime');
      const allDay = get('is_all_day') === 'true';
      const zone = get('time_zone');
      let when: string | undefined;
      if (start && end && zone) {
        const shownStart = wallDate(start, allDay);
        const shownEnd = wallDate(end, allDay);
        if (shownStart && shownEnd && end > start) {
          if (allDay && start.endsWith('T00:00:00') && end.endsWith('T00:00:00')) {
            const lastDay = new Date(new Date(`${end}Z`).getTime() - 86_400_000).toISOString().slice(0, 19);
            when = `${shownStart}${lastDay.slice(0, 10) !== start.slice(0, 10) ? ` – ${wallDate(lastDay, true)}` : ''} · All day · ${zone}`;
          } else if (!allDay) {
            const endLabel = start.slice(0, 10) === end.slice(0, 10)
              ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(new Date(`${end}Z`))
              : shownEnd;
            when = `${shownStart} – ${endLabel} · ${zone}`;
          }
        }
      }
      if (when && common.some(field => field.name === 'time_zone')) when = when.replace(` · ${zone}`, '');
      const availability = get('show_as');
      if (when && (availability === 'free' || availability === 'busy')) when += ` · ${availability === 'free' ? 'Free' : 'Busy'}`;
      return { title, when, check: item.check,
        fields: fields.filter(field => !['subject', 'title'].includes(field.name)
          && !(when && ['start_datetime', 'end_datetime', 'is_all_day', 'time_zone', 'body'].includes(field.name))
          && !(when && ['free', 'busy'].includes(availability ?? '') && field.name === 'show_as')),
        exact: item.fields,
      };
    }),
  };
}
