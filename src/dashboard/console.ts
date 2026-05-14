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
      <button class="nav" data-panel="workflows">
        <span class="nav-key">03</span>
        <span class="nav-label">Workflows</span>
      </button>
      <button class="nav" data-panel="tools">
        <span class="nav-key">04</span>
        <span class="nav-label">Tools</span>
      </button>
      <button class="nav" data-panel="projects">
        <span class="nav-key">05</span>
        <span class="nav-label">Projects</span>
      </button>
      <button class="nav" data-panel="skills">
        <span class="nav-key">06</span>
        <span class="nav-label">Skills</span>
      </button>
      <button class="nav" data-panel="settings">
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

      <section class="panel-frame" data-section="workflows" hidden>
        <div class="panel-tag">PANEL · 03 · WORKFLOW STUDIO</div>

        <div class="panel-body wf-layout">

          <!-- Workflow list (left) -->
          <aside class="wf-list-pane">
            <div class="wf-list-head">
              <span>WORKFLOWS</span>
              <button class="wf-new-btn" data-wf-new title="Create new workflow">＋ NEW</button>
            </div>
            <ol class="wf-list" data-wf-list>
              <li class="empty">— loading —</li>
            </ol>
          </aside>

          <!-- Editor (middle) -->
          <div class="wf-editor" data-wf-editor>
            <div class="wf-empty">
              <div class="wf-empty-mark">⊟</div>
              <div class="wf-empty-text">SELECT A WORKFLOW OR ＋NEW</div>
            </div>
          </div>

          <!-- Architect chat (right) -->
          <aside class="wf-chat-pane">
            <div class="wf-chat-head">
              <span class="wf-chat-title">ARCHITECT</span>
              <span class="wf-chat-meta" data-wf-chat-meta>idle</span>
            </div>
            <div class="wf-chat-log" data-wf-chat-log>
              <div class="wf-chat-intro">
                Workflow Architect chat.<br>
                Ask the agent to draft, refine, or critique the workflow on the left.
                <br><br>
                <em>e.g. "Add a step after research that drafts a weekly email" or "Tighten the schedule to weekdays 9am" or "Validate this for cycles".</em>
              </div>
            </div>
            <form class="wf-chat-form" data-wf-chat-form>
              <textarea class="wf-chat-input" data-wf-chat-input
                placeholder="message the architect · ⏎ to send · shift+⏎ for newline"
                rows="2" autocomplete="off"></textarea>
              <button type="submit" class="wf-chat-send" data-wf-chat-send>SEND ▸</button>
            </form>
          </aside>

        </div>
      </section>

      <section class="panel-frame" data-section="tools" hidden>
        <div class="panel-tag">PANEL · 04 · TOOLS CATALOG</div>
        <div class="panel-body tools-layout">

          <aside class="tools-side">
            <div class="tools-filter">
              <input class="tools-search" data-tools-search type="search" placeholder="filter tools · category, name…" />
              <span class="tools-count" data-tools-count>—</span>
            </div>
            <div class="tools-categories" data-tools-categories>
              <!-- pills populated by JS -->
            </div>
          </aside>

          <div class="tools-main">
            <div class="tools-section">
              <div class="tools-section-head">
                <span>REGISTERED TOOLS</span>
                <em data-tools-shown>—</em>
              </div>
              <div class="tools-grid" data-tools-grid>
                <div class="tools-empty">— loading —</div>
              </div>
            </div>

            <div class="tools-section">
              <div class="tools-section-head">
                <span>DISCOVERED MCP SERVERS</span>
                <em data-mcp-count>—</em>
              </div>
              <div class="mcp-grid" data-mcp-grid>
                <div class="tools-empty">— loading —</div>
              </div>
            </div>
          </div>

        </div>
      </section>

      <section class="panel-frame" data-section="projects" hidden>
        <div class="panel-tag">PANEL · 05 · PROJECTS</div>
        <div class="panel-body projects-layout">

          <aside class="proj-side">
            <div class="proj-side-head">
              <span>WORKSPACES</span>
              <em data-proj-workspaces-count>—</em>
            </div>
            <ul class="proj-ws-list" data-proj-ws-list>
              <li class="empty">— loading —</li>
            </ul>
            <div class="proj-side-head">
              <span>DETECTED PROJECTS</span>
              <em data-proj-list-count>—</em>
            </div>
            <ol class="proj-list" data-proj-list>
              <li class="empty">— loading —</li>
            </ol>
          </aside>

          <div class="proj-detail" data-proj-detail>
            <div class="wf-empty">
              <div class="wf-empty-mark">⌗</div>
              <div class="wf-empty-text">SELECT A PROJECT</div>
            </div>
          </div>

        </div>
      </section>

      <section class="panel-frame" data-section="skills" hidden>
        <div class="panel-tag">PANEL · 06 · SKILLS</div>
        <div class="panel-body skills-layout">

          <div class="skills-header">
            <div class="skills-intro">
              <h3>Installed Skills</h3>
              <p>Skills are plugins dropped into <code data-skills-dir>~/.clementine-next/plugins/</code>.
                 Each plugin can register tools the agent calls just like built-in ones.</p>
            </div>
            <div class="skills-stats">
              <div class="stat-card"><span>SKILLS</span><em data-skills-count>—</em></div>
              <div class="stat-card"><span>TOOLS</span><em data-skills-tool-count>—</em></div>
            </div>
          </div>

          <div class="skills-grid" data-skills-grid>
            <div class="tools-empty">— loading —</div>
          </div>

        </div>
      </section>

      <section class="panel-frame" data-section="settings" hidden>
        <div class="panel-tag">PANEL · 07 · SETTINGS</div>
        <div class="panel-body settings-layout">

          <div class="settings-col">
            <div class="settings-block">
              <div class="settings-block-head">USER PROFILE</div>
              <form class="settings-form" data-settings-profile-form>
                <div class="settings-field">
                  <label>DISPLAY NAME</label>
                  <input type="text" name="displayName" data-profile-field />
                </div>
                <div class="settings-field">
                  <label>PREFERRED NAME (how the agent addresses you)</label>
                  <input type="text" name="preferredName" data-profile-field />
                </div>
                <div class="settings-field">
                  <label>ROLE</label>
                  <input type="text" name="role" data-profile-field />
                </div>
                <div class="settings-grid-2">
                  <div class="settings-field">
                    <label>TIMEZONE</label>
                    <input type="text" name="timezone" data-profile-field placeholder="America/Los_Angeles" />
                  </div>
                  <div class="settings-field">
                    <label>URGENCY TOLERANCE</label>
                    <select name="urgencyTolerance" data-profile-field>
                      <option value="low">low — notify sparingly</option>
                      <option value="normal">normal</option>
                      <option value="high">high — frequent updates ok</option>
                    </select>
                  </div>
                </div>
                <div class="settings-grid-2">
                  <div class="settings-field">
                    <label>TONE</label>
                    <select name="communicationTone" data-profile-field>
                      <option value="terse">terse</option>
                      <option value="balanced">balanced</option>
                      <option value="verbose">verbose</option>
                    </select>
                  </div>
                  <div class="settings-field">
                    <label>FORMALITY</label>
                    <select name="formality" data-profile-field>
                      <option value="casual">casual</option>
                      <option value="professional">professional</option>
                      <option value="formal">formal</option>
                    </select>
                  </div>
                </div>
                <div class="settings-grid-2">
                  <div class="settings-field">
                    <label>WORKING HOURS START</label>
                    <input type="text" name="workingHoursStart" data-profile-field placeholder="9:00" />
                  </div>
                  <div class="settings-field">
                    <label>WORKING HOURS END</label>
                    <input type="text" name="workingHoursEnd" data-profile-field placeholder="18:00" />
                  </div>
                </div>
                <div class="settings-field">
                  <label>NOTES (free-form context the agent should know)</label>
                  <textarea name="notes" data-profile-field rows="3"></textarea>
                </div>
                <button type="submit" class="settings-save">SAVE PROFILE ✎</button>
              </form>
            </div>

            <div class="settings-block">
              <div class="settings-block-head">AUTH</div>
              <div class="settings-info" data-settings-auth>—</div>
            </div>
          </div>

          <div class="settings-col">
            <div class="settings-block">
              <div class="settings-block-head">PROACTIVITY POLICY</div>
              <form class="settings-form" data-settings-policy-form>
                <div class="settings-field">
                  <label>ENABLED · the master switch for proactive work</label>
                  <div class="settings-row">
                    <label class="check-pill">
                      <input type="checkbox" name="enabled" data-policy-field />
                      <span>Proactive loops on</span>
                    </label>
                  </div>
                </div>
                <div class="settings-grid-2">
                  <div class="settings-field">
                    <label>MODE</label>
                    <select name="mode" data-policy-field>
                      <option value="watch">watch — observe + notify only</option>
                      <option value="balanced">balanced</option>
                      <option value="hands_on">hands_on — drive forward</option>
                    </select>
                  </div>
                  <div class="settings-field">
                    <label>CHECK-IN MINUTES</label>
                    <input type="number" name="checkInMinutes" data-policy-field min="1" max="60" />
                  </div>
                </div>
                <div class="settings-grid-2">
                  <div class="settings-field">
                    <label>DEFAULT LONG TASK (MIN)</label>
                    <input type="number" name="defaultLongTaskMinutes" data-policy-field min="5" max="240" />
                  </div>
                  <div class="settings-field">
                    <label>BRIEF CADENCE (MIN)</label>
                    <input type="number" name="briefCadenceMinutes" data-policy-field min="10" max="1440" />
                  </div>
                </div>
                <div class="settings-field">
                  <label>QUIET HOURS</label>
                  <div class="settings-row">
                    <label class="check-pill">
                      <input type="checkbox" name="quietHoursEnabled" data-policy-field />
                      <span>Enabled</span>
                    </label>
                    <input type="text" name="quietHoursStart" data-policy-field placeholder="22:00" style="width:90px;" />
                    <span style="color:var(--fg-3);">→</span>
                    <input type="text" name="quietHoursEnd" data-policy-field placeholder="07:00" style="width:90px;" />
                  </div>
                </div>
                <div class="settings-field">
                  <label>CAPABILITY GATES</label>
                  <div class="settings-row settings-gates">
                    <label class="check-pill">
                      <input type="checkbox" name="allowComputerActions" data-policy-field />
                      <span>Computer</span>
                    </label>
                    <label class="check-pill">
                      <input type="checkbox" name="allowComposioActions" data-policy-field />
                      <span>Composio</span>
                    </label>
                    <label class="check-pill">
                      <input type="checkbox" name="allowDiscordCheckIns" data-policy-field />
                      <span>Discord</span>
                    </label>
                  </div>
                </div>
                <button type="submit" class="settings-save">SAVE POLICY ✎</button>
              </form>
            </div>

            <div class="settings-block">
              <div class="settings-block-head">MEMORY INDEX</div>
              <div class="settings-info" data-settings-memory>—</div>
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

