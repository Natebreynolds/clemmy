/**
 * Clementine Console — the new operational dashboard surface.
 *
 * Lives at /console alongside the existing /dashboard. Distinct visual
 * language ("operational console" aesthetic) and surfaces that scale
 * to the full vision: agent management, workflows, skills, tool catalog,
 * memory navigator, project picker, workflow studio with chat.
 *
 * Architecture:
 *   - Single HTML page response, no build step.
 *   - All CSS and JS inlined so it ships in the route handler.
 *   - Vanilla JS, no framework. Talks to the existing /api/* endpoints
 *     the dashboard already exposes (runs, dashboard snapshot,
 *     approvals, etc.) plus a couple of console-specific routes.
 *   - Polls /api/runs every 2s for live activity.
 *
 * Visual identity: near-black background, hairline borders, monospace
 * everywhere, tight 8px grid, surgical accent colors. Designed to feel
 * like an instrument panel, not a marketing dashboard.
 */

function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderConsoleHtml(token: string): string {
  const tokenJson = JSON.stringify(token);
  return /* html */ `<!DOCTYPE html>
<html lang="en" data-theme="ops">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Clementine // Console</title>
  <link rel="icon" href="data:," />
  <style>${CONSOLE_CSS}</style>
</head>
<body>
  <div class="grid">

    <header class="status-bar">
      <div class="brand">
        <span class="pulse" aria-hidden="true"></span>
        <span class="brand-mark">CLEMENTINE</span>
        <span class="brand-sep">//</span>
        <span class="brand-sub">CONSOLE</span>
      </div>
      <div class="status-row" data-status-row>
        <span class="stat" data-stat-runs>RUNS · <em>—</em></span>
        <span class="stat" data-stat-memory>MEM · <em>—</em></span>
        <span class="stat" data-stat-approvals>APPRV · <em>—</em></span>
        <span class="stat" data-stat-policy>MODE · <em>—</em></span>
        <span class="stat connection" data-stat-connection>● ONLINE</span>
      </div>
    </header>

    <nav class="sidebar" aria-label="Console sections">
      <button class="nav active" data-panel="activity">
        <span class="nav-key">01</span>
        <span class="nav-label">Activity</span>
      </button>
      <button class="nav" data-panel="memory" disabled title="Coming next">
        <span class="nav-key">02</span>
        <span class="nav-label">Memory</span>
      </button>
      <button class="nav" data-panel="workflows" disabled title="Coming next">
        <span class="nav-key">03</span>
        <span class="nav-label">Workflows</span>
      </button>
      <button class="nav" data-panel="tools" disabled title="Coming next">
        <span class="nav-key">04</span>
        <span class="nav-label">Tools</span>
      </button>
      <button class="nav" data-panel="projects" disabled title="Coming next">
        <span class="nav-key">05</span>
        <span class="nav-label">Projects</span>
      </button>
      <button class="nav" data-panel="skills" disabled title="Coming next">
        <span class="nav-key">06</span>
        <span class="nav-label">Skills</span>
      </button>
      <button class="nav" data-panel="settings" disabled title="Coming next">
        <span class="nav-key">07</span>
        <span class="nav-label">Settings</span>
      </button>
      <div class="nav-foot">
        <a class="nav-foot-link" href="/dashboard?token=${esc(token)}">↗ classic dashboard</a>
      </div>
    </nav>

    <main class="panel" data-active-panel="activity">

      <section class="panel-frame" data-section="activity">
        <div class="panel-tag">PANEL · 01 · ACTIVITY PULSE</div>

        <div class="panel-body activity-layout">

          <div class="activity-feed">
            <div class="feed-header">
              <span class="feed-title">LIVE RUNS</span>
              <span class="feed-meta">
                <span class="feed-stat">TOTAL · <em data-feed-total>0</em></span>
                <span class="feed-stat">RUNNING · <em data-feed-running>0</em></span>
                <span class="feed-stat">FAILED · <em data-feed-failed>0</em></span>
              </span>
            </div>
            <ol class="run-list" data-run-list aria-live="polite">
              <li class="empty">— waiting for first run —</li>
            </ol>
          </div>

          <aside class="activity-detail">
            <div class="detail-header">
              <span class="detail-title">RUN INSPECTOR</span>
              <span class="detail-meta" data-detail-id>—</span>
            </div>
            <div class="detail-body" data-detail-body>
              <p class="hint">Select a run to inspect its event timeline.</p>
            </div>
          </aside>

        </div>
      </section>

    </main>

    <footer class="foot-bar">
      <span class="foot-cell">poll · 2s</span>
      <span class="foot-cell">last · <em data-last-sync>—</em></span>
      <span class="foot-cell foot-right">⌘ K coming soon</span>
    </footer>

  </div>

  <script>
    window.__CLEMENTINE_TOKEN__ = ${tokenJson};
  </script>
  <script>${CONSOLE_JS}</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────
//  Stylesheet — kept as a string literal so the page response is self-
//  contained. Mirrors a hardware-instrument aesthetic.
// ─────────────────────────────────────────────────────────────────────
const CONSOLE_CSS = `
:root {
  /* Surfaces */
  --bg-0: #07070a;
  --bg-1: #0d0d12;
  --bg-2: #14141c;
  --bg-3: #1c1c26;

  /* Lines */
  --line: #2a2a36;
  --line-bright: #44445a;

  /* Text */
  --fg: #e5e5ea;
  --fg-2: #a0a0aa;
  --fg-3: #6b6b78;
  --fg-mute: #4a4a55;

  /* Accents */
  --accent: #ff5a35;        /* tactical orange */
  --accent-2: #b9ff36;      /* electric lime */
  --accent-3: #36c5ff;      /* cyan */
  --accent-warn: #ffcc33;
  --accent-fail: #ff3b5a;

  --mono: ui-monospace, "SF Mono", "JetBrains Mono", "IBM Plex Mono", Menlo, monospace;
  --tile: 8px;
}

* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }

