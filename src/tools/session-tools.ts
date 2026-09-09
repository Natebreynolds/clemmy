import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ExecutionStore } from '../execution/store.js';
import { loadSessionBrief, listSessionBriefs, refreshSessionBrief, renderSessionResume, saveSessionManualHandoff } from '../memory/session-briefs.js';
import { PlanStore } from '../planning/plan-store.js';
import { INBOX_DIR, TASKS_FILE, parseTasks, sessions, textResult } from './shared.js';
import { listGoalRecords, type GoalRecord } from '../memory/goals-list.js';
import { getSession as getHarnessSession, listEvents as listHarnessEvents } from '../runtime/harness/eventlog.js';
import { exactSessionHistoryForTool, pullRecentTurnsForHarnessHistory, renderSessionHistoryForModel } from '../runtime/harness/session-transcript.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { sameConversationAncestorSessionIds } from '../runtime/harness/accepted-source-session-branch.js';
import { publicUserInputText } from '../runtime/harness/public-presentation.js';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from '../runtime/harness/tool-output-format.js';
import { searchSessionHistory, redeemSessionHistorySearch, sessionHistorySnapshotDigest } from '../runtime/harness/session-history-search.js';
import type { ConversationTurn, SessionRecord } from '../types.js';

interface DiscoveredWorkItem {
  type: string;
  urgency: number;
  description: string;
}

function daysSince(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Math.floor((Date.now() - parsed) / 86_400_000));
}

function readGoals(): GoalRecord[] {
  return listGoalRecords();
}

function collectGoalWork(items: DiscoveredWorkItem[]): void {
  for (const goal of readGoals()) {
    if (goal.status !== 'active' && goal.status !== 'blocked') continue;

    const staleDays = daysSince(goal.updatedAt);
    const staleThreshold = goal.reviewFrequency === 'daily' ? 1 : goal.reviewFrequency === 'weekly' ? 7 : 30;
    const priorityWeight = goal.priority === 'high' ? 2 : goal.priority === 'medium' ? 1 : 0;

    if (goal.status === 'blocked' && goal.blockers[0]) {
      items.push({
        type: 'blocked-goal',
        urgency: Math.min(5, 4 + priorityWeight),
        description: `${goal.title} is blocked: ${goal.blockers[0]}`,
      });
      continue;
    }

    if (staleDays > staleThreshold) {
      const nextAction = goal.nextActions[0] ? ` | Next: ${goal.nextActions[0]}` : '';
      items.push({
        type: 'stale-goal',
        urgency: Math.min(5, 2 + priorityWeight + Math.floor(staleDays / Math.max(staleThreshold, 1))),
        description: `${goal.title} has been quiet for ${staleDays}d${nextAction}`,
      });
    }
  }
}

function collectTaskWork(items: DiscoveredWorkItem[]): void {
  if (!existsSync(TASKS_FILE)) return;

  const pendingTasks = parseTasks(readFileSync(TASKS_FILE, 'utf-8')).filter((task) => task.status === 'pending');
  const today = new Date().toISOString().slice(0, 10);
  const overdue = pendingTasks.filter((task) => task.dueDate && task.dueDate < today);
  const dueToday = pendingTasks.filter((task) => task.dueDate === today);

  if (overdue.length > 0) {
    items.push({
      type: 'overdue-task',
      urgency: 5,
      description: `${overdue.length} task(s) are overdue in TASKS.md`,
    });
  }

  if (dueToday.length > 0) {
    items.push({
      type: 'due-today',
      urgency: 4,
      description: `${dueToday.length} task(s) are due today`,
    });
  }
}

function collectInboxWork(items: DiscoveredWorkItem[]): void {
  if (!existsSync(INBOX_DIR)) return;

  const inboxCount = readdirSync(INBOX_DIR).filter((file) => file.endsWith('.md')).length;
  if (inboxCount > 0) {
    items.push({
      type: 'inbox',
      urgency: Math.min(4, 1 + Math.floor(inboxCount / 3)),
      description: `${inboxCount} inbox item(s) still need triage`,
    });
  }
}

function collectPlanWork(items: DiscoveredWorkItem[]): void {
  const plans = new PlanStore().list(4);
  for (const plan of plans) {
    const activeStep = plan.steps.find((step) => step.status === 'in_progress');
    if (!activeStep) continue;
    items.push({
      type: 'active-plan',
      urgency: 3,
      description: `${plan.title} -> ${activeStep.text}`,
    });
  }
}

