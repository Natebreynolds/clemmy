/** Small retained-state briefing. No checks, cleanup, answers or effect authority. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HeartbeatPresentation } from '../agents/heartbeats.js';
import type { InboxQuestionItem } from '../execution/inbox-questions.js';
import type { PendingApprovalRow } from '../runtime/harness/approval-registry.js';

type Status = 'ok' | 'partial' | 'unavailable';
type Ref = Record<string, string>;
interface Item { key: string; title: string; at: string | null; ref: Ref }
interface Watch {
  id: string; title: string; enabled: boolean; state: HeartbeatPresentation['state'];
  lastCheck: HeartbeatPresentation['lastCheck']; summary?: string;
}
interface Workflow { runId: string; workflow: string; status: string; at: string | null }
interface Plan { id: string; proposedAt: string; plan?: { objective?: string }; originatingRequest?: string }
export interface VoiceCheckInReaders {
  approvals: () => Pick<PendingApprovalRow, 'approvalId' | 'subject' | 'requestedAt'>[];
  questions: () => InboxQuestionItem[];
  plans: () => Plan[];
  watches: () => Promise<{ items: Watch[]; failed: number }>;
  workflows: () => { items: Workflow[]; failed: number; omitted: number };
}

const ITEM_LIMIT = 4;
const RECORD_LIMIT = 64;
const FILE_LIMIT = 2 * 1024 * 1024;
const OMITTED_ATTENTION = ['notifications', 'trust_proposals', 'workspace_choices', 'check_in_templates'] as const;
const clip = (value: string, max: number) => value.replace(/\s+/g, ' ').trim().slice(0, max);
const spoken = (value: string, max: number) => clip(value.replace(/https?:\/\/\S+/gi, '').replace(/[`*_#]/g, ''), max);
const exactId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const retainedAt = (value: unknown, now: number): string | null => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now ? value : null;

/** The normal status readers tolerate damaged stores. Preflight preserves the
 * distinction between no observations and an unreadable saved observation. */
function preflight(file: string, container?: 'items' | 'records' | 'proposals'): void {
  let value: unknown;
  try {
    if (statSync(file).size > FILE_LIMIT) throw new Error('retained_state_too_large');
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('retained_state_invalid');
  const row = value as Record<string, unknown>;
  if (container && (row.version !== 1 || !row[container] || typeof row[container] !== 'object'
    || (container === 'records' ? !Array.isArray(row[container]) : Array.isArray(row[container])))) {
    throw new Error('retained_state_invalid');
  }
}

async function productionReaders(now: number): Promise<VoiceCheckInReaders> {
  const [{ BASE_DIR, WORKFLOW_RUNS_DIR }, approvals, questions, presentation, plans, heartbeats,
    inventory, terminal] = await Promise.all([
    import('../tools/shared.js'), import('../runtime/harness/approval-registry.js'),
    import('../execution/inbox-questions.js'), import('./question-presentation.js'), import('../agents/plan-proposals.js'),
    import('../agents/heartbeats.js'), import('../execution/workflow-run-inventory.js'), import('../execution/workflow-run-terminal-status.js'),
  ]);
  return {
    approvals: () => approvals.listPending({ status: 'pending' })
      .filter(row => !approvals.isExpired(row)).filter(approvals.isFormalApprovalSurface),
    questions: () => presentation.visibleInboxQuestions(questions.listInboxQuestions({ reconcile: false }), now),
    plans: () => plans.listPlanProposals({ status: 'pending', strictRead: true }),
    watches: async () => {
      preflight(path.join(BASE_DIR, 'state', 'proactivity-policy.json'));
      const reads = [
        { file: 'work-review.json', container: 'items' as const, read: async () => (await import('../agents/work-review-runtime.js')).workReviewStatus(now) },
        { file: 'calendar-watch.json', container: 'items' as const, read: async () => (await import('../agents/calendar-watch-runtime.js')).calendarWatchStatus(now, { includeConnectedOperations: false }) },
        { file: 'workflow-suggestions.json', container: 'records' as const, read: async () => (await import('../agents/workflow-suggestions.js')).workflowSuggestionsStatus(new Date(now)) },
        { file: 'noticing.json', container: 'proposals' as const, read: async () => (await import('../agents/noticing-runtime.js')).noticingStatus(now) },
      ];
      const results = await Promise.allSettled(reads.map(async source => {
        preflight(path.join(BASE_DIR, 'state', source.file), source.container);
        const row = await source.read();
        const finding = row.lastFinding;
        const detail = finding as { readFailures?: number; accounts?: number } | undefined;
        const display = heartbeats.projectHeartbeatPresentation({ ...row,
          readFailures: detail?.readFailures, ...(row.id === 'calendar' ? { successfulReads: detail?.accounts } : {}) }, now);
        return { id: row.id, title: row.title, enabled: row.enabled, state: display.state, lastCheck: display.lastCheck,
          ...(finding?.summary && display.lastCheck.at === finding.at ? { summary: clip(finding.summary, 180) } : {}) };
      }));
      return { items: results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []),
        failed: results.filter(result => result.status === 'rejected').length };
    },
    workflows: () => {
      let files: string[];
      try { files = readdirSync(WORKFLOW_RUNS_DIR).filter(file => file.endsWith('.json')).sort(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], failed: 0, omitted: 0 }; throw error; }
      const items: Workflow[] = [];
      let failed = 0;
      for (const file of files.slice(0, RECORD_LIMIT)) {
        try {
          if (statSync(path.join(WORKFLOW_RUNS_DIR, file)).size > FILE_LIMIT) { failed += 1; continue; }
          const read = inventory.readWorkflowRunInventoryFile(file);
          if (read.kind !== 'record') { failed += 1; continue; }
          const record = read.entry.record;
          if (!exactId(record.id) || record.id !== file.slice(0, -5) || !exactId(record.workflow)
            || !exactId(record.status)) { failed += 1; continue; }
          if (terminal.isTerminalWorkflowRunStatus(record.status)) continue;
          items.push({ runId: record.id, workflow: record.workflow, status: record.status,
            at: retainedAt(record.updatedAt ?? record.startedAt ?? record.createdAt, now) });
        } catch { failed += 1; }
      }
      items.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.runId.localeCompare(b.runId));
      return { items, failed, omitted: Math.max(0, files.length - RECORD_LIMIT) };
    },
  };
}