/* ── Workflow Studio ─────────────────────────────────────────── */
.wf-layout {
  display: grid;
  grid-template-columns: 260px 1fr 360px;
  gap: 14px;
  height: 100%;
  overflow: hidden;
}
.wf-list-pane,
.wf-editor,
.wf-chat-pane {
  border: 1px solid var(--line);
  background: var(--bg-2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.wf-list-head,
.wf-chat-head {
  padding: 8px 12px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
}
.wf-chat-title { color: var(--fg); }
.wf-chat-meta { color: var(--accent); font-size: 10px; }
.wf-new-btn {
  background: transparent;
  border: 1px solid var(--accent);
  color: var(--accent);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 3px 8px;
  cursor: pointer;
  transition: background 100ms, color 100ms;
}
.wf-new-btn:hover { background: var(--accent); color: var(--bg-0); }

.wf-list {
  list-style: none;
  margin: 0; padding: 0;
  overflow-y: auto;
  flex: 1;
  font-size: 11px;
}
.wf-list .empty { padding: 18px; color: var(--fg-mute); text-align: center; letter-spacing: 0.1em; }
.wf-list li.wf {
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
  transition: background 100ms;
}
.wf-list li.wf:hover { background: var(--bg-3); }
.wf-list li.wf.selected { background: var(--bg-3); box-shadow: inset 2px 0 0 var(--accent); }
.wf-list li.wf .name {
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
}
.wf-list li.wf .meta {
  color: var(--fg-3);
  font-size: 10px;
  margin-top: 3px;
  display: flex;
  gap: 10px;
}
.wf-list li.wf .pill {
  font-size: 9px;
  letter-spacing: 0.18em;
}
.wf-list li.wf .pill.on { color: var(--accent-2); }
.wf-list li.wf .pill.off { color: var(--fg-mute); }
.wf-list li.wf .pill.cron { color: var(--accent-3); }

/* Editor */
.wf-editor { padding: 0; }
.wf-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 14px;
  color: var(--fg-mute);
  letter-spacing: 0.16em;
  font-size: 10px;
}
.wf-empty-mark { font-size: 40px; color: var(--line-bright); }

.wf-edit-head {
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
}
.wf-edit-head input.wf-name {
  background: transparent;
  border: 0;
  border-bottom: 1px dashed var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  padding: 4px 0;
  outline: none;
  letter-spacing: 0.02em;
  min-width: 280px;
  flex: 1;
}
.wf-edit-head input.wf-name:focus { border-bottom-color: var(--accent); }
.wf-edit-head .status-pill {
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 3px 8px;
  border: 1px solid var(--line);
  color: var(--fg-3);
}
.wf-edit-head .status-pill.on { color: var(--accent-2); border-color: var(--accent-2); }
.wf-edit-head .status-pill.off { color: var(--fg-mute); }

.wf-edit-controls {
  padding: 8px 14px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--line);
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.wf-edit-controls button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 5px 10px;
  cursor: pointer;
  transition: background 100ms, color 100ms, border-color 100ms;
}
.wf-edit-controls button:hover { color: var(--fg); border-color: var(--line-bright); }
.wf-edit-controls .btn-save { color: var(--accent); border-color: var(--accent); }
.wf-edit-controls .btn-save:hover { background: var(--accent); color: var(--bg-0); }
.wf-edit-controls .btn-validate { color: var(--accent-3); border-color: var(--accent-3); }
.wf-edit-controls .btn-validate:hover { background: var(--accent-3); color: var(--bg-0); }
.wf-edit-controls .btn-test { color: var(--accent-warn); border-color: var(--accent-warn); }
.wf-edit-controls .btn-test:hover { background: var(--accent-warn); color: var(--bg-0); }
.wf-edit-controls .btn-run { color: var(--accent-2); border-color: var(--accent-2); }
.wf-edit-controls .btn-run:hover { background: var(--accent-2); color: var(--bg-0); }
.wf-edit-controls .btn-toggle { color: var(--fg-2); }
.wf-edit-controls .btn-delete { color: var(--accent-fail); border-color: var(--accent-fail); margin-left: auto; }
.wf-edit-controls .btn-delete:hover { background: var(--accent-fail); color: var(--bg-0); }

.wf-edit-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  font-size: 11px;
}
.wf-field {
  margin-bottom: 14px;
}
.wf-field label {
  display: block;
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
  margin-bottom: 5px;
}
.wf-field input,
.wf-field textarea,
.wf-field select {
  width: 100%;
  background: var(--bg-1);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  padding: 7px 9px;
  outline: none;
  transition: border-color 120ms;
}
.wf-field input:focus,
.wf-field textarea:focus { border-color: var(--accent); }
.wf-field textarea { resize: vertical; min-height: 60px; }
.wf-field .hint {
  display: block;
  margin-top: 4px;
  font-size: 10px;
  color: var(--fg-mute);
  letter-spacing: 0.06em;
}

.wf-steps { display: flex; flex-direction: column; gap: 8px; }
.wf-step {
  border: 1px solid var(--line);
  background: var(--bg-1);
}
.wf-step-head {
  padding: 6px 10px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--fg-3);
}
.wf-step-head .step-num { color: var(--accent); }
.wf-step-head .step-id-input {
  background: transparent;
  border: 0;
  border-bottom: 1px dashed var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  width: 120px;
  outline: none;
  letter-spacing: 0.06em;
}
.wf-step-head .step-id-input:focus { border-bottom-color: var(--accent); }
.wf-step-head .step-actions { margin-left: auto; display: flex; gap: 4px; }
.wf-step-head .step-actions button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-3);
  font: inherit;
  font-size: 10px;
  padding: 2px 6px;
  cursor: pointer;
}
.wf-step-head .step-actions button:hover { color: var(--fg); border-color: var(--line-bright); }
.wf-step-head .step-actions .step-remove { color: var(--accent-fail); border-color: var(--accent-fail); }