body {
  background: var(--bg-0);
  color: var(--fg);
  font: 13px/1.4 var(--mono);
  letter-spacing: 0.01em;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
  /* Subtle scan-line texture — gives the console a CRT-ish feel without
     being heavy-handed. */
  background-image:
    repeating-linear-gradient(
      to bottom,
      transparent 0px,
      transparent 3px,
      rgba(255, 255, 255, 0.012) 3px,
      rgba(255, 255, 255, 0.012) 4px
    );
}

/* ── Layout ─────────────────────────────────────────────────────── */
.grid {
  display: grid;
  grid-template-columns: 220px 1fr;
  grid-template-rows: 44px 1fr 28px;
  grid-template-areas:
    "header header"
    "sidebar panel"
    "foot foot";
  height: 100vh;
}
.status-bar { grid-area: header; }
.sidebar     { grid-area: sidebar; }
.panel       { grid-area: panel; overflow: hidden; }
.foot-bar    { grid-area: foot; }

/* ── Status bar (top) ─────────────────────────────────────────── */
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--line);
  position: relative;
}
.status-bar::after {
  /* Hairline accent ribbon below the bar — subtle vertical anchor. */
  content: "";
  position: absolute;
  left: 0; right: 0; bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent 0, var(--accent) 18%, transparent 38%);
  opacity: 0.55;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  letter-spacing: 0.18em;
  font-size: 11px;
}
.brand-mark { color: var(--fg); }
.brand-sep  { color: var(--fg-mute); }
.brand-sub  { color: var(--accent); }
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-2);
  box-shadow: 0 0 8px rgba(185, 255, 54, 0.55);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.45; transform: scale(0.7); }
}
.status-row {
  display: flex;
  gap: 18px;
  font-size: 11px;
  color: var(--fg-3);
  letter-spacing: 0.1em;
}
.status-row .stat em {
  font-style: normal;
  color: var(--fg);
  margin-left: 4px;
}
.status-row .connection {
  color: var(--accent-2);
}
.status-row .connection[data-offline] {
  color: var(--accent-fail);
}

