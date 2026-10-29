#!/usr/bin/env node
/** Supplemental visual QA of the already-built apps. Run:
 *   node scripts/preview-experience-fixtures.mjs
 * This server imports no application runtime/config/auth code, reads only the
 * two built asset directories, never proxies requests, and never calls a model.
 * Its fictional account and in-memory preferences are NOT installed/live proof.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = 'FRAMEWORK-TEST';
const projectId = 'FRAMEWORK-TEST-experience';
const agentId = 'FRAMEWORK-TEST-researcher';
const sessionId = 'FRAMEWORK-TEST-session';
const workerSessionId = 'background:FRAMEWORK-TEST-report';
const reviewSessionId = 'background:FRAMEWORK-TEST-approval-task';
const now = new Date().toISOString();
const chatSession = { id: sessionId, title: 'FRAMEWORK-TEST · Launch review conversation', kind: 'chat', channel: 'fixture', status: 'paused', createdAt: Date.parse(now), updatedAt: Date.parse(now), agentId: null, agentName: null, projectId, projectName: 'FRAMEWORK-TEST · Launch review', pinned: false, archived: false, running: false };
const desktopSession = { ...chatSession, id: `harness:${sessionId}`, origin: 'desktop', store: 'harness', preview: 'Controlled conversation for draft navigation. Sending is unavailable.', createdAt: now, updatedAt: now, tags: [], continuable: true, turnCount: 0 };
const exactApprovalBody = [
  'FRAMEWORK-TEST · Controlled review draft. This content is fictional and will not be sent.',
  ...Array.from({ length: 24 }, (_, index) => `Review point ${index + 1}: Keep the user’s decision, exact recipients and complete message visible together. This paragraph is intentionally long so the controlled preview verifies the full recorded content remains reviewable instead of a shortened excerpt.`),
  'FRAMEWORK-TEST exact final line',
].join('\n\n');
const approvalBase = { sessionId, channel: 'fixture', channelId: null, requestedAt: now, expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(), status: 'pending', resolution: null, kind: 'harness', tool: 'OUTLOOK_SEND_EMAIL', projectId, projectName: chatSession.projectName };
// These are recorded review examples, never executable approvals. All approve,
// reject and send writes remain forbidden by mutation() below.
const approvals = [
  { ...approvalBase, approvalId: 'FRAMEWORK-TEST-approval-readable', subject: 'Send the controlled launch review', args: { arguments: { controlled: true } }, presentation: { action: 'Send the controlled review', ask: 'Can I send this controlled review to launch@example.test?', why: 'This is sample content only. Approval does not send anything in this preview.', details: [], unwrapped: true }, contentPreview: { body: exactApprovalBody.slice(0, 1499) + '…' }, preview: { operation: 'Send the controlled message', fields: [{ name: 'to', value: 'launch@example.test' }, { name: 'subject', value: 'FRAMEWORK-TEST review' }, { name: 'body', value: exactApprovalBody }, { name: 'scope', value: 'Only this message; no future sends' }] } },
  { ...approvalBase, approvalId: 'FRAMEWORK-TEST-approval-opaque', subject: 'Review the older controlled draft', args: { arguments: { to: 'legacy@example.test', body: 'Opaque old action' } }, presentation: { action: 'Send the older controlled draft', ask: 'Can I send the older controlled draft?', why: 'This sample has no complete recorded review. The phone must require review on the computer.', details: [{ label: 'To', value: 'legacy@example.test', long: false }, { label: 'Message excerpt', value: 'FRAMEWORK-TEST · An older draft summary is not the full action.', long: true }], unwrapped: true }, contentPreview: { body: 'FRAMEWORK-TEST · Older controlled draft excerpt.' } },
];
const report = 'The controlled review is ready. Three findings are organized by priority, with a clear next action for each.\n\nThis is fictional fixture content for visual QA. No accounts were contacted and no agent work ran.\n\n1. Keep the primary navigation focused on outcomes.\n2. Make every question recoverable from Set aside.\n3. Keep the complete report and saved files one tap away.';
const file = { fileId: 'FRAMEWORK-TEST-file', name: 'FRAMEWORK-TEST-review.md', folder: 'FRAMEWORK-TEST-results', place: 'Controlled fixture results', kind: 'markdown', bytes: Buffer.byteLength(report), modifiedAt: now, openable: false, revision: `sha256:${createHash('sha256').update(report).digest('hex')}`, text: report };
const project = { id: projectId, name: 'FRAMEWORK-TEST · Launch review', purpose: 'A controlled example of work, people and results in one project.', goals: ['Review the launch experience', 'Keep decisions easy to find'], context: 'Fictional sample project. No personal or business records are loaded.', status: 'active', revision: 1, createdFrom: 'console', originSessionId: sessionId, createdAt: now, updatedAt: now, archivedAt: null };
const assignment = { agentId, agentName: 'FRAMEWORK-TEST Researcher', handles: 'Research and clear reportbacks', available: true, responsibility: 'Find the evidence and return an actionable review.', context: 'Only controlled fixture material.', skills: [], shareMethods: false, revision: 1, assignedAt: now };
const task = { taskId: 'FRAMEWORK-TEST-report', title: 'FRAMEWORK-TEST · Review the launch experience', status: 'done', phase: 'finished', owner: { agentId, agentName: assignment.agentName, chosenBy: 'owner' }, project: { id: projectId, name: project.name }, requestVersion: 1, revisions: [], correctionPending: false, artifactDestination: 'FRAMEWORK-TEST-results', question: null, approvalId: null, resultPreview: report, resultPath: file.name, error: null, checkIns: [{ at: now, note: 'Controlled evidence has been organized into a readable report.' }], work: { done: 3, total: 3, items: [{ id: 'review', label: 'Review the controlled evidence', state: 'done' }, { id: 'priorities', label: 'Set priorities', state: 'done' }, { id: 'report', label: 'Prepare the report', state: 'done' }] }, files: [{ name: file.name, dir: file.folder }], originSessionId: sessionId, runSessionId: sessionId, followsTaskId: null, createdAt: now, startedAt: now, completedAt: now, updatedAt: now, controls: { canSteer: false, canStop: false, canResume: false, canAnswer: false } };
task.runSessionId = workerSessionId;
const reviewTask = { ...task, taskId: 'FRAMEWORK-TEST-approval-task', title: 'FRAMEWORK-TEST · Review before the sample can continue', status: 'blocked', phase: 'needs_you', approvalId: approvals[0].approvalId, resultPreview: null, resultPath: null, files: [], runSessionId: reviewSessionId, completedAt: null, work: null, controls: { canSteer: false, canStop: false, canResume: false, canAnswer: false } };
const agent = { id: agentId, slug: agentId, name: assignment.agentName, handles: assignment.handles, description: assignment.handles, instructions: 'Controlled fixture agent. No execution is available. Threads, project context and saved files are safe to inspect; sending and configuration changes are forbidden.', enabled: true, status: 'active', model: null, tools: [], skills: [], workflows: [], memoryScope: null, createdFrom: 'console', createdAt: now, updatedAt: now };
const agentSession = { ...desktopSession, agentId, agentName: agent.name, agentIds: [agentId], turnCount: 2, status: 'completed', preview: 'The controlled report is ready. Drafts are safe; sending is disabled.' };
const guidanceReply = 'The controlled review is organized by priority. You can inspect Threads, About and the project context, or type a draft without sending. No real agent work ran.\n\n[Show me Projects](app:guide:projects) · [Show me Agents](app:guide:agents)';
const agentTurns = [{ role: 'user', text: 'FRAMEWORK-TEST · Organize the launch review in this project.', createdAt: now, agentName: agent.name, projectName: project.name }, { role: 'assistant', text: guidanceReply, createdAt: now, agentName: agent.name, projectName: project.name }];
const chatEvents = [{ seq: 1, id: 'FRAMEWORK-TEST-chat-user', turn: 1, role: 'user', type: 'user_input_received', sessionId, createdAt: Date.parse(now), data: { text: agentTurns[0].text } }, { seq: 2, id: 'FRAMEWORK-TEST-chat-guide', turn: 1, role: 'assistant', type: 'conversation_completed', sessionId, createdAt: Date.parse(now), data: { reply: guidanceReply, sourceUserSeq: 1 } }];
const workerSession = { ...agentSession, id: `harness:${workerSessionId}`, title: task.title, kind: 'agent', status: 'completed', continuable: false, preview: report.slice(0, 180) };
const runEvents = [{ seq: 1, type: 'deliverable_saved', sessionId: workerSessionId, createdAt: Date.parse(now), data: { name: file.name, dir: file.folder, excerpt: report.slice(0, 160) } }, { seq: 2, type: 'conversation_completed', sessionId: workerSessionId, createdAt: Date.parse(now), data: { reply: report } }];
const reviewSession = { ...workerSession, id: `harness:${reviewSessionId}`, title: reviewTask.title, status: 'awaiting_approval' };
const recentRuns = [{ id: workerSessionId, sessionId: workerSessionId, title: task.title, status: 'completed', statusLabel: 'Done', preview: 'A controlled saved report is ready to open.', createdAt: now, updatedAt: now }, { id: reviewSessionId, sessionId: reviewSessionId, title: reviewTask.title, status: 'awaiting_approval', statusLabel: 'Waiting for your approval', needsAttention: true, createdAt: now, updatedAt: now }];
const workingEntries = [{ schemaVersion: 1, runKey: reviewSessionId, attemptId: 'FRAMEWORK-TEST-review-attempt', kind: 'background', lifecycle: 'awaiting_approval', liveness: 'unknown', needsAttention: true, headline: reviewTask.title, startedAt: now, lastEvidenceAt: now, revision: 1, sessionId: reviewSessionId, taskId: reviewTask.taskId }];
let activityMode = 'ready';
let experienceMode = 'sample';
const summaryProject = { id: projectId, name: project.name, purpose: project.purpose, status: 'active', updatedAt: now, agents: [{ agentId, agentName: assignment.agentName }], activeTasks: 0, needsYou: 1 };
const overview = () => ({ project, agents: [assignment], resources: [], tasks: [task], codingRuns: [], pages: [], conversations: [{ sessionId, title: 'FRAMEWORK-TEST · Launch review conversation', updatedAt: now, agentName: assignment.agentName, current: true }], decisions: [] });
const definitions = [
  ['checkin:FRAMEWORK-TEST-visible', 'Which part should the controlled review prioritize?', 'Choose a focus to preview how a question reads in context.'],
  ['checkin:FRAMEWORK-TEST-later', 'Should the sample launch checklist include an accessibility review?', 'Set aside until tomorrow. This question remains paused.'],
  ['checkin:FRAMEWORK-TEST-dismissed', 'Would you like a second version of the sample report?', 'Dismissed from attention. Restore it here whenever you need it.'],
];
const questions = definitions.map(([id, question, context], i) => ({ id, source: 'check_in', question, options: i ? [] : ['Navigation and clarity', 'Reports and results'], context, askedAt: now, urgency: 'normal', agentLabel: 'FRAMEWORK-TEST Clem', sessionId, taskId: null, workflowName: null, runId: null, stepId: null, answerable: true, unavailableReason: null, attentionKey: id, lifecycle: { canDismiss: true, canDefer: true, dismissLabel: 'Dismiss', deferLabel: 'Tomorrow', effect: 'hide_only', generation: String(i + 1).repeat(64), explanation: 'Fixture only: this changes the preview attention list. No real work runs.' } }));
const attentionDefinitions = [
  { key: 'flow:framework-test-launch', kind: 'workflow', title: 'FRAMEWORK-TEST · Workflow needs a review', detail: 'The controlled launch workflow is paused. Later or Dismiss only hides this request; it does not resume or cancel the workflow.', workflow: 'FRAMEWORK-TEST Launch', workflowSlug: 'framework-test-launch', runId: 'FRAMEWORK-TEST-workflow-run', notificationId: 'FRAMEWORK-TEST-workflow-notice', metadata: { workflow: 'FRAMEWORK-TEST Launch', workflowRunId: 'FRAMEWORK-TEST-workflow-run', runId: 'FRAMEWORK-TEST-workflow-run', heartbeatId: 'work-review', itemKey: 'run_failed:FRAMEWORK-TEST-launch', refType: 'workflow_run', refId: 'FRAMEWORK-TEST-workflow-run', changeKind: 'run_failed', needsAttention: true } },
  { key: `session:${sessionId}`, kind: 'conversation', title: 'FRAMEWORK-TEST · Conversation needs your direction', detail: 'The controlled conversation is waiting for direction. Setting it aside does not send a reply.', sessionId, notificationId: 'FRAMEWORK-TEST-conversation-notice', metadata: { sessionId, status: 'needs_input', heartbeatId: 'work-review', needsAttention: true } },
  { key: 'calendar:FRAMEWORK-TEST-calendar|invite_unanswered|event', kind: 'calendar', title: 'FRAMEWORK-TEST · Calendar invitation needs a response', detail: 'This fictional invitation has no RSVP yet. Later or Dismiss never accepts or declines the event.', notificationId: 'FRAMEWORK-TEST-calendar-notice', metadata: { watch: 'calendar', itemKey: 'FRAMEWORK-TEST-calendar|invite_unanswered|event', changeKind: 'invite_unanswered', startsAt: new Date(Date.parse(now) + 86_400_000).toISOString(), needsAttention: true } },
];
const attentionItems = attentionDefinitions.map(({ metadata, ...row }) => ({ ...row, createdAt: now, projectId,
  lifecycle: { canDismiss: true, canDefer: true, effect: 'hide_only', dismissLabel: 'Dismiss', deferLabel: 'Tomorrow',
    generation: createHash('sha256').update(JSON.stringify({ fixture: label, row, metadata, now })).digest('hex'),
    explanation: 'Fixture only: this clears attention. It never replies, approves, cancels, resumes or changes real work.' } }));
let attentionPreferences = new Map();
const attentionHidden = item => { const saved = attentionPreferences.get(item.key); return saved?.generation === item.lifecycle.generation && (saved.action === 'dismiss' || saved.action === 'defer' && Date.parse(saved.until) > Date.now()); };
const visibleAttention = () => attentionItems.filter(item => !attentionHidden(item));
const asideAttention = () => attentionItems.filter(attentionHidden).map(item => ({ ...item, ...attentionPreferences.get(item.key) }));
const attentionNotifications = () => visibleAttention().flatMap(item => {
  const base = { id: item.notificationId, kind: item.kind === 'workflow' ? 'workflow' : 'execution', title: item.title, body: item.detail, createdAt: now, read: false, needsAttention: true, needsYouKey: item.key, lifecycle: item.lifecycle, deliveredAt: now, deliveryError: null, workflow: item.workflow ?? null, metadata: { fixture: true, ...attentionDefinitions.find(row => row.key === item.key).metadata }, context: { actionItemId: null, approvalId: null, questionId: null, planProposalId: null, trustProposalId: null, sessionId: item.sessionId ?? null, runId: item.runId ?? null, workflow: item.workflow ?? null, stepId: null } };
  if (item.kind !== 'workflow') return [base];
  return [
    { ...base, title: 'FRAMEWORK-TEST · Review the model account', body: 'This fictional workflow stopped when its model account needed a review. Open the preserved run to inspect the cause.', context: { ...base.context, runId: 'FRAMEWORK-TEST-credit-new' }, metadata: { ...base.metadata, refId: 'FRAMEWORK-TEST-credit-new', workflowRunId: 'FRAMEWORK-TEST-credit-new', runId: 'FRAMEWORK-TEST-credit-new' } },
    { ...base, id: 'FRAMEWORK-TEST-workflow-credit-old', title: 'FRAMEWORK-TEST · Review the model account', body: 'This fictional workflow stopped when its model account needed a review. Open the preserved run to inspect the cause.', createdAt: new Date(Date.parse(now) - 60_000).toISOString(), context: { ...base.context, runId: 'FRAMEWORK-TEST-credit-old' }, metadata: { ...base.metadata, refId: 'FRAMEWORK-TEST-credit-old', workflowRunId: 'FRAMEWORK-TEST-credit-old', runId: 'FRAMEWORK-TEST-credit-old' } },
    { ...base, id: 'FRAMEWORK-TEST-workflow-permission', title: 'FRAMEWORK-TEST · Review computer access', body: 'A separate fictional attempt stopped before computer access was available. This report and its run stay distinct from the model-account report.', createdAt: new Date(Date.parse(now) - 120_000).toISOString(), context: { ...base.context, runId: 'FRAMEWORK-TEST-permission-run' }, metadata: { ...base.metadata, refId: 'FRAMEWORK-TEST-permission-run', workflowRunId: 'FRAMEWORK-TEST-permission-run', runId: 'FRAMEWORK-TEST-permission-run' } },
  ];
});
const fromClem = () => {
  const reports = new Map();
  for (const row of attentionNotifications().filter(row => !row.needsYouKey.startsWith('session:'))) {
    const key = JSON.stringify([row.needsYouKey, row.title, row.body]);
    if (reports.has(key)) { reports.get(key).relatedNotificationIds.push(row.id); continue; }
    reports.set(key, { key: `fixture:${row.id}`, heartbeat: 'work-review', heartbeatTitle: 'Work review', at: row.createdAt, asks: true, text: row.body, say: row.title,
      voiceDigest: createHash('sha256').update(key + row.lifecycle.generation).digest('hex'), attentionKey: row.needsYouKey, lifecycle: row.lifecycle,
      relatedNotificationIds: [row.id], ...(row.context.runId ? { run: { runId: row.context.runId, workflow: row.workflow } } : {}) });
  }
  const rows = [...reports.values()];
  return { rows, pulses: [], covers: { questionIds: [], notificationIds: rows.flatMap(row => row.relatedNotificationIds), planProposalIds: [] } };
};
let preferences;
function reset() { preferences = new Map([[questions[1].id, { action: 'defer', mutationToken: randomUUID(), until: new Date(Date.now() + 86_400_000).toISOString() }], [questions[2].id, { action: 'dismiss', mutationToken: randomUUID() }]]); attentionPreferences = new Map(); activityMode = 'ready'; experienceMode = 'sample'; }
reset();
const hidden = (q) => { const p = preferences.get(q.id); return p && (p.action === 'dismiss' || (p.action === 'defer' && Date.parse(p.until) > Date.now())); };
const visible = () => questions.filter(q => !hidden(q));
const aside = () => questions.filter(hidden).map(q => ({ ...q, ...preferences.get(q.id), generation: q.lifecycle.generation }));
const attention = () => ({ total: visible().length + approvals.length + visibleAttention().length, needsYou: visible().length + approvals.length + visibleAttention().length, approvals: approvals.length, plans: 0, checkInProposals: 0, questions: visible().length, workspaceChoices: 0, trustProposals: 0, stoppedWorkflows: visibleAttention().filter(item => item.kind === 'workflow').length, notificationNeedsYou: visibleAttention().filter(item => item.kind !== 'workflow').length, unreadUpdates: notificationRead ? 0 : 1, keys: [...visible().map(q => q.id), ...approvals.map(row => `approval:${row.approvalId}`), ...visibleAttention().map(item => item.key)], attentionItems: visibleAttention(), unlisted: visibleAttention().filter(item => item.kind === 'workflow').map(item => ({ key: item.key, kind: 'workflow_paused', title: item.title, detail: item.detail, workflow: item.workflow, lifecycle: item.lifecycle })) });
const homePrefs = { landing: 'home', style: 'briefing', liveStatus: 'still', spaceViews: {}, panes: { order: ['needs_you', 'running', 'made', 'projects', 'today'], hidden: [] }, nav: { pinned: ['/home', '/chat', '/inbox', '/projects'], shown: ['/agents', '/workspaces', '/automate', '/memory', '/connect', '/settings'], more: [] }, quickActions: [], phoneSwitcher: ['home', 'chats', 'inbox', 'projects', 'agents'] };
// Static public fresh-install contract from runtime/home-preferences.ts.
// Sample customization above remains separate; no real preference is read.
const firstUseHomePrefs = { landing: 'home', style: 'dashboard', liveStatus: 'animated', spaceViews: {},
  panes: { order: ['needs_you', 'running', 'today', 'while_away', 'made', 'projects', 'quick_actions'], hidden: ['workstate'] },
  nav: { pinned: ['/home', '/chat', '/inbox', '/projects', '/tasks', '/workspaces'], shown: ['/automate', '/connect'], more: ['/memory', '/meetings', '/goals', '/agents'] },
  quickActions: [], phoneSwitcher: ['home', 'inbox', 'chats', 'spaces', 'more'], updatedAt: '1970-01-01T00:00:00.000Z' };
// SettingsSnapshot / ModelRolesSnapshot shape, with explicitly unavailable
// fictional models: the header can render, while no provider is connected.
const fixtureRole = { modelId: 'FRAMEWORK-TEST-not-running', provider: 'byo', source: 'default' };
const fixtureModels = { fast: fixtureRole.modelId, primary: fixtureRole.modelId, deep: fixtureRole.modelId };
const fixtureSettings = { developerMode: false, profile: { preferredName: 'Framework Test', displayName: 'FRAMEWORK-TEST' }, proactivity: { policy: { enabled: false, mode: 'balanced', autoApproveScope: 'strict' } }, runtimeBudget: { settings: {}, presets: [], envKeys: {} }, models: { models: fixtureModels, defaults: fixtureModels, presets: [] }, modelBackend: { mode: 'off', baseURL: '', modelId: '', judgeId: '', workerModel: '', providerLabel: 'FRAMEWORK-TEST', hasKey: false, configured: false }, modelProviders: [], claudeAuth: { configured: false, reason: 'This is a controlled visual fixture.' }, activeBrain: 'api_key', fusion: { mode: 'off', judge: 'codex', strategy: 'verify', active: false, brainsAvailable: { claude: false, codex: false } }, modelRoles: { roles: { brain: fixtureRole, worker: fixtureRole, judge: fixtureRole }, bindings: [], available: [], brainOptions: [{ id: 'api_key', value: 'api_key:' + fixtureRole.modelId, modelId: fixtureRole.modelId, label: 'FRAMEWORK-TEST · No execution', available: false }], activeBrain: 'api_key', effectiveBrain: 'api_key', effectiveBrainValue: 'api_key:' + fixtureRole.modelId }, authMode: 'fixture', agents: [] };
const notification = { id: 'FRAMEWORK-TEST-update', kind: 'execution', title: task.title, body: report, createdAt: now, read: false, needsAttention: false, delivered: true, workflow: null, metadata: { fixture: true }, context: { actionItemId: null, sessionId, runId: null } };
const delivered = { id: 1, createdAt: now, title: 'FRAMEWORK-TEST · Launch review report', why: 'Preview a complete controlled result.', lane: 'fixture', sessionId, conversationSessionId: sessionId, artifactCount: 1, rerunnable: false, artifacts: [{ kind: 'file', title: file.name, target: file.name, createdAt: now, openable: false, stillExists: true, fileRef: { sessionId, name: file.name, folder: file.folder, fileId: file.fileId }, conversationSessionId: sessionId }] };
let notificationRead = false;
const routesSeen = new Set();

function answer(res, body, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Clementine-Fixture': label }); res.end(JSON.stringify(body)); }
function apiGet(url, mobile) {
  let p = url.pathname.replace(/^\/m\/api(?=\/|$)/, '/api/console');
  const decoded = decodeURIComponent(p);
  if (experienceMode === 'first-use') {
    if (p.endsWith('/needs-you/summary') || p.endsWith('/inbox/summary')) return { ...attention(), total: 0, needsYou: 0, approvals: 0, questions: 0, stoppedWorkflows: 0, notificationNeedsYou: 0, unreadUpdates: 0, keys: [], attentionItems: [], unlisted: [] };
    if (p.endsWith('/inbox/questions/presentation')) return { questions: [], count: 0 };
    if (p.endsWith('/inbox/attention/presentation')) return { items: [], count: 0 };
    if (p.endsWith('/inbox/questions')) return { questions: [], count: 0 };
    if (p.endsWith('/home/from-clem')) return { rows: [], pulses: [], covers: { questionIds: [], notificationIds: [], planProposalIds: [] } };
    if (p.endsWith('/home/command-center')) return { presence: { status: 'online', label: 'Controlled first-use preview', mode: 'balanced' }, counts: { active: 0, waiting: 0, approvals: 0, checkIns: 0, runningRuns: 0, runningWorkflows: 0, backgroundActive: 0, requiredSetupMissing: 0, snoozed: 0 }, needsYou: [], recentCompleted: [], focus: { active: null, parked: [], parkedCount: 0, needsConfirm: false }, memory: { chunks: 0, indexedFiles: 0, activeFacts: 0, totalFacts: 0, warnings: [] }, integrations: { connected: 0, total: 0, requiredMissing: 0, runtimeAuth: [], credentials: [] } };
    if (p.endsWith('/activity/v2') || p.endsWith('/working-now')) return { schemaVersion: 1, observedAt: now, snapshots: [], entries: [], items: [], working: [], needsYou: [], recent: [] };
    if (p.endsWith('/projects') || p.endsWith('/project-records')) return { projects: [], items: [], count: 0 };
    if (p.endsWith('/agents')) return { agents: [], count: 0 };
    if (p.endsWith('/delegated-tasks')) return { tasks: [] };
    if (p.endsWith('/delivered')) return { groups: [] };
    if (p.endsWith('/sessions') || p.endsWith('/chat/sessions')) return { sessions: [], count: 0, total: 0, hasMore: false };
    if (p.endsWith('/inbox/notifications') || p === '/api/notifications') return { notifications: [], count: 0 };
    if (/\/approvals(?:\/list)?$/.test(p)) return { approvals: [], count: 0, urgentCount: 0 };
    if (p.endsWith('/runs') || p === '/api/runs') return { runs: [], count: 0 };
  }
  if (p.endsWith('/inbox/attention/presentation')) return { items: asideAttention(), count: asideAttention().length };
  if (p === '/__fixtures/scenario') return { fixture: true, activity: activityMode, experience: experienceMode };
  if (p === '/m/auth/status') return { pinConfigured: true, pinUpdatedAt: null, authenticated: true, deviceId: 'FRAMEWORK-TEST-device', deviceLabel: 'FRAMEWORK-TEST ONLY', binding: 'cookie', scope: 'full', needsDeviceUpgrade: false, sessionFingerprint: null };
  if (p.endsWith('/whoami')) return { name: 'Framework Test', deviceId: 'FRAMEWORK-TEST-device', deviceLabel: 'FRAMEWORK-TEST ONLY' };
  if (p.endsWith('/inbox/questions/presentation')) return { questions: aside(), count: aside().length };
  if (p.endsWith('/inbox/questions')) return { questions: visible(), count: visible().length };
  if (p.endsWith('/needs-you/summary') || p.endsWith('/inbox/summary')) return attention();
  if (p.endsWith('/settings/home')) { const preferences = experienceMode === 'first-use' ? firstUseHomePrefs : homePrefs; return { home: preferences, preferences, ...preferences }; }
  if (p.endsWith('/home/layout')) return { layout: { version: 1, revision: 0, updatedAt: null, tiles: [] }, fixture: true };
  if (p.endsWith('/context')) return { profile: experienceMode === 'first-use' ? {} : { preferredName: 'Framework Test', displayName: label }, goals: [], files: [], fixture: true };
  if (p.endsWith('/watches')) return { watches: [], fixture: true };
  if (p.endsWith('/model-status')) return { codex: { connected: false }, claude: { connected: false }, xai: { connected: false }, openai: { connected: false }, jev: { connected: false }, together: { connected: false }, byoProviders: [], updatedAt: Date.parse(now), fixture: true };
  if (p === '/api/status') return { status: 'fixture', uptime: 0, timestamp: now, fixture: true };
  if (p === '/api/composio/status') return { configured: false, connected: false, enabled: false, apiKeyPresent: false, executionBackend: 'auto', cli: { installed: false, authenticated: false }, fixture: true };
  if (p === '/api/composio/toolkits') return { enabled: false, apiKeyPresent: false, connected: [], toolkits: [], featured: [], catalogError: null, connectionsError: null, fixture: true };
  if (p === '/api/composio/cli-default-accounts') return { authorities: [], fixture: true };
  if (p.endsWith('/mcp/health')) return { servers: [], summary: { total: 0, degraded: 0, unavailable: 0 }, fixture: true };
  if (p.endsWith('/settings/models')) return { brain: fixtureRole, options: fixtureSettings.modelRoles.brainOptions, effectiveValue: `api_key:${fixtureRole.modelId}`, activeBrain: 'api_key', roles: {}, roleOptions: {} };
  if (p.endsWith('/settings')) return fixtureSettings;
  if (p === '/api/console/credentials') return { rows: [], descriptors: {}, auth: { codexOauthPresent: false, openaiApiKeyPresent: false }, fixture: true };
  if (p === '/api/console/auth/xai/status') return { connected: false, fixture: true };
  if (p === '/api/console/jev') return { configured: false, enabled: false, warning: null, fixture: true };
  if (p.endsWith('/focus')) return { active: null, parked: [], parkedCount: 0, needsConfirm: false };
  if (p.endsWith('/build-info')) return { version: 'FRAMEWORK-TEST visual preview', sourceFingerprint: 'fixture-only', packaged: false, fixture: true };
  if (p.endsWith('/activity/v2') || p.endsWith('/working-now')) return ['working-unavailable', 'both-unavailable'].includes(activityMode) ? { fixtureStatus: 503, error: 'FRAMEWORK-TEST: current work is deliberately unavailable.' } : { schemaVersion: 1, observedAt: now, snapshots: workingEntries, entries: workingEntries, items: [], working: workingEntries, needsYou: [], recent: [] };
  if (p.endsWith('/home/from-clem')) return fromClem();
  if (p.endsWith('/home/command-center')) return { presence: { status: 'online', label: 'Controlled preview', mode: 'balanced' }, counts: { active: 0, waiting: attention().total, approvals: approvals.length, checkIns: visible().length, runningRuns: 0, runningWorkflows: 0, backgroundActive: 0, requiredSetupMissing: 0, snoozed: 0 }, needsYou: [...visible().map(q => ({ kind: 'question', title: q.question, meta: q.context, panel: 'inbox', urgency: 'normal', questionId: q.id, attentionKey: q.id, lifecycle: q.lifecycle })), ...approvals.map(row => ({ kind: 'approval', title: row.presentation.ask, meta: row.presentation.why, panel: 'inbox', urgency: 'normal', approvalId: row.approvalId, attentionKey: `approval:${row.approvalId}` })), ...visibleAttention().map(item => ({ kind: item.kind === 'workflow' ? 'workflow' : 'notification', title: item.title, meta: item.detail, panel: 'inbox', urgency: 'normal', notifId: item.notificationId, attentionKey: item.key, lifecycle: item.lifecycle, sessionId: item.sessionId, workflow: item.workflow }))], recentCompleted: [{ kind: 'done', title: task.title, meta: 'Controlled sample result', panel: 'projects', taskId: task.taskId }], focus: { active: null, parked: [], parkedCount: 0, needsConfirm: false }, memory: { chunks: 0, indexedFiles: 0, activeFacts: 0, totalFacts: 0, warnings: [] }, integrations: { connected: 0, total: 0, requiredMissing: 0, runtimeAuth: [], credentials: [] } };
  if (p.endsWith('/home/today')) return { events: [], items: [], state: 'ready', connected: false, available: false };
  if (p.endsWith('/home/space-summaries')) return { summaries: [] };
  if (p.endsWith('/delivered')) return { groups: [delivered] };
  if (p.endsWith('/home/made')) return { items: [], delivered: [], folders: [], count: 0 };
  if (p === '/api/console/project-records' || p === '/api/console/projects') return { projects: [{ ...summaryProject, needsYou: attention().needsYou }] };
  if (p === `/api/console/project-records/${projectId}` || p === `/api/console/projects/${projectId}`) return { overview: overview() };
  if (p.endsWith('/project-records-connected-apps')) return { apps: [] };
  if (p.endsWith('/project-records-local-projects')) return { localProjects: [], foundProjects: [] };
  if (p.endsWith('/project-records-labels')) return { labels: [{ sessionId, projectId, projectName: project.name }] };
  if (p.endsWith('/assignments')) return { work: { agentId, projects: [{ projectId, projectName: project.name, responsibility: assignment.responsibility, shareMethods: false, activeTasks: 0 }], currentTasks: [], recentOutcomes: [task] } };
  if (p === '/api/console/agents') return { agents: [agent] };
  if (p.endsWith('/agents/catalog')) return { models: [], skills: [], tools: [], agents: [agent] };
  if (p === `/api/console/agents/${agentId}`) return { agent };
  if (p === `/api/console/agents/${agentId}/work`) return { threads: [agentSession], workers: [] };
  if (p.endsWith('/delegated-tasks')) return { tasks: [task] };
  if (p.endsWith('/foreground-task-controls')) return { cards: [], generatedAt: now };
  if (p === `/api/console/delegated-tasks/${task.taskId}`) return { task };
  if (p === `/api/console/delegated-tasks/${reviewTask.taskId}`) return { task: reviewTask };
  if (p.endsWith('/sessions') || p.endsWith('/chat/sessions')) return { sessions: url.searchParams.get('archived') === '1' ? [] : mobile ? [{ ...chatSession, agentId, agentName: agent.name, status: 'completed' }] : url.searchParams.get('agent') ? [agentSession] : [agentSession, workerSession, reviewSession], count: url.searchParams.get('archived') === '1' ? 0 : mobile || url.searchParams.get('agent') ? 1 : 3, total: url.searchParams.get('archived') === '1' ? 0 : mobile || url.searchParams.get('agent') ? 1 : 3, hasMore: false };
  if (p === '/api/console/chat/answering-model') return { agent: null, brain: { modelId: fixtureRole.modelId, provider: 'byo', source: 'default' }, effectiveValue: `api_key:${fixtureRole.modelId}` };
  if (p.endsWith(`/chat/sessions/${sessionId}`)) return { session: chatSession, events: chatEvents, latestSeq: 2 };
  if (decoded.endsWith(`/sessions/harness:${sessionId}`)) return { session: agentSession, turns: agentTurns, continueHint: null };
  if (decoded.endsWith(`/sessions/harness:${workerSessionId}`)) return { session: workerSession, turns: [], continueHint: null };
  if (decoded.endsWith(`/sessions/harness:${reviewSessionId}`)) return { session: reviewSession, turns: [], continueHint: null };
  if (p.endsWith(`/chat/sessions/${sessionId}/events/recent`)) return { sessionId, events: chatEvents.filter(event => event.seq > Number(url.searchParams.get('sinceSeq') ?? 0)), latestSeq: 2 };
  const producingSession = /\/(?:chat\/)?sessions\/([^/]+)\/(files|file(?:\/content)?)$/.exec(decoded);
  if (producingSession && [sessionId, workerSessionId].includes(producingSession[1])) {
    if (producingSession[2] === 'files') return { files: [file] };
    if (url.searchParams.get('fileId') !== file.fileId) return { fixtureStatus: 404, error: 'Unknown controlled file identity.' };
    return producingSession[2] === 'file/content' ? { fixtureContent: report, fixtureMime: 'text/markdown; charset=utf-8' } : { file };
  }
  if (decoded.endsWith(`/sessions/${workerSessionId}/events/recent`)) return { sessionId: workerSessionId, events: runEvents.filter(event => event.seq > Number(url.searchParams.get('sinceSeq') ?? 0)), sessionStatus: 'completed', latestSeq: 2, page: { version: 1, scannedThroughSeq: 2, snapshotSeq: 2, hasMore: false } };
  if (decoded.endsWith(`/runs/${workerSessionId}`) || decoded.endsWith(`/runs/${reviewSessionId}`)) {
    const review = decoded.endsWith(`/runs/${reviewSessionId}`);
    return { id: review ? reviewSessionId : workerSessionId, title: review ? reviewTask.title : task.title, status: review ? 'awaiting_approval' : 'completed', delegatedTask: review ? reviewTask : task, kind: 'agent', createdAt: now, updatedAt: now, startedAt: Date.parse(now), lastEventAt: Date.parse(now), events: review ? [] : runEvents, receipts: [], deliverables: review ? [] : [{ at: Date.parse(now), name: file.name, dir: file.folder, excerpt: report.slice(0, 160) }] };
  }
  if (p.endsWith('/inbox/notifications') || p === '/api/notifications') { const notifications = [...(notificationRead ? [] : [notification]), ...attentionNotifications()]; return { notifications, count: notifications.length }; }
  if (p.endsWith(`/inbox/notifications/${notification.id}`)) return { notification: { ...notification, read: notificationRead } };
  if (attentionNotifications().some(row => p.endsWith(`/inbox/notifications/${row.id}`))) return { notification: attentionNotifications().find(row => p.endsWith(`/inbox/notifications/${row.id}`)) };
  if (/\/approvals(?:\/list)?$/.test(p)) return { approvals, count: approvals.length, urgentCount: 0 };
  if (p.includes('plan-proposals') || p.includes('trust-proposals')) return { proposals: [], count: 0 };
  if (p.includes('workspace-destination') || p.includes('workspace-choices') || p.includes('workspace-choosers')) return { choosers: [], count: 0 };
  if (p.endsWith('/spaces') || p.endsWith('/workspaces')) return { spaces: [], workspaces: [] };
  if (p.endsWith('/runs') || p === '/api/runs') return ['history-unavailable', 'both-unavailable'].includes(activityMode) ? { fixtureStatus: 503, error: 'FRAMEWORK-TEST: earlier work is deliberately unavailable.' } : { runs: recentRuns, count: recentRuns.length };
  if (p.includes('/memory')) return { facts: [], episodes: [], total: 0, scopes: [], items: [] };
  if (p.endsWith('/cloud-browser/status')) return { configured: false, choice: 'local', effectiveBackend: 'computer', provider: null, providers: {}, fixture: true };
  if (p.endsWith('/cloud-browser/resources')) return { resources: [] };
  if (p.endsWith('/cloud-browser/overview')) return { openCount: 0, browsers: [], unlinked: [], fixture: true };
  if (p.endsWith('/computer-driver')) return { installed: true, embedded: true, connected: false, daemon: 'stopped', statusText: 'Controlled sample only. No computer is connected.', permissions: 'unknown', permissionsText: 'No permissions are requested in this preview.', permissionSettingsAvailable: false, screenViewAvailable: false, serverName: 'FRAMEWORK-TEST', docsUrl: '', platformSupport: 'supported', version: 'FRAMEWORK-TEST', path: null, fixture: true };
  if (p.endsWith('/health')) return { status: 'fixture', fixture: true };
  return undefined;
}
async function mutation(req, res, pathname) {
  if (pathname === '/__fixtures/reset') { reset(); notificationRead = false; return answer(res, { fixture: true, ok: true }); }
  // This fixture-only control changes read availability in memory. It never
  // calls an application mutation, reads a home, or changes any runtime setting.
  if (pathname === '/__fixtures/scenario' && req.method === 'POST') {
    let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 4096) return answer(res, { error: 'Fixture request too large.' }, 413); }
    let input; try { input = JSON.parse(text); } catch { return answer(res, { error: 'Invalid fixture scenario.' }, 400); }
    if (input && ['sample', 'first-use'].includes(input.experience) && Object.keys(input).length === 1) {
      experienceMode = input.experience;
      return answer(res, { fixture: true, activity: activityMode, experience: experienceMode });
    }
    if (!['ready', 'working-unavailable', 'history-unavailable', 'both-unavailable'].includes(input.activity)) return answer(res, { error: 'Unknown controlled activity scenario.' }, 400);
    activityMode = input.activity;
    return answer(res, { fixture: true, activity: activityMode });
  }
  if (/^\/(?:api\/console|m\/api)\/inbox\/attention\/presentation$/.test(pathname) && req.method === 'POST') {
    let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 4096) return answer(res, { error: 'Fixture request too large.' }, 413); }
    let input; try { input = JSON.parse(text); } catch { return answer(res, { error: 'Invalid fixture request.' }, 400); }
    if (!input || typeof input.key !== 'string' || !['dismiss', 'defer', 'restore'].includes(input.action) || typeof input.generation !== 'string' || !/^[a-f0-9]{64}$/.test(input.generation)) return answer(res, { error: 'Invalid controlled attention request.' }, 400);
    const item = attentionItems.find(row => row.key === input.key);
    const previous = attentionPreferences.get(input.key);
    if (!item || item.lifecycle.generation !== input.generation || input.action === 'restore' && (!input.mutationToken || previous?.generation !== input.generation || previous?.mutationToken !== input.mutationToken)) return answer(res, { ok: false, key: input.key, action: input.action, error: 'This controlled attention item or its latest choice changed. Refresh before trying again.' }, 409);
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
    const receipt = { generation: input.generation, action: input.action, mutationToken: input.action === 'restore' ? input.mutationToken : randomUUID(), ...(input.action === 'defer' ? { until: tomorrow.toISOString() } : {}) };
    attentionPreferences.set(input.key, receipt);
    return answer(res, { fixture: true, ok: true, key: input.key, ...receipt });
  }
  const match = /^\/(?:api\/console|m\/api)\/inbox\/questions\/([^/]+)\/presentation$/.exec(pathname);
  if (!match) return answer(res, { error: 'FRAMEWORK-TEST: this write is unavailable. No real work runs in this preview.' }, 403);
  const q = questions.find(row => row.id === decodeURIComponent(match[1]));
  if (!q) return answer(res, { error: 'Unknown controlled fixture question.' }, 403);
  let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) return answer(res, { error: 'Fixture request too large.' }, 413); }
  let input; try { input = JSON.parse(body); } catch { return answer(res, { error: 'Invalid fixture request.' }, 400); }
  const previous = preferences.get(q.id);
  if (!['dismiss', 'defer', 'restore'].includes(input.action)) return answer(res, { error: 'Unsupported fixture action.' }, 403);
  if ((input.generation && input.generation !== q.lifecycle.generation) || (input.action === 'restore' && (!input.generation || !input.mutationToken || input.mutationToken !== previous?.mutationToken))) return answer(res, { error: 'This controlled fixture choice changed. Refresh before restoring.' }, 409);
  const receipt = { action: input.action, mutationToken: input.action === 'restore' ? input.mutationToken : randomUUID(), ...(input.action === 'defer' ? { until: new Date(Date.now() + 86_400_000).toISOString() } : {}) };
  preferences.set(q.id, receipt);
  return answer(res, { fixture: true, ok: true, id: q.id, generation: q.lifecycle.generation, ...receipt });
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webp': 'image/webp' };
function previewPath(raw, mobile) {
  const prefix = mobile ? '/m/' : '/console/';
  if (typeof raw !== 'string' || !raw.startsWith(prefix) || raw.includes('\\')) return mobile ? '/m/?tab=inbox' : '/console/inbox';
  const parsed = new URL(raw, 'http://fixture.invalid');
  parsed.searchParams.delete('__fixture_frame');
  return parsed.origin === 'http://fixture.invalid' ? parsed.pathname + parsed.search + parsed.hash : prefix;
}
const fixtureViewport = value => ['320', '393', '800', '1280'].includes(String(value)) ? Number(value) : null;
const previewUrl = (appPath, requestedViewport) => '/__fixtures/preview?' + new URLSearchParams({ path: appPath, ...(fixtureViewport(requestedViewport) ? { viewport: String(fixtureViewport(requestedViewport)) } : {}) });
function previewPage(appPath, mobile, requestedViewport) {
  const viewport = fixtureViewport(requestedViewport);
  const previewLink = appPath => previewUrl(appPath, viewport);
  const initial = new URL(appPath, 'http://fixture.invalid');
  initial.searchParams.set('__fixture_frame', '1');
  const frameSource = (initial.pathname + initial.search + initial.hash).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const inbox = mobile ? '/m/?tab=inbox' : '/console/inbox';
  const projectUrl = mobile ? `/m/?tab=projects&project=${projectId}` : `/console/projects/${projectId}`;
  const chatsUrl = mobile ? '/m/?tab=chats' : `/console/chat/harness%3A${sessionId}`;
  const setupUrl = '/console/onboarding';
  const setupLink = mobile ? '' : `<a href="${previewLink(setupUrl)}" data-app-path="${setupUrl}">Setup</a>`;
  const approvalUrl = mobile ? '/m/?tab=inbox&item=approval%3AFRAMEWORK-TEST-approval-readable' : '/console/inbox?tab=needs&select=approval%3AFRAMEWORK-TEST-approval-readable';
  const agentUrl = mobile ? `/m/?tab=projects&agent=${agentId}` : `/console/agents/${agentId}/t/harness%3A${sessionId}`;
  const resultUrl = mobile ? `/m/?tab=activity&run=${encodeURIComponent(workerSessionId)}` : `/console/chat/${encodeURIComponent(workerSession.id)}`;
  const reviewRunUrl = mobile ? `/m/?tab=activity&run=${encodeURIComponent(reviewSessionId)}` : `/console/chat/${encodeURIComponent(reviewSession.id)}`;
  const phoneFrame = mobile || viewport ? `body{background:#eeece7}iframe{max-width:${viewport ?? 393}px;margin-inline:auto;background:white}` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FRAMEWORK-TEST · Sample preview</title><style>html,body{margin:0;height:100%;overflow:hidden;font-family:system-ui}#fixture-banner{height:48px;box-sizing:border-box;background:#fff4c2;color:#302700;font-size:11px;display:flex;align-items:center;justify-content:center;gap:12px;padding:4px 8px;border-bottom:1px solid #cabd7a}#fixture-banner a{color:inherit;text-decoration:underline}#fixture-banner button{font:inherit;background:transparent;border:1px solid #9c8b42;border-radius:4px;padding:3px}iframe{display:block;width:100%;height:calc(100dvh - 48px);border:0}${phoneFrame}@media(max-width:480px){#fixture-banner{flex-wrap:wrap;align-content:center;gap:3px 12px;font-size:10px}#fixture-banner b{flex-basis:100%;text-align:center}}</style></head><body><div id="fixture-banner" role="note"><b>FRAMEWORK-TEST · Sample data only${viewport ? ` · ${viewport}px ${mobile ? 'phone' : 'desktop'}` : ''}</b><a href="${previewLink(inbox)}" data-app-path="${inbox}">Inbox</a><a href="${previewLink(projectUrl)}" data-app-path="${projectUrl}">Project</a><a href="${previewLink(approvalUrl)}" data-app-path="${approvalUrl}">Approval</a><a href="${previewLink(chatsUrl)}" data-app-path="${chatsUrl}">Chats</a><a href="${previewLink(agentUrl)}" data-app-path="${agentUrl}">Agent</a><a href="${previewLink(resultUrl)}" data-app-path="${resultUrl}">Result</a><a href="${previewLink(reviewRunUrl)}" data-app-path="${reviewRunUrl}">Review run</a>${setupLink}<button id="fixture-reset">Reset</button></div><iframe id="fixture-app" title="Clementine · Controlled sample app" src="${frameSource}"></iframe><script>const frame=document.getElementById('fixture-app');function framePath(raw){const at=new URL(raw,location.origin);at.searchParams.set('__fixture_frame','1');return at.pathname+at.search+at.hash}document.querySelectorAll('[data-app-path]').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();frame.src=framePath(link.dataset.appPath)}));document.getElementById('fixture-reset').addEventListener('click',()=>fetch('/__fixtures/reset',{method:'POST'}).then(()=>{const at=frame.contentWindow.location;frame.src=framePath(at.pathname+at.search+at.hash)}));function remember(){try{const at=frame.contentWindow.location;if(at.origin!==location.origin)return;const clean=new URL(at.href);clean.searchParams.delete('__fixture_frame');const path=clean.pathname+clean.search+clean.hash;if(!path.startsWith(${JSON.stringify(mobile ? '/m/' : '/console/')}))return;const params=new URLSearchParams({path});const viewport=${JSON.stringify(viewport)};if(viewport)params.set('viewport',String(viewport));const next='/__fixtures/preview?'+params;if(location.pathname+location.search!==next)history.replaceState(null,'',next)}catch{}}frame.addEventListener('load',remember);setInterval(remember,350);</script></body></html>`;
}
function createPreview(port, mobile) {
  const base = fs.realpathSync(path.join(repo, 'apps', mobile ? 'mobile-web' : 'console-web', 'dist'));
  const prefix = mobile ? '/m/' : '/console/';
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Clementine-Fixture', label); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method !== 'GET' && req.method !== 'HEAD') return await mutation(req, res, url.pathname);
      if (url.pathname === '/__fixtures/scenario') return answer(res, { fixture: true, activity: activityMode, experience: experienceMode });
      if (url.pathname === '/__fixtures/preview') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(req.method === 'HEAD' ? undefined : previewPage(previewPath(url.searchParams.get('path'), mobile), mobile, url.searchParams.get('viewport'))); }
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/m/api/') || url.pathname.startsWith('/m/auth/')) {
        if (/\/(?:events|stream)$/.test(url.pathname)) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('retry: 60000\nevent: fixture\ndata: {"fixture":true}\n\n'); return; }
        const body = apiGet(url, mobile);
        if (body?.fixtureStatus) return answer(res, { fixture: true, error: body.error }, body.fixtureStatus);
        if (body?.fixtureContent !== undefined) { res.writeHead(200, { 'Content-Type': body.fixtureMime }); return res.end(req.method === 'HEAD' ? undefined : body.fixtureContent); }
        if (body !== undefined) return answer(res, body);
        if (!routesSeen.has(url.pathname)) { routesSeen.add(url.pathname); process.stdout.write(`Fixture has no response for GET ${url.pathname}\n`); }
        return answer(res, { error: 'This endpoint is outside the controlled visual fixture.', fixture: true }, 404);
      }
      const relative = decodeURIComponent(url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '');
      let candidate = path.resolve(base, relative || 'index.html');
      if (!candidate.startsWith(base + path.sep) && candidate !== base) return answer(res, { error: 'Outside fixture assets.' }, 403);
      if (!fs.existsSync(candidate) || fs.statSync(candidate).isDirectory()) candidate = path.join(base, 'index.html');
      candidate = fs.realpathSync(candidate); if (!candidate.startsWith(base + path.sep)) return answer(res, { error: 'Outside fixture assets.' }, 403);
      if (candidate.endsWith('index.html') && req.headers['sec-fetch-dest'] !== 'iframe' && url.searchParams.get('__fixture_frame') !== '1') { res.writeHead(302, { Location: previewUrl(previewPath(url.pathname + url.search, mobile)) }); return res.end(); }
      const content = fs.readFileSync(candidate);
      res.writeHead(200, { 'Content-Type': mime[path.extname(candidate)] ?? 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch { answer(res, { error: 'The controlled fixture could not answer this request.', fixture: true }, 500); }
  });
  server.on('error', error => { process.stderr.write(`Fixture server ${port}: ${error.message}\n`); process.exitCode = 1; for (const running of servers) running.close(); });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`${label} ${mobile ? 'mobile' : 'desktop'} visual preview: http://127.0.0.1:${port}${previewUrl(mobile ? '/m/?tab=inbox' : '/console/inbox')}\n`));
  return server;
}
const servers = [];
servers.push(createPreview(5182, false), createPreview(5183, true));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const server of servers) server.close(); process.exit(0); });