function collectExecutionWork(items: DiscoveredWorkItem[], sessionId?: string): void {
  const executions = new ExecutionStore()
    .list(10)
    .filter((execution) => !sessionId || execution.sessionId === sessionId)
    .filter((execution) => execution.status === 'active' || execution.status === 'blocked');

  for (const execution of executions) {
    const staleMinutes = Math.floor((Date.now() - new Date(execution.lastActivityAt).getTime()) / 60_000);
    items.push({
      type: execution.status === 'blocked' ? 'blocked-execution' : 'active-execution',
      urgency: execution.status === 'blocked' ? 5 : Math.min(5, 2 + Math.floor(staleMinutes / 60)),
      description: `${execution.title}${execution.nextStep ? ` -> ${execution.nextStep}` : ''}`,
    });
  }
}

function collectHandoffWork(items: DiscoveredWorkItem[], sessionId?: string): void {
  const briefs = sessionId
    ? [loadSessionBrief(sessionId)].filter((brief): brief is NonNullable<ReturnType<typeof loadSessionBrief>> => brief !== null)
    : listSessionBriefs(8);

  for (const brief of briefs) {
    const remaining = brief.manual?.remaining ?? [];
    const blockers = brief.manual?.blockers ?? [];
    const ageDays = daysSince(brief.manual?.pausedAt ?? brief.updatedAt);

    for (const item of remaining.slice(0, 4)) {
      items.push({
        type: 'session-handoff',
        urgency: Math.min(5, 3 + Math.min(ageDays, 2)),
        description: `${brief.sessionId}: ${item}`,
      });
    }

    for (const blocker of blockers.slice(0, 2)) {
      items.push({
        type: 'handoff-blocker',
        urgency: 5,
        description: `${brief.sessionId}: ${blocker}`,
      });
    }
  }
}

function renderDiscoveredWork(items: DiscoveredWorkItem[], limit: number): string {
  const ranked = items
    .sort((left, right) => right.urgency - left.urgency || left.description.localeCompare(right.description))
    .slice(0, limit);

  if (ranked.length === 0) {
    return 'No outstanding work discovered from handoffs, plans, goals, inbox, or tasks.';
  }

  return [
    `## Discovered Work (${ranked.length})`,
    ...ranked.map((item) => `- [${item.type}] Urgency ${item.urgency}/5: ${item.description}`),
  ].join('\n');
}

function harnessSessionRecordForContinuity(sessionId: string): SessionRecord | null {
  try {
    const row = getHarnessSession(sessionId);
    if (!row) return null;
    const turns: ConversationTurn[] = pullRecentTurnsForHarnessHistory(sessionId, 20).map((turn) => ({
      role: turn.who === 'user' ? 'user' : 'assistant',
      text: turn.text,
      createdAt: turn.at,
    }));
    return {
      id: row.id,
      userId: row.userId ?? undefined,
      channel: row.channel ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      title: row.title ?? row.objective ?? undefined,
      turns,
    };
  } catch {
    return null;
  }
}

function sessionRecordForContinuity(sessionId: string): { session: SessionRecord; source: 'legacy' | 'harness' } {
  const harness = harnessSessionRecordForContinuity(sessionId);
  if (harness && harness.turns.length > 0) return { session: harness, source: 'harness' };
  const legacy = sessions.get(sessionId);
  if (legacy.turns.length > 0) return { session: legacy, source: 'legacy' };
  if (harness) return { session: harness, source: 'harness' };
  return { session: legacy, source: 'legacy' };
}

/** Exact locator equality, not an operation/prose classifier. A named sibling
 * such as session-A-long cannot authorize reading the shorter session-A. */
function containsExactSessionLocator(text: string, sessionId: string): boolean {
  const isIdentifierChar = (char: string | undefined): boolean => Boolean(char && /[\p{L}\p{N}_.:-]/u.test(char));
  for (let offset = text.indexOf(sessionId); offset >= 0; offset = text.indexOf(sessionId, offset + sessionId.length)) {
    if (!isIdentifierChar(text[offset - 1]) && !isIdentifierChar(text[offset + sessionId.length])) return true;
  }
  return false;
}