export async function readVoiceCheckIn(readers?: VoiceCheckInReaders, now = Date.now()) {
  const generatedAt = new Date(now).toISOString();
  const issues: Array<{ source: string; code: 'read_unavailable' | 'partial_read' }> = [];
  let source = readers;
  try { source ??= await productionReaders(now); }
  catch { source = { approvals: () => { throw new Error(); }, questions: () => { throw new Error(); }, plans: () => { throw new Error(); },
    watches: async () => { throw new Error(); }, workflows: () => { throw new Error(); } }; }
  const names = ['approvals', 'questions', 'plans', 'watches', 'workflows'] as const;
  const results = await Promise.allSettled(names.map((name): Promise<unknown> => Promise.resolve().then<unknown>(() => source![name]())));
  for (let index = 0; index < results.length; index++) {
    if (results[index].status === 'rejected') issues.push({ source: names[index], code: 'read_unavailable' });
  }
  const get = <T>(index: number): T | null => { const result = results[index]; return result.status === 'fulfilled' ? result.value as T : null; };
  const approvals = get<ReturnType<VoiceCheckInReaders['approvals']>>(0);
  const questions = get<ReturnType<VoiceCheckInReaders['questions']>>(1);
  const plans = get<ReturnType<VoiceCheckInReaders['plans']>>(2);
  const watchRead = get<Awaited<ReturnType<VoiceCheckInReaders['watches']>>>(3);
  const flowRead = get<ReturnType<VoiceCheckInReaders['workflows']>>(4);
  if (watchRead?.failed) issues.push({ source: 'watches', code: 'partial_read' });
  if (flowRead?.failed || flowRead?.omitted) issues.push({ source: 'workflows', code: 'partial_read' });
  const decisions = new Map<string, Item>();
  const invalidDecisionCount = [...(approvals ?? []).map(row => row.approvalId), ...(questions ?? []).map(row => row.id),
    ...(plans ?? []).map(row => row.id)].filter(id => !exactId(id)).length;
  if (invalidDecisionCount) issues.push({ source: 'attention', code: 'partial_read' });
  for (const row of approvals ?? []) if (exactId(row.approvalId)) decisions.set(`approval:${row.approvalId}`, {
    key: `approval:${row.approvalId}`, title: clip(row.subject || 'Approval required', 180), at: retainedAt(row.requestedAt, now), ref: { approvalId: row.approvalId } });
  for (const row of questions ?? []) if (exactId(row.id)) {
    const ref: Ref = { questionId: row.id };
    for (const field of ['runId', 'stepId', 'sessionId', 'taskId'] as const) if (exactId(row[field])) ref[field] = row[field]!;
    decisions.set(row.id, { key: row.id, title: clip(row.question, 180), at: retainedAt(row.askedAt, now), ref });
  }
  for (const row of plans ?? []) if (exactId(row.id)) decisions.set(`plan:${row.id}`, {
    key: `plan:${row.id}`, title: clip(row.plan?.objective || row.originatingRequest || 'Plan awaiting review', 180),
    at: retainedAt(row.proposedAt, now), ref: { planId: row.id } });
  const attention = [...decisions.values()];
  const watches = (watchRead?.items ?? []).slice(0, ITEM_LIMIT).map(row => ({ ...row, title: clip(row.title, 80),
    ...(row.summary ? { summary: clip(row.summary, 180) } : {}), ref: { heartbeatId: row.id },
    freshness: { basis: 'retained' as const, at: retainedAt(row.lastCheck.at, now) } }));
  const workflows = (flowRead?.items ?? []).slice(0, ITEM_LIMIT).map(row => ({ key: `workflow-run:${row.runId}`,
    title: clip(row.workflow, 180), status: clip(row.status, 80), at: retainedAt(row.at, now),
    ref: { runId: row.runId, workflow: row.workflow } }));
  const status: Status = results.every(result => result.status === 'rejected') ? 'unavailable' : 'partial';
  const sections = {
    attention: { status: 'partial' as Status, scope: 'pending_approvals_questions_plans', observedCount: attention.length,
      counts: { approvals: approvals?.length ?? null, questions: questions?.length ?? null, plans: plans?.length ?? null },
      items: attention.slice(0, ITEM_LIMIT), omittedItems: invalidDecisionCount + Math.max(0, attention.length - ITEM_LIMIT), omittedSources: [...OMITTED_ATTENTION],
      freshness: { basis: 'retained' as const, observedAt: generatedAt } },
    watches: { status: (watchRead ? watchRead.failed ? watches.length ? 'partial' : 'unavailable' : 'ok' : 'unavailable') as Status,
      items: watches, omittedItems: Math.max(0, (watchRead?.items.length ?? 0) - watches.length),
      freshness: { basis: 'retained' as const, observedAt: generatedAt } },
    workflows: { status: (flowRead ? flowRead.failed || flowRead.omitted ? 'partial' : 'ok' : 'unavailable') as Status,
      scope: 'retained_unfinished_workflow_runs', observedCount: flowRead?.items.length ?? null, items: workflows,
      omittedItems: (flowRead?.omitted ?? 0) + Math.max(0, (flowRead?.items.length ?? 0) - workflows.length),
      freshness: { basis: 'retained' as const, observedAt: generatedAt } },
  };
  const caveat = 'Saved observations, not fresh checks. Notification asks, trust and workspace choices are not included. Open Clem for the full Needs you list.';
  const watchFindings = watches.filter(row => row.summary && row.freshness.at !== null).slice(0, 2)
    .map(row => `${spoken(row.title, 40)}, saved check ${row.lastCheck.state} at ${row.freshness.at}: ${spoken(row.summary!, 110)}.`);
  const words = status === 'unavailable' ? ['I could not read Clem’s saved check-in. Open Clem to check the current work.'] : [
    'From Clem’s saved records:',
    `${approvals === null ? 'Approval status unavailable' : `${approvals.length} approval${approvals.length === 1 ? '' : 's'}`}, ${questions === null ? 'question status unavailable' : `${questions.length} question${questions.length === 1 ? '' : 's'}`}, and ${plans === null ? 'plan status unavailable' : `${plans.length} plan${plans.length === 1 ? '' : 's'}`} in the checked sources.`,
    ...watchFindings,
    ...attention.slice(0, 2).map(item => `${spoken(item.title, 100)}.`),
    flowRead ? `${flowRead.items.length} unfinished workflow run${flowRead.items.length === 1 ? '' : 's'} in the checked records${flowRead.failed || flowRead.omitted ? '; some records could not be included' : ''}.` : 'Workflow status unavailable.',
    watchRead && (watches.length || !watchRead.failed) ? `${watches.filter(row => row.freshness.at !== null).length} saved watch records${watches.some(row => row.lastCheck.state === 'never') ? '; some watches have not recorded a check' : ''}${watchRead.failed ? '; some watch status is unavailable' : ''}.` : 'Watch status unavailable.',
  ];
  const spokenText = status === 'unavailable' ? spoken(words.join(' '), 1000)
    : `${spoken(words.join(' '), 1000 - caveat.length - 1)} ${caveat}`;
  return { version: 1 as const, status, generatedAt, spokenText, sections, issues };
}
