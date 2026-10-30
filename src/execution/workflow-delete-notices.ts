/**
 * A deleted workflow needs nothing more from the owner. Its unread notices — a
 * stopped run, a failed step, a creation test that found issues — are read
 * with it, so Today and Needs you never keep a row for a workflow that is
 * gone. A notice belongs to the workflow when it names the workflow (slug or
 * the name the owner sees) or one of its runs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadNotifications, markNotificationsRead } from '../runtime/notifications.js';
import { WORKFLOW_RUNS_DIR } from '../tools/shared.js';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export function settleNoticesOfDeletedWorkflow(slug: string, displayName?: string): number {
  const names = new Set([slug, displayName].map(text).filter((name): name is string => Boolean(name)).map((name) => name.toLowerCase()));
  if (names.size === 0) return 0;
  const workflowOfRun = new Map<string, string | undefined>();
  const ranWorkflow = (runId: string): string | undefined => {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(runId)) return undefined;
    if (!workflowOfRun.has(runId)) {
      try {
        const record = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, `${runId}.json`), 'utf8')) as { workflow?: unknown };
        workflowOfRun.set(runId, text(record.workflow));
      } catch {
        workflowOfRun.set(runId, undefined);
      }
    }
    return workflowOfRun.get(runId);
  };
  const ids = loadNotifications()
    .filter((notification) => !notification.read)
    .filter((notification) => {
      const meta = notification.metadata ?? {};
      const named = text(meta.workflowSlug) ?? text(meta.workflow);
      if (named && names.has(named.toLowerCase())) return true;
      const runId = text(meta.runId) ?? text(meta.workflowRunId);
      const ran = runId ? ranWorkflow(runId) : undefined;
      return Boolean(ran && names.has(ran.toLowerCase()));
    })
    .map((notification) => notification.id);
  return ids.length > 0 ? markNotificationsRead(ids).cleared.length : 0;
}