export function registerSessionTools(server: McpServer): void {
  server.tool(
    'session_search',
    'Find prior public conversations owned by the current conversation principal. By default exclude this conversation and its validated ancestors; include_current_conversation=true opts them in. Search retained user/assistant text, then copy a returned session_id, through_seq, snapshot_sha256 and search_receipt_id to session_history for the exact full conversation. Factual recall grants no task continuation or write authority. query is lexical words (all must match); use an empty query to list recent work or a time window. after is inclusive and before exclusive ISO time with timezone: resolve relative dates using the user timezone. Results are newest first and excerpts are explicitly shortened, not full evidence. Repeat unchanged arguments with next_cursor to page results. A changed index refuses the old cursor; repeat without cursor to acquire a fresh snapshot in the same user turn. coverage.complete=false means incremental backfill remains: repeat without cursor until covered before claiming no matches or a complete list. Only retained harness chats are searched; derived memory and legacy-only chats are not covered.',
    {
      query: z.string().max(2_000).nullish(),
      after: z.string().datetime({ offset: true }).nullish(),
      before: z.string().datetime({ offset: true }).nullish(),
      limit: z.number().int().min(1).max(20).nullish(),
      cursor: z.string().min(1).nullish(),
      include_current_conversation: z.boolean().nullish().describe('Default false excludes this conversation and its validated ancestors, so earlier failed recall attempts do not hide the actual older work. Set true to intentionally search current-conversation history too.'),
    },
    async ({ query, after, before, limit, cursor, include_current_conversation }) => {
      const context = getToolOutputContext();
      const harnessContext = harnessRunContextStorage.getStore();
      const sourceUserSeq = context?.sourceUserSeq
        ?? (harnessContext?.sessionId === context?.sessionId ? harnessContext?.sourceUserSeq : undefined);
      if (!context?.sessionId || !sourceUserSeq) return textResult('session_search denied: an exact accepted requesting source is required.', { isError: true });
      try {
        return textResult(JSON.stringify(searchSessionHistory({ sessionId: context.sessionId, sourceUserSeq,
          query: query ?? undefined, after, before, limit: limit ?? undefined, cursor, includeCurrentConversation: include_current_conversation ?? undefined })));
      } catch (error) {
        return textResult(`session_search denied: ${error instanceof Error ? error.message : String(error)}`, { isError: true });
      }
    },
  );

  server.tool(
    'session_history',
    'Read exact public conversation history for the current session, an explicitly named session owned by the same principal, or an exact session_search result using search_receipt_id. This read grants no task continuation or write authority. through_seq is an inclusive harness event boundary. No turn text is shortened. Large histories return lossless pages: repeat the same session_id, through_seq, max_turns, search_receipt_id and snapshot_sha256 with next_offset_chars as offset_chars until complete. max_turns optionally selects recent exchanges; omit it for a search receipt. Omitted reads all retained exchanges. earlier_before_seq identifies older exchanges excluded by that explicit window.',
    {
      session_id: z.string().min(1),
      max_turns: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
      through_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
      offset_chars: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullish(),
      max_chars: z.number().int().min(100).max(DEFAULT_TOOL_RESULT_MAX_CHARS - 2_048).nullish()
        .describe('Maximum exact content characters in this page; default uses the complete tool-result transport page budget. More content remains available at next_offset_chars.'),
      snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullish()
        .describe('For subsequent pages copy the first page digest, so a changed transcript cannot silently replace the requested snapshot.'),
      search_receipt_id: z.string().min(1).nullish().describe('Copy the receipt from session_search for its exact same-principal snapshot. Bound to the current accepted user source.'),
    },
    async ({ session_id, max_turns, through_seq, offset_chars, max_chars, snapshot_sha256, search_receipt_id }) => {
      const context = getToolOutputContext();
      const harnessContext = harnessRunContextStorage.getStore();
      const sourceUserSeq = context?.sourceUserSeq
        ?? (harnessContext?.sessionId === context?.sessionId ? harnessContext?.sourceUserSeq : undefined);
      const requester = context?.sessionId ? getHarnessSession(context.sessionId) : null;
      const legacyRequester = !requester && context?.sessionId ? sessions.get(context.sessionId) : null;
      const target = getHarnessSession(session_id);
      const legacyTarget = !target ? sessions.get(session_id) : null;
      const requesterPrincipal = requester?.userId || legacyRequester?.userId || requester?.id;
      const targetPrincipal = target?.userId || legacyTarget?.userId || target?.id;
      const sameSession = Boolean(context?.sessionId && context.sessionId === session_id && (requester || legacyRequester?.turns.length));
      const source = requester && sourceUserSeq
        ? listHarnessEvents(requester.id, { sinceSeq: sourceUserSeq - 1, types: ['user_input_received'], limit: 1 })
          .find(event => event.seq === sourceUserSeq)
        : undefined;
      const explicitLocator = Boolean(source && containsExactSessionLocator(publicUserInputText(source.data), session_id));
      const ancestor = requester && requesterPrincipal
        ? sameConversationAncestorSessionIds({ sessionId: requester.id, principalId: requesterPrincipal }).includes(session_id)
        : false;
      let searchRead: ReturnType<typeof redeemSessionHistorySearch> | undefined;
      if (search_receipt_id) {
        try {
          if (!context?.sessionId || !sourceUserSeq) throw new Error('An exact accepted requesting source is required.');
          searchRead = redeemSessionHistorySearch({ sessionId: context.sessionId, sourceUserSeq,
            receiptId: search_receipt_id, targetSessionId: session_id, throughSeq: through_seq ?? undefined,
            snapshotSha256: snapshot_sha256 ?? undefined, maxTurns: max_turns ?? undefined });
        } catch (error) {
          return textResult(`session_history denied: ${error instanceof Error ? error.message : String(error)}`, { isError: true });
        }
      }
      if (!sameSession && !searchRead && !(requesterPrincipal && requesterPrincipal === targetPrincipal && (explicitLocator || ancestor))) {
        return textResult('session_history denied: the host requesting session must own this history, and cross-session reads require an exact accepted-source session locator or validated conversation ancestry.', { isError: true });
      }
      const offset = offset_chars ?? 0;
      if (offset > 0 && (!snapshot_sha256 || (target && through_seq == null && !searchRead))) {
        return textResult('session_history page denied: copy snapshot_sha256 and through_seq from the first page before requesting an offset.', { isError: true });
      }
      const history = searchRead?.history ?? exactSessionHistoryForTool({ sessionId: session_id, throughSeq: through_seq ?? undefined, maxTurns: max_turns ?? undefined });
      const digest = sessionHistorySnapshotDigest({ sessionId: session_id,
        throughSeq: history.throughSeq, maxTurns: max_turns ?? undefined, text: history.text });
      if ((snapshot_sha256 && snapshot_sha256 !== digest) || offset > history.text.length) {
        return textResult('session_history page denied: the requested snapshot digest or offset no longer matches; restart at offset_chars:0 for a new explicit snapshot.', { isError: true });
      }
      let end = Math.min(history.text.length, offset + (max_chars ?? DEFAULT_TOOL_RESULT_MAX_CHARS - 2_048));
      // Do not split a UTF-16 surrogate pair between transport pages.
      if (end < history.text.length && /[\uD800-\uDBFF]/.test(history.text[end - 1] ?? '')) end -= 1;
      const header = {
        version: 1, session_id, through_seq: history.throughSeq, max_turns: max_turns ?? null,
        snapshot_sha256: digest, total_chars: history.text.length, offset_chars: offset,
        returned_chars: end - offset, next_offset_chars: end < history.text.length ? end : null,
        complete: end === history.text.length, empty: history.text.length === 0, earlier_before_seq: history.earlierBeforeSeq,
        ...(searchRead?.history.beforeSourceSeq === undefined ? {} : { source_before_seq: searchRead.history.beforeSourceSeq }),
      };
      return textResult(`${JSON.stringify(header)}\n\n${history.text.slice(offset, end)}`);
    },
  );

  server.tool(
    'session_pause',
    'Save a structured handoff for a session so work can resume cleanly after context drift, a restart, or a channel handoff.',
    {
      session_id: z.string().min(1),
      completed: z.array(z.string()).min(1),
      remaining: z.array(z.string()).min(1),
      decisions: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
      context: z.string().optional(),
    },
    async ({ session_id, completed, remaining, decisions, blockers, context }) => {
      const { session } = sessionRecordForContinuity(session_id);
      const brief = saveSessionManualHandoff({
        session,
        completed,
        remaining,
        decisions,
        blockers,
        context,
      });

      return textResult(
        [
          `Handoff saved for ${session_id}.`,
          `Completed: ${brief.manual?.completed.length ?? 0}`,
          `Remaining: ${brief.manual?.remaining.length ?? 0}`,
          brief.manual?.blockers.length ? `Blockers: ${brief.manual.blockers.length}` : '',
        ].filter(Boolean).join('\n'),
      );
    },
  );

  server.tool(
    'session_resume',
    'Summarize a session using its continuity brief and recent transcript so work can resume cleanly.',
    {
      session_id: z.string().min(1),
    },
    async ({ session_id }) => {
      const { session, source } = sessionRecordForContinuity(session_id);
      const brief = loadSessionBrief(session_id);
      if (source === 'harness') {
        const harnessHistory = renderSessionHistoryForModel(session_id, 20, 16_000);
        if (brief) {
          return textResult([
            renderSessionResume(session, brief),
            harnessHistory ? `Canonical harness history:\n${harnessHistory}` : '',
          ].filter(Boolean).join('\n\n'));
        }
        if (harnessHistory) {
          return textResult([
            `Harness session resume for ${session_id}.`,
            harnessHistory,
          ].join('\n\n'));
        }
      }
      if (session.turns.length === 0) {
        if (brief) return textResult(renderSessionResume(session, brief));
        return textResult('No prior activity for that session.');
      }

      const refreshed = brief ?? refreshSessionBrief(session);
      return textResult(renderSessionResume(session, refreshed));
    },
  );

  server.tool(
    'discover_work',
    'Scan handoffs, plans, goals, tasks, and inbox items to find prioritized work that should be advanced next.',
    {
      session_id: z.string().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async ({ session_id, limit }) => {
      const items: DiscoveredWorkItem[] = [];
      collectHandoffWork(items, session_id);
      collectExecutionWork(items, session_id);
      collectPlanWork(items);
      collectGoalWork(items);
      collectTaskWork(items);
      collectInboxWork(items);
      return textResult(renderDiscoveredWork(items, limit ?? 10));
    },
  );
}
