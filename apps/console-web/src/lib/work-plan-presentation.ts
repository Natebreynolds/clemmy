import type { ActivityItem } from './useChat';

/** Mechanical id → human label. `social_lookup` becomes `Social lookup`.
 *  Compiler node ids (`n5:retrieve`) drop the index — that is IR, not work. */
export function humanizeRequirementId(id: string): string {
  const words = id.trim()
    .replace(/^n\d+:/i, '')
    .replace(/[_:./-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!words) return id;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

export function isWorkPlanRow(item: Pick<ActivityItem, 'id' | 'kind'>): boolean {
  return item.kind === 'event' && item.id.startsWith('ew-');
}

/** Effect is the work. Node kind (`retrieve` / `execute`) is compiler IR. */
export function workPlanStepLabel(line: {
  id: string;
  effect?: unknown;
}, done = false): string {
  const effect = typeof line.effect === 'string' ? line.effect : '';
  if (effect === 'read') return done ? 'Looked this up' : 'Looking this up';
  if (effect === 'external_write') return done ? 'Wrote it' : 'Writing';
  if (effect === 'local_write') return done ? 'Saved it' : 'Saving';
  if (effect === 'compute') return done ? 'Worked it out' : 'Working it out';
  if (effect === 'admin') return done ? 'Set up' : 'Setting up';
  const human = humanizeRequirementId(line.id);
  return done ? `${human} — done` : human;
}

/** One host plan-card line as a strip row. Sequencing is not a user-facing
 *  block: a later write waiting on the read stays off the strip until it is
 *  the work. */
export function workPlanActivityItem(line: {
  id: string;
  effect?: unknown;
  state?: unknown;
  dependsOn?: unknown;
}): ActivityItem | null {
  const state = typeof line.state === 'string' ? line.state : '';
  if (state === 'blocked_on_dependency') return null;
  if (state === 'satisfied' || state === 'data_in') {
    return {
      id: `ew-${line.id}`,
      kind: 'event',
      variant: 'lifecycle',
      label: workPlanStepLabel(line, true),
      status: 'done',
      tone: 'success',
    };
  }
  return {
    id: `ew-${line.id}`,
    kind: 'event',
    variant: 'lifecycle',
    label: workPlanStepLabel(line),
    status: 'running',
    tone: 'live',
  };
}
