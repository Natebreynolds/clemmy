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
      <button class="nav" data-panel="memory">
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

      <section class="panel-frame" data-section="memory" hidden>
        <div class="panel-tag">PANEL · 02 · MEMORY NAVIGATOR</div>

        <div class="panel-body memory-layout">

          <aside class="mem-sidebar">
            <div class="mem-stats" data-mem-stats>
              <div class="mem-stat"><span>CHUNKS</span><em data-mem-chunks>—</em></div>
              <div class="mem-stat"><span>FILES</span><em data-mem-files>—</em></div>
              <div class="mem-stat"><span>FACTS</span><em data-mem-facts>—</em></div>
              <div class="mem-stat"><span>EMBED</span><em data-mem-embed>—</em></div>
            </div>

            <div class="mem-section">
              <div class="mem-section-head">
                <span>INDEXED FILES</span>
                <em data-mem-files-count>—</em>
              </div>
              <ol class="mem-file-list" data-mem-file-list>
                <li class="empty">— loading —</li>
              </ol>
            </div>

            <div class="mem-section">
              <div class="mem-section-head">
                <span>DURABLE FACTS</span>
                <em data-mem-facts-count>—</em>
              </div>
              <div class="mem-fact-kinds" data-mem-fact-kinds>
                <button class="kind-pill active" data-kind="">ALL</button>
                <button class="kind-pill" data-kind="user">USER</button>
                <button class="kind-pill" data-kind="project">PROJECT</button>
                <button class="kind-pill" data-kind="feedback">FEEDBACK</button>
                <button class="kind-pill" data-kind="reference">REFERENCE</button>
              </div>
              <ol class="mem-fact-list" data-mem-fact-list>
                <li class="empty">— loading —</li>
              </ol>
            </div>
          </aside>

          <div class="mem-main">
            <div class="mem-search">
              <input type="search" class="mem-search-input" data-mem-search
                placeholder="search vault · FTS + embedding rerank · ⏎ to query"
                autocomplete="off" spellcheck="false" />
              <span class="mem-search-meta" data-mem-search-meta>—</span>
            </div>

            <div class="mem-viewer" data-mem-viewer>
              <div class="mem-empty">
                <div class="mem-empty-mark">▢</div>
                <div class="mem-empty-text">SEARCH OR SELECT A FILE / FACT</div>
              </div>
            </div>
          </div>

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

/* ── Memory panel ────────────────────────────────────────────── */
.memory-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 18px;
  height: 100%;
  overflow: hidden;
}
.mem-sidebar {
  border: 1px solid var(--line);
  background: var(--bg-2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.mem-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
}
.mem-stat {
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--fg-3);
}
.mem-stat:nth-child(2n) { border-right: 0; }
.mem-stat:nth-last-child(-n+2) { border-bottom: 0; }
.mem-stat em { font-style: normal; color: var(--fg); font-size: 14px; letter-spacing: 0.04em; }

.mem-section {
  border-bottom: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.mem-section:last-child { border-bottom: 0; flex: 1; }
.mem-section-head {
  padding: 8px 12px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
}
.mem-section-head em { font-style: normal; color: var(--fg); }

.mem-file-list,
.mem-fact-list {
  list-style: none;
  margin: 0; padding: 0;
  overflow-y: auto;
  font-size: 11px;
  flex: 1;
  min-height: 80px;
  max-height: 240px;
}
.mem-file-list .empty,
.mem-fact-list .empty {
  padding: 18px;
  text-align: center;
  color: var(--fg-mute);
  letter-spacing: 0.1em;
}
.mem-file-list li.file,
.mem-fact-list li.fact {
  padding: 7px 12px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
  transition: background 100ms;
}
.mem-file-list li.file:hover,
.mem-fact-list li.fact:hover { background: var(--bg-3); }
.mem-file-list li.file.selected,
.mem-fact-list li.fact.selected {
  background: var(--bg-3);
  box-shadow: inset 2px 0 0 var(--accent);
}
.mem-file-list .name {
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
}
.mem-file-list .meta {
  color: var(--fg-3);
  font-size: 10px;
  letter-spacing: 0.06em;
  display: block;
  margin-top: 2px;
}
.mem-fact-list li.fact .kind {
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--accent);
  margin-right: 6px;
}
.mem-fact-list li.fact .body {
  color: var(--fg);
  display: block;
}
.mem-fact-list li.fact .body-extra {
  display: block;
  font-size: 10px;
  color: var(--fg-3);
  margin-top: 2px;
}