/* ── Sidebar (left nav) ───────────────────────────────────────── */
.sidebar {
  background: var(--bg-1);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  padding: 12px 0;
}
.nav {
  background: transparent;
  border: 0;
  border-left: 2px solid transparent;
  text-align: left;
  padding: 9px 18px 9px 14px;
  color: var(--fg-2);
  font: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-size: 11px;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.nav:hover:not(:disabled) {
  background: var(--bg-2);
  color: var(--fg);
}
.nav.active {
  border-left-color: var(--accent);
  background: var(--bg-2);
  color: var(--fg);
}
.nav:disabled {
  opacity: 0.32;
  cursor: not-allowed;
}
.nav-key {
  color: var(--fg-mute);
  font-size: 10px;
  letter-spacing: 0.16em;
}
.nav.active .nav-key { color: var(--accent); }
.nav-foot {
  margin-top: auto;
  padding: 14px 16px;
  border-top: 1px dashed var(--line);
}
.nav-foot-link {
  color: var(--fg-3);
  text-decoration: none;
  font-size: 10px;
  letter-spacing: 0.14em;
}
.nav-foot-link:hover { color: var(--accent); }

/* ── Panel area ───────────────────────────────────────────────── */
.panel { padding: 18px; overflow-y: auto; }
.panel-frame {
  border: 1px solid var(--line);
  background: var(--bg-1);
  position: relative;
  height: 100%;
}
.panel-tag {
  position: absolute;
  top: -10px;
  left: 16px;
  background: var(--bg-0);
  padding: 0 8px;
  font-size: 10px;
  letter-spacing: 0.22em;
  color: var(--accent);
  border: 1px solid var(--line);
}
.panel-body {
  height: 100%;
  padding: 20px 18px 18px;
  overflow: hidden;
}

/* ── Activity panel ───────────────────────────────────────────── */
.activity-layout {
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: 18px;
  height: 100%;
  overflow: hidden;
}

.activity-feed,
.activity-detail {
  border: 1px solid var(--line);
  background: var(--bg-2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.feed-header,
.detail-header {
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg-1);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
}
.feed-title, .detail-title { color: var(--fg); }
.feed-stat { margin-left: 14px; }
.feed-stat em { font-style: normal; color: var(--fg); margin-left: 4px; }
.detail-meta { color: var(--accent); font-size: 11px; }

.run-list {
  list-style: none;
  margin: 0; padding: 0;
  overflow-y: auto;
  font-size: 12px;
}
.run-list .empty {
  padding: 24px;
  text-align: center;
  color: var(--fg-mute);
  letter-spacing: 0.1em;
}
.run-list li.run {
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  display: grid;
  grid-template-columns: 14px 64px 80px 1fr 70px;
  gap: 10px;
  align-items: baseline;
  cursor: pointer;
  transition: background 100ms, color 100ms;
  position: relative;
}
.run-list li.run:hover { background: var(--bg-3); }
.run-list li.run.selected {
  background: var(--bg-3);
  box-shadow: inset 2px 0 0 var(--accent);
}
.run-list li.run .dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--fg-mute);
  margin-top: 6px;
}
.run-list li.run[data-status="running"] .dot,
.run-list li.run[data-status="received"] .dot {
  background: var(--accent-3);
  box-shadow: 0 0 8px rgba(54, 197, 255, 0.55);
  animation: pulse 1.4s ease-in-out infinite;
}
.run-list li.run[data-status="completed"] .dot { background: var(--accent-2); }
.run-list li.run[data-status="failed"] .dot    { background: var(--accent-fail); }
.run-list li.run[data-status="queued"] .dot,
.run-list li.run[data-status="awaiting_approval"] .dot { background: var(--accent-warn); }

.run-list li.run .time { color: var(--fg-3); font-size: 10px; letter-spacing: 0.04em; }
.run-list li.run .src  { color: var(--fg-2); font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; }
.run-list li.run .title {
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.run-list li.run .dur  { color: var(--fg-3); font-size: 10px; text-align: right; }

/* ── Detail (inspector) ──────────────────────────────────────── */
.detail-body {
  flex: 1;
  padding: 12px 14px;
  overflow-y: auto;
  font-size: 11px;
  color: var(--fg-2);
}
.detail-body .hint {
  color: var(--fg-mute);
  text-align: center;
  margin-top: 32px;
  letter-spacing: 0.08em;
}
.detail-block {
  border: 1px solid var(--line);
  background: var(--bg-1);
  margin-bottom: 10px;
}
.detail-block-head {
  padding: 6px 10px;
  background: var(--bg-2);
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--fg-3);
  border-bottom: 1px solid var(--line);
}
.detail-block-body { padding: 8px 10px; }
.detail-block-body pre {
  margin: 0;
  font: 11px/1.45 var(--mono);
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-word;
}
.detail-event {
  border-bottom: 1px dashed var(--line);
  padding: 6px 0;
  display: grid;
  grid-template-columns: 60px 110px 1fr;
  gap: 8px;
  align-items: baseline;
}
.detail-event:last-child { border-bottom: 0; }
.detail-event .ev-time { color: var(--fg-3); font-size: 10px; }
.detail-event .ev-type { color: var(--accent-3); font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; }
.detail-event[data-type="tool_started"] .ev-type { color: var(--accent); }
.detail-event[data-type="completed"] .ev-type     { color: var(--accent-2); }
.detail-event[data-type="failed"] .ev-type        { color: var(--accent-fail); }
.detail-event[data-type="approval_required"] .ev-type { color: var(--accent-warn); }
.detail-event[data-type="queued_background"] .ev-type { color: var(--accent-warn); }
.detail-event .ev-msg { color: var(--fg); }

