import type { PendingApproval } from '../types.js';
import { buildDashboardSnapshot } from './state.js';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderList(items: string[], empty: string): string {
  if (items.length === 0) return `<p class="empty">${esc(empty)}</p>`;
  return `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

export function renderDashboardHtml(approvals: PendingApproval[], token: string): string {
  const snapshot = buildDashboardSnapshot();

  const approvalItems = approvals.map((approval) =>
    `<strong>${esc(approval.toolName)}</strong> <code>${esc(approval.id)}</code> <span class="muted">session ${esc(approval.sessionId)}</span>${approval.userId ? ` <span class="muted">user ${esc(approval.userId)}</span>` : ''}${approval.channel ? ` <span class="muted">${esc(approval.channel)}</span>` : ''}`,
  );
  const agentItems = snapshot.agents.map((agent) =>
    `<strong>${esc(agent.name)}</strong> <code>${esc(agent.slug)}</code>${agent.channelName ? ` <span class="muted">#${esc(agent.channelName)}</span>` : ''}${agent.project ? ` <span class="muted">project: ${esc(agent.project)}</span>` : ''}`,
  );
  const agentStateItems = snapshot.agentStates.map((state) => {
    const inbox = snapshot.agentInboxCounts.find((item) => item.slug === state.slug);
    return `<strong>${esc(state.slug)}</strong><div class="muted">last run ${esc(state.lastRunAt ?? 'never')}</div><div class="muted">pending inbox ${esc(inbox?.pending ?? 0)}</div><div>${esc(state.lastSummary ?? state.lastError ?? 'No recent activity.')}</div>`;
  });
  const cronItems = snapshot.cronJobs.map((job) =>
    `<strong>${esc(job.name)}</strong> <span class="muted">${esc(job.schedule)}</span>${job.mode === 'unleashed' ? ' <span class="tag">unleashed</span>' : ''}<div>${esc(job.prompt.slice(0, 140))}</div>`,
  );
  const workflowItems = snapshot.workflows.map((workflow) =>
    `<strong>${esc(workflow.name)}</strong> <span class="muted">${workflow.enabled ? 'enabled' : 'disabled'}</span><div>${esc(workflow.description || '(no description)')}</div><div class="muted">steps: ${workflow.steps.map((step) => esc(step.id)).join(' -> ')}</div>`,
  );
  const cronRunItems = snapshot.recentCronRuns.map((run) =>
    `<strong>${esc(run.file)}</strong> <span class="muted">${esc(run.status)}</span><div>${esc(run.finishedAt ?? run.startedAt ?? '')}</div>`,
  );
  const workflowRunItems = snapshot.recentWorkflowRuns.map((run) =>
    `<strong>${esc(run.workflow)}</strong> <span class="muted">${esc(run.status)}</span><div>${esc(run.finishedAt ?? run.startedAt ?? run.createdAt ?? '')}</div>`,
  );
  const notificationItems = snapshot.notifications.map((note) =>
    `<strong>${esc(note.title)}</strong>${note.read ? ' <span class="muted">read</span>' : ' <span class="tag">new</span>'}${note.deliveredAt ? ' <span class="tag">delivered</span>' : ''}<div>${esc(note.body)}</div><div class="muted">${esc(note.createdAt)}${note.deliveryError ? ` | delivery error: ${esc(note.deliveryError)}` : ''}${note.deliveredDestinations?.length ? ` | delivered to: ${esc(note.deliveredDestinations.join(', '))}` : ''}</div><form method="post" action="/dashboard/actions/notifications/${encodeURIComponent(esc(note.id))}/read?token=${encodeURIComponent(token)}"><button class="secondary" type="submit">Mark Read</button></form>`,
  );
  const destinationItems = snapshot.notificationDestinations.map((destination) =>
    `<div class="action-row"><div><strong>${esc(destination.name)}</strong> <span class="muted">${esc(destination.type)}</span><div class="muted">${esc(destination.url ?? destination.channelId ?? '(no target)')}</div>${destination.enabled ? ' <span class="tag">enabled</span>' : ' <span class="muted">disabled</span>'}</div><form method="post" action="/dashboard/actions/notifications/destinations/${encodeURIComponent(esc(destination.id))}/test?token=${encodeURIComponent(token)}"><button type="submit">Test</button></form><form method="post" action="/dashboard/actions/notifications/destinations/${encodeURIComponent(esc(destination.id))}/toggle?token=${encodeURIComponent(token)}"><button class="secondary" type="submit">${destination.enabled ? 'Disable' : 'Enable'}</button></form><form method="post" action="/dashboard/actions/notifications/destinations/${encodeURIComponent(esc(destination.id))}/delete?token=${encodeURIComponent(token)}"><button class="secondary" type="submit">Delete</button></form></div>`,
  );
  const queueItems = snapshot.queuedNotificationDeliveries.map((job) =>
    `<strong>${esc(job.notificationId)}</strong> <div class="muted">queued ${esc(job.queuedAt)}</div><div class="muted">completed: ${esc((job.completedDestinationIds ?? []).length)} | failed: ${esc((job.failedDestinationIds ?? []).length)} | pending retry: ${esc(Object.keys(job.nextAttemptAtByDestination ?? {}).length)}</div>`,
  );
  const discordSessionItems = snapshot.recentDiscordSessions.map((session) =>
    `<strong>${esc(session.sessionId)}</strong><div class="muted">user ${esc(session.userId)} | channel ${esc(session.channelId)}${session.guildId ? ` | guild ${esc(session.guildId)}` : ' | DM'}</div><div class="muted">last message ${esc(session.lastMessageAt)}</div>`,
  );
  const approvalActionItems = approvals.map((approval) =>
    `<div class="action-row"><div><strong>${esc(approval.toolName)}</strong> <code>${esc(approval.id)}</code></div><form method="post" action="/dashboard/actions/approve?token=${encodeURIComponent(token)}"><input type="hidden" name="id" value="${esc(approval.id)}" /><button type="submit">Approve</button></form><form method="post" action="/dashboard/actions/reject?token=${encodeURIComponent(token)}"><input type="hidden" name="id" value="${esc(approval.id)}" /><button class="secondary" type="submit">Reject</button></form></div>`,
  );
  const cronActionItems = snapshot.cronJobs.map((job) =>
    `<div class="action-row"><div><strong>${esc(job.name)}</strong> <span class="muted">${esc(job.schedule)}</span></div><form method="post" action="/dashboard/actions/trigger-cron?token=${encodeURIComponent(token)}"><input type="hidden" name="job_name" value="${esc(job.name)}" /><button type="submit">Run Now</button></form></div>`,
  );
  const workflowActionItems = snapshot.workflows
    .filter((workflow) => workflow.enabled && workflow.trigger.manual !== false)
    .map((workflow) =>
    `<div class="action-row"><div><strong>${esc(workflow.name)}</strong></div><form method="post" action="/dashboard/actions/run-workflow?token=${encodeURIComponent(token)}"><input type="hidden" name="name" value="${esc(workflow.name)}" /><button type="submit">Queue Run</button></form></div>`,
  );
  const notificationActionItems = snapshot.notifications.map((note) =>
    `<div class="action-row"><div><strong>${esc(note.title)}</strong> <span class="muted">${esc(note.id)}</span></div><form method="post" action="/dashboard/actions/notifications/${encodeURIComponent(esc(note.id))}/read?token=${encodeURIComponent(token)}"><button class="secondary" type="submit">Mark Read</button></form><form method="post" action="/dashboard/actions/notifications/${encodeURIComponent(esc(note.id))}/retry?token=${encodeURIComponent(token)}"><button type="submit">Retry Delivery</button></form></div>`,
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Clementine Control Plane</title>
  <style>
    :root {
      --bg: #f3efe6;
      --panel: #fffaf0;
      --ink: #1b1f18;
      --muted: #5f6659;
      --line: #d8d0c0;
      --accent: #0f5c4d;
      --accent-soft: #d8ece5;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Iowan Old Style", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top right, #e3efe8 0, transparent 28%),
        radial-gradient(circle at bottom left, #efe3d8 0, transparent 32%),
        var(--bg);
    }
    main { max-width: 1200px; margin: 0 auto; padding: 32px 20px 48px; }
    h1 { font-size: 42px; margin: 0 0 8px; }
    p, li, code, div { line-height: 1.45; }
    .lede { color: var(--muted); margin-bottom: 24px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px 18px 16px;
      box-shadow: 0 10px 30px rgba(31, 34, 24, 0.06);
    }
    h2 { margin: 0 0 12px; font-size: 21px; }
    ul { margin: 0; padding-left: 18px; }
    li { margin: 0 0 10px; }
    .muted { color: var(--muted); }
    .tag {
      display: inline-block;
      margin-left: 6px;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .empty {
      margin: 0;
      color: var(--muted);
      font-style: italic;
    }
    .action-row {
      display: grid;
      grid-template-columns: 1fr auto auto auto;
      gap: 8px;
      align-items: start;
      margin-bottom: 10px;
    }
    form { margin: 0; }
    button {
      border: 0;
      border-radius: 999px;
      background: var(--accent);
      color: white;
      padding: 8px 12px;
      font: inherit;
      cursor: pointer;
    }
    button.secondary {
      background: #8b5c4b;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 16px;
      color: var(--muted);
    }
    .meta code { background: rgba(15,92,77,0.08); padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <main>
    <h1>Clementine Control Plane</h1>
    <p class="lede">Local-first operational view over approvals, agents, cron, workflows, and daemon health.</p>
    <div class="meta">
      <div>Approvals: <code>${approvals.length}</code></div>
      <div>Agents: <code>${snapshot.agents.length}</code></div>
      <div>Cron Jobs: <code>${snapshot.cronJobs.length}</code></div>
      <div>Workflows: <code>${snapshot.workflows.length}</code></div>
      <div>Notifications: <code>${snapshot.notifications.filter((item) => !item.read).length}</code></div>
      <div>Auth: <code>${esc(snapshot.auth.mode)} / ${esc(snapshot.auth.source)}</code></div>
      <div>Discord: <code>${snapshot.discord.connected ? snapshot.discord.userTag ?? 'connected' : snapshot.discord.enabled ? 'configured' : 'disabled'}</code></div>
      <div>Discord Sessions: <code>${snapshot.discordSessionCount}</code></div>
      <div>Last daemon keys: <code>${esc(Object.keys(snapshot.daemonState.lastCronRunByMinute ?? {}).length)}</code></div>
    </div>
    <div class="grid">
      <section>
        <h2>Auth</h2>
        <p class="empty">${esc(snapshot.auth.message)}</p>
        <ul>
          <li><strong>Mode</strong> <span class="muted">${esc(snapshot.auth.mode)}</span></li>
          <li><strong>Configured</strong> <span class="muted">${esc(snapshot.auth.configured ? 'yes' : 'no')}</span></li>
          <li><strong>Source</strong> <span class="muted">${esc(snapshot.auth.source)}</span></li>
          <li><strong>API Key</strong> <span class="muted">${esc(snapshot.auth.openaiApiKeyPresent ? 'present' : 'missing')}</span></li>
          <li><strong>Codex OAuth</strong> <span class="muted">${esc(snapshot.auth.codexOauthPresent ? 'present' : 'missing')}</span></li>
          ${snapshot.auth.codexAccountId ? `<li><strong>Codex Account</strong> <span class="muted">${esc(snapshot.auth.codexAccountId)}</span></li>` : ''}
          ${snapshot.auth.codexLastRefresh ? `<li><strong>Last Refresh</strong> <span class="muted">${esc(snapshot.auth.codexLastRefresh)}</span></li>` : ''}
        </ul>
      </section>
      <section>
        <h2>Pending Approvals</h2>
        ${renderList(approvalItems, 'No pending approvals.')}
      </section>
      <section>
        <h2>Approval Actions</h2>
        ${renderList(approvalActionItems, 'No pending approvals to act on.')}
      </section>
      <section>
        <h2>Team Agents</h2>
        ${renderList(agentItems, 'No team agents configured.')}
      </section>
      <section>
        <h2>Agent Activity</h2>
        ${renderList(agentStateItems, 'No autonomous agent runs recorded yet.')}
      </section>
      <section>
        <h2>Cron Jobs</h2>
        ${renderList(cronItems, 'No cron jobs configured.')}
      </section>
      <section>
        <h2>Cron Actions</h2>
        ${renderList(cronActionItems, 'No cron jobs available.')}
      </section>
      <section>
        <h2>Workflows</h2>
        ${renderList(workflowItems, 'No workflows configured.')}
      </section>
      <section>
        <h2>Workflow Actions</h2>
        ${renderList(workflowActionItems, 'No workflows available.')}
      </section>
      <section>
        <h2>Recent Cron Runs</h2>
        ${renderList(cronRunItems, 'No cron runs recorded yet.')}
      </section>
      <section>
        <h2>Recent Workflow Runs</h2>
        ${renderList(workflowRunItems, 'No workflow runs recorded yet.')}
      </section>
      <section>
        <h2>Notifications</h2>
        ${renderList(notificationItems, 'No notifications yet.')}
      </section>
      <section>
        <h2>Notification Actions</h2>
        ${renderList(notificationActionItems, 'No notifications available.')}
      </section>
      <section>
        <h2>Delivery Destinations</h2>
        ${renderList(destinationItems, 'No delivery destinations configured.')}
        <form method="post" action="/dashboard/actions/notifications/destinations?token=${encodeURIComponent(token)}">
          <p><input name="name" placeholder="Destination name" required /></p>
          <p>
            <select name="type">
              <option value="generic_webhook">Generic Webhook</option>
              <option value="discord_webhook">Discord Webhook</option>
              <option value="discord_channel">Discord Channel</option>
              <option value="discord_user">Discord User DM</option>
            </select>
          </p>
          <p><input name="url" placeholder="https://... or leave blank for Discord bot targets" /></p>
          <p><input name="channel_id" placeholder="Discord channel ID for bot delivery" /></p>
          <p><input name="user_id" placeholder="Discord user ID for DM delivery" /></p>
          <p><button type="submit">Add Destination</button></p>
        </form>
      </section>
      <section>
        <h2>Delivery Queue</h2>
        ${renderList(queueItems, 'No queued deliveries.')}
      </section>
      <section>
        <h2>Discord Sessions</h2>
        ${renderList(discordSessionItems, 'No Discord sessions recorded yet.')}
      </section>
    </div>
  </main>
</body>
</html>`;
}