.mem-fact-kinds {
  display: flex;
  gap: 4px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
}
.kind-pill {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-3);
  font: inherit;
  font-size: 9px;
  letter-spacing: 0.16em;
  padding: 3px 7px;
  cursor: pointer;
  transition: background 100ms, color 100ms, border-color 100ms;
}
.kind-pill:hover { color: var(--fg); border-color: var(--line-bright); }
.kind-pill.active {
  background: var(--accent);
  color: var(--bg-0);
  border-color: var(--accent);
}

.mem-main {
  border: 1px solid var(--line);
  background: var(--bg-2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.mem-search {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
}
.mem-search-input {
  flex: 1;
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg);
  padding: 7px 10px;
  font: inherit;
  letter-spacing: 0.04em;
  outline: none;
  transition: border-color 120ms;
}
.mem-search-input:focus { border-color: var(--accent); }
.mem-search-input::placeholder { color: var(--fg-mute); letter-spacing: 0.06em; }
.mem-search-meta {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--fg-3);
}

.mem-viewer {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  font-size: 12px;
}
.mem-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--fg-mute);
  letter-spacing: 0.16em;
  font-size: 10px;
}
.mem-empty-mark { font-size: 38px; color: var(--line-bright); }

.search-result {
  border: 1px solid var(--line);
  background: var(--bg-1);
  margin-bottom: 10px;
}
.search-result-head {
  padding: 7px 12px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--fg-3);
}
.search-result-head .title { color: var(--fg); font-size: 11px; }
.search-result-head .score { color: var(--accent-2); }
.search-result-body {
  padding: 10px 12px;
}
.search-result-body pre {
  margin: 0;
  font: 11px/1.55 var(--mono);
  color: var(--fg-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.search-result-body .hit-token {
  color: var(--accent);
  background: rgba(255, 90, 53, 0.15);
  padding: 0 2px;
}
.search-result-path {
  color: var(--fg-mute);
  font-size: 10px;
  letter-spacing: 0.08em;
  word-break: break-all;
}

.file-viewer {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.file-viewer-head {
  border: 1px solid var(--line);
  background: var(--bg-1);
  padding: 10px 12px;
}
.file-viewer-head .path { color: var(--accent); font-size: 11px; word-break: break-all; }
.file-viewer-head .stats { color: var(--fg-3); font-size: 10px; letter-spacing: 0.14em; margin-top: 4px; }
.file-chunk {
  border: 1px solid var(--line);
  background: var(--bg-1);
}
.file-chunk-head {
  padding: 6px 12px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
  color: var(--fg-3);
  font-size: 10px;
  letter-spacing: 0.14em;
  display: flex;
  justify-content: space-between;
}
.file-chunk-head em { font-style: normal; color: var(--fg); }
.file-chunk-body {
  padding: 8px 12px;
}
.file-chunk-body pre {
  margin: 0;
  font: 11px/1.55 var(--mono);
  color: var(--fg-2);
  white-space: pre-wrap;
  word-break: break-word;
}

.fact-viewer {
  border: 1px solid var(--line);
  background: var(--bg-1);
  padding: 14px;
}
.fact-viewer .kind {
  color: var(--accent);
  font-size: 10px;
  letter-spacing: 0.18em;
}
.fact-viewer .body {
  margin: 8px 0;
  font-size: 13px;
  color: var(--fg);
  line-height: 1.5;
}
.fact-viewer .meta {
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--fg-3);
}
.fact-viewer .forget {
  margin-top: 14px;
  background: transparent;
  border: 1px solid var(--accent-fail);
  color: var(--accent-fail);
  padding: 6px 12px;
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  cursor: pointer;
  transition: background 100ms, color 100ms;
}
.fact-viewer .forget:hover { background: var(--accent-fail); color: var(--bg-0); }

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

  // ─── Panel routing ────────────────────────────────────────────
  //
  // Click a sidebar nav button → show its panel-frame, hide the rest.
  // Activity is the default. Memory boots lazily the first time it's
  // shown.

  const navButtons = Array.from(document.querySelectorAll('.nav[data-panel]'));
  const panelSections = Array.from(document.querySelectorAll('.panel-frame[data-section]'));
  let memoryBooted = false;

  function switchPanel(name) {
    panelSections.forEach((s) => {
      const match = s.getAttribute('data-section') === name;
      if (match) s.removeAttribute('hidden');
      else s.setAttribute('hidden', '');
    });
    navButtons.forEach((b) => b.classList.toggle('active', b.getAttribute('data-panel') === name));
    if (name === 'memory' && !memoryBooted) {
      memoryBooted = true;
      bootMemoryPanel();
    } else if (name === 'memory') {
      refreshMemoryPanel();
    }
  }
  navButtons.forEach((b) => {
    b.addEventListener('click', () => {
      if (b.hasAttribute('disabled')) return;
      switchPanel(b.getAttribute('data-panel'));
    });
  });

  // ─── Memory panel ─────────────────────────────────────────────

  const mem = {
    chunks:     document.querySelector('[data-mem-chunks]'),
    files:      document.querySelector('[data-mem-files]'),
    facts:      document.querySelector('[data-mem-facts]'),
    embed:      document.querySelector('[data-mem-embed]'),
    fileList:   document.querySelector('[data-mem-file-list]'),
    factList:   document.querySelector('[data-mem-fact-list]'),
    fileCount:  document.querySelector('[data-mem-files-count]'),
    factCount:  document.querySelector('[data-mem-facts-count]'),
    kinds:      document.querySelector('[data-mem-fact-kinds]'),
    search:     document.querySelector('[data-mem-search]'),
    searchMeta: document.querySelector('[data-mem-search-meta]'),
    viewer:     document.querySelector('[data-mem-viewer]'),
  };
  let memSelectedFile = null;
  let memSelectedFact = null;
  let memActiveKind = '';
  let memSearchSeq = 0;

  function escMem(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  }

  function fmtMtime(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  }

  function shortenPath(full) {
    const parts = full.split('/');
    if (parts.length <= 3) return full;
    return '…/' + parts.slice(-3).join('/');
  }

  async function bootMemoryPanel() {
    await Promise.all([refreshMemoryStatus(), refreshFileList(), refreshFactList()]);
  }
  async function refreshMemoryPanel() {
    await Promise.all([refreshMemoryStatus(), refreshFileList(), refreshFactList()]);
  }

  async function refreshMemoryStatus() {
    try {
      const snap = await fetchJSON('/api/dashboard');
      const idx = snap.memoryIndex || {};
      mem.chunks.textContent = idx.chunks ?? '—';
      mem.files.textContent  = idx.indexedFiles ?? '—';
      mem.facts.textContent  = idx.activeFacts ?? '—';
      mem.embed.textContent  = idx.embeddingsEnabled
        ? Math.round((idx.embeddingsCoverage || 0) * 100) + '%'
        : 'off';
    } catch (_) { /* tolerate offline */ }
  }

  async function refreshFileList() {
    try {
      const data = await fetchJSON('/api/console/memory/files');
      const files = data.files || [];
      mem.fileCount.textContent = files.length;
      if (files.length === 0) {
        mem.fileList.innerHTML = '<li class="empty">— no indexed files —</li>';
        return;
      }
      mem.fileList.innerHTML = files.slice(0, 60).map((f) => {
        const cls = memSelectedFile === f.path ? 'file selected' : 'file';
        return [
          '<li class="' + cls + '" data-file-path="' + escMem(f.path) + '">',
          '  <span class="name" title="' + escMem(f.path) + '">' + escMem(shortenPath(f.path)) + '</span>',
          '  <span class="meta">' + f.chunks + ' chunks · ' + fmtMtime(f.mtime) + '</span>',
          '</li>',
        ].join('');
      }).join('');
      Array.from(mem.fileList.querySelectorAll('li.file')).forEach((li) => {
        li.addEventListener('click', () => {
          memSelectedFile = li.getAttribute('data-file-path');
          memSelectedFact = null;
          Array.from(mem.fileList.querySelectorAll('li.file')).forEach((el) => el.classList.toggle('selected', el === li));
          Array.from(mem.factList.querySelectorAll('li.fact')).forEach((el) => el.classList.remove('selected'));
          loadFileViewer(memSelectedFile);
        });
      });
    } catch (err) {
      mem.fileList.innerHTML = '<li class="empty">— failed: ' + escMem(err.message || err) + ' —</li>';
    }
  }

  async function refreshFactList() {
    try {
      const url = memActiveKind ? '/api/console/memory/facts?kind=' + encodeURIComponent(memActiveKind) : '/api/console/memory/facts';
      const data = await fetchJSON(url);
      const facts = data.facts || [];
      mem.factCount.textContent = facts.length;
      if (facts.length === 0) {
        mem.factList.innerHTML = '<li class="empty">— no facts in this kind —</li>';
        return;
      }
      mem.factList.innerHTML = facts.map((f) => {
        const cls = memSelectedFact === f.id ? 'fact selected' : 'fact';
        return [
          '<li class="' + cls + '" data-fact-id="' + f.id + '">',
          '  <span class="kind">' + escMem(f.kind.toUpperCase()) + '</span>',
          '  <span class="body">' + escMem(f.content) + '</span>',
          '  <span class="body-extra">score ' + (f.score || 1).toFixed(2) + ' · updated ' + (f.updatedAt ? f.updatedAt.slice(0, 10) : '—') + '</span>',
          '</li>',
        ].join('');
      }).join('');
      Array.from(mem.factList.querySelectorAll('li.fact')).forEach((li) => {
        li.addEventListener('click', () => {
          memSelectedFact = Number(li.getAttribute('data-fact-id'));
          memSelectedFile = null;
          Array.from(mem.factList.querySelectorAll('li.fact')).forEach((el) => el.classList.toggle('selected', el === li));
          Array.from(mem.fileList.querySelectorAll('li.file')).forEach((el) => el.classList.remove('selected'));
          const fact = facts.find((f) => f.id === memSelectedFact);
          if (fact) renderFactViewer(fact);
        });
      });
    } catch (err) {
      mem.factList.innerHTML = '<li class="empty">— failed: ' + escMem(err.message || err) + ' —</li>';
    }
  }

  mem.kinds.querySelectorAll('.kind-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      memActiveKind = pill.getAttribute('data-kind') || '';
      mem.kinds.querySelectorAll('.kind-pill').forEach((p) => p.classList.toggle('active', p === pill));
      refreshFactList();
    });
  });

  mem.search.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = mem.search.value.trim();
    if (!q) return;
    const seq = ++memSearchSeq;
    mem.searchMeta.textContent = 'searching…';
    try {
      const data = await fetchJSON('/api/console/memory/search?q=' + encodeURIComponent(q) + '&limit=10');
      if (seq !== memSearchSeq) return;
      renderSearchResults(q, data.hits || []);
    } catch (err) {
      mem.searchMeta.textContent = 'search failed';
      mem.viewer.innerHTML = '<div class="mem-empty"><div class="mem-empty-mark">!</div><div class="mem-empty-text">' + escMem(err.message || err) + '</div></div>';
    }
  });

  function renderSearchResults(query, hits) {
    mem.searchMeta.textContent = hits.length + ' HIT' + (hits.length === 1 ? '' : 'S');
    if (hits.length === 0) {
      mem.viewer.innerHTML = '<div class="mem-empty"><div class="mem-empty-mark">∅</div><div class="mem-empty-text">NO RESULTS FOR &ldquo;' + escMem(query) + '&rdquo;</div></div>';
      return;
    }
    mem.viewer.innerHTML = hits.map((hit) => {
      // Highlight bracketed tokens from FTS snippet rendering ([token])
      const snippetHtml = escMem(hit.snippet || '').replace(/\\[(.+?)\\]/g, '<span class="hit-token">$1</span>');
      return [
        '<div class="search-result">',
        '  <div class="search-result-head">',
        '    <span class="title">' + escMem(hit.title || '(untitled)') + '</span>',
        '    <span class="score">' + (typeof hit.score === 'number' ? hit.score.toFixed(2) : '—') + '</span>',
        '  </div>',
        '  <div class="search-result-body">',
        '    <pre>' + snippetHtml + '</pre>',
        '    <div class="search-result-path">' + escMem(hit.filePath || '') + '</div>',
        '  </div>',
        '</div>',
      ].join('');
    }).join('');
  }

  async function loadFileViewer(path) {
    if (!path) return;
    try {
      const data = await fetchJSON('/api/console/memory/file?path=' + encodeURIComponent(path));
      const chunks = data.chunks || [];
      const totalBytes = chunks.reduce((s, c) => s + (c.byteSize || 0), 0);
      const stats = chunks.length + ' chunks · ' + totalBytes + ' bytes';
      const head = '<div class="file-viewer-head"><div class="path">' + escMem(path) + '</div><div class="stats">' + stats + '</div></div>';
      const body = chunks.map((c) => [
        '<div class="file-chunk">',
        '  <div class="file-chunk-head"><span>CHUNK #' + c.chunkIndex + '</span><em>' + escMem(c.title || '(no title)') + '</em></div>',
        '  <div class="file-chunk-body"><pre>' + escMem(c.content) + '</pre></div>',
        '</div>',
      ].join('')).join('');
      mem.viewer.innerHTML = '<div class="file-viewer">' + head + body + '</div>';
    } catch (err) {
      mem.viewer.innerHTML = '<div class="mem-empty"><div class="mem-empty-mark">!</div><div class="mem-empty-text">' + escMem(err.message || err) + '</div></div>';
    }
  }

  function renderFactViewer(fact) {
    const html = [
      '<div class="fact-viewer">',
      '  <div class="kind">' + escMem(fact.kind.toUpperCase()) + ' · #' + fact.id + '</div>',
      '  <div class="body">' + escMem(fact.content) + '</div>',
      '  <div class="meta">score ' + (fact.score || 1).toFixed(2)
         + ' · created ' + (fact.createdAt ? fact.createdAt.slice(0, 19).replace('T', ' ') : '—')
         + ' · updated ' + (fact.updatedAt ? fact.updatedAt.slice(0, 19).replace('T', ' ') : '—') + '</div>',
      '  <button class="forget" data-forget-id="' + fact.id + '">FORGET ▣</button>',
      '</div>',
    ].join('');
    mem.viewer.innerHTML = html;
    const btn = mem.viewer.querySelector('.forget');
    btn.addEventListener('click', async () => {
      if (!confirm('Soft-delete fact #' + fact.id + '?')) return;
      try {
        await fetch(withToken('/api/console/memory/facts/' + fact.id + '/forget'), { method: 'POST' });
        await refreshFactList();
        await refreshMemoryStatus();
        mem.viewer.innerHTML = '<div class="mem-empty"><div class="mem-empty-mark">▢</div><div class="mem-empty-text">FACT FORGOTTEN</div></div>';
      } catch (err) {
        alert('Forget failed: ' + (err.message || err));
      }
    });
  }

  // Boot the loop.
  tick();
  setInterval(tick, POLL_MS);
})();
`;