/* ── Foot bar ───────────────────────────────────────────────── */
.foot-bar {
  display: flex;
  align-items: center;
  padding: 0 16px;
  background: var(--bg-1);
  border-top: 1px solid var(--line);
  font-size: 10px;
  color: var(--fg-mute);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  gap: 18px;
}
.foot-cell em { color: var(--fg-2); font-style: normal; margin-left: 4px; }
.foot-right { margin-left: auto; }

/* ── Scrollbars (subtle) ────────────────────────────────────── */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--line); border-radius: 0; }
::-webkit-scrollbar-thumb:hover { background: var(--line-bright); }
`;

// ─────────────────────────────────────────────────────────────────────
//  Inline JS — single IIFE. Polls the dashboard snapshot + runs feed,
//  renders the activity feed, and binds run-row clicks to load the
//  inspector. No framework; this stays small and self-contained.
// ─────────────────────────────────────────────────────────────────────
const CONSOLE_JS = `
(function () {
  'use strict';

  const TOKEN = window.__CLEMENTINE_TOKEN__ || '';
  const POLL_MS = 2000;

  const els = {
    runs:      document.querySelector('[data-stat-runs] em'),
    memory:    document.querySelector('[data-stat-memory] em'),
    approvals: document.querySelector('[data-stat-approvals] em'),
    policy:    document.querySelector('[data-stat-policy] em'),
    conn:      document.querySelector('[data-stat-connection]'),
    runList:   document.querySelector('[data-run-list]'),
    feedTotal: document.querySelector('[data-feed-total]'),
    feedRun:   document.querySelector('[data-feed-running]'),
    feedFail:  document.querySelector('[data-feed-failed]'),
    detailId:  document.querySelector('[data-detail-id]'),
    detailBody:document.querySelector('[data-detail-body]'),
    lastSync:  document.querySelector('[data-last-sync]'),
  };

  let selectedRunId = null;
  let lastSnapshotJSON = '';
  let lastRunsJSON = '';

  function withToken(path) {
    const sep = path.includes('?') ? '&' : '?';
    return path + sep + 'token=' + encodeURIComponent(TOKEN);
  }

  async function fetchJSON(path) {
    const r = await fetch(withToken(path), { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  function setOnline(ok) {
    if (ok) {
      els.conn.removeAttribute('data-offline');
      els.conn.textContent = '● ONLINE';
    } else {
      els.conn.setAttribute('data-offline', 'true');
      els.conn.textContent = '● OFFLINE';
    }
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    return iso.slice(11, 19);
  }

  function fmtDuration(rec) {
    if (!rec.createdAt) return '';
    const end = rec.completedAt || new Date().toISOString();
    const ms = new Date(end).getTime() - new Date(rec.createdAt).getTime();
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return Math.round(ms / 1000) + 's';
  }

  function renderRunList(runs) {
    if (!runs || runs.length === 0) {
      els.runList.innerHTML = '<li class="empty">— waiting for first run —</li>';
      return;
    }
    // Stable sort: most recent updatedAt first.
    const sorted = runs.slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const html = sorted.slice(0, 80).map((run) => {
      const status = run.status || 'unknown';
      const cls = selectedRunId === run.id ? 'run selected' : 'run';
      const title = (run.title || run.input || '(no title)').replace(/[<>&]/g, (c) => ({
        '<': '&lt;', '>': '&gt;', '&': '&amp;',
      }[c]));
      const src = (run.source || '?').toUpperCase();
      return [
        '<li class="' + cls + '" data-run-id="' + run.id + '" data-status="' + status + '">',
        '  <span class="dot"></span>',
        '  <span class="time">' + fmtTime(run.createdAt) + '</span>',
        '  <span class="src">' + src + '</span>',
        '  <span class="title" title="' + title + '">' + title + '</span>',
        '  <span class="dur">' + fmtDuration(run) + '</span>',
        '</li>',
      ].join('');
    }).join('');
    els.runList.innerHTML = html;
    Array.from(els.runList.querySelectorAll('li.run')).forEach((li) => {
      li.addEventListener('click', () => {
        selectedRunId = li.getAttribute('data-run-id');
        Array.from(els.runList.querySelectorAll('li.run')).forEach((el) => el.classList.toggle('selected', el === li));
        loadDetail(selectedRunId);
      });
    });
  }

  function renderDetail(run) {
    if (!run) {
      els.detailId.textContent = '—';
      els.detailBody.innerHTML = '<p class="hint">Run not found.</p>';
      return;
    }
    els.detailId.textContent = run.id;
    const headLines = [
      ['STATUS',  run.status],
      ['AGENT',   run.userId || run.sessionId || '—'],
      ['CHANNEL', run.channel || '—'],
      ['SOURCE',  run.source || '—'],
      ['TITLE',   run.title || '—'],
    ];
    const headHtml = '<div class="detail-block"><div class="detail-block-head">HEADER</div><div class="detail-block-body"><pre>'
      + headLines.map((kv) => kv[0].padEnd(8) + ' ' + esc(kv[1])).join('\\n')
      + '</pre></div></div>';

    const events = (run.events || []).slice(-40);
    const eventsHtml = '<div class="detail-block"><div class="detail-block-head">TIMELINE · ' + events.length + ' / ' + (run.events || []).length + '</div><div class="detail-block-body">'
      + (events.length === 0
        ? '<p class="hint" style="margin:8px 0;">No events recorded.</p>'
        : events.map((ev) =>
          '<div class="detail-event" data-type="' + esc(ev.type) + '">'
          + '<span class="ev-time">' + fmtTime(ev.createdAt) + '</span>'
          + '<span class="ev-type">' + esc(ev.type) + '</span>'
          + '<span class="ev-msg">' + esc(ev.message) + '</span>'
          + '</div>'
        ).join(''))
      + '</div></div>';

    let outputHtml = '';
    if (run.outputPreview) {
      outputHtml = '<div class="detail-block"><div class="detail-block-head">OUTPUT PREVIEW</div><div class="detail-block-body"><pre>'
        + esc(run.outputPreview) + '</pre></div></div>';
    }
    if (run.error) {
      outputHtml += '<div class="detail-block"><div class="detail-block-head" style="color:var(--accent-fail);">ERROR</div><div class="detail-block-body"><pre>'
        + esc(run.error) + '</pre></div></div>';
    }

    els.detailBody.innerHTML = headHtml + eventsHtml + outputHtml;
  }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  }

  async function loadDetail(id) {
    if (!id) return;
    try {
      const data = await fetchJSON('/api/runs/' + encodeURIComponent(id));
      renderDetail(data);
    } catch (err) {
      els.detailBody.innerHTML = '<p class="hint">Failed to load run · ' + esc(err.message || err) + '</p>';
    }
  }

  async function tick() {
    try {
      const [snap, runs] = await Promise.all([
        fetchJSON('/api/dashboard'),
        fetchJSON('/api/runs'),
      ]);
      setOnline(true);

      // Status bar
      const memIdx = snap.memoryIndex || {};
      els.runs.textContent      = (runs.runs || runs || []).length;
      els.memory.textContent    = (memIdx.chunks ?? '—') + ' / ' + (memIdx.activeFacts ?? '—') + 'f';
      els.approvals.textContent = (snap.approvals || []).length;
      els.policy.textContent    = ((snap.proactivity && snap.proactivity.policy && snap.proactivity.policy.mode) || '—').toUpperCase();

      const list = runs.runs || runs || [];
      const running = list.filter((r) => r.status === 'running' || r.status === 'received').length;
      const failed  = list.filter((r) => r.status === 'failed').length;
      els.feedTotal.textContent = list.length;
      els.feedRun.textContent   = running;
      els.feedFail.textContent  = failed;

      const snapshotJSON = JSON.stringify({ chunks: memIdx.chunks, facts: memIdx.activeFacts, approvals: (snap.approvals || []).length, mode: snap.proactivity && snap.proactivity.policy && snap.proactivity.policy.mode });
      const runsJSON = JSON.stringify(list.map((r) => [r.id, r.status, r.updatedAt]));
      if (runsJSON !== lastRunsJSON) {
        renderRunList(list);
        lastRunsJSON = runsJSON;
      }
      lastSnapshotJSON = snapshotJSON;

      if (selectedRunId) {
        const stillThere = list.find((r) => r.id === selectedRunId);
        if (stillThere) loadDetail(selectedRunId);
      }

      els.lastSync.textContent = new Date().toLocaleTimeString();
    } catch (err) {
      setOnline(false);
      els.lastSync.textContent = 'stalled';
    }
  }

  // Boot the loop.
  tick();
  setInterval(tick, POLL_MS);
})();
`;
