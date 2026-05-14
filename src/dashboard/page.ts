import type { PendingApproval } from '../types.js';
import { buildDashboardSnapshot } from './state.js';

interface DashboardFlashMessage {
  kind: 'success' | 'error';
  text: string;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pathLabel(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() ?? filePath;
}

function renderStack(items: string[], empty: string, className = 'stack-list'): string {
  if (items.length === 0) return `<p class="empty">${esc(empty)}</p>`;
  return `<div class="${esc(className)}">${items.map((item) => `<div class="stack-item">${item}</div>`).join('')}</div>`;
}

function renderPanel(title: string, eyebrow: string, body: string, options: { className?: string; actions?: string } = {}): string {
  return `<section class="panel ${esc(options.className ?? '')}">
    <div class="panel-head">
      <div>
        <p class="eyebrow">${esc(eyebrow)}</p>
        <h2>${esc(title)}</h2>
      </div>
      ${options.actions ? `<div class="panel-actions">${options.actions}</div>` : ''}
    </div>
    <div class="panel-body">${body}</div>
  </section>`;
}

function renderStatusLine(tone: 'ok' | 'warn' | 'danger' | 'idle', title: string, detail: string): string {
  return `<div class="status-line ${tone}">
    <span class="status-dot"></span>
    <div><strong>${esc(title)}</strong><p>${esc(detail)}</p></div>
  </div>`;
}

function renderMetric(label: string, value: string | number, detail: string, tone: 'ok' | 'warn' | 'danger' | 'idle' = 'idle'): string {
  return `<div class="metric-card ${tone}">
    <span>${esc(label)}</span>
    <strong>${esc(value)}</strong>
    <p>${esc(detail)}</p>
  </div>`;
}

function renderActionButton(action: string, token: string, label: string, hiddenInputs: Record<string, string> = {}, secondary = false): string {
  const inputs = Object.entries(hiddenInputs)
    .map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(value)}" />`)
    .join('');
  return `<form method="post" action="${esc(action)}?token=${encodeURIComponent(token)}">${inputs}<button class="${secondary ? 'secondary' : ''}" type="submit">${esc(label)}</button></form>`;
}

function checked(value: boolean): string {
  return value ? ' checked' : '';
}