.wf-step-body { padding: 10px; }
.wf-step-body .step-prompt {
  width: 100%;
  background: var(--bg-2);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  padding: 8px 10px;
  outline: none;
  resize: vertical;
  min-height: 60px;
  transition: border-color 120ms;
}
.wf-step-body .step-prompt:focus { border-color: var(--accent); }
.wf-step-body .step-deps {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 10px;
  letter-spacing: 0.12em;
}
.wf-step-body .step-deps-label { color: var(--fg-3); margin-right: 6px; }
.wf-step-body .step-deps .dep-pill {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-3);
  padding: 2px 6px;
  cursor: pointer;
}
.wf-step-body .step-deps .dep-pill.on {
  background: var(--accent-3);
  border-color: var(--accent-3);
  color: var(--bg-0);
}

.wf-add-step {
  margin-top: 8px;
  background: transparent;
  border: 1px dashed var(--line);
  color: var(--fg-3);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 8px;
  width: 100%;
  cursor: pointer;
  transition: color 100ms, border-color 100ms;
}
.wf-add-step:hover { color: var(--accent); border-color: var(--accent); }

.wf-validation {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  background: var(--bg-1);
  font-size: 11px;
}
.wf-validation.ok { border-color: var(--accent-2); }
.wf-validation.err { border-color: var(--accent-fail); }
.wf-validation-head {
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
  margin-bottom: 6px;
}
.wf-validation.ok .wf-validation-head { color: var(--accent-2); }
.wf-validation.err .wf-validation-head { color: var(--accent-fail); }
.wf-validation ul { margin: 0; padding-left: 18px; color: var(--fg-2); }
.wf-validation .warn { color: var(--accent-warn); }
.wf-validation .err  { color: var(--accent-fail); }

/* Architect chat */
.wf-chat-pane { font-size: 12px; }
.wf-chat-log {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wf-chat-intro {
  color: var(--fg-3);
  font-size: 11px;
  line-height: 1.55;
  padding: 6px;
  border: 1px dashed var(--line);
}
.wf-chat-intro em { color: var(--fg-2); font-style: italic; }

.wf-msg {
  border: 1px solid var(--line);
  background: var(--bg-1);
}
.wf-msg-head {
  padding: 4px 9px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
}
.wf-msg-body {
  padding: 9px 10px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
  color: var(--fg);
  line-height: 1.5;
}
.wf-msg.user .wf-msg-head { color: var(--accent-3); }
.wf-msg.assistant .wf-msg-head { color: var(--accent); }
.wf-msg.error .wf-msg-head { color: var(--accent-fail); }
.wf-msg.thinking .wf-msg-body {
  color: var(--fg-mute);
  font-style: italic;
}

.wf-chat-form {
  border-top: 1px solid var(--line);
  background: var(--bg-1);
  padding: 8px;
  display: flex;
  gap: 6px;
  align-items: flex-end;
}
.wf-chat-input {
  flex: 1;
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  padding: 6px 8px;
  resize: none;
  outline: none;
  transition: border-color 120ms;
}
.wf-chat-input:focus { border-color: var(--accent); }
.wf-chat-send {
  background: var(--accent);
  border: 0;
  color: var(--bg-0);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.18em;
  padding: 7px 12px;
  cursor: pointer;
  align-self: stretch;
  font-weight: 600;
}
.wf-chat-send:disabled {
  background: var(--bg-3);
  color: var(--fg-mute);
  cursor: wait;
}

/* ── Tools panel ─────────────────────────────────────────────── */
.tools-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 14px;
  height: 100%;
  overflow: hidden;
}
.tools-side {
  border: 1px solid var(--line);
  background: var(--bg-2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tools-filter {
  padding: 10px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tools-search {
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  padding: 6px 8px;
  outline: none;
}
.tools-search:focus { border-color: var(--accent); }
.tools-count {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--fg-3);
}
.tools-count em { font-style: normal; color: var(--fg); }
.tools-categories {
  padding: 8px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.cat-pill {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.14em;
  padding: 6px 8px;
  text-align: left;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  transition: background 100ms, color 100ms, border-color 100ms;
}
.cat-pill:hover { color: var(--fg); border-color: var(--line-bright); }
.cat-pill.active {
  background: var(--accent);
  color: var(--bg-0);
  border-color: var(--accent);
}
.cat-pill .cat-count {
  font-size: 9px;
  letter-spacing: 0.12em;
  opacity: 0.7;
}

.tools-main {
  border: 1px solid var(--line);
  background: var(--bg-2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tools-section {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--line);
  min-height: 0;
}
.tools-section:last-child { border-bottom: 0; }
.tools-section-head {
  padding: 8px 14px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
}
.tools-section-head em { font-style: normal; color: var(--fg); }

.tools-grid,
.mcp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 8px;
  padding: 12px;
  overflow-y: auto;
  flex: 1;
  font-size: 11px;
}
.tools-empty { color: var(--fg-mute); padding: 14px; letter-spacing: 0.12em; }

.tool-card {
  border: 1px solid var(--line);
  background: var(--bg-1);
  padding: 8px 10px;
  transition: border-color 100ms, background 100ms;
}
.tool-card:hover { border-color: var(--line-bright); background: var(--bg-3); }
.tool-card .tool-name {
  color: var(--fg);
  font-size: 11px;
  word-break: break-word;
}
.tool-card .tool-meta {
  margin-top: 4px;
  display: flex;
  gap: 6px;
  font-size: 9px;
  letter-spacing: 0.14em;
  color: var(--fg-3);
}
.tool-card .tool-cat { color: var(--accent); }
.tool-card .tool-src { color: var(--accent-3); }
.tool-card .tool-src.mcp { color: var(--accent-warn); }
.tool-card .tool-approval { color: var(--accent-fail); }
.tool-card .tool-desc {
  margin-top: 6px;
  color: var(--fg-2);
  font-size: 11px;
  line-height: 1.45;
}

.mcp-card {
  border: 1px solid var(--line);
  background: var(--bg-1);
  padding: 10px 12px;
}
.mcp-card .mcp-name {
  color: var(--fg);
  font-size: 12px;
}
.mcp-card .mcp-meta {
  margin-top: 4px;
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--fg-3);
}
.mcp-card .mcp-meta em { color: var(--accent-2); font-style: normal; }
.mcp-card .mcp-meta .off { color: var(--fg-mute); }
.mcp-card .mcp-desc {
  margin-top: 6px;
  font-size: 11px;
  color: var(--fg-2);
}
.mcp-card .mcp-cmd {
  margin-top: 4px;
  font-size: 10px;
  color: var(--fg-mute);
  word-break: break-all;
}

/* ── Projects panel ──────────────────────────────────────────── */
.projects-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 14px;
  height: 100%;
  overflow: hidden;
}
.proj-side {
  border: 1px solid var(--line);
  background: var(--bg-2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.proj-side-head {
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
.proj-side-head em { font-style: normal; color: var(--fg); }
.proj-ws-list,
.proj-list {
  list-style: none;
  margin: 0; padding: 0;
  overflow-y: auto;
  font-size: 11px;
  max-height: 240px;
}
.proj-list { flex: 1; max-height: none; }
.proj-ws-list li,
.proj-list li {
  padding: 7px 12px;
  border-bottom: 1px solid var(--line);
}
.proj-ws-list li { color: var(--fg-2); font-size: 10px; word-break: break-all; letter-spacing: 0.04em; }
.proj-list li.proj {
  cursor: pointer;
  transition: background 100ms;
}
.proj-list li.proj:hover { background: var(--bg-3); }
.proj-list li.proj.selected { background: var(--bg-3); box-shadow: inset 2px 0 0 var(--accent); }
.proj-list li.proj .pname {
  color: var(--fg);
  display: block;
}
.proj-list li.proj .ppath {
  display: block;
  margin-top: 2px;
  color: var(--fg-mute);
  font-size: 9px;
  word-break: break-all;
}
.proj-list .empty,
.proj-ws-list .empty {
  padding: 14px; color: var(--fg-mute); letter-spacing: 0.12em; text-align: center;
}

.proj-detail {
  border: 1px solid var(--line);
  background: var(--bg-2);
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 11px;
}
.proj-block {
  border: 1px solid var(--line);
  background: var(--bg-1);
}
.proj-block-head {
  padding: 6px 12px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
  display: flex;
  justify-content: space-between;
}
.proj-block-head em { font-style: normal; color: var(--accent); }
.proj-block-body {
  padding: 10px 12px;
}
.proj-block-body pre {
  margin: 0;
  font: 11px/1.5 var(--mono);
  color: var(--fg);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}
.proj-pkg-grid {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 4px 12px;
  font-size: 11px;
}
.proj-pkg-grid dt {
  color: var(--fg-3);
  letter-spacing: 0.1em;
  font-size: 10px;
  text-transform: uppercase;
}
.proj-pkg-grid dd { margin: 0; color: var(--fg); }
.proj-entries {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 4px;
  font-size: 10px;
  letter-spacing: 0.04em;
}
.proj-entries .entry {
  padding: 3px 6px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  color: var(--fg-2);
}
.proj-entries .entry.dir { color: var(--accent-3); }

/* ── Skills panel ────────────────────────────────────────────── */
.skills-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 14px;
  overflow: hidden;
}
.skills-header {
  display: grid;
  grid-template-columns: 1fr 260px;
  gap: 14px;
}
.skills-intro {
  border: 1px solid var(--line);
  background: var(--bg-2);
  padding: 14px 16px;
  font-size: 12px;
  color: var(--fg-2);
  line-height: 1.5;
}
.skills-intro h3 {
  margin: 0 0 6px;
  color: var(--fg);
  font-size: 11px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.skills-intro p { margin: 0; }
.skills-intro code {
  background: var(--bg-0);
  border: 1px solid var(--line);
  padding: 1px 6px;
  color: var(--accent);
  font-size: 11px;
}
.skills-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
  border: 1px solid var(--line);
  background: var(--bg-2);
}
.stat-card {
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
}
.stat-card:first-child { border-right: 1px solid var(--line); }
.stat-card em {
  font-style: normal;
  font-size: 28px;
  color: var(--accent);
  letter-spacing: 0;
}

.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
  overflow-y: auto;
  flex: 1;
}
.skill-card {
  border: 1px solid var(--line);
  background: var(--bg-2);
  display: flex;
  flex-direction: column;
}
.skill-card .skill-head {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
}
.skill-card .skill-name {
  color: var(--fg);
  font-size: 12px;
  letter-spacing: 0.02em;
}
.skill-card .skill-version {
  color: var(--accent);
  font-size: 10px;
  letter-spacing: 0.14em;
  margin-left: 6px;
}
.skill-card .skill-desc {
  padding: 10px 12px;
  color: var(--fg-2);
  font-size: 11px;
  line-height: 1.5;
}
.skill-card .skill-tools-head {
  padding: 6px 12px;
  background: var(--bg-1);
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
  display: flex;
  justify-content: space-between;
}
.skill-card .skill-tools-head em { font-style: normal; color: var(--fg); }
.skill-card .skill-tools {
  padding: 8px 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.skill-card .skill-tool-pill {
  font-size: 10px;
  letter-spacing: 0.06em;
  background: var(--bg-1);
  border: 1px solid var(--line);
  padding: 2px 6px;
  color: var(--fg-2);
}

/* ── Settings panel ──────────────────────────────────────────── */
.settings-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  height: 100%;
  overflow: hidden;
}
.settings-col {
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
}
.settings-block {
  border: 1px solid var(--line);
  background: var(--bg-2);
}
.settings-block-head {
  padding: 8px 14px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--line);
  font-size: 10px;
  letter-spacing: 0.2em;
  color: var(--fg-3);
}
.settings-form { padding: 14px 16px; }
.settings-field { margin-bottom: 12px; }
.settings-field:last-child { margin-bottom: 0; }
.settings-field label {
  display: block;
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--fg-3);
  margin-bottom: 5px;
}
.settings-field input[type="text"],
.settings-field input[type="number"],
.settings-field select,
.settings-field textarea {
  width: 100%;
  background: var(--bg-1);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  padding: 6px 8px;
  outline: none;
  transition: border-color 120ms;
}
.settings-field input[type="text"]:focus,
.settings-field input[type="number"]:focus,
.settings-field select:focus,
.settings-field textarea:focus { border-color: var(--accent); }
.settings-field textarea { resize: vertical; }
.settings-grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}
.settings-grid-2 .settings-field { margin-bottom: 0; }
.settings-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.check-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--fg-2);
  padding: 5px 10px;
  border: 1px solid var(--line);
  cursor: pointer;
  user-select: none;
  background: var(--bg-1);
  transition: border-color 100ms;
}
.check-pill:hover { border-color: var(--line-bright); }
.check-pill input { accent-color: var(--accent); }
.settings-gates .check-pill { font-size: 10px; letter-spacing: 0.1em; }

