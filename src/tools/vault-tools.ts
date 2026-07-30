import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TASKS_FILE,
  ensureTasksFile,
  noteFolderForType,
  nextTaskId,
  parseTasks,
  replaceFile,
  safeTitle,
  textResult,
  type ParsedTask,
} from './shared.js';
import { VAULT_DIR } from '../memory/vault.js';
import { ExecutionStore } from '../execution/store.js';
import {
  formatTaskLedgerHygieneResult,
  runTaskLedgerHygiene,
} from '../tasks/task-ledger-hygiene.js';

interface TaskTimeline {
  createdAt?: string;
  completedAt?: string;
  ownerCompletedAt?: string;
}

function parseSinceCutoff(value: string): { cutoffMs: number } | { error: string } {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  const date = new Date();

  if (lower === 'today') {
    date.setHours(0, 0, 0, 0);
    return { cutoffMs: date.getTime() };
  }
  if (lower === 'yesterday') {
    date.setDate(date.getDate() - 1);
    date.setHours(0, 0, 0, 0);
    return { cutoffMs: date.getTime() };
  }

  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? Date.parse(`${trimmed}T00:00:00`)
    : Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return { error: `Invalid since filter "${value}". Use today, yesterday, YYYY-MM-DD, or an ISO datetime.` };
  }
  return { cutoffMs: parsed };
}

function earlierIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) < Date.parse(left) ? right : left;
}

