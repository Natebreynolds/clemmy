import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { ClementineAssistant } from '../assistant/core.js';
import { MODELS, getRuntimeEnv } from '../config.js';
import { ExecutionStore } from '../execution/store.js';
import { addNotification } from '../runtime/notifications.js';
import {
  AGENT_INBOX_DIR,
  AGENT_STATE_DIR,
  DELEGATIONS_DIR,
  GOALS_DIR,
  TASKS_FILE,
  TEAM_COMMS_LOG,
  TEAM_REQUESTS_DIR,
  TeamAgentRecord,
  appendTodayNote,
  ensureDir,
  ensureTasksFile,
  loadTeamAgents,
  nextTaskId,
  parseTasks,
} from '../tools/shared.js';

const logger = pino({ name: 'clementine-next.agents' });
const AUTONOMY_V2_AGENTS_ENV = 'AUTONOMY_V2_AGENTS';

type InboxItemType = 'message' | 'request' | 'delegation' | 'task_review' | 'daily_review' | 'system';

interface AgentInboxItem {
  id: string;
  type: InboxItemType;
  createdAt: string;
  status: 'pending' | 'processed';
  fromAgent?: string;
  sourceKey?: string;
  content: string;
  metadata?: Record<string, unknown>;
  processedAt?: string;
}

interface AgentStateRecord {
  slug: string;
  lastRunAt?: string;
  lastWakeAt?: string;
  lastWakeReasons?: string[];
  lastSummary?: string;
  commitments?: string[];
  nextWakeAt?: string;
  lastError?: string;
}

interface GoalRecord {
  id: string;
  title: string;
  status: 'active' | 'paused' | 'completed' | 'blocked';
  priority: 'high' | 'medium' | 'low';
  owner: string;
  targetDate?: string;
  nextActions: string[];
  progressNotes: string[];
  blockers: string[];
  description: string;
  updatedAt: string;
}

function loadActiveGoals(): GoalRecord[] {
  if (!existsSync(GOALS_DIR)) return [];
  try {
    return readdirSync(GOALS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(path.join(GOALS_DIR, f), 'utf-8')) as GoalRecord;
        } catch {
          return null;
        }
      })
      .filter((g): g is GoalRecord => g !== null && (g.status === 'active' || g.status === 'blocked'))
      .sort((a, b) => {
        const pri = { high: 0, medium: 1, low: 2 };
        return (pri[a.priority] ?? 1) - (pri[b.priority] ?? 1);
      });
  } catch {
    return [];
  }
}

function updateGoal(goalId: string, update: {
  status?: GoalRecord['status'];
  progressNote?: string;
  nextActions?: string[];
  blockers?: string[];
}): void {
  const filePath = path.join(GOALS_DIR, `${goalId}.json`);
  if (!existsSync(filePath)) return;
  try {
    const goal = JSON.parse(readFileSync(filePath, 'utf-8')) as GoalRecord;
    if (update.status) goal.status = update.status;
    if (update.progressNote) {
      goal.progressNotes = goal.progressNotes ?? [];
      goal.progressNotes.push(`[${new Date().toISOString().slice(0, 16)}] ${update.progressNote}`);
    }
    if (update.nextActions) goal.nextActions = update.nextActions;
    if (update.blockers) goal.blockers = update.blockers;
    goal.updatedAt = new Date().toISOString();
    writeFileSync(filePath, JSON.stringify(goal, null, 2), 'utf-8');
  } catch {
    // Ignore if goal file is corrupt
  }
}

interface AgentAction {
  type: 'message_agent' | 'reply_request' | 'complete_delegation' | 'create_task' | 'update_task' | 'note' | 'notify_user' | 'delegate' | 'update_goal' | 'noop';
  to?: string;
  content?: string;
  requestId?: string;
  response?: string;
  delegationId?: string;
  result?: string;
  description?: string;
  priority?: 'high' | 'medium' | 'low';
  dueDate?: string;
  project?: string;
  taskId?: string;
  status?: 'pending' | 'completed';
  title?: string;
  body?: string;
  task?: string;
  expectedOutput?: string;
  reason?: string;
  // update_goal fields
  goalId?: string;
  goalNote?: string;
  goalStatus?: 'active' | 'paused' | 'completed' | 'blocked';
  goalNextActions?: string[];
  goalBlockers?: string[];
}

