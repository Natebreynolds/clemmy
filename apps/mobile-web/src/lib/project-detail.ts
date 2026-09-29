/**
 * How a project's screen lays out what the Mac returned.
 *
 * One truth, one door: a thing that waits on the owner is drawn once, under
 * "Needs you", and not again in the list of work below it. Every row here is
 * taken from the project overview; nothing is inferred.
 */
import {
  delegatedTaskOpen,
  orderDelegatedTasks,
  projectDecisionIsFormal,
  type DelegatedTaskPhase,
  type ProjectConnectedApp,
} from '@clem/chat-engine';

interface TaskLike {
  taskId: string;
  phase: DelegatedTaskPhase;
  updatedAt: string;
  controls?: { canAnswer?: boolean };
  question?: unknown;
}
interface DecisionLike {
  kind: 'question' | 'approval';
  /** False when it was asked in the conversation's own words. */
  formal?: boolean;
  taskId: string | null;
  sessionId?: string;
  approvalId: string | null;
  questionId: string | null;
  detail?: string;
  askedAt: string;
}

export interface ProjectWorkLayout<T, D, A> {
  /** Tasks waiting on an answer: each card carries its own answer field. */
  questions: T[];
  /** Questions whose task is not in the overview; answered by the task's id. */
  looseQuestions: D[];
  /**
   * Approvals decided on a card. `card` is the row the Needs-you screen
   * decides with; null when that list could not be read, and then the
   * approval is decided on Needs you, never from a button drawn without it.
   */
  approvals: Array<{ decision: D; card: A | null }>;
  /** Asked in a conversation's own words: answered there, never on a card. */
  asked: D[];
  /** Work that is still moving and is not already drawn above. */
  current: T[];
  /** Work that ended, newest first. */
  ended: T[];
  /** How many things wait on the owner here. */
  waiting: number;
}

/**
 * `approvalCards` is what the Needs-you screen lists (null when it could not
 * be read). The Mac says which decisions are made on a card; the shared
 * engine reads that (projectDecisionIsFormal). One asked in the conversation's
 * own words is answered there: deciding it from a card would answer on behalf
 * of a reply the owner never gave, so it gets no buttons. A card this screen
 * could not read gets none either, and is decided on Needs you.
 */
export function layoutProjectWork<T extends TaskLike, D extends DecisionLike, A extends { approvalId: string }>(input: {
  tasks: readonly T[];
  decisions: readonly D[];
  approvalCards: readonly A[] | null;
}): ProjectWorkLayout<T, D, A> {
  const byId = new Map(input.tasks.map((task) => [task.taskId, task] as const));
  const cards = new Map((input.approvalCards ?? []).map((row) => [row.approvalId, row] as const));
  const questions: T[] = [];
  const looseQuestions: D[] = [];
  const approvals: Array<{ decision: D; card: A | null }> = [];
  const asked: D[] = [];
  const drawn = new Set<string>();
  const seenApprovals = new Set<string>();
  const seenAsked = new Set<string>();
  const ask = (decision: D): void => {
    const key = `${decision.sessionId ?? ''}\u0000${decision.askedAt}\u0000${decision.detail ?? ''}`;
    if (seenAsked.has(key)) return;
    seenAsked.add(key);
    asked.push(decision);
  };

  for (const decision of input.decisions) {
    if (decision.kind === 'question') {
      if (!decision.taskId) continue;
      const task = byId.get(decision.taskId);
      if (task && task.controls?.canAnswer && task.question) {
        if (!drawn.has(task.taskId)) { drawn.add(task.taskId); questions.push(task); }
      } else if (!drawn.has(decision.taskId)) {
        drawn.add(decision.taskId);
        looseQuestions.push(decision);
      }
      continue;
    }
    if (!projectDecisionIsFormal(decision)) { ask(decision); continue; }
    if (!decision.approvalId) {
      // An approval with nothing to decide it by can only be answered where it was asked.
      if (decision.sessionId) ask(decision);
      continue;
    }
    if (seenApprovals.has(decision.approvalId)) continue;
    seenApprovals.add(decision.approvalId);
    approvals.push({ decision, card: cards.get(decision.approvalId) ?? null });
  }

  // A task the overview says can be answered is a decision even if the
  // decisions list was cut short.
  for (const task of input.tasks) {
    if (drawn.has(task.taskId)) continue;
    if (task.phase === 'needs_you' && task.controls?.canAnswer && task.question) {
      drawn.add(task.taskId);
      questions.push(task);
    }
  }

  const rest = orderDelegatedTasks(input.tasks.filter((task) => !questions.includes(task)));
  return {
    questions,
    looseQuestions,
    approvals,
    asked,
    current: rest.filter((task) => delegatedTaskOpen(task)),
    ended: rest.filter((task) => !delegatedTaskOpen(task)),
    waiting: questions.length + looseQuestions.length + approvals.length + asked.length,
  };
}

/** Agents that can still be assigned: every saved agent not assigned here. */
export function assignableAgents<T extends { id: string; name: string }>(
  agents: readonly T[],
  assigned: ReadonlyArray<{ agentId: string; available: boolean }>,
): T[] {
  // An assignment whose agent is gone does not block assigning its successor.
  const taken = new Set(assigned.filter((row) => row.available).map((row) => row.agentId));
  return agents.filter((agent) => !taken.has(agent.id)).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The apps an account can be added for, as the Mac listed them: only apps
 * with an account connected right now, one row per app, by name. Anything
 * unusable in the answer is left out rather than drawn half-named.
 */
export function bindableApps(apps: unknown): ProjectConnectedApp[] {
  if (!Array.isArray(apps)) return [];
  const byToolkit = new Map<string, ProjectConnectedApp>();
  for (const row of apps) {
    if (!row || typeof row !== 'object') continue;
    const raw = row as { toolkit?: unknown; name?: unknown; accounts?: unknown };
    const toolkit = typeof raw.toolkit === 'string' ? raw.toolkit.trim() : '';
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!toolkit || !name || byToolkit.has(toolkit)) continue;
    const seen = new Set<string>();
    const accounts: ProjectConnectedApp['accounts'] = [];
    for (const account of Array.isArray(raw.accounts) ? raw.accounts : []) {
      const accountId = typeof account?.accountId === 'string' ? account.accountId.trim() : '';
      if (!accountId || seen.has(accountId)) continue;
      seen.add(accountId);
      const label = typeof account?.label === 'string' ? account.label.trim() : '';
      accounts.push({ accountId, label: label || 'Connected account' });
    }
    if (accounts.length === 0) continue;
    byToolkit.set(toolkit, { toolkit, name, accounts });
  }
  return [...byToolkit.values()].sort((a, b) => a.name.localeCompare(b.name));
}