export async function renderDashboardHtml(
  approvals: PendingApproval[],
  token: string,
  flash?: DashboardFlashMessage,
): Promise<string> {
  const snapshot = await buildDashboardSnapshot();
  type DashboardRun = typeof snapshot.recentRuns[number];
  type DashboardBackgroundTask = typeof snapshot.backgroundTasks[number];

  const authReady = snapshot.auth.configured;
  const semanticReady = snapshot.memoryIndex.embeddingsEnabled;
  const composioReady = snapshot.composio.enabled;
  const discordReady = Boolean(snapshot.discord.connected || snapshot.discord.enabled);
  const projectsReady = snapshot.workspaceProjects.length > 0;
  const cliReady = snapshot.globalClis.some((cli) => cli.available);
  const unreadNotifications = snapshot.notifications.filter((item) => !item.read).length;
  const activeBackground = snapshot.backgroundTasks.filter((task) => task.status === 'pending' || task.status === 'running' || task.status === 'cancelling' || task.status === 'awaiting_approval' || task.status === 'interrupted').length;
  const activeWork = snapshot.activeExecutions.length + activeBackground;
  const proactivity = snapshot.proactivity;
  const policy = proactivity.policy;

  const readinessItems = [
    renderStatusLine(authReady ? 'ok' : 'danger', 'Model runtime', authReady ? snapshot.auth.message : 'Authentication needs attention before reliable agent runs.'),
    renderStatusLine(proactivity.proactiveWorkAllowed ? 'ok' : 'warn', 'Proactive loop', proactivity.proactiveWorkAllowed ? `${policy.mode} mode, check-ins every ${policy.checkInMinutes} minutes.` : proactivity.quietHoursActive ? 'Paused by quiet hours.' : 'Disabled in autonomy policy.'),
    renderStatusLine(semanticReady ? 'ok' : 'warn', 'Semantic memory', semanticReady ? `${snapshot.memoryIndex.embeddingsCount} vectors indexed.` : 'FTS memory works. Add an OpenAI API key to enable embedding recall.'),
    renderStatusLine(projectsReady ? 'ok' : 'warn', 'Project access', projectsReady ? `${snapshot.workspaceProjects.length} projects discovered.` : 'Add workspace roots so Clementine can find repos.'),
    renderStatusLine(composioReady ? 'ok' : 'warn', 'Connected apps', composioReady ? `${snapshot.composio.connected.length} active app connections.` : 'Add a Composio API key to connect Gmail, Slack, Notion, GitHub, and more.'),
    renderStatusLine(cliReady ? 'ok' : 'warn', 'Local CLIs', `${snapshot.globalClis.filter((cli) => cli.available).length}/${snapshot.globalClis.length} detected in the daemon PATH.`),
    renderStatusLine(discordReady ? 'ok' : 'warn', 'Discord', snapshot.discord.connected ? `${snapshot.discord.userTag ?? 'Bot'} is connected.` : 'Discord is configured but may need restart or install.'),
  ];

  const metrics = [
    renderMetric('Runtime', authReady ? 'Ready' : 'Blocked', `${snapshot.auth.mode} / ${snapshot.auth.source}`, authReady ? 'ok' : 'danger'),
    renderMetric('Autonomy', proactivity.proactiveWorkAllowed ? 'Live' : 'Paused', `${policy.mode}, ${policy.checkInMinutes}m check-ins`, proactivity.proactiveWorkAllowed ? 'ok' : 'warn'),
    renderMetric('Live Work', activeWork, `${snapshot.activeExecutions.length} executions, ${activeBackground} background`, activeWork > 0 ? 'warn' : 'idle'),
    renderMetric('Approvals', approvals.length, 'manual decisions waiting', approvals.length > 0 ? 'warn' : 'ok'),
    renderMetric('Runs', snapshot.recentRuns.length, 'recent timeline entries', 'idle'),
    renderMetric('Projects', snapshot.workspaceProjects.length, `${snapshot.workspaces.length} workspace roots`, projectsReady ? 'ok' : 'warn'),
    renderMetric('Memory', snapshot.memoryIndex.chunks, `${snapshot.memoryIndex.activeFacts} facts, ${Math.round(snapshot.memoryIndex.embeddingsCoverage * 100)}% vectors`, semanticReady ? 'ok' : 'warn'),
    renderMetric('Apps', snapshot.composio.connected.length, composioReady ? 'Composio configured' : 'Composio missing', composioReady ? 'ok' : 'warn'),
    renderMetric('Notifications', unreadNotifications, `${snapshot.notifications.length} recent total`, unreadNotifications > 0 ? 'warn' : 'ok'),
  ];
  const dashboardTabs = [
    { id: 'overview', label: 'Overview', value: activeWork, detail: 'Health + live work' },
    { id: 'setup', label: 'Setup', value: authReady ? 'ok' : '!', detail: 'Auth + Discord' },
    { id: 'projects', label: 'Projects', value: snapshot.workspaceProjects.length, detail: 'Repos + CLIs' },
    { id: 'automation', label: 'Automation', value: snapshot.cronJobs.length, detail: 'Schedules + runs' },
    { id: 'apps', label: 'Apps', value: snapshot.composio.connected.length, detail: 'Composio + routing' },
    { id: 'agents', label: 'Agents', value: snapshot.agents.length, detail: 'Team + queues' },
    { id: 'memory', label: 'Memory', value: snapshot.memoryIndex.chunks, detail: 'Facts + sessions' },
    { id: 'system', label: 'System', value: snapshot.runtimeTools.length, detail: 'Tools + delivery' },
  ];
  const renderDashboardTabLinks = (variant: 'nav' | 'strip') => dashboardTabs.map((tab, index) => {
    const detail = variant === 'strip' ? `<small>${esc(tab.detail)}</small>` : '';
    return `<a class="${index === 0 ? 'active' : ''}" href="#${esc(tab.id)}" data-tab="${esc(tab.id)}" role="tab" aria-controls="${esc(tab.id)}" aria-selected="${index === 0 ? 'true' : 'false'}">
      <span>${esc(tab.label)}${detail}</span>
      <strong>${esc(tab.value)}</strong>
    </a>`;
  }).join('');

  const approvalItems = approvals.map((approval) =>
    `<div class="item-title"><strong>${esc(approval.toolName)}</strong><code>${esc(approval.id)}</code></div><p>Session ${esc(approval.sessionId)}${approval.userId ? ` | user ${esc(approval.userId)}` : ''}${approval.channel ? ` | ${esc(approval.channel)}` : ''}</p>`,
  );
  const approvalActionItems = approvals.map((approval) =>
    `<div class="action-row"><div><strong>${esc(approval.toolName)}</strong><code>${esc(approval.id)}</code></div>${renderActionButton('/dashboard/actions/approve', token, 'Approve', { id: approval.id })}${renderActionButton('/dashboard/actions/reject', token, 'Reject', { id: approval.id }, true)}</div>`,
  );

  const executionItems = snapshot.activeExecutions.map((execution) => {
    const latestActivity = [...(execution.activity ?? [])]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return `<div class="item-title"><strong>${esc(execution.title)}</strong><span class="badge ${execution.status === 'blocked' ? 'danger' : 'blue'}">${esc(execution.status)}</span></div>
      <p>${esc(execution.objective)}</p>
      ${execution.lastAssistantSummary ? `<p>${esc(execution.lastAssistantSummary)}</p>` : ''}
      <p class="muted">Session ${esc(execution.sessionId)}${execution.planId ? ` | plan ${esc(execution.planId)}` : ''}${execution.nextReviewAt ? ` | review ${esc(execution.nextReviewAt)}` : ''}</p>
      <p class="muted">Next: ${esc(execution.nextStep ?? 'decide next step')}</p>
      ${execution.blocker ? `<p class="muted">Blocker: ${esc(execution.blocker)}</p>` : ''}
      ${latestActivity ? `<p class="muted">Latest: ${esc(latestActivity.message)}</p>` : ''}`;
  });

	  const backgroundTaskItems = snapshot.backgroundTasks.map((task) =>
	    `<div class="item-title"><strong>${esc(task.title)}</strong><span class="badge">${esc(task.status)}</span></div>
	    <p class="muted">Source ${esc(task.source)}${task.originSessionId ? ` | origin ${esc(task.originSessionId)}` : ''}${task.pendingApprovalId ? ` | approval ${esc(task.pendingApprovalId)}` : ''}</p>
	    ${task.lastCheckInAt ? `<p class="muted">Last check-in: ${esc(task.lastCheckInAt)}${task.progressCheckIns ? ` | ${esc(task.progressCheckIns)} check-ins` : ''}</p>` : ''}
	    ${task.lastCheckInMessage ? `<p>${esc(task.lastCheckInMessage)}</p>` : ''}
	    ${task.result ? `<p>${esc(task.result.slice(0, 500))}</p>` : ''}${task.error ? `<p class="danger-text">Error: ${esc(task.error)}</p>` : ''}`,
	  );

  const backgroundTaskById = new Map<string, DashboardBackgroundTask>(snapshot.backgroundTasks.map((task) => [task.id, task]));
  const pendingApprovalIds = new Set(approvals.map((approval) => approval.id));
  const runTone = (status: DashboardRun['status']): 'ok' | 'warn' | 'danger' | 'blue' | 'gray' =>
    status === 'failed' || status === 'cancelled'
      ? 'danger'
      : status === 'running'
        ? 'blue'
        : status === 'queued' || status === 'awaiting_approval'
          ? 'warn'
          : status === 'completed'
            ? 'ok'
            : 'gray';
  const eventTone = (type: DashboardRun['events'][number]['type']): 'ok' | 'warn' | 'danger' | 'blue' | 'gray' =>
    type === 'failed' || type === 'cancelled'
      ? 'danger'
      : type === 'approval_required' || type === 'queued_background'
        ? 'warn'
        : type === 'tool_started' || type === 'model_started'
          ? 'blue'
          : type === 'completed'
            ? 'ok'
            : 'gray';
  const renderRunActions = (run: DashboardRun): string => {
    const task = run.queuedTaskId ? backgroundTaskById.get(run.queuedTaskId) : undefined;
    const canCancelTask = Boolean(task && ['pending', 'running', 'awaiting_approval', 'interrupted'].includes(task.status));
    const canNotifyDiscord = Boolean(run.channel?.startsWith('discord:'));
    const canApprove = Boolean(run.pendingApprovalId && pendingApprovalIds.has(run.pendingApprovalId));
    const actions = [
      canApprove && run.pendingApprovalId ? renderActionButton('/dashboard/actions/approve', token, 'Approve', { id: run.pendingApprovalId }) : '',
      canApprove && run.pendingApprovalId ? renderActionButton('/dashboard/actions/reject', token, 'Reject', { id: run.pendingApprovalId }, true) : '',
      canCancelTask ? renderActionButton(`/dashboard/actions/runs/${encodeURIComponent(run.id)}/cancel`, token, task?.status === 'running' ? 'Request Cancel' : 'Cancel Task', {}, true) : '',
      renderActionButton(`/dashboard/actions/runs/${encodeURIComponent(run.id)}/retry`, token, task && ['failed', 'aborted', 'interrupted'].includes(task.status) ? 'Resume / Retry' : 'Retry as Task'),
      canNotifyDiscord ? renderActionButton(`/dashboard/actions/runs/${encodeURIComponent(run.id)}/notify`, token, 'Send Discord Update', {}, true) : '',
      `<a class="button-link secondary" href="/api/runs/${encodeURIComponent(run.id)}?token=${encodeURIComponent(token)}" target="_blank" rel="noreferrer">Open JSON</a>`,
    ].filter(Boolean);
    return `<div class="run-actions">${actions.join('')}</div>`;
  };
  const renderRunSelector = (run: DashboardRun, index: number): string => {
    const latestEvent = run.events[run.events.length - 1];
    const task = run.queuedTaskId ? backgroundTaskById.get(run.queuedTaskId) : undefined;
    const tone = runTone(run.status);
	    return `<button class="run-selector ${index === 0 ? 'active' : ''}" type="button" data-run-select="${esc(run.id)}">
	      <span class="timeline-dot ${tone}"></span>
	      <span>
	        <strong>${esc(run.title)}</strong>
	        <small data-live-run-summary="${esc(run.id)}">${esc(run.id)} | ${esc(run.status)}${task ? ` | task ${esc(task.status)}` : ''}</small>
	        <em data-live-run-latest="${esc(run.id)}">${latestEvent ? esc(latestEvent.message) : ''}</em>
	      </span>
	    </button>`;
	  };
  const renderRunDetail = (run: DashboardRun, index: number): string => {
    const task = run.queuedTaskId ? backgroundTaskById.get(run.queuedTaskId) : undefined;
    const latestEvent = run.events[run.events.length - 1];
    const toolEvents = run.events.filter((event) => event.type === 'tool_started');
    const runDetails = [
      `<strong>Status</strong><span><span class="badge ${runTone(run.status)}">${esc(run.status)}</span></span>`,
      `<strong>Run ID</strong><span><code>${esc(run.id)}</code></span>`,
      `<strong>Session</strong><span>${esc(run.sessionId)}</span>`,
      `<strong>Source</strong><span>${esc(run.source ?? 'unknown')}</span>`,
      `<strong>Created</strong><span>${esc(run.createdAt)}</span>`,
      `<strong>Updated</strong><span>${esc(run.updatedAt)}</span>`,
      run.completedAt ? `<strong>Completed</strong><span>${esc(run.completedAt)}</span>` : '',
      run.channel ? `<strong>Channel</strong><span>${esc(run.channel)}</span>` : '',
      run.userId ? `<strong>User</strong><span>${esc(run.userId)}</span>` : '',
      run.queuedTaskId ? `<strong>Background task</strong><span><code>${esc(run.queuedTaskId)}</code>${task ? ` <span class="badge ${task.status === 'done' ? 'ok' : task.status === 'failed' || task.status === 'aborted' ? 'danger' : 'warn'}">${esc(task.status)}</span>` : ''}</span>` : '',
      run.pendingApprovalId ? `<strong>Approval</strong><span><code>${esc(run.pendingApprovalId)}</code>${pendingApprovalIds.has(run.pendingApprovalId) ? ' <span class="badge warn">pending</span>' : ''}</span>` : '',
      toolEvents.length ? `<strong>Tools</strong><span>${esc(toolEvents.map((event) => String(event.data?.toolName ?? 'tool')).join(', '))}</span>` : '',
    ].filter(Boolean);
    const eventRows = run.events.map((event) => `<div class="run-event-row" data-run-event-id="${esc(event.id)}">
      <span class="timeline-dot ${eventTone(event.type)}"></span>
      <div>
        <div class="item-title"><strong>${esc(event.type)}</strong><span class="muted">${esc(event.createdAt)}</span></div>
        <p>${esc(event.message)}</p>
        ${event.data && Object.keys(event.data).length > 0 ? `<pre class="run-pre compact">${esc(JSON.stringify(event.data, null, 2))}</pre>` : ''}
      </div>
    </div>`);
    return `<div class="run-detail ${index === 0 ? 'active' : ''}" data-run-detail="${esc(run.id)}">
	      <div class="run-detail-head">
	        <div>
	          <p class="eyebrow">Selected Run</p>
	          <h3>${esc(run.title)}</h3>
	          <p class="muted" data-live-run-latest-detail="${esc(run.id)}">${latestEvent ? esc(latestEvent.message) : ''}</p>
	        </div>
	        <span class="badge ${runTone(run.status)}" data-live-run-status="${esc(run.id)}">${esc(run.status)}</span>
	      </div>
      ${renderRunActions(run)}
      <div class="run-meta-grid">${runDetails.map((item) => `<div class="stack-item">${item}</div>`).join('')}</div>
      <div class="run-split">
        <div>
          <p class="eyebrow">Original Request</p>
          <pre class="run-pre">${esc(run.input)}</pre>
        </div>
        <div>
          <p class="eyebrow">Result / Error</p>
          <pre class="run-pre" data-live-run-output="${esc(run.id)}">${esc(run.error ?? run.outputPreview ?? 'No output captured yet.')}</pre>
        </div>
      </div>
      <div class="run-events" data-live-run-events="${esc(run.id)}">${eventRows.join('') || '<p class="empty">No timeline events captured yet.</p>'}</div>
    </div>`;
  };
  const runControlBody = snapshot.recentRuns.length
    ? `<div class="run-control">
      <div class="run-picker">${snapshot.recentRuns.map(renderRunSelector).join('')}</div>
      <div class="run-details">${snapshot.recentRuns.map(renderRunDetail).join('')}</div>
    </div>
    <p class="mini-note">Pause is not exposed yet because the worker loop needs cooperative checkpoints. Cancel works for queued/background work; retry creates a fresh durable task.</p>`
    : '<p class="empty">No runs recorded yet.</p>';

  const proactivityItems = [
    `<strong>Status</strong><span>${proactivity.proactiveWorkAllowed ? 'allowed' : proactivity.quietHoursActive ? 'quiet hours active' : 'disabled'}</span>`,
    `<strong>Mode</strong><span>${esc(policy.mode)}</span>`,
    `<strong>Check-ins</strong><span>Every ${esc(policy.checkInMinutes)} minutes</span>`,
    `<strong>Proactive briefs</strong><span>Every ${esc(policy.briefCadenceMinutes)} minutes</span>`,
    `<strong>Long task max</strong><span>${esc(policy.defaultLongTaskMinutes)} minutes</span>`,
    `<strong>Background concurrency</strong><span>${esc(policy.maxConcurrentBackgroundTasks)}</span>`,
    `<strong>Execution gate</strong><span>${policy.requireWorkflowApprovalForExecution ? 'tracked execution required' : 'disabled'}</span>`,
    `<strong>Quiet hours</strong><span>${policy.quietHoursEnabled ? `${esc(policy.quietHoursStart)} to ${esc(policy.quietHoursEnd)}` : 'off'}</span>`,
    snapshot.proactiveBrief.lastBriefAt ? `<strong>Last brief</strong><span>${esc(snapshot.proactiveBrief.lastBriefAt)}</span>` : '',
  ];
  const proactivityPolicyForm = `<form class="form-stack" method="post" action="/dashboard/actions/proactivity-policy?token=${encodeURIComponent(token)}">
    <label class="check-row"><input type="checkbox" name="enabled"${checked(policy.enabled)} /> <span>Enable proactive execution controller and autonomous agent wake cycles</span></label>
    <div class="form-grid">
      <select name="mode">
        <option value="watch"${policy.mode === 'watch' ? ' selected' : ''}>Watch - surface updates, minimal initiative</option>
        <option value="balanced"${policy.mode === 'balanced' ? ' selected' : ''}>Balanced - move work forward safely</option>
        <option value="hands_on"${policy.mode === 'hands_on' ? ' selected' : ''}>Hands-on - bias toward taking action</option>
      </select>
      <input name="check_in_minutes" value="${esc(policy.checkInMinutes)}" placeholder="Check-in minutes" />
    </div>
    <div class="form-grid">
      <input name="brief_cadence_minutes" value="${esc(policy.briefCadenceMinutes)}" placeholder="Proactive brief cadence minutes" />
      <input name="default_long_task_minutes" value="${esc(policy.defaultLongTaskMinutes)}" placeholder="Default long-task max minutes" />
    </div>
    <input name="max_concurrent_background_tasks" value="${esc(policy.maxConcurrentBackgroundTasks)}" placeholder="Concurrent background tasks" />
    <label class="check-row"><input type="checkbox" name="quiet_hours_enabled"${checked(policy.quietHoursEnabled)} /> <span>Pause proactive work during quiet hours</span></label>
    <div class="form-grid">
      <input name="quiet_hours_start" value="${esc(policy.quietHoursStart)}" placeholder="22:00" />
      <input name="quiet_hours_end" value="${esc(policy.quietHoursEnd)}" placeholder="07:00" />
    </div>
    <label class="check-row"><input type="checkbox" name="allow_discord_checkins"${checked(policy.allowDiscordCheckIns)} /> <span>Allow Discord delivery for long-task status updates</span></label>
    <label class="check-row"><input type="checkbox" name="allow_composio_actions"${checked(policy.allowComposioActions)} /> <span>Allow connected-app actions when tools require them</span></label>
    <label class="check-row"><input type="checkbox" name="allow_computer_actions"${checked(policy.allowComputerActions)} /> <span>Allow local computer actions with configured approval gates</span></label>
    <label class="check-row"><input type="checkbox" name="require_workflow_approval_for_execution"${checked(policy.requireWorkflowApprovalForExecution)} /> <span>Require tracked workflow approval before Executor/Deployer handoffs</span></label>
    <button type="submit">Save Autonomy Policy</button>
  </form>`;
  const proactiveBriefItems = [
    snapshot.proactiveBrief.lastBriefAt ? `<strong>Last sent</strong><span>${esc(snapshot.proactiveBrief.lastBriefAt)}</span>` : '',
    snapshot.proactiveBrief.lastTitle ? `<strong>Title</strong><span>${esc(snapshot.proactiveBrief.lastTitle)}</span>` : '',
    snapshot.proactiveBrief.lastSummary ? `<strong>Summary</strong><span>${esc(snapshot.proactiveBrief.lastSummary)}</span>` : '',
    snapshot.proactiveBrief.lastSignature ? `<strong>Signature</strong><span><code>${esc(snapshot.proactiveBrief.lastSignature)}</code></span>` : '',
  ].filter(Boolean);
  const longTaskForm = `<form class="form-stack" method="post" action="/dashboard/actions/background/create?token=${encodeURIComponent(token)}">
    <div class="form-grid">
      <input name="title" placeholder="Find and audit the Clementine project" />
      <input name="max_minutes" value="${esc(policy.defaultLongTaskMinutes)}" placeholder="Max minutes" />
    </div>
    <textarea name="prompt" rows="8" placeholder="Describe the long-running task. Clementine will queue it, run in the daemon, emit check-ins, and keep the run visible here." required></textarea>
    <button type="submit">Queue Long Task</button>
  </form>`;

  const cronItems = snapshot.cronJobs.map((job) =>
    `<div class="item-title"><strong>${esc(job.name)}</strong><span class="badge blue">${esc(job.schedule)}</span>${job.mode === 'unleashed' ? '<span class="badge purple">unleashed</span>' : ''}</div>
    <p>${esc(job.prompt.slice(0, 180))}</p>
    ${job.work_dir ? `<p class="muted">${esc(job.work_dir)}</p>` : ''}`,
  );
  const cronActionItems = snapshot.cronJobs.map((job) =>
    `<div class="action-row"><div><strong>${esc(job.name)}</strong><p class="muted">${esc(job.schedule)}</p></div>${renderActionButton('/dashboard/actions/trigger-cron', token, 'Run Now', { job_name: job.name })}</div>`,
  );
  const cronRunItems = snapshot.recentCronRuns.map((run) =>
    `<div class="item-title"><strong>${esc(run.file)}</strong><span class="badge">${esc(run.status)}</span></div><p class="muted">${esc(run.finishedAt ?? run.startedAt ?? '')}</p>`,
  );

  const workflowItems = snapshot.workflows.map((workflow) =>
    `<div class="item-title"><strong>${esc(workflow.name)}</strong><span class="badge ${workflow.enabled ? 'ok' : 'gray'}">${workflow.enabled ? 'enabled' : 'disabled'}</span></div>
    <p>${esc(workflow.description || '(no description)')}</p>
    <p class="muted">Steps: ${workflow.steps.map((step) => esc(step.id)).join(' -> ') || 'none'}</p>`,
  );
  const workflowActionItems = snapshot.workflows
    .filter((workflow) => workflow.enabled && workflow.trigger.manual !== false)
    .map((workflow) =>
      `<div class="action-row"><div><strong>${esc(workflow.name)}</strong><p class="muted">${esc(workflow.steps.length)} steps</p></div>${renderActionButton('/dashboard/actions/run-workflow', token, 'Queue Run', { name: workflow.name })}</div>`,
    );
  const workflowRunItems = snapshot.recentWorkflowRuns.map((run) =>
    `<div class="item-title"><strong>${esc(run.workflow)}</strong><span class="badge">${esc(run.status)}</span></div><p class="muted">${esc(run.finishedAt ?? run.startedAt ?? run.createdAt ?? '')}</p>`,
  );

  const workspaceItems = snapshot.workspaces.map((workspace) =>
    `<div class="action-row"><div><strong>${esc(pathLabel(workspace))}</strong><p class="muted">${esc(workspace)}</p></div>${renderActionButton('/dashboard/actions/workspaces/remove', token, 'Remove', { directory: workspace }, true)}</div>`,
  );
  const projectItems = snapshot.workspaceProjects.map((project) =>
    `<div class="item-title"><strong>${esc(project.name)}</strong><span class="badge">${esc(project.type)}</span>${project.hasClaude ? '<span class="badge purple">claude notes</span>' : ''}</div>
    <p class="muted">${esc(project.path)}</p>${project.description ? `<p>${esc(project.description)}</p>` : ''}`,
  );
  const cliItems = snapshot.globalClis.map((cli) =>
    `<div class="item-title"><strong>${esc(cli.label)}</strong><code>${esc(cli.command)}</code><span class="badge ${cli.available ? 'ok' : 'gray'}">${cli.available ? 'available' : 'missing'}</span></div>
    <p>${esc(cli.purpose)}</p>${cli.version ? `<p class="muted">${esc(cli.version)}</p>` : ''}${cli.path ? `<p class="muted">${esc(cli.path)}</p>` : ''}`,
  );

  const memoryStatusItems = [
    `<strong>Indexed files</strong><span>${esc(snapshot.memoryIndex.indexedFiles)}</span>`,
    `<strong>Chunks</strong><span>${esc(snapshot.memoryIndex.chunks)}</span>`,
    `<strong>Facts</strong><span>${esc(snapshot.memoryIndex.activeFacts)} active / ${esc(snapshot.memoryIndex.totalFacts)} total</span>`,
    `<strong>Embeddings</strong><span>${snapshot.memoryIndex.embeddingsEnabled ? 'enabled' : 'disabled'} | ${esc(snapshot.memoryIndex.embeddingsCount)} vectors | ${esc(Math.round(snapshot.memoryIndex.embeddingsCoverage * 100))}% coverage</span>`,
    snapshot.memoryIndex.embeddingsModel ? `<strong>Embedding model</strong><span>${esc(snapshot.memoryIndex.embeddingsModel)} (${esc(snapshot.memoryIndex.embeddingsDim ?? '-')})</span>` : '',
    `<strong>Database</strong><span>${snapshot.memoryIndex.dbPresent ? `${esc(snapshot.memoryIndex.dbBytes)} bytes` : 'not created yet'}</span>`,
    snapshot.memoryIndex.lastIndexedSourceMtime ? `<strong>Latest source mtime</strong><span>${esc(new Date(snapshot.memoryIndex.lastIndexedSourceMtime).toISOString())}</span>` : '',
    snapshot.memoryIndex.error ? `<strong>Error</strong><span>${esc(snapshot.memoryIndex.error)}</span>` : '',
    `<strong>Path</strong><span>${esc(snapshot.memoryIndex.dbPath)}</span>`,
  ].filter(Boolean);
  const sessionBriefItems = snapshot.recentSessionBriefs.map((brief) => {
    const remaining = brief.manual?.remaining?.length ?? 0;
    const blockers = brief.manual?.blockers?.length ?? 0;
    return `<div class="item-title"><strong>${esc(brief.sessionId)}</strong></div><p>${esc(brief.auto.summary)}</p><p class="muted">Updated ${esc(brief.updatedAt)} | remaining ${esc(remaining)} | blockers ${esc(blockers)}</p>`;
  });
  const discordSessionItems = snapshot.recentDiscordSessions.map((session) =>
    `<div class="item-title"><strong>${esc(session.sessionId)}</strong></div><p class="muted">User ${esc(session.userId)} | channel ${esc(session.channelId)}${session.guildId ? ` | guild ${esc(session.guildId)}` : ' | DM'}</p><p class="muted">Last message ${esc(session.lastMessageAt)}</p>`,
  );

  const agentItems = snapshot.agents.map((agent) =>
    `<div class="item-title"><strong>${esc(agent.name)}</strong><code>${esc(agent.slug)}</code></div>
    <p>${esc(agent.description)}</p>
    <p class="muted">${agent.channelName ? `#${esc(agent.channelName)} | ` : ''}${agent.project ? `project: ${esc(agent.project)}` : 'no project binding'}</p>`,
  );
  const agentStateItems = snapshot.agentStates.map((state) => {
    const inbox = snapshot.agentInboxCounts.find((item) => item.slug === state.slug);
    return `<div class="item-title"><strong>${esc(state.slug)}</strong><span class="badge">${esc(inbox?.pending ?? 0)} pending</span></div><p>${esc(state.lastSummary ?? state.lastError ?? 'No recent activity.')}</p><p class="muted">Last run ${esc(state.lastRunAt ?? 'never')}</p>`;
  });

  const connectedAppItems = snapshot.composio.connected.map((connection) =>
    `<div class="action-row"><div><strong>${esc(connection.slug)}</strong><span class="badge ok">${esc(connection.status)}</span><p class="muted">${esc(connection.accountLabel ?? connection.alias ?? connection.connectionId)}</p></div>${renderActionButton('/dashboard/actions/composio/disconnect', token, 'Disconnect', { connection_id: connection.connectionId }, true)}</div>`,
  );
  const featuredToolkitSlugs = new Set(snapshot.composio.featured);
  const composioToolkitItems = snapshot.composio.toolkits
    .filter((toolkit) => featuredToolkitSlugs.has(toolkit.slug))
    .slice(0, 16)
    .map((toolkit) => {
      const activeConnections = toolkit.connections.filter((connection) => connection.status === 'ACTIVE').length;
      const needsByo = toolkit.authMode === 'byo' && !toolkit.hasAuthConfig;
      return `<div class="toolkit-row"><div><div class="item-title"><strong>${esc(toolkit.displayName)}</strong><code>${esc(toolkit.slug)}</code>${activeConnections ? `<span class="badge ok">${esc(activeConnections)} connected</span>` : ''}${toolkit.toolCount ? `<span class="badge">${esc(toolkit.toolCount)} tools</span>` : ''}</div><p>${esc(toolkit.description ?? (needsByo ? 'Requires a Composio auth config before OAuth can start.' : 'Connect this app through Composio OAuth.'))}</p></div>${renderActionButton('/dashboard/actions/composio/connect', token, activeConnections ? 'Connect Another' : 'Connect', { slug: toolkit.slug })}</div>`;
    });
  const toolPreferenceItems = snapshot.toolPreferences.services.map((service) => {
    const selected: string = snapshot.toolPreferences.preferences[service.id] ?? service.effective ?? '';
    const status = [
      service.composio?.available ? 'Composio connected' : '',
      service.mcp?.available ? 'MCP available' : '',
      service.hasConflict ? 'conflict' : '',
    ].filter(Boolean).join(' | ') || 'not connected';
    return `<div class="preference-row"><label><strong>${esc(service.label)}</strong><span class="muted">${esc(status)}</span></label><select name="pref_${esc(service.id)}"><option value=""${selected === '' ? ' selected' : ''}>Auto</option><option value="composio"${selected === 'composio' ? ' selected' : ''}>Composio</option><option value="mcp"${selected === 'mcp' ? ' selected' : ''}>MCP</option><option value="off"${selected === 'off' ? ' selected' : ''}>Off</option></select></div>`;
  });
  const runtimeToolGroups = snapshot.runtimeTools.reduce((groups, runtimeTool) => {
    const items = groups.get(runtimeTool.category) ?? [];
    items.push(runtimeTool);
    groups.set(runtimeTool.category, items);
    return groups;
  }, new Map<string, typeof snapshot.runtimeTools>());
  const runtimeToolItems = [...runtimeToolGroups.entries()].map(([category, tools]) =>
    `<div class="item-title"><strong>${esc(category)}</strong><span class="badge">${esc(tools.length)} tools</span></div><p class="muted">${tools.slice(0, 12).map((item) => esc(item.name)).join(', ')}${tools.length > 12 ? `, +${tools.length - 12} more` : ''}</p>`,
  );

  const notificationItems = snapshot.notifications.map((note) =>
    `<div class="item-title"><strong>${esc(note.title)}</strong>${note.read ? '<span class="badge gray">read</span>' : '<span class="badge warn">new</span>'}${note.deliveredAt ? '<span class="badge ok">delivered</span>' : ''}</div>
    <p>${esc(note.body)}</p><p class="muted">${esc(note.createdAt)}${note.deliveryError ? ` | delivery error: ${esc(note.deliveryError)}` : ''}${note.deliveredDestinations?.length ? ` | delivered to: ${esc(note.deliveredDestinations.join(', '))}` : ''}</p>
    ${renderActionButton(`/dashboard/actions/notifications/${encodeURIComponent(note.id)}/read`, token, 'Mark Read', {}, true)}`,
  );
  const notificationActionItems = snapshot.notifications.map((note) =>
    `<div class="action-row"><div><strong>${esc(note.title)}</strong><p class="muted">${esc(note.id)}</p></div>${renderActionButton(`/dashboard/actions/notifications/${encodeURIComponent(note.id)}/read`, token, 'Mark Read', {}, true)}${renderActionButton(`/dashboard/actions/notifications/${encodeURIComponent(note.id)}/retry`, token, 'Retry Delivery')}</div>`,
  );
  const destinationItems = snapshot.notificationDestinations.map((destination) =>
    `<div class="action-row multi"><div><strong>${esc(destination.name)}</strong><span class="badge">${esc(destination.type)}</span>${destination.enabled ? '<span class="badge ok">enabled</span>' : '<span class="badge gray">disabled</span>'}<p class="muted">${esc(destination.url ?? destination.channelId ?? destination.userId ?? '(no target)')}</p></div>${renderActionButton(`/dashboard/actions/notifications/destinations/${encodeURIComponent(destination.id)}/test`, token, 'Test')}${renderActionButton(`/dashboard/actions/notifications/destinations/${encodeURIComponent(destination.id)}/toggle`, token, destination.enabled ? 'Disable' : 'Enable', {}, true)}${renderActionButton(`/dashboard/actions/notifications/destinations/${encodeURIComponent(destination.id)}/delete`, token, 'Delete', {}, true)}</div>`,
  );
  const queueItems = snapshot.queuedNotificationDeliveries.map((job) =>
    `<div class="item-title"><strong>${esc(job.notificationId)}</strong></div><p class="muted">Queued ${esc(job.queuedAt)}</p><p class="muted">completed: ${esc((job.completedDestinationIds ?? []).length)} | failed: ${esc((job.failedDestinationIds ?? []).length)} | retry: ${esc(Object.keys(job.nextAttemptAtByDestination ?? {}).length)}</p>`,
  );

  const authItems = [
    `<strong>Mode</strong><span>${esc(snapshot.auth.mode)}</span>`,
    `<strong>Configured</strong><span>${esc(snapshot.auth.configured ? 'yes' : 'no')}</span>`,
    `<strong>Source</strong><span>${esc(snapshot.auth.source)}</span>`,
    `<strong>API Key</strong><span>${esc(snapshot.auth.openaiApiKeyPresent ? 'present' : 'missing')}</span>`,
    `<strong>Codex OAuth</strong><span>${esc(snapshot.auth.codexOauthPresent ? 'present' : 'missing')}</span>`,
    snapshot.auth.codexAccountId ? `<strong>Codex Account</strong><span>${esc(snapshot.auth.codexAccountId)}</span>` : '',
    snapshot.auth.codexLastRefresh ? `<strong>Last Refresh</strong><span>${esc(snapshot.auth.codexLastRefresh)}</span>` : '',
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clementine Command Center</title>
  <style>
    :root {
      --bg: #080b10;
      --bg-2: #0d1219;
      --panel: rgba(17, 24, 34, 0.88);
      --panel-2: rgba(22, 31, 44, 0.84);
      --ink: #f4efe3;
      --text: #d8d1c3;
      --muted: #8d968e;
      --dim: #606a64;
      --line: rgba(223, 211, 187, 0.14);
      --line-2: rgba(223, 211, 187, 0.08);
      --orange: #f28a2e;
      --green: #60c48b;
      --blue: #68a8ff;
      --yellow: #e7bf62;
      --red: #ef6a5b;
      --purple: #b28dff;
      --radius: 18px;
      --shadow: 0 24px 80px rgba(0,0,0,0.34);
      --mono: "SF Mono", "Cascadia Code", "JetBrains Mono", monospace;
      --sans: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      --serif: Georgia, "Iowan Old Style", serif;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      font-family: var(--sans);
      background:
        radial-gradient(circle at 20% -10%, rgba(242,138,46,0.16), transparent 34%),
        radial-gradient(circle at 90% 15%, rgba(96,196,139,0.12), transparent 28%),
        linear-gradient(135deg, #080b10 0%, #101820 52%, #090d11 100%);
    }
    a { color: inherit; }
    p { margin: 0; line-height: 1.5; }
    code {
      font-family: var(--mono);
      font-size: 11px;
      color: #ead8b9;
      background: rgba(255,255,255,0.06);
      border: 1px solid var(--line-2);
      border-radius: 7px;
      padding: 2px 6px;
    }
    .app-shell {
      display: grid;
      grid-template-columns: 248px minmax(0, 1fr);
      min-height: 100vh;
    }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      padding: 24px 18px;
      border-right: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(12,17,24,0.96), rgba(7,10,14,0.94));
      display: flex;
      flex-direction: column;
      gap: 22px;
    }
    .brand {
      display: flex;
      gap: 12px;
      align-items: center;
    }
    .brand-mark {
      width: 44px;
      height: 44px;
      border-radius: 16px;
      display: grid;
      place-items: center;
      color: #15100b;
      font-weight: 900;
      background: linear-gradient(135deg, #f7a24a, #fb6a2b);
      box-shadow: 0 0 0 5px rgba(242,138,46,0.1);
    }
    .brand strong { display: block; color: var(--ink); font-size: 16px; }
    .brand span { color: var(--muted); font-size: 11px; }
    .nav {
      display: grid;
      gap: 6px;
    }
    .nav a {
      text-decoration: none;
      padding: 10px 11px;
      border-radius: 12px;
      color: var(--muted);
      font-size: 13px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border: 1px solid transparent;
    }
    .nav a:hover {
      color: var(--ink);
      background: rgba(255,255,255,0.05);
      border-color: var(--line-2);
    }
    .nav a.active {
      color: var(--ink);
      background: linear-gradient(135deg, rgba(242,138,46,0.16), rgba(255,255,255,0.05));
      border-color: rgba(242,138,46,0.32);
      box-shadow: inset 3px 0 0 var(--orange);
    }
    .nav a > span {
      min-width: 0;
    }
    .nav a strong {
      color: var(--dim);
      font: 800 11px/1 var(--mono);
      text-transform: uppercase;
    }
    .nav a.active strong {
      color: var(--orange);
    }
    .sidebar-foot {
      margin-top: auto;
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 12px;
      background: rgba(255,255,255,0.03);
      font-size: 12px;
      color: var(--muted);
    }
    .content {
      min-width: 0;
      padding: 28px;
    }
    .hero {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 28px;
      padding: 30px;
      background:
        linear-gradient(135deg, rgba(242,138,46,0.18), transparent 34%),
        linear-gradient(90deg, rgba(20,29,40,0.94), rgba(16,22,30,0.82));
      box-shadow: var(--shadow);
    }
    .hero::after {
      content: "";
      position: absolute;
      right: -80px;
      top: -110px;
      width: 360px;
      height: 360px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(96,196,139,0.18), transparent 65%);
      pointer-events: none;
    }
    .hero-grid {
      position: relative;
      z-index: 1;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 28px;
      align-items: start;
    }
    .kicker {
      color: var(--orange);
      font: 700 11px/1 var(--mono);
      letter-spacing: 0.16em;
      text-transform: uppercase;
      margin-bottom: 10px;
    }
    h1 {
      margin: 0;
      color: var(--ink);
      font: 700 clamp(38px, 6vw, 76px)/0.9 var(--serif);
      letter-spacing: -0.055em;
    }
    .lede {
      max-width: 760px;
      margin-top: 16px;
      color: #bfc7bd;
      font-size: 15px;
    }
    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 22px;
    }
    .agent-orb {
      width: 158px;
      height: 158px;
      border-radius: 44px;
      display: grid;
      place-items: center;
      text-align: center;
      color: #19110a;
      background: linear-gradient(135deg, #f8b15f, #ed742f 54%, #f0c46e);
      box-shadow: 0 22px 70px rgba(242,138,46,0.24);
      transform: rotate(2deg);
    }
    .agent-orb strong { font-size: 48px; line-height: 1; }
    .agent-orb span { display: block; margin-top: 6px; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; }
    .metric-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 18px 0 26px;
    }
    .metric-card {
      min-height: 112px;
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 15px;
      background: rgba(13,18,25,0.74);
    }
    .metric-card span {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .metric-card strong {
      display: block;
      color: var(--ink);
      margin-top: 10px;
      font-size: 25px;
      line-height: 1;
    }
    .metric-card p {
      margin-top: 10px;
      color: var(--muted);
      font-size: 12px;
    }
    .metric-card.ok { border-color: rgba(96,196,139,0.32); }
    .metric-card.warn { border-color: rgba(231,191,98,0.36); }
    .metric-card.danger { border-color: rgba(239,106,91,0.42); }
    .tab-strip {
      position: sticky;
      top: 14px;
      z-index: 10;
      display: grid;
      grid-template-columns: repeat(8, minmax(0, 1fr));
      gap: 8px;
      margin: -8px 0 26px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: rgba(9,13,18,0.78);
      box-shadow: 0 16px 50px rgba(0,0,0,0.22);
      backdrop-filter: blur(18px);
    }
    .tab-strip a {
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 58px;
      padding: 10px 11px;
      border: 1px solid transparent;
      border-radius: 15px;
      color: var(--muted);
      text-decoration: none;
      background: rgba(255,255,255,0.025);
    }
    .tab-strip a:hover {
      color: var(--ink);
      border-color: var(--line-2);
      background: rgba(255,255,255,0.055);
    }
    .tab-strip a.active {
      color: var(--ink);
      border-color: rgba(242,138,46,0.34);
      background: linear-gradient(135deg, rgba(242,138,46,0.18), rgba(255,255,255,0.055));
      box-shadow: inset 0 -3px 0 var(--orange);
    }
    .tab-strip span {
      display: grid;
      gap: 4px;
      min-width: 0;
      font-weight: 800;
      font-size: 12px;
    }
    .tab-strip small {
      overflow: hidden;
      color: var(--muted);
      font-size: 10px;
      font-weight: 600;
      line-height: 1.15;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tab-strip strong {
      color: var(--orange);
      font: 900 10px/1 var(--mono);
      text-transform: uppercase;
    }
    .section-block {
      scroll-margin-top: 20px;
      margin-top: 26px;
    }
    .tab-page {
      display: none;
    }
    .tab-page.active {
      display: block;
      animation: tabIn 180ms ease-out;
    }
    @keyframes tabIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .section-title {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 16px;
      margin: 0 0 12px;
    }
    .section-title h2 {
      margin: 0;
      color: var(--ink);
      font-size: 24px;
      letter-spacing: -0.03em;
    }
    .section-title p {
      color: var(--muted);
      font-size: 13px;
      max-width: 620px;
    }
    .panel-grid {
      display: grid;
      grid-template-columns: repeat(12, minmax(0, 1fr));
      gap: 14px;
    }
    .panel {
      grid-column: span 4;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--panel);
      box-shadow: 0 18px 44px rgba(0,0,0,0.16);
      overflow: hidden;
    }
    .panel.wide { grid-column: span 8; }
    .panel.full { grid-column: 1 / -1; }
    .panel.feature { background: linear-gradient(135deg, rgba(242,138,46,0.12), rgba(17,24,34,0.9)); }
    .panel-head {
      padding: 16px 18px 13px;
      border-bottom: 1px solid var(--line-2);
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 12px;
    }
    .panel-head h2 {
      color: var(--ink);
      margin: 4px 0 0;
      font-size: 18px;
      letter-spacing: -0.02em;
    }
    .eyebrow {
      margin: 0;
      color: var(--orange);
      font: 700 10px/1 var(--mono);
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .panel-body { padding: 16px 18px 18px; }
    .stack-list {
      display: grid;
      gap: 10px;
    }
    .stack-list.compact { gap: 7px; }
    .stack-item {
      border: 1px solid var(--line-2);
      border-radius: 14px;
      padding: 12px;
      background: rgba(255,255,255,0.025);
      min-width: 0;
    }
    .stack-item p { color: var(--text); font-size: 13px; }
    .muted { color: var(--muted) !important; }
    .danger-text { color: #ff9a8f !important; }
    .empty {
      color: var(--muted);
      font-style: italic;
      padding: 8px 0;
    }
    .item-title {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 7px;
      min-width: 0;
    }
    .item-title strong { color: var(--ink); }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--muted);
      background: rgba(255,255,255,0.035);
      font: 700 10px/1.45 var(--mono);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge.ok { color: var(--green); border-color: rgba(96,196,139,0.32); background: rgba(96,196,139,0.08); }
    .badge.warn { color: var(--yellow); border-color: rgba(231,191,98,0.32); background: rgba(231,191,98,0.08); }
    .badge.danger { color: var(--red); border-color: rgba(239,106,91,0.32); background: rgba(239,106,91,0.08); }
    .badge.blue { color: var(--blue); border-color: rgba(104,168,255,0.3); background: rgba(104,168,255,0.08); }
    .badge.purple { color: var(--purple); border-color: rgba(178,141,255,0.3); background: rgba(178,141,255,0.08); }
    .badge.gray { color: var(--dim); }
    .status-line {
      display: grid;
      grid-template-columns: 12px minmax(0, 1fr);
      gap: 11px;
      align-items: start;
      padding: 11px 0;
      border-bottom: 1px solid var(--line-2);
    }
    .status-line:last-child { border-bottom: 0; padding-bottom: 0; }
    .status-line strong { color: var(--ink); }
    .status-line p { color: var(--muted); font-size: 12px; margin-top: 3px; }
    .status-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      margin-top: 5px;
      background: var(--dim);
      box-shadow: 0 0 0 4px rgba(255,255,255,0.035);
    }
    .status-line.ok .status-dot, .timeline-dot.ok { background: var(--green); box-shadow: 0 0 0 4px rgba(96,196,139,0.12); }
    .status-line.warn .status-dot { background: var(--yellow); box-shadow: 0 0 0 4px rgba(231,191,98,0.12); }
    .status-line.danger .status-dot, .timeline-dot.danger { background: var(--red); box-shadow: 0 0 0 4px rgba(239,106,91,0.12); }
    .action-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      gap: 8px;
      align-items: start;
    }
    .action-row.multi { grid-template-columns: minmax(0, 1fr) repeat(3, auto); }
    form { margin: 0; }
    button, .button-link {
      border: 0;
      border-radius: 999px;
      background: linear-gradient(135deg, #f28a2e, #df6b25);
      color: #170f08;
      padding: 9px 13px;
      font: 800 12px/1 var(--sans);
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
    }
    button.secondary, .button-link.secondary {
      background: rgba(255,255,255,0.07);
      color: var(--text);
      border: 1px solid var(--line);
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px 12px;
      font: inherit;
      color: var(--ink);
      background: rgba(255,255,255,0.055);
      outline: none;
    }
    textarea { resize: vertical; min-height: 108px; }
    input:focus, textarea:focus, select:focus {
      border-color: rgba(242,138,46,0.5);
      box-shadow: 0 0 0 4px rgba(242,138,46,0.08);
    }
    .form-stack {
      display: grid;
      gap: 10px;
    }
    .form-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .check-row {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      color: var(--text);
      font-size: 13px;
      line-height: 1.4;
    }
    .check-row input {
      width: auto;
      margin-top: 2px;
      accent-color: var(--orange);
    }
    .kv-list {
      display: grid;
      gap: 8px;
    }
    .kv-list .stack-item {
      display: grid;
      grid-template-columns: 130px minmax(0, 1fr);
      gap: 12px;
      align-items: start;
    }
    .kv-list strong { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    .kv-list span { min-width: 0; overflow-wrap: anywhere; color: var(--text); }
    .toolkit-row, .preference-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      padding: 12px 0;
      border-bottom: 1px solid var(--line-2);
    }
    .toolkit-row:last-child, .preference-row:last-child { border-bottom: 0; }
    .preference-row label { display: grid; gap: 4px; }
    .preference-row select { min-width: 160px; }
    .timeline {
      display: grid;
      gap: 0;
    }
    .timeline-row {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      gap: 11px;
      padding: 12px 0;
      border-bottom: 1px solid var(--line-2);
    }
    .timeline-row:last-child { border-bottom: 0; }
	    .timeline-dot {
	      width: 9px;
	      height: 9px;
	      border-radius: 50%;
	      margin-top: 6px;
	      background: var(--dim);
	    }
	    .timeline-dot.blue { background: var(--blue); box-shadow: 0 0 0 4px rgba(104,168,255,0.1); }
	    .timeline-dot.warn { background: var(--yellow); box-shadow: 0 0 0 4px rgba(231,191,98,0.12); }
	    .timeline-dot.gray { background: var(--dim); box-shadow: 0 0 0 4px rgba(255,255,255,0.04); }
	    .run-control {
	      display: grid;
	      grid-template-columns: minmax(260px, 0.42fr) minmax(0, 1fr);
	      gap: 14px;
	      align-items: start;
	    }
	    .run-picker {
	      display: grid;
	      gap: 8px;
	      max-height: 760px;
	      overflow: auto;
	      padding-right: 4px;
	    }
	    .run-selector {
	      width: 100%;
	      display: grid;
	      grid-template-columns: 18px minmax(0, 1fr);
	      gap: 10px;
	      align-items: start;
	      border: 1px solid var(--line-2);
	      border-radius: 16px;
	      padding: 12px;
	      color: var(--text);
	      text-align: left;
	      background: rgba(255,255,255,0.025);
	      box-shadow: none;
	      white-space: normal;
	    }
	    .run-selector:hover,
	    .run-selector.active {
	      border-color: rgba(242,138,46,0.34);
	      background: linear-gradient(135deg, rgba(242,138,46,0.12), rgba(255,255,255,0.04));
	    }
	    .run-selector span:last-child {
	      display: grid;
	      gap: 5px;
	      min-width: 0;
	    }
	    .run-selector strong {
	      color: var(--ink);
	      overflow: hidden;
	      text-overflow: ellipsis;
	      white-space: nowrap;
	    }
	    .run-selector small,
	    .run-selector em {
	      color: var(--muted);
	      font-size: 11px;
	      font-style: normal;
	      line-height: 1.35;
	    }
	    .run-detail {
	      display: none;
	      border: 1px solid var(--line-2);
	      border-radius: 20px;
	      padding: 16px;
	      background: rgba(255,255,255,0.025);
	    }
	    .run-detail.active {
	      display: grid;
	      gap: 14px;
	    }
	    .run-detail-head {
	      display: flex;
	      justify-content: space-between;
	      gap: 12px;
	      align-items: start;
	    }
	    .run-detail-head h3 {
	      margin: 4px 0 5px;
	      color: var(--ink);
	      font-size: 22px;
	      letter-spacing: -0.025em;
	    }
	    .run-actions {
	      display: flex;
	      flex-wrap: wrap;
	      gap: 8px;
	      align-items: center;
	    }
	    .run-meta-grid {
	      display: grid;
	      grid-template-columns: repeat(3, minmax(0, 1fr));
	      gap: 8px;
	    }
	    .run-meta-grid .stack-item {
	      display: grid;
	      gap: 7px;
	    }
	    .run-meta-grid strong {
	      color: var(--muted);
	      font-size: 10px;
	      letter-spacing: 0.08em;
	      text-transform: uppercase;
	    }
	    .run-meta-grid span {
	      min-width: 0;
	      overflow-wrap: anywhere;
	    }
	    .run-split {
	      display: grid;
	      grid-template-columns: 1fr 1fr;
	      gap: 10px;
	    }
	    .run-pre {
	      min-height: 120px;
	      max-height: 300px;
	      margin: 8px 0 0;
	      overflow: auto;
	      white-space: pre-wrap;
	      word-break: break-word;
	      border: 1px solid var(--line-2);
	      border-radius: 14px;
	      padding: 12px;
	      color: var(--text);
	      background: rgba(0,0,0,0.22);
	      font: 12px/1.45 var(--mono);
	    }
	    .run-pre.compact {
	      min-height: 0;
	      max-height: 170px;
	      font-size: 11px;
	    }
	    .run-events {
	      display: grid;
	      gap: 0;
	      border-top: 1px solid var(--line-2);
	      padding-top: 6px;
	    }
	    .run-event-row {
	      display: grid;
	      grid-template-columns: 18px minmax(0, 1fr);
	      gap: 10px;
	      padding: 11px 0;
	      border-bottom: 1px solid var(--line-2);
	    }
	    .run-event-row:last-child { border-bottom: 0; }
	    .flash {
      margin-top: 18px;
      border-radius: 16px;
      border: 1px solid var(--line);
      padding: 13px 15px;
      background: rgba(255,255,255,0.055);
      color: var(--ink);
    }
    .flash.error { border-color: rgba(239,106,91,0.44); background: rgba(239,106,91,0.1); }
    .flash.success { border-color: rgba(96,196,139,0.4); background: rgba(96,196,139,0.09); }
    .mini-note {
      color: var(--muted);
      font-size: 12px;
      margin-top: 9px;
    }
    .install-link { overflow-wrap: anywhere; }
    .top-link {
      color: var(--muted);
      font-size: 12px;
      text-decoration: none;
    }
    .top-link:hover { color: var(--ink); }
    @media (max-width: 1100px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        height: auto;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
	      .nav { grid-template-columns: repeat(4, minmax(0, 1fr)); }
	      .sidebar-foot { display: none; }
	      .metric-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	      .tab-strip { grid-template-columns: repeat(4, minmax(0, 1fr)); top: 8px; }
		      .panel, .panel.wide { grid-column: 1 / -1; }
		      .run-control { grid-template-columns: 1fr; }
		      .run-meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		      .hero-grid { grid-template-columns: 1fr; }
		      .agent-orb { display: none; }
		    }
    @media (max-width: 680px) {
	      .content { padding: 16px; }
	      .hero { padding: 22px; border-radius: 22px; }
	      .metric-strip { grid-template-columns: 1fr; }
	      .tab-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	      .nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
		      .run-meta-grid, .run-split, .form-grid, .action-row, .action-row.multi, .toolkit-row, .preference-row, .kv-list .stack-item {
		        grid-template-columns: 1fr;
		      }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">C</div>
        <div><strong>Clementine</strong><span>Local agent command center</span></div>
      </div>
	      <nav class="nav" role="tablist" aria-label="Dashboard sections">
	        ${renderDashboardTabLinks('nav')}
	      </nav>
      <div class="sidebar-foot">
        <strong style="color:var(--ink)">Daemon</strong>
        <p>${snapshot.discord.connected ? `Discord: ${esc(snapshot.discord.userTag ?? 'connected')}` : 'Discord is not currently connected.'}</p>
        <p>${snapshot.auth.mode} via ${esc(snapshot.auth.source)}</p>
      </div>
    </aside>
    <main class="content">
      <header class="hero" id="top">
        <div class="hero-grid">
          <div>
            <p class="kicker">Clementine Next</p>
            <h1>Command Center</h1>
            <p class="lede">A local-first control plane for autonomous runs, Discord operations, project work, memory, connected apps, approvals, and scheduled execution.</p>
            <div class="hero-actions">
              <a class="button-link" href="#setup" data-tab="setup">Finish Setup</a>
              <a class="button-link secondary" href="#automation" data-tab="automation">Schedule Work</a>
              <a class="button-link secondary" href="#agents" data-tab="agents">Watch Runs</a>
            </div>
          </div>
          <div class="agent-orb"><div><strong>${authReady ? 'ON' : 'SET'}</strong><span>${activeWork > 0 ? `${activeWork} active` : 'standing by'}</span></div></div>
        </div>
      </header>
      ${flash ? `<div class="flash ${esc(flash.kind)}">${esc(flash.text)}</div>` : ''}
	      <div class="metric-strip">
	        ${metrics.join('')}
	      </div>
	      <div class="tab-strip" role="tablist" aria-label="Dashboard tabs">
	        ${renderDashboardTabLinks('strip')}
	      </div>

	      <section class="section-block tab-page active" id="overview" role="tabpanel" tabindex="0">
        <div class="section-title">
          <div><h2>Overview</h2><p>Glanceable health and active work. This mirrors the Clementine Dev command-center approach but uses the OpenAI runtime data.</p></div>
          <span class="badge ok">active tab</span>
        </div>
        <div class="panel-grid">
          ${renderPanel('Capability Readiness', 'Setup map', readinessItems.join(''), { className: 'wide feature' })}
          ${renderPanel('Pending Approvals', 'Human gate', renderStack(approvalItems, 'No pending approvals.', 'stack-list compact'), {
            actions: approvals.length ? `<span class="badge warn">${approvals.length} waiting</span>` : '<span class="badge ok">clear</span>',
          })}
          ${renderPanel('Approval Actions', 'Decide', renderStack(approvalActionItems, 'No approvals to act on.', 'stack-list compact'))}
          ${renderPanel('Active Executions', 'Long work', renderStack(executionItems, 'No tracked executions yet.'), { className: 'wide' })}
          ${renderPanel('Background Jobs', 'Queue', renderStack(backgroundTaskItems, 'No background jobs yet.'))}
	          ${renderPanel('Run Control Center', 'Live visibility', runControlBody, { className: 'full feature' })}
        </div>
      </section>

	      <section class="section-block tab-page" id="setup" role="tabpanel" tabindex="0">
        <div class="section-title">
          <div><h2>Setup</h2><p>Everything a new user needs to make Clementine useful without editing files by hand.</p></div>
          <span class="badge">setup</span>
        </div>
        <div class="panel-grid">
          ${renderPanel('Semantic Memory', 'Recall', `<div class="form-stack">
            <p class="mini-note">FTS memory works offline. Add an OpenAI API key to enable semantic embedding recall and backfill.</p>
            <form class="form-stack" method="post" action="/dashboard/actions/openai/api-key?token=${encodeURIComponent(token)}">
              <input type="password" name="api_key" placeholder="OpenAI API key for embeddings (sk-...)" />
              <button type="submit">${snapshot.auth.openaiApiKeyPresent ? 'Update OpenAI Key' : 'Save OpenAI Key'}</button>
            </form>
            ${snapshot.auth.openaiApiKeyPresent ? renderActionButton('/dashboard/actions/openai/clear-api-key', token, 'Clear OpenAI Key', {}, true) : ''}
            <p class="mini-note">Status: ${snapshot.memoryIndex.embeddingsEnabled ? 'semantic embeddings enabled' : 'FTS-only'} | ${esc(snapshot.memoryIndex.embeddingsCount)} vectors | ${esc(Math.round(snapshot.memoryIndex.embeddingsCoverage * 100))}% coverage</p>
            <form class="form-stack" method="post" action="/dashboard/actions/memory/embed-backfill?token=${encodeURIComponent(token)}">
              <input name="max_chunks" value="200" placeholder="Max chunks to backfill now" />
              <button type="submit">Backfill Embeddings</button>
            </form>
          </div>`)}
          ${renderPanel('Auth', 'Runtime', `<p class="mini-note">${esc(snapshot.auth.message)}</p>${renderStack(authItems, 'No auth status available.', 'kv-list')}`)}
          ${renderPanel('Discord', 'Channel', `<div class="form-stack">
            <p class="mini-note">Paste a Discord bot token to verify it, store the client ID, and generate the server install link.</p>
            <form class="form-stack" method="post" action="/dashboard/actions/discord/setup?token=${encodeURIComponent(token)}">
              <input type="password" name="bot_token" placeholder="Discord bot token" />
              <button type="submit">Save Discord Bot</button>
            </form>
            ${snapshot.discord.installUrl ? `<a class="button-link" href="${esc(snapshot.discord.installUrl)}" target="_blank" rel="noreferrer">Install bot to server</a><p class="mini-note">Client ID: <code>${esc(snapshot.discord.clientId ?? '')}</code></p><p class="mini-note install-link">${esc(snapshot.discord.installUrl)}</p>` : '<p class="empty">No Discord install link available yet.</p>'}
          </div>`)}
        </div>
      </section>

	      <section class="section-block tab-page" id="projects" role="tabpanel" tabindex="0">
        <div class="section-title">
          <div><h2>Projects</h2><p>Project roots and globally installed CLIs are what let Clementine operate on your computer from Discord.</p></div>
          <span class="badge">${snapshot.workspaceProjects.length} projects</span>
        </div>
        <div class="panel-grid">
          ${renderPanel('Project Workspaces', 'Roots', `${renderStack(workspaceItems, 'No configured workspace roots. Clementine will auto-detect common folders until you add one.')}<form class="form-stack" method="post" action="/dashboard/actions/workspaces/add?token=${encodeURIComponent(token)}" style="margin-top:12px"><input name="directory" placeholder="~/Desktop or /absolute/path/to/projects" /><button type="submit">Add Workspace</button></form>`, { className: 'wide' })}
          ${renderPanel('Global CLIs', 'PATH', renderStack(cliItems, 'No global CLI status available.'))}
          ${renderPanel('Discovered Projects', 'Repos', renderStack(projectItems.slice(0, 30), 'No projects discovered yet. Add a workspace root that contains repos.'), { className: 'full' })}
        </div>
      </section>

	      <section class="section-block tab-page" id="automation" role="tabpanel" tabindex="0">
        <div class="section-title">
          <div><h2>Automation</h2><p>Scheduled tasks, manual runs, workflows, and recent execution history.</p></div>
          <span class="badge">${snapshot.cronJobs.length} schedules</span>
        </div>
	        <div class="panel-grid">
	          ${renderPanel('Run Control Center', 'Inspect and control', runControlBody, { className: 'full feature' })}
	          ${renderPanel('Autonomy Policy', 'Operating mode', `${renderStack(proactivityItems, 'No proactivity policy loaded.', 'kv-list')}${proactivityPolicyForm}`, { className: 'wide feature' })}
	          ${renderPanel('Queue Long Task', 'Daemon worker', longTaskForm)}
	          ${renderPanel('Proactive Briefs', 'Status reports', renderStack(proactiveBriefItems, 'No proactive brief has been sent yet.', 'kv-list'))}
	          ${renderPanel('Create Scheduled Task', 'New recurring work', `<form class="form-stack" method="post" action="/dashboard/actions/cron/create?token=${encodeURIComponent(token)}">
	            <div class="form-grid"><input name="name" placeholder="daily-research-brief" required /><input name="schedule" placeholder="0 9 * * *" required /></div>
            <input name="work_dir" placeholder="Optional project directory" />
            <select name="mode"><option value="standard">Standard</option><option value="unleashed">Unleashed</option></select>
            <textarea name="prompt" rows="6" placeholder="Research this topic, update the project notes, and send me a summary..." required></textarea>
            <button type="submit">Save Scheduled Task</button>
          </form>`, { className: 'wide feature' })}
          ${renderPanel('Cron Actions', 'Run now', renderStack(cronActionItems, 'No cron jobs available.', 'stack-list compact'))}
          ${renderPanel('Cron Jobs', 'Definitions', renderStack(cronItems, 'No cron jobs configured.'), { className: 'wide' })}
          ${renderPanel('Workflows', 'Multi-step', renderStack(workflowItems, 'No workflows configured.'))}
          ${renderPanel('Workflow Actions', 'Manual queue', renderStack(workflowActionItems, 'No workflows available.'))}
          ${renderPanel('Recent Cron Runs', 'History', renderStack(cronRunItems, 'No cron runs recorded yet.'), { className: 'wide' })}
          ${renderPanel('Recent Workflow Runs', 'History', renderStack(workflowRunItems, 'No workflow runs recorded yet.'))}
        </div>
      </section>

	      <section class="section-block tab-page" id="apps" role="tabpanel" tabindex="0">
        <div class="section-title">
          <div><h2>Connected Apps</h2><p>Composio and tool preferences decide how Clementine sends emails, checks calendars, and updates external systems.</p></div>
          <span class="badge">${snapshot.composio.connected.length} connected</span>
        </div>
        <div class="panel-grid">
          ${renderPanel('Composio Setup', 'OAuth broker', `<div class="form-stack">
            <p class="mini-note">Clementine stores your Composio API key; app tokens stay inside Composio.</p>
            <form class="form-stack" method="post" action="/dashboard/actions/composio/api-key?token=${encodeURIComponent(token)}">
              <input type="password" name="api_key" placeholder="Composio API key (cak_...)" />
              <input name="user_id" placeholder="Composio user ID, default is default" value="${snapshot.composio.userId === 'default' ? '' : esc(snapshot.composio.userId)}" />
              <button type="submit">${snapshot.composio.apiKeyPresent ? 'Update Composio Key' : 'Save Composio Key'}</button>
            </form>
            <p class="mini-note">Status: ${snapshot.composio.apiKeyPresent ? `configured (${esc(snapshot.composio.maskedApiKey ?? '')})` : 'missing'} | <a href="https://app.composio.dev/developers" target="_blank" rel="noreferrer">get API key</a></p>
            ${snapshot.composio.catalogError ? `<p class="danger-text">Catalog warning: ${esc(snapshot.composio.catalogError)}</p>` : ''}
            ${renderActionButton('/dashboard/actions/composio/refresh', token, 'Refresh Composio', {}, true)}
          </div>`)}
          ${renderPanel('App Connections', 'Active', renderStack(connectedAppItems, snapshot.composio.enabled ? 'No connected apps yet.' : 'Add a Composio API key first.'))}
          ${renderPanel('Connect Toolkits', 'Featured', `<p class="mini-note">Showing featured services from ${esc(snapshot.composio.totalCount)} available toolkits.</p>${renderStack(composioToolkitItems, snapshot.composio.enabled ? 'No toolkits available.' : 'Save a Composio API key to load the live catalog.')}`, { className: 'wide' })}
          ${renderPanel('Tool Preferences', 'Routing', `<form class="form-stack" method="post" action="/dashboard/actions/tool-preferences?token=${encodeURIComponent(token)}">${toolPreferenceItems.join('') || '<p class="empty">No known services configured.</p>'}<button type="submit">Save Preferences</button></form>`, { className: 'full' })}
        </div>
      </section>

	      <section class="section-block tab-page" id="agents" role="tabpanel" tabindex="0">
        <div class="section-title">
          <div><h2>Agents</h2><p>Team agents, autonomous activity, active executions, and background task visibility.</p></div>
          <span class="badge">${snapshot.agents.length} agents</span>
        </div>
        <div class="panel-grid">
          ${renderPanel('Team Agents', 'Roster', renderStack(agentItems, 'No team agents configured.'), { className: 'wide' })}
          ${renderPanel('Agent Activity', 'Heartbeat', renderStack(agentStateItems, 'No autonomous agent runs recorded yet.'))}
          ${renderPanel('Active Executions', 'Now', renderStack(executionItems, 'No tracked executions yet.'), { className: 'wide' })}
          ${renderPanel('Background Jobs', 'Queue', renderStack(backgroundTaskItems, 'No background jobs yet.'))}
        </div>
      </section>

	      <section class="section-block tab-page" id="memory" role="tabpanel" tabindex="0">
        <div class="section-title">
          <div><h2>Memory</h2><p>Vault index, durable facts, session continuity, and Discord conversation state.</p></div>
          <span class="badge">${snapshot.memoryIndex.chunks} chunks</span>
        </div>
        <div class="panel-grid">
          ${renderPanel('Memory Index', 'Vault', `${renderStack(memoryStatusItems, 'No memory index status available.', 'kv-list')}${renderActionButton('/dashboard/actions/memory/rebuild-index', token, 'Rebuild Index')}`, { className: 'wide' })}
          ${renderPanel('Session Continuity', 'Briefs', renderStack(sessionBriefItems, 'No session briefs recorded yet.'))}
          ${renderPanel('Discord Sessions', 'Conversations', renderStack(discordSessionItems, 'No Discord sessions recorded yet.'), { className: 'wide' })}
        </div>
      </section>

	      <section class="section-block tab-page" id="system" role="tabpanel" tabindex="0">
        <div class="section-title">
          <div><h2>System</h2><p>Runtime tools, notifications, delivery destinations, and operational diagnostics.</p></div>
          <span class="badge">${snapshot.runtimeTools.length} tools</span>
        </div>
        <div class="panel-grid">
          ${renderPanel('Runtime Tools', 'Tool surface', renderStack(runtimeToolItems, 'No runtime tools loaded.'), { className: 'wide' })}
          ${renderPanel('Notifications', 'Inbox', renderStack(notificationItems, 'No notifications yet.'))}
          ${renderPanel('Notification Actions', 'Delivery', renderStack(notificationActionItems, 'No notifications available.'))}
          ${renderPanel('Delivery Destinations', 'Targets', `${renderStack(destinationItems, 'No delivery destinations configured.')}<form class="form-stack" method="post" action="/dashboard/actions/notifications/destinations?token=${encodeURIComponent(token)}" style="margin-top:12px"><input name="name" placeholder="Destination name" required /><select name="type"><option value="generic_webhook">Generic Webhook</option><option value="discord_webhook">Discord Webhook</option><option value="discord_channel">Discord Channel</option><option value="discord_user">Discord User DM</option></select><input name="url" placeholder="https://... or leave blank for Discord bot targets" /><input name="channel_id" placeholder="Discord channel ID for bot delivery" /><input name="user_id" placeholder="Discord user ID for DM delivery" /><button type="submit">Add Destination</button></form>`, { className: 'wide' })}
          ${renderPanel('Delivery Queue', 'Retries', renderStack(queueItems, 'No queued deliveries.'))}
        </div>
      </section>
    </main>
  </div>
	  <script>
	    let formDirty = false;
	    const tabIds = ['overview', 'setup', 'projects', 'automation', 'apps', 'agents', 'memory', 'system'];
	    const activeTabStorageKey = 'clementine.dashboard.activeTab';
	    const activeRunStorageKey = 'clementine.dashboard.activeRun';
	    function currentDashboardTab() {
	      const active = document.querySelector('.tab-page.active');
	      return active && tabIds.includes(active.id) ? active.id : 'overview';
	    }
	    function initialDashboardTab() {
	      const hashTab = location.hash.replace('#', '');
	      const queryTab = new URLSearchParams(location.search).get('tab') || '';
	      const savedTab = sessionStorage.getItem(activeTabStorageKey) || '';
	      return [hashTab, queryTab, savedTab].find((tab) => tabIds.includes(tab)) || 'overview';
	    }
	    function activateDashboardTab(tabId, options) {
	      const nextTab = tabIds.includes(tabId) ? tabId : 'overview';
	      document.querySelectorAll('.tab-page').forEach((section) => {
	        const isActive = section.id === nextTab;
	        section.classList.toggle('active', isActive);
	        section.toggleAttribute('hidden', !isActive);
	      });
	      document.querySelectorAll('[data-tab]').forEach((item) => {
	        const isActive = item.getAttribute('data-tab') === nextTab;
	        item.classList.toggle('active', isActive);
	        if (item.getAttribute('role') === 'tab') {
	          item.setAttribute('aria-selected', isActive ? 'true' : 'false');
	          item.setAttribute('tabindex', isActive ? '0' : '-1');
	        }
	      });
	      sessionStorage.setItem(activeTabStorageKey, nextTab);
	      if (!options || options.updateHash !== false) {
	        history.replaceState(null, '', '#' + nextTab);
	      }
      if (options && options.scrollTop) {
        document.querySelector('.content')?.scrollTo?.({ top: 0, behavior: 'smooth' });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
	    document.querySelectorAll('[data-tab]').forEach((item) => {
	      item.addEventListener('click', (event) => {
	        event.preventDefault();
		        activateDashboardTab(item.getAttribute('data-tab') || 'overview', { scrollTop: true });
		      });
		    });
	    function activateRunDetail(runId) {
	      const fallback = document.querySelector('[data-run-detail]')?.getAttribute('data-run-detail') || '';
	      const hasRequestedRun = Array.from(document.querySelectorAll('[data-run-detail]'))
	        .some((item) => item.getAttribute('data-run-detail') === runId);
	      const nextRun = hasRequestedRun ? runId : fallback;
	      if (!nextRun) return;
	      document.querySelectorAll('[data-run-select]').forEach((item) => {
	        item.classList.toggle('active', item.getAttribute('data-run-select') === nextRun);
	      });
	      document.querySelectorAll('[data-run-detail]').forEach((item) => {
	        item.classList.toggle('active', item.getAttribute('data-run-detail') === nextRun);
	      });
	      sessionStorage.setItem(activeRunStorageKey, nextRun);
	    }
	    document.querySelectorAll('[data-run-select]').forEach((item) => {
	      item.addEventListener('click', () => {
	        activateRunDetail(item.getAttribute('data-run-select') || '');
	      });
	    });
	    activateRunDetail(sessionStorage.getItem(activeRunStorageKey) || '');
	    function liveTone(status) {
	      if (status === 'failed' || status === 'cancelled') return 'danger';
	      if (status === 'running') return 'blue';
	      if (status === 'queued' || status === 'awaiting_approval') return 'warn';
	      if (status === 'completed') return 'ok';
	      return 'gray';
	    }
	    function liveEventTone(type) {
	      if (type === 'failed' || type === 'cancelled') return 'danger';
	      if (type === 'approval_required' || type === 'queued_background') return 'warn';
	      if (type === 'tool_started' || type === 'model_started') return 'blue';
	      if (type === 'completed') return 'ok';
	      return 'gray';
	    }
	    function escapeHtml(value) {
	      return String(value ?? '')
	        .replace(/&/g, '&amp;')
	        .replace(/</g, '&lt;')
	        .replace(/>/g, '&gt;')
	        .replace(/"/g, '&quot;');
	    }
	    function renderRunEventRow(event) {
	      const data = event.data && Object.keys(event.data).length
	        ? '<pre class="run-pre compact">' + escapeHtml(JSON.stringify(event.data, null, 2)) + '</pre>'
	        : '';
	      return '<div class="run-event-row" data-run-event-id="' + escapeHtml(event.id) + '">' +
	        '<span class="timeline-dot ' + liveEventTone(event.type) + '"></span>' +
	        '<div>' +
	        '<div class="item-title"><strong>' + escapeHtml(event.type) + '</strong><span class="muted">' + escapeHtml(event.createdAt) + '</span></div>' +
	        '<p>' + escapeHtml(event.message) + '</p>' +
	        data +
	        '</div>' +
	        '</div>';
	    }
	    async function pollRunLiveState() {
	      if (document.hidden || formDirty) return;
	      const token = new URLSearchParams(location.search).get('token') || '';
	      if (!token) return;
	      try {
	        const response = await fetch('/api/runs?token=' + encodeURIComponent(token) + '&limit=20', { cache: 'no-store' });
	        if (!response.ok) return;
	        const payload = await response.json();
	        for (const run of payload.runs || []) {
	          const latest = run.events && run.events.length ? run.events[run.events.length - 1] : null;
	          const summary = document.querySelector('[data-live-run-summary="' + run.id + '"]');
	          if (summary) summary.textContent = run.id + ' | ' + run.status + (run.queuedTaskId ? ' | task ' + run.queuedTaskId : '') + ' | updated ' + run.updatedAt;
	          document.querySelectorAll('[data-live-run-latest="' + run.id + '"], [data-live-run-latest-detail="' + run.id + '"]').forEach((item) => {
	            item.textContent = latest ? latest.message : '';
	          });
	          document.querySelectorAll('[data-live-run-status="' + run.id + '"]').forEach((item) => {
	            item.className = 'badge ' + liveTone(run.status);
	            item.textContent = run.status;
	          });
	          document.querySelectorAll('[data-live-run-output="' + run.id + '"]').forEach((item) => {
	            item.textContent = run.error || run.outputPreview || 'No output captured yet.';
	          });
	          const eventBox = document.querySelector('[data-live-run-events="' + run.id + '"]');
	          if (eventBox && Array.isArray(run.events)) {
	            const seen = new Set(Array.from(eventBox.querySelectorAll('[data-run-event-id]')).map((item) => item.getAttribute('data-run-event-id')));
	            if (run.events.length > 0) {
	              eventBox.querySelector('.empty')?.remove();
	            }
	            for (const event of run.events) {
	              if (!event.id || seen.has(event.id)) continue;
	              eventBox.insertAdjacentHTML('beforeend', renderRunEventRow(event));
	              seen.add(event.id);
	            }
	          }
	        }
	      } catch {
	        // Best-effort live refresh. The full dashboard reload remains the fallback.
	      }
	    }
	    window.setInterval(pollRunLiveState, 5000);
	    void pollRunLiveState();
		    document.addEventListener('submit', (event) => {
		      const form = event.target;
		      if (!(form instanceof HTMLFormElement)) return;
	      sessionStorage.setItem(activeTabStorageKey, currentDashboardTab());
	    });
	    window.addEventListener('hashchange', () => {
	      activateDashboardTab(location.hash.replace('#', ''), { updateHash: false });
	    });
	    activateDashboardTab(initialDashboardTab(), { updateHash: Boolean(location.hash) });
    document.addEventListener('input', () => { formDirty = true; }, { capture: true });
    document.addEventListener('change', () => { formDirty = true; }, { capture: true });
    window.setTimeout(() => {
      const active = document.activeElement;
      const isEditing = active instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName);
      if (!document.hidden && !isEditing && !formDirty) window.location.reload();
    }, 15000);
  </script>
</body>
</html>`;
}