interface AgentDecision {
  summary: string;
  actions: AgentAction[];
  commitments: string[];
  followUpMinutes?: number;
}

interface TeamMessageRecord {
  id: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  timestamp: string;
  protocol: 'message' | 'request' | 'response';
  requestId?: string;
  respondedAt?: string;
}

interface TeamRequestRecord {
  id: string;
  fromAgent: string;
  toAgent: string;
  content: string;
  expectedBy?: string;
  createdAt: string;
  status: 'pending' | 'completed';
  response?: string;
  respondedAt?: string;
}

interface DelegationRecord {
  id: string;
  fromAgent: string;
  toAgent: string;
  task: string;
  expectedOutput: string;
  status: 'pending' | 'in_progress' | 'completed';
  result?: string;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_WAKE_TRIGGERS = ['inbox', 'delegation', 'request', 'stale_tasks', 'daily_review', 'execution_review'];

function inboxFilePath(slug: string): string {
  return path.join(AGENT_INBOX_DIR, `${slug}.json`);
}

function stateFilePath(slug: string): string {
  return path.join(AGENT_STATE_DIR, `${slug}.json`);
}

function requestFilePath(id: string): string {
  return path.join(TEAM_REQUESTS_DIR, `${id}.json`);
}

function delegationFilePath(toAgent: string, id: string): string {
  return path.join(DELEGATIONS_DIR, toAgent, `${id}.json`);
}

function loadJsonArray<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function loadInbox(slug: string): AgentInboxItem[] {
  return loadJsonArray<AgentInboxItem>(inboxFilePath(slug));
}

function saveInbox(slug: string, items: AgentInboxItem[]): void {
  ensureDir(AGENT_INBOX_DIR);
  writeFileSync(inboxFilePath(slug), JSON.stringify(items, null, 2), 'utf-8');
}

function enqueueInboxItem(slug: string, item: Omit<AgentInboxItem, 'id' | 'createdAt' | 'status'>): void {
  const items = loadInbox(slug);
  if (item.sourceKey && items.some((entry) => entry.sourceKey === item.sourceKey)) {
    return;
  }
  items.push({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    ...item,
  });
  saveInbox(slug, items);
}

function markInboxProcessed(slug: string, ids: string[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const items = loadInbox(slug).map((item) => ids.includes(item.id)
    ? { ...item, status: 'processed' as const, processedAt: now }
    : item);
  saveInbox(slug, items);
}

function loadAgentState(slug: string): AgentStateRecord {
  const filePath = stateFilePath(slug);
  if (!existsSync(filePath)) {
    return { slug, commitments: [] };
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as AgentStateRecord;
  } catch {
    return { slug, commitments: [] };
  }
}

function saveAgentState(state: AgentStateRecord): void {
  ensureDir(AGENT_STATE_DIR);
  writeFileSync(stateFilePath(state.slug), JSON.stringify(state, null, 2), 'utf-8');
}

function readTeamMessages(): TeamMessageRecord[] {
  if (!existsSync(TEAM_COMMS_LOG)) return [];
  return readFileSync(TEAM_COMMS_LOG, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TeamMessageRecord;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is TeamMessageRecord => entry !== null);
}

function readTeamRequests(): TeamRequestRecord[] {
  if (!existsSync(TEAM_REQUESTS_DIR)) return [];
  return readdirSync(TEAM_REQUESTS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      try {
        return JSON.parse(readFileSync(path.join(TEAM_REQUESTS_DIR, file), 'utf-8')) as TeamRequestRecord;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is TeamRequestRecord => entry !== null);
}

function readDelegations(): DelegationRecord[] {
  if (!existsSync(DELEGATIONS_DIR)) return [];
  const records: DelegationRecord[] = [];
  for (const slug of readdirSync(DELEGATIONS_DIR)) {
    const dirPath = path.join(DELEGATIONS_DIR, slug);
    if (!existsSync(dirPath)) continue;
    for (const file of readdirSync(dirPath).filter((entry) => entry.endsWith('.json'))) {
      try {
        records.push(JSON.parse(readFileSync(path.join(dirPath, file), 'utf-8')) as DelegationRecord);
      } catch {
        continue;
      }
    }
  }
  return records;
}

function appendTeamComms(record: TeamMessageRecord): void {
  ensureDir(path.dirname(TEAM_COMMS_LOG));
  appendFileSync(TEAM_COMMS_LOG, `${JSON.stringify(record)}\n`, 'utf-8');
}

function saveTeamRequest(record: TeamRequestRecord): void {
  ensureDir(TEAM_REQUESTS_DIR);
  writeFileSync(requestFilePath(record.id), JSON.stringify(record, null, 2), 'utf-8');
}

function saveDelegation(record: DelegationRecord): void {
  const filePath = delegationFilePath(record.toAgent, record.id);
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
}

function defaultPrimaryAgent(teamAgents: TeamAgentRecord[]): TeamAgentRecord {
  return {
    slug: 'clementine',
    name: 'Clementine',
    description: 'Primary personal assistant and coordinator.',
    role: 'personal_assistant',
    canMessage: teamAgents.map((agent) => agent.slug),
    allowedTools: [],
    personality: 'You are Clementine, the primary assistant. Stay proactive, practical, and concise. Coordinate work across the team when helpful.',
    autonomyEnabled: true,
    proactive: true,
    cadenceMinutes: 30,
    wakeTriggers: DEFAULT_WAKE_TRIGGERS,
    tier: 2,
  };
}

function listAutonomyAgents(): TeamAgentRecord[] {
  const teamAgents = loadTeamAgents();
  const agents = [...teamAgents];
  if (!agents.some((agent) => agent.slug === 'clementine')) {
    agents.unshift(defaultPrimaryAgent(teamAgents));
  }
  return agents;
}

function readV2OwnedAgentSlugs(): Set<string> {
  return new Set(
    getRuntimeEnv(AUTONOMY_V2_AGENTS_ENV, '')
      .split(',')
      .map((slug) => slug.trim())
      .filter(Boolean),
  );
}

function normalizeWakeTriggers(agent: TeamAgentRecord): string[] {
  return agent.wakeTriggers && agent.wakeTriggers.length > 0 ? agent.wakeTriggers : DEFAULT_WAKE_TRIGGERS;
}

function pickTaskOwner(taskProject: string, agents: TeamAgentRecord[]): string {
  if (taskProject) {
    const match = agents.find((agent) => agent.project?.toLowerCase() === taskProject.toLowerCase());
    if (match) return match.slug;
  }
  return 'clementine';
}

function syncMessagesToInbox(agents: TeamAgentRecord[]): void {
  const agentSet = new Set(agents.map((agent) => agent.slug));
  for (const message of readTeamMessages()) {
    if (!agentSet.has(message.toAgent)) continue;
    enqueueInboxItem(message.toAgent, {
      type: message.protocol === 'request' ? 'request' : 'message',
      fromAgent: message.fromAgent,
      sourceKey: `team-message:${message.id}`,
      content: message.content,
      metadata: {
        protocol: message.protocol,
        requestId: message.requestId,
        respondedAt: message.respondedAt,
      },
    });
  }
}

function syncRequestsToInbox(agents: TeamAgentRecord[]): void {
  const agentSet = new Set(agents.map((agent) => agent.slug));
  for (const request of readTeamRequests()) {
    if (request.status !== 'pending' || !agentSet.has(request.toAgent)) continue;
    enqueueInboxItem(request.toAgent, {
      type: 'request',
      fromAgent: request.fromAgent,
      sourceKey: `team-request:${request.id}`,
      content: request.content,
      metadata: {
        requestId: request.id,
        expectedBy: request.expectedBy,
      },
    });
  }
}

function syncDelegationsToInbox(agents: TeamAgentRecord[]): void {
  const agentSet = new Set(agents.map((agent) => agent.slug));
  for (const delegation of readDelegations()) {
    if (delegation.status === 'completed' || !agentSet.has(delegation.toAgent)) continue;
    enqueueInboxItem(delegation.toAgent, {
      type: 'delegation',
      fromAgent: delegation.fromAgent,
      sourceKey: `delegation:${delegation.id}:${delegation.status}`,
      content: delegation.task,
      metadata: {
        delegationId: delegation.id,
        expectedOutput: delegation.expectedOutput,
        status: delegation.status,
      },
    });
  }
}

function syncTaskReviewsToInbox(agents: TeamAgentRecord[]): void {
  ensureTasksFile();
  const today = new Date().toISOString().slice(0, 10);
  const tasks = parseTasks(readFileSync(TASKS_FILE, 'utf-8'))
    .filter((task) => task.status === 'pending')
    .filter((task) => task.priority === 'high' || (task.dueDate && task.dueDate <= today));

  for (const task of tasks) {
    const owner = pickTaskOwner(task.project, agents);
    enqueueInboxItem(owner, {
      type: 'task_review',
      sourceKey: `task-review:${task.id}:${task.priority}:${task.dueDate}:${task.project}`,
      content: task.description,
      metadata: {
        taskId: task.id,
        project: task.project,
        priority: task.priority,
        dueDate: task.dueDate,
      },
    });
  }
}

function syncDailyReviewsToInbox(agents: TeamAgentRecord[]): void {
  const today = new Date().toISOString().slice(0, 10);
  for (const agent of agents) {
    if (!normalizeWakeTriggers(agent).includes('daily_review')) continue;
    enqueueInboxItem(agent.slug, {
      type: 'daily_review',
      sourceKey: `daily-review:${today}`,
      content: `Run a daily review for ${today}. Check open commitments, overdue tasks, and needed follow-ups.`,
      metadata: { date: today },
    });
  }
}

function syncExecutionReviewsToInbox(agents: TeamAgentRecord[]): void {
  const executions = new ExecutionStore()
    .list(12)
    .filter((execution) => execution.status === 'active' || execution.status === 'blocked');

  for (const execution of executions) {
    const ageMinutes = Math.floor((Date.now() - new Date(execution.lastActivityAt).getTime()) / 60_000);
    if (ageMinutes < 30) continue;

    enqueueInboxItem('clementine', {
      type: 'system',
      sourceKey: `execution-review:${execution.id}:${execution.updatedAt}`,
      content: `Review tracked execution "${execution.title}" and decide the next move.`,
      metadata: {
        executionId: execution.id,
        objective: execution.objective,
        nextStep: execution.nextStep,
        ageMinutes,
        status: execution.status,
      },
    });
  }
}

function syncAutonomyInputs(): TeamAgentRecord[] {
  const agents = listAutonomyAgents();
  syncMessagesToInbox(agents);
  syncRequestsToInbox(agents);
  syncDelegationsToInbox(agents);
  syncTaskReviewsToInbox(agents);
  syncDailyReviewsToInbox(agents);
  syncExecutionReviewsToInbox(agents);
  const v2Owned = readV2OwnedAgentSlugs();
  return agents.filter((agent) => !v2Owned.has(agent.slug));
}

function isCadenceDue(agent: TeamAgentRecord, state: AgentStateRecord): boolean {
  if (!agent.proactive) return false;
  if (state.nextWakeAt && new Date(state.nextWakeAt).getTime() > Date.now()) return false;
  const cadence = Math.max(5, agent.cadenceMinutes ?? 30);
  if (!state.lastRunAt) return true;
  return Date.now() - new Date(state.lastRunAt).getTime() >= cadence * 60_000;
}

function parseJsonObject(text: string): AgentDecision | null {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<AgentDecision>;
      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary : 'No summary provided.',
        actions: Array.isArray(parsed.actions) ? parsed.actions as AgentAction[] : [],
        commitments: Array.isArray(parsed.commitments) ? parsed.commitments.map(String).filter(Boolean) : [],
        followUpMinutes: typeof parsed.followUpMinutes === 'number' ? parsed.followUpMinutes : undefined,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function buildAgentPrompt(agent: TeamAgentRecord, inboxItems: AgentInboxItem[], state: AgentStateRecord): string {
  ensureTasksFile();
  const tasks = parseTasks(readFileSync(TASKS_FILE, 'utf-8'))
    .filter((task) => task.status === 'pending')
    .filter((task) => !agent.project || task.project.toLowerCase() === agent.project.toLowerCase() || !task.project)
    .slice(0, 12);

  const inboxText = inboxItems.map((item, index) => {
    const metadata = item.metadata ?? {};
    const metaParts = [
      item.fromAgent ? `from=${item.fromAgent}` : '',
      metadata.requestId ? `requestId=${String(metadata.requestId)}` : '',
      metadata.delegationId ? `delegationId=${String(metadata.delegationId)}` : '',
      metadata.taskId ? `taskId=${String(metadata.taskId)}` : '',
      metadata.priority ? `priority=${String(metadata.priority)}` : '',
      metadata.dueDate ? `due=${String(metadata.dueDate)}` : '',
    ].filter(Boolean).join(' ');
    return `${index + 1}. [${item.type}] ${metaParts}\n${item.content}`;
  }).join('\n\n');

  const taskText = tasks.length === 0
    ? 'No matching pending tasks.'
    : tasks.map((task) => `- {${task.id}} ${task.description}${task.priority ? ` !!${task.priority}` : ''}${task.dueDate ? ` due ${task.dueDate}` : ''}${task.project ? ` project=${task.project}` : ''}`).join('\n');

  // Inject active goals so the agent can proactively drive them forward
  const activeGoals = agent.slug === 'clementine' ? loadActiveGoals().slice(0, 6) : [];
  const goalsText = activeGoals.length === 0
    ? ''
    : activeGoals.map((g) => {
      const next = g.nextActions[0] ? ` | next: ${g.nextActions[0]}` : '';
      const blocker = g.blockers?.[0] ? ` | BLOCKED: ${g.blockers[0]}` : '';
      const due = g.targetDate ? ` | due ${g.targetDate}` : '';
      return `- [${g.id}] ${g.title} (${g.priority}${due}${next}${blocker})`;
    }).join('\n');

  const activeExecutions = agent.slug === 'clementine'
    ? new ExecutionStore()
      .list(8)
      .filter((execution) => execution.status === 'active' || execution.status === 'blocked')
    : [];
  const executionText = activeExecutions.length === 0
    ? ''
    : activeExecutions
      .map((execution) => `- [${execution.id}] ${execution.title} (${execution.status}) | next: ${execution.nextStep ?? 'decide next step'} | objective: ${execution.objective}`)
      .join('\n');

  const today = new Date().toISOString().slice(0, 10);
  const timeOfDay = (() => {
    const h = new Date().getHours();
    if (h < 6) return 'early morning';
    if (h < 12) return 'morning';
    if (h < 17) return 'afternoon';
    if (h < 21) return 'evening';
    return 'night';
  })();

  return [
    `You are operating as the autonomous agent ${agent.name} (${agent.slug}).`,
    agent.role ? `Role: ${agent.role}` : '',
    agent.description ? `Mission: ${agent.description}` : '',
    agent.project ? `Bound project: ${agent.project}` : '',
    `Personality and operating guidance:\n${agent.personality}`,
    `Current context: ${today}, ${timeOfDay}`,
    state.commitments && state.commitments.length > 0 ? `Existing commitments:\n- ${state.commitments.join('\n- ')}` : 'Existing commitments: none',
    goalsText ? `Active goals (you should proactively advance these):\n${goalsText}` : '',
    executionText ? `Active tracked executions (push these forward proactively):\n${executionText}` : '',
    inboxItems.length > 0 ? `Pending inbox items:\n${inboxText}` : 'Pending inbox items: none',
    `Relevant open tasks:\n${taskText}`,
    'You are proactive. If you see stagnant goals or tasks without recent progress, take initiative to move them forward — create tasks, add notes, send messages, or notify the user.',
    'Return only valid JSON matching this schema:',
    '{"summary":"string","actions":[{"type":"message_agent|reply_request|complete_delegation|create_task|update_task|note|notify_user|delegate|update_goal|noop","to":"slug","content":"string","requestId":"string","response":"string","delegationId":"string","result":"string","description":"string","priority":"high|medium|low","dueDate":"YYYY-MM-DD","project":"string","taskId":"T-001","status":"pending|completed","title":"string","body":"string","task":"string","expectedOutput":"string","reason":"string","goalId":"string","goalNote":"string","goalStatus":"active|paused|completed|blocked","goalNextActions":["string"],"goalBlockers":["string"]}],"commitments":["string"],"followUpMinutes":30}',
    'Action rules:',
    '- If replying to a request, use reply_request with requestId.',
    '- If completing delegated work, use complete_delegation with delegationId and result.',
    '- If you need another agent, use delegate or message_agent.',
    '- Use notify_user only for meaningful status changes, blockers, or when the user would genuinely want to know.',
    '- Use update_goal with goalId to log progress notes, update status, or set next actions.',
    '- Use noop only if nothing useful should be done now (include a reason).',
    '- Prefer concrete actions over commentary.',
  ].filter(Boolean).join('\n\n');
}

function updateTaskLine(action: AgentAction): string | null {
  ensureTasksFile();
  const body = readFileSync(TASKS_FILE, 'utf-8');
  const lines = body.split('\n');
  const taskId = action.taskId?.replace(/[{}]/g, '') ?? '';
  const normalizedId = taskId.startsWith('T-') ? taskId : taskId ? `T-${taskId}` : '';
  const index = normalizedId
    ? lines.findIndex((line) => line.includes(`{${normalizedId}}`) && /^\s*-\s+\[[ xX]\]/.test(line))
    : -1;

  if (index === -1) {
    return null;
  }

  const existing = parseTasks(lines[index])[0];
  if (!existing) return null;
  const nextStatus = action.status ?? existing.status;
  const nextDescription = action.description ?? existing.description;
  const nextPriority = action.priority ?? existing.priority;
  const nextDueDate = action.dueDate !== undefined ? action.dueDate : existing.dueDate;
  const project = action.project ?? existing.project;
  const checkbox = nextStatus === 'completed' ? 'x' : ' ';
  const projectTag = project ? ` #project:${project}` : '';
  const priorityTag = nextPriority ? ` !!${nextPriority}` : '';
  const dueTag = nextDueDate ? ` 📅 ${nextDueDate}` : '';
  lines[index] = `- [${checkbox}] {${normalizedId}} ${nextDescription}${priorityTag}${dueTag}${projectTag}`;
  writeFileSync(TASKS_FILE, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf-8');
  return normalizedId;
}

function addTask(action: AgentAction): string | null {
  if (!action.description) return null;
  ensureTasksFile();
  let body = readFileSync(TASKS_FILE, 'utf-8');
  const taskId = nextTaskId(body);
  const meta = [
    action.priority ? `!!${action.priority}` : '',
    action.dueDate ? `📅 ${action.dueDate}` : '',
    action.project ? `#project:${action.project}` : '',
  ].filter(Boolean).join(' ');
  const taskLine = `- [ ] {${taskId}} ${action.description}${meta ? ` ${meta}` : ''}`;
  const marker = '## Pending\n';
  const insertAt = body.includes(marker) ? body.indexOf(marker) + marker.length : body.length;
  body = `${body.slice(0, insertAt)}\n${taskLine}${body.slice(insertAt)}`;
  writeFileSync(TASKS_FILE, body, 'utf-8');
  return taskId;
}

function executeAgentActions(agent: TeamAgentRecord, decision: AgentDecision): string[] {
  const outcomes: string[] = [];
  for (const action of decision.actions.slice(0, 6)) {
    try {
      switch (action.type) {
        case 'message_agent': {
          if (!action.to || !action.content) break;
          appendTeamComms({
            id: randomUUID().slice(0, 8),
            fromAgent: agent.slug,
            toAgent: action.to,
            content: action.content,
            timestamp: new Date().toISOString(),
            protocol: 'message',
          });
          outcomes.push(`messaged ${action.to}`);
          break;
        }
        case 'reply_request': {
          if (!action.requestId || !action.response) break;
          const filePath = requestFilePath(action.requestId);
          if (!existsSync(filePath)) break;
          const request = JSON.parse(readFileSync(filePath, 'utf-8')) as TeamRequestRecord;
          if (request.toAgent !== agent.slug || request.status !== 'pending') break;
          saveTeamRequest({
            ...request,
            status: 'completed',
            response: action.response,
            respondedAt: new Date().toISOString(),
          });
          appendTeamComms({
            id: randomUUID().slice(0, 8),
            fromAgent: agent.slug,
            toAgent: request.fromAgent,
            content: action.response,
            timestamp: new Date().toISOString(),
            protocol: 'response',
            requestId: request.id,
            respondedAt: new Date().toISOString(),
          });
          outcomes.push(`replied to request ${request.id}`);
          break;
        }
        case 'complete_delegation': {
          if (!action.delegationId || !action.result) break;
          const filePath = delegationFilePath(agent.slug, action.delegationId);
          if (!existsSync(filePath)) break;
          const delegation = JSON.parse(readFileSync(filePath, 'utf-8')) as DelegationRecord;
          saveDelegation({
            ...delegation,
            status: 'completed',
            result: action.result,
            updatedAt: new Date().toISOString(),
          });
          appendTeamComms({
            id: randomUUID().slice(0, 8),
            fromAgent: agent.slug,
            toAgent: delegation.fromAgent,
            content: `Completed delegation ${delegation.id}: ${action.result}`,
            timestamp: new Date().toISOString(),
            protocol: 'message',
          });
          outcomes.push(`completed delegation ${delegation.id}`);
          break;
        }
        case 'create_task': {
          const taskId = addTask(action);
          if (taskId) outcomes.push(`created task ${taskId}`);
          break;
        }
        case 'update_task': {
          const taskId = updateTaskLine(action);
          if (taskId) outcomes.push(`updated task ${taskId}`);
          break;
        }
        case 'note': {
          if (!action.content) break;
          appendTodayNote(`[${agent.name}] ${action.content}`);
          outcomes.push('updated daily note');
          break;
        }
        case 'notify_user': {
          if (!action.title || !action.body) break;
          addNotification({
            id: `${Date.now()}-agent-${agent.slug}`,
            kind: 'system',
            title: `${agent.name}: ${action.title}`,
            body: action.body,
            createdAt: new Date().toISOString(),
            read: false,
            metadata: { agent: agent.slug },
          });
          outcomes.push('notified user');
          break;
        }
        case 'delegate': {
          if (!action.to || !action.task || !action.expectedOutput) break;
          const record: DelegationRecord = {
            id: randomUUID().slice(0, 8),
            fromAgent: agent.slug,
            toAgent: action.to,
            task: action.task,
            expectedOutput: action.expectedOutput,
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          saveDelegation(record);
          outcomes.push(`delegated work to ${action.to}`);
          break;
        }
        case 'update_goal': {
          if (!action.goalId) break;
          updateGoal(action.goalId, {
            status: action.goalStatus,
            progressNote: action.goalNote,
            nextActions: action.goalNextActions,
            blockers: action.goalBlockers,
          });
          outcomes.push(`updated goal ${action.goalId}`);
          break;
        }
        case 'noop':
          outcomes.push(action.reason ? `noop: ${action.reason}` : 'noop');
          break;
      }
    } catch (error) {
      logger.warn({ err: error, agent: agent.slug, action }, 'Agent action failed');
    }
  }
  return outcomes;
}

async function runAgentCycle(assistant: ClementineAssistant, agent: TeamAgentRecord): Promise<void> {
  if (agent.autonomyEnabled === false) return;
  const state = loadAgentState(agent.slug);
  const inboxItems = loadInbox(agent.slug).filter((item) => item.status === 'pending').slice(0, 6);
  const wakeReasons = [
    ...(inboxItems.length > 0 ? ['inbox'] : []),
    ...(isCadenceDue(agent, state) ? ['cadence'] : []),
  ];

  if (wakeReasons.length === 0) return;

  const prompt = buildAgentPrompt(agent, inboxItems, state);
  try {
    const response = await assistant.respond({
      sessionId: `agent:${agent.slug}`,
      channel: 'agent',
      userId: agent.slug,
      model: agent.model ?? MODELS.fast,
      message: prompt,
    });
    const decision = parseJsonObject(response.text);
    if (!decision) {
      throw new Error(`Agent response was not valid JSON: ${response.text.slice(0, 240)}`);
    }
    const outcomes = executeAgentActions(agent, decision);
    markInboxProcessed(agent.slug, inboxItems.map((item) => item.id));
    saveAgentState({
      slug: agent.slug,
      lastRunAt: new Date().toISOString(),
      lastWakeAt: new Date().toISOString(),
      lastWakeReasons: wakeReasons,
      lastSummary: `${decision.summary}${outcomes.length > 0 ? ` | actions: ${outcomes.join(', ')}` : ''}`,
      commitments: decision.commitments.slice(0, 8),
      nextWakeAt: decision.followUpMinutes
        ? new Date(Date.now() + Math.max(5, decision.followUpMinutes) * 60_000).toISOString()
        : undefined,
    });
    if (outcomes.some((entry) => !entry.startsWith('noop'))) {
      addNotification({
        id: `${Date.now()}-agent-loop-${agent.slug}`,
        kind: 'system',
        title: `Agent activity: ${agent.name}`,
        body: `${decision.summary}\n\nActions: ${outcomes.join(', ') || 'none'}`,
        createdAt: new Date().toISOString(),
        read: false,
        metadata: { agent: agent.slug, wakeReasons },
      });
    }
  } catch (error) {
    logger.error({ err: error, agent: agent.slug }, 'Agent cycle failed');
    saveAgentState({
      ...state,
      slug: agent.slug,
      lastRunAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    });
    addNotification({
      id: `${Date.now()}-agent-loop-${agent.slug}-error`,
      kind: 'system',
      title: `Agent loop failed: ${agent.name}`,
      body: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { agent: agent.slug, status: 'error' },
    });
  }
}

export function listAgentStates(): AgentStateRecord[] {
  if (!existsSync(AGENT_STATE_DIR)) return [];
  return readdirSync(AGENT_STATE_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      try {
        return JSON.parse(readFileSync(path.join(AGENT_STATE_DIR, file), 'utf-8')) as AgentStateRecord;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is AgentStateRecord => entry !== null)
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

export function listAgentInboxCounts(): Array<{ slug: string; pending: number }> {
  return listAutonomyAgents().map((agent) => ({
    slug: agent.slug,
    pending: loadInbox(agent.slug).filter((item) => item.status === 'pending').length,
  }));
}

export async function processAgentAutonomy(assistant: ClementineAssistant): Promise<void> {
  const agents = syncAutonomyInputs();
  for (const agent of agents) {
    await runAgentCycle(assistant, agent);
  }
}