.settings-save {
  background: var(--accent);
  border: 0;
  color: var(--bg-0);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.18em;
  padding: 8px 16px;
  cursor: pointer;
  font-weight: 600;
  margin-top: 4px;
  transition: background 100ms;
}
.settings-save:hover { background: var(--accent-2); color: var(--bg-0); }
.settings-save:disabled { background: var(--bg-3); color: var(--fg-mute); cursor: wait; }

.settings-info {
  padding: 14px 16px;
  font-size: 11px;
  color: var(--fg-2);
  line-height: 1.6;
}
.settings-info .row {
  display: flex;
  justify-content: space-between;
  border-bottom: 1px dashed var(--line);
  padding: 4px 0;
}
.settings-info .row:last-child { border-bottom: 0; }
.settings-info .row .k {
  color: var(--fg-3);
  font-size: 10px;
  letter-spacing: 0.14em;
}
.settings-info .row .v { color: var(--fg); }
.settings-info .row .v.on { color: var(--accent-2); }
.settings-info .row .v.off { color: var(--fg-mute); }

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
  let workflowsBooted = false;
  let toolsBooted = false;
  let projectsBooted = false;
  let skillsBooted = false;
  let settingsBooted = false;

  function switchPanel(name) {
    panelSections.forEach((s) => {
      const match = s.getAttribute('data-section') === name;
      if (match) s.removeAttribute('hidden');
      else s.setAttribute('hidden', '');
    });
    navButtons.forEach((b) => b.classList.toggle('active', b.getAttribute('data-panel') === name));
    if (name === 'memory') {
      if (!memoryBooted) { memoryBooted = true; bootMemoryPanel(); }
      else refreshMemoryPanel();
    } else if (name === 'workflows') {
      if (!workflowsBooted) { workflowsBooted = true; bootWorkflowsPanel(); }
      else refreshWorkflowList();
    } else if (name === 'tools') {
      if (!toolsBooted) { toolsBooted = true; bootToolsPanel(); }
    } else if (name === 'projects') {
      if (!projectsBooted) { projectsBooted = true; bootProjectsPanel(); }
    } else if (name === 'skills') {
      if (!skillsBooted) { skillsBooted = true; bootSkillsPanel(); }
    } else if (name === 'settings') {
      if (!settingsBooted) { settingsBooted = true; bootSettingsPanel(); }
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

  // ─── Workflow Studio ──────────────────────────────────────────

  const wf = {
    list:      document.querySelector('[data-wf-list]'),
    editor:    document.querySelector('[data-wf-editor]'),
    newBtn:    document.querySelector('[data-wf-new]'),
    chatLog:   document.querySelector('[data-wf-chat-log]'),
    chatForm:  document.querySelector('[data-wf-chat-form]'),
    chatInput: document.querySelector('[data-wf-chat-input]'),
    chatSend:  document.querySelector('[data-wf-chat-send]'),
    chatMeta:  document.querySelector('[data-wf-chat-meta]'),
  };

  /** Local draft state — what the editor shows; not yet saved unless
   *  the user hits SAVE. New workflows live here before the first POST. */
  let wfDraft = null;
  let wfSelectedName = null;
  let wfIsNew = false;
  let wfChatHistory = [];
  let wfChatBusy = false;

  async function bootWorkflowsPanel() { await refreshWorkflowList(); }

  async function refreshWorkflowList() {
    try {
      const data = await fetchJSON('/api/console/workflows');
      const items = data.workflows || [];
      if (items.length === 0) {
        wf.list.innerHTML = '<li class="empty">— no workflows — ＋ NEW to start —</li>';
        return;
      }
      wf.list.innerHTML = items.map((w) => {
        const cls = (wfSelectedName === w.name) ? 'wf selected' : 'wf';
        const enabledPill = w.enabled ? '<span class="pill on">● APPROVED</span>' : '<span class="pill off">○ DISABLED</span>';
        const cronPill = w.triggerSchedule ? '<span class="pill cron">⏱ ' + escMem(w.triggerSchedule) + '</span>' : '';
        return [
          '<li class="' + cls + '" data-wf-name="' + escMem(w.name) + '">',
          '  <span class="name">' + escMem(w.name) + '</span>',
          '  <span class="meta">' + enabledPill + cronPill + '<span class="pill">' + w.stepCount + ' steps</span></span>',
          '</li>',
        ].join('');
      }).join('');
      Array.from(wf.list.querySelectorAll('li.wf')).forEach((li) => {
        li.addEventListener('click', () => {
          const name = li.getAttribute('data-wf-name');
          wfSelectedName = name;
          wfIsNew = false;
          Array.from(wf.list.querySelectorAll('li.wf')).forEach((el) => el.classList.toggle('selected', el === li));
          loadWorkflow(name);
        });
      });
    } catch (err) {
      wf.list.innerHTML = '<li class="empty">— failed: ' + escMem(err.message || err) + ' —</li>';
    }
  }

  async function loadWorkflow(name) {
    try {
      const data = await fetchJSON('/api/console/workflows/' + encodeURIComponent(name));
      wfDraft = {
        name: data.name,
        description: data.description || '',
        enabled: data.enabled !== false,
        triggerSchedule: data.trigger && data.trigger.schedule ? data.trigger.schedule : '',
        steps: Array.isArray(data.steps) ? data.steps.map((s) => ({ id: s.id, prompt: s.prompt, dependsOn: s.dependsOn || [], model: s.model })) : [],
        inputs: data.inputs || {},
        synthesisPrompt: data.synthesis && data.synthesis.prompt ? data.synthesis.prompt : '',
      };
      wfChatHistory = [];
      renderEditor();
    } catch (err) {
      wf.editor.innerHTML = '<div class="wf-empty"><div class="wf-empty-mark">!</div><div class="wf-empty-text">' + escMem(err.message || err) + '</div></div>';
    }
  }

  function startNewWorkflow() {
    wfSelectedName = null;
    wfIsNew = true;
    wfDraft = {
      name: 'new-workflow',
      description: '',
      enabled: false,
      triggerSchedule: '',
      steps: [{ id: 'step-1', prompt: '', dependsOn: [] }],
      inputs: {},
      synthesisPrompt: '',
    };
    wfChatHistory = [];
    Array.from(wf.list.querySelectorAll('li.wf')).forEach((el) => el.classList.remove('selected'));
    renderEditor();
  }
  wf.newBtn.addEventListener('click', startNewWorkflow);

  function renderEditor() {
    if (!wfDraft) {
      wf.editor.innerHTML = '<div class="wf-empty"><div class="wf-empty-mark">⊟</div><div class="wf-empty-text">SELECT A WORKFLOW OR ＋NEW</div></div>';
      return;
    }
    const d = wfDraft;
    const stepIds = d.steps.map((s) => s.id);
    const head = [
      '<div class="wf-edit-head">',
      '  <input class="wf-name" data-wf-field="name" type="text" value="' + escMem(d.name) + '" spellcheck="false" />',
      '  <span class="status-pill ' + (d.enabled ? 'on' : 'off') + '">' + (d.enabled ? '● APPROVED' : '○ DRAFT') + '</span>',
      '</div>',
    ].join('');
    const controls = [
      '<div class="wf-edit-controls">',
      '  <button class="btn-save" data-wf-action="save">' + (wfIsNew ? 'CREATE' : 'SAVE') + ' ✎</button>',
      wfIsNew ? '' : '  <button class="btn-validate" data-wf-action="validate">VALIDATE ✓</button>',
      wfIsNew ? '' : '  <button class="btn-test" data-wf-action="test">DRY-RUN ⌗</button>',
      wfIsNew ? '' : '  <button class="btn-run" data-wf-action="run">RUN ▶</button>',
      wfIsNew ? '' : '  <button class="btn-toggle" data-wf-action="toggle">' + (d.enabled ? '○ DISABLE' : '● APPROVE') + '</button>',
      wfIsNew ? '' : '  <button class="btn-delete" data-wf-action="delete">DELETE ▣</button>',
      '</div>',
    ].join('');

    const body = [
      '<div class="wf-edit-body">',

      '  <div class="wf-field">',
      '    <label>DESCRIPTION</label>',
      '    <textarea data-wf-field="description" rows="2" spellcheck="false">' + escMem(d.description) + '</textarea>',
      '    <span class="hint">A clear description helps the agent pick the right workflow.</span>',
      '  </div>',

      '  <div class="wf-field">',
      '    <label>TRIGGER (cron expression — blank = manual only)</label>',
      '    <input type="text" data-wf-field="triggerSchedule" value="' + escMem(d.triggerSchedule) + '" spellcheck="false" placeholder="0 9 * * 1-5" />',
      '    <span class="hint">Five-field cron. Examples: <code>0 9 * * 1-5</code> (weekdays 9am), <code>*/15 * * * *</code> (every 15m).</span>',
      '  </div>',

      '  <div class="wf-field">',
      '    <label>STEPS · ' + d.steps.length + '</label>',
      '    <div class="wf-steps" data-wf-steps>',
           d.steps.map((s, i) => renderStep(s, i, stepIds)).join(''),
      '    </div>',
      '    <button class="wf-add-step" data-wf-action="add-step">＋ ADD STEP</button>',
      '  </div>',

      '  <div class="wf-field">',
      '    <label>SYNTHESIS (optional final prompt that combines step outputs)</label>',
      '    <textarea data-wf-field="synthesisPrompt" rows="3" spellcheck="false" placeholder="Summarize the prior step outputs as a single concise update.">' + escMem(d.synthesisPrompt) + '</textarea>',
      '  </div>',

      '  <div data-wf-validation></div>',

      '</div>',
    ].join('');

    wf.editor.innerHTML = head + controls + body;
    bindEditorEvents();
  }

  function renderStep(step, index, allStepIds) {
    const deps = step.dependsOn || [];
    const depPills = allStepIds
      .filter((id) => id !== step.id)
      .map((id) => '<button type="button" class="dep-pill ' + (deps.includes(id) ? 'on' : '') + '" data-wf-dep="' + escMem(id) + '" data-wf-step-id="' + escMem(step.id) + '">' + escMem(id) + '</button>')
      .join('');
    return [
      '<div class="wf-step" data-wf-step-index="' + index + '">',
      '  <div class="wf-step-head">',
      '    <span class="step-num">#' + (index + 1) + '</span>',
      '    <input class="step-id-input" type="text" value="' + escMem(step.id) + '" data-wf-step-field="id" data-wf-step-index="' + index + '" spellcheck="false" />',
      '    <div class="step-actions">',
      '      <button type="button" data-wf-action="step-up" data-wf-step-index="' + index + '">↑</button>',
      '      <button type="button" data-wf-action="step-down" data-wf-step-index="' + index + '">↓</button>',
      '      <button type="button" class="step-remove" data-wf-action="step-remove" data-wf-step-index="' + index + '">REMOVE</button>',
      '    </div>',
      '  </div>',
      '  <div class="wf-step-body">',
      '    <textarea class="step-prompt" rows="3" data-wf-step-field="prompt" data-wf-step-index="' + index + '" placeholder="What this step should do, ideally referencing any tools it should call (e.g. memory_recall, notify_user).">' + escMem(step.prompt || '') + '</textarea>',
      depPills ? '    <div class="step-deps"><span class="step-deps-label">DEPENDS ON ⇢</span>' + depPills + '</div>' : '    <div class="step-deps"><span class="step-deps-label">DEPENDS ON ⇢</span><span style="color:var(--fg-mute);">(no other steps to depend on)</span></div>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function bindEditorEvents() {
    // Field bindings — every input mutates wfDraft in place.
    wf.editor.querySelectorAll('[data-wf-field]').forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.getAttribute('data-wf-field');
        wfDraft[key] = input.value;
      });
    });
    wf.editor.querySelectorAll('[data-wf-step-field]').forEach((input) => {
      input.addEventListener('input', () => {
        const idx = parseInt(input.getAttribute('data-wf-step-index'), 10);
        const field = input.getAttribute('data-wf-step-field');
        if (Number.isFinite(idx) && wfDraft.steps[idx]) {
          wfDraft.steps[idx][field] = input.value;
        }
      });
    });
    // Dependency pill toggles
    wf.editor.querySelectorAll('.dep-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const stepId = pill.getAttribute('data-wf-step-id');
        const depId = pill.getAttribute('data-wf-dep');
        const step = wfDraft.steps.find((s) => s.id === stepId);
        if (!step) return;
        const has = (step.dependsOn || []).includes(depId);
        if (has) step.dependsOn = step.dependsOn.filter((d) => d !== depId);
        else step.dependsOn = [...(step.dependsOn || []), depId];
        pill.classList.toggle('on');
      });
    });

    // Action buttons
    wf.editor.querySelectorAll('[data-wf-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const action = btn.getAttribute('data-wf-action');
        const idx = parseInt(btn.getAttribute('data-wf-step-index') || '-1', 10);
        if (action === 'save') return saveWorkflow();
        if (action === 'validate') return validateWorkflow();
        if (action === 'test') return runWorkflow(true);
        if (action === 'run') return runWorkflow(false);
        if (action === 'toggle') return toggleEnabled();
        if (action === 'delete') return deleteWorkflow();
        if (action === 'add-step') {
          const nextId = 'step-' + (wfDraft.steps.length + 1);
          wfDraft.steps.push({ id: nextId, prompt: '', dependsOn: [] });
          renderEditor();
          return;
        }
        if (action === 'step-remove' && Number.isFinite(idx)) {
          wfDraft.steps.splice(idx, 1);
          renderEditor();
          return;
        }
        if (action === 'step-up' && idx > 0) {
          const [moved] = wfDraft.steps.splice(idx, 1);
          wfDraft.steps.splice(idx - 1, 0, moved);
          renderEditor();
          return;
        }
        if (action === 'step-down' && idx >= 0 && idx < wfDraft.steps.length - 1) {
          const [moved] = wfDraft.steps.splice(idx, 1);
          wfDraft.steps.splice(idx + 1, 0, moved);
          renderEditor();
          return;
        }
      });
    });
  }

  async function saveWorkflow() {
    if (!wfDraft) return;
    try {
      if (wfIsNew) {
        const r = await fetch(withToken('/api/console/workflows'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: wfDraft.name,
            description: wfDraft.description,
            enabled: wfDraft.enabled,
            triggerSchedule: wfDraft.triggerSchedule || undefined,
            steps: wfDraft.steps,
            synthesisPrompt: wfDraft.synthesisPrompt || undefined,
            inputs: wfDraft.inputs,
          }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          renderValidation({ ok: false, errors: [j.error || ('HTTP ' + r.status)], warnings: [], stepCount: 0, hasCycles: false });
          return;
        }
        wfIsNew = false;
        wfSelectedName = wfDraft.name;
      } else {
        const r = await fetch(withToken('/api/console/workflows/' + encodeURIComponent(wfSelectedName)), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: wfDraft.description,
            triggerSchedule: wfDraft.triggerSchedule || undefined,
            clearTriggerSchedule: !wfDraft.triggerSchedule,
            steps: wfDraft.steps,
            synthesisPrompt: wfDraft.synthesisPrompt,
            inputs: wfDraft.inputs,
          }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          renderValidation({ ok: false, errors: [j.error || ('HTTP ' + r.status)], warnings: [], stepCount: 0, hasCycles: false });
          return;
        }
      }
      renderValidation({ ok: true, errors: [], warnings: [], stepCount: wfDraft.steps.length, hasCycles: false }, 'SAVED');
      refreshWorkflowList();
    } catch (err) {
      renderValidation({ ok: false, errors: [err.message || String(err)], warnings: [], stepCount: 0, hasCycles: false });
    }
  }

  async function validateWorkflow() {
    if (!wfSelectedName) return;
    try {
      const r = await fetch(withToken('/api/console/workflows/' + encodeURIComponent(wfSelectedName) + '/validate'), { method: 'POST' });
      const v = await r.json();
      renderValidation(v);
    } catch (err) {
      renderValidation({ ok: false, errors: [err.message || String(err)], warnings: [], stepCount: 0, hasCycles: false });
    }
  }

  async function runWorkflow(dryRun) {
    if (!wfSelectedName) return;
    try {
      const r = await fetch(withToken('/api/console/workflows/' + encodeURIComponent(wfSelectedName) + '/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun, inputs: {} }),
      });
      const j = await r.json();
      if (!r.ok) {
        renderValidation({ ok: false, errors: [j.error || ('HTTP ' + r.status)], warnings: [], stepCount: 0, hasCycles: false });
        return;
      }
      renderValidation({ ok: true, errors: [], warnings: [], stepCount: 0, hasCycles: false }, dryRun ? ('DRY-RUN QUEUED · ' + j.id) : ('QUEUED · ' + j.id));
    } catch (err) {
      renderValidation({ ok: false, errors: [err.message || String(err)], warnings: [], stepCount: 0, hasCycles: false });
    }
  }

  async function toggleEnabled() {
    if (!wfSelectedName) return;
    const next = !wfDraft.enabled;
    try {
      const r = await fetch(withToken('/api/console/workflows/' + encodeURIComponent(wfSelectedName) + '/set-enabled'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        renderValidation({ ok: false, errors: [j.error || ('HTTP ' + r.status)], warnings: [], stepCount: 0, hasCycles: false });
        return;
      }
      wfDraft.enabled = next;
      renderEditor();
      refreshWorkflowList();
    } catch (err) {
      renderValidation({ ok: false, errors: [err.message || String(err)], warnings: [], stepCount: 0, hasCycles: false });
    }
  }

  async function deleteWorkflow() {
    if (!wfSelectedName) return;
    if (!confirm('Permanently delete workflow "' + wfSelectedName + '"?')) return;
    try {
      const r = await fetch(withToken('/api/console/workflows/' + encodeURIComponent(wfSelectedName)), { method: 'DELETE' });
      if (!r.ok) return;
      wfDraft = null;
      wfSelectedName = null;
      renderEditor();
      refreshWorkflowList();
    } catch (_) {}
  }

  function renderValidation(v, customLabel) {
    const target = wf.editor.querySelector('[data-wf-validation]');
    if (!target) return;
    const cls = v.ok ? 'ok' : 'err';
    const headLabel = customLabel || (v.ok ? '✓ VALID · ' + (v.stepCount || 0) + ' STEPS' : '✗ ' + v.errors.length + ' ERROR' + (v.errors.length === 1 ? '' : 'S'));
    const items = [];
    v.errors.forEach((e) => items.push('<li class="err">' + escMem(e) + '</li>'));
    v.warnings.forEach((w) => items.push('<li class="warn">⚠ ' + escMem(w) + '</li>'));
    target.innerHTML = [
      '<div class="wf-validation ' + cls + '">',
      '  <div class="wf-validation-head">' + headLabel + '</div>',
      items.length > 0 ? '  <ul>' + items.join('') + '</ul>' : '  <div style="color:var(--fg-mute);font-size:11px;">No issues.</div>',
      '</div>',
    ].join('');
  }

  // ─── Architect chat ───────────────────────────────────────────

  function appendChatMessage(role, text) {
    if (!wf.chatLog) return;
    const intro = wf.chatLog.querySelector('.wf-chat-intro');
    if (intro) intro.remove();
    const div = document.createElement('div');
    div.className = 'wf-msg ' + role;
    div.innerHTML = '<div class="wf-msg-head">' + role.toUpperCase() + '</div><div class="wf-msg-body">' + escMem(text) + '</div>';
    wf.chatLog.appendChild(div);
    wf.chatLog.scrollTop = wf.chatLog.scrollHeight;
    return div;
  }

  wf.chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (wfChatBusy) return;
    const msg = wf.chatInput.value.trim();
    if (!msg) return;
    appendChatMessage('user', msg);
    wfChatHistory.push({ role: 'user', text: msg });
    wf.chatInput.value = '';
    wfChatBusy = true;
    wf.chatSend.disabled = true;
    wf.chatMeta.textContent = 'thinking…';
    const thinkingNode = appendChatMessage('thinking', '…');
    try {
      const r = await fetch(withToken('/api/console/workflows/architect/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msg,
          draft: wfDraft,
          draftName: wfDraft ? wfDraft.name : null,
          history: wfChatHistory.slice(0, -1),
        }),
      });
      const j = await r.json();
      if (thinkingNode) thinkingNode.remove();
      if (!r.ok) {
        appendChatMessage('error', j.error || ('HTTP ' + r.status));
      } else {
        appendChatMessage('assistant', j.text || '(no reply)');
        wfChatHistory.push({ role: 'assistant', text: j.text || '' });
      }
    } catch (err) {
      if (thinkingNode) thinkingNode.remove();
      appendChatMessage('error', err.message || String(err));
    } finally {
      wfChatBusy = false;
      wf.chatSend.disabled = false;
      wf.chatMeta.textContent = 'idle';
    }
  });

  // Enter sends; Shift+Enter inserts newline.
  wf.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      wf.chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });

  // ─── Tools panel ──────────────────────────────────────────────

  const tools = {
    search:     document.querySelector('[data-tools-search]'),
    count:      document.querySelector('[data-tools-count]'),
    categories: document.querySelector('[data-tools-categories]'),
    grid:       document.querySelector('[data-tools-grid]'),
    shown:      document.querySelector('[data-tools-shown]'),
    mcpGrid:    document.querySelector('[data-mcp-grid]'),
    mcpCount:   document.querySelector('[data-mcp-count]'),
  };
  let toolsData = null;
  let toolsActiveCategory = '';

  async function bootToolsPanel() {
    try {
      toolsData = await fetchJSON('/api/console/tools');
      renderToolsCategories();
      renderToolsGrid();
      renderMcpGrid();
    } catch (err) {
      tools.grid.innerHTML = '<div class="tools-empty">— failed: ' + escMem(err.message || err) + ' —</div>';
    }
  }

  function renderToolsCategories() {
    const counts = new Map();
    toolsData.tools.forEach((t) => counts.set(t.category, (counts.get(t.category) || 0) + 1));
    const total = toolsData.tools.length;
    const cats = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const pills = [
      '<button class="cat-pill ' + (toolsActiveCategory === '' ? 'active' : '') + '" data-cat="">'
        + '<span>ALL</span><span class="cat-count">' + total + '</span></button>',
    ].concat(cats.map(([c, n]) =>
      '<button class="cat-pill ' + (toolsActiveCategory === c ? 'active' : '') + '" data-cat="' + escMem(c) + '">'
        + '<span>' + escMem(c).toUpperCase() + '</span><span class="cat-count">' + n + '</span></button>',
    ));
    tools.categories.innerHTML = pills.join('');
    tools.count.innerHTML = 'TOTAL · <em>' + total + '</em>';
    Array.from(tools.categories.querySelectorAll('.cat-pill')).forEach((p) => {
      p.addEventListener('click', () => {
        toolsActiveCategory = p.getAttribute('data-cat') || '';
        Array.from(tools.categories.querySelectorAll('.cat-pill')).forEach((el) => el.classList.toggle('active', el === p));
        renderToolsGrid();
      });
    });
  }

  function renderToolsGrid() {
    if (!toolsData) return;
    const q = (tools.search.value || '').trim().toLowerCase();
    const filtered = toolsData.tools.filter((t) =>
      (toolsActiveCategory === '' || t.category === toolsActiveCategory) &&
      (q === '' || t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q) || t.category.toLowerCase().includes(q)),
    );
    tools.shown.textContent = filtered.length + ' shown';
    if (filtered.length === 0) {
      tools.grid.innerHTML = '<div class="tools-empty">— no tools match the filter —</div>';
      return;
    }
    tools.grid.innerHTML = filtered.map((t) => [
      '<div class="tool-card">',
      '  <div class="tool-name">' + escMem(t.name) + '</div>',
      '  <div class="tool-meta">',
      '    <span class="tool-cat">' + escMem(t.category).toUpperCase() + '</span>',
      '    <span class="tool-src ' + escMem(t.source) + '">' + escMem(t.source).toUpperCase() + '</span>',
      t.needsApproval ? '    <span class="tool-approval">APPROVAL</span>' : '',
      '  </div>',
      t.description ? '  <div class="tool-desc">' + escMem(t.description) + '</div>' : '',
      '</div>',
    ].join('')).join('');
  }

  function renderMcpGrid() {
    if (!toolsData) return;
    const list = toolsData.mcpServers || [];
    tools.mcpCount.textContent = list.length;
    if (list.length === 0) {
      tools.mcpGrid.innerHTML = '<div class="tools-empty">— no MCP servers discovered. Add one to your Claude Desktop / Code config to expose more tools. —</div>';
      return;
    }
    tools.mcpGrid.innerHTML = list.map((s) => [
      '<div class="mcp-card">',
      '  <div class="mcp-name">' + escMem(s.name) + '</div>',
      '  <div class="mcp-meta">',
      '    <em>' + (s.enabled ? '● ENABLED' : '<span class="off">○ DISABLED</span>') + '</em>',
      '    · ' + escMem(s.transport || 'stdio').toUpperCase(),
      '    · ' + escMem(s.source || 'config'),
      '  </div>',
      s.description ? '  <div class="mcp-desc">' + escMem(s.description) + '</div>' : '',
      s.command ? '  <div class="mcp-cmd">$ ' + escMem(s.command) + '</div>' : '',
      s.url ? '  <div class="mcp-cmd">' + escMem(s.url) + '</div>' : '',
      '</div>',
    ].join('')).join('');
  }

  tools.search.addEventListener('input', () => renderToolsGrid());

  // ─── Projects panel ────────────────────────────────────────────

  const proj = {
    wsList:     document.querySelector('[data-proj-ws-list]'),
    wsCount:    document.querySelector('[data-proj-workspaces-count]'),
    list:       document.querySelector('[data-proj-list]'),
    count:      document.querySelector('[data-proj-list-count]'),
    detail:     document.querySelector('[data-proj-detail]'),
  };
  let projData = null;
  let projSelectedPath = null;

  async function bootProjectsPanel() {
    try {
      projData = await fetchJSON('/api/console/projects');
      renderWorkspaces();
      renderProjects();
    } catch (err) {
      proj.list.innerHTML = '<li class="empty">— failed: ' + escMem(err.message || err) + ' —</li>';
    }
  }

  function renderWorkspaces() {
    const dirs = (projData && projData.workspaceDirs) || [];
    proj.wsCount.textContent = dirs.length;
    if (dirs.length === 0) {
      proj.wsList.innerHTML = '<li class="empty">— no workspaces configured · use the workspace_config tool to add one —</li>';
      return;
    }
    proj.wsList.innerHTML = dirs.map((d) => '<li>' + escMem(d) + '</li>').join('');
  }

  function renderProjects() {
    const items = (projData && projData.projects) || [];
    proj.count.textContent = items.length;
    if (items.length === 0) {
      proj.list.innerHTML = '<li class="empty">— no projects detected in configured workspaces —</li>';
      return;
    }
    proj.list.innerHTML = items.map((p) => {
      const cls = (projSelectedPath === p.path) ? 'proj selected' : 'proj';
      return [
        '<li class="' + cls + '" data-proj-path="' + escMem(p.path) + '">',
        '  <span class="pname">' + escMem(p.name || p.path.split("/").pop()) + '</span>',
        '  <span class="ppath">' + escMem(p.path) + '</span>',
        '</li>',
      ].join('');
    }).join('');
    Array.from(proj.list.querySelectorAll('li.proj')).forEach((li) => {
      li.addEventListener('click', () => {
        projSelectedPath = li.getAttribute('data-proj-path');
        Array.from(proj.list.querySelectorAll('li.proj')).forEach((el) => el.classList.toggle('selected', el === li));
        loadProjectDetail(projSelectedPath);
      });
    });
  }

  async function loadProjectDetail(p) {
    if (!p) return;
    proj.detail.innerHTML = '<div class="wf-empty"><div class="wf-empty-mark">⌛</div><div class="wf-empty-text">LOADING…</div></div>';
    try {
      const data = await fetchJSON('/api/console/projects/inspect?path=' + encodeURIComponent(p));
      const parts = [];
      parts.push('<div class="proj-block"><div class="proj-block-head"><span>PATH</span></div><div class="proj-block-body"><pre>' + escMem(data.path) + '</pre></div></div>');

      if (data.package) {
        const pkg = data.package;
        const scripts = Object.entries(pkg.scripts || {}).slice(0, 12)
          .map(([k, v]) => '<dt>' + escMem(k) + '</dt><dd>' + escMem(String(v)) + '</dd>').join('');
        parts.push([
          '<div class="proj-block"><div class="proj-block-head"><span>PACKAGE.JSON</span><em>' + escMem(pkg.name || '') + ' ' + escMem(pkg.version || '') + '</em></div>',
          '<div class="proj-block-body">',
          pkg.description ? '<div style="color:var(--fg-2);margin-bottom:8px;">' + escMem(pkg.description) + '</div>' : '',
          scripts ? '<div style="font-size:10px;letter-spacing:0.14em;color:var(--fg-3);margin-bottom:4px;">SCRIPTS</div><dl class="proj-pkg-grid">' + scripts + '</dl>' : '',
          (pkg.dependencies || []).length > 0
            ? '<div style="margin-top:8px;font-size:10px;letter-spacing:0.14em;color:var(--fg-3);">DEPS (' + pkg.dependencies.length + ')</div><div style="font-size:10px;color:var(--fg-2);">' + escMem(pkg.dependencies.slice(0, 24).join(", ")) + (pkg.dependencies.length > 24 ? " …" : "") + '</div>'
            : '',
          '</div></div>',
        ].join(''));
      }

      if (data.claudeMd) {
        parts.push('<div class="proj-block"><div class="proj-block-head"><span>CLAUDE.MD</span></div><div class="proj-block-body"><pre>' + escMem(data.claudeMd) + '</pre></div></div>');
      }
      if (data.readme) {
        parts.push('<div class="proj-block"><div class="proj-block-head"><span>README</span></div><div class="proj-block-body"><pre>' + escMem(data.readme) + '</pre></div></div>');
      }
      if (Array.isArray(data.entries) && data.entries.length > 0) {
        parts.push([
          '<div class="proj-block"><div class="proj-block-head"><span>TOP-LEVEL · ' + data.entries.length + '</span></div>',
          '<div class="proj-block-body"><div class="proj-entries">',
          data.entries.map((e) => '<span class="entry ' + (e.isDir ? 'dir' : '') + '">' + escMem(e.name) + (e.isDir ? '/' : '') + '</span>').join(''),
          '</div></div></div>',
        ].join(''));
      }
      proj.detail.innerHTML = parts.join('');
    } catch (err) {
      proj.detail.innerHTML = '<div class="wf-empty"><div class="wf-empty-mark">!</div><div class="wf-empty-text">' + escMem(err.message || err) + '</div></div>';
    }
  }

  // ─── Skills panel ─────────────────────────────────────────────

  async function bootSkillsPanel() {
    const dirEl   = document.querySelector('[data-skills-dir]');
    const cntEl   = document.querySelector('[data-skills-count]');
    const tcntEl  = document.querySelector('[data-skills-tool-count]');
    const gridEl  = document.querySelector('[data-skills-grid]');
    try {
      const data = await fetchJSON('/api/console/skills');
      if (data.pluginsDir) dirEl.textContent = data.pluginsDir;
      const plugins = data.plugins || [];
      cntEl.textContent = plugins.length;
      tcntEl.textContent = plugins.reduce((s, p) => s + (p.toolCount || 0), 0);
      if (plugins.length === 0) {
        gridEl.innerHTML =
          '<div class="tools-empty">— no skills installed —<br>'
        + '<span style="color:var(--fg-mute);font-size:10px;letter-spacing:0.06em;">Drop a folder with index.js into '
        + escMem(data.pluginsDir || '') + ' to install one. Use the plugin install command or build your own.</span></div>';
        return;
      }
      gridEl.innerHTML = plugins.map((p) => [
        '<div class="skill-card">',
        '  <div class="skill-head">',
        '    <span class="skill-name">' + escMem(p.name) + '</span>',
        p.version ? '    <span class="skill-version">v' + escMem(p.version) + '</span>' : '',
        '  </div>',
        p.description ? '  <div class="skill-desc">' + escMem(p.description) + '</div>' : '',
        '  <div class="skill-tools-head"><span>TOOLS</span><em>' + (p.toolCount || 0) + '</em></div>',
        '  <div class="skill-tools">',
           (p.tools || []).map((t) => '<span class="skill-tool-pill" title="' + escMem(t.description || '') + '">' + escMem(t.name) + '</span>').join('') || '<span style="color:var(--fg-mute);font-size:10px;">(no tools)</span>',
        '  </div>',
        '</div>',
      ].join('')).join('');
    } catch (err) {
      gridEl.innerHTML = '<div class="tools-empty">— failed: ' + escMem(err.message || err) + ' —</div>';
    }
  }

  // ─── Settings panel ───────────────────────────────────────────

  const sett = {
    profileForm: document.querySelector('[data-settings-profile-form]'),
    policyForm:  document.querySelector('[data-settings-policy-form]'),
    authBox:     document.querySelector('[data-settings-auth]'),
    memoryBox:   document.querySelector('[data-settings-memory]'),
  };

  function setFormValue(form, name, value) {
    const el = form.querySelector('[name="' + name + '"]');
    if (!el) return;
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value ?? '';
  }
  function getFormPatch(form) {
    const patch = {};
    form.querySelectorAll('[data-profile-field], [data-policy-field]').forEach((el) => {
      const name = el.getAttribute('name');
      if (!name) return;
      if (el.type === 'checkbox') patch[name] = el.checked;
      else if (el.type === 'number') {
        const n = parseInt(el.value, 10);
        if (Number.isFinite(n)) patch[name] = n;
      }
      else patch[name] = el.value;
    });
    return patch;
  }

  async function bootSettingsPanel() {
    try {
      const s = await fetchJSON('/api/console/settings');
      const profile = s.profile || {};
      ['displayName','preferredName','role','timezone','urgencyTolerance','communicationTone','formality','workingHoursStart','workingHoursEnd','notes'].forEach((k) => setFormValue(sett.profileForm, k, profile[k]));

      const policy = (s.proactivity && s.proactivity.policy) || {};
      ['enabled','quietHoursEnabled','allowComputerActions','allowComposioActions','allowDiscordCheckIns'].forEach((k) => setFormValue(sett.policyForm, k, policy[k]));
      ['mode','checkInMinutes','defaultLongTaskMinutes','briefCadenceMinutes','quietHoursStart','quietHoursEnd'].forEach((k) => setFormValue(sett.policyForm, k, policy[k]));

      renderAuthInfo(s.auth);
      renderMemoryInfo(s.memory);
    } catch (err) {
      sett.authBox.innerHTML = '<div style="color:var(--accent-fail);">Failed to load settings: ' + escMem(err.message || err) + '</div>';
    }
  }

  function renderAuthInfo(auth) {
    if (!auth) { sett.authBox.textContent = '—'; return; }
    const rows = [
      ['Mode',           auth.mode || '—'],
      ['Has API key',    auth.hasOpenAiApiKey ? 'yes' : 'no'],
      ['Codex auth',     auth.hasNativeOAuth || auth.hasImportedCodexAuth ? 'configured' : 'not configured'],
    ];
    sett.authBox.innerHTML = rows.map(([k, v]) =>
      '<div class="row"><span class="k">' + escMem(k) + '</span><span class="v ' + (v === 'no' || v === 'not configured' ? 'off' : 'on') + '">' + escMem(String(v)) + '</span></div>',
    ).join('');
  }

  function renderMemoryInfo(m) {
    if (!m) { sett.memoryBox.textContent = '—'; return; }
    const rows = [
      ['Chunks',          m.chunks ?? '—'],
      ['Files',           m.indexedFiles ?? '—'],
      ['Active facts',    m.activeFacts ?? '—'],
      ['Total facts',     m.totalFacts ?? '—'],
      ['Embeddings',      m.embeddingsEnabled ? (m.embeddingsCount + ' vectors · ' + Math.round((m.embeddingsCoverage || 0) * 100) + '%') : 'disabled (set OPENAI_API_KEY)'],
      ['DB size',         (m.dbBytes ?? 0) + ' bytes'],
    ];
    sett.memoryBox.innerHTML = rows.map(([k, v]) => {
      const cls = (v === 'disabled (set OPENAI_API_KEY)') ? 'off' : 'on';
      return '<div class="row"><span class="k">' + escMem(k) + '</span><span class="v ' + cls + '">' + escMem(String(v)) + '</span></div>';
    }).join('');
  }

  sett.profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = sett.profileForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const patch = getFormPatch(sett.profileForm);
      const r = await fetch(withToken('/api/console/settings/profile'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      btn.disabled = false;
      btn.textContent = r.ok ? 'SAVED ✓' : 'FAILED';
      setTimeout(() => { btn.textContent = 'SAVE PROFILE ✎'; }, 1400);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'FAILED';
      setTimeout(() => { btn.textContent = 'SAVE PROFILE ✎'; }, 1400);
    }
  });

  sett.policyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = sett.policyForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const patch = getFormPatch(sett.policyForm);
      const r = await fetch(withToken('/api/console/settings/policy'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      btn.disabled = false;
      btn.textContent = r.ok ? 'SAVED ✓' : 'FAILED';
      setTimeout(() => { btn.textContent = 'SAVE POLICY ✎'; }, 1400);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'FAILED';
      setTimeout(() => { btn.textContent = 'SAVE POLICY ✎'; }, 1400);
    }
  });

  // Boot the loop.
  tick();
  setInterval(tick, POLL_MS);
})();
`;
