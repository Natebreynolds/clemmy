import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { TASKS_FILE, ensureTasksFile, parseTasks } from '../tools/shared.js';
import type { ExecutionRecord } from '../types.js';

const EXECUTIONS_FILE = path.join(BASE_DIR, 'state', 'executions.json');

export interface TaskLedgerHygieneOptions {
  apply?: boolean;
  closeUnownedBefore?: string | Date;
  now?: Date;
}

export interface TaskLedgerHygieneResult {
  mode: 'apply' | 'dry-run';
  baseDir: string;
  pendingTasks: number;
  repairableTasks: number;
  completedOwnerTasks: number;
  staleUnownedTasks: number;
  closeUnownedBefore: string | null;
  checkedTaskRows: number;
  compactedTaskRows: number;
  updatedBindings: number;
  sampleTaskIds: string[];
}

export interface CompactTaskLedgerResult {
  body: string;
  checkedTaskRows: number;
  compactedTaskRows: number;
}

function loadExecutions(): ExecutionRecord[] {
  if (!existsSync(EXECUTIONS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(EXECUTIONS_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed as ExecutionRecord[] : [];
  } catch {
    return [];
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function localDayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function previousLocalDayKey(date = new Date()): string {
  const previous = new Date(date);
  previous.setDate(previous.getDate() - 1);
  return localDayKey(previous);
}

function normalizeCutoff(value: string | Date | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return localDayKey(value);
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === 'today') return localDayKey(new Date());
  if (trimmed === 'yesterday') return previousLocalDayKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error('closeUnownedBefore must be today, yesterday, YYYY-MM-DD, or a Date.');
  }
  return trimmed;
}

function taskLineId(line: string): string | undefined {
  return line.match(/\{(T-\d+)\}/)?.[1];
}

function isTaskLine(line: string): boolean {
  return /^\s*-\s+\[[ xX]\]/.test(line);
}

function isCheckedTaskLine(line: string): boolean {
  return /^\s*-\s+\[[xX]\]/.test(line);
}

function checkTaskLine(line: string): string {
  return line.replace(/^(\s*-\s+\[) (\])/, '$1x$2');
}

function trimBlankEdges(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[0].trim() === '') copy.shift();
  while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop();
  return copy;
}

export function closeAndCompactTaskLedgerBody(body: string, taskIdsToClose: Set<string>): CompactTaskLedgerResult {
  const lines = body.split('\n');
  const pendingHeaderIndex = lines.findIndex((line) => line.trim() === '## Pending');
  const completedHeaderIndex = lines.findIndex((line) => line.trim() === '## Completed');
  if (pendingHeaderIndex === -1 || completedHeaderIndex === -1 || completedHeaderIndex <= pendingHeaderIndex) {
    let checkedTaskRows = 0;
    const next = lines.map((line) => {
      const id = taskLineId(line);
      if (!id || !taskIdsToClose.has(id) || !isTaskLine(line) || isCheckedTaskLine(line)) return line;
      checkedTaskRows += 1;
      return checkTaskLine(line);
    });
    return {
      body: `${next.join('\n').replace(/\n+$/, '')}\n`,
      checkedTaskRows,
      compactedTaskRows: 0,
    };
  }

  const beforePending = lines.slice(0, pendingHeaderIndex + 1);
  const pendingBody = lines.slice(pendingHeaderIndex + 1, completedHeaderIndex);
  const completedBody = lines.slice(completedHeaderIndex + 1);
  const existingCompletedIds = new Set(completedBody.map(taskLineId).filter((id): id is string => Boolean(id)));
  const pendingKeep: string[] = [];
  const completedAdd: string[] = [];
  let checkedTaskRows = 0;
  let compactedTaskRows = 0;

  for (const line of pendingBody) {
    const id = taskLineId(line);
    if (!id || !isTaskLine(line)) {
      pendingKeep.push(line);
      continue;
    }
    const shouldClose = taskIdsToClose.has(id);
    const checked = isCheckedTaskLine(line);
    if (!shouldClose && !checked) {
      pendingKeep.push(line);
      continue;
    }

    const completedLine = checked ? line : checkTaskLine(line);
    if (shouldClose && !checked) checkedTaskRows += 1;
    if (!existingCompletedIds.has(id)) {
      completedAdd.push(completedLine);
      existingCompletedIds.add(id);
    }
    compactedTaskRows += 1;
  }

  const nextLines = [
    ...trimBlankEdges(beforePending),
    '',
    ...trimBlankEdges(pendingKeep),
    '',
    '## Completed',
    '',
    ...trimBlankEdges(completedAdd),
    ...(completedAdd.length > 0 && trimBlankEdges(completedBody).length > 0 ? [''] : []),
    ...trimBlankEdges(completedBody),
  ];

  return {
    body: `${nextLines.join('\n').replace(/\n+$/, '')}\n`,
    checkedTaskRows,
    compactedTaskRows,
  };
}

export function runTaskLedgerHygiene(options: TaskLedgerHygieneOptions = {}): TaskLedgerHygieneResult {
  const apply = options.apply === true;
  const closeUnownedBefore = normalizeCutoff(options.closeUnownedBefore);
  ensureTasksFile();
  const taskBody = readFileSync(TASKS_FILE, 'utf-8');
  const pendingTasks = parseTasks(taskBody).filter((task) => task.status === 'pending');
  const pendingTaskIds = new Set(pendingTasks.map((task) => task.id).filter(Boolean));
  const executions = loadExecutions();
  const completedOwnerTaskIds = new Set<string>();
  const ownerTaskIds = new Set<string>();

  for (const execution of executions) {
    for (const binding of execution.taskBindings ?? []) {
      ownerTaskIds.add(binding.taskId);
    }
    if (execution.status !== 'completed') continue;
    for (const binding of execution.taskBindings ?? []) {
      if (pendingTaskIds.has(binding.taskId)) {
        completedOwnerTaskIds.add(binding.taskId);
      }
    }
  }

  const staleUnownedTaskIds = new Set<string>();
  if (closeUnownedBefore) {
    for (const task of pendingTasks) {
      if (!task.id || ownerTaskIds.has(task.id)) continue;
      if (task.dueDate && task.dueDate <= closeUnownedBefore) {
        staleUnownedTaskIds.add(task.id);
      }
    }
  }

  const repairedTaskIds = unique([...completedOwnerTaskIds, ...staleUnownedTaskIds])
    .sort((left, right) => right.localeCompare(left));
  const repairedTaskSet = new Set(repairedTaskIds);
  const compacted = closeAndCompactTaskLedgerBody(taskBody, repairedTaskSet);

  const nowIso = (options.now ?? new Date()).toISOString();
  let updatedBindings = 0;
  const nextExecutions = executions.map((execution) => {
    if (execution.status !== 'completed' || !execution.taskBindings?.length) return execution;
    let changed = false;
    const taskBindings = execution.taskBindings.map((binding) => {
      if (!repairedTaskSet.has(binding.taskId) || binding.status === 'completed') return binding;
      changed = true;
      updatedBindings += 1;
      return {
        ...binding,
        status: 'completed' as const,
        completedAt: binding.completedAt ?? execution.updatedAt ?? nowIso,
      };
    });
    return changed ? { ...execution, taskBindings } : execution;
  });

  if (apply) {
    writeFileSync(TASKS_FILE, compacted.body, 'utf-8');
    if (updatedBindings > 0) {
      writeFileSync(EXECUTIONS_FILE, JSON.stringify(nextExecutions, null, 2), 'utf-8');
    }
  }

  return {
    mode: apply ? 'apply' : 'dry-run',
    baseDir: BASE_DIR,
    pendingTasks: pendingTaskIds.size,
    repairableTasks: repairedTaskIds.length,
    completedOwnerTasks: completedOwnerTaskIds.size,
    staleUnownedTasks: staleUnownedTaskIds.size,
    closeUnownedBefore,
    checkedTaskRows: compacted.checkedTaskRows,
    compactedTaskRows: compacted.compactedTaskRows,
    updatedBindings,
    sampleTaskIds: repairedTaskIds.slice(0, 20),
  };
}

export function formatTaskLedgerHygieneResult(result: TaskLedgerHygieneResult): string {
  return [
    `Task ledger hygiene (${result.mode})`,
    `Pending before: ${result.pendingTasks}`,
    `Repaired: ${result.repairableTasks} (${result.completedOwnerTasks} completed-owner, ${result.staleUnownedTasks} stale-unowned)`,
    `Checked rows: ${result.checkedTaskRows}`,
    `Compacted rows out of Pending: ${result.compactedTaskRows}`,
    `Updated execution bindings: ${result.updatedBindings}`,
    result.closeUnownedBefore ? `Stale-unowned cutoff: ${result.closeUnownedBefore}` : '',
    result.sampleTaskIds.length > 0 ? `Sample: ${result.sampleTaskIds.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}
