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
    'Add a new task to the master task list.',
    {
      description: z.string().min(1),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      due_date: z.string().optional(),
      project: z.string().optional(),
    },
    async ({ description, priority, due_date, project }) => {
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
