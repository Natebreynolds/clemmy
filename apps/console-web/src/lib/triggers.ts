import { apiGet, apiPost } from './api';
import type { WatchRow } from './watches';
import type { WorkflowUpcoming } from './automate';

export interface TriggerWorkflowRow {
  name: string;
  slug: string;
  enabled: boolean;
  description: string | null;
  schedule: string | null;
  timezone: string | null;
  onceAt: string | null;
  interval: unknown | null;
  webhookPath: string | null;
  webhookKey: string | null;
  events: string[];
  manual: boolean;
  lastRun: { runId: string; at: string | null; status: string | null; outcome: string | null } | null;
}

export interface ReminderRow { id: string; message: string; fireAt: string; createdAt: string }

export interface TriggersView {
  generatedAt: string;
  workflows: TriggerWorkflowRow[];
  upcoming: WorkflowUpcoming[];
  watches: WatchRow[];
  reminders: ReminderRow[];
  webhookBase: string;
}

export const getTriggers = () => apiGet<TriggersView>('/api/console/triggers');
export const cancelReminder = (id: string) => apiPost<{ cancelled: string[] }>(`/api/console/reminders/${encodeURIComponent(id)}/cancel`, {});
