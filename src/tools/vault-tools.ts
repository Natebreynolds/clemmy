import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  TASKS_FILE,
  appendTodayNote,
  ensureTasksFile,
  noteFolderForType,
  nextTaskId,
  parseTasks,
  replaceFile,
  safeTitle,
  textResult,
} from './shared.js';
import { VAULT_DIR } from '../memory/vault.js';

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
    'note_take',
    'Append a quick capture to today’s daily note.',
    { content: z.string().min(1) },
    async ({ content }) => {
      const noteName = appendTodayNote(content);
      return textResult(`Appended to ${noteName}`);
    },
  );

  server.tool(
    'task_list',
    'List tasks from the master task list.',
    {
      status: z.enum(['all', 'pending', 'completed']).optional(),
      project: z.string().optional(),
    },
    async ({ status, project }) => {
      ensureTasksFile();
      const tasks = parseTasks(readFileSync(TASKS_FILE, 'utf-8'))
        .filter((task) => !status || status === 'all' || task.status === status)
        .filter((task) => !project || task.project.toLowerCase() === project.toLowerCase());

      if (tasks.length === 0) {
        return textResult('No tasks found matching the criteria.');
      }

      return textResult(tasks.map((task) => `- [${task.status}] {${task.id}} ${task.description}`).join('\n'));
    },
  );

  server.tool(
    'task_add',
    "Add a SINGLE one-shot task to the user's TODO list. Use ONLY for one-time todos like \"remind me to call Bob tomorrow\" or \"add to my list: review the Q3 plan\". DO NOT use for recurring or scheduled work (\"daily\", \"every Monday\", \"at 6pm\", \"weekly\", \"every hour\") — for those, call workflow_create + workflow_schedule instead (workflows actually fire on a cron; tasks just sit in the list). The handler rejects descriptions that contain recurring language to prevent misroutes.",
    {
      description: z.string().min(1),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      due_date: z.string().optional(),
      project: z.string().optional(),
    },
    async ({ description, priority, due_date, project }) => {
      // Tier-2 architectural guard: task_add is one-shot. If the model
      // tried to use it for recurring/scheduled work (the lunar-audit-style
      // miscall from sess-mpf3h80a where Clementine called task_add for a
      // "daily at 6pm" request), refuse with a message that names the
      // correct tools so the model self-corrects in one retry.
      // Only match unambiguously recurring language. The earlier draft
      // included `at\s+\d{1,2}\s*(am|pm)` which false-positived on
      // common one-shot reminders like "remind me at 3pm tomorrow" —
      // a perfectly valid task_add use case. Time-of-day alone is NOT
      // a recurrence signal; recurrence is signaled by cadence words
      // (daily/weekly/...) or quantifiers (every X, each X).
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

      return textResult(`Added task {${taskId}}: ${description}`);
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