function laterIso(...values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function taskTimestampForSince(task: ParsedTask, timeline?: TaskTimeline): string | undefined {
  if (task.status === 'completed') {
    return laterIso(timeline?.completedAt, timeline?.ownerCompletedAt);
  }
  return timeline?.createdAt;
}

function loadTaskTimelines(): Map<string, TaskTimeline> {
  const timelines = new Map<string, TaskTimeline>();
  for (const execution of new ExecutionStore().list(5000)) {
    for (const binding of execution.taskBindings ?? []) {
      const current = timelines.get(binding.taskId) ?? {};
      current.createdAt = earlierIso(current.createdAt, binding.createdAt);
      current.completedAt = laterIso(current.completedAt, binding.completedAt);
      if (execution.status === 'completed') {
        current.ownerCompletedAt = laterIso(current.ownerCompletedAt, binding.completedAt, execution.updatedAt);
      }
      timelines.set(binding.taskId, current);
    }
  }
  return timelines;
}

function formatTask(task: ParsedTask): string {
  const meta = [
    task.priority ? `priority=${task.priority}` : '',
    task.dueDate ? `due=${task.dueDate}` : '',
    task.project ? `project=${task.project}` : '',
  ].filter(Boolean).join(', ');
  return `- [${task.status}] {${task.id}} ${task.description}${meta ? ` (${meta})` : ''}`;
}

export function registerVaultTools(server: McpServer): void {
  server.tool(
    'note_create',
    'Create a new note in the vault.',
    {
      note_type: z.enum(['person', 'project', 'topic', 'task', 'inbox']),
      title: z.string().min(1),
      content: z.string().optional(),
    },
    async ({ note_type, title, content }) => {
      const folder = noteFolderForType(note_type);
      const cleanedTitle = safeTitle(title);
      const notePath = path.join(folder, `${cleanedTitle}.md`);

      if (existsSync(notePath)) {
        return textResult(`Already exists: ${path.relative(VAULT_DIR, notePath)}`);
      }

      const body = content?.trim() || `# ${cleanedTitle}\n`;
      replaceFile(notePath, body);
      return textResult(`Created ${path.relative(VAULT_DIR, notePath)}`);
    },
  );

  server.tool(
    'task_list',
    'List tasks from the master task list.',
    {
      status: z.enum(['all', 'pending', 'completed']).optional(),
      project: z.string().optional(),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      since: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    async ({ status, project, priority, since, limit }) => {
      ensureTasksFile();
      let tasks = parseTasks(readFileSync(TASKS_FILE, 'utf-8'))
        .filter((task) => !status || status === 'all' || task.status === status)
        .filter((task) => !project || task.project.toLowerCase() === project.toLowerCase())
        .filter((task) => !priority || task.priority === priority);

      const notes: string[] = [];
      if (since) {
        const cutoff = parseSinceCutoff(since);
        if ('error' in cutoff) {
          return textResult(cutoff.error);
        }
        const timelines = loadTaskTimelines();
        tasks = tasks.filter((task) => {
          const timestamp = taskTimestampForSince(task, timelines.get(task.id));
          return Boolean(timestamp && Date.parse(timestamp) >= cutoff.cutoffMs);
        });
        notes.push('Note: since filtering uses execution task-binding timestamps; manual TASKS.md rows without timestamps are excluded.');
      }

      const total = tasks.length;
      if (limit && tasks.length > limit) {
        tasks = tasks.slice(0, limit);
        notes.push(`Showing ${tasks.length} of ${total} matching tasks.`);
      }

      if (tasks.length === 0) {
        return textResult([...notes, 'No tasks found matching the criteria.'].join('\n'));
      }

      return textResult([...notes, ...tasks.map(formatTask)].join('\n'));
    },
  );

  server.tool(
    'task_hygiene',
    'Repair and compact the task ledger so completed execution-owned tasks do not remain in the active queue. Dry-run by default; set apply=true to mutate TASKS.md and execution bindings.',
    {
      apply: z.boolean().optional(),
      close_stale_unowned_before: z.string().optional(),
    },
    async ({ apply, close_stale_unowned_before }) => {
      try {
        const result = runTaskLedgerHygiene({
          apply: apply === true,
          closeUnownedBefore: close_stale_unowned_before,
        });
        return textResult(formatTaskLedgerHygieneResult(result));
      } catch (error) {
        return textResult(`Task ledger hygiene failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'task_add',
    "Add a SINGLE passive item to the user's TODO list, such as \"add to my list: review the Q3 plan\". This tool NEVER fires or sends a notification. For \"remind/notify me at 10 PM tonight\" use set_timer; for recurring or later scheduled work use workflow_create + workflow_schedule.",
    {
      description: z.string().min(1),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      due_date: z.string().optional(),
      project: z.string().optional(),
    },
    async ({ description, priority, due_date, project }) => {
      // TASKS.md stores passive work and its reader reduces due timestamps to a
      // calendar date. Accepting an exact time here is therefore misleading:
      // it cannot wake the daemon or notify the user. Refuse it at the tool
      // boundary so a reminder request self-corrects to the firing capability.
      const hasReminderIntent = /\breminder\b|\b(?:remind|notify|alert|ping|nudge|tell)\s+(?:me|us)\b|\blet\s+(?:me|us)\s+know\b/i.test(description);
      const hasExactDueTime = typeof due_date === 'string'
        && (/[T ]\d{1,2}:\d{2}(?::\d{2})?/.test(due_date) || /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i.test(due_date));
      if (hasReminderIntent || hasExactDueTime) {
        return textResult(
          'task_add refused: this looks like a reminder, but task_add would create only a passive TODO and would not notify the user. '
          + 'For a one-time reminder within 24 hours, call set_timer with fire_at (an ISO timestamp with an explicit offset). '
          + 'For later or recurring work, use workflow_create + workflow_schedule.',
        );
      }

      // Recurring commitments belong to the workflow scheduler, not a passive
      // one-shot task record.
      const RECURRING_PATTERN = /\b(daily|weekly|monthly|hourly|every\s+(day|week|month|hour|morning|afternoon|evening|night|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each\s+(day|week|month|hour|morning|afternoon|evening|night|weekday|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|recurring|repeats?|on\s+a\s+schedule)\b/i;
      const match = description.match(RECURRING_PATTERN);
      if (match) {
        return textResult(
          `task_add refused: description contains recurring/scheduled language ("${match[0]}"). `
          + `task_add is for one-shot todos only. For recurring or scheduled work, call workflow_create `
          + `(to define the steps) + workflow_schedule (to set the cron) instead. `
          + `Call workflow_list first if you want to see existing examples.`,
        );
      }

      ensureTasksFile();
      let body = readFileSync(TASKS_FILE, 'utf-8');
      const taskId = nextTaskId(body);
      const meta = [
        priority ? `!!${priority}` : '',
        due_date ? `📅 ${due_date}` : '',
        project ? `#project:${project}` : '',
      ].filter(Boolean).join(' ');
      const taskLine = `- [ ] {${taskId}} ${description}${meta ? ` ${meta}` : ''}`;

      const marker = '## Pending\n';
      const insertAt = body.includes(marker) ? body.indexOf(marker) + marker.length : body.length;
      body = `${body.slice(0, insertAt)}\n${taskLine}${body.slice(insertAt)}`;
      writeFileSync(TASKS_FILE, body, 'utf-8');

      return textResult(`Added passive TODO {${taskId}}: ${description}. No reminder notification was scheduled.`);
    },
  );

  server.tool(
    'task_update',
    'Update a task by ID and optionally move it between pending and completed.',
    {
      task_id: z.string().min(1),
      status: z.enum(['pending', 'completed']).optional(),
      description: z.string().optional(),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      due_date: z.string().optional(),
    },
    async ({ task_id, status, description, priority, due_date }) => {
      ensureTasksFile();
      const body = readFileSync(TASKS_FILE, 'utf-8');
      const lines = body.split('\n');
      const normalized = task_id.replace(/[{}]/g, '').startsWith('T-') ? task_id.replace(/[{}]/g, '') : `T-${task_id.replace(/[{}]/g, '')}`;
      const index = lines.findIndex((line) => line.includes(`{${normalized}}`) && /^\s*-\s+\[[ xX]\]/.test(line));

      if (index === -1) {
        return textResult(`Task not found: ${task_id}`);
      }

      const existing = parseTasks(lines[index])[0];
      if (!existing) {
        return textResult(`Task could not be parsed: ${task_id}`);
      }
      const nextStatus = status || existing.status;
      const nextDescription = description || existing.description;
      const nextPriority = priority || existing.priority;
      const nextDueDate = due_date !== undefined ? due_date : existing.dueDate;
      const projectTag = existing.project ? ` #project:${existing.project}` : '';
      const priorityTag = nextPriority ? ` !!${nextPriority}` : '';
      const dueTag = nextDueDate ? ` 📅 ${nextDueDate}` : '';
      const checkbox = nextStatus === 'completed' ? 'x' : ' ';

      lines[index] = `- [${checkbox}] {${normalized}} ${nextDescription}${priorityTag}${dueTag}${projectTag}`;
      writeFileSync(TASKS_FILE, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf-8');

      return textResult(`Updated task {${normalized}}.`);
    },
  );
}
