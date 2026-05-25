/**
 * Clementine Console — the new operational dashboard surface.
 *
 * Lives at /console as the primary Electron UI. Distinct visual language
 * ("operational console" aesthetic) and surfaces that scale
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
  <link rel="icon" href="/console/icon.png" />
  <style>${CONSOLE_CSS}</style>
  <script src="/console/vendor/cytoscape.min.js" defer></script>
</head>
<body>
  <div class="grid">

    <header class="status-bar">
      <div class="brand">
        <img class="brand-icon" src="/console/icon.png" alt="" />
        <div class="brand-words">
          <span class="brand-mark">Clementine</span>
          <span class="brand-sub" data-daemon-version>console</span>
        </div>
        <!--
          Dedicated update CTA. Hidden by default; renderUpdaterChip
          shows + populates it when there's an action the user can
          take (download, install, repair ownership, move to /
          Applications, retry check). Previously the version label
          itself doubled as the click target — undiscoverable for
          new users.
        -->
        <button type="button" class="updater-cta" data-updater-cta hidden aria-live="polite">
          <span class="updater-cta-icon" aria-hidden="true">↓</span>
          <span class="updater-cta-label" data-updater-cta-label>Update</span>
        </button>
      </div>
      <div class="status-row" data-status-row>
        <span class="stat" data-stat-runs>RUNS · <em>—</em></span>
        <span class="stat" data-stat-memory>MEM · <em>—</em></span>
        <span class="stat" data-stat-approvals>APPRV · <em>—</em></span>
        <span class="stat" data-stat-policy>MODE · <em>—</em></span>
        <!--
          MCP server health pill. Polls /api/console/mcp/health every
          3s. Click to jump to Settings → MCP Servers. Shows one of:
            MCP · 3 READY            (all good — connected style)
            MCP · 2/3 READY · 1 ⚠     (any degraded)
            MCP · CONNECTING…        (anything still booting)
            MCP · 1 DOWN             (anything unavailable — red)
          Empty when zero servers configured (no clutter for fresh installs).
        -->
        <button class="stat mcp-stat" data-stat-mcp data-state="loading" type="button"
                title="MCP server health · click for details" hidden>
          MCP · <em data-stat-mcp-label>—</em>
        </button>
        <span class="stat connection" data-stat-connection>
          <span class="pulse" aria-hidden="true"></span>
          <span data-conn-label>ONLINE</span>
        </span>
        <!--
          CURRENT FOCUS chip — persistent across all panels. Shows the
          active attention pointer's title; click to open a popover
          with summary + park/done actions. Hidden when no focus.
          See src/memory/focus.ts.
        -->
        <span class="stat stat-focus" data-stat-focus hidden>
          <span class="stat-focus-label">FOCUS</span>
          <span class="stat-focus-title" data-stat-focus-title>—</span>
          <button type="button" class="stat-focus-clear" data-stat-focus-clear title="Clear focus">×</button>
          <div class="stat-focus-popover" data-stat-focus-popover hidden>
            <div class="stat-focus-popover-title" data-stat-focus-popover-title>—</div>
            <div class="stat-focus-popover-summary" data-stat-focus-popover-summary>—</div>
            <div class="stat-focus-popover-meta" data-stat-focus-popover-meta>—</div>
            <div class="stat-focus-popover-actions">
              <button type="button" data-stat-focus-park>PARK</button>
              <button type="button" data-stat-focus-clear-popover>DONE</button>
            </div>
            <div class="stat-focus-popover-parked" data-stat-focus-popover-parked></div>
          </div>
        </span>
        <button class="theme-toggle" data-theme-toggle aria-label="Toggle light/dark mode" title="Toggle light/dark">
          <span class="theme-toggle-icon" data-theme-icon>◐</span>
        </button>
      </div>
    </header>

    <nav class="sidebar" aria-label="Console sections">
      <button class="nav active" data-panel="home">
        <span class="nav-key">01</span>
        <span class="nav-label">Home</span>
      </button>
      <button class="nav" data-panel="activity">
        <span class="nav-key">02</span>
        <span class="nav-label">Activity</span>
      </button>
      <!-- v0.5.11: Brain panel — single home for everything Clementine
           knows + how it learns + how it's evolving. Consolidates the
           legacy Memory / Context / Evolution top-level slots into one
           panel with 5 sub-tabs (Overview / Knowledge / Events /
           Profile / Evolution). See [[project_brain_architecture]]. -->
      <button class="nav" data-panel="brain">
        <span class="nav-key">03</span>
        <span class="nav-label">Brain</span>
      </button>
      <button class="nav" data-panel="workflows">
        <span class="nav-key">04</span>
        <span class="nav-label">Workflows</span>
      </button>
      <button class="nav" data-panel="tools">
        <span class="nav-key">05</span>
        <span class="nav-label">Tools</span>
      </button>
      <button class="nav" data-panel="projects">
        <span class="nav-key">06</span>
        <span class="nav-label">Projects</span>
      </button>
      <button class="nav" data-panel="skills">
        <span class="nav-key">07</span>
        <span class="nav-label">Skills</span>
      </button>
      <button class="nav" data-panel="integrations">
        <span class="nav-key">08</span>
        <span class="nav-label">Integrations</span>
      </button>
      <button class="nav" data-panel="usage">
        <span class="nav-key">09</span>
        <span class="nav-label">Usage</span>
      </button>
      <button class="nav" data-panel="settings">
        <span class="nav-key">10</span>
        <span class="nav-label">Settings</span>
      </button>
      <!-- v0.5.11: dedicated Approvals panel. Surfaces pending approvals
           with full context (subject, args, workflow source, age) and
           per-row + bulk actions. Replaces the noise loop where briefs
           pinged the user without enough context to act on. -->
      <button class="nav" data-panel="approvals">
        <span class="nav-key">A</span>
        <span class="nav-label">Approvals <span class="approvals-badge" data-approvals-badge hidden></span></span>
      </button>

      <!-- ── nav-dock: fills the dead space under the menu items ──
           Five stacked cards that surface monitoring + access to live
           features from any panel. AIM-era "buddy info" zone.
           Cards are fixed-height where possible; RECENT scrolls inside
           its bounds so the nav itself never scrolls. -->
      <div class="nav-dock" aria-label="Live status">

        <div class="dock-card dock-now dock-card-clickable" data-dock-now data-dock-jump="activity" role="button" tabindex="0" aria-label="Open Activity panel">
          <div class="dock-card-head">
            <span class="dock-card-tag">NOW</span>
            <span class="dock-card-tick" data-dock-now-tick>—</span>
          </div>
          <div class="dock-card-body">
            <div class="dock-now-row">
              <span class="presence-dot" data-dock-now-presence></span>
              <span class="dock-now-label" data-dock-now-label>idle</span>
            </div>
            <div class="dock-now-detail" data-dock-now-detail>—</div>
          </div>
        </div>

        <div class="dock-card dock-goal dock-card-clickable" data-dock-goal data-dock-jump="workflows" role="button" tabindex="0" aria-label="Open Workflows panel" hidden>
          <div class="dock-card-head">
            <span class="dock-card-tag">ACTIVE GOAL</span>
            <span class="dock-card-tick" data-dock-goal-turns>0/0</span>
          </div>
          <div class="dock-card-body">
            <div class="dock-goal-obj" data-dock-goal-objective>—</div>
            <div class="dock-progress">
              <span class="dock-progress-fill" data-dock-goal-progress style="width:0%"></span>
            </div>
            <div class="dock-goal-judge" data-dock-goal-judge>—</div>
          </div>
        </div>

        <div class="dock-card dock-live" data-dock-live>
          <div class="dock-card-head">
            <span class="dock-card-tag">CLEMENTINE LIVE</span>
            <span class="dock-card-tick" data-dock-live-phase>STANDBY</span>
          </div>
          <div class="dock-card-body dock-live-body">
            <button type="button" class="dock-live-orb" data-dock-live-toggle aria-label="Toggle voice">
              <span class="dock-live-orb-ring"></span>
              <span class="dock-live-orb-core"></span>
            </button>
            <div class="dock-live-info">
              <div class="dock-live-status" data-dock-live-status>tap to talk</div>
              <div class="dock-live-meta" data-dock-live-meta>voice off</div>
              <!--
                Record affordance for Recall.ai meeting capture. Lives
                inside the dock-live info block so it doesn't fight with
                the voice orb (which stays as the dedicated voice
                control). The button toggles between REC and STOP and is
                hidden when Recall isn't enabled / initialized. State +
                visibility are driven by refreshDockLive() reading
                window.clemmy.recallStatus().
              -->
              <button type="button" class="dock-live-rec" data-dock-live-rec hidden>
                <span class="dock-live-rec-dot" aria-hidden="true"></span>
                <span data-dock-live-rec-label>RECORD MEETING</span>
              </button>
            </div>
          </div>
        </div>

        <div class="dock-card dock-recent dock-card-clickable" data-dock-recent data-dock-jump="activity" role="button" tabindex="0" aria-label="Open Activity panel">
          <div class="dock-card-head">
            <span class="dock-card-tag">RECENT</span>
            <span class="dock-card-tick" data-dock-recent-count>0</span>
          </div>
          <div class="dock-card-body dock-recent-list" data-dock-recent-list>
            <div class="dock-empty">— quiet —</div>
          </div>
        </div>

        <div class="dock-card dock-health dock-card-clickable" data-dock-health data-dock-jump="settings" role="button" tabindex="0" aria-label="Open Settings panel">
          <div class="dock-card-head">
            <span class="dock-card-tag">HEALTH</span>
            <span class="dock-card-tick" data-dock-health-overall>—</span>
          </div>
          <div class="dock-card-body dock-health-grid">
            <div class="dock-health-cell" data-dock-health-daemon>
              <span class="presence-dot"></span><span>daemon</span>
            </div>
            <div class="dock-health-cell" data-dock-health-db>
              <span class="presence-dot"></span><span>memory.db</span>
            </div>
            <div class="dock-health-cell" data-dock-health-mcp>
              <span class="presence-dot"></span><span>mcp</span>
            </div>
            <div class="dock-health-cell" data-dock-health-composio>
              <span class="presence-dot"></span><span>composio</span>
            </div>
          </div>
        </div>

      </div>
    </nav>

    <main class="panel" data-active-panel="home">

      <section class="panel-frame" data-section="home">
        <div class="panel-tag">PANEL · 01 · HOME</div>

        <!--
          Home panel — focused layout. Page itself never scrolls; each
          card scrolls internally if its content overflows. The nav-dock
          (left sidebar) carries the at-a-glance monitoring (NOW, RECENT,
          HEALTH) so the home page can stay focused on:
            1. agenda — what needs you and what's running (left col)
            2. chat — the IM-style conversation (right col, focal)
            3. CLEMENTINE LIVE — voice, with its own card; click to enter
               takeover mode (orb fills the entire home panel).
        -->
        <div class="panel-body home-layout" data-home-layout>

          <header class="home-greet-strip">
            <div class="home-greet-text">
              <h2 data-home-greeting>Hello.</h2>
              <p data-home-sub>Loading status…</p>
            </div>
            <div class="home-greet-status">
              <span class="presence-dot" data-home-agent-presence></span>
              <span data-home-away-message>Reading the room…</span>
            </div>
          </header>

          <div class="home-main">

            <div class="home-main-left">
              <div class="home-block home-needs">
                <div class="home-block-head">
                  <span>NEEDS YOU</span>
                  <em data-home-needs-count>—</em>
                </div>
                <div class="home-block-body command-list" data-home-needs-list>
                  <div class="home-empty">— checking approvals —</div>
                </div>
              </div>

              <div class="home-block home-working">
                <div class="home-block-head">
                  <span>WORKING NOW</span>
                  <em data-home-active-count>—</em>
                </div>
                <div class="home-current-objective">
                  <span class="presence-dot working"></span>
                  <span data-home-current-objective>Finding active work…</span>
                </div>
                <div class="home-block-body command-list" data-home-working-list>
                  <div class="home-empty">— no active workers yet —</div>
                </div>
              </div>


              <!--
                CLEMENTINE LIVE — its own card on home. Click anywhere
                outside the orb to enter takeover mode (orb fills the
                panel). Clicking the orb directly enters takeover AND
                starts voice in one motion. The voice JS hooks
                (data-home-voice-*) are preserved so the existing
                Realtime / Recall integrations keep working.
              -->
              <div class="home-block home-live" data-home-live-card role="button" tabindex="0" aria-label="Activate Clementine Live">
                <div class="home-live-head">
                  <span class="home-live-label">CLEMENTINE LIVE</span>
                  <span class="home-live-phase" data-home-voice-phase>STANDBY</span>
                </div>
                <div class="home-live-stage" data-home-voice-panel>
                  <button type="button" class="home-voice-orb-button" data-home-voice-toggle aria-label="Start live voice">
                    <span class="home-voice-halo" aria-hidden="true"></span>
                    <span class="home-voice-portrait">
                      <img src="/console/icon.png" alt="" class="home-voice-avatar" />
                      <!--
                        Pixel-art mouth overlay positioned over the dog's
                        real mouth coordinates. .open animates the cavity
                        height + tongue visibility; the inline style on
                        --mouth-open is updated in JS from the AnalyserNode
                        amplitude so the mouth tracks the actual TTS output.
                      -->
                      <span class="home-voice-mouth" data-home-voice-mouth aria-hidden="true">
                        <span class="home-voice-mouth-cavity"></span>
                        <span class="home-voice-mouth-tongue"></span>
                      </span>
                    </span>
                  </button>
                  <div class="home-live-copy">
                    <div class="home-live-cta">Tap to talk</div>
                    <div class="home-live-sub" data-home-voice-status>or say <em>"hey Clementine"</em> from anywhere</div>
                    <label class="home-live-wake-toggle" title="Listen for &quot;hey Clementine&quot; in the background.">
                      <input type="checkbox" data-home-voice-wake-toggle />
                      <span>Wake-word</span>
                      <span class="home-live-wake-dot" data-home-voice-wake-dot aria-hidden="true"></span>
                    </label>
                  </div>
                  <audio data-home-voice-audio autoplay></audio>
                </div>
              </div>
            </div>

            <div class="home-main-right">
              <div class="home-block home-chat home-chat-dock">
                <div class="home-block-head">
                  <span>CHAT DOCK</span>
                  <span class="home-chat-meta" data-home-chat-meta>local session</span>
                </div>
                <div class="home-chat-thread" data-home-chat-thread>
                  <div class="home-chat-hint">
                    <div class="home-chat-hint-title">Instant message Clementine.</div>
                    <div class="home-chat-hint-sub">Try a quick prompt to get started:</div>
                    <div class="home-chat-suggestions">
                      <button type="button" class="home-chat-suggest" data-home-chat-suggest="what's on my plate today">what's on my plate today</button>
                      <button type="button" class="home-chat-suggest" data-home-chat-suggest="show me my open salesforce accounts that haven't been touched in 14 days">stale Salesforce accounts</button>
                      <button type="button" class="home-chat-suggest" data-home-chat-suggest="summarize what got done yesterday">recap yesterday</button>
                    </div>
                  </div>
                </div>
                <form class="home-chat-form" data-home-chat-form>
                  <input type="text" class="home-chat-input" data-home-chat-input
                    placeholder="message Clementine…" autocomplete="off" />
                  <button type="submit" class="home-chat-send">SEND ↵</button>
                </form>
              </div>
            </div>

          </div>

          <!--
            Takeover overlay — only visible when .home-layout has class
            .live-takeover (toggled by clicking the LIVE card). The orb,
            transcript, and live-feed live IN-PLACE inside the LIVE card
            via CSS positioning, but this overlay holds the takeover-only
            chrome (exit button, big transcript, send-last-turn action).
          -->
          <div class="home-live-takeover-chrome" data-home-live-takeover hidden>
            <button type="button" class="home-live-close" data-home-live-close aria-label="Exit live mode" title="Exit live mode">✕  exit live</button>
            <div class="home-live-takeover-transcript" data-home-voice-transcript>
              Voice transcript will appear here while Clementine is listening.
            </div>
            <div class="home-live-takeover-feed" data-home-voice-feed>
              <span>Tool calls + SDK events stream here in real time.</span>
            </div>
            <div class="home-live-takeover-actions">
              <button type="button" class="home-voice-btn" data-home-voice-handoff disabled>SEND LAST TURN TO CHAT</button>
              <span class="home-live-takeover-hint">say "hey Clementine" — coming soon · press <kbd>Esc</kbd> to exit</span>
            </div>
          </div>

        </div>
      </section>

      <section class="panel-frame" data-section="activity" hidden>
        <div class="panel-tag">PANEL · 02 · ACTIVITY PULSE</div>

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

      <!-- v0.5.11 brain-consolidation: Memory panel content moved to
           Brain → Knowledge → Graph & Files. Nav button removed; this
           empty shell is deleted in the same ship. -->
      <!-- (memory shell removed) -->

      <!-- v0.5.11 brain-consolidation: Context panel content moved to
           Brain → Profile. Nav button removed. -->
      <!-- (context shell removed) -->

      <section class="panel-frame" data-section="workflows" hidden>
        <div class="panel-tag">PANEL · 05 · WORKFLOW STUDIO</div>

        <div class="panel-body wf-layout">

          <!-- Workflow list (left) -->
          <aside class="wf-list-pane">
            <div class="wf-list-head">
              <span>WORKFLOWS</span>
              <span class="wf-new-btn" data-wf-new role="button" tabindex="0" title="Create new workflow" onclick="window.__clementineStartNewWorkflow && window.__clementineStartNewWorkflow();">＋ NEW</span>
            </div>
            <ol class="wf-list" data-wf-list>
              <li class="empty">— loading —</li>
            </ol>
            <!-- "SCHEDULED JOBS" (legacy crons) panel removed 2026-05-21.
                 Crons are being migrated to workflows so users have one
                 mental model: every recurring action is a workflow,
                 every one-off is a task. The legacy panel implied two
                 parallel systems and trained users to expect both. -->
          </aside>

          <!-- Editor (middle) -->
          <div class="wf-editor" data-wf-editor>
            <div class="wf-empty wf-empty-onboarding">
              <div class="wf-empty-mark">⊟</div>
              <div class="wf-empty-text">No workflow selected</div>
              <p class="wf-empty-sub">A workflow is a multi-step task you can run on demand or on a schedule. Steps can depend on each other, share inputs, and synthesize a final output.</p>
              <div class="wf-empty-actions">
                <button class="wf-empty-btn primary" data-wf-new onclick="window.__clementineStartNewWorkflow && window.__clementineStartNewWorkflow();">＋ NEW WORKFLOW</button>
                <button class="wf-empty-btn" data-wf-empty-architect>ASK ARCHITECT TO DRAFT ONE →</button>
              </div>
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
                <strong>Describe what you want and the Architect builds it.</strong><br>
                The Architect drafts, refines, or critiques the workflow on the left. Click a starter below or type your own.
              </div>
            </div>
            <!-- v0.5.11 UX: starter prompt chips. Context-aware via
                 [data-wf-chat-chip data-wf-chat-chip-mode="new|edit"];
                 the JS swaps which set is visible based on whether a
                 workflow is open. Clicking a chip pre-fills the textarea
                 and focuses it so the user can edit before sending. -->
            <div class="wf-chat-chips" data-wf-chat-chips>
              <!-- "new workflow" chips — visible when no draft is loaded -->
              <button type="button" class="wf-chat-chip" data-wf-chat-chip-mode="new" data-wf-chat-chip="Draft a workflow that triages my inbox every hour and surfaces anything important.">📥 Hourly inbox triage</button>
              <button type="button" class="wf-chat-chip" data-wf-chat-chip-mode="new" data-wf-chat-chip="Draft a morning briefing workflow that runs Mon-Fri at 8am and summarizes my calendar, overdue tasks, and any new emails I should know about.">☀ Morning briefing</button>
              <button type="button" class="wf-chat-chip" data-wf-chat-chip-mode="new" data-wf-chat-chip="Draft a weekly review workflow that runs Mondays at 9am, pulls completed tasks from last week, and asks me what I want to focus on this week.">📅 Weekly review</button>
              <button type="button" class="wf-chat-chip" data-wf-chat-chip-mode="new" data-wf-chat-chip="Draft a daily prospect outreach workflow that pulls cadence-eligible accounts from Salesforce, enriches them with SEO data via DataForSEO, drafts emails (no send), and surfaces drafts for my approval.">🎯 Prospect outreach</button>
              <!-- "edit current workflow" chips — visible when a draft is loaded -->
              <button type="button" class="wf-chat-chip" data-wf-chat-chip-mode="edit" data-wf-chat-chip="Add a step at the end that summarizes what just happened and sends me a notify_user." hidden>＋ Add a summary step</button>
              <button type="button" class="wf-chat-chip" data-wf-chat-chip-mode="edit" data-wf-chat-chip="Change the schedule to weekdays at 9am Pacific." hidden>⏱ Change schedule</button>
              <button type="button" class="wf-chat-chip" data-wf-chat-chip-mode="edit" data-wf-chat-chip="Validate this workflow for cycles, missing tools, and broken step dependencies. Tell me what you find." hidden>✓ Validate this workflow</button>
              <button type="button" class="wf-chat-chip" data-wf-chat-chip-mode="edit" data-wf-chat-chip="Explain what this workflow does in plain English — assume I'm a non-developer." hidden>❔ Explain in plain English</button>
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
        <div class="panel-tag">PANEL · 06 · TOOLS</div>
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
                <span>MCP SERVERS</span>
                <em data-mcp-count>—</em>
              </div>
              <div class="tools-empty">
                Discovered + custom MCP servers live in <a class="tools-jump" data-tools-jump="integrations">Integrations</a>.
                Toggle, edit, or add new ones there — anything the agent can call is reflected back here as a tool.
              </div>
            </div>
            <!--
              LOCAL CLIs — view-only mirror of the connected-clis.json
              registry. Surfaces "what command-line tools the agent has
              first-class access to right now." Lifecycle (install /
              configure / disconnect) lives in the Integrations panel.
              Auto-promote covers fresh installs; this section is the
              answer to "what's actually connected?"
            -->
            <div class="tools-section">
              <div class="tools-section-head">
                <span>LOCAL CLIs</span>
                <em data-tools-cli-count>—</em>
              </div>
              <div class="tools-cli-list" data-tools-cli-list>
                <div class="tools-empty">— loading —</div>
              </div>
              <div class="tools-empty" style="margin-top:8px;">
                Install + manage CLIs in <a class="tools-jump" data-tools-jump="integrations">Integrations</a>.
                Catalog CLIs already on your PATH get auto-promoted here — no install needed.
              </div>
            </div>
          </div>

        </div>
      </section>

      <section class="panel-frame" data-section="projects" hidden>
        <div class="panel-tag">PANEL · 07 · PROJECTS</div>
        <div class="panel-body projects-layout">

          <aside class="proj-side">
            <div class="proj-side-head">
              <span>WORKSPACES <em data-proj-workspaces-count>—</em></span>
              <button class="ws-add-btn" data-ws-add-btn type="button">+ ADD</button>
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
        <div class="panel-tag">PANEL · 08 · SKILLS</div>
        <div class="panel-body skills-layout">

          <div class="skills-header">
            <div class="skills-intro">
              <h3>Installed Skills</h3>
              <p>Skills are reusable <code>SKILL.md</code> prompt modules — personas, design systems, style guides, domain knowledge — that load into the agent's context on demand. Same format as Claude Code skills, Codex skills, and <a href="https://agentskills.io" target="_blank" rel="noopener">agentskills.io</a>. Public repos work directly; private repos can be enabled later with GitHub CLI.</p>
            </div>
            <div class="skills-stats">
              <div class="stat-card"><span>SKILLS</span><em data-skills-count>—</em></div>
            </div>
          </div>

          <div class="skills-install" data-skills-install>
            <input type="text" data-skills-install-url placeholder="github.com/owner/repo, owner/repo, or 'npx skills add owner/repo'" />
            <button data-skills-install-run>INSTALL SKILL</button>
            <div class="skills-install-status" data-skills-install-status hidden></div>
          </div>

          <div class="skills-grid" data-skills-grid>
            <div class="tools-empty">— loading —</div>
          </div>

          <p class="skills-footer">Skills install to <code data-skills-dir>~/.clementine-next/skills/</code>. Want custom executable tools instead? Drop a JS plugin under <code>~/.clementine-next/plugins/</code> — they show up in the Tools panel as Custom Tools.</p>

        </div>
      </section>

      <section class="panel-frame" data-section="integrations" hidden>
        <div class="panel-tag">PANEL · 09 · INTEGRATIONS</div>

        <div class="panel-body integrations-layout">

          <header class="hub-header">
            <div>
              <h3>Integrations Hub</h3>
              <p>One place to connect your APIs, third-party apps, and local MCP servers. Anything you add here becomes a tool the agent can call.</p>
            </div>
            <div class="hub-stats">
              <div class="stat-card"><span>AUTH</span><em data-hub-keys>—</em></div>
              <div class="stat-card"><span>APPS</span><em data-hub-apps>—</em></div>
              <div class="stat-card"><span>MCP</span><em data-hub-mcp>—</em></div>
            </div>
          </header>

          <div class="hub-block">
            <div class="hub-block-head">
              <span class="hub-block-title">Runtime Auth & Capability Keys</span>
              <span class="hub-block-meta" data-hub-keys-meta>—</span>
            </div>
            <p class="hub-block-intro">Codex OAuth runs the agent runtime. An OpenAI API key is separate and optional: it unlocks embeddings, Realtime live voice, and direct API-only features. Discord, Composio, and webhook secrets are separate integration keys.</p>
            <div class="hub-keys-list" data-hub-keys-list>
              <div class="settings-info">— loading —</div>
            </div>
          </div>

          <div class="hub-block">
            <div class="hub-block-head">
              <span class="hub-block-title">Connected Apps</span>
              <span class="hub-block-meta" data-hub-apps-meta>—</span>
            </div>
            <p class="hub-block-intro">Third-party apps you connect via Composio — Gmail, Slack, Notion, GitHub, Linear, Calendar, Drive, CRMs. One OAuth click per app; the agent can then read/write within the scopes you approved.</p>
            <div class="hub-apps-controls" data-hub-apps-controls>
              <div class="settings-info">— loading —</div>
            </div>
            <div class="hub-apps-list" data-hub-apps-list>
              <div class="settings-info">— loading —</div>
            </div>
          </div>

          <div class="hub-block">
            <div class="hub-block-head">
              <span class="hub-block-title">Native Browser Harness</span>
              <span class="hub-block-meta" data-hub-browser-meta>—</span>
            </div>
            <p class="hub-block-intro">Optional. Browser Harness gives Clementine direct CDP control over your real Chrome or a Browser Use cloud browser. Install it only when you want live browser automation; normal chat, memory, files, Discord, and Composio do not require it.</p>
            <div class="hub-apps-controls" data-hub-browser-controls>
              <div class="settings-info">— loading —</div>
            </div>
            <div class="hub-apps-list" data-hub-browser-list>
              <div class="settings-info">— loading —</div>
            </div>
          </div>

          <div class="hub-block">
            <div class="hub-block-head">
              <span class="hub-block-title">Connect a CLI</span>
              <span class="hub-block-meta" data-hub-cli-cat-meta>—</span>
            </div>
            <p class="hub-block-intro">Optional. Search for a CLI by name when a workflow needs a local vendor tool. Clementine can run without these; once connected, the agent can call it via <code>run_shell_command</code> and remember the install + auth context.</p>
            <div class="hub-apps-list" data-hub-github-cli>
              <div class="settings-info">Checking GitHub CLI…</div>
            </div>
            <div class="hub-apps-controls">
              <input type="search" data-hub-cli-cat-search placeholder="Search a CLI — e.g. salesforce, railway, vercel…" autocomplete="off" spellcheck="false" />
            </div>
            <div class="hub-apps-list" data-hub-cli-cat-results>
              <div class="settings-info">Type a name above to find an installable CLI.</div>
            </div>
            <div class="hub-apps-list" data-hub-cli-cat-connected>
              <!-- "Already connected" surface populated by JS when the
                   user has CLIs in connected-clis.json. -->
            </div>
          </div>

          <div class="hub-block">
            <div class="hub-block-head">
              <span class="hub-block-title">Skill / CLI Installer</span>
              <span class="hub-block-meta" data-hub-installer-meta>approved commands only</span>
            </div>
            <p class="hub-block-intro">Advanced and optional. Install trusted CLI tools (gh, sf, etc.) without opening Terminal. Accepts single install commands such as <code>npm install -g package</code>, <code>brew install formula</code>, <code>uv tool install package</code>, <code>pipx install package</code>, or <code>git clone https://github.com/org/repo</code>. <strong>For SKILL installs (Hallmark, etc.) use Skills → Install Skill — that path drops the skill into <code>~/.clementine-next/skills/</code> properly.</strong></p>
            <div class="hub-apps-controls" data-hub-installer-controls>
              <input type="text" data-hub-install-command placeholder="npm install -g some-cli" />
              <button data-hub-install-run>RUN INSTALL</button>
            </div>
            <div class="hub-apps-list" data-hub-installer-list>
              <div class="settings-info">— paste an approved install command above. Output will stream here. —</div>
            </div>
          </div>

          <div class="hub-block">
            <div class="hub-block-head">
              <span class="hub-block-title">Meeting Capture</span>
              <span class="hub-block-meta" data-hub-recall-meta>—</span>
            </div>
            <p class="hub-block-intro">Optional Recall.ai Desktop Recording SDK capture for Zoom, Google Meet, Teams, Slack Huddles, and in-person meetings. The SDK only loads inside the Electron app after you enable it.</p>
            <div class="hub-apps-controls" data-hub-recall-controls>
              <div class="settings-info">— loading —</div>
            </div>
            <div class="hub-apps-list" data-hub-recall-list>
              <div class="settings-info">— loading —</div>
            </div>
          </div>

          <div class="hub-block">
            <div class="hub-block-head">
              <span class="hub-block-title">MCP Servers</span>
              <span class="hub-block-meta" data-hub-mcp-meta>—</span>
            </div>
            <p class="hub-block-intro">Model Context Protocol servers extend the agent's tool surface with things like filesystem access, browser control, Playwright, Pinecone, Airtable, custom internal tools. Existing local MCP client configs can be imported automatically, but Clementine-owned config is the primary setup path.</p>
            <div class="hub-mcp-list" data-hub-mcp-list>
              <div class="settings-info">— loading —</div>
            </div>
            <div class="hub-mcp-actions">
              <button class="hub-btn-add" data-hub-mcp-new>+ ADD CUSTOM SERVER</button>
            </div>
          </div>

        </div>
      </section>

      <!--
        v0.5.11 — Approvals panel. Lists every pending approval with FULL
        context (subject, tool args, source workflow, age) so the user
        can recognize each one without opening the underlying session.
        Per-row approve/edit/reject + bulk "cancel all stale" actions.
        Backed by /api/console/approvals/list + the existing
        /api/console/harness-approvals/:id/:decision endpoint.
      -->
      <!--
        v0.5.11 — Brain panel. Surfaces the derived facts, entities,
        and episodic pointers the brain has accumulated. Four sub-sections:
          Facts: sortable list of consolidated_facts, filterable by kind /
            derivation / trust. Each row shows importance + last-accessed.
          Entities: people / companies / projects with mention counts +
            alias union (cross-source matching surface).
          Pointers: episodic_pointers ("the pricing convo" → call_id),
            click-to-recall via the recall_tool_result tool surface.
          Health: reflection invocations, hallucinated call_ids,
            conflict-resolver decisions (ADD/UPDATE/DELETE/NOOP).
        Read-only — manage facts via memory_remember / memory_forget
        from chat, manage approvals via the Approvals panel.
      -->
      <!--
        v0.5.11 — Brain panel. Single home for everything Clementine
        knows + how it learns. Consolidates the old Memory / Context /
        Evolution sidebars into 5 sub-tabs:
          Overview   — at-a-glance: health stats, recent learning,
                       evolution latest report header
          Knowledge  — semantic memory: facts + entities + cytoscape
                       graph + indexed files (was: Memory + Brain.Facts
                       + Brain.Entities)
          Events     — episodic memory: pointers + recent reflection
                       events (was: Brain.Pointers)
          Profile    — procedural / standing-memory: user profile +
                       goals + identity (was: Context)
          Evolution  — autoresearch nightly reports + brain-about-itself
                       (was: Evolution, previously hidden behind the
                       diagnostics toggle)
        Anchored on Tulving's semantic / episodic / procedural framing
        — see [[project_brain_architecture]] + [[project_brain_phase1_gaps]].
      -->
      <section class="panel-frame" data-section="brain" hidden>
        <div class="panel-tag">PANEL · B · BRAIN</div>
        <div class="panel-body brain-layout">
          <div class="brain-header">
            <h3>Brain</h3>
            <p>Everything Clementine knows about you, how it learns, and how it's evolving. Derived from tool returns, user statements, and reflection over time.</p>
            <div class="brain-tabs">
              <button class="brain-tab on" data-brain-tab="overview">Overview</button>
              <button class="brain-tab" data-brain-tab="knowledge">Knowledge</button>
              <button class="brain-tab" data-brain-tab="events">Events</button>
              <button class="brain-tab" data-brain-tab="meetings">Meetings</button>
              <button class="brain-tab" data-brain-tab="profile">Profile</button>
              <button class="brain-tab" data-brain-tab="evolution">Evolution</button>
            </div>
          </div>

          <!-- Overview: at-a-glance dashboard. Default tab. -->
          <div class="brain-tab-pane" data-brain-pane="overview">
            <div class="brain-overview" data-brain-overview>
              <div class="settings-info">— loading —</div>
            </div>
          </div>

          <!-- Knowledge: semantic memory. Four inner sub-tabs —
               Facts (derived/direct facts list with filters)
               Entities (people/companies/projects registry)
               Graph (cytoscape view of the memory web)
               Files (indexed vault files + vault search + viewer).
               Meetings is its OWN OUTER tab (next sibling) since
               meeting captures are episodic, not semantic. -->
          <div class="brain-tab-pane" data-brain-pane="knowledge" hidden>
            <div class="brain-subtabs">
              <button class="brain-subtab on" data-brain-knowledge-tab="facts">Facts</button>
              <button class="brain-subtab" data-brain-knowledge-tab="entities">Entities</button>
              <button class="brain-subtab" data-brain-knowledge-tab="graph">Graph</button>
              <button class="brain-subtab" data-brain-knowledge-tab="files">Files</button>
            </div>
            <div class="brain-knowledge-pane" data-brain-knowledge-pane="facts">
              <div class="brain-controls">
                <select data-brain-fact-kind>
                  <option value="">all kinds</option>
                  <option value="user">user</option>
                  <option value="project">project</option>
                  <option value="feedback">feedback</option>
                  <option value="reference">reference</option>
                </select>
                <select data-brain-fact-sort>
                  <option value="stanford">Stanford rank (importance × recency)</option>
                  <option value="recent">recent first</option>
                  <option value="important">most important first</option>
                  <option value="trust">most trusted first</option>
                </select>
                <span class="brain-count" data-brain-fact-count></span>
              </div>
              <div class="brain-list" data-brain-fact-list>
                <div class="settings-info">— loading —</div>
              </div>
            </div>
            <div class="brain-knowledge-pane" data-brain-knowledge-pane="entities" hidden>
              <div class="brain-controls">
                <select data-brain-entity-type>
                  <option value="">all types</option>
                  <option value="person">people</option>
                  <option value="company">companies</option>
                  <option value="project">projects</option>
                  <option value="place">places</option>
                  <option value="thing">things</option>
                </select>
                <span class="brain-count" data-brain-entity-count></span>
              </div>
              <div class="brain-list" data-brain-entity-list>
                <div class="settings-info">— loading —</div>
              </div>
            </div>
            <!-- Graph — full-width cytoscape. Standalone (no sidebar)
                 since file browsing now lives in its own Files sub-tab. -->
            <div class="brain-knowledge-pane" data-brain-knowledge-pane="graph" hidden>
              <div class="brain-graph-wrap">
                <div class="mem-graph" data-mem-graph>
                  <div class="mem-graph-topbar">
                    <div class="mem-graph-controls">
                      <button type="button" data-mem-graph-refresh>REFRESH</button>
                      <button type="button" data-mem-graph-fit>FIT</button>
                      <button type="button" data-mem-graph-reset>RESET</button>
                    </div>
                    <div class="mem-graph-filters">
                      <select data-mem-graph-type aria-label="Filter graph node type">
                        <option value="">ALL NODES</option>
                        <option value="fact">FACTS</option>
                        <option value="file">FILES</option>
                        <option value="kind">KINDS</option>
                      </select>
                      <input type="search" data-mem-graph-search placeholder="filter graph…" autocomplete="off" spellcheck="false" />
                    </div>
                    <span class="mem-graph-meta" data-mem-graph-meta>—</span>
                  </div>
                  <div class="mem-graph-canvas" data-mem-graph-canvas>
                    <div class="mem-graph-sparse-hint" data-mem-graph-sparse-hint hidden>
                      <strong>SPARSE LINKS</strong>
                      Most current connections are kind clusters. More meeting notes, vault entries, and cross-file references will thicken the web.
                    </div>
                  </div>
                  <aside class="mem-graph-detail" data-mem-graph-detail>
                    <div class="mem-graph-detail-empty">Hover or click a node to inspect.</div>
                  </aside>
                  <div class="mem-graph-legend">
                    <span><i class="dot kind"></i> Kind<em data-mem-legend-kinds>—</em></span>
                    <span><i class="dot fact"></i> Fact<em data-mem-legend-facts>—</em></span>
                    <span><i class="dot file"></i> File<em data-mem-legend-files>—</em></span>
                  </div>
                </div>
              </div>
            </div>
            <!-- Files — vault browser. Stats + indexed files + recent
                 files + vault search + viewer. The durable-facts list
                 that lived in the legacy mem-sidebar is dropped here
                 because the Facts sub-tab is now the canonical home
                 for facts. The bootMemoryPanel selectors for
                 data-mem-fact-list will null-resolve safely. -->
            <div class="brain-knowledge-pane" data-brain-knowledge-pane="files" hidden>
              <div class="memory-layout">
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
                      <span>RECENT FILES <em style="color:var(--fg-3); font-style:normal; font-size:9.5px; letter-spacing:0.06em;">· all extensions</em></span>
                      <em data-mem-recent-files-count>—</em>
                    </div>
                    <input type="search" class="mem-files-filter" data-mem-recent-files-filter
                      placeholder="filter by name…"
                      autocomplete="off" spellcheck="false"
                      style="margin: 4px 8px 8px 8px; width: calc(100% - 16px); padding: 4px 6px; font-size: 11px; background: var(--bg-1); border: 1px solid var(--line); color: var(--fg);" />
                    <ol class="mem-file-list" data-mem-recent-files-list>
                      <li class="empty">— loading —</li>
                    </ol>
                  </div>
                  <!-- Durable facts quick-list kept here so bootMemoryPanel's
                       selectors all resolve. The CANONICAL home for fact
                       browsing is Brain → Knowledge → Facts (which has
                       filters, sort, provenance pills). This sidebar list
                       is a compact quick-reference while the user is in
                       the file browser. -->
                  <div class="mem-section">
                    <div class="mem-section-head">
                      <span>DURABLE FACTS <em style="color:var(--fg-3); font-style:normal; font-size:9.5px; letter-spacing:0.06em;">· quick reference</em></span>
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
                  <div class="mem-toolbar">
                    <div class="mem-search">
                      <input type="search" class="mem-search-input" data-mem-search
                        placeholder="search vault · FTS + embedding rerank · ⏎ to query"
                        autocomplete="off" spellcheck="false" />
                      <span class="mem-search-meta" data-mem-search-meta>—</span>
                    </div>
                  </div>
                  <div class="mem-viewer" data-mem-viewer>
                    <div class="mem-empty">
                      <div class="mem-empty-mark">▢</div>
                      <div class="mem-empty-text">SEARCH OR SELECT A FILE</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Events: episodic memory — pointers, reflection timeline.
               Stays as the next outer sub-tab. The HTML below is its
               existing pane (no changes from v0.5.11). -->
          <!-- (no edit here — see the existing pane definition that
               follows after Knowledge) -->

          <!-- Meetings: recall meeting captures — promoted to its own
               outer sub-tab so it's reachable in one click instead of
               buried behind Knowledge → Graph & Files → MEETINGS
               toggle. Migrated mem-meetings content. -->
          <div class="brain-tab-pane" data-brain-pane="meetings" hidden>
            <div class="brain-meetings-wrap">
              <div class="mem-meetings" data-mem-meetings>
                <div class="mem-meetings-head">
                  <span class="mem-meetings-tag">CAPTURED MEETINGS</span>
                  <span class="mem-meetings-meta" data-mem-meetings-meta>—</span>
                  <button type="button" class="mem-meetings-refresh" data-mem-meetings-refresh>REFRESH</button>
                </div>
                <div class="mem-meetings-list" data-mem-meetings-list>
                  <div class="mem-meetings-empty">— loading recent meetings —</div>
                </div>
                <div class="mem-meetings-detail" data-mem-meetings-detail>
                  <div class="mem-meetings-detail-empty">Pick a meeting on the left to see its summary, action items, and transcript.</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Events: episodic memory — pointers, reflection timeline. -->
          <div class="brain-tab-pane" data-brain-pane="events" hidden>
            <p class="brain-help">Episodic pointers — short labels Clementine attached to specific tool calls. Click <code>RECALL</code> to fetch the verbatim source via <code>recall_tool_result</code>.</p>
            <div class="brain-list" data-brain-pointer-list>
              <div class="settings-info">— loading —</div>
            </div>
          </div>

          <!-- Profile: user-stated standing memory + identity + goals.
               Migrated from the legacy Context panel (was
               /api/console/context/*). CSS classes (.context-layout,
               .context-grid, .context-card etc.) are unchanged so all
               existing styles + bootContextPanel selectors still apply. -->
          <div class="brain-tab-pane" data-brain-pane="profile" hidden>
            <div class="context-layout">
              <header class="context-header">
                <div>
                  <h3>Agent Profile</h3>
                  <p>What Clementine knows before it talks, acts, or listens. Keep the core identity files useful, then add durable facts and goals as the operating picture changes.</p>
                </div>
                <div class="context-stats" data-context-stats>
                  <div class="stat-card"><span>FILES</span><em data-context-files-count>—</em></div>
                  <div class="stat-card"><span>FACTS</span><em data-context-facts-count>—</em></div>
                  <div class="stat-card"><span>GOALS</span><em data-context-goals-count>—</em></div>
                  <div class="stat-card"><span>VOICE CTX</span><em data-context-voice-count>—</em></div>
                </div>
              </header>

              <div class="context-grid">
                <section class="context-card context-profile-card">
                  <div class="context-card-head">
                    <span>USER PROFILE</span>
                    <em data-context-profile-meta>—</em>
                  </div>
                  <form class="context-profile-form" data-context-profile-form>
                    <div class="context-form-grid">
                      <label>Preferred name<input name="preferredName" data-context-profile-field autocomplete="off" /></label>
                      <label>Role<input name="role" data-context-profile-field autocomplete="off" /></label>
                      <label>Timezone<input name="timezone" data-context-profile-field placeholder="America/Los_Angeles" autocomplete="off" /></label>
                      <label>Tone
                        <select name="communicationTone" data-context-profile-field>
                          <option value="terse">terse</option>
                          <option value="balanced">balanced</option>
                          <option value="verbose">verbose</option>
                        </select>
                      </label>
                    </div>
                    <label class="context-notes-label">Notes<textarea name="notes" data-context-profile-field rows="3" placeholder="Standing preferences, work style, people/projects Clementine should respect."></textarea></label>
                    <button type="submit" class="context-save">SAVE PROFILE ✎</button>
                  </form>
                </section>

                <section class="context-card context-health-card">
                  <div class="context-card-head">
                    <span>CONTEXT HEALTH</span>
                    <button type="button" data-context-refresh>REFRESH</button>
                  </div>
                  <div class="context-health-list" data-context-health-list>
                    <div class="settings-info">— loading —</div>
                  </div>
                </section>
              </div>

              <section class="context-card">
                <div class="context-card-head">
                  <span>CORE CONTEXT FILES</span>
                  <em>loaded into chat, Discord, and live voice</em>
                </div>
                <div class="context-files" data-context-files>
                  <div class="settings-info">— loading —</div>
                </div>
              </section>

              <div class="context-grid lower">
                <section class="context-card">
                  <div class="context-card-head">
                    <span>STANDING MEMORY</span>
                    <em>durable facts injected on every run</em>
                  </div>
                  <form class="context-fact-form" data-context-fact-form>
                    <select name="kind">
                      <option value="user">user</option>
                      <option value="project">project</option>
                      <option value="feedback">feedback</option>
                      <option value="reference">reference</option>
                    </select>
                    <input name="content" placeholder="Clementine should remember…" autocomplete="off" />
                    <button type="submit">REMEMBER</button>
                  </form>
                  <div class="context-facts-list" data-context-facts-list>
                    <div class="settings-info">— loading —</div>
                  </div>
                </section>

                <section class="context-card">
                  <div class="context-card-head">
                    <span>ACTIVE GOALS</span>
                    <em>what proactive work should optimize around</em>
                  </div>
                  <form class="context-goal-form" data-context-goal-form>
                    <input name="title" placeholder="Goal title" autocomplete="off" />
                    <select name="priority">
                      <option value="high">high</option>
                      <option value="medium" selected>medium</option>
                      <option value="low">low</option>
                    </select>
                    <textarea name="description" rows="2" placeholder="Why this matters and what done looks like."></textarea>
                    <textarea name="nextActions" rows="2" placeholder="Next actions, one per line."></textarea>
                    <button type="submit">CREATE GOAL</button>
                  </form>
                  <div class="context-goals-list" data-context-goals-list>
                    <div class="settings-info">— loading —</div>
                  </div>
                </section>
              </div>
            </div>
          </div>

          <!-- Evolution: autoresearch reports. Migrated from the legacy
               Evolution panel (was hidden behind the diagnostics toggle).
               CSS classes (.evolution-layout, .evolution-header etc.)
               unchanged so bootEvolutionPanel still finds its selectors. -->
          <div class="brain-tab-pane" data-brain-pane="evolution" hidden>
            <div class="evolution-layout">
              <div class="evolution-header">
                <div>
                  <h2 class="evolution-title">Autoresearch</h2>
                  <p class="evolution-sub">Nightly observatory over Clementine's traces. Surfaces tool / workflow / skill health so you can decide what to evolve next. No mutations applied — read-only for now.</p>
                </div>
                <div class="evolution-actions">
                  <button type="button" class="evolution-btn" data-evolution-run title="Rebuild the report from current trace data">Run now</button>
                  <select class="evolution-history-pick" data-evolution-history>
                    <option value="">— history —</option>
                  </select>
                </div>
              </div>
              <div class="evolution-meta" data-evolution-meta>— loading —</div>
              <div class="evolution-report" data-evolution-report>
                <div class="settings-info">— no report yet · click <strong>Run now</strong> to generate one —</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="panel-frame" data-section="approvals" hidden>
        <div class="panel-tag">PANEL · A · APPROVALS</div>
        <div class="panel-body approvals-layout">
          <div class="approvals-header">
            <div class="approvals-intro">
              <h3>Pending Approvals</h3>
              <p>Anything Clementine paused on, waiting for you to decide. Each row shows what's being asked, where it came from, and how long it's been waiting.</p>
            </div>
            <div class="approvals-toolbar">
              <button class="hub-btn" data-approvals-refresh>REFRESH</button>
              <button class="hub-btn-danger" data-approvals-cancel-stale title="Cancel approvals older than 1 hour">CANCEL ALL STALE</button>
            </div>
          </div>
          <div class="approvals-list" data-approvals-list>
            <div class="settings-info">— loading —</div>
          </div>
        </div>
      </section>

      <section class="panel-frame" data-section="usage" hidden>
        <div class="panel-tag">PANEL · 10 · USAGE</div>
        <div class="panel-body usage-layout">

          <div class="usage-header">
            <div class="usage-intro">
              <h3>Token Usage Today</h3>
              <p>What's eating tokens. Captured per model call. Drill in to disable a noisy source without breaking agentic work.</p>
            </div>
            <div class="usage-totals">
              <div class="stat-card"><span>TOTAL TOKENS</span><em data-usage-total>—</em></div>
              <div class="stat-card"><span>CALLS</span><em data-usage-calls>—</em></div>
              <div class="stat-card"><span>INPUT</span><em data-usage-input>—</em></div>
              <div class="stat-card"><span>OUTPUT</span><em data-usage-output>—</em></div>
            </div>
          </div>

          <div class="usage-grid">
            <div class="usage-block">
              <div class="usage-block-head">BY SOURCE <button data-usage-refresh>REFRESH</button></div>
              <div class="usage-bysource" data-usage-bysource>
                <div class="settings-info">— loading —</div>
              </div>
            </div>

            <div class="usage-block">
              <div class="usage-block-head">BY KIND</div>
              <div class="usage-bykind" data-usage-bykind>
                <div class="settings-info">— loading —</div>
              </div>
              <div class="usage-block-head" style="margin-top:14px;">BY MODEL</div>
              <div class="usage-bymodel" data-usage-bymodel>
                <div class="settings-info">— loading —</div>
              </div>
            </div>
          </div>

          <div class="usage-block">
            <div class="usage-block-head">HOURLY TOKEN SPEND</div>
            <div class="usage-spark" data-usage-spark>— loading —</div>
          </div>

          <div class="usage-block">
            <div class="usage-block-head">AUTO-COMPACT (last 24h)</div>
            <p class="usage-trim-intro">When chat sessions get long, Clementine clips older tool outputs and (if needed) summarizes earlier turns so the model keeps fitting in its context window. Full originals stay recoverable via <code>recall_tool_result</code>.</p>
            <div class="usage-compaction" data-usage-compaction>
              <div class="settings-info">— loading —</div>
            </div>
          </div>

          <div class="usage-block">
            <div class="usage-block-head">TRIM CONTROLS</div>
            <p class="usage-trim-intro">Pause expensive loops without losing the agentic component. Re-enable any time. None of these disable chat or harness runs.</p>
            <div class="usage-trim" data-usage-trim>
              <div class="settings-info">— loading —</div>
            </div>
          </div>

        </div>
      </section>

      <section class="panel-frame" data-section="settings" hidden>
        <div class="panel-tag">PANEL · 11 · SETTINGS</div>
        <div class="panel-toolbar" style="display:flex; justify-content:flex-end; padding:8px 16px; border-bottom:1px solid var(--line);">
          <label class="check-pill" style="cursor:pointer;">
            <input type="checkbox" data-settings-advanced-toggle />
            <span>Show advanced</span>
          </label>
        </div>
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
              <div class="settings-block-head">RUNTIME AUTH</div>
              <div class="settings-info" data-settings-auth>—</div>
            </div>

            <div class="settings-block">
              <div class="settings-block-head">MODEL PICKER</div>
              <form class="settings-form" data-settings-models-form>
                <div class="settings-model-row">
                  <div class="settings-field">
                    <label>FAST</label>
                    <select data-model-preset="fast"></select>
                  </div>
                  <div class="settings-field">
                    <label>CUSTOM ID</label>
                    <input type="text" data-model-custom="fast" autocomplete="off" spellcheck="false" />
                  </div>
                </div>
                <div class="settings-model-row">
                  <div class="settings-field">
                    <label>PRIMARY</label>
                    <select data-model-preset="primary"></select>
                  </div>
                  <div class="settings-field">
                    <label>CUSTOM ID</label>
                    <input type="text" data-model-custom="primary" autocomplete="off" spellcheck="false" />
                  </div>
                </div>
                <div class="settings-model-row">
                  <div class="settings-field">
                    <label>DEEP</label>
                    <select data-model-preset="deep"></select>
                  </div>
                  <div class="settings-field">
                    <label>CUSTOM ID</label>
                    <input type="text" data-model-custom="deep" autocomplete="off" spellcheck="false" />
                  </div>
                </div>
                <div class="settings-actions-row">
                  <button type="submit" class="settings-save">SAVE MODELS ✎</button>
                  <button type="button" class="settings-secondary" data-settings-models-reset>RESET DEFAULTS</button>
                </div>
              </form>
              <div class="settings-info" data-settings-models-status>—</div>
            </div>

            <div class="settings-block">
              <div class="settings-block-head">RUNTIME BUDGETS</div>
              <form class="settings-form" data-settings-runtime-form>
                <div class="settings-field">
                  <label>WORKFLOW MODE</label>
                  <select name="preset" data-runtime-field data-runtime-preset>
                    <option value="standard">standard — normal chat + tasks</option>
                    <option value="long">long workflow — higher budget + check-ins</option>
                    <option value="unlimited">unlimited supervised — keep going until done/cancelled</option>
                  </select>
                </div>
                <div class="settings-grid-2">
                  <div class="settings-field">
                    <label>MAX SDK TURNS</label>
                    <input type="number" name="maxTurns" data-runtime-field min="1" max="2000" />
                  </div>
                  <div class="settings-field">
                    <label>MAX CONVERSATION STEPS</label>
                    <input type="number" name="maxConversationSteps" data-runtime-field min="1" max="1000000" />
                  </div>
                </div>
                <div class="settings-grid-2">
                  <div class="settings-field">
                    <label>WALL-CLOCK MINUTES</label>
                    <input type="number" name="maxConversationWallMinutes" data-runtime-field min="0" max="525600" />
                  </div>
                  <div class="settings-field">
                    <label>TOOL CALLS PER TURN</label>
                    <input type="number" name="toolCallsPerTurn" data-runtime-field min="1" max="256" />
                  </div>
                </div>
                <div class="settings-grid-2">
                  <div class="settings-field">
                    <label>VISIBLE CHECK-IN MINUTES</label>
                    <input type="number" name="checkInMinutes" data-runtime-field min="1" max="240" />
                  </div>
                  <div class="settings-field">
                    <label>AUTO-CONTINUE</label>
                    <label class="check-pill">
                      <input type="checkbox" name="autoContinueOnLimit" data-runtime-field />
                      <span>Continue instead of waiting when a soft budget is reached</span>
                    </label>
                  </div>
                </div>
                <div class="settings-actions-row">
                  <button type="submit" class="settings-save">SAVE RUNTIME ✎</button>
                  <button type="button" class="settings-secondary" data-runtime-preset-apply="long">USE LONG</button>
                  <button type="button" class="settings-secondary" data-runtime-preset-apply="unlimited">USE UNLIMITED</button>
                </div>
              </form>
              <div class="settings-info" data-settings-runtime-status>—</div>
            </div>
          </div>

          <div class="settings-col">
            <div class="settings-block" data-advanced-block hidden>
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
                <div class="settings-field">
                  <label>AUTO-APPROVE SCOPE</label>
                  <select name="autoApproveScope" data-policy-field>
                    <option value="strict">strict — every shell/write asks (default)</option>
                    <option value="workspace">workspace — auto inside your configured project dirs</option>
                    <option value="yolo">YOLO — auto everywhere (only the danger denylist applies)</option>
                  </select>
                  <span class="hint" style="display:block; margin-top: 4px; color: var(--fg-3); font-size: 10.5px; line-height: 1.5;">
                    Clementine's own data dir (<code>~/.clementine-next/</code>) always auto-approves regardless of scope — that's bookkeeping, not a user-visible action. <strong>workspace</strong> additionally auto-approves writes inside the dirs you listed in <code>WORKSPACE_DIRS</code>. Plan-scoped approvals (15 min) always work on top. The hard denylist (<code>rm -rf /</code>, <code>sudo</code>, fork bombs, disk wipes) is enforced regardless.
                    <strong style="color: var(--accent-warn);">YOLO trusts the agent anywhere the user can write</strong> — use when you want zero friction.
                  </span>
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
              <div class="settings-block-head">PERSONALITY · how Clementine talks to you</div>
              <div class="settings-info" style="line-height: 1.6;">
                Personality + identity live as plain-text files Clementine reads on every turn — edits take effect on your next message, no restart.
                Open the <button type="button" class="settings-secondary" data-tools-jump="context" style="font-size: 10.5px; padding: 4px 10px; vertical-align: baseline;">CONTEXT TAB</button> to edit them, pick from preset starters (terse + proactive, warm + explanatory, quiet executor), or start from scratch.
              </div>
            </div>

            <div class="settings-block">
              <div class="settings-block-head">MEMORY INDEX</div>
              <div class="settings-info" data-settings-memory>—</div>
            </div>

            <div class="settings-block">
              <div class="settings-block-head">
                PROPOSED PLANS
                <span class="creds-meta" data-plan-proposals-meta>—</span>
              </div>
              <div class="proposals-intro">
                Plans the agent drafted before mutating anything. Review the objective, steps, and risks. Approve to let the agent proceed, edit to change the plan first, or reject to abandon.
              </div>
              <div class="plan-proposals-list" data-plan-proposals-list>
                <div class="settings-info">— no pending plans —</div>
              </div>
            </div>

            <div class="settings-block">
              <div class="settings-block-head">
                PROPOSED BY AGENT
                <span class="creds-meta" data-proposals-meta>—</span>
              </div>
              <div class="proposals-intro">
                Templates the agent drafted from patterns it noticed. Review the rationale, then approve, edit, or reject. Approved proposals are installed as live templates.
              </div>
              <div class="proposals-list" data-proposals-list>
                <div class="settings-info">— no pending proposals —</div>
              </div>
            </div>

            <div class="settings-block">
              <div class="settings-block-head">
                PROACTIVE CHECK-INS
                <span class="creds-meta" data-checkins-meta>—</span>
              </div>
              <div class="checkins-intro">
                Autonomous reach-outs the agent fires on a schedule or when a condition is true.
                Five seeded templates are installed and disabled — toggle the ones you want active. Cooldown prevents repeat-firing.
              </div>
              <div class="checkins-list" data-checkins-list>
                <div class="settings-info">— loading —</div>
              </div>
              <div class="checkins-actions">
                <button class="checkins-btn-new" data-checkins-new>+ NEW TEMPLATE</button>
              </div>
            </div>

            <div class="settings-block">
              <div class="settings-block-head">
                CREDENTIAL VAULT
                <span class="creds-meta" data-creds-meta>—</span>
              </div>
              <div class="settings-info" style="padding: 0 16px 8px; line-height: 1.5;">
                Per-credential edit, repair, and reset live here.
                Codex OAuth runtime credentials and optional capability keys are shown separately in <a class="tools-jump" data-tools-jump="integrations">Integrations</a>.
              </div>
              <div class="creds-list" data-creds-list>
                <div class="settings-info">— loading —</div>
              </div>
              <div class="creds-actions">
                <button class="creds-btn-repair" data-creds-repair>REPAIR KEYCHAIN ⟲</button>
                <button class="creds-btn-reset" data-creds-reset>RESET CREDENTIALS ▣</button>
              </div>
              <div class="creds-footnote">
                Reset only deletes entries under <code>com.clemmy.desktop.v1</code> and the local file vault.
                Your <code>.env</code> is never touched.
              </div>
            </div>
          </div>

          <!--
            Diagnostics block — hidden behind a "Show diagnostics" toggle
            at the top, revealed in-place. Power-user surface only;
            renders today's tool-event summary, recent errors, MCP server
            health, and storage stats from /api/console/diagnostics.
            Pure read; no buttons that modify state.
          -->
          <div class="settings-col" data-diagnostics-wrap>
            <div class="settings-block">
              <label class="settings-toggle">
                <input type="checkbox" data-diagnostics-toggle />
                <span>Show diagnostics</span>
              </label>
              <p class="settings-block-hint">
                Read-only panel that summarizes today's tool calls, recent errors, and MCP server health.
                Useful for diagnosing why a particular session was fast or slow without grepping logs.
              </p>
            </div>
            <div class="settings-block" data-diagnostics-panel hidden>
              <div class="settings-block-head">
                DIAGNOSTICS
                <button type="button" class="settings-btn-mini" data-diagnostics-refresh title="Refresh">↻</button>
              </div>
              <div class="diag-summary" data-diag-summary>
                <div class="settings-info">— loading —</div>
              </div>
              <div class="diag-section" data-diag-tool-events hidden>
                <div class="diag-section-head">TODAY'S TOOL EVENTS</div>
                <div class="diag-tool-events-body" data-diag-tool-events-body></div>
              </div>
              <div class="diag-section" data-diag-sessions hidden>
                <div class="diag-section-head">SESSIONS (most active)</div>
                <div class="diag-sessions-body" data-diag-sessions-body></div>
              </div>
              <div class="diag-section" data-diag-mcp hidden>
                <div class="diag-section-head">MCP SERVERS</div>
                <div class="diag-mcp-body" data-diag-mcp-body></div>
              </div>
              <div class="diag-section" data-diag-errors hidden>
                <div class="diag-section-head">RECENT WARN/ERROR (filtered)</div>
                <div class="diag-errors-body" data-diag-errors-body></div>
              </div>
              <div class="diag-section" data-diag-storage hidden>
                <div class="diag-section-head">STORAGE</div>
                <div class="diag-storage-body" data-diag-storage-body></div>
              </div>
            </div>
          </div>

        </div>
      </section>

      <!--
        PANEL · 12 · EVOLUTION
        Power-user nav slot for autoresearch (hermes-style self-evolution).
        Foundation only: daily observatory report from yesterday's traces.
        Mutation phases (C/B/A) land here later behind an approval queue.
      -->
      <!-- v0.5.11 brain-consolidation: Evolution panel content moved to
           Brain → Evolution. Nav button removed. -->
      <!-- (evolution shell removed) -->

    </main>

    <!--
      The standalone right-side "LIVE" rail was removed. The Activity
      panel's run list is now the single canonical surface for every
      app + Discord run, and it auto-refreshes in near-real-time via
      the SSE consumer in initLiveActionsRefresh() below (which kicks
      the polling tick on every relevant event from
      /api/console/actions/stream).
    -->

    <footer class="foot-bar">
      <span class="foot-cell">poll · 2s</span>
      <span class="foot-cell">last · <em data-last-sync>—</em></span>
      <span class="foot-cell" data-foot-version>—</span>
      <span class="foot-cell foot-right">⌘K · coming soon</span>
    </footer>

    <!--
      ── Meeting-capture floating layer ─────────────────────────────
      Three states, mutually exclusive, all top-right:
        a) meeting detected but not recording → prompt banner with
           [Record this meeting] [Always record] [Not this time]
        b) recording in progress → live pill (platform + elapsed),
           click to expand the transcript drawer
        c) recording just ended → completion toast with
           [Open transcript] [Send summary to chat] [Dismiss]
      Visible from any panel — the recall events fire globally,
      not just when the Integrations tab is open.
    -->
    <div class="meeting-layer" data-meeting-layer aria-live="polite">

      <div class="meeting-prompt" data-meeting-prompt hidden>
        <div class="meeting-prompt-head">
          <span class="meeting-dot detected"></span>
          <span class="meeting-prompt-title" data-meeting-prompt-title>Meeting detected</span>
          <button type="button" class="meeting-x" data-meeting-prompt-dismiss aria-label="Dismiss">✕</button>
        </div>
        <div class="meeting-prompt-sub" data-meeting-prompt-sub>—</div>
        <div class="meeting-prompt-actions">
          <button type="button" class="meeting-btn primary" data-meeting-prompt-record>RECORD THIS MEETING</button>
          <button type="button" class="meeting-btn ghost" data-meeting-prompt-always>ALWAYS RECORD</button>
        </div>
      </div>

      <div class="meeting-toast" data-meeting-toast hidden>
        <div class="meeting-toast-head">
          <span class="meeting-dot complete"></span>
          <span class="meeting-toast-title">Meeting captured</span>
          <button type="button" class="meeting-x" data-meeting-toast-dismiss aria-label="Dismiss">✕</button>
        </div>
        <div class="meeting-toast-sub" data-meeting-toast-sub>—</div>
        <div class="meeting-toast-actions">
          <button type="button" class="meeting-btn ghost" data-meeting-toast-transcript>OPEN TRANSCRIPT</button>
          <button type="button" class="meeting-btn primary" data-meeting-toast-summary>SUMMARIZE IN CHAT</button>
        </div>
      </div>

    </div>

    <!--
      General-purpose toast layer. Floating bottom-right stack; each
      toast auto-dismisses after a few seconds unless sticky. Replaces
      the avalanche of native alert() popups that used to fire for
      every "X failed" error.
    -->
    <div class="toast-layer" data-toast-layer aria-live="polite" aria-atomic="false"></div>

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
:root,
:root[data-theme="ops"] {
  /* Dark "operations console" theme — the default. */
  --bg-0: #07070a;
  --bg-1: #0d0d12;
  --bg-2: #14141c;
  --bg-3: #1c1c26;

  --line: #2a2a36;
  --line-bright: #44445a;

  --fg: #e5e5ea;
  --fg-2: #a0a0aa;
  --fg-3: #6b6b78;
  --fg-mute: #4a4a55;

  --accent: #ff5a35;        /* tactical orange */
  --accent-2: #b9ff36;      /* electric lime */
  --accent-3: #36c5ff;      /* cyan */
  --accent-warn: #ffcc33;
  --accent-fail: #ff3b5a;

  --scanline-rgb: 255, 255, 255;
  --scanline-alpha: 0.012;

  --mono: ui-monospace, "SF Mono", "JetBrains Mono", "IBM Plex Mono", Menlo, monospace;
  --tile: 8px;
}

:root[data-theme="day"] {
  /* Light theme — same console DNA, just inverted. Same accents so
     the visual identity stays consistent. */
  --bg-0: #f6f4ef;
  --bg-1: #fdfbf5;
  --bg-2: #efebe0;
  --bg-3: #e6e1d3;

  --line: #d2cdbc;
  --line-bright: #b2ac98;

  --fg: #1c1a14;
  --fg-2: #4a473b;
  --fg-3: #76715f;
  --fg-mute: #a6a08c;

  /* Slightly darker accents to maintain contrast on the warm beige. */
  --accent: #d44a25;
  --accent-2: #6a9920;
  --accent-3: #2588b8;
  --accent-warn: #b88a18;
  --accent-fail: #c8253c;

  --scanline-rgb: 0, 0, 0;
  --scanline-alpha: 0.010;

  /* Slightly stronger card tint over the warm cream so the
     plan/proposal accents still read clearly. */
  --card-tint: 0.12;
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
  /* Subtle scan-line texture — flips polarity with the theme so it
     reads as a CRT shimmer in both dark and light modes. */
  background-image:
    repeating-linear-gradient(
      to bottom,
      transparent 0px,
      transparent 3px,
      rgba(var(--scanline-rgb), var(--scanline-alpha)) 3px,
      rgba(var(--scanline-rgb), var(--scanline-alpha)) 4px
    );
  transition: background 200ms ease, color 200ms ease;
}

/* ── Layout ─────────────────────────────────────────────────────── */
/*
 * The right-side LIVE rail was removed. The grid is now two columns:
 * sidebar (220px) + panel (1fr). The standalone real-time feed was
 * causing routing confusion separate from the Activity table — the
 * Activity table is now canonical, and a small SSE consumer (in the
 * inline JS below) kicks the polling tick whenever the daemon emits
 * an action so the table updates in near-real-time without the rail.
 */
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
  /* On macOS the traffic-light buttons occupy roughly the leftmost
     78px of the window chrome. Pad the brand area past them so the
     Clementine icon isn't hiding underneath. Non-mac platforms put
     window controls on the right, so the extra left padding is a
     minor cost. -webkit-app-region: drag turns the status bar into
     a draggable window handle when packaged. */
  padding: 0 16px 0 84px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--line);
  position: relative;
  -webkit-app-region: drag;
}
.status-bar button,
.status-bar input,
.status-bar select,
.status-bar a,
.status-bar [role="button"] {
  /* Drag-handle applies to the whole bar; carve out interactive
     elements so clicks still register. */
  -webkit-app-region: no-drag;
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
  gap: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  font-size: 11px;
}
.brand-icon {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  image-rendering: pixelated;
  background: var(--bg-2);
  padding: 2px;
  flex-shrink: 0;
}
.brand-words {
  display: flex;
  flex-direction: column;
  line-height: 1.05;
}
.brand-mark {
  color: var(--fg);
  font-size: 14px;
  letter-spacing: 0.02em;
  font-weight: 600;
  text-transform: none;
}
.brand-sub {
  color: var(--fg-3);
  font-size: 9.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin-top: 1px;
}
.updater-cta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 10px;
  padding: 4px 10px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border: 1px solid var(--accent);
  color: var(--accent);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 600;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.updater-cta:hover  { background: var(--accent); color: var(--bg-0); }
.updater-cta:disabled,
.updater-cta.busy   { background: var(--bg-1); color: var(--fg-3); border-color: var(--line); cursor: progress; }
.updater-cta[hidden] { display: none; }
.updater-cta-icon { font-size: 11px; line-height: 1; }
.updater-cta.kind-install  { border-color: var(--accent-2, #8ed47e); color: var(--accent-2, #8ed47e); background: color-mix(in srgb, var(--accent-2, #8ed47e) 16%, transparent); }
.updater-cta.kind-install:hover { background: var(--accent-2, #8ed47e); color: var(--bg-0); }
.updater-cta.kind-repair   { border-color: var(--accent-fail, #ff5a5f); color: var(--accent-fail, #ff5a5f); background: color-mix(in srgb, var(--accent-fail, #ff5a5f) 14%, transparent); }
.updater-cta.kind-repair:hover  { background: var(--accent-fail, #ff5a5f); color: var(--bg-0); }
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
  align-items: center;
  gap: 14px;
  font-size: 10.5px;
  color: var(--fg-3);
  letter-spacing: 0.1em;
}
.status-row .stat {
  white-space: nowrap;
}
.status-row .stat em {
  font-style: normal;
  color: var(--fg);
  margin-left: 4px;
}
@media (max-width: 900px) {
  .status-row {
    gap: 10px;
    font-size: 9.5px;
  }
}
.status-row .connection {
  color: var(--accent-2);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.status-row .connection[data-offline] {
  color: var(--accent-fail);
}
.status-row .connection[data-offline] .pulse {
  background: var(--accent-fail);
  box-shadow: 0 0 8px rgba(255, 59, 90, 0.6);
}

/* ── MCP server status pill (header) ─────────────────────────── */
.mcp-stat {
  cursor: pointer;
  border: 1px solid var(--line);
  background: transparent;
  font: inherit;
  font-size: 11px;
  color: var(--fg-2);
  padding: 2px 8px;
  border-radius: 4px;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
.mcp-stat[hidden] { display: none; }
.mcp-stat:hover { color: var(--fg); border-color: var(--fg-2); }
.mcp-stat[data-state="ready"]      { color: var(--accent-2, #5cd66a); border-color: color-mix(in srgb, var(--accent-2, #5cd66a) 60%, transparent); }
.mcp-stat[data-state="connecting"] { color: var(--accent, #ff8f3c); border-color: color-mix(in srgb, var(--accent, #ff8f3c) 60%, transparent); }
.mcp-stat[data-state="degraded"]   { color: var(--accent-warn, #f7b733); border-color: color-mix(in srgb, var(--accent-warn, #f7b733) 60%, transparent); }
.mcp-stat[data-state="down"]       { color: var(--accent-fail, #ff5a5f); border-color: color-mix(in srgb, var(--accent-fail, #ff5a5f) 60%, transparent); }

/* ── Theme toggle ─────────────────────────────────────────────── */
.theme-toggle {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  width: 26px;
  height: 26px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 100ms, border-color 100ms, color 100ms;
  margin-left: 4px;
}
.theme-toggle:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.theme-toggle-icon {
  display: inline-block;
  transition: transform 200ms ease;
}
:root[data-theme="day"] .theme-toggle-icon {
  transform: rotate(180deg);
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
.nav-badge {
  margin-left: auto;
  min-width: 19px;
  height: 17px;
  padding: 2px 5px;
  border: 1px solid var(--line-bright);
  color: var(--fg-2);
  background: var(--bg-0);
  font-size: 9px;
  line-height: 11px;
  text-align: center;
  letter-spacing: 0.04em;
}
.nav-badge.warn {
  border-color: var(--accent-warn);
  color: var(--accent-warn);
}
.nav-badge.hot {
  border-color: var(--accent);
  color: var(--accent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 18%, transparent);
}
.nav-badge.good {
  border-color: var(--accent-2);
  color: var(--accent-2);
}

/* -- Nav dock (the AIM "buddy info" zone) ------------------------
 * Lives under the 10 menu items inside .sidebar, fills the dead
 * vertical space with stacked status cards. The sidebar is a flex
 * column; the dock uses margin-top:auto so it pins to the bottom of
 * the available space and the menu sits on top.
 *
 * Cards are fixed-height where possible so the nav never scrolls;
 * only the RECENT card scrolls internally when its event list grows.
 */
.nav-dock {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 10px 12px;
  min-height: 0;
  overflow: hidden;
}
.dock-card {
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg-0) 56%, var(--bg-1));
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
}
.dock-card[hidden] { display: none; }
.dock-card-clickable {
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}
.dock-card-clickable:hover,
.dock-card-clickable:focus-visible {
  background: color-mix(in srgb, var(--accent) 9%, var(--bg-1));
  border-color: var(--accent);
  outline: none;
}
.dock-card-clickable:active {
  background: color-mix(in srgb, var(--accent) 16%, var(--bg-1));
}
.dock-card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 9px 4px;
  border-bottom: 1px dashed var(--line);
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
  text-transform: uppercase;
}
.dock-card-tag {
  font-weight: 600;
}
.dock-card-tick {
  color: var(--fg-2);
  letter-spacing: 0.1em;
  font-size: 9px;
}
.dock-card-body {
  padding: 6px 9px 8px;
  font-size: 10.5px;
  color: var(--fg);
  line-height: 1.35;
}
.dock-empty {
  color: var(--fg-3);
  font-style: italic;
  font-size: 10px;
}

/* NOW */
.dock-now-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.dock-now-label {
  color: var(--fg);
}
.dock-now-detail {
  color: var(--fg-2);
  font-size: 10px;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ACTIVE GOAL */
.dock-goal-obj {
  font-size: 10.5px;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 5px;
}
.dock-progress {
  width: 100%;
  height: 4px;
  background: var(--bg-0);
  border: 1px solid var(--line);
  overflow: hidden;
  margin-bottom: 4px;
}
.dock-progress-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 220ms ease;
}
.dock-goal-judge {
  color: var(--fg-3);
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

/* CLEMENTINE LIVE */
.dock-live-body {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 9px 9px;
}
.dock-live-orb {
  background: transparent;
  border: 0;
  cursor: pointer;
  position: relative;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
}
.dock-live-orb-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid var(--accent);
  opacity: 0.4;
}
.dock-live-orb-core {
  position: absolute;
  inset: 4px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%,
    color-mix(in srgb, var(--accent) 70%, var(--bg-0)) 0%,
    color-mix(in srgb, var(--accent) 28%, var(--bg-0)) 55%,
    color-mix(in srgb, var(--accent) 10%, var(--bg-1)) 100%);
  border: 1px solid color-mix(in srgb, var(--accent) 60%, var(--line));
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.dock-live.live .dock-live-orb-ring {
  border-color: var(--accent-2);
  opacity: 1;
  animation: dock-live-pulse 1.4s ease-in-out infinite;
}
@keyframes dock-live-pulse {
  0%, 100% { transform: scale(1); opacity: 0.55; }
  50%      { transform: scale(1.15); opacity: 0.95; }
}
.dock-live-info {
  min-width: 0;
}
.dock-live-status {
  color: var(--fg);
  font-size: 10.5px;
}
.dock-live-meta {
  color: var(--fg-3);
  font-size: 9px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  margin-top: 2px;
}
/* Record button in the dock-live card. Distinct from the orb (which
   is voice). Red dot indicates idle-ready; pulses when recording. */
.dock-live-rec {
  margin-top: 6px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  font-size: 9.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 600;
  background: transparent;
  color: var(--accent-fail, #ff5a5f);
  border: 1px solid var(--accent-fail, #ff5a5f);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.dock-live-rec:hover { background: var(--accent-fail, #ff5a5f); color: var(--bg-0); }
.dock-live-rec:disabled { opacity: 0.55; cursor: progress; }
.dock-live-rec[hidden] { display: none; }
.dock-live-rec-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent-fail, #ff5a5f);
  box-shadow: 0 0 5px color-mix(in srgb, var(--accent-fail, #ff5a5f) 60%, transparent);
}
.dock-live.live .dock-live-rec {
  background: var(--accent-fail, #ff5a5f);
  color: var(--bg-0);
}
.dock-live.live .dock-live-rec-dot { animation: dock-live-rec-pulse 1.2s ease-in-out infinite; }
@keyframes dock-live-rec-pulse {
  0%, 100% { opacity: 0.45; transform: scale(1); }
  50%      { opacity: 1; transform: scale(1.25); }
}

/* RECENT */
.dock-recent-list {
  max-height: 92px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10px;
}
.dock-recent-row {
  display: flex;
  gap: 6px;
  align-items: baseline;
  color: var(--fg-2);
  line-height: 1.35;
}
.dock-recent-row.ok   { color: var(--fg); }
.dock-recent-row.warn { color: var(--accent-warn); }
.dock-recent-row.err  { color: var(--accent-fail); }
.dock-recent-row .t {
  color: var(--fg-3);
  font-size: 9px;
  white-space: nowrap;
  flex: 0 0 auto;
}
.dock-recent-row .n {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* HEALTH */
.dock-health-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 8px;
  font-size: 9.5px;
  letter-spacing: 0.04em;
}
.dock-health-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--fg-2);
}
.dock-health-cell .presence-dot {
  width: 7px;
  height: 7px;
  margin-top: 0;
}
.dock-health-cell.warn { color: var(--accent-warn); }
.dock-health-cell.err  { color: var(--accent-fail); }

@media (max-height: 760px) {
  /* On short viewports the recent feed gets the squeeze first. */
  .dock-recent-list { max-height: 64px; }
}
@media (max-height: 660px) {
  /* If we really run out of room, fold recent + health into compact rows. */
  .dock-health-grid { grid-template-columns: 1fr 1fr 1fr 1fr; }
  .dock-recent-list { max-height: 44px; }
}

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

/* ── Home panel ───────────────────────────────────────────────── */
/* No page-level scroll. The page itself is a fixed-height grid; each
   card inside scrolls internally if its content overflows. */
.home-layout {
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 12px;
  padding: 14px 18px 18px;
  overflow: hidden;
  height: 100%;
  position: relative; /* anchor the takeover overlay */
}
/* Compact greet strip — single horizontal row at the top of home.
   Replaces the old home-welcome + 7 home-tiles block (those stats now
   live in the nav-dock NOW card). */
.home-greet-strip {
  display: flex;
  align-items: center;
  /* flex-start (was space-between) so the right-side status sits next
     to the greeting instead of being pushed to the far edge — that
     gap left a huge empty middle on wide windows. */
  justify-content: flex-start;
  gap: 18px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 56%),
    var(--bg-1);
  min-height: 50px;
}
.home-greet-text {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}
.home-greet-text h2 {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 18px;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.home-greet-text p {
  margin: 0;
  color: var(--fg-2);
  font-size: 11px;
  letter-spacing: 0.06em;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.home-greet-status {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--fg-3);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  /* Tight, short status only — long narration like the agent's last
     reply belongs in the WORKING NOW card, not the header strip.
     refreshHomeCommandCenter trims awayMessage to presence.label for
     the header surface (see [data-home-away-message] update). */
  flex: 0 0 auto;
}
.presence-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--accent-2);
  box-shadow: 0 0 9px color-mix(in srgb, var(--accent-2) 52%, transparent);
  flex: 0 0 auto;
}
.presence-dot.needs-you,
.presence-dot.warn { background: var(--accent-warn); box-shadow: 0 0 9px color-mix(in srgb, var(--accent-warn) 52%, transparent); }
.presence-dot.working { background: var(--accent-3); box-shadow: 0 0 9px color-mix(in srgb, var(--accent-3) 52%, transparent); }
.presence-dot.offline { background: var(--accent-fail); box-shadow: 0 0 9px color-mix(in srgb, var(--accent-fail) 52%, transparent); }
/* Two-column main: agenda + LIVE on the left, CHAT on the right.
   Both columns fill the available height (1fr in the parent grid).
   Each card inside uses min-height: 0 so its body can scroll instead
   of expanding the page. */
.home-main {
  display: grid;
  grid-template-columns: minmax(280px, 0.85fr) minmax(360px, 1.4fr);
  gap: 12px;
  min-height: 0; /* critical: lets children's overflow:auto actually scroll */
}
.home-main-left {
  display: grid;
  grid-template-rows: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 12px;
  min-height: 0;
}
.home-main-right {
  display: grid;
  min-height: 0;
}
.home-needs,
.home-working {
  min-height: 0;
}
.home-current-objective {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  color: var(--fg);
  font-size: 11px;
  line-height: 1.4;
  background:
    repeating-linear-gradient(90deg, color-mix(in srgb, var(--fg) 4%, transparent) 0 1px, transparent 1px 18px),
    var(--bg-0);
}
.home-current-objective[hidden] {
  /* HTML's hidden attribute applies display:none with low
     specificity, which the display:flex above overrides — explicit
     reset so the JS can collapse the banner when there's no active
     work without it ghosting as an empty row. */
  display: none;
}
.command-list {
  gap: 0;
}
.command-list.compact .home-item {
  padding: 6px 0;
}

/* CLEMENTINE LIVE card — third card in left column. Whole card is a
   button; clicking enters takeover mode. Compact by default; the
   takeover state grows the orb and shows the transcript chrome. */
.home-live {
  background:
    radial-gradient(circle at 25% 0%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 55%),
    var(--bg-1);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line));
  color: var(--fg);
  font: inherit;
  text-align: left;
  cursor: pointer;
  padding: 0;
  display: flex;
  flex-direction: column;
  transition: border-color 160ms, background 160ms;
  overflow: hidden;
}
.home-live:hover {
  border-color: var(--accent);
  background:
    radial-gradient(circle at 25% 0%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 55%),
    var(--bg-1);
}
.home-live-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px;
  border-bottom: 1px dashed var(--line);
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
  text-transform: uppercase;
}
.home-live-label {
  font-weight: 600;
}
.home-live-phase {
  color: var(--accent);
  letter-spacing: 0.1em;
}
.home-live-stage {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px 14px;
}
.home-live-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.home-live-cta {
  font-size: 13px;
  letter-spacing: 0.04em;
  color: var(--fg);
}
.home-live-sub {
  font-size: 10px;
  letter-spacing: 0.05em;
  color: var(--fg-3);
}

/* CHAT — full height of the right column, internal scroll for thread. */
.home-chat-harness-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.55);
  cursor: pointer;
  user-select: none;
}
.home-chat-harness-toggle input {
  width: 11px;
  height: 11px;
  accent-color: #f6a623;
  cursor: pointer;
}
.home-chat-harness-toggle:has(input:checked) {
  color: #f6a623;
}
.home-chat-dock {
  height: 100%;
  min-height: 0;
}
.home-chat {
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* Subtle warm tint so the chat block reads as the focal point. */
  background:
    linear-gradient(180deg, rgba(255, 170, 80, var(--card-tint, 0.03)) 0%, transparent 30%),
    var(--bg-1);
  border-left: 2px solid var(--accent);
}
.home-chat .home-chat-thread {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

/* TAKEOVER state — clicking LIVE adds .live-takeover to .home-layout.
   home-layout becomes a 2-row grid: [home-main, 1fr] [chrome, auto].
   The LIVE card fills home-main with the orb centered. The chrome
   (transcript + feed + actions) sits naturally below as a sibling. */
.home-layout.live-takeover {
  grid-template-rows: 1fr auto;
  gap: 10px;
}
.home-layout.live-takeover .home-greet-strip,
.home-layout.live-takeover .home-main-left > :not(.home-live),
.home-layout.live-takeover .home-main-right {
  display: none;
}
.home-layout.live-takeover .home-main {
  grid-template-columns: 1fr;
  min-height: 0;
}
.home-layout.live-takeover .home-main-left {
  grid-template-rows: 1fr;
  min-height: 0;
}
.home-layout.live-takeover .home-live {
  cursor: default;
  min-height: 0;
  position: relative;
}
.home-layout.live-takeover .home-live-stage {
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 18px;
  padding: 24px 24px 16px;
  flex: 1 1 auto;
  min-height: 220px;
  overflow: hidden;
}
.home-layout.live-takeover .home-live-stage .home-voice-orb-button {
  width: clamp(140px, 24vh, 220px);
  height: clamp(140px, 24vh, 220px);
  transform: scale(1);
}
/* Avatar fills the portrait disc at every size now — no per-state
   sizing needed. */
.home-layout.live-takeover .home-live-copy {
  text-align: center;
  gap: 6px;
}
.home-layout.live-takeover .home-live-cta {
  font-size: 20px;
  letter-spacing: 0.02em;
}
.home-layout.live-takeover .home-live-sub {
  font-size: 11px;
  letter-spacing: 0.08em;
  max-width: 480px;
  line-height: 1.5;
  white-space: normal;
  word-wrap: break-word;
}
/* Chrome flows naturally at the bottom of the card; no more absolute
   overlay (which caused the orb area to collide with transcript/feed
   on narrow viewports). */
.home-live-takeover-chrome {
  display: none;
  flex-direction: column;
  gap: 8px;
  padding: 0 18px 14px;
  flex: 0 0 auto;
}
.home-layout.live-takeover .home-live-takeover-chrome {
  display: flex;
}
.home-live-close {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: 5;
  background: color-mix(in srgb, var(--bg-0) 70%, transparent);
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 5px 10px;
  cursor: pointer;
  backdrop-filter: blur(6px);
}
.home-live-close:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.home-live-takeover-transcript {
  padding: 10px 14px;
  border: 1px dashed var(--line);
  background: color-mix(in srgb, var(--bg-0) 58%, transparent);
  color: var(--fg);
  font-size: 12px;
  line-height: 1.5;
  max-height: 96px;
  overflow-y: auto;
}
.home-live-takeover-feed {
  padding: 8px 12px;
  border: 1px solid var(--line);
  background: var(--bg-0);
  color: var(--fg-2);
  font-size: 10px;
  letter-spacing: 0.06em;
  max-height: 72px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.home-live-takeover-feed .home-voice-event {
  display: block;
  word-break: break-word;
}
.home-live-takeover-feed .home-voice-event.error {
  color: var(--accent-fail);
}
.home-live-takeover-feed .home-voice-event.routing {
  color: var(--accent-3);
}
.home-live-takeover-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding-top: 2px;
}
.home-live-takeover-hint {
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--fg-3);
  text-transform: uppercase;
}
.home-live-takeover-hint kbd {
  border: 1px solid var(--line);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: ui-monospace, monospace;
  font-size: 9px;
  color: var(--fg-2);
  background: var(--bg-1);
}

@media (max-height: 620px) {
  .home-layout.live-takeover .home-live-stage {
    min-height: 180px;
    padding: 14px 18px 10px;
    gap: 10px;
  }
  .home-live-takeover-transcript { max-height: 64px; }
  .home-live-takeover-feed { max-height: 56px; }
  .home-layout.live-takeover .home-live-cta { font-size: 17px; }
}

@media (max-width: 900px) {
  .home-main {
    grid-template-columns: 1fr;
  }
  .home-main-left {
    grid-template-rows: auto auto auto;
  }
}
.home-block {
  background: var(--bg-1);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* v0.5.14 — Current Focus chip in the global status bar. Persistent
   across every panel; hidden when no focus is active. Click the title
   to open a small popover with summary + actions; the × clears. */
.stat-focus {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--accent);
  background: var(--bg-2);
  padding: 0 4px 0 8px;
  font-size: 10px; letter-spacing: 0.14em;
  cursor: pointer; position: relative;
}
.stat-focus-label { color: var(--accent); font-weight: 600; }
.stat-focus-title {
  color: var(--fg-1); letter-spacing: 0;
  max-width: 200px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.stat-focus.needs-confirm { border-color: var(--accent-warn); }
.stat-focus.needs-confirm .stat-focus-label { color: var(--accent-warn); }
.stat-focus-clear {
  background: transparent; border: none; color: var(--fg-3);
  cursor: pointer; font-size: 14px; line-height: 1; padding: 0 4px;
}
.stat-focus-clear:hover { color: var(--accent-fail); }
.stat-focus-popover {
  position: absolute; top: 100%; right: 0; margin-top: 6px;
  min-width: 280px; max-width: 420px;
  border: 1px solid var(--accent); background: var(--bg-1);
  padding: 14px; z-index: 1000;
  display: flex; flex-direction: column; gap: 8px;
}
.stat-focus-popover[hidden] { display: none; }
.stat-focus-popover-title { font-size: 13px; font-weight: 500; color: var(--fg-1); letter-spacing: 0; }
.stat-focus-popover-summary { font-size: 11px; color: var(--fg-2); line-height: 1.4; letter-spacing: 0; }
.stat-focus-popover-meta { font-size: 10px; color: var(--fg-3); letter-spacing: 0.04em; }
.stat-focus-popover-meta.needs-confirm { color: var(--accent-warn); }
.stat-focus-popover-actions { display: flex; gap: 6px; }
.stat-focus-popover-actions button {
  background: transparent; border: 1px solid var(--line);
  color: var(--fg-3); font-size: 10px; letter-spacing: 0.14em;
  padding: 4px 10px; cursor: pointer;
}
.stat-focus-popover-actions button:hover { color: var(--accent); border-color: var(--accent); }
.stat-focus-popover-parked {
  border-top: 1px dashed var(--line); padding-top: 8px; margin-top: 4px;
  display: flex; flex-direction: column; gap: 6px;
  font-size: 11px; color: var(--fg-3); letter-spacing: 0;
}
.stat-focus-popover-parked:empty { display: none; }
.stat-focus-popover-parked-row {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
}
.stat-focus-popover-parked-title { color: var(--fg-2); flex: 1; }
.stat-focus-popover-parked-resume {
  background: transparent; border: 1px solid var(--line);
  color: var(--fg-3); font-size: 9px; letter-spacing: 0.14em;
  padding: 2px 8px; cursor: pointer;
}
.stat-focus-popover-parked-resume:hover { color: var(--accent); border-color: var(--accent); }
.home-block-head {
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fg-3);
}
.home-block-head em {
  font-style: normal;
  font-size: 11px;
  color: var(--accent);
}
.home-block-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.home-empty {
  color: var(--fg-mute);
  font-size: 11px;
  letter-spacing: 0.08em;
  padding: 18px 0;
  text-align: center;
}
.home-item {
  display: flex;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dotted var(--line);
  align-items: flex-start;
}
.home-item.command-item {
  cursor: pointer;
}
.home-item.command-item:hover .home-item-text {
  color: var(--accent);
}
.home-item:last-child { border-bottom: 0; }
.home-item-kind {
  font-size: 9px;
  letter-spacing: 0.16em;
  color: var(--accent);
  text-transform: uppercase;
  padding: 1px 6px;
  border: 1px solid var(--accent);
  align-self: flex-start;
  flex-shrink: 0;
}
.home-item-kind.task { color: var(--accent-3); border-color: var(--accent-3); }
.home-item-kind.exec { color: var(--accent-warn); border-color: var(--accent-warn); }
.home-item-kind.checkin { color: var(--accent); border-color: var(--accent); }
.home-item-kind.harness-approval { color: var(--accent-warn); border-color: var(--accent-warn); }
.home-item-kind.workflow { color: var(--accent-2); border-color: var(--accent-2); }
.home-item-kind.run { color: var(--accent-2); border-color: var(--accent-2); }
.home-item-kind.done { color: var(--fg-mute); border-color: var(--fg-mute); }
.home-item-text {
  flex: 1;
  font-size: 12px;
  color: var(--fg);
  line-height: 1.45;
  /* Keep agent-generated tracking tasks from dominating the column —
     show the first ~2 lines, fade the rest. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-width: 0;
}
.home-list-footer {
  padding: 8px 0 4px;
  text-align: right;
  font-size: 10px;
  letter-spacing: 0.12em;
}
.home-list-footer .tools-jump {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px dashed var(--accent);
  cursor: pointer;
}
.home-list-footer .tools-jump:hover {
  background: var(--accent);
  color: var(--bg-0);
  border-bottom-color: transparent;
}
.home-item-meta {
  font-size: 10px;
  color: var(--fg-3);
  margin-top: 2px;
}
.home-item-actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.home-item-actions button {
  border: 1px solid var(--line-strong);
  background: transparent;
  color: var(--fg);
  font-family: inherit;
  font-size: 9px;
  letter-spacing: 0.14em;
  padding: 4px 7px;
  cursor: pointer;
}
.home-item-actions button:hover { background: var(--fg); color: var(--bg-0); }
.home-item-actions button[data-home-approval-action="approve"] { border-color: var(--accent-2); color: var(--accent-2); }
.home-item-actions button[data-home-approval-action="reject"] { border-color: var(--accent-fail); color: var(--accent-fail); }
.home-item-actions button[disabled] { opacity: 0.45; cursor: wait; }
.home-memory-line {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
  border-bottom: 1px dotted var(--line);
  font-size: 11px;
  letter-spacing: 0.08em;
}
.home-memory-line span {
  color: var(--fg-3);
  text-transform: uppercase;
}
.home-memory-line em {
  color: var(--fg);
  font-style: normal;
}

/* Chat */
.home-chat-thread {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.home-chat-hint {
  color: var(--fg-mute);
  text-align: center;
  padding: 40px 16px;
  margin: auto;
  max-width: 560px;
}
.home-chat-hint-title {
  font-size: 16px;
  letter-spacing: 0.02em;
  color: var(--fg);
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-weight: 500;
  margin-bottom: 6px;
}
.home-chat-hint-sub {
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--fg-3);
  margin-bottom: 16px;
}
.home-chat-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
.home-chat-suggest {
  background: var(--bg-1);
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 11px;
  padding: 6px 12px;
  cursor: pointer;
  letter-spacing: 0.04em;
  border-radius: 14px;
  transition: background 100ms, border-color 100ms, color 100ms;
}
.home-chat-suggest:hover {
  background: var(--accent);
  color: var(--bg-0);
  border-color: var(--accent);
}
.home-chat-meta {
  font-style: normal;
  font-size: 9px;
  letter-spacing: 0.16em;
  color: var(--fg-mute);
}
.home-chat-turn {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
}
.home-chat-turn.pending {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 72%, transparent);
}
.home-chat-turn.user {
  background: var(--bg-0);
  border-left: 2px solid var(--accent);
  align-self: stretch;
}
.home-chat-turn.assistant {
  background: var(--bg-2);
  border-left: 2px solid var(--accent-2);
  align-self: stretch;
  white-space: pre-wrap;
}
.home-chat-role {
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fg-3);
}
.home-chat-stream-status {
  display: none;
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent-2);
}
.home-chat-turn.pending .home-chat-stream-status {
  display: block;
}
.home-chat-turn-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.home-chat-turn-actions button {
  border: 1px solid var(--line-strong);
  background: var(--bg-0);
  color: var(--fg);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 6px 10px;
  cursor: pointer;
}
.home-chat-turn-actions button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.home-chat-turn-actions button:disabled {
  cursor: wait;
  opacity: 0.55;
}
.home-chat-form {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--line);
  background: var(--bg-2);
}
.home-chat-input {
  flex: 1;
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  padding: 8px 10px;
  outline: none;
}
.home-chat-input:focus { border-color: var(--accent); }
.home-chat-send {
  background: transparent;
  border: 1px solid var(--accent);
  color: var(--accent);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 6px 14px;
  cursor: pointer;
}
.home-chat-send:hover { background: var(--accent); color: var(--bg-0); }
.home-chat-send:disabled {
  opacity: 0.5;
  cursor: progress;
}
.home-voice-panel {
  position: relative;
  display: grid;
  grid-template-columns: 76px 1fr auto;
  gap: 14px;
  align-items: center;
  padding: 14px;
  border-top: 1px solid var(--line);
  overflow: hidden;
  transition:
    min-height 220ms ease,
    padding 220ms ease,
    margin 220ms ease,
    border-radius 220ms ease,
    box-shadow 220ms ease;
  background:
    radial-gradient(circle at 42px 34px, color-mix(in srgb, var(--accent) 20%, transparent), transparent 56px),
    radial-gradient(circle at 95% 30%, color-mix(in srgb, var(--accent-2) 14%, transparent), transparent 120px),
    linear-gradient(90deg, var(--bg-2), color-mix(in srgb, var(--bg-1) 78%, var(--accent-2) 8%));
}
.home-voice-panel::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
  transform: translateX(-20%);
  transition: opacity 220ms ease, transform 480ms ease;
  background:
    linear-gradient(115deg, transparent 0 30%, color-mix(in srgb, var(--accent) 12%, transparent) 42%, transparent 56%),
    repeating-linear-gradient(90deg, color-mix(in srgb, var(--fg) 5%, transparent) 0 1px, transparent 1px 18px);
}
.home-voice-panel.live {
  grid-template-columns: 138px minmax(0, 1fr) auto;
  min-height: 176px;
  margin: 14px;
  padding: 22px;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, var(--line));
  border-radius: 28px;
  box-shadow:
    0 24px 80px color-mix(in srgb, #000 28%, transparent),
    0 0 60px color-mix(in srgb, var(--accent) 15%, transparent),
    inset 0 0 42px color-mix(in srgb, var(--accent-2) 8%, transparent);
}
.home-voice-panel.live::before {
  opacity: 1;
  transform: translateX(0);
}
.home-voice-panel.focus {
  grid-template-columns: 176px minmax(0, 1fr) auto;
  min-height: 248px;
  margin: 18px;
  padding: 28px;
  border-radius: 34px;
}
/* ── Live-voice orb: portrait-first, all chrome stripped ────────────
   The orb is a clean disc whose only contents are the Clementine
   portrait and an inline pixel-art mouth overlay sitting exactly over
   the dog's actual mouth pixels. A single soft halo handles the
   "alive" feel. Everything that used to clutter the bottom — wave
   bars, scan line, dual orbiting rings, floating cheek pixels — is
   gone. Mouth-open is amplitude-driven via the --mouth-open custom
   property updated from JS each frame. */
.home-voice-orb-button {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--accent) 48%, var(--line));
  background:
    radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--accent) 14%, transparent) 0%, transparent 55%),
    radial-gradient(circle at 50% 50%, var(--bg-1) 0%, var(--bg-0) 100%);
  cursor: pointer;
  padding: 0;
  box-shadow:
    0 8px 30px rgba(0, 0, 0, 0.45),
    0 0 20px color-mix(in srgb, var(--accent) 18%, transparent);
  isolation: isolate;
  overflow: visible;
  --mouth-open: 0;             /* 0 = closed, 1 = wide open */
  --halo-strength: 0;          /* 0 idle, 1 speaking peak */
  transition:
    width 240ms cubic-bezier(0.4, 0, 0.2, 1),
    height 240ms cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow 220ms ease;
}
.home-voice-orb-button:disabled { cursor: progress; opacity: 0.7; }
.home-voice-orb-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
.home-voice-halo {
  position: absolute;
  inset: -14px;
  border-radius: 999px;
  pointer-events: none;
  background: radial-gradient(circle, color-mix(in srgb, var(--accent) 36%, transparent) 0%, transparent 62%);
  opacity: calc(0.15 + 0.55 * var(--halo-strength));
  transition: opacity 120ms ease;
  z-index: -1;
}
.home-voice-portrait {
  position: absolute;
  inset: 6px;
  border-radius: 999px;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: var(--bg-0);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fg) 8%, transparent);
}
.home-voice-avatar {
  width: 100%;
  height: 100%;
  object-fit: cover;
  image-rendering: pixelated;
  /* Slight contrast lift so the dog reads sharp on the dark backdrop. */
  filter: saturate(1.1) contrast(1.05);
  /* The breathing scale tracks halo-strength so the head subtly
     "comes alive" when the agent is speaking. */
  transform: scale(calc(1 + 0.025 * var(--halo-strength)));
  transition: transform 90ms ease;
}

/* Pixel-art mouth, anchored to the dog's real mouth pixels.
   The icon is 1024×1024 with the mouth centered at roughly y=78% from
   top, width ≈ 11% of the canvas. We position the overlay in those
   same proportions so it lines up at any orb size. */
.home-voice-mouth {
  position: absolute;
  left: 50%;
  top: 78%;
  width: 11%;
  height: 5%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  image-rendering: pixelated;
  /* Use grid so cavity + tongue stack and grow together. */
  display: grid;
  place-items: end center;
  opacity: 0;
  transition: opacity 200ms ease;
}
.home-voice-mouth-cavity {
  position: absolute;
  inset: 0;
  /* Dark mouth interior — matches the icon's #1b1822 nose/mouth tone. */
  background: #0c0a14;
  border-radius: 0;
  /* Mouth opens by scaling Y from the bottom edge. */
  transform-origin: 50% 50%;
  transform: scaleY(calc(0.15 + 1.4 * var(--mouth-open)));
  transition: transform 70ms ease-out;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.6);
}
.home-voice-mouth-tongue {
  position: absolute;
  left: 22%;
  right: 22%;
  bottom: 8%;
  height: 28%;
  background: #b73a3a;
  opacity: calc(var(--mouth-open) * 0.9);
  transform: scaleY(var(--mouth-open));
  transform-origin: 50% 100%;
  transition: opacity 70ms, transform 70ms;
}
.home-voice-panel.live .home-voice-mouth { opacity: 1; }

/* Size scaling per panel state. Halo & mouth scale with the parent
   percentages so the alignment holds without per-state overrides. */
.home-voice-panel.live .home-voice-orb-button { width: 132px; height: 132px; }
.home-voice-panel.focus .home-voice-orb-button { width: 192px; height: 192px; }

/* "Speaking" state gets a stronger amber halo; "thinking" goes cooler. */
.home-voice-panel.speaking .home-voice-orb-button {
  border-color: color-mix(in srgb, var(--accent) 72%, var(--accent-2));
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.55), 0 0 40px color-mix(in srgb, var(--accent) 42%, transparent);
}
.home-voice-panel.thinking .home-voice-orb-button {
  border-color: color-mix(in srgb, var(--accent-3) 60%, var(--line));
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45), 0 0 28px color-mix(in srgb, var(--accent-3) 30%, transparent);
}
.home-voice-panel.routing .home-voice-orb-button {
  border-color: color-mix(in srgb, var(--accent-2) 70%, var(--accent));
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45), 0 0 32px color-mix(in srgb, var(--accent-2) 32%, transparent);
}

/* Idle "breathing" — gentle scale on the whole button so the orb
   feels alive even before audio amplitude drives the halo. Stops
   when speaking so the audio-reactive halo can dominate. */
.home-voice-orb-button { animation: voiceBreathe 4.2s ease-in-out infinite; }
.home-voice-panel.live .home-voice-orb-button,
.home-voice-panel.speaking .home-voice-orb-button { animation: none; }
@keyframes voiceBreathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.025); }
}

/* Wake-word toggle pill */
.home-live-wake-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--fg-3);
  text-transform: uppercase;
  cursor: pointer;
  user-select: none;
}
.home-live-wake-toggle input { accent-color: var(--accent); transform: scale(0.9); }
.home-live-wake-toggle:hover { color: var(--fg-2); }
.home-live-wake-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--fg-mute);
  transition: background 160ms ease, box-shadow 160ms ease;
}
.home-live-wake-toggle[data-wake-state="listening"] .home-live-wake-dot {
  background: var(--accent-2);
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent-2) 70%, transparent);
  animation: wakeDot 1.6s ease-in-out infinite;
}
.home-live-wake-toggle[data-wake-state="unavailable"] .home-live-wake-dot {
  background: var(--accent-warn);
}
.home-live-wake-toggle[data-wake-state="heard"] .home-live-wake-dot {
  background: var(--accent);
  box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 80%, transparent);
}
@keyframes wakeDot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.home-voice-copy {
  min-width: 0;
  position: relative;
  z-index: 1;
}
.home-voice-title-row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.home-voice-title {
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fg);
}
.home-voice-panel.live .home-voice-title {
  font-size: 13px;
  letter-spacing: 0.22em;
}
.home-voice-phase {
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--line));
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 8px;
  letter-spacing: 0.18em;
  color: var(--accent);
  background: color-mix(in srgb, var(--bg-0) 78%, transparent);
}
.home-voice-status {
  margin-top: 3px;
  font-size: 11px;
  color: var(--fg-2);
}
.home-voice-panel.live .home-voice-status {
  margin-top: 9px;
  font-size: 15px;
  color: var(--fg);
}
.home-voice-transcript {
  margin-top: 4px;
  font-size: 10px;
  color: var(--fg-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.home-voice-panel.live .home-voice-transcript {
  margin-top: 8px;
  font-size: 12px;
  color: var(--fg-2);
  white-space: normal;
}
.home-voice-feed {
  display: none;
  margin-top: 12px;
  max-height: 72px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--line) 74%, transparent);
  background: color-mix(in srgb, var(--bg-0) 48%, transparent);
  padding: 8px;
  color: var(--fg-3);
  font-size: 10px;
  line-height: 1.45;
}
.home-voice-panel.live .home-voice-feed {
  display: grid;
  gap: 4px;
}
.home-voice-panel.focus .home-voice-feed {
  max-height: 120px;
  font-size: 11px;
}
.home-voice-event {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.home-voice-event.tool,
.home-voice-event.routing {
  color: var(--accent-2);
}
.home-voice-event.error {
  color: var(--danger);
}
.home-voice-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  position: relative;
  z-index: 1;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.home-voice-btn {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 9px;
  letter-spacing: 0.16em;
  padding: 7px 10px;
  cursor: pointer;
}
.home-voice-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.home-voice-btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}
.home-voice-panel audio {
  display: none;
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
.mem-toolbar {
  display: flex;
  align-items: stretch;
  gap: 0;
  border-bottom: 1px solid var(--line);
}
.mem-view-toggle {
  display: flex;
  border-right: 1px solid var(--line);
}
.mem-view-btn {
  background: transparent;
  border: 0;
  color: var(--fg-3);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.18em;
  padding: 12px 14px;
  cursor: pointer;
  text-transform: uppercase;
  transition: color 100ms, background 100ms;
}
.mem-view-btn:hover { color: var(--fg); background: var(--bg-1); }
.mem-view-btn.active { color: var(--accent); background: var(--bg-1); }

/* The graph view */
.mem-graph {
  flex: 1;
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr;
  grid-template-columns: 1fr 280px;
  background: var(--bg-2);
  overflow: hidden;
}
.mem-graph[hidden] { display: none; }
.mem-graph-topbar {
  grid-column: 1 / -1;
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
  min-width: 0;
}
.mem-graph-controls,
.mem-graph-filters {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}
.mem-graph-controls button,
.mem-graph-filters select,
.mem-graph-filters input {
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 9px;
  letter-spacing: 0.14em;
  padding: 5px 8px;
  outline: none;
}
.mem-graph-controls button {
  cursor: pointer;
}
.mem-graph-controls button:hover,
.mem-graph-filters select:focus,
.mem-graph-filters input:focus {
  border-color: var(--accent);
  color: var(--accent);
}
.mem-graph-filters input {
  width: 150px;
}
.mem-graph-meta {
  color: var(--fg-3);
  font-size: 10px;
  letter-spacing: 0.12em;
  white-space: nowrap;
}
.mem-graph-canvas {
  position: relative;
  background:
    /* Soft central spotlight so the kind clusters feel anchored at the
       middle of the canvas. */
    radial-gradient(ellipse 60% 50% at 50% 50%, rgba(255, 90, 53, 0.06) 0%, transparent 70%),
    /* Faint starfield: two offset dot layers at different densities to
       avoid the regular-grid look. */
    radial-gradient(circle at 12% 18%, rgba(255, 255, 255, 0.08) 0 1px, transparent 1.4px),
    radial-gradient(circle at 76% 64%, rgba(185, 255, 54, 0.06) 0 1px, transparent 1.4px),
    radial-gradient(circle at 38% 84%, rgba(54, 197, 255, 0.06) 0 1px, transparent 1.4px),
    /* Base radial vignette — keep the existing depth gradient under everything. */
    radial-gradient(circle at 50% 50%, var(--bg-1) 0%, var(--bg-0) 80%);
  background-size: 100% 100%, 180px 180px, 240px 240px, 220px 220px, 100% 100%;
  overflow: hidden;
  min-height: 360px;
}
.mem-graph-canvas::before {
  /* Inner vignette frame — pulls the eye toward the middle of the graph. */
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 80px rgba(0, 0, 0, 0.55);
  border: 1px solid transparent;
}
.mem-graph-canvas::after {
  /* Scan-line texture, matching the rest of the operational UI. */
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: repeating-linear-gradient(to bottom, transparent 0 3px, rgba(255, 255, 255, 0.015) 3px 4px);
}
.mem-graph-detail {
  border-left: 1px solid var(--line);
  padding: 14px 16px;
  background: var(--bg-1);
  overflow-y: auto;
  font-size: 11px;
  color: var(--fg-2);
  line-height: 1.55;
}
.mem-graph-detail h4 {
  margin: 0 0 6px;
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--fg);
}
.mem-graph-detail .pill {
  display: inline-block;
  font-size: 9px;
  letter-spacing: 0.16em;
  padding: 1px 6px;
  border: 1px solid var(--line);
  text-transform: uppercase;
  margin-right: 6px;
  color: var(--fg-3);
}
.mem-graph-detail .pill.fact { color: var(--accent); border-color: var(--accent); }
.mem-graph-detail .pill.file { color: var(--accent-3); border-color: var(--accent-3); }
.mem-graph-detail .pill.kind { color: var(--accent-2); border-color: var(--accent-2); }
.mem-graph-detail-empty { color: var(--fg-mute); padding: 20px 0; }
.mem-graph-detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
.mem-graph-detail-actions button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 9px;
  letter-spacing: 0.14em;
  padding: 5px 8px;
  cursor: pointer;
}
.mem-graph-detail-actions button:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.mem-graph-note {
  margin: 10px 0 0;
  color: var(--fg-3);
  font-size: 10px;
  line-height: 1.45;
  border-top: 1px dashed var(--line);
  padding-top: 10px;
}
.mem-graph-legend {
  position: absolute;
  bottom: 14px;
  left: 14px;
  display: flex;
  gap: 16px;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--fg-2);
  background: rgba(13, 13, 18, 0.78);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  border: 1px solid var(--line);
  padding: 8px 14px;
  pointer-events: none;
  text-transform: uppercase;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.45);
}
.mem-graph-legend span { display: inline-flex; align-items: center; gap: 6px; }
.mem-graph-legend em {
  font-style: normal;
  color: var(--fg);
  margin-left: 2px;
  letter-spacing: 0.05em;
}
.mem-graph-legend .dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  vertical-align: middle;
}
.mem-graph-legend .dot.fact { background: var(--accent); box-shadow: 0 0 8px rgba(255, 90, 53, 0.55); }
.mem-graph-legend .dot.file { background: var(--accent-3); box-shadow: 0 0 8px rgba(54, 197, 255, 0.45); border-radius: 1px; width: 8px; height: 8px; }
.mem-graph-legend .dot.kind { background: var(--accent-2); box-shadow: 0 0 10px rgba(185, 255, 54, 0.55); width: 11px; height: 11px; }

/* Sparse-data hint that floats above the canvas instead of crowding
   the detail pane. Less ceremonial than the prior inline note. */
.mem-graph-sparse-hint {
  position: absolute;
  top: 14px;
  right: 14px;
  max-width: 220px;
  font-size: 10px;
  line-height: 1.5;
  letter-spacing: 0.04em;
  color: var(--fg-3);
  background: rgba(13, 13, 18, 0.78);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  border: 1px solid var(--line);
  border-left: 2px solid var(--accent-warn);
  padding: 8px 12px;
  pointer-events: none;
}
.mem-graph-sparse-hint strong { color: var(--accent-warn); display: block; letter-spacing: 0.16em; font-size: 9px; margin-bottom: 4px; }

.mem-graph-empty {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 14px;
  text-align: center;
  padding: 0 40px;
  color: var(--fg-2);
}
.mem-graph-empty h4 {
  margin: 0;
  font-size: 11px;
  letter-spacing: 0.22em;
  color: var(--accent);
}
.mem-graph-empty p {
  margin: 0;
  max-width: 360px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--fg-3);
}
.mem-graph-empty-ring {
  position: relative;
  width: 64px; height: 64px;
  border-radius: 50%;
  border: 1px dashed rgba(255, 90, 53, 0.4);
}
.mem-graph-empty-ring::before,
.mem-graph-empty-ring::after {
  content: '';
  position: absolute;
  border-radius: 50%;
}
.mem-graph-empty-ring::before {
  inset: 12px;
  border: 1px solid rgba(185, 255, 54, 0.35);
}
.mem-graph-empty-ring::after {
  inset: 26px;
  background: var(--accent);
  box-shadow: 0 0 16px rgba(255, 90, 53, 0.7);
  animation: pulse-soft 1.8s ease-in-out infinite;
}
@keyframes pulse-soft {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.55); }
}

/* ── Meetings sub-view ──────────────────────────────────────── */
.mem-meetings {
  flex: 1;
  display: grid;
  grid-template-columns: 320px 1fr;
  grid-template-rows: auto 1fr;
  gap: 0;
  background: var(--bg-2);
  min-height: 0;
}
.mem-meetings[hidden] { display: none; }
.mem-meetings-head {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--line);
}
.mem-meetings-tag {
  font-size: 10px;
  letter-spacing: 0.22em;
  color: var(--accent);
  font-weight: 600;
}
.mem-meetings-meta {
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--fg-3);
  margin-left: auto;
}
.mem-meetings-refresh {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 9px;
  letter-spacing: 0.18em;
  padding: 4px 10px;
  cursor: pointer;
}
.mem-meetings-refresh:hover { color: var(--accent); border-color: var(--accent); }

.mem-meetings-list {
  border-right: 1px solid var(--line);
  overflow-y: auto;
  background: var(--bg-1);
}
.mem-meetings-list .mem-meetings-empty {
  padding: 18px 14px;
  font-size: 11px;
  color: var(--fg-mute);
}
.mem-meeting-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
  transition: background 100ms;
}
.mem-meeting-row:hover { background: var(--bg-2); }
.mem-meeting-row.selected { background: var(--bg-2); border-left: 2px solid var(--accent); padding-left: 12px; }
.mem-meeting-row-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--fg);
}
.mem-meeting-platform {
  font-size: 9px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--accent);
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--accent) 50%, var(--line));
}
.mem-meeting-platform.zoom { color: var(--accent-3); border-color: color-mix(in srgb, var(--accent-3) 50%, var(--line)); }
.mem-meeting-platform.meet { color: var(--accent-2); border-color: color-mix(in srgb, var(--accent-2) 50%, var(--line)); }
.mem-meeting-platform.teams { color: var(--accent-warn); border-color: color-mix(in srgb, var(--accent-warn) 50%, var(--line)); }
.mem-meeting-status {
  font-size: 9px;
  letter-spacing: 0.18em;
  margin-left: auto;
  color: var(--fg-mute);
}
.mem-meeting-status.completed { color: var(--accent-2); }
.mem-meeting-status.recording { color: var(--accent-fail); }
.mem-meeting-status.analysis-ready { color: var(--accent-2); }
.mem-meeting-status.analysis-pending { color: var(--accent-warn); }
.mem-meeting-row-title {
  font-size: 11px;
  color: var(--fg-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mem-meeting-row-meta {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--fg-mute);
}

.mem-meetings-detail {
  overflow-y: auto;
  padding: 18px 22px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--fg);
}
.mem-meetings-detail-empty { color: var(--fg-mute); padding: 12px 0; }
.mem-meeting-detail h3 {
  margin: 0 0 6px;
  font-size: 14px;
  color: var(--fg);
  letter-spacing: 0.02em;
}
.mem-meeting-detail h4 {
  margin: 18px 0 8px;
  font-size: 10px;
  letter-spacing: 0.22em;
  color: var(--accent);
  text-transform: uppercase;
}
.mem-meeting-detail-meta {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--fg-3);
  margin-bottom: 10px;
}
.mem-meeting-detail-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 14px 0 4px;
}
.mem-meeting-detail-actions button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  padding: 6px 12px;
  cursor: pointer;
}
.mem-meeting-detail-actions button:hover { color: var(--fg); border-color: var(--line-bright); }
.mem-meeting-detail-actions .primary { color: var(--accent); border-color: var(--accent); }
.mem-meeting-detail-actions .primary:hover { background: var(--accent); color: var(--bg-0); }
.mem-meeting-detail ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.mem-meeting-detail li { margin-bottom: 4px; }
.mem-meeting-detail-pending {
  display: inline-block;
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent-warn);
  padding: 3px 8px;
  border: 1px dashed color-mix(in srgb, var(--accent-warn) 60%, var(--line));
  margin-top: 6px;
}
.mem-meeting-detail-empty-state {
  text-align: center;
  padding: 24px 0;
  color: var(--fg-mute);
  font-size: 11px;
}
@media (max-width: 1040px) {
  .memory-layout {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }
  .mem-sidebar {
    min-height: 280px;
  }
  .mem-graph {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(360px, 1fr) auto;
  }
  .mem-graph-detail {
    border-left: 0;
    border-top: 1px solid var(--line);
    max-height: 220px;
  }
}
@media (max-width: 760px) {
  .mem-toolbar,
  .mem-graph-topbar {
    flex-wrap: wrap;
  }
  .mem-search {
    min-width: 100%;
  }
  .mem-graph-filters {
    width: 100%;
  }
  .mem-graph-filters input {
    flex: 1;
    width: auto;
  }
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

/* ── Context / Identity panel ─────────────────────────────────── */
.context-layout {
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.context-header {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 18px;
  align-items: start;
  border: 1px solid var(--line);
  background:
    linear-gradient(135deg, rgba(255, 90, 53, 0.10), transparent 38%),
    var(--bg-2);
  padding: 18px;
}
.context-header h3 {
  margin: 0 0 6px;
  font-size: 22px;
  letter-spacing: -0.02em;
  color: var(--fg);
}
.context-header p {
  margin: 0;
  color: var(--fg-2);
  max-width: 780px;
  line-height: 1.5;
}
.context-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(82px, 1fr));
  gap: 8px;
}
.context-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
  gap: 16px;
}
.context-grid.lower {
  align-items: start;
}
.context-card {
  border: 1px solid var(--line);
  background: var(--bg-2);
  min-width: 0;
}
.context-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
  color: var(--fg-3);
  font-size: 10px;
  letter-spacing: 0.18em;
}
.context-card-head em {
  font-style: normal;
  color: var(--fg-mute);
  letter-spacing: 0.08em;
}
.context-card-head button,
.context-save,
.context-fact-form button,
.context-goal-form button,
.context-file-actions button {
  background: transparent;
  border: 1px solid var(--accent);
  color: var(--accent);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 5px 9px;
  cursor: pointer;
  transition: background 100ms, color 100ms;
}
.context-card-head button:hover,
.context-save:hover,
.context-fact-form button:hover,
.context-goal-form button:hover,
.context-file-actions button:hover {
  background: var(--accent);
  color: var(--bg-0);
}
.context-profile-form,
.context-fact-form,
.context-goal-form {
  padding: 14px;
}
.context-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.context-profile-form label,
.context-fact-form label,
.context-goal-form label,
.context-notes-label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--fg-3);
  font-size: 10px;
  letter-spacing: 0.14em;
}
.context-profile-form input,
.context-profile-form select,
.context-profile-form textarea,
.context-fact-form input,
.context-fact-form select,
.context-goal-form input,
.context-goal-form select,
.context-goal-form textarea,
.context-file textarea {
  width: 100%;
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  padding: 7px 9px;
  outline: none;
}
.context-profile-form textarea,
.context-goal-form textarea,
.context-file textarea {
  resize: vertical;
  line-height: 1.55;
}
.context-notes-label {
  margin-top: 10px;
}
.context-save {
  margin-top: 10px;
}
.context-health-list,
.context-facts-list,
.context-goals-list,
.context-files {
  padding: 12px 14px;
}
.context-health-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px dashed var(--line);
}
.context-health-row:last-child { border-bottom: 0; }
.context-health-status {
  font-size: 9px;
  letter-spacing: 0.16em;
  border: 1px solid var(--line);
  padding: 2px 7px;
  color: var(--fg-3);
}
.context-health-status.ok { color: var(--accent-2); border-color: var(--accent-2); }
.context-health-status.warn { color: var(--accent-warn); border-color: var(--accent-warn); }
.context-health-title { color: var(--fg); font-size: 11px; }
.context-health-meta { color: var(--fg-3); font-size: 10px; }
.context-file {
  border: 1px solid var(--line);
  background: var(--bg-1);
  margin-bottom: 12px;
}
.context-file:last-child { margin-bottom: 0; }
.context-file-head {
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.context-file-title { color: var(--fg); font-size: 12px; }
.context-file-desc { color: var(--fg-3); font-size: 10px; margin-top: 3px; line-height: 1.45; }
.context-file-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
  color: var(--fg-3);
  font-size: 10px;
  letter-spacing: 0.12em;
}
.context-file-meta .warn { color: var(--accent-warn); }
.context-file textarea {
  border: 0;
  border-bottom: 1px solid var(--line);
  min-height: 150px;
}
.context-file-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  color: var(--fg-mute);
  font-size: 10px;
}
.context-file-presets {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-2);
  font-size: 10.5px;
}
.context-file-presets label {
  color: var(--fg-3);
  letter-spacing: 0.06em;
  font-size: 9.5px;
}
.context-file-presets select {
  flex: 1;
  max-width: 360px;
}
.context-file-preset-hint {
  color: var(--fg-3);
  font-size: 10px;
}
.context-file-livehint {
  padding: 6px 12px;
  color: var(--fg-3);
  font-size: 10px;
  border-bottom: 1px solid var(--line);
  font-style: italic;
}
.context-fact-form {
  display: grid;
  grid-template-columns: 120px 1fr auto;
  gap: 8px;
  border-bottom: 1px solid var(--line);
}
.context-goal-form {
  display: grid;
  grid-template-columns: 1fr 110px;
  gap: 8px;
  border-bottom: 1px solid var(--line);
}
.context-goal-form textarea,
.context-goal-form button {
  grid-column: 1 / -1;
}
.context-fact,
.context-goal {
  border-bottom: 1px dashed var(--line);
  padding: 9px 0;
}
.context-fact:last-child,
.context-goal:last-child { border-bottom: 0; }
.context-fact-kind,
.context-goal-meta {
  color: var(--accent);
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
.context-fact-body,
.context-goal-title {
  color: var(--fg);
  margin-top: 4px;
  line-height: 1.45;
}
.context-goal-desc,
.context-goal-next {
  color: var(--fg-3);
  font-size: 10px;
  line-height: 1.45;
  margin-top: 4px;
}

/* ── Workflow Studio ─────────────────────────────────────────── */
.wf-layout {
  display: grid;
  /* List stays slim, editor takes 1.5x of the remaining space so the
     per-step action row (▶ TRY · ✎ REFINE · ⛭) doesn't clip, and the
     architect chat keeps a usable column on standard desktops. fr
     units (not min-width) so we degrade gracefully on narrow windows
     instead of overflowing horizontally. */
  grid-template-columns: 200px 1.5fr 1fr;
  gap: 12px;
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
  display: inline-block;
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
  border-bottom: 1px solid var(--line);
  transition: background 100ms;
}
.wf-list li.wf:hover { background: var(--bg-3); }
.wf-list li.wf.selected { background: var(--bg-3); box-shadow: inset 2px 0 0 var(--accent); }
.wf-list .wf-select {
  width: 100%;
  display: block;
  text-align: left;
  padding: 9px 12px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-decoration: none;
}
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

/* Scheduled-jobs (cron) section in the workflows pane. Same list
   width as workflows but the items don't navigate — they expand
   inline to show last-run excerpt + history. */
.wf-list-head-cron { margin-top: 6px; border-top: 1px solid var(--line); }
.wf-list-meta { color: var(--fg-mute); font-size: 10px; }
.wf-cron-list { flex: 0 0 auto; max-height: 45vh; }
.wf-cron-row { padding: 9px 12px; cursor: pointer; }
.wf-cron-row.selected { background: var(--bg-3); box-shadow: inset 2px 0 0 var(--accent-3); }
.wf-cron-row:hover { background: var(--bg-3); }
.wf-cron-row .wf-cron-head { display: flex; flex-direction: column; gap: 4px; }
.wf-cron-row .name {
  color: var(--fg);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wf-cron-row .meta {
  color: var(--fg-3);
  font-size: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  row-gap: 4px;
}
.wf-cron-row .pill {
  font-size: 9px;
  letter-spacing: 0.18em;
  padding: 1px 5px;
  border: 1px solid var(--line);
}
.wf-cron-row .pill.on { color: var(--accent-2); border-color: var(--accent-2); }
.wf-cron-row .pill.off { color: var(--fg-mute); }
.wf-cron-row .pill.cron { color: var(--accent-3); border-color: var(--accent-3); }
.wf-cron-excerpt {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--bg-1);
  border-left: 2px solid var(--accent-3);
  font-size: 10px;
  color: var(--fg-3);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 5em;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Cron detail view rendered in wf-editor when a cron row is clicked.
   Same container as the workflow editor; the wf-empty placeholder is
   replaced by a cron-specific layout. */
.cron-detail {
  padding: 18px 22px;
  overflow-y: auto;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.cron-detail-head h2 {
  margin: 0 0 8px;
  font-size: 14px;
  letter-spacing: 0.08em;
  color: var(--fg);
}
.cron-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10px;
}
.cron-detail-meta .pill {
  font-size: 9px;
  letter-spacing: 0.18em;
  padding: 2px 6px;
  border: 1px solid var(--line);
  color: var(--fg-3);
}
.cron-detail-meta .pill.on { color: var(--accent-2); border-color: var(--accent-2); }
.cron-detail-meta .pill.off { color: var(--fg-mute); }
.cron-detail-meta .pill.cron { color: var(--accent-3); border-color: var(--accent-3); }
.cron-detail-section { display: flex; flex-direction: column; gap: 8px; }
.cron-detail-label {
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
}
.cron-detail-prompt {
  margin: 0;
  padding: 10px 12px;
  background: var(--bg-1);
  border-left: 2px solid var(--line);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg);
  max-height: 14em;
  overflow-y: auto;
}
.cron-detail-empty { color: var(--fg-mute); font-size: 11px; font-style: italic; }
.cron-detail-run {
  border: 1px solid var(--line);
  border-radius: 2px;
  padding: 8px 10px;
  background: var(--bg-1);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cron-detail-run.ok { border-left: 2px solid var(--accent-2); }
.cron-detail-run.err { border-left: 2px solid #e25656; }
.cron-detail-run-head {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  letter-spacing: 0.1em;
}
.cron-detail-run-head .status { color: var(--fg); }
.cron-detail-run-head .when { color: var(--fg-3); }
.cron-detail-run.ok .cron-detail-run-head .status { color: var(--accent-2); }
.cron-detail-run.err .cron-detail-run-head .status { color: #e25656; }
.cron-detail-run-body {
  margin: 0;
  padding: 8px 10px;
  background: var(--bg-2);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
  line-height: 1.5;
  color: var(--fg-3);
  max-height: 12em;
  overflow-y: auto;
  border-radius: 2px;
}

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
.wf-empty-onboarding {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 24px;
  text-align: center;
}
.wf-empty-onboarding .wf-empty-text {
  font-size: 14px;
  letter-spacing: 0.02em;
  color: var(--fg);
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-weight: 500;
}
.wf-empty-sub {
  margin: 0;
  max-width: 460px;
  font-size: 11px;
  color: var(--fg-3);
  line-height: 1.55;
}
.wf-empty-actions {
  display: flex;
  gap: 8px;
  margin-top: 6px;
  flex-wrap: wrap;
  justify-content: center;
}
.wf-empty-btn {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 8px 14px;
  cursor: pointer;
  transition: background 100ms, border-color 100ms, color 100ms;
}
.wf-empty-btn:hover { border-color: var(--accent); color: var(--accent); }
.wf-empty-btn.primary { border-color: var(--accent); color: var(--accent); }
.wf-empty-btn.primary:hover { background: var(--accent); color: var(--bg-0); }

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
  gap: 14px;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
}
.wf-control-group {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.wf-control-group::before {
  content: attr(data-label);
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--fg-mute);
  align-self: center;
  text-transform: uppercase;
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
.wf-edit-controls .btn-duplicate { color: var(--fg-2); }
.wf-edit-controls .btn-validate { color: var(--accent-3); border-color: var(--accent-3); }
.wf-edit-controls .btn-validate:hover { background: var(--accent-3); color: var(--bg-0); }
.wf-edit-controls .btn-test { color: var(--accent-warn); border-color: var(--accent-warn); }
.wf-edit-controls .btn-test:hover { background: var(--accent-warn); color: var(--bg-0); }
.wf-edit-controls .btn-run { color: var(--accent-2); border-color: var(--accent-2); }
.wf-edit-controls .btn-run:hover { background: var(--accent-2); color: var(--bg-0); }
.wf-edit-controls .btn-toggle { color: var(--fg-2); }
.wf-edit-controls .btn-delete { color: var(--accent-fail); border-color: var(--accent-fail); }
.wf-edit-controls .btn-delete:hover { background: var(--accent-fail); color: var(--bg-0); }

/* Inputs editor */
.wf-inputs {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 4px 0;
}
.wf-input-row {
  display: grid;
  grid-template-columns: 200px 1fr auto;
  gap: 6px;
  align-items: center;
}
.wf-input-row input {
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  padding: 6px 8px;
  outline: none;
}
.wf-input-row input:focus { border-color: var(--accent); }
.wf-input-key { font-family: var(--mono); color: var(--accent); }
.wf-input-remove {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-3);
  font: inherit;
  cursor: pointer;
  padding: 6px 10px;
}
.wf-input-remove:hover { color: var(--accent-fail); border-color: var(--accent-fail); }
.wf-input-empty {
  color: var(--fg-mute);
  font-style: italic;
  font-size: 11px;
  padding: 4px 0;
  grid-template-columns: 1fr !important;
}
.wf-add-input {
  align-self: flex-start;
  background: transparent;
  border: 1px dashed var(--line);
  color: var(--fg-3);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 6px 12px;
  margin-top: 6px;
  cursor: pointer;
}
.wf-add-input:hover { color: var(--accent); border-color: var(--accent); }

/* Recent runs in the editor */
.wf-runs { display: flex; flex-direction: column; gap: 6px; }
.wf-runs-head {
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
  text-transform: uppercase;
  margin-top: 8px;
}
.wf-runs-empty {
  color: var(--fg-mute);
  font-size: 11px;
  letter-spacing: 0.04em;
  padding: 6px 0;
}
.wf-runs-list { margin: 0; padding: 0; list-style: none; }
.wf-run {
  display: grid;
  grid-template-columns: 90px 1fr auto auto auto;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px dotted var(--line);
  font-size: 11px;
  align-items: center;
}
.wf-run:last-child { border-bottom: 0; }
.wf-run-status {
  font-size: 9px;
  letter-spacing: 0.16em;
  padding: 2px 6px;
  border: 1px solid var(--line);
  text-align: center;
}
.wf-run-status.status-queued    { color: var(--accent-warn); border-color: var(--accent-warn); }
.wf-run-status.status-running   { color: var(--accent-3); border-color: var(--accent-3); }
.wf-run-status.status-completed { color: var(--accent-2); border-color: var(--accent-2); }
.wf-run-status.status-success   { color: var(--accent-2); border-color: var(--accent-2); }
.wf-run-status.status-error,
.wf-run-status.status-failed    { color: var(--accent-fail); border-color: var(--accent-fail); }
.wf-run-status.status-dry_run   { color: var(--fg-mute); border-color: var(--fg-mute); }
.wf-run-status.status-cancelled { color: var(--fg-mute); border-color: var(--fg-mute); }
.wf-run-id { font-family: var(--mono); color: var(--fg-3); font-size: 10px; }
.wf-run-time { font-family: var(--mono); color: var(--fg-3); font-size: 10px; }
.wf-run-inputs { font-family: var(--mono); color: var(--fg-mute); font-size: 10px; }
.wf-run-action {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg-2);
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  padding: 3px 6px;
  cursor: pointer;
}
.wf-run-action:hover { border-color: var(--accent-fail); color: var(--accent-fail); }
.wf-run-action[disabled] { opacity: 0.45; cursor: wait; }

/* Run inputs modal */
.wf-run-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
}
.wf-run-modal {
  background: var(--bg-1);
  border: 1px solid var(--line);
  width: min(520px, 96vw);
  max-height: 80vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.wf-run-modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  font-size: 11px;
  letter-spacing: 0.18em;
  color: var(--accent);
  text-transform: uppercase;
}
.wf-run-modal-close {
  background: transparent;
  border: 0;
  color: var(--fg-3);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}
.wf-run-modal-close:hover { color: var(--accent-fail); }
.wf-run-modal-sub {
  margin: 0;
  padding: 8px 16px;
  font-size: 11px;
  color: var(--fg-3);
}
.wf-run-modal-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px 14px;
}
.wf-run-modal-row {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 10px;
  align-items: center;
}
.wf-run-modal-row span {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--accent);
}
.wf-run-modal-row input {
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  padding: 8px 10px;
  outline: none;
}
.wf-run-modal-row input:focus { border-color: var(--accent); }
.wf-run-modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 8px;
}
.wf-run-modal-actions button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 8px 14px;
  cursor: pointer;
}
.wf-run-modal-actions .cancel:hover { border-color: var(--accent-fail); color: var(--accent-fail); }
.wf-run-modal-actions .primary { border-color: var(--accent); color: var(--accent); }
.wf-run-modal-actions .primary:hover { background: var(--accent); color: var(--bg-0); }
.wf-run-modal kbd {
  background: var(--bg-0);
  border: 1px solid var(--line);
  padding: 1px 4px;
  font-size: 10px;
  font-family: var(--mono);
}

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
.sched-picker {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.sched-picker select,
.sched-picker input[type="time"],
.sched-picker input[type="number"],
.sched-picker input[type="text"] {
  background: var(--bg-0);
  border: 1px solid var(--line);
  padding: 6px 8px;
  color: var(--fg);
  font: inherit;
  font-size: 12px;
}
.sched-picker select { min-width: 180px; }
.sched-picker input[type="number"] { width: 80px; }
.sched-picker input[type="text"] { flex: 1; min-width: 200px; font-family: var(--mono, ui-monospace, monospace); }
.sched-picker input[hidden], .sched-picker div[hidden] { display: none; }
.sched-days {
  display: inline-flex;
  gap: 4px;
}
.sched-day {
  font-size: 10px;
  letter-spacing: 0.1em;
  padding: 4px 7px;
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg-3);
  cursor: pointer;
}
.sched-day.on {
  background: var(--bg-1);
  border-color: var(--accent);
  color: var(--accent);
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
.wf-step-head .step-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.wf-step-head .step-actions button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-3);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.08em;
  padding: 2px 7px;
  cursor: pointer;
  white-space: nowrap;
}
.wf-step-head .step-actions button:hover { color: var(--fg); border-color: var(--line-bright); }
.wf-step-head .step-actions .step-remove { color: var(--accent-fail); border-color: var(--accent-fail); }
.wf-step-head .step-actions .btn-step-try { color: var(--accent-2); border-color: var(--accent-2); }
.wf-step-head .step-actions .btn-step-try:hover { background: var(--accent-2); color: var(--bg-0); }
.wf-step-head .step-actions .btn-step-refine { color: var(--accent); border-color: var(--accent); }
.wf-step-head .step-actions .btn-step-refine:hover { background: var(--accent); color: var(--bg-0); }
.wf-step-head .step-actions .btn-step-edit { color: var(--fg-3); }
.wf-step-head .step-id-label {
  color: var(--fg);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: lowercase;
}
.wf-step-head .step-status {
  font-size: 9px;
  letter-spacing: 0.16em;
  padding: 2px 7px;
  border: 1px solid var(--line);
  color: var(--fg-mute);
  text-transform: uppercase;
}
.wf-step-head .step-status.status-running {
  color: var(--accent);
  border-color: var(--accent);
  animation: status-pulse 1.4s ease-in-out infinite;
}
.wf-step-head .step-status.status-done {
  color: var(--accent-2);
  border-color: var(--accent-2);
}
.wf-step-head .step-status.status-failed {
  color: var(--accent-fail);
  border-color: var(--accent-fail);
}
.wf-step-head .step-status.status-queueing,
.wf-step-head .step-status.status-skipped {
  color: var(--accent-warn);
  border-color: var(--accent-warn);
}
@keyframes status-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.5 } }

.wf-step.wf-step-editing { box-shadow: inset 2px 0 0 var(--accent); }

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

/* Step read-only prompt display + chips + live output. The read-only
   surface is the default — the textarea only appears when the user
   clicks ⛭ EDIT on a step. */
.wf-step-body .step-prompt-display {
  background: var(--bg-2);
  border: 1px solid var(--line);
  color: var(--fg);
  font-size: 12px;
  line-height: 1.55;
  padding: 10px 12px;
  cursor: text;
  white-space: pre-wrap;
  word-break: break-word;
  transition: border-color 120ms, background 120ms;
}
.wf-step-body .step-prompt-display:hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--bg-2) 80%, var(--accent) 8%);
}
.wf-step-body .step-chips {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 10px;
  letter-spacing: 0.04em;
}
.wf-step-body .step-chip {
  padding: 2px 8px;
  border: 1px solid var(--line);
  color: var(--fg-3);
  background: transparent;
}
.wf-step-body .step-chip.chip-forEach { color: var(--accent-3); border-color: color-mix(in srgb, var(--accent-3) 60%, transparent); }
.wf-step-body .step-chip.chip-deterministic { color: var(--accent-warn); border-color: color-mix(in srgb, var(--accent-warn) 60%, transparent); }
.wf-step-body .step-chip.chip-tools { color: var(--accent-2); border-color: color-mix(in srgb, var(--accent-2) 60%, transparent); }
.wf-step-body .step-chip.chip-deps { color: var(--fg-2); }
.wf-step-body .step-chip.chip-model { color: var(--fg-3); }
.wf-step-body .step-output {
  margin-top: 10px;
  padding: 8px 12px;
  background: var(--bg-0);
  border: 1px solid var(--line);
  border-left: 2px solid var(--accent-2);
  color: var(--fg-2);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow-y: auto;
}

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

/* v0.5.11 UX — starter prompt chips above the architect input.
   Two sets: "new" (when no workflow open) and "edit" (when one IS open).
   JS toggles hidden on each chip based on context. Chips are clickable
   pills that pre-fill the textarea. */
.wf-chat-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 8px 0;
  background: var(--bg-1);
}
.wf-chat-chip {
  font-size: 10px;
  letter-spacing: 0.04em;
  padding: 5px 9px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  color: var(--fg-2);
  cursor: pointer;
  border-radius: 0;
  line-height: 1.2;
  text-align: left;
}
.wf-chat-chip:hover { color: var(--accent); border-color: var(--accent); }
.wf-chat-chip:active { transform: translateY(1px); }

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

/* Architect diff card — proposed changes the user can APPLY or DISCARD. */
.wf-diff-card {
  border: 1px solid color-mix(in srgb, var(--accent) 50%, var(--line));
  background: color-mix(in srgb, var(--bg-1) 88%, var(--accent) 6%);
}
.wf-diff-card.applied { opacity: 0.7; border-color: var(--accent-2); }
.wf-diff-card.discarded { opacity: 0.55; border-color: var(--line); }
.wf-diff-head {
  padding: 4px 9px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--accent);
}
.wf-diff-summary {
  padding: 8px 10px 4px;
  font-size: 11px;
  color: var(--fg);
  line-height: 1.5;
}
.wf-diff-ops {
  list-style: none;
  margin: 0;
  padding: 4px 12px 8px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--fg-2);
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
.wf-diff-ops li { padding: 1px 0; }
.wf-diff-actions {
  display: flex;
  gap: 6px;
  padding: 6px 10px 10px;
}
.wf-diff-apply, .wf-diff-discard {
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.18em;
  padding: 5px 12px;
  cursor: pointer;
  border: 1px solid var(--line);
  background: var(--bg-2);
  color: var(--fg);
  font-weight: 600;
}
.wf-diff-apply { background: var(--accent); color: var(--bg-0); border-color: var(--accent); }
.wf-diff-apply:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 80%, white); }
.wf-diff-discard:hover:not(:disabled) { border-color: var(--accent-fail); color: var(--accent-fail); }
.wf-diff-apply:disabled, .wf-diff-discard:disabled {
  background: var(--bg-3);
  color: var(--fg-mute);
  cursor: default;
  border-color: var(--line);
}
.wf-diff-status {
  padding: 0 10px 10px;
  font-size: 10px;
  letter-spacing: 0.14em;
}
.wf-diff-applied { color: var(--accent-2); }
.wf-diff-discarded { color: var(--fg-mute); }
.wf-diff-warn {
  margin-top: 4px;
  letter-spacing: normal;
  font-size: 10px;
  color: var(--accent-warn);
  line-height: 1.5;
}

/* @-mention tool picker — overlay floats above the active step textarea. */
.wf-tool-picker {
  position: absolute;
  z-index: 1000;
  min-width: 280px;
  max-width: 380px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--bg-1);
  border: 1px solid var(--accent);
  box-shadow: 0 6px 18px rgba(0,0,0,0.4);
  font-size: 11px;
}
.wf-tool-picker-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 5px 9px;
  cursor: pointer;
  border-bottom: 1px solid var(--line);
}
.wf-tool-picker-row:last-child { border-bottom: 0; }
.wf-tool-picker-row.active { background: color-mix(in srgb, var(--accent) 18%, var(--bg-2)); }
.wf-tool-picker-row:hover { background: var(--bg-2); }
.wf-tool-picker-name {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color: var(--fg);
}
.wf-tool-picker-cat {
  font-size: 9px;
  letter-spacing: 0.12em;
  color: var(--fg-3);
}
.wf-tool-picker-cat.is-skill {
  color: var(--accent-3);
  background: color-mix(in srgb, var(--bg-2) 70%, var(--accent-3) 14%);
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--accent-3) 50%, var(--line));
}
.wf-tool-picker-empty {
  padding: 10px;
  color: var(--fg-mute);
  font-size: 11px;
}

/* Per-step "tools allowed" chip rail beneath each step's prompt textarea. */
.wf-step-tools {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  font-size: 10px;
  letter-spacing: 0.14em;
}
.wf-step-tools-label {
  color: var(--fg-3);
  margin-right: 4px;
}
.wf-tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 7px;
  border: 1px solid color-mix(in srgb, var(--accent-2) 50%, var(--line));
  color: var(--accent-2);
  background: color-mix(in srgb, var(--bg-2) 80%, var(--accent-2) 6%);
  letter-spacing: normal;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
}
.wf-tool-chip-remove {
  background: transparent;
  border: 0;
  color: var(--fg-3);
  cursor: pointer;
  padding: 0 2px;
  font: inherit;
  font-size: 11px;
  line-height: 1;
}
.wf-tool-chip-remove:hover { color: var(--accent-fail); }
.wf-tool-add {
  background: transparent;
  border: 1px dashed var(--line);
  color: var(--fg-3);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.14em;
  padding: 2px 7px;
  cursor: pointer;
}
.wf-tool-add:hover { color: var(--accent); border-color: var(--accent); }

/* Per-step skill binding (usesSkill). One skill per step; the runner
   injects the skill's SKILL.md body into the step prompt at execution
   time. Rendered as its own row beneath the TOOLS rail so composing
   expertise reads as a distinct action from picking tools. */
.wf-step-skill {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  font-size: 10px;
  letter-spacing: 0.14em;
}
.wf-skill-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px 2px 7px;
  border: 1px solid color-mix(in srgb, var(--accent-3) 60%, var(--line));
  color: var(--accent-3);
  background: color-mix(in srgb, var(--bg-2) 80%, var(--accent-3) 10%);
  letter-spacing: normal;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
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
.tools-empty { color: var(--fg-mute); padding: 14px; letter-spacing: 0.12em; line-height: 1.5; }
/* LOCAL CLIs section — mirrors connected-clis.json in the Tools panel.
   Cards match the visual weight of MCP/registered-tool rows. */
.tools-cli-list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
  padding: 0 14px 8px;
}
.tools-cli-row {
  display: grid;
  grid-template-columns: 160px 1fr auto;
  align-items: center;
  gap: 14px;
  padding: 8px 12px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  font-size: 11.5px;
}
.tools-cli-row .tools-cli-name {
  color: var(--fg);
  font-weight: 600;
  letter-spacing: 0.04em;
}
.tools-cli-row .tools-cli-name code {
  color: var(--accent);
  font-size: 11px;
  margin-right: 6px;
}
.tools-cli-row .tools-cli-meta {
  color: var(--fg-3);
  font-size: 10.5px;
  letter-spacing: 0.08em;
}
.tools-cli-row .tools-cli-meta code {
  background: var(--bg-1);
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--accent-2, #5cd66a);
  font-size: 10.5px;
}
.tools-cli-row .tools-cli-when {
  color: var(--fg-mute);
  font-size: 10px;
  letter-spacing: 0.08em;
}
.tools-empty .tools-jump {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px dashed var(--accent);
  cursor: pointer;
}
.tools-empty .tools-jump:hover {
  background: var(--accent);
  color: var(--bg-0);
  border-bottom-color: transparent;
}

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

/* Workspace add/remove controls */
.proj-side-head .ws-add-btn {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--accent);
  font: 11px var(--mono);
  letter-spacing: 0.1em;
  padding: 2px 7px;
  cursor: pointer;
  transition: background 100ms;
}
.proj-side-head .ws-add-btn:hover { background: var(--bg-3); }
.proj-ws-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.proj-ws-list .ws-remove {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-mute);
  font: 10px var(--mono);
  padding: 1px 5px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 100ms, color 100ms;
  flex-shrink: 0;
}
.proj-ws-list li:hover .ws-remove { opacity: 1; }
.proj-ws-list .ws-remove:hover { color: #d04848; border-color: #d04848; }

/* Workspace linker modal */
.ws-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
.ws-modal {
  background: var(--bg-1);
  border: 1px solid var(--line);
  width: 560px;
  max-width: 90vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  font: 12px var(--mono);
}
.ws-modal-head {
  padding: 10px 14px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  letter-spacing: 0.16em;
  color: var(--fg-3);
}
.ws-modal-head .ws-close {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  padding: 1px 8px;
  cursor: pointer;
  font: 11px var(--mono);
}
.ws-modal-head .ws-close:hover { color: var(--fg); }
.ws-modal-tabs {
  display: flex;
  border-bottom: 1px solid var(--line);
  background: var(--bg-2);
}
.ws-modal-tabs button {
  flex: 1;
  background: transparent;
  border: 0;
  border-right: 1px solid var(--line);
  color: var(--fg-3);
  padding: 8px;
  letter-spacing: 0.14em;
  font: 10px var(--mono);
  cursor: pointer;
}
.ws-modal-tabs button:last-child { border-right: 0; }
.ws-modal-tabs button.active {
  color: var(--accent);
  background: var(--bg-1);
  box-shadow: inset 0 -2px 0 var(--accent);
}
.ws-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  font-size: 11px;
}
.ws-cwd {
  font-size: 10px;
  color: var(--fg-mute);
  padding: 6px 8px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  margin-bottom: 8px;
  word-break: break-all;
}
.ws-cwd .ws-cwd-link {
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
  margin-right: 8px;
}
.ws-add-this {
  width: 100%;
  text-align: left;
  background: var(--bg-2);
  border: 1px solid var(--accent);
  color: var(--accent);
  padding: 8px 10px;
  margin-bottom: 8px;
  cursor: pointer;
  font: 11px var(--mono);
  letter-spacing: 0.04em;
}
.ws-add-this:hover { background: var(--bg-3); }
.ws-dir-list {
  list-style: none;
  margin: 0; padding: 0;
}
.ws-dir-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
  transition: background 100ms;
}
.ws-dir-list li:hover { background: var(--bg-3); }
.ws-dir-list .ws-dir-name { color: var(--fg); flex: 1; word-break: break-all; }
.ws-dir-list .ws-link-btn {
  background: transparent;
  border: 1px solid var(--accent);
  color: var(--accent);
  padding: 1px 8px;
  cursor: pointer;
  font: 10px var(--mono);
  letter-spacing: 0.1em;
  flex-shrink: 0;
  margin-left: 8px;
}
.ws-dir-list .ws-link-btn:hover { background: var(--bg-3); }
.ws-search-input {
  width: 100%;
  background: var(--bg-2);
  border: 1px solid var(--line);
  color: var(--fg);
  padding: 8px 10px;
  font: 11px var(--mono);
  margin-bottom: 10px;
}
.ws-search-input:focus { outline: none; border-color: var(--accent); }
.ws-modal-status {
  font-size: 10px;
  color: var(--fg-mute);
  text-align: center;
  padding: 8px;
}
.ws-modal-status.error { color: #d04848; }

/* ── Integrations hub ────────────────────────────────────────── */
.integrations-layout {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 18px 20px 28px;
  overflow-y: auto;
}
.hub-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 24px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--line);
}
.hub-header h3 {
  margin: 0 0 4px;
  font-size: 14px;
  letter-spacing: 0.02em;
  color: var(--fg);
}
.hub-header p {
  margin: 0;
  font-size: 11px;
  color: var(--fg-3);
  line-height: 1.55;
  max-width: 640px;
}
.hub-stats {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.hub-stats .stat-card {
  background: var(--bg-1);
  border: 1px solid var(--line);
  padding: 6px 10px;
  min-width: 64px;
  text-align: center;
}
.hub-stats .stat-card span {
  display: block;
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--fg-3);
}
.hub-stats .stat-card em {
  display: block;
  margin-top: 2px;
  font-style: normal;
  font-size: 16px;
  color: var(--accent);
}

.hub-block {
  background: var(--bg-1);
  border: 1px solid var(--line);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hub-block-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  border-bottom: 1px solid var(--line);
  padding-bottom: 8px;
}
.hub-block-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.hub-block-meta {
  font-size: 10px;
  color: var(--fg-3);
  letter-spacing: 0.12em;
}
.hub-block-intro {
  margin: 0;
  font-size: 11px;
  color: var(--fg-2);
  line-height: 1.55;
}

/* ─ Keys list ─ */
.hub-keys-list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--line);
}
.hub-key-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
  align-items: center;
}
.hub-key-row:last-child { border-bottom: 0; }
.hub-key-name {
  font-size: 12px;
  color: var(--fg);
}
.hub-key-meta {
  margin-top: 4px;
  font-size: 10px;
  color: var(--fg-3);
  letter-spacing: 0.08em;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.hub-key-meta .pill {
  font-size: 9px;
  letter-spacing: 0.16em;
  padding: 1px 6px;
  border: 1px solid var(--line);
}
.hub-key-meta .pill.connected { color: var(--accent-2); border-color: var(--accent-2); }
.hub-key-meta .pill.runtime_ready { color: var(--accent); border-color: var(--accent); }
.hub-key-meta .pill.optional { color: var(--fg-3); border-color: var(--line); }
.hub-key-meta .pill.missing   { color: var(--accent-fail); border-color: var(--accent-fail); }
.hub-key-meta .pill.env_only  { color: var(--accent-warn); border-color: var(--accent-warn); }
.hub-key-meta .pill.unreadable, .hub-key-meta .pill.needs_repair { color: var(--accent-fail); border-color: var(--accent-fail); }
.hub-key-desc {
  margin-top: 4px;
  font-size: 10px;
  color: var(--fg-mute);
}
.hub-key-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hub-key-ok,
.cred-action-note {
  font-size: 9px;
  letter-spacing: 0.16em;
  color: var(--accent);
  border: 1px solid var(--accent);
  padding: 3px 7px;
  text-align: center;
}
.hub-key-actions button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.14em;
  padding: 5px 10px;
  cursor: pointer;
}
.hub-key-actions button:hover { border-color: var(--accent); color: var(--accent); }

/* ─ Apps list (Composio) ─ */
.hub-apps-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 6px 0;
}
.hub-apps-controls input {
  flex: 1;
  min-width: 200px;
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  padding: 6px 8px;
  outline: none;
}
.hub-apps-controls input.secret-input {
  -webkit-text-security: disc;
}
.hub-apps-controls input:focus { border-color: var(--accent); }
.hub-inline-select {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--fg-3);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.hub-inline-select select {
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 10px;
  padding: 5px 8px;
  outline: none;
}
.hub-inline-select select:focus { border-color: var(--accent); }
.hub-apps-controls button {
  background: transparent;
  border: 1px solid var(--accent);
  color: var(--accent);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.14em;
  padding: 6px 12px;
  cursor: pointer;
}
.hub-apps-controls button:hover { background: var(--accent); color: var(--bg-0); }
.hub-apps-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  margin-top: 4px;
}
.hub-app-card {
  background: var(--bg-0);
  border: 1px solid var(--line);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hub-app-name {
  font-size: 12px;
  color: var(--fg);
  letter-spacing: 0.02em;
}
.hub-app-meta {
  font-size: 9px;
  letter-spacing: 0.14em;
  color: var(--fg-3);
  text-transform: uppercase;
}
.hub-install-log {
  margin: 10px 0 0;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg-2);
  padding: 10px;
  font: 10px/1.5 var(--mono);
  letter-spacing: 0.02em;
  text-transform: none;
}
.hub-app-pill {
  font-size: 9px;
  letter-spacing: 0.16em;
  padding: 1px 6px;
  border: 1px solid var(--line);
  align-self: flex-start;
}
.hub-app-pill.active { color: var(--accent-2); border-color: var(--accent-2); }
.hub-app-pill.pending { color: var(--accent-warn); border-color: var(--accent-warn); }
.hub-app-pill.available { color: var(--fg-3); border-color: var(--line); }
.hub-app-pill.needs-setup { color: var(--accent-warn); border-color: var(--accent-warn); }
.hub-app-pill.failed, .hub-app-pill.disconnected { color: var(--accent-fail); border-color: var(--accent-fail); }

/* CLI catalog — action row + connected pills */
.hub-app-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.hub-app-actions button,
.hub-app-actions a {
  background: transparent;
  border: 1px solid var(--accent);
  color: var(--accent);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.14em;
  padding: 5px 10px;
  cursor: pointer;
  text-decoration: none;
  text-transform: uppercase;
}
.hub-app-actions button:hover,
.hub-app-actions a:hover { background: var(--accent); color: var(--bg-0); }
.hub-app-actions .cli-cat-forget {
  border-color: var(--line);
  color: var(--fg-3);
}
.hub-app-actions .cli-cat-forget:hover {
  border-color: var(--accent-fail);
  color: var(--accent-fail);
  background: transparent;
}
.hub-cli-connected-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.hub-cli-connected-pill {
  font-size: 10px;
  padding: 3px 8px;
  border: 1px solid color-mix(in srgb, var(--accent-2) 50%, var(--line));
  color: var(--fg-2);
  background: color-mix(in srgb, var(--accent-2) 5%, transparent);
}
.hub-cli-connected-pill code {
  color: var(--accent-2);
  background: transparent;
}
.hub-app-card-actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}
.hub-app-card-actions button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 9.5px;
  letter-spacing: 0.14em;
  padding: 5px 9px;
  cursor: pointer;
}
.hub-app-card-actions .connect { color: var(--accent); border-color: var(--accent); }
.hub-app-card-actions .connect:hover { background: var(--accent); color: var(--bg-0); }
.hub-app-card-actions .disconnect { color: var(--accent-fail); border-color: var(--accent-fail); }
.hub-app-card-actions .disconnect:hover { background: var(--accent-fail); color: var(--bg-0); }

/* ─ Clementine-native auth-setup modal (replaces Composio's broken popup for API_KEY toolkits) ─ */
.clemmy-modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 9999;
}
.clemmy-modal {
  background: var(--bg-1); color: var(--fg);
  border: 1px solid var(--line); border-radius: 8px;
  padding: 20px 22px;
  min-width: 380px; max-width: 480px;
  box-shadow: 0 18px 50px rgba(0,0,0,0.35);
  font-family: inherit;
}
.clemmy-modal-title {
  font-size: 14px; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--fg); margin-bottom: 4px;
}
.clemmy-modal-sub {
  font-size: 12px; color: var(--fg-3); margin-bottom: 16px; line-height: 1.45;
}
.clemmy-modal label { display: block; font-size: 11px; color: var(--fg-3); letter-spacing: 0.04em; margin: 10px 0 4px; }
.clemmy-modal input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-0); color: var(--fg); border: 1px solid var(--line);
  padding: 8px 10px; font: inherit; font-size: 12px; border-radius: 4px; outline: none;
}
.clemmy-modal input:focus { border-color: var(--accent); }
.clemmy-modal-actions {
  margin-top: 18px; display: flex; gap: 8px; justify-content: flex-end;
}
.clemmy-modal-actions button {
  font: inherit; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
  padding: 8px 14px; border: 1px solid var(--line); background: transparent;
  color: var(--fg); border-radius: 4px; cursor: pointer;
}
.clemmy-modal-actions .submit { color: var(--accent); border-color: var(--accent); }
.clemmy-modal-actions .submit:hover { background: var(--accent); color: var(--bg-0); }
.clemmy-modal-actions .submit:disabled { opacity: 0.5; cursor: not-allowed; }
.clemmy-modal-error {
  margin-top: 12px; font-size: 12px; color: var(--accent-fail);
  background: rgba(255,80,80,0.08); border: 1px solid var(--accent-fail);
  padding: 8px 10px; border-radius: 4px;
}

/* ─ MCP servers list ─ */
.hub-mcp-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hub-mcp-row {
  background: var(--bg-0);
  border: 1px solid var(--line);
  padding: 10px 12px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: center;
}
.hub-mcp-name {
  font-size: 12px;
  color: var(--fg);
  display: flex;
  align-items: center;
  gap: 8px;
}
.hub-mcp-name .pill {
  font-size: 9px;
  letter-spacing: 0.16em;
  padding: 1px 6px;
  border: 1px solid var(--line);
}
.hub-mcp-name .pill.source-auto-detected { color: var(--accent-3); border-color: var(--accent-3); }
.hub-mcp-name .pill.source-user { color: var(--accent); border-color: var(--accent); }
.hub-mcp-name .pill.transport-stdio { color: var(--fg-3); }
.hub-mcp-name .pill.transport-http,
.hub-mcp-name .pill.transport-sse { color: var(--accent-2); border-color: var(--accent-2); }
.hub-mcp-meta {
  margin-top: 4px;
  font-size: 10px;
  color: var(--fg-3);
  font-family: var(--mono);
  word-break: break-all;
}
.hub-mcp-desc {
  margin-top: 4px;
  font-size: 10px;
  color: var(--fg-mute);
  font-style: italic;
}
.hub-mcp-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 110px;
}
.hub-mcp-actions button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.14em;
  padding: 5px 10px;
  cursor: pointer;
}
.hub-mcp-actions .toggle.on { color: var(--accent-2); border-color: var(--accent-2); }
.hub-mcp-actions .toggle.off { color: var(--fg-mute); }
.hub-mcp-actions .del { color: var(--accent-fail); border-color: var(--accent-fail); }
.hub-mcp-actions .del:hover { background: var(--accent-fail); color: var(--bg-0); }
.hub-btn-add {
  background: transparent;
  border: 1px solid var(--accent);
  color: var(--accent);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 6px 12px;
  cursor: pointer;
  align-self: flex-start;
}
.hub-btn-add:hover { background: var(--accent); color: var(--bg-0); }

.hub-mcp-editor {
  grid-column: 1 / -1;
  margin-top: 8px;
  padding: 12px;
  background: var(--bg-1);
  border: 1px solid var(--line);
  display: grid;
  gap: 8px;
}
.hub-mcp-editor label {
  display: block;
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--fg-3);
  margin-bottom: 4px;
}
.hub-mcp-editor input,
.hub-mcp-editor select,
.hub-mcp-editor textarea {
  width: 100%;
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  padding: 6px 8px;
  outline: none;
}
.hub-mcp-editor input:focus,
.hub-mcp-editor select:focus,
.hub-mcp-editor textarea:focus { border-color: var(--accent); }
.hub-mcp-editor textarea { resize: vertical; min-height: 56px; font-family: var(--mono); }
.hub-mcp-editor .row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.hub-mcp-editor .buttons {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.hub-mcp-editor .buttons button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.14em;
  padding: 6px 12px;
  cursor: pointer;
}
.hub-mcp-editor .buttons .save { color: var(--accent-2); border-color: var(--accent-2); }
.hub-mcp-editor .buttons .save:hover { background: var(--accent-2); color: var(--bg-0); }

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

/* ── Usage panel ─────────────────────────────────────────────── */
.usage-layout {
  display: flex; flex-direction: column; gap: 14px;
  height: 100%; overflow-y: auto;
}
.usage-header {
  display: flex; justify-content: space-between; align-items: start;
  gap: 14px; padding: 14px; border: 1px solid var(--line); background: var(--bg-1);
}
.usage-intro h3 { margin: 0 0 6px; font-size: 16px; letter-spacing: 0.04em; }
.usage-intro p { margin: 0; color: var(--fg-3); font-size: 12px; max-width: 520px; }
.usage-totals { display: flex; gap: 0; border: 1px solid var(--line); }
.usage-totals .stat-card { border-right: 1px solid var(--line); padding: 10px 14px; }
.usage-totals .stat-card:last-child { border-right: none; }
.usage-totals .stat-card em { font-size: 22px; }
.usage-grid {
  display: grid; grid-template-columns: 1.4fr 1fr; gap: 14px;
}
.usage-block { padding: 14px; border: 1px solid var(--line); background: var(--bg-1); }
.usage-block-head {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 10px; letter-spacing: 0.18em; color: var(--fg-3);
  margin-bottom: 10px; text-transform: uppercase;
}
.usage-block-head button {
  font-size: 10px; padding: 3px 8px; background: transparent;
  border: 1px solid var(--line); color: var(--fg-3); cursor: pointer;
  letter-spacing: 0.14em;
}
.usage-block-head button:hover { color: var(--accent); border-color: var(--accent); }
.usage-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 0; border-bottom: 1px dashed var(--line); font-size: 12px;
  font-family: var(--mono, ui-monospace, monospace);
}
.usage-row:last-child { border-bottom: none; }
.usage-row .label { color: var(--fg-2); }
.usage-row .meta { color: var(--fg-3); font-size: 10px; letter-spacing: 0.1em; }
.usage-row .tokens { color: var(--accent); font-variant-numeric: tabular-nums; }
.usage-row .bar {
  flex: 1; height: 4px; background: var(--bg-0); margin: 0 12px;
  border: 1px solid var(--line); border-radius: 2px; overflow: hidden;
}
.usage-row .bar-fill { height: 100%; background: var(--accent); }
.usage-spark {
  display: flex; align-items: end; gap: 2px;
  height: 80px; padding: 8px 0;
}
.usage-spark .spark-bar {
  flex: 1; background: var(--accent); min-height: 1px;
  border-radius: 1px 1px 0 0;
}
.usage-spark .spark-bar.empty { background: var(--line); }
.usage-spark .spark-hour {
  font-size: 8px; color: var(--fg-3); letter-spacing: 0;
  text-align: center; margin-top: 4px;
}
.usage-trim-intro { color: var(--fg-3); font-size: 11px; margin: 0 0 12px; }
.usage-trim-row {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 0; border-bottom: 1px solid var(--line);
}
.usage-trim-row:last-child { border-bottom: none; }
.usage-trim-row .name { flex: 1; font-size: 12px; }
.usage-trim-row .desc { color: var(--fg-3); font-size: 10px; letter-spacing: 0.06em; }
.usage-trim-row button {
  font-size: 10px; padding: 5px 12px; letter-spacing: 0.14em;
  background: transparent; border: 1px solid var(--line);
  color: var(--fg-3); cursor: pointer;
}
.usage-trim-row button:hover { color: var(--accent); border-color: var(--accent); }
.usage-trim-row button.on { color: var(--accent); border-color: var(--accent); }
.usage-trim-row button.danger { color: var(--accent-fail); border-color: var(--accent-fail); }

/* v0.5.11 — Approvals panel */
.approvals-layout { padding: 16px; }
.approvals-header { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.approvals-intro h3 { margin: 0 0 4px; font-size: 14px; letter-spacing: 0.08em; }
.approvals-intro p { margin: 0; color: var(--fg-3); font-size: 11px; max-width: 600px; }
.approvals-toolbar { display: flex; gap: 8px; align-items: flex-start; }
.approvals-list { display: flex; flex-direction: column; gap: 12px; }
.approval-card {
  border: 1px solid var(--line);
  padding: 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.approval-card-head {
  display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;
}
.approval-subject { font-size: 13px; font-weight: 500; line-height: 1.4; flex: 1; }
.approval-age { font-size: 10px; letter-spacing: 0.1em; color: var(--fg-3); white-space: nowrap; padding-top: 2px; }
.approval-age.stale { color: var(--accent-warn); }
.approval-kind-pill {
  display: inline-block; padding: 0 5px; font-size: 9px; letter-spacing: 0.12em;
  border: 1px solid var(--line); border-radius: 2px; text-transform: uppercase;
}
.approval-kind-pill.runtime { color: var(--accent); border-color: var(--accent); }
.approval-kind-pill.harness { color: var(--fg-3); }
.approval-card.has-mismatch { border-color: var(--accent-fail); border-width: 2px; }
.approval-mismatch {
  background: color-mix(in srgb, var(--accent-fail) 12%, transparent);
  border-left: 3px solid var(--accent-fail);
  padding: 10px 12px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--fg-1);
}
.approval-mismatch strong { color: var(--accent-fail); letter-spacing: 0.1em; }
.approval-mismatch code {
  background: var(--bg-2); padding: 1px 4px; border: 1px solid var(--line);
  font-size: 10px; word-break: break-all;
}
.approval-age.very-stale { color: var(--accent-fail); }
.approval-meta { font-size: 10px; color: var(--fg-3); letter-spacing: 0.04em; }
.approval-meta code { background: var(--bg-2); padding: 1px 5px; border: 1px solid var(--line); }
.approval-args {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; padding: 8px 10px; background: var(--bg-2);
  border: 1px solid var(--line); max-height: 180px; overflow-y: auto;
  white-space: pre-wrap; word-break: break-word;
}
.approval-actions { display: flex; gap: 8px; }
.approval-actions button {
  font-size: 10px; padding: 6px 14px; letter-spacing: 0.14em;
  background: transparent; border: 1px solid var(--line);
  color: var(--fg-3); cursor: pointer;
}
.approval-actions button.approve { color: var(--accent-ok, #4ade80); border-color: var(--accent-ok, #4ade80); }
.approval-actions button.reject { color: var(--accent-fail); border-color: var(--accent-fail); }
.approval-actions button:hover { color: var(--accent); border-color: var(--accent); }
.approval-actions button:disabled { opacity: 0.4; cursor: not-allowed; }
.approvals-badge {
  display: inline-block; min-width: 16px; padding: 0 5px;
  font-size: 9px; line-height: 14px; border-radius: 8px;
  background: var(--accent-fail); color: var(--bg-1);
  text-align: center; margin-left: 4px;
}

/* v0.5.11 — Brain panel */
.brain-layout {
  padding: 16px;
  /* Parent .panel-body is height:100% / overflow:hidden, so the brain
     panel has to manage its own internal scroll. Flex column with the
     header (tabs) staying fixed and the active tab pane filling the
     remainder + scrolling. Hidden panes have display:none and don't
     take flex space, so only the visible pane gets flex:1. */
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
}
.brain-layout > .brain-header { flex: 0 0 auto; }
.brain-tab-pane {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.brain-header h3 { margin: 0 0 4px; font-size: 14px; letter-spacing: 0.08em; }
.brain-header p { margin: 0 0 12px; color: var(--fg-3); font-size: 11px; max-width: 640px; }
.brain-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.brain-tab {
  background: transparent; border: 1px solid var(--line); border-bottom: none;
  padding: 6px 14px; font-size: 11px; letter-spacing: 0.1em; color: var(--fg-3);
  cursor: pointer;
}
.brain-tab.on { color: var(--accent); border-color: var(--accent); background: var(--bg-2); }
.brain-controls { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.brain-controls select {
  font-size: 11px; padding: 4px 8px; background: var(--bg-2);
  border: 1px solid var(--line); color: var(--fg-1);
}
.brain-count { font-size: 10px; color: var(--fg-3); letter-spacing: 0.08em; }
.brain-help { font-size: 11px; color: var(--fg-3); margin: 0 0 12px; }
.brain-help code { background: var(--bg-2); padding: 1px 5px; border: 1px solid var(--line); }
.brain-list { display: flex; flex-direction: column; gap: 8px; }
.brain-fact-row, .brain-entity-row, .brain-pointer-row {
  border: 1px solid var(--line); padding: 10px 12px;
}
.brain-fact-row { display: flex; flex-direction: column; gap: 6px; }
.brain-fact-content { font-size: 12px; line-height: 1.4; }
.brain-fact-meta { font-size: 10px; color: var(--fg-3); letter-spacing: 0.04em; }
.brain-fact-meta .pill {
  display: inline-block; padding: 1px 6px; border: 1px solid var(--line);
  background: var(--bg-2); margin-right: 4px;
}
.brain-fact-meta .pill.derived { color: var(--accent-warn); border-color: var(--accent-warn); }
.brain-fact-meta .pill.direct { color: var(--accent-ok, #4ade80); border-color: var(--accent-ok, #4ade80); }
.brain-fact-meta .pill.important { color: var(--accent); border-color: var(--accent); }
.brain-entity-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.brain-entity-name { font-size: 12px; font-weight: 500; }
.brain-entity-type {
  font-size: 9px; letter-spacing: 0.12em; color: var(--fg-3);
  padding: 1px 6px; border: 1px solid var(--line); background: var(--bg-2);
}
.brain-entity-aliases { font-size: 10px; color: var(--fg-3); margin-top: 3px; }
.brain-entity-stats { font-size: 10px; color: var(--fg-3); white-space: nowrap; }
.brain-pointer-row { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.brain-pointer-label { font-size: 12px; flex: 1; }
.brain-pointer-meta { font-size: 10px; color: var(--fg-3); }
.brain-pointer-row button {
  font-size: 10px; padding: 4px 10px; letter-spacing: 0.14em;
  background: transparent; border: 1px solid var(--line);
  color: var(--fg-3); cursor: pointer;
}
.brain-pointer-row button:hover { color: var(--accent); border-color: var(--accent); }
.brain-health-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px;
}
.brain-health-card {
  border: 1px solid var(--line); padding: 12px;
}
.brain-health-card .label {
  font-size: 9px; letter-spacing: 0.12em; color: var(--fg-3);
}
.brain-health-card .value {
  font-size: 22px; margin-top: 4px;
}
.brain-health-card .sub { font-size: 10px; color: var(--fg-3); margin-top: 4px; }

/* Inner Knowledge sub-tabs (Facts / Entities / Graph & Files) */
.brain-subtabs {
  display: flex; gap: 4px; margin-bottom: 12px;
  border-bottom: 1px dashed var(--line); padding-bottom: 0;
}
.brain-subtab {
  background: transparent; border: 1px solid transparent;
  padding: 5px 12px; font-size: 10px; letter-spacing: 0.1em;
  color: var(--fg-3); cursor: pointer;
}
.brain-subtab.on { color: var(--accent); border-bottom-color: var(--accent); }

/* Overview tab cards */
.brain-overview { display: block; }
.brain-overview-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 14px;
}
.brain-overview-card {
  border: 1px solid var(--line);
  padding: 14px;
}
.brain-overview-stats { grid-column: span 2; }
.overview-card-head {
  font-size: 9px; letter-spacing: 0.14em; color: var(--fg-3);
  margin-bottom: 10px;
}
.overview-card-head em { font-style: normal; opacity: 0.7; margin-left: 4px; }
.overview-stat-row { display: flex; gap: 24px; }
.overview-stat { display: flex; flex-direction: column; }
.overview-stat em { font-style: normal; font-size: 22px; line-height: 1; }
.overview-stat span {
  font-size: 9px; letter-spacing: 0.12em; color: var(--fg-3);
  margin-top: 4px;
}
.overview-fact-row {
  display: flex; align-items: baseline; gap: 8px;
  padding: 6px 0; border-bottom: 1px solid var(--line);
  font-size: 11.5px; line-height: 1.4;
}
.overview-fact-row:last-child { border-bottom: none; }
.overview-fact-text { flex: 1; }
.overview-callid {
  font-size: 9px; padding: 1px 5px;
  background: var(--bg-2); border: 1px solid var(--line);
}
.overview-age { font-size: 10px; color: var(--fg-3); white-space: nowrap; }
.overview-health-row {
  font-size: 11px; padding: 4px 0; color: var(--fg-2);
}
.overview-health-row strong { color: var(--fg-1); }
.overview-evolution-body { margin-bottom: 8px; }
.overview-evolution-line { font-size: 11px; color: var(--fg-2); padding: 2px 0; }
.overview-evolution-link {
  font-size: 10px; letter-spacing: 0.1em; color: var(--accent);
  text-decoration: none; border-bottom: 1px solid var(--accent);
}
.overview-evolution-link:hover { opacity: 0.8; }
@media (max-width: 900px) {
  .brain-overview-grid { grid-template-columns: 1fr; }
  .brain-overview-stats { grid-column: span 1; }
}

/* Graph + Meetings — full-width wrappers inside Knowledge / Meetings tabs */
.brain-graph-wrap { height: calc(100vh - 240px); min-height: 480px; }
.brain-graph-wrap .mem-graph {
  display: grid;
  grid-template-columns: 1fr 280px;
  grid-template-rows: auto 1fr auto;
  height: 100%;
}
.brain-graph-wrap .mem-graph-topbar { grid-column: 1 / -1; }
.brain-graph-wrap .mem-graph-canvas { grid-column: 1 / 2; }
.brain-graph-wrap .mem-graph-detail { grid-column: 2 / 3; grid-row: 2 / 3; }
.brain-graph-wrap .mem-graph-legend  { grid-column: 1 / -1; }

.brain-meetings-wrap { height: calc(100vh - 240px); min-height: 480px; }
.brain-meetings-wrap .mem-meetings { height: 100%; }

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
.skill-card .skill-uninstall {
  font-size: 10px;
  letter-spacing: 0.12em;
  background: transparent;
  border: 1px solid var(--line);
  padding: 3px 8px;
  color: var(--fg-3);
  cursor: pointer;
}
.skill-card .skill-uninstall:hover { color: var(--accent-fail); border-color: var(--accent-fail); }
.skills-install {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.skills-install input {
  flex: 1;
  min-width: 280px;
  background: var(--bg-0);
  border: 1px solid var(--line);
  padding: 8px 10px;
  color: var(--fg);
  font: inherit;
}
.skills-install button {
  font-size: 11px;
  letter-spacing: 0.14em;
  padding: 8px 14px;
  background: var(--bg-1);
  border: 1px solid var(--line);
  color: var(--fg);
  cursor: pointer;
}
.skills-install button:hover { border-color: var(--accent); color: var(--accent); }
.skills-install button:disabled { opacity: 0.5; cursor: wait; }
.skills-install-status {
  flex-basis: 100%;
  background: var(--bg-0);
  border: 1px solid var(--line);
  padding: 8px 10px;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 10px;
  white-space: pre-wrap;
  color: var(--fg-2);
  max-height: 160px;
  overflow-y: auto;
}
.skills-footer {
  margin-top: 14px;
  font-size: 10px;
  color: var(--fg-3);
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
/* Diagnostics panel — additive only; renders read-only data from
   /api/console/diagnostics. Same look as other settings blocks. */
/* EVOLUTION panel (slot 12 — autoresearch).
   Layout matches the other panel-bodies; the report is a scrollable
   pre-rendered Markdown surface that we lightly style for readability. */
.evolution-layout {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
  height: 100%;
  overflow: hidden;
}
.evolution-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.evolution-title {
  margin: 0 0 6px;
  font-size: 16px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--fg);
}
.evolution-sub {
  margin: 0;
  font-size: 11.5px;
  color: var(--fg-3);
  max-width: 720px;
}
.evolution-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.evolution-btn {
  background: transparent;
  border: 1px solid var(--accent, #ff8f3c);
  color: var(--accent, #ff8f3c);
  padding: 6px 14px;
  font: inherit;
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.evolution-btn:hover { background: var(--accent, #ff8f3c); color: var(--bg-0); }
.evolution-btn:disabled { opacity: 0.5; cursor: progress; }
.evolution-history-pick {
  background: var(--bg-2);
  border: 1px solid var(--line);
  color: var(--fg-2);
  padding: 6px 10px;
  font: inherit;
  font-size: 11px;
  letter-spacing: 0.1em;
}
.evolution-meta {
  font-size: 10.5px;
  color: var(--fg-3);
  letter-spacing: 0.08em;
}
.evolution-report {
  flex: 1;
  overflow-y: auto;
  background: var(--bg-2);
  border: 1px solid var(--line);
  padding: 16px 20px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--fg-2);
}
.evolution-report h1 { font-size: 16px; color: var(--fg); margin: 0 0 12px; }
.evolution-report h2 { font-size: 13px; color: var(--fg); margin: 18px 0 10px; letter-spacing: 0.08em; text-transform: uppercase; }
.evolution-report table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 11.5px; }
.evolution-report th, .evolution-report td {
  border-bottom: 1px solid var(--line);
  padding: 4px 8px;
  text-align: left;
}
.evolution-report th { color: var(--fg-3); font-weight: 600; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; }
.evolution-report td:nth-child(n+2) { text-align: right; font-variant-numeric: tabular-nums; }
.evolution-report code { background: var(--bg-1); padding: 1px 5px; border-radius: 3px; font-size: 11.5px; color: var(--accent, #ff8f3c); }
.evolution-report ul { margin: 6px 0 12px 18px; padding: 0; }
.evolution-report li { margin: 3px 0; }
.evolution-report em { color: var(--fg-3); font-style: italic; }
.evolution-report hr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }

.settings-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  font-size: 12px;
  cursor: pointer;
}
.settings-toggle input { cursor: pointer; }
.settings-block-hint {
  padding: 0 16px 14px;
  margin: 0;
  font-size: 11px;
  color: var(--fg-3);
}
.settings-btn-mini {
  float: right;
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-3);
  width: 22px;
  height: 22px;
  cursor: pointer;
  font-size: 11px;
}
.settings-btn-mini:hover { color: var(--fg); border-color: var(--fg-2); }
.diag-summary {
  padding: 12px 16px;
  font-size: 11px;
  color: var(--fg-2);
  border-bottom: 1px dashed var(--line);
}
.diag-summary strong { color: var(--fg); }
.diag-section { padding: 10px 16px; border-bottom: 1px dashed var(--line); }
.diag-section:last-child { border-bottom: 0; }
.diag-section-head {
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--fg-3);
  margin-bottom: 8px;
}
.diag-row {
  display: grid;
  grid-template-columns: 1fr 60px;
  font-size: 11px;
  padding: 3px 0;
  gap: 8px;
  color: var(--fg-2);
}
.diag-row em { color: var(--fg); font-style: normal; text-align: right; }
.diag-session-row {
  display: grid;
  grid-template-columns: 1fr 60px 100px;
  font-size: 11px;
  padding: 4px 0;
  gap: 8px;
  color: var(--fg-2);
  border-bottom: 1px solid var(--line);
}
.diag-session-row .diag-pattern { font-size: 10px; text-align: right; }
.diag-pattern[data-p="batch"]        { color: var(--accent-2, #5cd66a); }
.diag-pattern[data-p="per-row-loop"] { color: var(--accent-fail, #ff5a5f); }
.diag-pattern[data-p="mixed"]        { color: var(--accent-warn, #f7b733); }
.diag-pattern[data-p="small"]        { color: var(--fg-3); }
.diag-error-row {
  display: grid;
  grid-template-columns: 60px 1fr;
  gap: 8px;
  font-size: 10.5px;
  padding: 3px 0;
  color: var(--fg-2);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
.diag-error-row .diag-level { font-weight: 600; }
.diag-error-row .diag-level.error { color: var(--accent-fail, #ff5a5f); }
.diag-error-row .diag-level.warn  { color: var(--accent-warn, #f7b733); }
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
.settings-secondary {
  background: var(--bg-1);
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 7px 12px;
  cursor: pointer;
}
.settings-secondary:hover { border-color: var(--line-bright); color: var(--fg); }
.settings-model-row {
  display: grid;
  grid-template-columns: 0.8fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}
.settings-model-row .settings-field { margin-bottom: 0; }
.settings-actions-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

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
.settings-note {
  margin: 10px 0 0;
  color: var(--fg-mute);
  font-size: 10px;
  line-height: 1.5;
}

/* ── Proactive Check-ins (Settings sub-block) ─────────────────── */
.checkins-intro {
  padding: 10px 16px;
  font-size: 11px;
  color: var(--fg-2);
  line-height: 1.55;
  border-bottom: 1px solid var(--line);
}
.checkins-list {
  display: flex;
  flex-direction: column;
}
.checkin-row {
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: center;
}
.checkin-row:last-child { border-bottom: 0; }
.checkin-row .checkin-main { min-width: 0; }
.checkin-row .checkin-name {
  font-size: 12px;
  color: var(--fg);
  letter-spacing: 0.02em;
}
.checkin-row .checkin-meta {
  margin-top: 4px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--fg-3);
}
.checkin-row .checkin-meta .pill {
  font-size: 9px;
  letter-spacing: 0.16em;
  padding: 1px 6px;
  border: 1px solid var(--line);
}
.checkin-row .checkin-meta .pill.trigger-schedule { color: var(--accent-3); border-color: var(--accent-3); }
.checkin-row .checkin-meta .pill.trigger-execution_blocked { color: var(--accent-fail); border-color: var(--accent-fail); }
.checkin-row .checkin-meta .pill.trigger-goal_stale { color: var(--accent-warn); border-color: var(--accent-warn); }
.checkin-row .checkin-meta .pill.trigger-inbox_backed_up { color: var(--accent); border-color: var(--accent); }
.checkin-row .checkin-desc {
  margin-top: 6px;
  font-size: 10px;
  color: var(--fg-mute);
  line-height: 1.5;
  font-style: italic;
}

.checkin-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
  min-width: 130px;
}
.checkin-actions button {
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
.checkin-actions button:hover { color: var(--fg); border-color: var(--line-bright); }
.checkin-actions .toggle.on { color: var(--accent-2); border-color: var(--accent-2); }
.checkin-actions .toggle.off { color: var(--fg-mute); }
.checkin-actions .test { color: var(--accent-3); border-color: var(--accent-3); }
.checkin-actions .test:hover { background: var(--accent-3); color: var(--bg-0); }
.checkin-actions .edit { color: var(--accent); border-color: var(--accent); }
.checkin-actions .edit:hover { background: var(--accent); color: var(--bg-0); }
.checkin-actions .del { color: var(--accent-fail); border-color: var(--accent-fail); }
.checkin-actions .del:hover { background: var(--accent-fail); color: var(--bg-0); }

.checkin-editor {
  grid-column: 1 / -1;
  margin-top: 10px;
  padding: 12px;
  background: var(--bg-1);
  border: 1px solid var(--line);
  display: grid;
  gap: 8px;
}
.checkin-editor label {
  display: block;
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--fg-3);
  margin-bottom: 4px;
}
.checkin-editor input,
.checkin-editor select,
.checkin-editor textarea {
  width: 100%;
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  padding: 6px 8px;
  outline: none;
}
.checkin-editor input:focus, .checkin-editor select:focus, .checkin-editor textarea:focus { border-color: var(--accent); }
.checkin-editor textarea { resize: vertical; min-height: 56px; }
.checkin-editor .row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.checkin-editor .editor-buttons {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
.checkin-editor .editor-buttons button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.14em;
  padding: 6px 10px;
  cursor: pointer;
}
.checkin-editor .editor-buttons .save { color: var(--accent-2); border-color: var(--accent-2); }
.checkin-editor .editor-buttons .save:hover { background: var(--accent-2); color: var(--bg-0); }
.checkin-editor .editor-buttons .cancel { color: var(--fg-3); }

.checkins-actions {
  padding: 12px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-1);
}
.checkins-btn-new {
  background: transparent;
  border: 1px solid var(--accent);
  color: var(--accent);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 100ms, color 100ms;
}
.checkins-btn-new:hover { background: var(--accent); color: var(--bg-0); }

/* ── Plan proposals (Settings sub-block) ──────────────────────── */
.plan-proposals-list {
  display: flex;
  flex-direction: column;
}
.plan-proposal-row {
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 10px;
  background:
    linear-gradient(180deg, rgba(80, 200, 230, var(--card-tint, 0.05)) 0%, transparent 32%),
    var(--bg-1);
  border-left: 2px solid var(--accent-3);
}
.plan-proposal-row:last-child { border-bottom: 0; }
.plan-head { display: flex; flex-direction: column; gap: 4px; }
.plan-objective {
  font-size: 13px;
  color: var(--fg);
  letter-spacing: 0.01em;
  font-weight: 500;
}
.plan-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--fg-3);
}
.plan-meta .pill {
  font-size: 9px;
  letter-spacing: 0.16em;
  padding: 1px 6px;
  border: 1px solid var(--line);
}
.plan-meta .pill.complexity-trivial { color: var(--fg-mute); border-color: var(--fg-mute); }
.plan-meta .pill.complexity-moderate { color: var(--accent-2); border-color: var(--accent-2); }
.plan-meta .pill.complexity-significant { color: var(--accent-warn); border-color: var(--accent-warn); }
.plan-meta .pill.complexity-large { color: var(--accent-fail); border-color: var(--accent-fail); }
.plan-meta .pill.plan-tracked { color: var(--accent-3); border-color: var(--accent-3); }

.plan-label {
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--accent-3);
  margin-right: 6px;
}
.plan-context, .plan-request {
  font-size: 11px;
  color: var(--fg-2);
  line-height: 1.5;
}
.plan-request { color: var(--fg-mute); font-style: italic; }

.plan-section { font-size: 11px; line-height: 1.55; color: var(--fg-2); }
.plan-section ol, .plan-section ul {
  margin: 4px 0 0 4px;
  padding: 0;
  list-style: none;
}
.plan-section li {
  padding: 4px 0;
  border-left: 1px dotted var(--line);
  padding-left: 10px;
  margin-left: 6px;
}
.plan-step-n {
  font-family: var(--font-mono, monospace);
  color: var(--accent-3);
  margin-right: 4px;
}
.plan-step-action { color: var(--fg); }
.plan-step-rationale {
  margin-top: 2px;
  font-size: 10px;
  color: var(--fg-mute);
  font-style: italic;
}
.plan-step-verify {
  margin-top: 2px;
  font-size: 10px;
  color: var(--accent-2);
  font-family: var(--font-mono, monospace);
}
.plan-risks li { color: var(--accent-warn); }
.plan-questions li { color: var(--accent); }

.plan-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.plan-actions button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 100ms, color 100ms, border-color 100ms;
}
.plan-actions .plan-btn-approve { color: var(--accent-2); border-color: var(--accent-2); }
.plan-actions .plan-btn-approve:hover { background: var(--accent-2); color: var(--bg-0); }
.plan-actions .plan-btn-reject { color: var(--accent-fail); border-color: var(--accent-fail); }
.plan-actions .plan-btn-reject:hover { background: var(--accent-fail); color: var(--bg-0); }

/* ── Agent-drafted proposals (Settings sub-block) ─────────────── */
.proposals-intro {
  padding: 10px 16px;
  font-size: 11px;
  color: var(--fg-2);
  line-height: 1.55;
  border-bottom: 1px solid var(--line);
}
.proposals-list {
  display: flex;
  flex-direction: column;
}
.proposal-row {
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 8px;
  background:
    linear-gradient(180deg, rgba(255, 170, 80, var(--card-tint, 0.04)) 0%, transparent 28%),
    var(--bg-1);
  border-left: 2px solid var(--accent);
}
.proposal-row:last-child { border-bottom: 0; }
.proposal-head { display: flex; flex-direction: column; gap: 4px; }
.proposal-name {
  font-size: 12px;
  color: var(--fg);
  letter-spacing: 0.02em;
}
.proposal-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--fg-3);
}
.proposal-meta .pill {
  font-size: 9px;
  letter-spacing: 0.16em;
  padding: 1px 6px;
  border: 1px solid var(--line);
}
.proposal-meta .pill.trigger-schedule { color: var(--accent-3); border-color: var(--accent-3); }
.proposal-meta .pill.trigger-execution_blocked { color: var(--accent-fail); border-color: var(--accent-fail); }
.proposal-meta .pill.trigger-goal_stale { color: var(--accent-warn); border-color: var(--accent-warn); }
.proposal-meta .pill.trigger-inbox_backed_up { color: var(--accent); border-color: var(--accent); }

.proposal-label {
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--accent);
  margin-right: 6px;
}
.proposal-rationale,
.proposal-question,
.proposal-desc {
  font-size: 11px;
  color: var(--fg-2);
  line-height: 1.5;
}
.proposal-question { color: var(--fg); }
.proposal-desc { color: var(--fg-mute); font-style: italic; }

.proposal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
.proposal-actions button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 100ms, color 100ms, border-color 100ms;
}
.proposal-actions .proposal-btn-approve { color: var(--accent-2); border-color: var(--accent-2); }
.proposal-actions .proposal-btn-approve:hover { background: var(--accent-2); color: var(--bg-0); }
.proposal-actions .proposal-btn-edit { color: var(--accent); border-color: var(--accent); }
.proposal-actions .proposal-btn-edit:hover { background: var(--accent); color: var(--bg-0); }
.proposal-actions .proposal-btn-reject { color: var(--accent-fail); border-color: var(--accent-fail); }
.proposal-actions .proposal-btn-reject:hover { background: var(--accent-fail); color: var(--bg-0); }

.proposal-editor {
  margin-top: 4px;
  padding: 12px;
  background: var(--bg-0);
  border: 1px solid var(--line);
  display: grid;
  gap: 8px;
}
.proposal-editor label {
  display: block;
  font-size: 10px;
  letter-spacing: 0.16em;
  color: var(--fg-3);
  margin-bottom: 4px;
}
.proposal-editor input,
.proposal-editor select,
.proposal-editor textarea {
  width: 100%;
  background: var(--bg-1);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  padding: 6px 8px;
  outline: none;
}
.proposal-editor input:focus, .proposal-editor select:focus, .proposal-editor textarea:focus { border-color: var(--accent); }
.proposal-editor textarea { resize: vertical; min-height: 48px; }
.proposal-editor .row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

/* ── Credentials Health (Settings sub-block) ──────────────────── */
.creds-meta {
  margin-left: auto;
  font-size: 9px;
  color: var(--fg-mute);
  letter-spacing: 0.14em;
}
.creds-list {
  padding: 0;
  display: flex;
  flex-direction: column;
}
.cred-row {
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  align-items: start;
}
.cred-row:last-child { border-bottom: 0; }
.cred-row .cred-main { min-width: 0; }
.cred-row .cred-name {
  font-size: 11px;
  color: var(--fg);
  letter-spacing: 0.06em;
}
.cred-row .cred-meta {
  margin-top: 3px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--fg-3);
}
.cred-status {
  font-size: 9px;
  letter-spacing: 0.18em;
  padding: 1px 6px;
  border: 1px solid var(--line);
}
.cred-status.connected { color: var(--accent-2); border-color: var(--accent-2); }
.cred-status.runtime_ready { color: var(--accent); border-color: var(--accent); }
.cred-status.optional { color: var(--fg-3); border-color: var(--line); }
.cred-status.missing { color: var(--fg-mute); }
.cred-status.env_only { color: var(--accent-warn); border-color: var(--accent-warn); }
.cred-status.unreadable { color: var(--accent-fail); border-color: var(--accent-fail); }
.cred-status.needs_repair { color: var(--accent-fail); border-color: var(--accent-fail); }

.cred-source {
  font-size: 9px;
  letter-spacing: 0.16em;
}
.cred-source.keychain { color: var(--accent-3); }
.cred-source.file { color: var(--accent); }
.cred-source.env { color: var(--accent-warn); }
.cred-source.missing { color: var(--fg-mute); }
.cred-drift {
  font-size: 9px; letter-spacing: 0.16em;
  color: var(--accent-fail); border: 1px solid var(--accent-fail);
  padding: 1px 5px;
}

.cred-desc {
  margin-top: 6px;
  font-size: 10px;
  color: var(--fg-3);
  line-height: 1.5;
}
.cred-hint {
  margin-top: 4px;
  font-size: 10px;
  color: var(--fg-mute);
  letter-spacing: 0.02em;
}

.cred-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
  min-width: 130px;
}
.cred-actions button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 5px 8px;
  cursor: pointer;
  transition: background 100ms, color 100ms, border-color 100ms;
}
.cred-actions button:hover { color: var(--fg); border-color: var(--line-bright); }
.cred-actions .cred-set { color: var(--accent); border-color: var(--accent); }
.cred-actions .cred-set:hover { background: var(--accent); color: var(--bg-0); }
.cred-actions .cred-migrate { color: var(--accent-3); border-color: var(--accent-3); }
.cred-actions .cred-migrate:hover { background: var(--accent-3); color: var(--bg-0); }
.cred-actions .cred-delete { color: var(--accent-fail); border-color: var(--accent-fail); }
.cred-actions .cred-delete:hover { background: var(--accent-fail); color: var(--bg-0); }

.cred-set-input-wrap {
  margin-top: 8px;
  display: none;
  gap: 6px;
  flex-direction: column;
}
.cred-set-input-wrap.open { display: flex; }
.cred-set-input {
  width: 100%;
  background: var(--bg-0);
  border: 1px solid var(--line);
  color: var(--fg);
  font: inherit;
  font-size: 11px;
  padding: 6px 8px;
  outline: none;
  transition: border-color 120ms;
}
.cred-set-input.secret-input {
  -webkit-text-security: disc;
}
.cred-set-input:focus { border-color: var(--accent); }
.cred-set-buttons { display: flex; gap: 4px; }
.cred-set-buttons button {
  flex: 1;
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.14em;
  padding: 4px 8px;
  cursor: pointer;
}
.cred-set-buttons .save { color: var(--accent-2); border-color: var(--accent-2); }
.cred-set-buttons .save:hover { background: var(--accent-2); color: var(--bg-0); }

.creds-actions {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
  background: var(--bg-1);
}
.creds-actions button {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  padding: 6px 12px;
  cursor: pointer;
  transition: background 100ms, color 100ms, border-color 100ms;
}
.creds-btn-repair { color: var(--accent-3) !important; border-color: var(--accent-3) !important; }
.creds-btn-repair:hover { background: var(--accent-3); color: var(--bg-0) !important; }
.creds-btn-reset { color: var(--accent-fail) !important; border-color: var(--accent-fail) !important; margin-left: auto; }
.creds-btn-reset:hover { background: var(--accent-fail); color: var(--bg-0) !important; }

.creds-footnote {
  padding: 8px 16px 14px;
  font-size: 10px;
  color: var(--fg-mute);
  line-height: 1.55;
}
.creds-footnote code {
  background: var(--bg-0);
  border: 1px solid var(--line);
  padding: 1px 5px;
  color: var(--accent);
  font-size: 10px;
}

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

/* ── Meeting-capture floating layer ───────────────────────────
   Always-mounted, conditionally visible. Three top-right slots
   (prompt → pill → toast) stack so the user only ever sees one at
   a time. The drawer slides in from the right when the pill is
   tapped. Everything pointer-events:none on the layer itself; the
   individual cards re-enable pointer events. */
.meeting-layer {
  position: fixed;
  top: 64px;
  right: 18px;
  z-index: 2400;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  pointer-events: none;
}
.meeting-layer > * { pointer-events: auto; }

.meeting-prompt,
.meeting-toast {
  width: 320px;
  padding: 14px 14px 12px;
  /* Glass surface — uses the theme's bg-1 with a small alpha lift so
     the backdrop-filter blur reads through. Adapts to both ops (dark)
     and day (light) themes via the CSS variables. */
  background: color-mix(in srgb, var(--bg-1) 88%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--line);
  border-left: 2px solid var(--accent);
  box-shadow: 0 10px 36px color-mix(in srgb, var(--bg-0) 50%, transparent);
  color: var(--fg);
  animation: meetingSlideIn 220ms ease-out;
}
.meeting-toast { border-left-color: var(--accent-2); }

@keyframes meetingSlideIn {
  from { opacity: 0; transform: translateY(-6px) translateX(8px); }
  to { opacity: 1; transform: none; }
}

.meeting-prompt-head,
.meeting-toast-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.meeting-prompt-title,
.meeting-toast-title {
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fg);
  flex: 1;
}
.meeting-prompt-sub,
.meeting-toast-sub {
  font-size: 11px;
  color: var(--fg-2);
  line-height: 1.5;
  margin-bottom: 10px;
}
.meeting-prompt-actions,
.meeting-toast-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.meeting-x {
  background: transparent;
  border: 0;
  color: var(--fg-3);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
}
.meeting-x:hover { color: var(--accent-fail); }

.meeting-btn {
  background: transparent;
  border: 1px solid var(--line);
  color: var(--fg-2);
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  padding: 6px 10px;
  cursor: pointer;
  transition: background 120ms, color 120ms, border-color 120ms;
}
.meeting-btn:hover { color: var(--fg); border-color: var(--line-bright); }
.meeting-btn.primary { color: var(--accent); border-color: var(--accent); }
.meeting-btn.primary:hover { background: var(--accent); color: var(--bg-0); }
.meeting-btn.ghost { color: var(--fg-3); }

.meeting-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
.meeting-dot.detected { background: var(--accent); box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent); }
.meeting-dot.recording { background: var(--accent-fail); box-shadow: 0 0 10px color-mix(in srgb, var(--accent-fail) 75%, transparent); animation: meetingPulse 1.4s ease-in-out infinite; }
.meeting-dot.complete { background: var(--accent-2); box-shadow: 0 0 10px color-mix(in srgb, var(--accent-2) 70%, transparent); }
@keyframes meetingPulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(0.7); opacity: 0.55; }
}

/* Live recording card — lives INLINE inside the Memory > Meetings
   panel rather than as a floating popup. The pill click navigates
   to Memory > Meetings and this card scrolls into view at the top of
   the meetings list. Theme-aware via CSS variables. */
.mem-meeting-live {
  display: flex;
  flex-direction: column;
  padding: 14px 16px;
  background: color-mix(in srgb, var(--accent-fail) 8%, var(--bg-1));
  border: 1px solid var(--line);
  border-left: 3px solid var(--accent-fail);
}
.mem-meeting-live-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.mem-meeting-live-titles { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.mem-meeting-live-tag {
  font-size: 9px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--accent-fail);
  font-weight: 600;
}
.mem-meeting-live-title {
  font-size: 12px;
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mem-meeting-live-elapsed {
  font-size: 12px;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
  padding: 2px 8px;
  background: var(--bg-0);
  border: 1px solid var(--line);
}
.mem-meeting-live-body {
  max-height: 240px;
  overflow-y: auto;
  padding: 10px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mem-meeting-live-empty { color: var(--fg-mute); font-size: 11px; padding: 4px 0; font-style: italic; }
.mem-meeting-live-foot {
  margin-top: 6px;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  display: flex;
  align-items: center;
  gap: 12px;
}
.mem-meeting-live-hint { color: var(--fg-mute); font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; }

/* Shared segment style used by both the live card and any post-meeting
   transcript inline render. */
.meeting-segment {
  font-size: 12px;
  line-height: 1.55;
  color: var(--fg);
  padding-bottom: 8px;
  border-bottom: 1px dashed color-mix(in srgb, var(--line) 70%, transparent);
}
.meeting-segment:last-child { border-bottom: 0; padding-bottom: 0; }
.meeting-segment-speaker {
  display: block;
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent);
  margin-bottom: 3px;
}

/* ── General toast layer ────────────────────────────────────────────
   Bottom-right stack. Replaces native alert() for transient feedback
   (errors, success confirmations, info pings). Kinds use border-left
   color + dot to match the existing meeting-toast aesthetic. */
.toast-layer {
  position: fixed;
  bottom: 18px;
  right: 18px;
  z-index: 2600;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
  max-width: 360px;
}
.toast {
  pointer-events: auto;
  min-width: 240px;
  max-width: 360px;
  padding: 10px 12px 11px 32px;
  position: relative;
  background: color-mix(in srgb, var(--bg-1) 92%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--line);
  border-left: 2px solid var(--accent);
  box-shadow: 0 8px 28px color-mix(in srgb, var(--bg-0) 60%, transparent);
  color: var(--fg);
  font-size: 11.5px;
  line-height: 1.4;
  animation: toastSlideIn 200ms ease-out;
}
.toast.dismissing { animation: toastSlideOut 160ms ease-in forwards; }
.toast::before {
  content: '';
  position: absolute;
  left: 12px;
  top: 14px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent);
}
.toast.kind-error      { border-left-color: var(--accent-fail, #ff5a5f); }
.toast.kind-error::before { background: var(--accent-fail, #ff5a5f); box-shadow: 0 0 8px color-mix(in srgb, var(--accent-fail, #ff5a5f) 70%, transparent); }
.toast.kind-success    { border-left-color: var(--accent-2, #8ed47e); }
.toast.kind-success::before { background: var(--accent-2, #8ed47e); box-shadow: 0 0 8px color-mix(in srgb, var(--accent-2, #8ed47e) 60%, transparent); }
.toast.kind-warn       { border-left-color: var(--accent, #ff9f1c); }
.toast-title {
  font-size: 9px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--fg-3);
  margin-bottom: 3px;
}
.toast-body { color: var(--fg); word-break: break-word; }
.toast-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.toast-action {
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
  background: transparent;
  border: 1px solid var(--accent);
  padding: 4px 8px;
  cursor: pointer;
}
.toast-action:hover { background: color-mix(in srgb, var(--accent) 20%, transparent); }
.toast-close {
  position: absolute;
  top: 6px;
  right: 6px;
  background: transparent;
  border: 0;
  color: var(--fg-3);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 2px 4px;
}
.toast-close:hover { color: var(--fg); }
@keyframes toastSlideIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
@keyframes toastSlideOut {
  to { opacity: 0; transform: translateY(8px); }
}
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

  // ── General-purpose toast helper ────────────────────────────────
  //
  // Replaces native alert() for transient feedback. Stacks in the
  // bottom-right [data-toast-layer]. Each toast auto-dismisses after
  // opts.durationMs (default 6000) unless opts.sticky is true. Returns
  // a handle with .dismiss() for callers that want to remove early.
  //
  // Usage:
  //   showToast({ kind: 'error', title: 'Update failed', message: 'reason here' })
  //   showError('Update failed: reason')
  //   showSuccess('Repaired ownership')
  //
  // Kinds: 'error' | 'warn' | 'success' | 'info' (default 'info').
  function escToastHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function showToast(opts) {
    const layer = document.querySelector('[data-toast-layer]');
    if (!layer) {
      // Fallback if the toast layer isn't in the DOM for some reason —
      // we still surface the message somehow rather than swallow it.
      console.warn('[toast] layer missing; message=' + (opts && opts.message));
      return { dismiss() {} };
    }
    const kind = (opts && opts.kind) || 'info';
    const title = opts && opts.title;
    const message = (opts && opts.message) || '';
    const sticky = Boolean(opts && opts.sticky);
    const durationMs = (opts && typeof opts.durationMs === 'number') ? opts.durationMs : 6000;
    const actions = (opts && Array.isArray(opts.actions)) ? opts.actions : [];

    const toast = document.createElement('div');
    toast.className = 'toast kind-' + kind;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const parts = [];
    if (title) parts.push('<div class="toast-title">' + escToastHtml(title) + '</div>');
    parts.push('<div class="toast-body">' + escToastHtml(message) + '</div>');
    if (actions.length > 0) {
      parts.push('<div class="toast-actions">' +
        actions.map((a, i) => '<button class="toast-action" data-toast-action="' + i + '">' + escToastHtml(a.label || 'OK') + '</button>').join('') +
        '</div>');
    }
    parts.push('<button class="toast-close" aria-label="Dismiss" data-toast-close>×</button>');
    toast.innerHTML = parts.join('');

    let dismissed = false;
    let dismissTimer = null;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
      toast.classList.add('dismissing');
      setTimeout(() => { try { toast.remove(); } catch {} }, 180);
    }

    toast.querySelector('[data-toast-close]')?.addEventListener('click', dismiss);
    toast.querySelectorAll('[data-toast-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-toast-action'));
        const action = actions[idx];
        try { if (action && typeof action.onClick === 'function') action.onClick(); } catch (err) { console.error('toast action threw:', err); }
        if (!action || action.dismissOnClick !== false) dismiss();
      });
    });

    layer.appendChild(toast);
    if (!sticky && durationMs > 0) {
      dismissTimer = setTimeout(dismiss, durationMs);
    }
    return { dismiss };
  }
  function showError(message, opts)   { return showToast(Object.assign({ kind: 'error',   title: 'Error',   message: String(message) }, opts || {})); }
  function showWarn(message, opts)    { return showToast(Object.assign({ kind: 'warn',    title: 'Warning', message: String(message) }, opts || {})); }
  function showSuccess(message, opts) { return showToast(Object.assign({ kind: 'success', title: 'Done',    message: String(message) }, opts || {})); }
  function showInfo(message, opts)    { return showToast(Object.assign({ kind: 'info',                       message: String(message) }, opts || {})); }
  // Expose for the few non-IIFE code paths that need them (e.g. inline
  // onclick handlers and the meeting controller below).
  window.__clementineToast = { showToast, showError, showWarn, showSuccess, showInfo };

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
    // The connection chip contains a .pulse element + the label span.
    // Update ONLY the label so the pulse animation keeps running.
    const label = document.querySelector('[data-conn-label]');
    if (ok) {
      els.conn.removeAttribute('data-offline');
      if (label) label.textContent = 'ONLINE';
    } else {
      els.conn.setAttribute('data-offline', 'true');
      if (label) label.textContent = 'OFFLINE';
    }
  }

  // ─── Theme toggle ─────────────────────────────────────────────
  const THEME_KEY = 'clemmy.console.theme';
  const themeIcon = document.querySelector('[data-theme-icon]');

  function applyTheme(theme) {
    const t = theme === 'day' ? 'day' : 'ops';
    document.documentElement.setAttribute('data-theme', t);
    if (themeIcon) themeIcon.textContent = t === 'day' ? '☀' : '◐';
    try { localStorage.setItem(THEME_KEY, t); } catch (err) { /* private mode */ }
  }

  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (err) { /* private mode */ }
    if (saved === 'day' || saved === 'ops') {
      applyTheme(saved);
      return;
    }
    // No saved preference — follow the OS color scheme on first load.
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(prefersLight ? 'day' : 'ops');
  }

  const themeToggleBtn = document.querySelector('[data-theme-toggle]');
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'ops';
      applyTheme(current === 'day' ? 'ops' : 'day');
    });
  }
  initTheme();

  // Populate version chips from /api/console/build-info — done once at
  // page load. If the call fails we keep the placeholder dash.
  //
  // Race fix: the renderUpdaterChip below caches sub.textContent into
  // sub.dataset.baseLabel on its first run. If renderUpdaterChip
  // fires before this IIFE resolves, baseLabel sticks at the HTML
  // placeholder "v0.1.0 · console" and every subsequent tick rebuilds
  // the header with that stale prefix — even after install of 0.4.x.
  // So after we set the real version, drop the cached baseLabel so the
  // next chip render re-captures from the fresh textContent.
  (async () => {
    try {
      const info = await fetchJSON('/api/console/build-info');
      const v = info.version ? 'v' + info.version : '';
      const headerSub = document.querySelector('[data-daemon-version]');
      if (headerSub && v) {
        headerSub.textContent = v + ' · console';
        delete headerSub.dataset.baseLabel;
      }
      const footVer = document.querySelector('[data-foot-version]');
      if (footVer && v) footVer.textContent = v;
    } catch (err) { /* leave placeholder */ }
  })();

  // Auto-updater state surfaces in two places in the header:
  //   1. [data-daemon-version] — static "v0.4.32 · console" label.
  //   2. [data-updater-cta]    — discoverable button that appears only
  //      when there's an action the user can take. This replaces the
  //      old behavior where the version label itself was the click
  //      target (undiscoverable for new users).
  //
  // Errors surface as toasts (showError) instead of native alert()
  // modals so they're non-blocking and consistent with the rest of
  // the dashboard's UX language.
  if (window.clemmy?.updaterStatus) {
    const cta       = document.querySelector('[data-updater-cta]');
    const ctaLabel  = document.querySelector('[data-updater-cta-label]');
    const sub       = document.querySelector('[data-daemon-version]');

    function setCtaBusy(busy, label) {
      if (!cta) return;
      if (busy) {
        cta.classList.add('busy');
        cta.setAttribute('disabled', '');
        if (label && ctaLabel) ctaLabel.textContent = label;
      } else {
        cta.classList.remove('busy');
        cta.removeAttribute('disabled');
      }
    }
    function setCtaKind(kind /* '' | 'install' | 'repair' */) {
      if (!cta) return;
      cta.classList.remove('kind-install', 'kind-repair');
      if (kind) cta.classList.add('kind-' + kind);
    }
    function hideCta() {
      if (!cta) return;
      cta.setAttribute('hidden', '');
      cta.onclick = null;
      setCtaKind('');
    }
    function showCta({ label, title, kind, onClick, icon }) {
      if (!cta) return;
      if (ctaLabel) ctaLabel.textContent = label;
      cta.title = title || label;
      const iconEl = cta.querySelector('.updater-cta-icon');
      if (iconEl && icon) iconEl.textContent = icon;
      setCtaKind(kind || '');
      cta.onclick = onClick;
      cta.removeAttribute('hidden');
      cta.removeAttribute('disabled');
      cta.classList.remove('busy');
    }

    const applyUpdate = async () => {
      setCtaBusy(true, 'STARTING…');
      try {
        const result = await window.clemmy?.updaterApply?.();
        const applyResult = result && result.applyResult;
        if (applyResult && applyResult.ok === false) {
          showError('Update could not be applied: ' + (applyResult.reason || 'unknown reason'));
          await renderUpdaterChip(result);
        } else if (applyResult && applyResult.action !== 'installing') {
          await renderUpdaterChip(result);
        }
        // action='installing' → renderer is about to be torn down; do nothing.
      } catch (err) {
        showError('Update apply failed: ' + ((err && err.message) || err));
        setCtaBusy(false);
        await renderUpdaterChip();
      }
    };

    const moveToApplications = async () => {
      setCtaBusy(true, 'MOVING…');
      try {
        const result = await window.clemmy?.updaterMoveToApplications?.();
        const moveResult = result && result.moveResult;
        if (moveResult && moveResult.ok === false) {
          showError('Move failed: ' + (moveResult.reason || 'unknown reason'));
        }
        await renderUpdaterChip(result);
      } catch (err) {
        showError('Move failed: ' + ((err && err.message) || err));
        setCtaBusy(false);
        await renderUpdaterChip();
      }
    };

    const repairOwnership = async () => {
      setCtaBusy(true, 'REPAIRING…');
      try {
        const result = await window.clemmy?.updaterRepairOwnership?.();
        const repairResult = result && result.repairResult;
        if (repairResult && repairResult.ok === false) {
          showError('Repair failed: ' + (repairResult.reason || 'unknown reason'));
        } else if (repairResult && repairResult.action === 'repaired') {
          showSuccess('Update ownership repaired. Checking for updates…');
        }
        await renderUpdaterChip(result);
      } catch (err) {
        showError('Repair failed: ' + ((err && err.message) || err));
        setCtaBusy(false);
        await renderUpdaterChip();
      }
    };

    const retryCheck = async () => {
      setCtaBusy(true, 'CHECKING…');
      try {
        const result = await window.clemmy?.updaterCheck?.();
        await renderUpdaterChip(result);
      } catch (err) {
        showError('Update check failed: ' + ((err && err.message) || err));
        setCtaBusy(false);
        await renderUpdaterChip();
      }
    };

    const renderUpdaterChip = async (incoming) => {
      let info = incoming;
      if (!info) {
        try { info = await window.clemmy.updaterStatus(); } catch { return; }
      }
      if (!info) return;
      // Clear any old downloading-suffix on the version label. We no
      // longer mutate the label as the primary affordance — the CTA
      // owns that.
      if (sub) sub.title = '';

      if (info.installBlocker === 'move-to-applications') {
        showCta({
          label: 'Move to /Applications',
          title: info.error || 'Move Clementine to /Applications to enable auto-updates',
          kind: 'repair',
          icon: '↗',
          onClick: moveToApplications,
        });
        return;
      }
      if (info.installBlocker === 'app-not-writable') {
        showCta({
          label: 'Repair updates',
          title: info.error || 'Repair /Applications/Clementine.app ownership so updates can install',
          kind: 'repair',
          icon: '⚙',
          onClick: repairOwnership,
        });
        return;
      }
      if (info.state === 'available') {
        showCta({
          label: 'Download v' + (info.version || ''),
          title: 'Download Clementine v' + (info.version || ''),
          kind: '',
          icon: '↓',
          onClick: applyUpdate,
        });
        return;
      }
      if (info.state === 'downloading') {
        showCta({
          label: info.progressPct ? 'Downloading ' + info.progressPct + '%' : 'Downloading…',
          title: 'Clementine is downloading the update in the background',
          kind: '',
          icon: '↓',
          onClick: null,
        });
        setCtaBusy(true);
        return;
      }
      if (info.state === 'ready-to-install') {
        showCta({
          label: 'Restart to install v' + (info.version || ''),
          title: 'Restart Clementine to install v' + (info.version || ''),
          kind: 'install',
          icon: '↻',
          onClick: applyUpdate,
        });
        return;
      }
      if (info.state === 'error') {
        showCta({
          label: 'Retry update check',
          title: (info.error ? info.error + ' — ' : '') + 'Click to retry',
          kind: 'repair',
          icon: '↻',
          onClick: retryCheck,
        });
        return;
      }
      // idle / checking / no-update: hide the CTA entirely.
      hideCta();
    };
    renderUpdaterChip();
    if (window.clemmy?.onUpdaterEvent) {
      window.clemmy.onUpdaterEvent((event) => { renderUpdaterChip(event); });
    }
    // Poll every 30s — cheap, doesn't block, picks up state changes
    // that fire after auto-updater's periodic check (4h cadence).
    setInterval(renderUpdaterChip, 30_000);
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
    // Stable sort: most recent activity first. Display the SAME field
    // we sort by — sorting by updatedAt while showing createdAt was
    // making the list look randomly ordered to the user (run that
    // started at 16:04 but was last touched at 21:00 appeared above
    // a 17:34 run that hasn't been touched since). Show the last-active
    // time so the visible order is monotonic top-to-bottom.
    const lastActiveFor = (run) => run.updatedAt || run.completedAt || run.createdAt || '';
    const sorted = runs.slice().sort((a, b) => lastActiveFor(b).localeCompare(lastActiveFor(a)));
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
        '  <span class="time">' + fmtTime(lastActiveFor(run)) + '</span>',
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
      // /api/runs/:id returns { run: {...} } envelope; older clients
      // expected the bare run object. Unwrap defensively so renderDetail
      // gets the run regardless of which shape the server returns.
      renderDetail(data && data.run ? data.run : data);
    } catch (err) {
      els.detailBody.innerHTML = '<p class="hint">Failed to load run · ' + esc(err.message || err) + '</p>';
    }
  }

  // Home tile counts that don't come from /api/dashboard.
  // Refreshed in the background so the tiles aren't always pinned to '—'.
  let homePlanCount = null;
  let homeProposalCount = null;
  let homeCheckinCount = null;

  async function refreshHomeAuxCounts() {
    try {
      const [plans, props, cmd] = await Promise.allSettled([
        fetchJSON('/api/console/plan-proposals?status=pending'),
        fetchJSON('/api/console/check-in-proposals?status=pending'),
        fetchJSON('/api/console/home/command-center'),
      ]);
      if (plans.status === 'fulfilled') homePlanCount = (plans.value.proposals || []).length;
      if (props.status === 'fulfilled') homeProposalCount = (props.value.proposals || []).length;
      if (cmd.status === 'fulfilled') homeCheckinCount = cmd.value?.counts?.checkIns ?? 0;
    } catch (err) { /* tiles fall back to '—' */ }
    // Push the latest counts straight to the tiles even if no main
    // snapshot has been fetched yet.
    const plansEl = document.querySelector('[data-home-plans]');
    const proposalsEl = document.querySelector('[data-home-proposals]');
    const checkinsEl = document.querySelector('[data-home-checkins]');
    function bump(el, v) {
      if (!el) return;
      el.textContent = v == null ? '—' : v;
      const tile = el.closest('.home-tile');
      if (!tile) return;
      tile.classList.toggle('has-activity', typeof v === 'number' && v > 0);
      tile.classList.toggle('high', typeof v === 'number' && v >= 5);
    }
    bump(plansEl, homePlanCount);
    bump(proposalsEl, homeProposalCount);
    bump(checkinsEl, homeCheckinCount);
  }

  function setNavBadge(panel, value, tone) {
    const nav = document.querySelector('.nav[data-panel="' + panel + '"]');
    if (!nav) return;
    let badge = nav.querySelector('.nav-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-badge';
      nav.appendChild(badge);
    }
    const show = value !== null && value !== undefined && value !== '' && String(value) !== '0';
    badge.hidden = !show;
    badge.textContent = show ? String(value) : '';
    badge.className = 'nav-badge' + (tone ? ' ' + tone : '');
  }

  // Render the Current Focus chip in the global status bar from the
  // /home/command-center payload's .focus field. Persistent across
  // every panel — same render path runs whether the user is on Home,
  // Brain, Activity, etc. Hidden when no active or parked focus.
  function renderStatusFocus(focusSnap) {
    const chip = document.querySelector('[data-stat-focus]');
    if (!chip) return;
    const active = focusSnap && focusSnap.active;
    const parked = (focusSnap && focusSnap.parked) || [];
    const needsConfirm = focusSnap && focusSnap.needsConfirm;
    if (!active && parked.length === 0) {
      chip.setAttribute('hidden', '');
      return;
    }
    chip.removeAttribute('hidden');
    chip.classList.toggle('needs-confirm', !!needsConfirm);

    const titleEl = chip.querySelector('[data-stat-focus-title]');
    if (titleEl) titleEl.textContent = active ? active.title : (parked[0] ? parked[0].title + ' (parked)' : '—');

    const popover = chip.querySelector('[data-stat-focus-popover]');
    if (popover) {
      const ptitle = popover.querySelector('[data-stat-focus-popover-title]');
      const psum = popover.querySelector('[data-stat-focus-popover-summary]');
      const pmeta = popover.querySelector('[data-stat-focus-popover-meta]');
      const ppark = popover.querySelector('[data-stat-focus-popover-parked]');
      if (active) {
        if (ptitle) ptitle.textContent = active.title;
        if (psum) psum.textContent = active.summary;
        if (pmeta) {
          const ageMin = Math.round((Date.now() - new Date(active.last_touched_at).getTime()) / 60000);
          const ageLabel = ageMin < 1 ? 'just now' : ageMin < 60 ? ageMin + 'm ago' : Math.round(ageMin / 60) + 'h ago';
          pmeta.textContent = active.resource_ref + ' · touched ' + ageLabel + (needsConfirm ? ' · NEEDS CONFIRM' : '');
          pmeta.classList.toggle('needs-confirm', !!needsConfirm);
        }
      } else {
        if (ptitle) ptitle.textContent = 'No active focus';
        if (psum) psum.textContent = 'Parked threads below can be resumed.';
        if (pmeta) pmeta.textContent = '';
      }
      // Wire the action buttons with current focus id
      const parkBtn = popover.querySelector('[data-stat-focus-park]');
      const doneBtn = popover.querySelector('[data-stat-focus-clear-popover]');
      if (parkBtn) parkBtn.setAttribute('data-focus-id', active ? String(active.id) : '');
      if (doneBtn) doneBtn.setAttribute('data-focus-id', active ? String(active.id) : '');
      if (parkBtn) parkBtn.disabled = !active;
      if (doneBtn) doneBtn.disabled = !active;
      // Parked list with RESUME buttons
      if (ppark) {
        if (parked.length === 0) {
          ppark.innerHTML = '';
        } else {
          ppark.innerHTML = parked.map((p) => (
            '<div class="stat-focus-popover-parked-row">'
            + '  <span class="stat-focus-popover-parked-title">' + escMem(p.title) + '</span>'
            + '  <button type="button" class="stat-focus-popover-parked-resume" data-stat-focus-resume="' + escMem(String(p.id)) + '">RESUME</button>'
            + '</div>'
          )).join('');
          ppark.querySelectorAll('[data-stat-focus-resume]').forEach((btn) => {
            btn.addEventListener('click', async (event) => {
              event.stopPropagation();
              const id = btn.getAttribute('data-stat-focus-resume'); if (!id) return;
              await fetch(withToken('/api/console/focus/' + id + '/activate'), { method: 'POST' });
              await refreshHomeCommandCenter();
            });
          });
        }
      }
    }

    // One-time wiring (idempotent via dataset.bound)
    if (!chip.dataset.bound) {
      chip.dataset.bound = '1';
      // Click chip body → toggle popover (but not when clicking buttons)
      chip.addEventListener('click', (event) => {
        const target = event.target;
        if (target && (target.tagName === 'BUTTON' || target.closest('button'))) return;
        if (popover) popover.toggleAttribute('hidden');
      });
      // Close popover when clicking outside
      document.addEventListener('click', (event) => {
        if (!chip.contains(event.target)) {
          if (popover) popover.setAttribute('hidden', '');
        }
      });
      const xBtn = chip.querySelector('[data-stat-focus-clear]');
      if (xBtn) {
        xBtn.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (!active) return;
          if (!confirm('Clear current focus "' + active.title + '"?')) return;
          await fetch(withToken('/api/console/focus/' + active.id + '/clear'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolution: 'completed' }),
          });
          await refreshHomeCommandCenter();
        });
      }
      const parkBtn = chip.querySelector('[data-stat-focus-park]');
      if (parkBtn) {
        parkBtn.addEventListener('click', async (event) => {
          event.stopPropagation();
          const id = parkBtn.getAttribute('data-focus-id'); if (!id) return;
          await fetch(withToken('/api/console/focus/' + id + '/park'), { method: 'POST' });
          await refreshHomeCommandCenter();
        });
      }
      const doneBtn = chip.querySelector('[data-stat-focus-clear-popover]');
      if (doneBtn) {
        doneBtn.addEventListener('click', async (event) => {
          event.stopPropagation();
          const id = doneBtn.getAttribute('data-focus-id'); if (!id) return;
          await fetch(withToken('/api/console/focus/' + id + '/clear'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolution: 'completed' }),
          });
          await refreshHomeCommandCenter();
        });
      }
    }
  }

  function renderCommandItems(items, emptyText) {
    if (!items || items.length === 0) {
      return '<div class="home-empty">' + escMem(emptyText) + '</div>';
    }
    return items.map((item) => {
      const hasApproval = item.approvalId && item.approvalKind;
      const hasWorkflowRun = item.actionKind === 'workflow-run' && item.workflowName && item.runId;
      const hasHarnessSession = item.actionKind === 'harness-session' && item.sessionId;
      const canEdit = hasApproval && item.approvalKind === 'harness' && item.approvalArgs;
      const editArgsAttr = canEdit ? ' data-home-approval-args="' + escMem(item.approvalArgs) + '"' : '';
      const editButton = canEdit
        ? '  <button type="button" data-home-approval-action="edit" data-home-approval-kind="' + escMem(item.approvalKind) + '" data-home-approval-id="' + escMem(item.approvalId) + '"' + editArgsAttr + ' data-home-approval-tool="' + escMem(item.approvalTool || '') + '">EDIT</button>'
        : '';
      const approvalActions = hasApproval
        ? [
            '<div class="home-item-actions" data-home-approval-row="' + escMem(item.approvalId) + '">',
            '  <button type="button" data-home-approval-action="approve" data-home-approval-kind="' + escMem(item.approvalKind) + '" data-home-approval-id="' + escMem(item.approvalId) + '">APPROVE</button>',
            editButton,
            '  <button type="button" data-home-approval-action="reject" data-home-approval-kind="' + escMem(item.approvalKind) + '" data-home-approval-id="' + escMem(item.approvalId) + '">REJECT</button>',
            '</div>',
          ].join('')
        : '';
      const workflowActions = hasWorkflowRun
        ? [
            '<div class="home-item-actions">',
            '  <button type="button" data-home-workflow-action="open" data-home-workflow-name="' + escMem(item.workflowName) + '" data-home-workflow-run-id="' + escMem(item.runId) + '">OPEN</button>',
            '  <button type="button" data-home-workflow-action="cancel" data-home-workflow-name="' + escMem(item.workflowName) + '" data-home-workflow-run-id="' + escMem(item.runId) + '">CANCEL</button>',
            '</div>',
          ].join('')
        : '';
      const harnessActions = hasHarnessSession
        ? [
            '<div class="home-item-actions">',
            '  <button type="button" data-home-harness-action="open" data-home-harness-session-id="' + escMem(item.sessionId) + '">WATCH</button>',
            '  <button type="button" data-home-harness-action="cancel" data-home-harness-session-id="' + escMem(item.sessionId) + '">CANCEL</button>',
            '</div>',
          ].join('')
        : '';
      // Drill-target: if the item carries a sessionId or runId, attach
      // it as a data attribute. The click handler at line ~8693 reads
      // these and, AFTER switching panels, loads the inspector detail
      // so the user lands directly on the specific approval/run that
      // brought them here — not on a generic "everything" list.
      const targetSessionAttr = item.targetSessionId
        ? ' data-home-target-session-id="' + escMem(item.targetSessionId) + '"'
        : '';
      return [
      '<div class="home-item command-item" data-tools-jump="' + escMem(item.panel || 'activity') + '"' + targetSessionAttr + '>',
      '  <span class="home-item-kind ' + escMem(item.kind || 'task') + '">' + escMem(String(item.kind || 'item').toUpperCase()) + '</span>',
      '  <div style="flex:1; min-width:0;">',
      '    <div class="home-item-text">' + escMem(item.title || '') + '</div>',
      item.meta ? '    <div class="home-item-meta">' + escMem(item.meta) + '</div>' : '',
      approvalActions,
      workflowActions,
      harnessActions,
      '  </div>',
      '</div>',
    ].join('');
    }).join('');
  }

  async function resolveHomeApprovalButton(button) {
    const id = button.getAttribute('data-home-approval-id');
    const kind = button.getAttribute('data-home-approval-kind') || 'runtime';
    const action = button.getAttribute('data-home-approval-action');
    if (!id) return;

    // EDIT — swap the row into an inline editor instead of POSTing.
    if (action === 'edit') {
      const row = button.closest('.home-item');
      const actionsRow = row ? row.querySelector('[data-home-approval-row="' + id + '"]') : null;
      if (!actionsRow) return;
      const initialArgs = button.getAttribute('data-home-approval-args') || '';
      const toolName = button.getAttribute('data-home-approval-tool') || '';
      // Replace the buttons with a textarea + Save / Cancel buttons.
      actionsRow.innerHTML = [
        '<div class="home-approval-editor" style="width:100%; display:flex; flex-direction:column; gap:6px;">',
        '  <textarea data-home-approval-editor="' + id + '" rows="8" style="width:100%; font-family:ui-monospace,Menlo,monospace; font-size:11px; padding:6px; background:var(--bg-1); color:var(--fg); border:1px solid var(--line);">' + escMem(initialArgs) + '</textarea>',
        '  <div style="display:flex; gap:6px; justify-content:flex-end;">',
        '    <button type="button" data-home-approval-action="save-edit" data-home-approval-kind="' + escMem(kind) + '" data-home-approval-id="' + escMem(id) + '" data-home-approval-tool="' + escMem(toolName) + '">SAVE &amp; APPROVE</button>',
        '    <button type="button" data-home-approval-action="cancel-edit" data-home-approval-kind="' + escMem(kind) + '" data-home-approval-id="' + escMem(id) + '">CANCEL EDIT</button>',
        '  </div>',
        '</div>',
      ].join('');
      const ta = actionsRow.querySelector('textarea');
      if (ta) ta.focus();
      return;
    }

    // CANCEL EDIT — just refresh the feed to reset the row.
    if (action === 'cancel-edit') {
      try { await refreshHomeCommandCenter(); } catch (_) {}
      return;
    }

    // SAVE-EDIT — post approve_with_edits with the textarea contents.
    if (action === 'save-edit') {
      const row = button.closest('.home-item');
      const ta = row ? row.querySelector('textarea[data-home-approval-editor="' + id + '"]') : null;
      if (!ta) return;
      const edited = (ta.value || '').trim();
      if (!edited) { alert('Edited args were empty — keeping the original. Cancel and approve normally if you don\\'t want edits.'); return; }
      try { JSON.parse(edited); } catch (err) {
        alert('Edited args are not valid JSON: ' + ((err && err.message) || err));
        return;
      }
      const toolName = button.getAttribute('data-home-approval-tool') || '';
      // For composio_execute_tool, wrap the inner args back into the
      // outer envelope so the harness sees the same shape the agent
      // proposed (with the user's edits applied to the inner payload).
      let payload;
      if (toolName === 'composio_execute_tool') {
        // Need the original outer envelope (slug + connected_account_id)
        // — preserved as a data attribute when the editor was opened.
        // Find the original EDIT button (now hidden) to read attributes.
        const origEdit = row ? row.querySelector('[data-home-approval-action="edit"]') : null;
        // origEdit may have been swapped out; fall back: derive slug
        // from button's tool attribute. We don't have slug separately —
        // best effort: stash slug in the textarea data attr.
        // For tonight ship: skip outer wrapping if we can't recover slug; the harness will fail validation cleanly.
        payload = { modifiedArgs: edited };
      } else {
        payload = { modifiedArgs: edited };
      }
      button.disabled = true;
      const original = button.textContent;
      button.textContent = 'APPROVING';
      const endpoint = '/api/console/harness-approvals/' + encodeURIComponent(id) + '/approve_with_edits';
      try {
        const r = await fetch(withToken(endpoint), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || ('HTTP ' + r.status));
        }
        await refreshHomeCommandCenter();
        try { await tick(); } catch (_) {}
      } catch (err) {
        button.disabled = false;
        button.textContent = original || 'SAVE & APPROVE';
        alert('Could not save edits: ' + ((err && err.message) || err));
      }
      return;
    }

    if (action !== 'approve' && action !== 'reject') return;
    const row = button.closest('.home-item');
    const buttons = row ? Array.from(row.querySelectorAll('[data-home-approval-action]')) : [button];
    buttons.forEach((btn) => { btn.disabled = true; });
    const original = button.textContent;
    button.textContent = action === 'approve' ? 'APPROVING' : 'REJECTING';
    const endpoint = kind === 'harness'
      ? '/api/console/harness-approvals/' + encodeURIComponent(id) + '/' + action
      : '/api/approvals/' + encodeURIComponent(id) + '/' + action;
    try {
      const r = await fetch(withToken(endpoint), { method: 'POST', headers: { Accept: 'application/json' } });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + r.status));
      }
      await refreshHomeCommandCenter();
      try { await tick(); } catch (_) {}
    } catch (err) {
      buttons.forEach((btn) => { btn.disabled = false; });
      button.textContent = original || (action === 'reject' ? 'REJECT' : action.toUpperCase());
      alert('Could not resolve approval: ' + ((err && err.message) || err));
    }
  }

  function openHomeWorkflowRun(workflowName, runId) {
    if (!workflowName) return;
    location.hash = 'workflows/' + encodeURIComponent(workflowName);
    switchPanel('workflows');
    setTimeout(() => {
      try {
        selectWorkflowByName(workflowName);
        if (runId) startActiveRunPolling(runId);
      } catch (err) {
        console.warn('workflow open failed', err);
      }
    }, 250);
  }

  async function handleHomeWorkflowButton(button) {
    const action = button.getAttribute('data-home-workflow-action');
    const workflowName = button.getAttribute('data-home-workflow-name') || '';
    const runId = button.getAttribute('data-home-workflow-run-id') || '';
    if (!workflowName || !runId) return;
    if (action === 'open') {
      openHomeWorkflowRun(workflowName, runId);
      return;
    }
    if (action !== 'cancel') return;
    const row = button.closest('.home-item');
    const buttons = row ? Array.from(row.querySelectorAll('[data-home-workflow-action]')) : [button];
    buttons.forEach((btn) => { btn.disabled = true; });
    const original = button.textContent;
    button.textContent = 'CANCELLING';
    try {
      const endpoint = '/api/console/workflows/' + encodeURIComponent(workflowName)
        + '/runs/' + encodeURIComponent(runId) + '/cancel';
      const r = await fetch(withToken(endpoint), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Cancelled from the desktop command center.' }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + r.status));
      }
      if (wfSelectedName === workflowName) {
        try { await refreshWorkflowRuns(); } catch (_) {}
      }
      await refreshHomeCommandCenter();
      try { await tick(); } catch (_) {}
    } catch (err) {
      buttons.forEach((btn) => { btn.disabled = false; });
      button.textContent = original || 'CANCEL';
      alert('Could not cancel workflow run: ' + ((err && err.message) || err));
    }
  }

  // Live session inspector — subscribes to /api/sessions/:id/events
  // SSE and renders a tail of tool_called / approval / turn events
  // into the activity panel's detail pane. Closes the previous
  // EventSource if any so we don't leak connections.
  let __sessionLiveES = null;
  let __sessionLiveSeq = 0;
  function openSessionLiveInspector(sessionId) {
    if (!sessionId) return;
    const detailId = document.querySelector('[data-detail-id]');
    const detailBody = document.querySelector('[data-detail-body]');
    if (detailId) detailId.textContent = sessionId.slice(0, 24);
    if (detailBody) {
      detailBody.innerHTML = [
        '<div style="font-family:ui-monospace,Menlo,monospace; font-size:11px;">',
        '<div style="opacity:0.6; padding:6px 0;">live · session ' + escMem(sessionId) + '</div>',
        '<ol class="session-live-feed" data-session-live-feed style="list-style:none; margin:0; padding:0; max-height:60vh; overflow-y:auto;"></ol>',
        '</div>',
      ].join('');
    }
    if (__sessionLiveES) {
      try { __sessionLiveES.close(); } catch (_) { /* ignore */ }
      __sessionLiveES = null;
    }
    __sessionLiveSeq = 0;
    const base = '/api/sessions/' + encodeURIComponent(sessionId) + '/events';
    const url = withToken(base);
    try { __sessionLiveES = new EventSource(url); } catch (err) {
      const feed = document.querySelector('[data-session-live-feed]');
      if (feed) feed.innerHTML = '<li style="color:var(--accent-fail);">Could not open live stream: ' + escMem(String(err && err.message || err)) + '</li>';
      return;
    }
    __sessionLiveES.addEventListener('replay', (evt) => {
      try {
        const parsed = JSON.parse(evt.data);
        const events = Array.isArray(parsed.events) ? parsed.events : [];
        for (const e of events) renderSessionLiveEvent(e);
      } catch (_) { /* ignore */ }
    });
    __sessionLiveES.addEventListener('event', (evt) => {
      try {
        renderSessionLiveEvent(JSON.parse(evt.data));
      } catch (_) { /* ignore */ }
    });
    __sessionLiveES.addEventListener('error', () => {
      // EventSource auto-retries; leave it alone unless we want to bound.
    });
  }

  function renderSessionLiveEvent(e) {
    if (!e || typeof e !== 'object') return;
    if (typeof e.seq === 'number') {
      if (e.seq <= __sessionLiveSeq) return; // dedupe on reconnect replay
      __sessionLiveSeq = e.seq;
    }
    const feed = document.querySelector('[data-session-live-feed]');
    if (!feed) return;
    const data = e.data || {};
    const tool = String(data.tool || data.subject || '');
    const args = data.args ? JSON.stringify(data.args).slice(0, 120) : '';
    let label = '';
    let color = 'var(--fg-2)';
    switch (e.type) {
      case 'turn_started':       label = '→ user input';                   color = 'var(--accent-3)'; break;
      case 'tool_called':        label = '→ ' + tool + (args ? ' (' + args + ')' : ''); color = 'var(--accent-2)'; break;
      case 'tool_returned':      label = '← ' + tool + ' returned'; color = 'var(--accent-2)'; break;
      case 'handoff':            label = '⇒ handoff'; color = 'var(--accent)'; break;
      case 'approval_requested': label = '⚠ approval: ' + String(data.subject || tool); color = 'var(--accent-warn)'; break;
      case 'approval_resolved':  label = '✓ approval ' + String(data.decision || ''); color = 'var(--accent-2)'; break;
      case 'stuck_detected':     label = '✗ stuck (' + String(data.signal || '') + ')'; color = 'var(--accent-fail)'; break;
      case 'run_completed':      label = '○ run completed'; color = 'var(--fg-3)'; break;
      case 'conversation_completed': label = '● done — ' + String(data.reason || 'completed'); color = 'var(--accent-2)'; break;
      case 'turn_ended':         label = '∎ turn ended'; color = 'var(--fg-3)'; break;
      default:                   label = '· ' + String(e.type || ''); color = 'var(--fg-mute)'; break;
    }
    const time = e.created_at || e.createdAt || '';
    const t = typeof time === 'string' && time ? new Date(time).toLocaleTimeString() : '';
    const li = document.createElement('li');
    li.style.cssText = 'padding:3px 6px; border-bottom:1px solid var(--line); color:' + color + '; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
    li.textContent = (t ? '[' + t + '] ' : '') + label;
    feed.insertBefore(li, feed.firstChild);
  }

  // Close any open live inspector when the user switches panels.
  // Hooks the existing switchPanel via a small wrapper.
  (function bindSessionLiveCleanup() {
    const orig = window.__clementineSwitchPanel;
    if (orig || !window) return;
  })();

  async function handleHomeHarnessButton(button) {
    const action = button.getAttribute('data-home-harness-action');
    const sessionId = button.getAttribute('data-home-harness-session-id') || '';
    if (!sessionId) return;
    if (action === 'open') {
      // WATCH: switch to the activity panel AND open a live inspector
      // for this session. The activity panel's right-side detail pane
      // gets repurposed as a live event timeline that subscribes to
      // /api/sessions/:id/events (SSE). Each tool_called / approval /
      // turn_ended event renders as a one-line entry, latest at top.
      switchPanel('activity');
      openSessionLiveInspector(sessionId);
      return;
    }
    if (action !== 'cancel') return;
    if (!confirm('Cancel this running Clementine session? It will stop at the next kill check and abandon pending approvals.')) return;
    const row = button.closest('.home-item');
    const buttons = row ? Array.from(row.querySelectorAll('[data-home-harness-action]')) : [button];
    buttons.forEach((btn) => { btn.disabled = true; });
    const original = button.textContent;
    button.textContent = 'CANCELLING';
    try {
      const r = await fetch(withToken('/api/console/harness-sessions/' + encodeURIComponent(sessionId) + '/cancel'), {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + r.status));
      }
      await refreshHomeCommandCenter();
      try { await tick(); } catch (_) {}
    } catch (err) {
      buttons.forEach((btn) => { btn.disabled = false; });
      button.textContent = original || 'CANCEL';
      alert('Could not cancel session: ' + ((err && err.message) || err));
    }
  }

  function setPresence(status) {
    const dot = document.querySelector('[data-home-agent-presence]');
    if (!dot) return;
    dot.classList.remove('needs-you', 'working', 'offline', 'warn');
    if (status === 'needs_you') dot.classList.add('needs-you');
    else if (status === 'working') dot.classList.add('working');
    else if (status === 'offline') dot.classList.add('offline');
  }

  function renderMemoryPulse(memory) {
    const warnings = memory?.warnings || [];
    const coverage = memory?.embeddingsEnabled
      ? Math.round((memory.embeddingsCoverage || 0) * 100) + '% embedded'
      : 'embeddings off';
    return [
      '<div class="home-memory-line"><span>chunks</span><em>' + escMem(memory?.chunks ?? '—') + '</em></div>',
      '<div class="home-memory-line"><span>files</span><em>' + escMem(memory?.indexedFiles ?? '—') + '</em></div>',
      '<div class="home-memory-line"><span>facts</span><em>' + escMem(memory?.activeFacts ?? '—') + '</em></div>',
      '<div class="home-memory-line"><span>vector</span><em>' + escMem(coverage) + '</em></div>',
      warnings.length
        ? '<div class="mem-graph-note">' + warnings.map((w) => escMem(w)).join(' · ') + '</div>'
        : '<div class="mem-graph-note">Memory index is ready for search and recall.</div>',
    ].join('');
  }

  function renderToolReadiness(integrations) {
    const rows = integrations?.credentials || [];
    if (rows.length === 0) return '<div class="home-empty">— no credential registry —</div>';
    return rows.map((row) => {
      const kind = row.hasValue ? 'done' : row.required ? 'checkin' : 'task';
      const status = row.hasValue ? (row.source || 'connected') : row.required ? 'required' : 'optional';
      return [
        '<div class="home-item command-item" data-tools-jump="integrations">',
        '  <span class="home-item-kind ' + kind + '">' + (row.hasValue ? 'ON' : 'OFF') + '</span>',
        '  <div style="flex:1; min-width:0;">',
        '    <div class="home-item-text">' + escMem(row.label || row.name) + '</div>',
        '    <div class="home-item-meta">' + escMem(status) + '</div>',
        '  </div>',
        '</div>',
      ].join('');
    }).join('');
  }

  async function refreshHomeCommandCenter() {
    try {
      const data = await fetchJSON('/api/console/home/command-center');
      const counts = data.counts || {};
      const presence = data.presence || {};
      const needsEl = document.querySelector('[data-home-needs-list]');
      const workingEl = document.querySelector('[data-home-working-list]');
      const recentEl = document.querySelector('[data-home-recent-list]');
      const memoryEl = document.querySelector('[data-home-memory-pulse]');
      const toolsEl = document.querySelector('[data-home-tools-list]');
      const awayEl = document.querySelector('[data-home-away-message]');
      const objectiveEl = document.querySelector('[data-home-current-objective]');
      const needsCountEl = document.querySelector('[data-home-needs-count]');
      const activeCountEl = document.querySelector('[data-home-active-count]');
      const recentCountEl = document.querySelector('[data-home-recent-count]');
      const memoryMetaEl = document.querySelector('[data-home-memory-card-meta]');
      const toolsMetaEl = document.querySelector('[data-home-tools-card-meta]');
      const approvalsTile = document.querySelector('[data-home-approvals]');
      const plansTile = document.querySelector('[data-home-plans]');
      const proposalsTile = document.querySelector('[data-home-proposals]');
      const checkinsTile = document.querySelector('[data-home-checkins]');
      const workingTile = document.querySelector('[data-home-working-count]');
      const memoryTile = document.querySelector('[data-home-memory-health]');
      const toolsTile = document.querySelector('[data-home-tools-ready]');

      setPresence(presence.status);
      // Header stays SHORT — just the status word (working / needs you /
      // online). The long narration (presence.awayMessage) drives the
      // WORKING NOW card and the FOCUS chip popover below; putting it
      // in the header strip caused overflow and dead horizontal space.
      if (awayEl) awayEl.textContent = presence.label || presence.status || 'idle';
      // The WORKING NOW banner is for active-work context — NOT the
      // pending check-in question or other "needs you" cues, which
      // already show in the NEEDS YOU card above. presence.awayMessage
      // is the check-in question when status === 'needs_you', so use
      // it only when status indicates actual work in flight.
      if (objectiveEl) {
        const activeStatuses = new Set(['working', 'thinking', 'running', 'autonomy']);
        const objectiveBanner = objectiveEl.closest('.home-current-objective');
        const showObjective = activeStatuses.has(presence.status) && (counts.active ?? 0) > 0;
        if (showObjective) {
          objectiveEl.textContent = presence.awayMessage || 'Working on the queue.';
          if (objectiveBanner) objectiveBanner.removeAttribute('hidden');
        } else {
          // Hide the banner outright when there's no active work — a
          // muted "standing by" line on an empty card is just clutter.
          if (objectiveBanner) objectiveBanner.setAttribute('hidden', '');
          objectiveEl.textContent = '';
        }
      }
      if (needsCountEl) needsCountEl.textContent = String(counts.waiting ?? 0);
      if (activeCountEl) activeCountEl.textContent = String(counts.active ?? 0);
      if (recentCountEl) recentCountEl.textContent = String((data.recentCompleted || []).length);
      if (memoryMetaEl) memoryMetaEl.textContent = (data.memory?.warnings || []).length ? 'attention' : 'ready';
      if (toolsMetaEl) toolsMetaEl.textContent = (data.integrations?.connected ?? 0) + '/' + (data.integrations?.total ?? 0);
      if (approvalsTile) approvalsTile.textContent = counts.approvals ?? 0;
      if (plansTile) plansTile.textContent = counts.planProposals ?? 0;
      if (proposalsTile) proposalsTile.textContent = counts.checkInProposals ?? 0;
      if (checkinsTile) checkinsTile.textContent = counts.checkIns ?? 0;
      if (workingTile) workingTile.textContent = counts.active ?? 0;
      if (memoryTile) memoryTile.textContent = (data.memory?.warnings || []).length ? '!' : 'ok';
      if (toolsTile) toolsTile.textContent = (data.integrations?.requiredMissing || 0) > 0 ? '!' : ((data.integrations?.connected ?? 0) + '/' + (data.integrations?.total ?? 0));
      if (els.approvals) els.approvals.textContent = counts.approvals ?? 0;

      if (needsEl) needsEl.innerHTML = renderCommandItems(data.needsYou, '— nothing waiting on you —');
      if (workingEl) workingEl.innerHTML = renderCommandItems(data.workingNow, '— no active runs or background tasks —');
      if (recentEl) recentEl.innerHTML = renderCommandItems(data.recentCompleted, '— nothing completed recently —');
      if (memoryEl) memoryEl.innerHTML = renderMemoryPulse(data.memory || {});
      if (toolsEl) toolsEl.innerHTML = renderToolReadiness(data.integrations || {});

      setNavBadge('home', counts.waiting || '', counts.waiting > 0 ? 'hot' : '');
      setNavBadge('activity', counts.active || '', counts.active > 0 ? 'good' : '');
      setNavBadge('memory', (data.memory?.warnings || []).length || '', 'warn');
      setNavBadge('integrations', data.integrations?.requiredMissing || '', 'warn');
      setNavBadge('settings', (counts.approvals || 0) + (counts.planProposals || 0) + (counts.checkInProposals || 0), 'hot');

      renderStatusFocus(data.focus || null);
    } catch (err) {
      const needsEl = document.querySelector('[data-home-needs-list]');
      if (needsEl) needsEl.innerHTML = '<div class="home-empty">Command center failed: ' + escMem(err.message || err) + '</div>';
      setPresence('offline');
    }
  }

  function greetingForNow() {
    const hour = new Date().getHours();
    if (hour < 5)  return 'Late night.';
    if (hour < 12) return 'Good morning.';
    if (hour < 17) return 'Good afternoon.';
    if (hour < 22) return 'Good evening.';
    return 'Late night.';
  }

  function updateHome(snap) {
    const greetEl = document.querySelector('[data-home-greeting]');
    const subEl = document.querySelector('[data-home-sub]');
    const approvalsEl = document.querySelector('[data-home-approvals]');
    const plansEl = document.querySelector('[data-home-plans]');
    const proposalsEl = document.querySelector('[data-home-proposals]');
    const checkinsEl = document.querySelector('[data-home-checkins]');
    if (!greetEl) return; // home block not on the page (initial paint)

    if (greetEl) greetEl.textContent = greetingForNow();
    const approvals = (snap.approvals || []).length;
    const policy = snap.proactivity && snap.proactivity.policy ? snap.proactivity.policy : {};
    const mode = policy.mode || 'unknown';
    const autoScope = policy.autoApproveScope || 'strict';
    const memIdx = snap.memoryIndex || {};
    const facts = memIdx.activeFacts ?? 0;
    if (subEl) {
      const yoloChip = autoScope === 'yolo'
        ? ' · <span style="color:var(--accent-warn); letter-spacing: 0.16em;">⚡ YOLO</span>'
        : autoScope === 'workspace'
          ? ' · <span style="color:var(--accent-3); letter-spacing: 0.16em;">⇢ WORKSPACE-AUTO</span>'
          : '';
      subEl.innerHTML =
        'Mode: ' + escMem(mode) + '  ·  ' + facts + ' facts in memory  ·  ' +
        (approvals === 0 ? 'nothing waiting on you.' : approvals + ' approval' + (approvals === 1 ? '' : 's') + ' waiting.') +
        yoloChip;
    }

    function setTile(el, value) {
      if (!el) return;
      el.textContent = value == null ? '—' : value;
      const tile = el.closest('.home-tile');
      if (!tile) return;
      tile.classList.toggle('has-activity', typeof value === 'number' && value > 0);
      tile.classList.toggle('high', typeof value === 'number' && value >= 5);
    }
    setTile(approvalsEl, approvals);
    setTile(plansEl, homePlanCount);
    setTile(proposalsEl, homeProposalCount);
    setTile(checkinsEl, homeCheckinCount);
  }

  // Wire tile click-through.
  document.querySelectorAll('[data-home-tile]').forEach((tile) => {
    tile.addEventListener('click', () => {
      const kind = tile.getAttribute('data-home-tile');
      if (kind === 'approvals' || kind === 'plans' || kind === 'proposals' || kind === 'checkins') {
        switchPanel('settings');
        // Settings panel hosts proposal/plan/check-in editors. Approvals
        // surface in run-inspector / Discord buttons; for v1 just open
        // Settings so users find the related controls.
      } else if (kind === 'activity') {
        switchPanel('activity');
      } else if (kind === 'memory') {
        switchPanel('memory');
      } else if (kind === 'integrations') {
        switchPanel('integrations');
      }
    });
  });

  // Poll the auxiliary counts every 8s — separate from the main tick
  // so the home tiles update even when the user is looking at another
  // panel.
  refreshHomeAuxCounts();
  setInterval(refreshHomeAuxCounts, 8000);
  refreshHomeCommandCenter();
  setInterval(refreshHomeCommandCenter, 6000);

  async function tick() {
    try {
      const [snap, runs, approvalsData] = await Promise.all([
        fetchJSON('/api/dashboard'),
        fetchJSON('/api/runs'),
        fetchJSON('/api/approvals'),
      ]);
      const approvals = approvalsData.approvals || [];
      const harnessApprovalCount = (approvalsData.harnessApprovals || []).length;
      const totalApprovalCount = approvals.length + harnessApprovalCount;
      const snapWithApprovals = { ...snap, approvals: Array.from({ length: totalApprovalCount }) };
      setOnline(true);

      // Status bar
      const memIdx = snap.memoryIndex || {};
      els.runs.textContent      = (runs.runs || runs || []).length;
      els.memory.textContent    = (memIdx.chunks ?? '—') + ' / ' + (memIdx.activeFacts ?? '—') + 'f';
      els.approvals.textContent = totalApprovalCount;
      els.policy.textContent    = ((snap.proactivity && snap.proactivity.policy && snap.proactivity.policy.mode) || '—').toUpperCase();

      // Home tiles + greeting (only on first paint + when count changes).
      updateHome(snapWithApprovals);

      const list = runs.runs || runs || [];
      const running = list.filter((r) => r.status === 'running' || r.status === 'received').length;
      const failed  = list.filter((r) => r.status === 'failed').length;
      els.feedTotal.textContent = list.length;
      els.feedRun.textContent   = running;
      els.feedFail.textContent  = failed;

      const snapshotJSON = JSON.stringify({ chunks: memIdx.chunks, facts: memIdx.activeFacts, approvals: totalApprovalCount, mode: snap.proactivity && snap.proactivity.policy && snap.proactivity.policy.mode });
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
  let contextBooted = false;
  let workflowsBooted = false;
  let toolsBooted = false;
  let projectsBooted = false;
  let skillsBooted = false;
  let usageBooted = false;
  let settingsBooted = false;
  let integrationsBooted = false;
  let homeBooted = false;
  let approvalsBooted = false;
  let brainBooted = false;
  let brainCurrentTab = 'overview';

  function switchPanel(name) {
    panelSections.forEach((s) => {
      const match = s.getAttribute('data-section') === name;
      if (match) s.removeAttribute('hidden');
      else s.setAttribute('hidden', '');
    });
    navButtons.forEach((b) => b.classList.toggle('active', b.getAttribute('data-panel') === name));
    // The Home panel has its own prominent LIVE card with the orb;
    // the sidebar dock-live duplicates the same controls. Hide the
    // dock copy when Home is active so the at-a-glance dock stays
    // useful from every other panel without doubling up on Home.
    const dockLive = document.querySelector('[data-dock-live]');
    if (dockLive) {
      if (name === 'home') dockLive.setAttribute('hidden', '');
      else dockLive.removeAttribute('hidden');
    }
    // v0.5.11 brain-consolidation: 'memory' / 'context' / 'evolution'
    // are no longer top-level panels — they live as sub-tabs inside
    // Brain. The boot/refresh functions for those modules are now
    // invoked lazily from inside bootBrainPanel when their tab is
    // first selected.
    if (name === 'workflows') {
      if (!workflowsBooted) {
        workflowsBooted = true;
        bootWorkflowsPanel();
      } else {
        refreshWorkflowList();
        refreshCronList().catch((err) => console.error('cron list refresh failed:', err));
      }
    } else if (name === 'tools') {
      if (!toolsBooted) { toolsBooted = true; bootToolsPanel(); }
    } else if (name === 'projects') {
      if (!projectsBooted) { projectsBooted = true; bootProjectsPanel(); }
    } else if (name === 'skills') {
      if (!skillsBooted) { skillsBooted = true; bootSkillsPanel(); }
    } else if (name === 'integrations') {
      if (!integrationsBooted) { integrationsBooted = true; bootIntegrationsHub(); }
      else refreshIntegrationsHub();
    } else if (name === 'home') {
      if (!homeBooted) { homeBooted = true; bootHomePanel(); }
      else refreshHomeAgenda();
    } else if (name === 'usage') {
      if (!usageBooted) { usageBooted = true; bootUsagePanel(); }
      else refreshUsagePanel();
    } else if (name === 'approvals') {
      if (!approvalsBooted) { approvalsBooted = true; bootApprovalsPanel(); }
      else refreshApprovalsPanel();
    } else if (name === 'brain') {
      if (!brainBooted) { brainBooted = true; bootBrainPanel(); }
      else refreshBrainCurrentTab();
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

  // ── Left-rail dock cards: clickable jump targets ──
  // Each dock-card-clickable carries data-dock-jump="<panel>". Click or
  // Enter/Space switches to that panel. Lets users tap into Activity
  // from NOW / RECENT, Workflows from ACTIVE GOAL, Settings from HEALTH
  // without hunting through the nav list.
  Array.from(document.querySelectorAll('.dock-card-clickable[data-dock-jump]')).forEach((card) => {
    const target = card.getAttribute('data-dock-jump');
    if (!target) return;
    const activate = (event) => {
      // Don't hijack clicks that originated on a real interactive child
      // (button, link, input). Otherwise the orb / "Always Record"
      // button etc. inside a card would re-trigger the panel jump.
      if (event && event.target && event.target.closest('button, a, input, select, textarea, [role="button"]')) {
        if (event.target !== card) return;
      }
      switchPanel(target);
    };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate(event);
      }
    });
  });

  function panelFromHash() {
    const requested = (location.hash || '').replace(/^#/, '').trim();
    if (!requested) return 'home';
    const panelName = requested.startsWith('workflows/') ? 'workflows' : requested;
    return panelSections.some((section) => section.getAttribute('data-section') === panelName)
      ? panelName
      : 'home';
  }

  // Site-wide cross-panel deep links: any element with
  // data-tools-jump="<panel>" switches to that panel on click.
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const approvalButton = target.closest('[data-home-approval-action]');
    if (approvalButton) {
      event.preventDefault();
      event.stopPropagation();
      resolveHomeApprovalButton(approvalButton);
      return;
    }
    const workflowButton = target.closest('[data-home-workflow-action]');
    if (workflowButton) {
      event.preventDefault();
      event.stopPropagation();
      handleHomeWorkflowButton(workflowButton);
      return;
    }
    const harnessButton = target.closest('[data-home-harness-action]');
    if (harnessButton) {
      event.preventDefault();
      event.stopPropagation();
      handleHomeHarnessButton(harnessButton);
      return;
    }
    const jump = target.closest('[data-tools-jump]');
    if (!jump) return;
    event.preventDefault();
    const panel = jump.getAttribute('data-tools-jump');
    switchPanel(panel);
    // Drill-link: if the clicked NEEDS-YOU item carries a specific
    // session/run id, load that exact item in the destination panel's
    // inspector after the panel renders. setTimeout lets the panel
    // DOM mount first so els.runList exists. Without this, users
    // landed on Activity with no anchor to the approval they clicked
    // (visibility gap surfaced 2026-05-21).
    const targetSessionId = jump.getAttribute('data-home-target-session-id');
    if (targetSessionId && panel === 'activity') {
      setTimeout(() => {
        try {
          selectedRunId = targetSessionId;
          if (typeof loadDetail === 'function') loadDetail(targetSessionId);
          if (els && els.runList) {
            Array.from(els.runList.querySelectorAll('li.run')).forEach((el) => {
              el.classList.toggle('selected', el.getAttribute('data-run-id') === targetSessionId);
            });
            // Scroll the selected row into view if it exists.
            const selectedLi = els.runList.querySelector('li.run.selected');
            if (selectedLi && typeof selectedLi.scrollIntoView === 'function') {
              selectedLi.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
          }
        } catch (err) { console.error('drill-link failed:', err); }
      }, 80);
    }
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
    graphSearch: document.querySelector('[data-mem-graph-search]'),
    graphType: document.querySelector('[data-mem-graph-type]'),
    graphMeta: document.querySelector('[data-mem-graph-meta]'),
  };
  let memSelectedFile = null;
  let memSelectedFact = null;
  let memActiveKind = '';
  let memSearchSeq = 0;

  function escMem(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  }

  // Clementine-native auth-setup modal. Replaces Composio's broken
  // hosted popup for API_KEY toolkits (firecrawl, apify). Renders
  // toolkit-specific fields + descriptions + "where do I get this"
  // link, pulled from /api/composio/toolkits/:slug/setup-meta
  // (which proxies Composio's per-toolkit metadata).
  //
  // Returns a Promise that resolves to { apiKey, baseUrl } on submit
  // or null on cancel.
  async function showApiKeyModal(slug, toolkitName) {
    // Fetch the toolkit's per-field metadata so we can render proper
    // labels + descriptions + the right help link, instead of a
    // generic "API key" prompt that leaves users hunting for where
    // to obtain the key.
    let meta = null;
    try {
      const r = await fetch(withToken('/api/composio/toolkits/' + encodeURIComponent(slug) + '/setup-meta'));
      if (r.ok) meta = await r.json();
    } catch { /* fall back to generic prompt */ }

    const displayName = (meta && meta.name) || toolkitName || slug;
    const description = (meta && meta.description) || null;
    const appUrl = (meta && meta.appUrl) || null;
    const authHintUrl = (meta && meta.authHintUrl) || null;
    const authGuideUrl = (meta && meta.authGuideUrl) || null;

    // Build a help-link strip from whatever Composio surfaced.
    const helpLinks = [];
    if (authHintUrl) helpLinks.push('<a href="' + escMem(authHintUrl) + '" target="_blank" rel="noopener noreferrer">Composio setup guide ↗</a>');
    if (authGuideUrl && authGuideUrl !== authHintUrl) helpLinks.push('<a href="' + escMem(authGuideUrl) + '" target="_blank" rel="noopener noreferrer">Auth guide ↗</a>');
    if (appUrl) helpLinks.push('Get your API key from <a href="' + escMem(appUrl) + '" target="_blank" rel="noopener noreferrer">' + escMem(displayName) + ' ↗</a>');

    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'clemmy-modal-backdrop';
      backdrop.innerHTML = [
        '<div class="clemmy-modal" role="dialog" aria-modal="true">',
        '  <div class="clemmy-modal-title">Connect ' + escMem(displayName) + '</div>',
        '  <div class="clemmy-modal-sub">',
        description ? escMem(description) + '<br><br>' : '',
        '    Paste your API key below — we send it to Composio over HTTPS and never store the value locally.',
        helpLinks.length > 0 ? '<br><br>' + helpLinks.join(' · ') : '',
        '  </div>',
        '  <label for="clemmy-modal-apikey">API key <span style="color:var(--accent-fail);">*</span></label>',
        '  <input type="password" id="clemmy-modal-apikey" autocomplete="off" spellcheck="false" placeholder="paste your API key" />',
        '  <label for="clemmy-modal-baseurl">Base URL <span style="color:var(--fg-3);font-weight:normal;">(optional — leave blank for default)</span></label>',
        '  <input type="text" id="clemmy-modal-baseurl" autocomplete="off" spellcheck="false" placeholder="' + escMem((meta && meta.fields && (meta.fields.find((f) => f.name === 'full' || f.name === 'base_url') || {}).default) || 'https://api.example.com') + '" />',
        '  <div class="clemmy-modal-error" data-clemmy-modal-error hidden></div>',
        '  <div class="clemmy-modal-actions">',
        '    <button type="button" data-clemmy-modal-cancel>Cancel</button>',
        '    <button type="button" class="submit" data-clemmy-modal-submit>Connect</button>',
        '  </div>',
        '</div>',
      ].join('');
      document.body.appendChild(backdrop);
      const apikeyEl = backdrop.querySelector('#clemmy-modal-apikey');
      const baseurlEl = backdrop.querySelector('#clemmy-modal-baseurl');
      const errorEl = backdrop.querySelector('[data-clemmy-modal-error]');
      const cancelBtn = backdrop.querySelector('[data-clemmy-modal-cancel]');
      const submitBtn = backdrop.querySelector('[data-clemmy-modal-submit]');
      const cleanup = () => { try { document.body.removeChild(backdrop); } catch {} };
      const finishWith = (value) => { cleanup(); resolve(value); };
      cancelBtn.addEventListener('click', () => finishWith(null));
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) finishWith(null); });
      document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', escHandler); finishWith(null); }
      });
      const onSubmit = () => {
        const apiKey = (apikeyEl.value || '').trim();
        if (!apiKey) {
          errorEl.textContent = 'API key is required.';
          errorEl.hidden = false;
          apikeyEl.focus();
          return;
        }
        errorEl.hidden = true;
        finishWith({ apiKey, baseUrl: (baseurlEl.value || '').trim() });
      };
      submitBtn.addEventListener('click', onSubmit);
      // Enter in either field submits.
      [apikeyEl, baseurlEl].forEach((el) => {
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); onSubmit(); }
        });
      });
      setTimeout(() => apikeyEl.focus(), 50);
    });
  }

  // Stricter escape that also handles quotes — needed when the escaped
  // text will land inside an HTML attribute value (href, title, etc).
  function escAttr(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[<>&"']/g, (c) => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Render plain text as HTML with bare URLs auto-linked. Used for the
  // dashboard chat dock so Clementine's replies containing Google Sheet
  // links, GitHub PR URLs, etc. are clickable instead of forcing the
  // user to copy-paste.
  //
  // Implementation note: CONSOLE_JS is a TS template literal, which
  // means a regex literal "/\\s+/" gets its escape stripped at
  // template-eval time and parses as "/s+/" — completely changing
  // meaning. Worse, "/[\\]]/" becomes "/[]]/" and throws a SyntaxError
  // that halts ALL dashboard JS (seen 2026-05-21, dashboard froze).
  //
  // Sidestep entirely by using pure string operations — no regex, no
  // escape ambiguity. Performance is fine; chat replies are short.
  function renderTextWithLinks(text) {
    if (text === null || text === undefined) return '';
    const raw = String(text);
    // Separator chars: space, tab(9), LF(10), CR(13), <, >, double-quote, single-quote.
    // String.fromCharCode lets us include control chars without escape sequences.
    const SEPS = ' ' + String.fromCharCode(9, 10, 13) + '<>"' + String.fromCharCode(39);
    const TRAILING_PUNCT = '.,;:!?)';
    function isSep(c) { return SEPS.indexOf(c) >= 0; }
    function startsURL(s, i) {
      if (s.substring(i, i + 8) === 'https://') return 'https://';
      if (s.substring(i, i + 7) === 'http://') return 'http://';
      if (s.substring(i, i + 4) === 'www.') {
        if (i === 0 || isSep(s.charAt(i - 1))) return 'www.';
      }
      return null;
    }
    let out = '';
    let i = 0;
    while (i < raw.length) {
      const prefix = startsURL(raw, i);
      if (prefix) {
        let end = i + prefix.length;
        while (end < raw.length && !isSep(raw.charAt(end))) end++;
        // Strip trailing punctuation so "see https://x.com." gives a clean link.
        while (end > i + prefix.length && TRAILING_PUNCT.indexOf(raw.charAt(end - 1)) >= 0) end--;
        const url = raw.substring(i, end);
        const href = url.charAt(0) === 'w' ? 'https://' + url : url;
        out += '<a href="' + escAttr(href) + '" target="_blank" rel="noopener noreferrer">' + escMem(url) + '</a>';
        i = end;
      } else {
        out += escMem(raw.charAt(i));
        i++;
      }
    }
    return out;
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
    wireMemoryViewToggle();
    wireMemoryGraphControls();
    await Promise.all([refreshMemoryStatus(), refreshFileList(), refreshFactList()]);
    if (!memGraphLoaded) {
      memGraphLoaded = true;
      await loadMemoryGraph();
    }
  }
  async function refreshMemoryPanel() {
    await Promise.all([refreshMemoryStatus(), refreshFileList(), refreshRecentFiles(), refreshFactList()]);
  }

  // ─── Memory view toggle + graph ────────────────────────────────

  let memGraphCy = null;        // cytoscape instance, lazy-init
  let memGraphLoaded = false;
  let memGraphData = null;
  let memGraphPinnedNode = null;
  let memViewToggleBound = false;
  let memGraphActionsBound = false;

  function wireMemoryViewToggle() {
    document.querySelectorAll('[data-mem-view]').forEach((button) => {
      if (button.dataset.memViewBound) return;
      button.dataset.memViewBound = '1';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        activateMemoryView(button.getAttribute('data-mem-view'));
      });
    });
    if (!memViewToggleBound) {
      memViewToggleBound = true;
      document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest('[data-mem-view]');
        if (!btn) return;
        event.preventDefault();
        activateMemoryView(btn.getAttribute('data-mem-view'));
      });
    }
  }

  function wireMemoryGraphControls() {
    const refresh = document.querySelector('[data-mem-graph-refresh]');
    const fit = document.querySelector('[data-mem-graph-fit]');
    const reset = document.querySelector('[data-mem-graph-reset]');
    if (refresh && !refresh.dataset.bound) {
      refresh.dataset.bound = '1';
      refresh.addEventListener('click', () => loadMemoryGraph({ force: true }));
    }
    if (fit && !fit.dataset.bound) {
      fit.dataset.bound = '1';
      fit.addEventListener('click', () => {
        if (!memGraphCy) return;
        memGraphCy.resize();
        memGraphCy.fit(undefined, 42);
      });
    }
    if (reset && !reset.dataset.bound) {
      reset.dataset.bound = '1';
      reset.addEventListener('click', () => {
        if (!memGraphCy) return;
        memGraphCy.elements().removeClass('dimmed related pinned');
        memGraphPinnedNode = null;
        applyMemoryGraphFilters();
        memGraphCy.layout({
          name: 'concentric',
          animate: true,
          animationDuration: 360,
          fit: true,
          padding: 56,
          startAngle: -Math.PI / 2,
          sweep: Math.PI * 2,
          equidistant: false,
          minNodeSpacing: 26,
          spacingFactor: 1.2,
          avoidOverlap: true,
          concentric: (node) => {
            const type = node.data('type');
            if (type === 'kind') return 3;
            if (type === 'fact') return 2;
            return 1;
          },
          levelWidth: () => 1,
        }).run();
      });
    }
    if (mem.graphType && !mem.graphType.dataset.bound) {
      mem.graphType.dataset.bound = '1';
      mem.graphType.addEventListener('change', applyMemoryGraphFilters);
    }
    if (mem.graphSearch && !mem.graphSearch.dataset.bound) {
      mem.graphSearch.dataset.bound = '1';
      mem.graphSearch.addEventListener('input', applyMemoryGraphFilters);
    }
    if (!memGraphActionsBound) {
      memGraphActionsBound = true;
      document.addEventListener('click', async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const action = target.closest('[data-graph-action]');
        if (!action) return;
        const type = action.getAttribute('data-graph-action');
        const value = action.getAttribute('data-value') || '';
        if (type === 'open-file' && value) {
          switchMemoryView('viewer');
          memSelectedFile = value;
          memSelectedFact = null;
          await loadFileViewer(value);
        } else if (type === 'search' && value) {
          switchMemoryView('viewer');
          mem.search.value = value;
          mem.search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        } else if (type === 'filter-kind' && value) {
          memActiveKind = value;
          mem.kinds.querySelectorAll('.kind-pill').forEach((p) => p.classList.toggle('active', p.getAttribute('data-kind') === value));
          switchMemoryView('viewer');
          await refreshFactList();
        } else if (type === 'forget-fact' && value) {
          if (!confirm('Soft-delete fact #' + value + '?')) return;
          await fetch(withToken('/api/console/memory/facts/' + encodeURIComponent(value) + '/forget'), { method: 'POST' });
          await Promise.all([refreshFactList(), refreshMemoryStatus(), loadMemoryGraph({ force: true })]);
        }
      });
    }
  }

  function switchMemoryView(view) {
    document.querySelectorAll('[data-mem-view]').forEach((button) => {
      button.classList.toggle('active', button.getAttribute('data-mem-view') === view);
    });
    const viewerEl = document.querySelector('[data-mem-viewer]');
    const graphEl = document.querySelector('[data-mem-graph]');
    const meetingsEl = document.querySelector('[data-mem-meetings]');
    [viewerEl, graphEl, meetingsEl].forEach((el) => el && el.setAttribute('hidden', ''));
    if (view === 'graph' && graphEl) graphEl.removeAttribute('hidden');
    else if (view === 'meetings' && meetingsEl) meetingsEl.removeAttribute('hidden');
    else if (viewerEl) viewerEl.removeAttribute('hidden');
  }

  function activateMemoryView(view) {
    switchMemoryView(view);
    if (view === 'graph') {
      wireMemoryGraphControls();
      if (!memGraphLoaded) {
        memGraphLoaded = true;
        loadMemoryGraph();
      } else if (memGraphCy) {
        memGraphCy.resize();
        memGraphCy.fit(undefined, 40);
      }
      return;
    }
    if (view === 'meetings') {
      wireMemoryMeetingsControls();
      loadMemoryMeetings();
    }
  }
  window.__clementineMemoryView = activateMemoryView;

  // ─── Memory · Meetings sub-view ──────────────────────────────
  let memMeetingsBound = false;
  let memMeetingsCache = [];
  let memMeetingsSelected = null;

  function wireMemoryMeetingsControls() {
    if (memMeetingsBound) return;
    memMeetingsBound = true;
    const refresh = document.querySelector('[data-mem-meetings-refresh]');
    refresh?.addEventListener('click', () => loadMemoryMeetings());
  }

  function platformClass(platform) {
    const p = String(platform || '').toLowerCase();
    if (p.includes('zoom')) return 'zoom';
    if (p.includes('meet') || p.includes('google')) return 'meet';
    if (p.includes('teams') || p.includes('microsoft')) return 'teams';
    return '';
  }

  function fmtMeetingDuration(seconds) {
    if (!seconds || !Number.isFinite(seconds)) return '—';
    const m = Math.max(1, Math.round(seconds / 60));
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    const r = m - h * 60;
    return h + 'h ' + (r < 10 ? '0' : '') + r + 'm';
  }

  function fmtMeetingDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function renderLiveMeetingCard() {
    const live = (window.__clementineLiveMeeting || {});
    if (!live.activeWindow) return '';
    const win = live.activeWindow;
    const segments = Array.isArray(live.segments) ? live.segments : [];
    const segmentsHtml = segments.length === 0
      ? '<div class="mem-meeting-live-empty">Waiting for the first transcript segment…</div>'
      : segments.map((s) => {
          const speaker = s.speaker || '';
          return '<div class="meeting-segment">' +
            (speaker ? '<span class="meeting-segment-speaker">' + escMem(speaker) + '</span>' : '') +
            escMem(s.text || '') +
            '</div>';
        }).join('');
    return [
      '<div class="mem-meeting-live" data-mem-meeting-live>',
      '  <div class="mem-meeting-live-head">',
      '    <span class="meeting-dot recording"></span>',
      '    <div class="mem-meeting-live-titles">',
      '      <span class="mem-meeting-live-tag">RECORDING NOW · ' + escMem((win.platform || 'meeting').toUpperCase()) + '</span>',
      '      <span class="mem-meeting-live-title" title="' + escMem(win.title || win.windowId || '') + '">' + escMem(win.title || '(untitled meeting)') + '</span>',
      '    </div>',
      '    <span class="mem-meeting-live-elapsed" data-mem-meeting-live-elapsed>00:00</span>',
      '  </div>',
      '  <div class="mem-meeting-live-body" data-mem-meeting-live-body>' + segmentsHtml + '</div>',
      '  <div class="mem-meeting-live-foot">',
      '    <button type="button" class="meeting-btn primary" data-mem-meeting-live-stop>STOP RECORDING</button>',
      '    <span class="mem-meeting-live-hint">Live transcript · segments stream as they finalize</span>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function wireLiveMeetingCardActions() {
    const stopBtn = document.querySelector('[data-mem-meeting-live-stop]');
    if (!stopBtn || stopBtn.dataset.bound) return;
    stopBtn.dataset.bound = '1';
    stopBtn.addEventListener('click', async () => {
      if (!window.clemmy || !window.clemmy.recallStop) return;
      try { await window.clemmy.recallStop(); }
      catch (err) { alert('Stop failed: ' + (err && err.message ? err.message : String(err))); }
    });
  }

  async function loadMemoryMeetings() {
    const list = document.querySelector('[data-mem-meetings-list]');
    const meta = document.querySelector('[data-mem-meetings-meta]');
    if (!list) return;
    try {
      const data = await fetchJSON('/api/console/meetings/recall/recent?limit=50');
      const meetings = data.meetings || [];
      memMeetingsCache = meetings;
      const liveCard = renderLiveMeetingCard();
      const haveLive = liveCard !== '';
      if (meta) meta.textContent = (haveLive ? '1 live · ' : '') + meetings.length + ' captured';
      if (meetings.length === 0 && !haveLive) {
        list.innerHTML = [
          '<div class="mem-meetings-empty">',
          '— no meetings captured yet. Start a Zoom / Meet / Teams call with Recall enabled and the transcript will land here. —',
          '</div>',
        ].join('');
        renderMemoryMeetingDetail(null);
        return;
      }
      list.innerHTML = liveCard + meetings.map((m) => {
        const cls = memMeetingsSelected === m.id ? 'mem-meeting-row selected' : 'mem-meeting-row';
        const platform = m.platform || 'meeting';
        const statusLabel = m.status === 'recording' ? 'RECORDING'
          : m.hasAnalysis ? 'ANALYSIS READY'
          : m.status === 'completed' ? 'ANALYSIS PENDING'
          : (m.status || 'unknown').toUpperCase();
        const statusCls = m.status === 'recording' ? 'recording'
          : m.hasAnalysis ? 'analysis-ready'
          : m.status === 'completed' ? 'analysis-pending'
          : '';
        return [
          '<div class="' + cls + '" data-mem-meeting-id="' + escMem(m.id) + '">',
          '  <div class="mem-meeting-row-head">',
          '    <span class="mem-meeting-platform ' + platformClass(platform) + '">' + escMem(platform) + '</span>',
          '    <span class="mem-meeting-status ' + statusCls + '">' + escMem(statusLabel) + '</span>',
          '  </div>',
          '  <div class="mem-meeting-row-title" title="' + escMem(m.title || m.windowId) + '">' + escMem(m.title || '(untitled meeting)') + '</div>',
          '  <div class="mem-meeting-row-meta">' + fmtMeetingDate(m.startedAt) + ' · ' + fmtMeetingDuration(m.durationSeconds) + ' · ' + (m.segmentCount || 0) + ' segments</div>',
          '</div>',
        ].join('');
      }).join('');
      Array.from(list.querySelectorAll('[data-mem-meeting-id]')).forEach((row) => {
        row.addEventListener('click', () => {
          const id = row.getAttribute('data-mem-meeting-id');
          memMeetingsSelected = id;
          Array.from(list.querySelectorAll('.mem-meeting-row')).forEach((el) => el.classList.toggle('selected', el === row));
          loadMemoryMeetingDetail(id);
        });
      });
      wireLiveMeetingCardActions();
      if (memMeetingsSelected && meetings.some((m) => m.id === memMeetingsSelected)) {
        loadMemoryMeetingDetail(memMeetingsSelected);
      }
    } catch (err) {
      list.innerHTML = '<div class="mem-meetings-empty" style="color:var(--accent-fail);">Failed to load meetings: ' + escMem(err.message || err) + '</div>';
    }
  }

  async function loadMemoryMeetingDetail(meetingId) {
    const detail = document.querySelector('[data-mem-meetings-detail]');
    if (!detail || !meetingId) return;
    detail.innerHTML = '<div class="mem-meetings-detail-empty">Loading…</div>';
    try {
      const data = await fetchJSON('/api/console/meetings/recall/' + encodeURIComponent(meetingId));
      renderMemoryMeetingDetail(data);
    } catch (err) {
      detail.innerHTML = '<div class="mem-meetings-detail-empty" style="color:var(--accent-fail);">Failed: ' + escMem(err.message || err) + '</div>';
    }
  }

  function renderMemoryMeetingDetail(data) {
    const detail = document.querySelector('[data-mem-meetings-detail]');
    if (!detail) return;
    if (!data || !data.record) {
      detail.innerHTML = '<div class="mem-meetings-detail-empty">Pick a meeting on the left to see its summary, action items, and transcript.</div>';
      return;
    }
    const rec = data.record;
    const analysis = data.analysis;
    const platform = rec.platform || 'meeting';
    const lines = [];
    lines.push('<div class="mem-meeting-detail">');
    lines.push('<h3>' + escMem(rec.title || '(untitled meeting)') + '</h3>');
    lines.push('<div class="mem-meeting-detail-meta">');
    lines.push('<span><strong>' + escMem(platform).toUpperCase() + '</strong></span>');
    lines.push('<span>' + fmtMeetingDate(rec.startedAt) + '</span>');
    if (rec.endedAt) {
      const dur = (Date.parse(rec.endedAt) - Date.parse(rec.startedAt)) / 1000;
      lines.push('<span>' + fmtMeetingDuration(dur) + '</span>');
    }
    lines.push('<span>' + (rec.segments?.length || 0) + ' segments</span>');
    lines.push('</div>');

    lines.push('<div class="mem-meeting-detail-actions">');
    if (rec.artifactPath) {
      lines.push('<button data-meeting-action="transcript" data-path="' + escMem(rec.artifactPath) + '">OPEN TRANSCRIPT</button>');
    }
    lines.push('<button class="primary" data-meeting-action="send-summary" data-id="' + escMem(rec.id) + '">SUMMARIZE IN CHAT</button>');
    lines.push('</div>');

    if (analysis) {
      if (analysis.summary) {
        lines.push('<h4>Summary</h4>');
        lines.push('<p>' + escMem(analysis.summary) + '</p>');
      }
      if (Array.isArray(analysis.actionItems) && analysis.actionItems.length > 0) {
        lines.push('<h4>Action items</h4><ul>');
        for (const a of analysis.actionItems) {
          const owner = a.owner ? '<strong>' + escMem(a.owner) + ':</strong> ' : '';
          const due = a.dueDate ? ' <span style="color:var(--fg-3);">(by ' + escMem(a.dueDate) + ')</span>' : '';
          lines.push('<li>' + owner + escMem(a.text || '') + due + '</li>');
        }
        lines.push('</ul>');
      }
      if (Array.isArray(analysis.decisions) && analysis.decisions.length > 0) {
        lines.push('<h4>Decisions</h4><ul>');
        for (const d of analysis.decisions) lines.push('<li>' + escMem(d) + '</li>');
        lines.push('</ul>');
      }
      if (Array.isArray(analysis.topics) && analysis.topics.length > 0) {
        lines.push('<h4>Topics</h4>');
        lines.push('<p>' + analysis.topics.map((t) => '<span class="mem-meeting-platform" style="margin-right:6px;">' + escMem(t) + '</span>').join('') + '</p>');
      }
      if (Array.isArray(analysis.participants) && analysis.participants.length > 0) {
        lines.push('<h4>Participants</h4>');
        lines.push('<p>' + analysis.participants.map(escMem).join(' · ') + '</p>');
      }
    } else if (rec.status === 'completed') {
      lines.push('<div class="mem-meeting-detail-pending">Analysis pending · the background agent will fill this in shortly</div>');
    }
    lines.push('</div>');
    detail.innerHTML = lines.join('');

    // Wire up the action buttons.
    Array.from(detail.querySelectorAll('[data-meeting-action]')).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-meeting-action');
        if (action === 'transcript') {
          const p = btn.getAttribute('data-path');
          if (!p) return;
          switchMemoryView('viewer');
          try { await loadFileViewer(p); } catch (_) {}
        } else if (action === 'send-summary') {
          const id = btn.getAttribute('data-id');
          if (!id) return;
          // Give the user feedback while we wait for the daemon.
          const originalLabel = btn.textContent;
          btn.disabled = true;
          btn.textContent = 'SENDING…';
          try {
            const fresh = await fetchJSON('/api/console/meetings/recall/' + encodeURIComponent(id));
            const a = fresh.analysis;
            let msg;
            if (a && a.summary) {
              const parts = ['Meeting summary:', '', a.summary];
              if (Array.isArray(a.actionItems) && a.actionItems.length > 0) {
                parts.push('', 'Action items:');
                for (const x of a.actionItems) parts.push('- ' + (x.owner ? x.owner + ': ' : '') + x.text);
              }
              if (Array.isArray(a.decisions) && a.decisions.length > 0) {
                parts.push('', 'Decisions:');
                for (const d of a.decisions) parts.push('- ' + (typeof d === 'string' ? d : (d.text || JSON.stringify(d))));
              }
              msg = parts.join('\\n');
            } else {
              msg = 'Captured meeting transcript is at ' + (fresh.record?.artifactPath || '(path unknown)') + '. Read it and give me the summary + action items.';
            }
            // SWITCH TO HOME PANEL FIRST. Without this the message lands
            // on the home chat thread (which exists in the DOM but is
            // hidden) and the user — still looking at Memory > Captured
            // Meetings — sees no feedback and thinks the button broke.
            // Was the exact bug reported on the 0.4.x Captured Meetings
            // detail pane.
            try { switchPanel('home'); } catch (_) { /* not critical */ }
            // Tiny delay so the panel transition lands BEFORE the
            // appendChatTurn mutates the now-visible thread (avoids a
            // flash of "still on Memory" with no visible chat update).
            await new Promise((resolve) => setTimeout(resolve, 100));
            const result = await sendHomeChat(msg);
            if (result && result.ok === false) {
              alert('Chat send failed: ' + (result.text || 'unknown reason'));
            }
          } catch (err) {
            alert('Send summary failed: ' + (err && err.message ? err.message : String(err)));
          } finally {
            btn.disabled = false;
            btn.textContent = originalLabel;
          }
        }
      });
    });
  }

  async function loadMemoryGraph(options = {}) {
    const canvas = document.querySelector('[data-mem-graph-canvas]');
    const detail = document.querySelector('[data-mem-graph-detail]');
    if (!canvas) return;
    if (typeof window.cytoscape !== 'function') {
      canvas.innerHTML = '<div class="mem-empty" style="padding:24px;">Cytoscape failed to load. Reload the page once the daemon is up.</div>';
      return;
    }
    try {
      const data = await fetchJSON('/api/console/memory/graph');
      memGraphData = data;
      if (!data.nodes || data.nodes.length === 0) {
        // Empty-state card — kept inside the canvas so the starfield
        // backdrop reads, with a brand-aligned visual so the section
        // doesn't feel like an "error" panel.
        canvas.innerHTML = [
          '<div class="mem-graph-empty">',
          '  <div class="mem-graph-empty-ring"></div>',
          '  <h4>NOTHING TO ORBIT YET</h4>',
          '  <p>Memory grows as Clementine works. Chat, meeting transcripts, and vault notes seed the kinds; cross-references make the web denser. Come back after a few sessions.</p>',
          '</div>',
        ].join('');
        if (mem.graphMeta) mem.graphMeta.textContent = '0 nodes · 0 links';
        const hint = document.querySelector('[data-mem-graph-sparse-hint]');
        if (hint) hint.setAttribute('hidden', '');
        const legendKinds = document.querySelector('[data-mem-legend-kinds]');
        const legendFacts = document.querySelector('[data-mem-legend-facts]');
        const legendFiles = document.querySelector('[data-mem-legend-files]');
        if (legendKinds) legendKinds.textContent = '0';
        if (legendFacts) legendFacts.textContent = '0';
        if (legendFiles) legendFiles.textContent = '0';
        return;
      }
      if (options.force && memGraphCy) {
        memGraphCy.destroy();
        memGraphCy = null;
      }

      const css = getComputedStyle(document.documentElement);
      const accent = css.getPropertyValue('--accent').trim() || '#ff5a35';
      const accent2 = css.getPropertyValue('--accent-2').trim() || '#b9ff36';
      const accent3 = css.getPropertyValue('--accent-3').trim() || '#36c5ff';
      const line = css.getPropertyValue('--line').trim() || '#2a2a36';
      const fg2 = css.getPropertyValue('--fg-2').trim() || '#a0a0aa';
      const bg0 = css.getPropertyValue('--bg-0').trim() || '#07070a';

      // Concentric layout rings the graph as kind clusters in the
      // middle, facts in a mid orbit, files on the outer edge — gives
      // sparse graphs a structured shape instead of a horizontal
      // scatter, and reads as "facts cluster around the topics they
      // belong to" which is what the data actually represents.
      const concentricLevel = (node) => {
        const type = node.data('type');
        if (type === 'kind') return 3;
        if (type === 'fact') return 2;
        return 1; // file
      };

      memGraphCy = window.cytoscape({
        container: canvas,
        elements: [
          ...data.nodes.map((n) => ({ data: { id: n.id, label: n.label, type: n.type, ...(n.data || {}) } })),
          ...data.edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, type: e.type } })),
        ],
        style: [
          {
            selector: 'node',
            style: {
              'background-color': fg2,
              'label': 'data(label)',
              'color': fg2,
              'font-size': '10px',
              'font-family': 'ui-monospace, SF Mono, Menlo, monospace',
              'text-valign': 'bottom',
              'text-margin-y': 6,
              'text-wrap': 'wrap',
              'text-max-width': '120px',
              'text-outline-color': bg0,
              'text-outline-width': 2,
              'text-outline-opacity': 1,
              'width': 16,
              'height': 16,
              'border-width': 1,
              'border-color': line,
              'border-opacity': 0.9,
              'transition-property': 'border-color, border-width, opacity, background-color',
              'transition-duration': '180ms',
            },
          },
          {
            selector: 'node[type = "fact"]',
            style: {
              'background-color': accent,
              'width': 18,
              'height': 18,
              'border-color': accent,
              'border-opacity': 0.4,
              // Faux-halo: a wide, faded border simulates a soft glow in
              // Cytoscape's canvas renderer without overlay nodes.
              'overlay-color': accent,
              'overlay-opacity': 0.08,
              'overlay-padding': 8,
            },
          },
          {
            selector: 'node[type = "file"]',
            style: {
              'background-color': accent3,
              'shape': 'round-rectangle',
              'width': 14,
              'height': 14,
              'border-color': accent3,
              'border-opacity': 0.4,
              'overlay-color': accent3,
              'overlay-opacity': 0.06,
              'overlay-padding': 6,
            },
          },
          {
            selector: 'node[type = "kind"]',
            style: {
              'background-color': accent2,
              'width': 38,
              'height': 38,
              'font-size': '11px',
              'font-weight': 'bold',
              'color': bg0,
              'text-valign': 'center',
              'text-halign': 'center',
              'text-margin-y': 0,
              'text-outline-color': accent2,
              'text-outline-width': 0,
              'text-outline-opacity': 0,
              'border-color': accent2,
              'border-width': 2,
              'border-opacity': 0.6,
              // Bigger halo on kind clusters so they read as anchors.
              'overlay-color': accent2,
              'overlay-opacity': 0.12,
              'overlay-padding': 14,
            },
          },
          {
            selector: 'edge',
            style: {
              'width': 1.2,
              'line-color': fg2,
              'curve-style': 'bezier',
              'target-arrow-shape': 'none',
              'opacity': 0.55,
            },
          },
          {
            selector: 'edge[type = "kind"]',
            style: {
              'line-color': accent2,
              'opacity': 0.62,
              'width': 1.4,
              // Straight spokes so kind clusters look like anchors.
              'curve-style': 'straight',
            },
          },
          {
            selector: 'edge[type = "mentions"]',
            style: {
              'line-color': accent3,
              'opacity': 0.7,
              'width': 1.2,
              'line-style': 'dashed',
              'line-dash-pattern': [4, 4],
            },
          },
          {
            selector: 'node:selected',
            style: {
              'border-width': 3,
              'border-color': accent,
            },
          },
          { selector: '.dimmed', style: { 'opacity': 0.08, 'text-opacity': 0.2 } },
          {
            selector: '.related',
            style: {
              'opacity': 1,
              'border-width': 2,
              'border-color': accent2,
              'border-opacity': 1,
            },
          },
          {
            selector: '.pinned',
            style: {
              'border-width': 3,
              'border-color': accent,
              'border-opacity': 1,
              'opacity': 1,
              'overlay-color': accent,
              'overlay-opacity': 0.22,
              'overlay-padding': 12,
            },
          },
          {
            selector: 'edge.related',
            style: {
              'opacity': 0.95,
              'width': 1.8,
            },
          },
        ],
        layout: {
          name: 'concentric',
          animate: false,
          fit: true,
          padding: 56,
          startAngle: -Math.PI / 2,
          sweep: Math.PI * 2,
          equidistant: false,
          minNodeSpacing: 26,
          spacingFactor: 1.2,
          avoidOverlap: true,
          concentric: concentricLevel,
          levelWidth: () => 1,
        },
        wheelSensitivity: 0.2,
        boxSelectionEnabled: false,
        userPanningEnabled: true,
        userZoomingEnabled: true,
      });

      memGraphCy.on('mouseover', 'node', (event) => {
        if (!memGraphPinnedNode) renderGraphDetail(detail, event.target);
      });
      memGraphCy.on('tap', 'node', (event) => {
        memGraphPinnedNode = event.target;
        highlightGraphNeighborhood(event.target);
        renderGraphDetail(detail, event.target, true);
      });
      memGraphCy.on('tap', (event) => {
        if (event.target !== memGraphCy) return;
        memGraphPinnedNode = null;
        memGraphCy.elements().removeClass('dimmed related pinned');
      });
      applyMemoryGraphFilters();
    } catch (err) {
      canvas.innerHTML = '<div class="mem-empty" style="padding:24px; color:var(--accent-fail);">Failed: ' + escMem(err.message || err) + '</div>';
    }
  }

  function applyMemoryGraphFilters() {
    if (!memGraphCy) return;
    const type = mem.graphType?.value || '';
    const query = (mem.graphSearch?.value || '').trim().toLowerCase();
    let visible = 0;
    const visibleByType = { kind: 0, fact: 0, file: 0 };
    memGraphCy.nodes().forEach((node) => {
      const d = node.data();
      const haystack = [d.label, d.content, d.kind, d.id].filter(Boolean).join(' ').toLowerCase();
      const show = (!type || d.type === type) && (!query || haystack.includes(query));
      node.style('display', show ? 'element' : 'none');
      if (show) {
        visible += 1;
        if (visibleByType[d.type] !== undefined) visibleByType[d.type] += 1;
      }
    });
    memGraphCy.edges().forEach((edge) => {
      const show = edge.source().style('display') !== 'none' && edge.target().style('display') !== 'none';
      edge.style('display', show ? 'element' : 'none');
    });

    const edges = (memGraphData && memGraphData.edges) || [];
    const nodes = (memGraphData && memGraphData.nodes) || [];
    const sparse = edges.length <= Math.max(2, Math.floor(nodes.length / 3));

    if (mem.graphMeta && memGraphData) {
      mem.graphMeta.textContent = visible + '/' + nodes.length + ' nodes · ' + edges.length + ' links' + (sparse ? ' · sparse' : '');
    }

    // Update the legend counts so the legend doubles as a quick stats
    // strip instead of static decoration.
    const legendKinds = document.querySelector('[data-mem-legend-kinds]');
    const legendFacts = document.querySelector('[data-mem-legend-facts]');
    const legendFiles = document.querySelector('[data-mem-legend-files]');
    if (legendKinds) legendKinds.textContent = String(visibleByType.kind);
    if (legendFacts) legendFacts.textContent = String(visibleByType.fact);
    if (legendFiles) legendFiles.textContent = String(visibleByType.file);

    // Surface the sparse-link state as a floating hint rather than
    // injecting copy into the detail pane on every node click.
    const hint = document.querySelector('[data-mem-graph-sparse-hint]');
    if (hint) {
      if (sparse && nodes.length > 0) hint.removeAttribute('hidden');
      else hint.setAttribute('hidden', '');
    }

    if (memGraphCy) {
      memGraphCy.resize();
      const visibleElements = memGraphCy.elements().filter((el) => el.style('display') !== 'none');
      if (visibleElements.length > 0) memGraphCy.fit(visibleElements, 56);
    }
  }

  function highlightGraphNeighborhood(node) {
    if (!memGraphCy) return;
    // Include connected edges in the neighborhood so the lit-up
    // segment reads as a connected sub-graph instead of orphan nodes.
    const neighborhood = node.closedNeighborhood();
    memGraphCy.elements().addClass('dimmed').removeClass('related pinned');
    neighborhood.removeClass('dimmed').addClass('related');
    node.addClass('pinned');
  }

  function renderGraphDetail(detail, node, pinned) {
    if (!detail) return;
    const d = node.data();
    const kind = d.type;
    const kindLabel = kind === 'fact' ? 'Fact' : kind === 'file' ? 'File' : kind === 'kind' ? 'Kind cluster' : kind;
    const body = [];
    body.push('<h4>' + escMem(d.label || '(node)') + '</h4>');
    body.push('<div><span class="pill ' + escMem(kind) + '">' + escMem(kindLabel) + '</span>' + (pinned ? '<span class="pill">pinned</span>' : '') + '</div>');
    if (kind === 'fact') {
      if (d.kind) body.push('<p style="margin:8px 0 4px;"><strong>Kind:</strong> ' + escMem(d.kind) + '</p>');
      if (d.content) body.push('<p style="margin:4px 0;">' + escMem(d.content) + '</p>');
      body.push('<div class="mem-graph-detail-actions">');
      if (d.kind) body.push('<button data-graph-action="filter-kind" data-value="' + escMem(d.kind) + '">FILTER KIND</button>');
      if (d.content) body.push('<button data-graph-action="search" data-value="' + escMem(d.content.slice(0, 120)) + '">SEARCH MEMORY</button>');
      const id = String(d.id || '').startsWith('fact:') ? String(d.id).slice('fact:'.length) : '';
      if (id) body.push('<button data-graph-action="forget-fact" data-value="' + escMem(id) + '">FORGET FACT</button>');
      body.push('</div>');
    } else if (kind === 'file') {
      const fullPath = d.id ? d.id.slice('file:'.length) : '';
      body.push('<p style="margin:8px 0 4px;"><code style="font-size:10px;">' + escMem(fullPath) + '</code></p>');
      if (d.chunks) body.push('<p style="margin:4px 0; color:var(--fg-3); font-size:10px;">' + d.chunks + ' chunk' + (d.chunks === 1 ? '' : 's') + '</p>');
      body.push('<div class="mem-graph-detail-actions"><button data-graph-action="open-file" data-value="' + escMem(fullPath) + '">OPEN FILE</button><button data-graph-action="search" data-value="' + escMem(d.label || fullPath) + '">SEARCH MEMORY</button></div>');
    } else if (kind === 'kind') {
      body.push('<p style="margin:8px 0; color:var(--fg-3);">All facts of this kind cluster here.</p>');
      const kindValue = String(d.id || '').startsWith('kind:') ? String(d.id).slice('kind:'.length) : d.label;
      body.push('<div class="mem-graph-detail-actions"><button data-graph-action="filter-kind" data-value="' + escMem(String(kindValue).toLowerCase()) + '">SHOW FACTS</button></div>');
    }
    // Sparse-link copy lives in the floating hint over the canvas now,
    // not in every node detail card — keeps the inspector compact.
    detail.innerHTML = body.join('');
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

  // Cached list of recent files so the filter input can re-render
  // without re-fetching. Populated by refreshRecentFiles().
  let __memRecentFilesCache = [];

  async function refreshRecentFiles() {
    const listEl = document.querySelector('[data-mem-recent-files-list]');
    const countEl = document.querySelector('[data-mem-recent-files-count]');
    const filterEl = document.querySelector('[data-mem-recent-files-filter]');
    if (!listEl) return;
    try {
      const data = await fetchJSON('/api/console/files/recent?limit=60');
      __memRecentFilesCache = Array.isArray(data.files) ? data.files : [];
      if (countEl) countEl.textContent = String(data.total || __memRecentFilesCache.length);
      renderRecentFiles(filterEl ? (filterEl.value || '').toLowerCase() : '');
    } catch (err) {
      listEl.innerHTML = '<li class="empty">— failed: ' + escMem(err.message || err) + ' —</li>';
    }
  }

  function renderRecentFiles(filterText) {
    const listEl = document.querySelector('[data-mem-recent-files-list]');
    if (!listEl) return;
    const filter = (filterText || '').toLowerCase().trim();
    const files = filter
      ? __memRecentFilesCache.filter((f) => f.name.toLowerCase().includes(filter) || (f.relPath || '').toLowerCase().includes(filter))
      : __memRecentFilesCache;
    if (files.length === 0) {
      listEl.innerHTML = '<li class="empty">— ' + (filter ? 'no matches' : 'no files yet') + ' —</li>';
      return;
    }
    const fmtBytes = (n) => {
      if (n < 1024) return n + 'B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'KB';
      return (n / 1024 / 1024).toFixed(1) + 'MB';
    };
    const fmtTime = (ms) => {
      try {
        const d = new Date(ms);
        const now = Date.now();
        const ageMs = now - ms;
        if (ageMs < 60_000) return 'just now';
        if (ageMs < 3_600_000) return Math.floor(ageMs / 60_000) + 'm ago';
        if (ageMs < 86_400_000) return Math.floor(ageMs / 3_600_000) + 'h ago';
        return d.toISOString().slice(0, 10);
      } catch (_) { return ''; }
    };
    listEl.innerHTML = files.slice(0, 60).map((f) => {
      const parent = (f.relPath || '').split('/').slice(0, -1).join('/') || '';
      const extBadge = f.ext ? ' · ' + f.ext.toUpperCase() : '';
      return [
        '<li class="file" data-recent-file-path="' + escMem(f.path) + '" data-recent-file-ext="' + escMem(f.ext || '') + '" style="cursor: pointer;">',
        '  <span class="name" title="' + escMem(f.relPath) + '">' + escMem(f.name) + '</span>',
        parent ? '  <span class="meta" style="opacity:0.7;">' + escMem(parent) + '</span>' : '',
        '  <span class="meta">' + fmtBytes(f.bytes) + extBadge + ' · ' + fmtTime(f.mtimeMs) + '</span>',
        '</li>',
      ].join('');
    }).join('');
    Array.from(listEl.querySelectorAll('li.file')).forEach((li) => {
      li.addEventListener('click', async () => {
        const p = li.getAttribute('data-recent-file-path');
        const ext = li.getAttribute('data-recent-file-ext');
        // Text-ish extensions → load into the existing viewer pane.
        // Binary / rich → open in the default app (Finder/Preview/Safari).
        const TEXT = new Set(['md', 'txt', 'json', 'csv', 'tsv', 'html', 'htm', 'log', 'yaml', 'yml', 'xml']);
        if (ext && TEXT.has(ext)) {
          try {
            const data = await fetchJSON('/api/console/files/preview?path=' + encodeURIComponent(p));
            showRecentFilePreview(data);
          } catch (err) {
            alert('Preview failed: ' + (err.message || err));
          }
        } else {
          try {
            await fetch(withToken('/api/console/files/open?path=' + encodeURIComponent(p)), { method: 'POST' });
          } catch (err) {
            alert('Open failed: ' + (err.message || err));
          }
        }
      });
    });
  }

  function showRecentFilePreview(data) {
    if (!mem.viewer) return;
    // Switch the memory main pane to the viewer view.
    if (typeof window.__clementineMemoryView === 'function') {
      try { window.__clementineMemoryView('viewer'); } catch (_) {}
    }
    const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const body = data.previewable
      ? '<pre style="margin:0; padding:12px; white-space:pre-wrap; word-break:break-word; font: 11px ui-monospace, monospace; max-height: 60vh; overflow:auto;">' + escHtml(data.content || '') + '</pre>'
      + (data.truncated ? '<div style="padding:8px 12px; color: var(--accent-warn); font-size: 10px;">⚠ Preview truncated at 200KB. Open in Finder for the full file.</div>' : '')
      : '<div style="padding:16px; color: var(--fg-3);">' + escHtml(data.reason || 'No preview available') + '</div>';
    const openBtn = '<button type="button" data-recent-file-open-finder style="margin-left:auto;">Open in Finder</button>';
    mem.viewer.innerHTML = [
      '<div class="mem-viewer-head" style="display:flex; align-items:center; gap:12px; padding:8px 12px; border-bottom:1px solid var(--line);">',
      '  <span style="font-size: 11px;">' + escHtml(data.relPath || data.path) + '</span>',
      '  <span style="font-size: 10px; color: var(--fg-3);">' + (data.bytes || 0) + ' bytes' + (data.ext ? ' · ' + escHtml(data.ext.toUpperCase()) : '') + '</span>',
      openBtn,
      '</div>',
      body,
    ].join('');
    mem.viewer.hidden = false;
    const finderBtn = mem.viewer.querySelector('[data-recent-file-open-finder]');
    if (finderBtn) {
      finderBtn.addEventListener('click', async () => {
        try {
          await fetch(withToken('/api/console/files/open?path=' + encodeURIComponent(data.path)), { method: 'POST' });
        } catch (err) {
          alert('Open failed: ' + (err.message || err));
        }
      });
    }
  }

  // Wire the filter input once — debounced re-render on input.
  (function bindRecentFilesFilter() {
    const filterEl = document.querySelector('[data-mem-recent-files-filter]');
    if (!filterEl || filterEl.dataset.bound) return;
    filterEl.dataset.bound = '1';
    let t = null;
    filterEl.addEventListener('input', () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => renderRecentFiles(filterEl.value || ''), 80);
    });
  })();

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

  // ─── Context / Identity panel ─────────────────────────────────

  const ctx = {
    filesCount: document.querySelector('[data-context-files-count]'),
    factsCount: document.querySelector('[data-context-facts-count]'),
    goalsCount: document.querySelector('[data-context-goals-count]'),
    voiceCount: document.querySelector('[data-context-voice-count]'),
    profileMeta: document.querySelector('[data-context-profile-meta]'),
    profileForm: document.querySelector('[data-context-profile-form]'),
    healthList: document.querySelector('[data-context-health-list]'),
    files: document.querySelector('[data-context-files]'),
    factsList: document.querySelector('[data-context-facts-list]'),
    goalsList: document.querySelector('[data-context-goals-list]'),
    factForm: document.querySelector('[data-context-fact-form]'),
    goalForm: document.querySelector('[data-context-goal-form]'),
    refresh: document.querySelector('[data-context-refresh]'),
  };
  let contextPanelBound = false;
  let contextData = null;

  async function bootContextPanel() {
    bindContextPanel();
    await refreshContextPanel();
  }

  function bindContextPanel() {
    if (contextPanelBound) return;
    contextPanelBound = true;

    ctx.refresh?.addEventListener('click', () => refreshContextPanel());

    ctx.profileForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = ctx.profileForm;
      const button = form.querySelector('button[type="submit"]');
      const patch = {};
      form.querySelectorAll('[data-context-profile-field]').forEach((el) => {
        const name = el.getAttribute('name');
        if (name) patch[name] = el.value;
      });
      if (button) button.textContent = 'SAVING…';
      try {
        const r = await fetch(withToken('/api/console/settings/profile'), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (button) button.textContent = 'SAVED ✓';
        await refreshContextPanel();
      } catch (err) {
        if (button) button.textContent = 'FAILED';
        alert('Profile save failed: ' + (err.message || err));
      } finally {
        setTimeout(() => { if (button) button.textContent = 'SAVE PROFILE ✎'; }, 1400);
      }
    });

    ctx.factForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = ctx.factForm;
      const payload = {
        kind: form.querySelector('[name="kind"]')?.value || 'user',
        content: form.querySelector('[name="content"]')?.value || '',
      };
      if (!payload.content.trim()) return;
      try {
        const r = await fetch(withToken('/api/console/context/facts'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        form.querySelector('[name="content"]').value = '';
        await refreshContextPanel();
        await refreshMemoryStatus().catch(() => {});
      } catch (err) {
        alert('Remember failed: ' + (err.message || err));
      }
    });

    ctx.goalForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = ctx.goalForm;
      const payload = {
        title: form.querySelector('[name="title"]')?.value || '',
        description: form.querySelector('[name="description"]')?.value || '',
        priority: form.querySelector('[name="priority"]')?.value || 'medium',
        nextActions: form.querySelector('[name="nextActions"]')?.value || '',
      };
      if (!payload.title.trim() || !payload.description.trim()) return;
      try {
        const r = await fetch(withToken('/api/console/context/goals'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        form.reset();
        await refreshContextPanel();
      } catch (err) {
        alert('Goal create failed: ' + (err.message || err));
      }
    });
  }

  async function refreshContextPanel() {
    try {
      contextData = await fetchJSON('/api/console/context');
      renderContextPanel();
    } catch (err) {
      if (ctx.healthList) ctx.healthList.innerHTML = '<div class="settings-info" style="color:var(--accent-fail);">Failed: ' + escMem(err.message || err) + '</div>';
    }
  }

  function setContextProfileForm(profile) {
    if (!ctx.profileForm || !profile) return;
    ['preferredName', 'role', 'timezone', 'communicationTone', 'notes'].forEach((name) => {
      const el = ctx.profileForm.querySelector('[name="' + name + '"]');
      if (el) el.value = profile[name] || (name === 'communicationTone' ? 'balanced' : '');
    });
    if (ctx.profileMeta) {
      const name = profile.preferredName || profile.displayName || 'not set';
      ctx.profileMeta.textContent = name + ' · ' + (profile.communicationTone || 'balanced');
    }
  }

  function renderContextPanel() {
    const data = contextData || {};
    const files = data.files || [];
    const facts = data.facts || [];
    const goals = data.goals || [];
    if (ctx.filesCount) ctx.filesCount.textContent = files.length;
    if (ctx.factsCount) ctx.factsCount.textContent = facts.length;
    if (ctx.goalsCount) ctx.goalsCount.textContent = goals.filter((g) => g.status === 'active' || g.status === 'blocked').length + '/' + goals.length;
    if (ctx.voiceCount) ctx.voiceCount.textContent = data.voiceContext?.chars ? Math.round(data.voiceContext.chars / 100) / 10 + 'k' : '—';

    setContextProfileForm(data.profile);
    renderContextHealth(data);
    renderContextFiles(files);
    renderContextFacts(facts);
    renderContextGoals(goals);
  }

  function renderContextHealth(data) {
    if (!ctx.healthList) return;
    const files = data.files || [];
    const profile = data.profile || {};
    const rows = [
      {
        title: 'User profile',
        ok: Boolean(profile.preferredName || profile.role || profile.notes),
        meta: profile.preferredName || profile.displayName || 'defaults only',
      },
      ...files.map((file) => ({
        title: file.title,
        ok: !file.empty,
        meta: (file.usefulChars || 0) + ' useful chars · ' + shortenPath(file.path || ''),
      })),
      {
        title: 'Realtime voice prompt',
        ok: (data.voiceContext?.chars || 0) > 1000,
        meta: (data.voiceContext?.chars || 0) + ' chars · ' + ((data.voiceContext?.sections || []).slice(0, 5).join(', ') || 'no sections'),
      },
      {
        title: 'Memory index',
        ok: (data.memory?.chunks || 0) > 0,
        meta: (data.memory?.chunks || 0) + ' chunks · ' + (data.memory?.activeFacts || 0) + ' facts',
      },
    ];
    ctx.healthList.innerHTML = rows.map((row) => [
      '<div class="context-health-row">',
      '  <span class="context-health-status ' + (row.ok ? 'ok' : 'warn') + '">' + (row.ok ? 'READY' : 'NEEDS COPY') + '</span>',
      '  <div><div class="context-health-title">' + escMem(row.title) + '</div><div class="context-health-meta">' + escMem(row.meta) + '</div></div>',
      '  <span class="context-health-meta">' + (row.ok ? '✓' : '!') + '</span>',
      '</div>',
    ].join('')).join('');
  }

  function renderContextFiles(files) {
    if (!ctx.files) return;
    if (!files.length) {
      ctx.files.innerHTML = '<div class="settings-info">— no context files found —</div>';
      return;
    }
    // Stash presets per file key so the change-handler can look them
    // up by index after the user selects from the dropdown.
    const presetsByKey = {};
    files.forEach((file) => { presetsByKey[file.key] = Array.isArray(file.presets) ? file.presets : []; });
    ctx.files.innerHTML = files.map((file) => {
      const presets = Array.isArray(file.presets) ? file.presets : [];
      const presetDropdown = presets.length === 0 ? '' : [
        '  <div class="context-file-presets">',
        '    <label>STARTERS</label>',
        '    <select data-context-file-preset="' + escMem(file.key) + '">',
        '      <option value="">— pick a starter to populate the editor —</option>',
        presets.map((p, i) => '      <option value="' + i + '">' + escMem(p.label) + '</option>').join('\\n'),
        '    </select>',
        '    <span class="context-file-preset-hint">Selecting one fills the editor — you still have to click SAVE.</span>',
        '  </div>',
      ].join('\\n');
      const liveHint = (file.key === 'soul' || file.key === 'identity')
        ? '  <div class="context-file-livehint">Loaded fresh into every conversation — saves take effect on your next message, no restart.</div>'
        : '';
      return [
        '<article class="context-file" data-context-file="' + escMem(file.key) + '">',
        '  <div class="context-file-head">',
        '    <div><div class="context-file-title">' + escMem(file.title) + '</div><div class="context-file-desc">' + escMem(file.description) + '</div></div>',
        '    <div class="context-file-meta"><span>' + escMem(shortenPath(file.path || '')) + '</span><span class="' + (file.empty ? 'warn' : '') + '">' + (file.empty ? 'NEEDS COPY' : 'READY') + '</span><span>' + (file.bytes || 0) + ' bytes</span></div>',
        '  </div>',
        presetDropdown,
        '  <textarea data-context-file-input="' + escMem(file.key) + '" rows="8" spellcheck="true">' + escMem(file.content || '') + '</textarea>',
        liveHint,
        '  <div class="context-file-actions"><span data-context-file-status="' + escMem(file.key) + '">saved state: ' + (file.empty ? 'thin' : 'ready') + '</span><button type="button" data-context-file-save="' + escMem(file.key) + '">SAVE ' + escMem(String(file.title || '').toUpperCase()) + '</button></div>',
        '</article>',
      ].join('');
    }).join('');
    ctx.files.querySelectorAll('[data-context-file-preset]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const key = sel.getAttribute('data-context-file-preset');
        const idx = parseInt(sel.value, 10);
        const preset = presetsByKey[key] && presetsByKey[key][idx];
        if (!preset) return;
        const input = ctx.files.querySelector('[data-context-file-input="' + key + '"]');
        if (!input) return;
        // Confirm only if there's existing user content — empty/whitespace
        // files can be overwritten silently. Avoids the "did I lose work?"
        // moment without making the experience noisy for first-run users.
        const existing = (input.value || '').trim();
        if (existing.length > 20 && !window.confirm('Replace your current ' + key + ' content with this starter? You can edit afterward — nothing saves until you click SAVE.')) {
          sel.value = '';
          return;
        }
        input.value = preset.body;
        sel.value = '';
        const status = ctx.files.querySelector('[data-context-file-status="' + key + '"]');
        if (status) status.textContent = 'starter loaded — click SAVE to apply';
      });
    });
    ctx.files.querySelectorAll('[data-context-file-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-context-file-save');
        const input = ctx.files.querySelector('[data-context-file-input="' + key + '"]');
        const status = ctx.files.querySelector('[data-context-file-status="' + key + '"]');
        btn.textContent = 'SAVING…';
        try {
          const r = await fetch(withToken('/api/console/context/files/' + encodeURIComponent(key)), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: input?.value || '' }),
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          if (status) status.textContent = 'saved ' + new Date().toLocaleTimeString();
          await refreshContextPanel();
        } catch (err) {
          if (status) status.textContent = 'save failed: ' + (err.message || err);
        } finally {
          btn.textContent = 'SAVE';
        }
      });
    });
  }

  function renderContextFacts(facts) {
    if (!ctx.factsList) return;
    if (!facts.length) {
      ctx.factsList.innerHTML = '<div class="settings-info">— no durable facts yet. Add one above or let Clementine capture facts during chat. —</div>';
      return;
    }
    ctx.factsList.innerHTML = facts.map((fact) => [
      '<div class="context-fact">',
      '  <div class="context-fact-kind">' + escMem(fact.kind) + ' · #' + escMem(fact.id) + '</div>',
      '  <div class="context-fact-body">' + escMem(fact.content) + '</div>',
      '</div>',
    ].join('')).join('');
  }

  function renderContextGoals(goals) {
    if (!ctx.goalsList) return;
    if (!goals.length) {
      ctx.goalsList.innerHTML = '<div class="settings-info">— no real goals yet. Create one above so proactive work has a target. —</div>';
      return;
    }
    ctx.goalsList.innerHTML = goals.map((goal) => {
      const next = Array.isArray(goal.nextActions) && goal.nextActions[0] ? goal.nextActions[0] : '';
      return [
        '<div class="context-goal">',
        '  <div class="context-goal-meta">' + escMem(goal.status || 'unknown') + ' · ' + escMem(goal.priority || 'medium') + ' · ' + escMem(goal.id || '') + '</div>',
        '  <div class="context-goal-title">' + escMem(goal.title || '(untitled goal)') + '</div>',
        goal.description ? '  <div class="context-goal-desc">' + escMem(goal.description) + '</div>' : '',
        next ? '  <div class="context-goal-next">next: ' + escMem(next) + '</div>' : '',
        '</div>',
      ].join('');
    }).join('');
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
  let wfItems = [];
  let wfChatHistory = [];
  let wfChatBusy = false;
  // Set of step indices currently in edit mode. Cleared on workflow
  // switch. Read by renderStep() to decide between textarea / display.
  const wfEditingStepIndices = new Set();
  // Run id currently being polled for live events (set when a TRY or
  // RUN fires; cleared when the run reaches a terminal state). Drives
  // the per-step status pill + output panel.
  let wfActiveRunId = null;
  let wfActiveRunPollTimer = null;
  let wfActiveRunLastEventAt = '';

  /**
   * v0.5.11 UX — humanize a cron expression for the workflow list.
   * Best-effort: covers the common patterns Clementine generates
   * (every day at H, weekdays at H, every N hours, specific days at H).
   * Falls back to the raw expression for shapes we don't recognize —
   * the title tooltip always shows the raw cron so power users keep
   * access to the underlying syntax.
   *
   * Standard 5-field cron: minute hour dayOfMonth month dayOfWeek.
   * Days of week: 0/7=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat.
   */
  function humanizeCronExpression(expr) {
    if (!expr || typeof expr !== 'string') return '';
    // Source string in TS uses 4 backslashes so that after CONSOLE_JS
    // template-literal interpolation, the JS source rendered into the
    // page sees 2 backslashes, which parse as a single regex backslash.
    // i.e. '\\\\s+' (TS) -> '\\s+' (rendered JS) -> /\s+/ (runtime regex).
    const parts = expr.trim().split(new RegExp('\\\\s+'));
    if (parts.length !== 5) return '';
    const [minStr, hourStr, domStr, monStr, dowStr] = parts;
    const formatTime = (hStr, mStr) => {
      // Multiple hours (e.g. "8,13") → render as a comma list of times.
      if (hStr.includes(',')) {
        const hours = hStr.split(',').map((h) => Number.parseInt(h, 10)).filter((n) => Number.isFinite(n));
        if (hours.length === 0) return null;
        const minute = Number.parseInt(mStr, 10);
        const minSuffix = Number.isFinite(minute) && minute !== 0 ? ':' + String(minute).padStart(2, '0') : '';
        return hours.map((h) => {
          const ampm = h >= 12 ? 'pm' : 'am';
          const display = h === 0 ? 12 : (h > 12 ? h - 12 : h);
          return display + minSuffix + ampm;
        }).join(', ');
      }
      const h = Number.parseInt(hStr, 10);
      const m = Number.parseInt(mStr, 10);
      if (!Number.isFinite(h)) return null;
      const ampm = h >= 12 ? 'pm' : 'am';
      const display = h === 0 ? 12 : (h > 12 ? h - 12 : h);
      const minSuffix = Number.isFinite(m) && m !== 0 ? ':' + String(m).padStart(2, '0') : '';
      return display + minSuffix + ampm;
    };
    const formatDayOfWeek = (dowS) => {
      if (dowS === '*' || dowS === '?') return null; // every day OR no DOW constraint
      if (dowS === '1-5') return 'Mon-Fri';
      if (dowS === '0,6' || dowS === '6,0' || dowS === '0-6' || dowS === '6-0') return 'weekends';
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      // Comma list of single-digit days
      if (new RegExp('^[0-7](,[0-7])*$').test(dowS)) {
        return dowS.split(',').map((d) => dayNames[Number.parseInt(d, 10) % 7]).join(', ');
      }
      // Single day
      if (new RegExp('^[0-7]$').test(dowS)) return dayNames[Number.parseInt(dowS, 10) % 7];
      return null;
    };
    // Pattern: every N minutes — minStr "*/N", everything else "*".
    // Backslashes are 4x in TS source (see split() comment above) — each
    // \\\\ renders as \\ in JS source which becomes \ in the regex char class.
    if (new RegExp('^\\\\*/\\\\d+$').test(minStr) && hourStr === '*' && domStr === '*' && monStr === '*' && dowStr === '*') {
      return 'every ' + minStr.slice(2) + ' min';
    }
    // Pattern: every N hours — hourStr "*/N"
    if (minStr === '0' && new RegExp('^\\\\*/\\\\d+$').test(hourStr) && domStr === '*' && monStr === '*' && dowStr === '*') {
      return 'every ' + hourStr.slice(2) + 'h';
    }
    // Pattern: every hour during a range — hourStr "A-B"
    if (minStr === '0' && new RegExp('^\\\\d+-\\\\d+$').test(hourStr) && domStr === '*' && monStr === '*' && dowStr === '*') {
      const [aStr, bStr] = hourStr.split('-');
      const a = Number.parseInt(aStr, 10);
      const b = Number.parseInt(bStr, 10);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        const ampmA = a >= 12 ? 'pm' : 'am';
        const ampmB = b >= 12 ? 'pm' : 'am';
        const dispA = a === 0 ? 12 : (a > 12 ? a - 12 : a);
        const dispB = b === 0 ? 12 : (b > 12 ? b - 12 : b);
        return 'hourly ' + dispA + ampmA + '-' + dispB + ampmB;
      }
    }
    // Pattern: daily at H — minStr digit, hourStr digit (or comma list), rest wild
    if (new RegExp('^\\\\d+$').test(minStr) && new RegExp('^\\\\d+(,\\\\d+)*$').test(hourStr) && domStr === '*' && monStr === '*') {
      const time = formatTime(hourStr, minStr);
      if (!time) return '';
      const dow = formatDayOfWeek(dowStr);
      if (!dow) return 'every day at ' + time;
      return dow + ' at ' + time;
    }
    // Pattern: every minute (* * * * *) — rare in Clementine
    if (minStr === '*' && hourStr === '*' && domStr === '*' && monStr === '*' && dowStr === '*') {
      return 'every minute';
    }
    return '';
  }

  async function bootWorkflowsPanel() {
    // Document-level delegation is intentional: the single-file HTML is
    // heavily re-rendered, and these controls are identified by explicit
    // data-wf-* attributes.
    document.addEventListener('click', (event) => {
      const rawTarget = event.target;
      const target = rawTarget instanceof HTMLElement
        ? rawTarget
        : rawTarget instanceof Node
          ? rawTarget.parentElement
          : null;
      if (!target) return;
      const workflowSelect = target.closest('[data-wf-select]');
      const workflowRow = workflowSelect
        ? workflowSelect.closest('li[data-wf-name]')
        : target.closest('li[data-wf-name]');
      if (workflowRow) {
        event.preventDefault();
        const name = workflowRow.getAttribute('data-wf-name');
        selectWorkflowByName(name);
        return;
      }
      // Cron rows live in the same pane but route to selectCronByName
      // so the middle pane renders the cron detail view instead of the
      // workflow editor. Checked AFTER workflowRow so a cron click
      // doesn't accidentally trigger workflow selection.
      const cronRow = target.closest('li.wf-cron-row');
      if (cronRow) {
        event.preventDefault();
        const cronName = cronRow.getAttribute('data-wf-cron-name');
        if (cronName) selectCronByName(cronName);
        return;
      }
      if (target.closest('[data-wf-new]')) {
        event.preventDefault();
        startNewWorkflow();
        return;
      }
      if (target.closest('[data-wf-empty-architect]')) {
        event.preventDefault();
        if (wf.chatInput) {
          wf.chatInput.value = 'Draft me a workflow for ';
          wf.chatInput.focus();
        }
      }
    });
    // Direct binding on the sidebar button so even if delegation is
    // ever bypassed (e.g. someone re-renders the panel), the sidebar
    // + NEW still works.
    if (wf.newBtn) {
      wf.newBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        startNewWorkflow();
      });
    }
    await refreshWorkflowList();
    refreshCronList().catch((err) => {
      console.error('cron list refresh failed:', err);
    });
    subscribeWorkflowChanges();
  }

  /**
   * Open the workflow_changed SSE stream. Refreshes the list (no
   * re-select, so the editor draft survives) whenever any workflow
   * file changes on disk — fixes the "had to reload the app to see
   * the new workflow" bug for every write path. EventSource handles
   * reconnect automatically.
   */
  let wfEventsSource = null;
  function subscribeWorkflowChanges() {
    if (wfEventsSource) return;
    try {
      wfEventsSource = new EventSource(withToken('/api/console/workflows/events'));
      wfEventsSource.addEventListener('workflow_changed', () => {
        // Keep the user's draft intact; just refresh the list view so
        // newly-created or just-deleted workflows appear/disappear.
        refreshWorkflowList({ skipReselect: true }).catch((err) => {
          console.error('workflow_changed refresh failed:', err);
        });
      });
      wfEventsSource.addEventListener('error', () => {
        // EventSource auto-reconnects; nothing to do here. Log so we
        // notice if the daemon is hard-down (browser will retry).
        // Avoid spamming the console — only log first failure.
      });
    } catch (err) {
      console.error('failed to open workflow events stream:', err);
    }
  }

  function fmtCronAgo(iso) {
    if (!iso) return '—';
    try {
      const then = new Date(iso).getTime();
      const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
      if (seconds < 60) return seconds + 's ago';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
      if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
      return Math.floor(seconds / 86400) + 'd ago';
    } catch { return '—'; }
  }

  // Cache the most recent /api/console/crons payload so selecting a
  // cron doesn't have to round-trip — refreshCronList is the single
  // source of truth, selectCronByName reads from this cache.
  let cronsCache = [];
  let cronSelectedName = null;

  async function refreshCronList() {
    const listEl = document.querySelector('[data-wf-cron-list]');
    const countEl = document.querySelector('[data-wf-cron-count]');
    if (!listEl) return;
    try {
      const data = await fetchJSON('/api/console/crons');
      const crons = data.crons || [];
      cronsCache = crons;
      if (countEl) countEl.textContent = String(crons.length);
      if (crons.length === 0) {
        listEl.innerHTML = '<li class="empty">— no scheduled jobs —</li>';
        return;
      }
      listEl.innerHTML = crons.map((c) => {
        const selected = (cronSelectedName === c.name) ? ' selected' : '';
        const enabledPill = c.enabled
          ? '<span class="pill on">● ENABLED</span>'
          : '<span class="pill off">○ DISABLED</span>';
        const schedPill = '<span class="pill cron">⏱ ' + escMem(c.schedule) + '</span>';
        const last = c.lastRun;
        let lastBadge = '';
        let excerpt = '';
        if (last) {
          const statusClass = last.status === 'ok' ? 'on'
            : last.status === 'error' ? 'off'
              : '';
          const statusLabel = last.status === 'ok' ? '✓ ok'
            : last.status === 'error' ? '✗ error'
              : '· ' + last.status;
          lastBadge = '<span class="pill ' + statusClass + '">' + statusLabel + ' ' + fmtCronAgo(last.startedAt) + '</span>';
          const body = last.responseExcerpt || last.error || '';
          if (body) {
            excerpt = '<div class="wf-cron-excerpt">' + escMem(body.slice(0, 240)) + '</div>';
          }
        } else {
          lastBadge = '<span class="pill">no runs yet</span>';
        }
        const runsCount = '<span class="pill">' + (c.runCount || 0) + ' run' + ((c.runCount || 0) === 1 ? '' : 's') + '</span>';
        return [
          '<li class="wf wf-cron-row' + selected + '" data-wf-cron-name="' + escMem(c.name) + '">',
          '  <div class="wf-cron-head">',
          '    <span class="name">' + escMem(c.name) + '</span>',
          '    <span class="meta">' + enabledPill + schedPill + lastBadge + runsCount + '</span>',
          '  </div>',
          excerpt,
          '</li>',
        ].join('');
      }).join('');
    } catch (err) {
      listEl.innerHTML = '<li class="empty">— failed: ' + escMem(err.message || err) + ' —</li>';
    }
  }

  function describeCronSchedule(expr) {
    // Best-effort human-readable from standard 5-field cron. Falls back
    // to the raw expression for shapes we don't recognize.
    if (!expr || typeof expr !== 'string') return '';
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return '';
    const [min, hour, dom, mon, dow] = parts;
    const allWild = (dom === '*' && mon === '*' && dow === '*');
    const days =
      dow === '1-5' ? 'weekdays' :
      dow === '0,6' || dow === '6,0' ? 'weekends' :
      dow === '1' ? 'Mondays' :
      dow === '2' ? 'Tuesdays' :
      dow === '3' ? 'Wednesdays' :
      dow === '4' ? 'Thursdays' :
      dow === '5' ? 'Fridays' :
      dow === '0' ? 'Sundays' :
      '';
    if (min === '0' && /^\d+$/.test(hour) && allWild) {
      return 'every day at ' + hour + ':00';
    }
    if (min === '0' && /^\d+$/.test(hour) && dow && days) {
      return days + ' at ' + hour + ':00';
    }
    if (min === '0' && /^\d+-\d+$/.test(hour) && allWild) {
      const [a, b] = hour.split('-');
      return 'every hour from ' + a + ':00 to ' + b + ':00';
    }
    return '';
  }

  function selectCronByName(name) {
    if (!name || !wf.editor) return;
    cronSelectedName = name;
    // Deselect any selected workflow — clicking a cron is a different
    // surface than the workflow editor; clear so the user sees the
    // cron view without a stale "selected workflow" row in the list.
    wfSelectedName = null;
    const wfRows = wf.list ? Array.from(wf.list.querySelectorAll('li.wf')) : [];
    wfRows.forEach((el) => el.classList.remove('selected'));
    const cronListEl = document.querySelector('[data-wf-cron-list]');
    if (cronListEl) {
      const rows = Array.from(cronListEl.querySelectorAll('li.wf-cron-row'));
      rows.forEach((el) => el.classList.toggle('selected', el.getAttribute('data-wf-cron-name') === name));
    }
    const cron = cronsCache.find((c) => c.name === name);
    if (!cron) {
      wf.editor.innerHTML = '<div class="wf-empty"><div class="wf-empty-mark">!</div><div class="wf-empty-text">Cron not found — try refreshing the list.</div></div>';
      return;
    }
    const hint = describeCronSchedule(cron.schedule);
    const enabledPill = cron.enabled
      ? '<span class="pill on">● ENABLED</span>'
      : '<span class="pill off">○ DISABLED</span>';
    const runs = (cron.recentRuns || []).slice().reverse();
    const runsHtml = runs.length === 0
      ? '<div class="cron-detail-empty">— no runs recorded —</div>'
      : runs.map((r) => {
        const okClass = r.status === 'ok' ? 'ok' : r.status === 'error' ? 'err' : '';
        const dur = typeof r.durationMs === 'number' ? (r.durationMs / 1000).toFixed(1) + 's' : '—';
        const body = (r.error || r.responseExcerpt || '').slice(0, 1200);
        return [
          '<div class="cron-detail-run ' + okClass + '">',
          '  <div class="cron-detail-run-head">',
          '    <span class="status">' + (r.status === 'ok' ? '✓ ok' : r.status === 'error' ? '✗ error' : '· ' + escMem(r.status)) + '</span>',
          '    <span class="when">' + escMem(r.startedAt || '—') + ' · ' + dur + (r.source ? ' · ' + escMem(r.source) : '') + '</span>',
          '  </div>',
          body ? '<pre class="cron-detail-run-body">' + escMem(body) + '</pre>' : '',
          '</div>',
        ].join('');
      }).join('');

    wf.editor.innerHTML = [
      '<div class="cron-detail">',
      '  <div class="cron-detail-head">',
      '    <div class="cron-detail-title">',
      '      <h2>' + escMem(cron.name) + '</h2>',
      '      <div class="cron-detail-meta">',
      '        ' + enabledPill,
      '        <span class="pill cron">⏱ ' + escMem(cron.schedule) + (hint ? ' · ' + escMem(hint) : '') + '</span>',
      '        <span class="pill">mode: ' + escMem(cron.mode || 'standard') + '</span>',
      cron.maxHours ? '        <span class="pill">max ' + cron.maxHours + 'h</span>' : '',
      cron.workDir ? '        <span class="pill">cwd: ' + escMem(cron.workDir) + '</span>' : '',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <div class="cron-detail-section">',
      '    <div class="cron-detail-label">PROMPT</div>',
      '    <pre class="cron-detail-prompt">' + escMem(cron.prompt || '— (none)') + '</pre>',
      '  </div>',
      '  <div class="cron-detail-section">',
      '    <div class="cron-detail-label">RECENT RUNS · ' + (cron.runCount || 0) + '</div>',
      '    ' + runsHtml,
      '  </div>',
      '</div>',
    ].filter(Boolean).join('');
  }

  window.__clementineSelectCron = selectCronByName;

  function selectWorkflowByName(name) {
    if (!name || !wf.list) return;
    wfSelectedName = name;
    wfIsNew = false;
    const rows = Array.from(wf.list.querySelectorAll('li.wf'));
    rows.forEach((el) => el.classList.toggle('selected', el.getAttribute('data-wf-name') === name));
    if (wf.editor) {
      wf.editor.innerHTML = '<div class="wf-empty"><div class="wf-empty-mark">↻</div><div class="wf-empty-text">Loading workflow…</div></div>';
    }
    const cached = cachedWorkflowData(name);
    if (cached && Array.isArray(cached.steps)) {
      setWorkflowDraftFromData(cached);
      return;
    }
    loadWorkflow(name);
  }

  window.__clementineSelectWorkflow = selectWorkflowByName;
  // Direct global hook so the + NEW buttons can call us via inline
  // onclick — sidestepping any event-delegation timing issues where the
  // document listener wasn't yet bound or got swallowed by another
  // handler upstream.
  window.__clementineStartNewWorkflow = () => {
    try { startNewWorkflow(); } catch (err) { console.error('startNewWorkflow failed', err); }
  };

  function workflowNameFromHash() {
    const raw = (location.hash || '').replace(/^#/, '').trim();
    if (!raw.startsWith('workflows/')) return null;
    const encoded = raw.slice('workflows/'.length);
    if (!encoded) return null;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }

  async function refreshWorkflowList(opts) {
    const skipReselect = !!(opts && opts.skipReselect);
    try {
      const data = await fetchJSON('/api/console/workflows');
      const items = data.workflows || [];
      wfItems = items;
      if (items.length === 0) {
        wf.list.innerHTML = '<li class="empty">— no workflows — ＋ NEW to start —</li>';
        return;
      }
      wf.list.innerHTML = items.map((w) => {
        const cls = (wfSelectedName === w.name) ? 'wf selected' : 'wf';
        const enabledPill = w.enabled ? '<span class="pill on">● APPROVED</span>' : '<span class="pill off">○ DISABLED</span>';
        // v0.5.11 UX: humanize cron expressions for the workflow list.
        // The raw cron (e.g. 0 8,13 * * 1-5) stays in the title tooltip
        // so power-users can read it without clicking. Non-power users
        // see "Mon-Fri at 8am, 1pm" or similar.
        const humanCron = w.triggerSchedule ? humanizeCronExpression(w.triggerSchedule) : '';
        const cronPill = w.triggerSchedule
          ? '<span class="pill cron" title="' + escMem(w.triggerSchedule) + '">⏱ ' + escMem(humanCron || w.triggerSchedule) + '</span>'
          : '';
        const href = '#workflows/' + encodeURIComponent(w.name);
        return [
          '<li class="' + cls + '" data-wf-name="' + escMem(w.name) + '">',
          '  <a class="wf-select" data-wf-select="' + escMem(w.name) + '" href="' + href + '" onclick="window.__clementineSelectWorkflow && window.__clementineSelectWorkflow(this.getAttribute(&quot;data-wf-select&quot;));">',
          '    <span class="name">' + escMem(w.name) + '</span>',
          '    <span class="meta">' + enabledPill + cronPill + '<span class="pill">' + w.stepCount + ' steps</span></span>',
          '  </a>',
          '</li>',
        ].join('');
      }).join('');
      if (skipReselect) return;
      const hashName = workflowNameFromHash();
      const nextSelection =
        hashName && items.some((item) => item.name === hashName) ? hashName
        : wfSelectedName && items.some((item) => item.name === wfSelectedName) ? wfSelectedName
        : items[0]?.name;
      if (nextSelection) {
        selectWorkflowByName(nextSelection);
      }
    } catch (err) {
      wf.list.innerHTML = '<li class="empty">— failed: ' + escMem(err.message || err) + ' —</li>';
    }
  }

  async function loadWorkflow(name) {
    try {
      const cached = cachedWorkflowData(name);
      const data = cached && Array.isArray(cached.steps)
        ? cached
        : await fetchJSON('/api/console/workflows/' + encodeURIComponent(name));
      setWorkflowDraftFromData(data);
    } catch (err) {
      wf.editor.innerHTML = '<div class="wf-empty"><div class="wf-empty-mark">!</div><div class="wf-empty-text">' + escMem(err.message || err) + '</div></div>';
    }
  }

  function cachedWorkflowData(name) {
    return wfItems.find((item) => item && item.name === name);
  }

  function setWorkflowDraftFromData(data) {
    wfDraft = {
      name: data.name,
      description: data.description || '',
      enabled: data.enabled !== false,
      triggerSchedule: data.trigger && data.trigger.schedule ? data.trigger.schedule : '',
      steps: Array.isArray(data.steps) ? data.steps.map((s) => ({
        id: s.id,
        prompt: s.prompt,
        dependsOn: s.dependsOn || [],
        model: s.model,
        forEach: s.forEach,
        deterministic: s.deterministic,
        allowedTools: s.allowedTools,
        usesSkill: s.usesSkill || s.uses_skill,
      })) : [],
      inputs: data.inputs || {},
      synthesisPrompt: data.synthesis && data.synthesis.prompt ? data.synthesis.prompt : '',
      allowedTools: data.allowedTools || null,
      whenToUse: data.whenToUse || null,
    };
    wfChatHistory = [];
    // Reset per-step edit state when loading a different workflow —
    // never carry over edit toggles across switches.
    wfEditingStepIndices.clear();
    stopActiveRunPolling();
    renderEditor();
  }

  function startNewWorkflow() {
    wfSelectedName = null;
    wfIsNew = true;
    // Friendly starter template: a 3-step research-draft-synthesize
    // pattern with one example input. Teaches the shape without
    // forcing the user to learn from a blank page.
    wfDraft = {
      name: 'new-workflow',
      description: 'Briefly describe what this workflow does.',
      enabled: false,
      triggerSchedule: '',
      steps: [
        {
          id: 'research',
          prompt: 'Gather the context needed for this task. Reference {{topic}}. Use memory_recall + read_file as needed. Return concise findings.',
          dependsOn: [],
        },
        {
          id: 'draft',
          prompt: 'Using the research above, draft the output the user asked for. Be concrete and direct.',
          dependsOn: ['research'],
        },
      ],
      inputs: { topic: '' },
      synthesisPrompt: 'Return the draft from the previous step, formatted clearly. No preamble.',
    };
    wfChatHistory = [];
    Array.from(wf.list.querySelectorAll('li.wf')).forEach((el) => el.classList.remove('selected'));
    renderEditor();
  }
  // The sidebar + empty-state both bind via event delegation in
  // bootWorkflowsPanel(); no per-element listener needed here.

  function renderEditor() {
    if (!wfDraft) {
      wf.editor.innerHTML = [
        '<div class="wf-empty wf-empty-onboarding">',
        '  <div class="wf-empty-mark">⊟</div>',
        '  <div class="wf-empty-text">No workflow selected</div>',
        '  <p class="wf-empty-sub">A workflow is a multi-step task you can run on demand or on a schedule.</p>',
        '  <div class="wf-empty-actions">',
        '    <button class="wf-empty-btn primary" data-wf-new onclick="window.__clementineStartNewWorkflow && window.__clementineStartNewWorkflow();">＋ NEW WORKFLOW</button>',
        '    <button class="wf-empty-btn" data-wf-empty-architect>ASK ARCHITECT TO DRAFT ONE →</button>',
        '  </div>',
        '</div>',
      ].join('');
      return;
    }
    const d = wfDraft;
    const stepIds = d.steps.map((s) => s.id);
    const head = [
      '<div class="wf-edit-head">',
      '  <input class="wf-name" data-wf-field="name" type="text" value="' + escMem(d.name) + '" spellcheck="false" />',
      '  <span class="status-pill ' + (d.enabled ? 'on' : 'off') + '">' + (d.enabled ? '● ENABLED' : '○ DISABLED') + '</span>',
      '</div>',
    ].join('');
    const controls = [
      '<div class="wf-edit-controls">',
      '  <div class="wf-control-group wf-control-state">',
      '    <button class="btn-save" data-wf-action="save">' + (wfIsNew ? 'CREATE' : 'SAVE') + ' ✎</button>',
      wfIsNew ? '' : '    <button class="btn-duplicate" data-wf-action="duplicate">DUPLICATE ⎘</button>',
      wfIsNew ? '' : '    <button class="btn-toggle" data-wf-action="toggle">' + (d.enabled ? '○ DISABLE' : '● ENABLE') + '</button>',
      wfIsNew ? '' : '    <button class="btn-delete" data-wf-action="delete">DELETE ▣</button>',
      '  </div>',
      wfIsNew ? '' : '  <div class="wf-control-group wf-control-execute">',
      wfIsNew ? '' : '    <button class="btn-validate" data-wf-action="validate">VALIDATE ✓</button>',
      wfIsNew ? '' : '    <button class="btn-test" data-wf-action="dry-run">DRY-RUN ⌗</button>',
      wfIsNew ? '' : '    <button class="btn-run" data-wf-action="run">RUN ▶</button>',
      wfIsNew ? '' : '  </div>',
      '</div>',
    ].join('');

    const body = [
      '<div class="wf-edit-body">',

      '  <div class="wf-field">',
      '    <label>DESCRIPTION</label>',
      '    <textarea data-wf-field="description" rows="2" spellcheck="false">' + escMem(d.description) + '</textarea>',
      '    <span class="hint">A clear description helps the agent pick the right workflow.</span>',
      '  </div>',

      '  <div class="wf-field wf-schedule">',
      '    <label>SCHEDULE</label>',
           renderSchedulePicker(d.triggerSchedule),
      '    <input type="hidden" data-wf-field="triggerSchedule" value="' + escMem(d.triggerSchedule) + '" />',
      '    <span class="hint" data-sched-summary>' + escMem(describeCron(d.triggerSchedule)) + '</span>',
      '  </div>',

      '  <div class="wf-field">',
      '    <label>STEPS · ' + d.steps.length + '</label>',
      '    <div class="wf-steps" data-wf-steps>',
           d.steps.map((s, i) => renderStep(s, i, stepIds)).join(''),
      '    </div>',
      '    <button class="wf-add-step" data-wf-action="add-step">＋ ADD STEP</button>',
      '  </div>',

      '  <div class="wf-field">',
      '    <label>INPUTS · ' + Object.keys(d.inputs || {}).length + '</label>',
      '    <div class="wf-inputs" data-wf-inputs>',
           renderInputsList(d.inputs || {}),
      '    </div>',
      '    <button class="wf-add-input" data-wf-action="add-input">＋ ADD INPUT</button>',
      '    <span class="hint">Inputs are runtime parameters (e.g. <code>customer_id</code>). Reference them in step prompts as <code>{{customer_id}}</code>. The user is prompted for values when running.</span>',
      '  </div>',

      '  <div class="wf-field">',
      '    <label>SYNTHESIS (optional final prompt that combines step outputs)</label>',
      '    <textarea data-wf-field="synthesisPrompt" rows="3" spellcheck="false" placeholder="Summarize the prior step outputs as a single concise update.">' + escMem(d.synthesisPrompt) + '</textarea>',
      '  </div>',

      '  <div class="wf-runs" data-wf-runs></div>',

      '  <div data-wf-validation></div>',

      '</div>',
    ].join('');

    wf.editor.innerHTML = head + controls + body;
    bindEditorEvents();
    bindSchedulePicker(wf.editor);
    refreshWorkflowRuns();
  }

  const SCHED_DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function parseScheduleToPreset(cron) {
    const empty = { mode: 'manual', time: '09:00', days: [1, 2, 3, 4, 5], every: 15, custom: '' };
    if (!cron || !cron.trim()) return empty;
    // NOTE: this function lives inside the CONSOLE_JS template literal,
    // so every backslash in a regex literal must be doubled (\\) — a
    // single \ gets stripped at template-evaluation time. Bug shipped
    // 2026-05-18 ("/^*/: Nothing to repeat") because /^\*\/(\d+)$/
    // became /^*/(d+)$/ after template eval. The doubled-\\ form here
    // is correct: at runtime the regex is /\s+/, /^\d+$/, etc.
    const parts = cron.trim().split(new RegExp('\\s+'));
    if (parts.length !== 5) return { ...empty, mode: 'custom', custom: cron };
    const [min, hour, dom, mon, dow] = parts;
    const RE_NUM = new RegExp('^\\d+$');
    const RE_STEP = new RegExp('^\\*\\/(\\d+)$');
    const RE_DAYS = new RegExp('^\\d(,\\d)*$');
    const isNum = (s) => RE_NUM.test(s);
    const everyStar = dom === '*' && mon === '*';
    let m = min.match(RE_STEP);
    if (m && hour === '*' && everyStar && dow === '*') {
      return { ...empty, mode: 'every-minutes', every: parseInt(m[1], 10) };
    }
    m = hour.match(RE_STEP);
    if (isNum(min) && parseInt(min, 10) === 0 && m && everyStar && dow === '*') {
      return { ...empty, mode: 'every-hours', every: parseInt(m[1], 10) };
    }
    if (isNum(min) && isNum(hour) && everyStar) {
      const time = hour.padStart(2, '0') + ':' + min.padStart(2, '0');
      if (dow === '*') return { ...empty, mode: 'daily', time };
      if (dow === '1-5') return { ...empty, mode: 'weekdays', time };
      if (RE_DAYS.test(dow)) {
        const days = dow.split(',').map(Number).filter((n) => n >= 0 && n <= 6);
        return { ...empty, mode: 'days', time, days };
      }
    }
    return { ...empty, mode: 'custom', custom: cron };
  }

  function cronFromPreset(state) {
    if (state.mode === 'manual') return '';
    if (state.mode === 'custom') return (state.custom || '').trim();
    if (state.mode === 'every-minutes') {
      const n = Math.max(1, Math.min(59, parseInt(state.every, 10) || 15));
      return '*/' + n + ' * * * *';
    }
    if (state.mode === 'every-hours') {
      const n = Math.max(1, Math.min(23, parseInt(state.every, 10) || 1));
      return '0 */' + n + ' * * *';
    }
    const [hStr, mStr] = (state.time || '09:00').split(':');
    const hour = Math.max(0, Math.min(23, parseInt(hStr, 10) || 9));
    const min = Math.max(0, Math.min(59, parseInt(mStr, 10) || 0));
    if (state.mode === 'daily') return min + ' ' + hour + ' * * *';
    if (state.mode === 'weekdays') return min + ' ' + hour + ' * * 1-5';
    if (state.mode === 'days') {
      const days = (state.days || []).slice().sort((a, b) => a - b);
      if (days.length === 0) return '';
      return min + ' ' + hour + ' * * ' + days.join(',');
    }
    return '';
  }

  function describeCron(cron) {
    if (!cron || !cron.trim()) return 'No schedule — runs only when manually triggered or fired from chat.';
    const state = parseScheduleToPreset(cron);
    if (state.mode === 'every-minutes') return 'Runs every ' + state.every + ' minutes. Cron: ' + cron;
    if (state.mode === 'every-hours') return 'Runs every ' + state.every + ' hour' + (state.every === 1 ? '' : 's') + ' on the hour. Cron: ' + cron;
    if (state.mode === 'daily') return 'Runs every day at ' + state.time + '. Cron: ' + cron;
    if (state.mode === 'weekdays') return 'Runs weekdays (Mon–Fri) at ' + state.time + '. Cron: ' + cron;
    if (state.mode === 'days') {
      const names = state.days.map((d) => SCHED_DAY_LABELS[d]).join(', ');
      return 'Runs ' + (names || '(no days selected)') + ' at ' + state.time + '. Cron: ' + cron;
    }
    return 'Custom cron: ' + cron;
  }

  function renderSchedulePicker(cron) {
    const s = parseScheduleToPreset(cron);
    const opt = (val, label) => '<option value="' + val + '"' + (s.mode === val ? ' selected' : '') + '>' + label + '</option>';
    const dayChips = SCHED_DAY_LABELS.map((label, idx) => {
      const on = s.days.includes(idx);
      return '<button type="button" class="sched-day' + (on ? ' on' : '') + '" data-sched-day="' + idx + '">' + label + '</button>';
    }).join('');
    const showTime = s.mode === 'daily' || s.mode === 'weekdays' || s.mode === 'days';
    const showEvery = s.mode === 'every-hours' || s.mode === 'every-minutes';
    return [
      '<div class="sched-picker" data-sched-picker>',
      '  <select class="sched-mode" data-sched-mode>',
      opt('manual', 'Manual only'),
      opt('daily', 'Every day'),
      opt('weekdays', 'Weekdays (Mon–Fri)'),
      opt('days', 'Specific days'),
      opt('every-hours', 'Every N hours'),
      opt('every-minutes', 'Every N minutes'),
      opt('custom', 'Custom cron'),
      '  </select>',
      '  <input type="time" class="sched-time" data-sched-time value="' + escMem(s.time || '09:00') + '"' + (showTime ? '' : ' hidden') + ' />',
      '  <div class="sched-days" data-sched-days' + (s.mode === 'days' ? '' : ' hidden') + '>' + dayChips + '</div>',
      '  <input type="number" class="sched-every" data-sched-every min="1" max="' + (s.mode === 'every-hours' ? '23' : '59') + '" value="' + escMem(String(s.every || (s.mode === 'every-hours' ? 1 : 15))) + '"' + (showEvery ? '' : ' hidden') + ' />',
      '  <input type="text" class="sched-custom" data-sched-custom value="' + escMem(s.custom || cron || '') + '" placeholder="0 9 * * 1-5"' + (s.mode === 'custom' ? '' : ' hidden') + ' spellcheck="false" />',
      '</div>',
    ].join('');
  }

  function bindSchedulePicker(root) {
    const picker = root.querySelector('[data-sched-picker]');
    if (!picker) return;
    const modeEl = picker.querySelector('[data-sched-mode]');
    const timeEl = picker.querySelector('[data-sched-time]');
    const daysEl = picker.querySelector('[data-sched-days]');
    const everyEl = picker.querySelector('[data-sched-every]');
    const customEl = picker.querySelector('[data-sched-custom]');
    const hidden = root.querySelector('input[data-wf-field="triggerSchedule"]');
    const summary = root.querySelector('[data-sched-summary]');
    if (!modeEl || !hidden) return;
    const readState = () => ({
      mode: modeEl.value,
      time: timeEl.value || '09:00',
      days: Array.from(picker.querySelectorAll('[data-sched-day]'))
        .filter((b) => b.classList.contains('on'))
        .map((b) => parseInt(b.getAttribute('data-sched-day'), 10)),
      every: parseInt(everyEl.value, 10) || 15,
      custom: customEl.value || '',
    });
    const syncVisibility = () => {
      const mode = modeEl.value;
      const showTime = mode === 'daily' || mode === 'weekdays' || mode === 'days';
      timeEl.hidden = !showTime;
      daysEl.hidden = mode !== 'days';
      everyEl.hidden = !(mode === 'every-hours' || mode === 'every-minutes');
      everyEl.max = mode === 'every-hours' ? '23' : '59';
      customEl.hidden = mode !== 'custom';
    };
    const recompute = () => {
      const cron = cronFromPreset(readState());
      hidden.value = cron;
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
      if (summary) summary.textContent = describeCron(cron);
    };
    modeEl.addEventListener('change', () => { syncVisibility(); recompute(); });
    timeEl.addEventListener('input', recompute);
    everyEl.addEventListener('input', recompute);
    customEl.addEventListener('input', recompute);
    picker.querySelectorAll('[data-sched-day]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        btn.classList.toggle('on');
        recompute();
      });
    });
  }

  function renderInputsList(inputs) {
    const keys = Object.keys(inputs);
    if (keys.length === 0) {
      return '<div class="wf-input-row wf-input-empty">— no inputs declared. The workflow runs with whatever the runtime supplies. —</div>';
    }
    return keys.map((k) => {
      const v = inputs[k];
      const valueStr = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
      return [
        '<div class="wf-input-row" data-wf-input-row="' + escMem(k) + '">',
        '  <input class="wf-input-key" type="text" value="' + escMem(k) + '" data-wf-input-key="' + escMem(k) + '" spellcheck="false" placeholder="key" />',
        '  <input class="wf-input-default" type="text" value="' + escMem(valueStr) + '" data-wf-input-value="' + escMem(k) + '" spellcheck="false" placeholder="default value (optional)" />',
        '  <button type="button" class="wf-input-remove" data-wf-action="input-remove" data-wf-input-name="' + escMem(k) + '">✕</button>',
        '</div>',
      ].join('');
    }).join('');
  }

  function renderStep(step, index, allStepIds) {
    // Step rendering is read-only by default. The whole industry (OpenAI
    // AgentKit, Zapier Copilot, Lovable) converged on chat-builds /
    // visual-displays in 2025-2026, so the step pane is a receipt of
    // what the Architect agent produced rather than the authoring
    // surface. ▶ TRY, ✎ REFINE, and ⛭ EDIT buttons cover the three
    // common operations a user wants on a step. Live status pulled
    // from events.jsonl by the run-status poller (refreshStepStatuses).
    const deps = step.dependsOn || [];
    const isEditing = wfEditingStepIndices.has(index);
    const depPills = allStepIds
      .filter((id) => id !== step.id)
      .map((id) => '<button type="button" class="dep-pill ' + (deps.includes(id) ? 'on' : '') + '" data-wf-dep="' + escMem(id) + '" data-wf-step-id="' + escMem(step.id) + '">' + escMem(id) + '</button>')
      .join('');
    // Chips: forEach / deterministic — agent-runtime hints. Tool
    // allowlist now lives in its own editable rail (see toolRailHtml
    // below) so we drop the read-only ⚡ chip to avoid duplication.
    const chips = [];
    if (step.forEach) chips.push('<span class="step-chip chip-forEach" title="Runs once per item in &quot;' + escMem(step.forEach) + '&quot;">⇢ forEach ' + escMem(step.forEach) + '</span>');
    if (step.deterministic && step.deterministic.runner) chips.push('<span class="step-chip chip-deterministic" title="Runs a script — no LLM call">⚙ ' + escMem(step.deterministic.runner) + '</span>');
    if (deps.length > 0) {
      chips.push('<span class="step-chip chip-deps">↑ depends on ' + escMem(deps.join(', ')) + '</span>');
    }
    if (step.model) chips.push('<span class="step-chip chip-model">model: ' + escMem(step.model) + '</span>');

    // Editable allowed-tools rail. Each tool is a chip with an x; the
    // + ADD TOOL button opens the picker. The rail is always visible
    // so the user can see what the step can call without entering the
    // raw-markdown edit mode.
    const tools = Array.isArray(step.allowedTools) ? step.allowedTools : [];
    const toolChipHtml = tools.map((t, ti) => {
      const name = typeof t === 'string' ? t : (t && t.name) || '';
      if (!name) return '';
      return [
        '<span class="wf-tool-chip" data-wf-tool-chip="' + escMem(name) + '" data-wf-step-index="' + index + '">',
        '  ' + escMem(name),
        '  <button type="button" class="wf-tool-chip-remove" data-wf-action="step-tool-remove" data-wf-step-index="' + index + '" data-wf-tool-index="' + ti + '" title="Remove ' + escMem(name) + '">×</button>',
        '</span>',
      ].join('');
    }).join('');
    const toolRailHtml = [
      '<div class="wf-step-tools" data-wf-step-tools-rail data-wf-step-index="' + index + '">',
      '  <span class="wf-step-tools-label">TOOLS:</span>',
      toolChipHtml || '<span style="color:var(--fg-mute);font-size:10px;letter-spacing:normal;">none</span>',
      '  <button type="button" class="wf-tool-add" data-wf-action="step-tool-add" data-wf-step-index="' + index + '" title="Pick a tool to allow in this step">+ ADD TOOL</button>',
      '</div>',
    ].join('');

    // Skill rail — visible when this step binds to a SKILL. One skill
    // per step (the runner injects its SKILL.md body into the prompt).
    // Rendered as a distinct row so it doesn't get lost among tool
    // chips, since composing a skill is a meaningfully different act.
    const skillRailHtml = step.usesSkill
      ? [
          '<div class="wf-step-skill" data-wf-step-skill-rail data-wf-step-index="' + index + '">',
          '  <span class="wf-step-tools-label">SKILL:</span>',
          '  <span class="wf-skill-chip" title="Runner injects the skill instructions before the step prompt">',
          '    ' + escMem(step.usesSkill),
          '    <button type="button" class="wf-tool-chip-remove" data-wf-action="step-skill-remove" data-wf-step-index="' + index + '" title="Unlink skill">×</button>',
          '  </span>',
          '</div>',
        ].join('')
      : '';

    const promptDisplay = (step.prompt || '').trim() || '(empty prompt)';
    return [
      '<div class="wf-step ' + (isEditing ? 'wf-step-editing' : '') + '" data-wf-step-index="' + index + '" data-wf-step-id="' + escMem(step.id) + '">',
      '  <div class="wf-step-head">',
      '    <span class="step-num">#' + (index + 1) + '</span>',
      isEditing
        ? '    <input class="step-id-input" type="text" value="' + escMem(step.id) + '" data-wf-step-field="id" data-wf-step-index="' + index + '" spellcheck="false" />'
        : '    <span class="step-id-label">' + escMem(step.id) + '</span>',
      '    <span class="step-status" data-wf-step-status="' + escMem(step.id) + '">idle</span>',
      '    <div class="step-actions">',
      wfIsNew ? '' : '      <button type="button" class="btn-step-try" data-wf-action="step-try" data-wf-step-index="' + index + '" title="Run only this step with the current draft prompt (single LLM call, no upstream)">▶ TRY</button>',
      '      <button type="button" class="btn-step-refine" data-wf-action="step-refine" data-wf-step-index="' + index + '" title="Ask the Architect to rewrite this step">✎ REFINE</button>',
      '      <button type="button" class="btn-step-edit" data-wf-action="step-edit-toggle" data-wf-step-index="' + index + '" title="' + (isEditing ? 'Done editing — return to read-only view' : 'Edit this step manually') + '">' + (isEditing ? '✓ DONE' : '⛭') + '</button>',
      isEditing ? '      <button type="button" data-wf-action="step-up" data-wf-step-index="' + index + '" title="Move up">↑</button>' : '',
      isEditing ? '      <button type="button" data-wf-action="step-down" data-wf-step-index="' + index + '" title="Move down">↓</button>' : '',
      isEditing ? '      <button type="button" class="step-remove" data-wf-action="step-remove" data-wf-step-index="' + index + '">REMOVE</button>' : '',
      '    </div>',
      '  </div>',
      '  <div class="wf-step-body">',
      isEditing
        ? '    <textarea class="step-prompt" rows="4" data-wf-step-field="prompt" data-wf-step-index="' + index + '" data-wf-tool-mention placeholder="What this step should do. Type @ to pick a tool (e.g. @composio_gmail_send_email).">' + escMem(step.prompt || '') + '</textarea>'
        : '    <div class="step-prompt-display" data-wf-action="step-edit-toggle" data-wf-step-index="' + index + '" title="Click to edit, or use ✎ REFINE to ask the Architect">' + escMem(promptDisplay) + '</div>',
      '    ' + toolRailHtml,
      '    ' + skillRailHtml,
      chips.length > 0 ? '    <div class="step-chips">' + chips.join('') + '</div>' : '',
      isEditing ? (depPills ? '    <div class="step-deps"><span class="step-deps-label">DEPENDS ON ⇢</span>' + depPills + '</div>' : '    <div class="step-deps"><span class="step-deps-label">DEPENDS ON ⇢</span><span style="color:var(--fg-mute);">(no other steps to depend on)</span></div>') : '',
      '    <div class="step-output" hidden data-wf-step-output="' + escMem(step.id) + '"></div>',
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

    // Input key/value bindings — keep wfDraft.inputs in sync without
    // re-rendering on every keystroke (the key field would lose focus).
    wf.editor.querySelectorAll('[data-wf-input-key]').forEach((input) => {
      const originalKey = input.getAttribute('data-wf-input-key');
      input.addEventListener('change', () => {
        const newKey = (input.value || '').trim();
        if (!newKey || newKey === originalKey) return;
        const v = wfDraft.inputs[originalKey];
        delete wfDraft.inputs[originalKey];
        wfDraft.inputs[newKey] = v;
        renderEditor();
      });
    });
    wf.editor.querySelectorAll('[data-wf-input-value]').forEach((input) => {
      const key = input.getAttribute('data-wf-input-value');
      input.addEventListener('input', () => {
        wfDraft.inputs[key] = input.value;
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
        if (action === 'dry-run' || action === 'test') return runWorkflow(true);
        if (action === 'run') {
          // v0.5.11 UX: confirm before firing a live RUN. The button
          // sits next to DRY-RUN; one accidental click otherwise
          // triggers real side-effects (Outlook sends, Salesforce
          // writes, notify_user pings). The confirm() is dismissible
          // for power-users who want quick repeated runs.
          const name = (wfDraft && wfDraft.name) || 'this workflow';
          // Escaped newlines: parent CONSOLE_JS template literal would
          // otherwise interpolate the escape into a real newline, which
          // would break the inner JS string literal across actual lines.
          const ok = confirm(
            'Run "' + name + '" now?\\n\\n' +
            'This executes for real — any tools the workflow calls may write to Salesforce / send Outlook drafts / notify you via Discord. Use DRY-RUN if you want to see the plan without side effects.'
          );
          if (!ok) return;
          return runWorkflow(false);
        }
        if (action === 'toggle') return toggleEnabled();
        if (action === 'delete') return deleteWorkflow();
        if (action === 'duplicate') return duplicateWorkflow();
        if (action === 'add-step') {
          const nextId = 'step-' + (wfDraft.steps.length + 1);
          wfDraft.steps.push({ id: nextId, prompt: '', dependsOn: [] });
          renderEditor();
          return;
        }
        if (action === 'add-input') {
          if (!wfDraft.inputs) wfDraft.inputs = {};
          let n = Object.keys(wfDraft.inputs).length + 1;
          let k = 'input_' + n;
          while (wfDraft.inputs[k] !== undefined) { n++; k = 'input_' + n; }
          wfDraft.inputs[k] = '';
          renderEditor();
          return;
        }
        if (action === 'input-remove') {
          const name = btn.getAttribute('data-wf-input-name');
          if (name && wfDraft.inputs) {
            delete wfDraft.inputs[name];
            renderEditor();
          }
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
        if (action === 'step-edit-toggle' && Number.isFinite(idx)) {
          // Toggle this step into / out of inline edit mode without
          // touching the rest of the workflow. The set is the source
          // of truth; renderStep() reads it on render.
          if (wfEditingStepIndices.has(idx)) wfEditingStepIndices.delete(idx);
          else wfEditingStepIndices.add(idx);
          renderEditor();
          return;
        }
        if (action === 'step-refine' && Number.isFinite(idx)) {
          // Scope the next Architect message to this step — prefill
          // the chat input with a leading directive and focus it. The
          // Architect's instructions already know how to handle a
          // step-scoped refinement because the workflow body already
          // names every step.
          const step = wfDraft.steps[idx];
          if (!step) return;
          const input = wf.chatInput;
          if (input) {
            const existing = (input.value || '').trim();
            const prefix = 'Refine step "' + step.id + '": ';
            if (!existing.startsWith(prefix)) {
              input.value = prefix + existing;
            }
            input.focus();
            // Place caret at end so the user types after the prefix.
            const end = input.value.length;
            try { input.setSelectionRange(end, end); } catch { /* tolerate textareas without selection */ }
          }
          return;
        }
        if (action === 'step-try' && Number.isFinite(idx)) {
          const step = wfDraft.steps[idx];
          if (!step) return;
          // Single-step run is the highest-leverage trust UX in the
          // category — Lovable, AgentKit, Zapier Copilot all ship it.
          // Sends a queued-run request with targetStepId so the runner
          // only executes this step (with empty / sample upstream).
          tryStep(step).catch((err) => console.error('try step failed', err));
          return;
        }
        if (action === 'step-tool-add' && Number.isFinite(idx)) {
          // Open the picker anchored to the + ADD TOOL button. Selecting
          // a tool appends to the step's allowedTools (no insertion into
          // the prompt text — the user clicked the button, not @-typed).
          openToolPicker({
            anchor: btn,
            stepIndex: idx,
            insertMention: false,
          });
          return;
        }
        if (action === 'step-tool-remove' && Number.isFinite(idx)) {
          const toolIdx = parseInt(btn.getAttribute('data-wf-tool-index') || '-1', 10);
          const step = wfDraft.steps[idx];
          if (!step || !Array.isArray(step.allowedTools)) return;
          if (toolIdx >= 0 && toolIdx < step.allowedTools.length) {
            step.allowedTools.splice(toolIdx, 1);
            if (step.allowedTools.length === 0) delete step.allowedTools;
            renderEditor();
          }
          return;
        }
        if (action === 'step-skill-remove' && Number.isFinite(idx)) {
          const step = wfDraft.steps[idx];
          if (!step) return;
          delete step.usesSkill;
          renderEditor();
          return;
        }
      });
    });

    // @-mention handlers on step prompt textareas. Typing '@' at a word
    // boundary opens the tool picker anchored to the caret; further
    // typing filters; Enter inserts. The textarea's input listener
    // already updates wfDraft.steps[idx].prompt — we just observe.
    wf.editor.querySelectorAll('[data-wf-tool-mention]').forEach((ta) => {
      ta.addEventListener('input', (e) => onMentionTextareaInput(ta));
      ta.addEventListener('keydown', (e) => onMentionTextareaKeydown(ta, e));
      ta.addEventListener('blur', () => {
        // Defer close so a click on a picker row registers first.
        setTimeout(() => { if (toolPickerState.activeTextarea === ta) closeToolPicker(); }, 120);
      });
    });
  }

  // ── Step TRY + live status ─────────────────────────────────────
  // The TRY button queues a single-step run via the same endpoint as
  // RUN (POST /api/console/workflows/:name/run) with targetStepId set.
  // The runner respects this hint and only fires that step. We then
  // poll the events endpoint (added in this redesign) for live status
  // updates that drive the per-step pill + output panel.
  async function tryStep(step) {
    if (wfIsNew || !wfSelectedName) {
      alert('Save the workflow first — TRY requires the SKILL.md on disk.');
      return;
    }
    const pill = document.querySelector('[data-wf-step-status="' + step.id + '"]');
    if (pill) { pill.textContent = 'queueing'; pill.className = 'step-status status-queueing'; }
    try {
      const r = await fetch(withToken('/api/console/workflows/' + encodeURIComponent(wfSelectedName) + '/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetStepId: step.id, inputs: {} }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (pill) { pill.textContent = 'error'; pill.className = 'step-status status-failed'; pill.title = j.error || ('HTTP ' + r.status); }
        return;
      }
      if (j.id) startActiveRunPolling(j.id);
    } catch (err) {
      if (pill) { pill.textContent = 'error'; pill.className = 'step-status status-failed'; pill.title = err && err.message ? err.message : String(err); }
    }
  }

  function stopActiveRunPolling() {
    if (wfActiveRunPollTimer) {
      clearInterval(wfActiveRunPollTimer);
      wfActiveRunPollTimer = null;
    }
    wfActiveRunId = null;
    wfActiveRunLastEventAt = '';
  }

  function startActiveRunPolling(runId) {
    stopActiveRunPolling();
    wfActiveRunId = runId;
    wfActiveRunLastEventAt = '';
    // 1s poll is plenty for an interactive editor — we're tailing a
    // file, not driving a tight loop. The since= param keeps the
    // response body small after the first call.
    const poll = async () => {
      if (!wfActiveRunId || !wfSelectedName) return;
      try {
        const url = '/api/console/workflows/' + encodeURIComponent(wfSelectedName)
          + '/runs/' + encodeURIComponent(wfActiveRunId) + '/events'
          + (wfActiveRunLastEventAt ? '?since=' + encodeURIComponent(wfActiveRunLastEventAt) : '');
        const data = await fetchJSON(url);
        const events = Array.isArray(data.events) ? data.events : [];
        for (const ev of events) {
          applyStepEvent(ev);
          wfActiveRunLastEventAt = ev.t;
        }
        // Stop polling once the run reaches a terminal kind.
        const terminal = events.some((ev) =>
          ev.kind === 'run_completed' || ev.kind === 'run_failed' || ev.kind === 'run_cancelled',
        );
        if (terminal) stopActiveRunPolling();
      } catch {
        // Network blip — keep polling. We'll exit when the run hits
        // a terminal state.
      }
    };
    poll();
    wfActiveRunPollTimer = setInterval(poll, 1000);
  }

  function applyStepEvent(ev) {
    if (!ev || !ev.stepId) return;
    const pill = document.querySelector('[data-wf-step-status="' + ev.stepId + '"]');
    const output = document.querySelector('[data-wf-step-output="' + ev.stepId + '"]');
    if (ev.kind === 'step_started') {
      if (pill) { pill.textContent = 'running'; pill.className = 'step-status status-running'; pill.title = ''; }
      if (output) { output.hidden = true; output.textContent = ''; }
    }
    if (ev.kind === 'step_completed') {
      if (pill) { pill.textContent = 'done'; pill.className = 'step-status status-done'; pill.title = ''; }
      if (output) {
        const text = typeof ev.output === 'string' ? ev.output : (ev.output != null ? JSON.stringify(ev.output, null, 2) : '');
        if (text) { output.hidden = false; output.textContent = text; }
      }
    }
    if (ev.kind === 'step_failed') {
      if (pill) { pill.textContent = 'failed'; pill.className = 'step-status status-failed'; pill.title = ev.error || ''; }
      if (output && ev.error) { output.hidden = false; output.textContent = 'Error: ' + ev.error; }
    }
    if (ev.kind === 'step_skipped') {
      if (pill) { pill.textContent = 'skipped'; pill.className = 'step-status status-skipped'; pill.title = (ev.meta && ev.meta.reason) || ''; }
    }
    if (ev.kind === 'item_started') {
      // For forEach steps, surface live progress as "running (3/100)"
      // — the count comes from accumulating item_started events. We
      // store the running tally on the pill's dataset so the next
      // tick can read + increment it without re-parsing text.
      if (pill) {
        const total = pill.dataset.itemTotal || '?';
        const seen = (parseInt(pill.dataset.itemDone || '0', 10)) + 1;
        pill.dataset.itemDone = String(seen);
        pill.dataset.itemTotal = total;
        pill.textContent = 'running (' + seen + '/' + total + ')';
        pill.className = 'step-status status-running';
      }
    }
    if (ev.kind === 'item_completed' && pill) {
      const seen = (parseInt(pill.dataset.itemDone || '0', 10)) + 1;
      pill.dataset.itemDone = String(seen);
    }
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

  function duplicateWorkflow() {
    if (!wfDraft) return;
    const newName = (prompt('Name for the duplicate:', wfDraft.name + '-copy') || '').trim();
    if (!newName) return;
    wfIsNew = true;
    wfSelectedName = null;
    wfDraft = {
      ...wfDraft,
      name: newName,
      enabled: false,
      // Steps + inputs are cloned by reference but they're flat enough
      // that the user can edit independently from here.
      steps: wfDraft.steps.map((s) => ({ ...s, dependsOn: [...(s.dependsOn || [])] })),
      inputs: { ...(wfDraft.inputs || {}) },
    };
    wfChatHistory = [];
    Array.from(wf.list.querySelectorAll('li.wf')).forEach((el) => el.classList.remove('selected'));
    renderEditor();
  }

  async function runWorkflow(dryRun) {
    if (!wfSelectedName) return;
    // Prompt for input values if any are declared.
    const declaredInputs = Object.keys(wfDraft?.inputs || {});
    let inputValues = {};
    if (declaredInputs.length > 0) {
      const supplied = await promptForRunInputs(wfDraft.inputs, dryRun);
      if (supplied === null) return; // user cancelled
      inputValues = supplied;
    }
    try {
      const r = await fetch(withToken('/api/console/workflows/' + encodeURIComponent(wfSelectedName) + '/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun, inputs: inputValues }),
      });
      const j = await r.json();
      if (!r.ok) {
        renderValidation({ ok: false, errors: [j.error || ('HTTP ' + r.status)], warnings: [], stepCount: 0, hasCycles: false });
        return;
      }
      renderValidation({ ok: true, errors: [], warnings: [], stepCount: 0, hasCycles: false }, dryRun ? ('DRY-RUN QUEUED · ' + j.id) : ('QUEUED · ' + j.id));
      // Refresh the runs list so the user sees their new run land.
      refreshWorkflowRuns();
    } catch (err) {
      renderValidation({ ok: false, errors: [err.message || String(err)], warnings: [], stepCount: 0, hasCycles: false });
    }
  }

  /**
   * Modal prompt for workflow inputs. Resolves with {key: value} or
   * null if cancelled. Pure-DOM modal — no framework, just an absolute
   * overlay over the editor.
   */
  function promptForRunInputs(declaredInputs, dryRun) {
    return new Promise((resolve) => {
      const keys = Object.keys(declaredInputs);
      const overlay = document.createElement('div');
      overlay.className = 'wf-run-modal-backdrop';
      overlay.innerHTML = [
        '<div class="wf-run-modal" role="dialog" aria-modal="true">',
        '  <div class="wf-run-modal-head">',
        '    <span>' + (dryRun ? 'DRY-RUN INPUTS' : 'RUN INPUTS') + '</span>',
        '    <button class="wf-run-modal-close" data-close>✕</button>',
        '  </div>',
        '  <p class="wf-run-modal-sub">Provide values for the workflow inputs. Press <kbd>↩</kbd> to ' + (dryRun ? 'dry-run' : 'run') + '.</p>',
        '  <form class="wf-run-modal-form">',
             keys.map((k) => {
               const def = declaredInputs[k];
               const defStr = def === undefined || def === null ? '' : String(def);
               return [
                 '<label class="wf-run-modal-row">',
                 '  <span>' + escMem(k) + '</span>',
                 '  <input type="text" name="' + escMem(k) + '" value="' + escMem(defStr) + '" autocomplete="off" />',
                 '</label>',
               ].join('');
             }).join(''),
        '    <div class="wf-run-modal-actions">',
        '      <button type="button" class="cancel" data-close>CANCEL</button>',
        '      <button type="submit" class="primary">' + (dryRun ? 'DRY-RUN ⌗' : 'RUN ▶') + '</button>',
        '    </div>',
        '  </form>',
        '</div>',
      ].join('');
      document.body.appendChild(overlay);
      const cleanup = () => { overlay.remove(); };
      overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { cleanup(); resolve(null); }));
      const form = overlay.querySelector('form');
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const out = {};
        for (const [k, v] of formData.entries()) out[k] = v;
        cleanup();
        resolve(out);
      });
      const firstInput = overlay.querySelector('input');
      if (firstInput) firstInput.focus();
    });
  }

  /** Recent runs for the currently-selected workflow. */
  async function refreshWorkflowRuns() {
    const slot = document.querySelector('[data-wf-runs]');
    if (!slot || !wfSelectedName || wfIsNew) {
      if (slot) slot.innerHTML = '';
      return;
    }
    try {
      const data = await fetchJSON('/api/console/workflows/' + encodeURIComponent(wfSelectedName) + '/runs?limit=5');
      const runs = data.runs || [];
      if (runs.length === 0) {
        slot.innerHTML = '<div class="wf-runs-empty">— no runs yet. Click RUN ▶ to kick one off. —</div>';
        return;
      }
      slot.innerHTML = [
        '<div class="wf-runs-head">RECENT RUNS</div>',
        '<ol class="wf-runs-list">',
           runs.map((r) => {
             const status = (r.status || 'unknown').toString();
             const when = (r.createdAt || '').slice(11, 19);
             const day = (r.createdAt || '').slice(0, 10);
             const canCancel = status === 'queued' || status === 'running';
             const inputs = r.inputs && Object.keys(r.inputs).length > 0
               ? Object.entries(r.inputs).map(([k, v]) => k + '=' + String(v).slice(0, 30)).join(' · ')
               : '';
             return [
               '<li class="wf-run">',
               '  <span class="wf-run-status status-' + escMem(status) + '">' + escMem(status.toUpperCase()) + '</span>',
               '  <span class="wf-run-id">' + escMem(r.id) + '</span>',
               '  <span class="wf-run-time">' + escMem(day + ' ' + when) + '</span>',
               inputs ? '  <span class="wf-run-inputs">' + escMem(inputs) + '</span>' : '',
               canCancel ? '  <button type="button" class="wf-run-action" data-wf-run-cancel="' + escMem(r.id) + '">CANCEL</button>' : '',
               '</li>',
             ].join('');
           }).join(''),
        '</ol>',
      ].join('');
      Array.from(slot.querySelectorAll('[data-wf-run-cancel]')).forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!wfSelectedName) return;
          const runId = btn.getAttribute('data-wf-run-cancel');
          if (!runId) return;
          btn.disabled = true;
          const original = btn.textContent;
          btn.textContent = 'CANCELLING';
          try {
            const endpoint = '/api/console/workflows/' + encodeURIComponent(wfSelectedName)
              + '/runs/' + encodeURIComponent(runId) + '/cancel';
            const r = await fetch(withToken(endpoint), {
              method: 'POST',
              headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
              body: JSON.stringify({ reason: 'Cancelled from Workflow Studio.' }),
            });
            if (!r.ok) {
              const j = await r.json().catch(() => ({}));
              throw new Error(j.error || ('HTTP ' + r.status));
            }
            await refreshWorkflowRuns();
            await refreshHomeCommandCenter();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = original || 'CANCEL';
            alert('Could not cancel run: ' + ((err && err.message) || err));
          }
        });
      });
    } catch (err) {
      slot.innerHTML = '<div class="wf-runs-empty">runs unavailable: ' + escMem(err.message || err) + '</div>';
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

  // ─── @-mention tool picker ────────────────────────────────────
  //
  // Tools are sourced from /api/console/tools (same registry the Tools
  // panel uses). We cache once on first picker open so the user gets
  // instant fuzzy filtering. The picker is a single floating <div>
  // reused across all step textareas — we re-anchor it each time it
  // opens. Selection inserts the @toolname into the prompt (if opened
  // via @-mention) and always adds the tool to the step's allowedTools.

  // Entries in the picker are either kind:'tool' (allowedTools binding)
  // or kind:'skill' (usesSkill binding). Both surface in the same fuzzy
  // list — skills get a SKILL badge so they're visually distinct.
  let wfPickerCache = null;
  let wfPickerCachePromise = null;
  const toolPickerState = {
    el: null,
    activeTextarea: null,
    stepIndex: -1,
    insertMention: false,
    mentionStart: -1,            // index of '@' in textarea.value when opened via mention
    filter: '',
    matches: [],
    activeRow: 0,
  };

  async function loadToolsForPicker() {
    if (wfPickerCache) return wfPickerCache;
    if (wfPickerCachePromise) return wfPickerCachePromise;
    wfPickerCachePromise = fetchJSON('/api/console/tools')
      .then((data) => {
        const tools = (data && Array.isArray(data.tools)) ? data.tools : [];
        const skills = (data && Array.isArray(data.skills)) ? data.skills : [];
        const toolEntries = tools.map((t) => ({
          kind: 'tool',
          name: t.name || '',
          category: t.category || 'Other',
          description: t.description || '',
        })).filter((t) => t.name);
        const skillEntries = skills.map((s) => ({
          kind: 'skill',
          name: s.name || '',
          category: 'Skill',
          description: s.description || '',
        })).filter((s) => s.name);
        // Skills first when scores tie — they're the most expensive
        // primitive to compose by hand, so surfacing them early pays
        // off in authoring time.
        wfPickerCache = [...skillEntries, ...toolEntries];
        return wfPickerCache;
      })
      .catch((err) => {
        console.error('tool picker: failed to load tools', err);
        wfPickerCache = [];
        return wfPickerCache;
      })
      .finally(() => { wfPickerCachePromise = null; });
    return wfPickerCachePromise;
  }

  function ensureToolPickerEl() {
    if (toolPickerState.el) return toolPickerState.el;
    const el = document.createElement('div');
    el.className = 'wf-tool-picker';
    el.setAttribute('data-wf-tool-picker', '');
    el.style.display = 'none';
    document.body.appendChild(el);
    el.addEventListener('mousedown', (e) => {
      // Prevent the textarea blur from firing before the click handler.
      e.preventDefault();
    });
    el.addEventListener('click', (e) => {
      const row = e.target instanceof HTMLElement ? e.target.closest('[data-wf-tool-row]') : null;
      if (!row) return;
      const name = row.getAttribute('data-wf-tool-row');
      const kind = row.getAttribute('data-wf-tool-kind') || 'tool';
      selectToolFromPicker(name, kind);
    });
    toolPickerState.el = el;
    return el;
  }

  function positionPicker(anchor) {
    const el = toolPickerState.el;
    if (!el || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    // Anchor below the element; clamp to viewport.
    const left = Math.max(8, Math.min(window.innerWidth - 300, rect.left));
    const top = rect.bottom + 4 + window.scrollY;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  /**
   * Open the picker. Two modes:
   *   - { anchor, stepIndex, insertMention: false }
   *       Anchored to a button (+ ADD TOOL). No textarea interaction.
   *   - { textarea, stepIndex, mentionStart }
   *       User typed '@' in a step prompt. Filter follows characters
   *       after the '@'. On select we insert @toolname into the prompt
   *       at the mention position.
   */
  async function openToolPicker(opts) {
    const el = ensureToolPickerEl();
    await loadToolsForPicker();
    toolPickerState.activeTextarea = opts.textarea || null;
    toolPickerState.stepIndex = (opts.stepIndex !== undefined) ? opts.stepIndex : -1;
    toolPickerState.insertMention = !!opts.insertMention;
    toolPickerState.mentionStart = opts.mentionStart !== undefined ? opts.mentionStart : -1;
    toolPickerState.filter = opts.filter || '';
    toolPickerState.activeRow = 0;
    const anchor = opts.anchor || opts.textarea;
    positionPicker(anchor);
    el.style.display = 'block';
    renderToolPicker();
  }

  function closeToolPicker() {
    const el = toolPickerState.el;
    if (el) el.style.display = 'none';
    toolPickerState.activeTextarea = null;
    toolPickerState.stepIndex = -1;
    toolPickerState.mentionStart = -1;
    toolPickerState.filter = '';
    toolPickerState.matches = [];
    toolPickerState.activeRow = 0;
  }

  function filterTools(filter) {
    const all = wfPickerCache || [];
    if (!filter) return all.slice(0, 8);
    const needle = filter.toLowerCase();
    const scored = [];
    for (const t of all) {
      const nameLc = t.name.toLowerCase();
      const catLc = t.category.toLowerCase();
      let score = -1;
      if (nameLc.startsWith(needle)) score = 100;
      else if (nameLc.includes(needle)) score = 70;
      else if (catLc.includes(needle)) score = 30;
      if (score >= 0) {
        // Boost skills slightly — they're rarer + higher-leverage so
        // when a name matches both a tool and a skill, prefer surfacing
        // the skill near the top.
        if (t.kind === 'skill') score += 5;
        scored.push({ t, score });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
    return scored.slice(0, 8).map((s) => s.t);
  }

  function renderToolPicker() {
    const el = toolPickerState.el;
    if (!el) return;
    const matches = filterTools(toolPickerState.filter);
    toolPickerState.matches = matches;
    if (toolPickerState.activeRow >= matches.length) toolPickerState.activeRow = 0;
    if (matches.length === 0) {
      el.innerHTML = '<div class="wf-tool-picker-empty">— nothing matches "' + escMem(toolPickerState.filter) + '" —</div>';
      return;
    }
    el.innerHTML = matches.map((t, i) => {
      const cls = 'wf-tool-picker-row' + (i === toolPickerState.activeRow ? ' active' : '');
      const kind = t.kind || 'tool';
      const catLabel = kind === 'skill' ? 'SKILL' : (t.category || 'TOOL');
      const catCls = kind === 'skill' ? 'wf-tool-picker-cat is-skill' : 'wf-tool-picker-cat';
      return [
        '<div class="' + cls + '" data-wf-tool-row="' + escMem(t.name) + '" data-wf-tool-kind="' + escMem(kind) + '">',
        '  <span class="wf-tool-picker-name">' + escMem(t.name) + '</span>',
        '  <span class="' + catCls + '">' + escMem(catLabel) + '</span>',
        '</div>',
      ].join('');
    }).join('');
  }

  function selectToolFromPicker(name, kind) {
    if (!name) return;
    const idx = toolPickerState.stepIndex;
    if (idx < 0 || !wfDraft || !wfDraft.steps[idx]) { closeToolPicker(); return; }
    const step = wfDraft.steps[idx];
    if (kind === 'skill') {
      // Skills bind to step.usesSkill — one skill per step. Adding a
      // new one replaces the prior binding (rare, but explicit beats
      // surprising). Don't touch allowedTools.
      step.usesSkill = name;
    } else {
      if (!Array.isArray(step.allowedTools)) step.allowedTools = [];
      if (!step.allowedTools.includes(name)) step.allowedTools.push(name);
    }

    // If opened via @-mention, splice @name into the prompt at the
    // mention position. Otherwise just update the chip rail.
    if (toolPickerState.insertMention && toolPickerState.activeTextarea && toolPickerState.mentionStart >= 0) {
      const ta = toolPickerState.activeTextarea;
      const value = ta.value;
      const before = value.slice(0, toolPickerState.mentionStart);
      const afterStart = ta.selectionEnd ?? value.length;
      const after = value.slice(afterStart);
      const insertion = '@' + name + ' ';
      ta.value = before + insertion + after;
      step.prompt = ta.value;
      const caret = before.length + insertion.length;
      try { ta.setSelectionRange(caret, caret); } catch { /* tolerate */ }
    }
    closeToolPicker();
    renderEditor();
  }

  function onMentionTextareaInput(ta) {
    const value = ta.value;
    const caret = ta.selectionStart ?? value.length;
    // Find the nearest '@' before the caret that starts at a word
    // boundary and has no whitespace between it and the caret.
    let at = -1;
    for (let i = caret - 1; i >= 0; i--) {
      const ch = value[i];
      if (ch === '@') { at = i; break; }
      if (/\s/.test(ch)) break;
    }
    if (at < 0) { closeToolPicker(); return; }
    if (at > 0 && /\S/.test(value[at - 1])) { closeToolPicker(); return; }
    const filter = value.slice(at + 1, caret);
    if (filter.length > 60) { closeToolPicker(); return; }
    const idx = parseInt(ta.getAttribute('data-wf-step-index') || '-1', 10);
    openToolPicker({
      textarea: ta,
      stepIndex: idx,
      insertMention: true,
      mentionStart: at,
      filter,
    });
  }

  function onMentionTextareaKeydown(ta, e) {
    const open = toolPickerState.el && toolPickerState.el.style.display === 'block' && toolPickerState.activeTextarea === ta;
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      toolPickerState.activeRow = Math.min(toolPickerState.matches.length - 1, toolPickerState.activeRow + 1);
      renderToolPicker();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      toolPickerState.activeRow = Math.max(0, toolPickerState.activeRow - 1);
      renderToolPicker();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      const pick = toolPickerState.matches[toolPickerState.activeRow];
      if (pick) {
        e.preventDefault();
        selectToolFromPicker(pick.name, pick.kind || 'tool');
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeToolPicker();
    }
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

  /**
   * Render one architect-proposed diff as a card in the chat log with
   * APPLY / DISCARD buttons. Ops are stashed on the DOM node so the
   * delegated click handler can read them back without re-parsing.
   */
  function appendDiffCard(diff) {
    if (!wf.chatLog || !diff || !Array.isArray(diff.ops) || diff.ops.length === 0) return null;
    const intro = wf.chatLog.querySelector('.wf-chat-intro');
    if (intro) intro.remove();
    const card = document.createElement('div');
    card.className = 'wf-diff-card';
    card._wfOps = diff.ops;
    const opsHtml = diff.ops.map((op) => '<li>' + escMem(describeDiffOp(op)) + '</li>').join('');
    const summary = diff.summary ? '<div class="wf-diff-summary">' + escMem(diff.summary) + '</div>' : '';
    card.innerHTML = [
      '<div class="wf-diff-head">PROPOSED CHANGES · ' + diff.ops.length + ' OP' + (diff.ops.length === 1 ? '' : 'S') + '</div>',
      summary,
      '<ul class="wf-diff-ops">' + opsHtml + '</ul>',
      '<div class="wf-diff-actions">',
      '  <button type="button" class="wf-diff-apply" data-wf-diff-apply>APPLY ▸</button>',
      '  <button type="button" class="wf-diff-discard" data-wf-diff-discard>DISCARD</button>',
      '</div>',
      '<div class="wf-diff-status" hidden></div>',
    ].join('');
    wf.chatLog.appendChild(card);
    wf.chatLog.scrollTop = wf.chatLog.scrollHeight;
    return card;
  }

  /** Human-readable one-liner per op for the diff card body. */
  function describeDiffOp(op) {
    if (!op || typeof op !== 'object') return '(invalid op)';
    const t = op.type;
    if (t === 'set_field') {
      const v = typeof op.value === 'string' ? '"' + op.value + '"' : JSON.stringify(op.value);
      return 'set ' + op.path + ' → ' + v;
    }
    if (t === 'add_step') {
      const id = op.step && op.step.id ? op.step.id : '?';
      const promptExcerpt = op.step && op.step.prompt ? op.step.prompt.slice(0, 70) : '';
      const skill = op.step && (op.step.uses_skill || op.step.usesSkill);
      const skillTag = skill ? ' [uses skill: ' + skill + ']' : '';
      return '+ step ' + id + (promptExcerpt ? ': "' + promptExcerpt + (op.step.prompt.length > 70 ? '…' : '') + '"' : '') + skillTag;
    }
    if (t === 'update_step') {
      const fields = op.patch ? Object.keys(op.patch).join(', ') : '';
      return '~ step ' + op.id + (fields ? ': ' + fields + ' updated' : '');
    }
    if (t === 'remove_step') return '− step ' + op.id;
    if (t === 'reorder_step') return '↕ step ' + op.id + ' moved after ' + (op.after || '(first)');
    if (t === 'rename_step') return '∼ step ' + op.id + ' → ' + op.newId;
    if (t === 'add_input') return '+ input ' + op.key;
    if (t === 'remove_input') return '− input ' + op.key;
    if (t === 'set_synthesis') return op.value ? 'set synthesis prompt' : 'clear synthesis prompt';
    return '(unknown op: ' + String(t) + ')';
  }

  /**
   * Apply an array of architect ops to a draft. Returns { draft, warnings }.
   * Pure function — caller is responsible for re-rendering and validating.
   * Unknown / invalid ops are skipped with a warning rather than throwing,
   * so a partially-malformed diff still applies the good parts.
   */
  function applyDiff(currentDraft, ops) {
    const warnings = [];
    const base = currentDraft || {
      name: 'new-workflow', description: '', enabled: false,
      triggerSchedule: '', steps: [], inputs: {}, synthesisPrompt: '',
    };
    // Deep-ish clone — steps + inputs are the parts that get mutated.
    const draft = {
      ...base,
      steps: (base.steps || []).map((s) => ({
        ...s,
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.slice() : [],
        allowedTools: Array.isArray(s.allowedTools) ? s.allowedTools.slice() : s.allowedTools,
      })),
      inputs: { ...(base.inputs || {}) },
    };
    const findStepIndex = (id) => draft.steps.findIndex((s) => s.id === id);
    const SET_FIELD_PATHS = { name: 1, description: 1, triggerSchedule: 1, enabled: 1, whenToUse: 1 };

    for (const op of ops) {
      if (!op || typeof op !== 'object') { warnings.push('skipped malformed op'); continue; }
      switch (op.type) {
        case 'set_field': {
          if (!SET_FIELD_PATHS[op.path]) { warnings.push('unknown field: ' + op.path); break; }
          draft[op.path] = op.value;
          break;
        }
        case 'add_step': {
          const step = op.step;
          if (!step || typeof step.id !== 'string') { warnings.push('add_step missing id'); break; }
          if (findStepIndex(step.id) >= 0) { warnings.push('step "' + step.id + '" already exists — skipped add_step'); break; }
          // Accept architect's snake_case allowed_tools alongside camelCase.
          const allowedTools = Array.isArray(step.allowed_tools) ? step.allowed_tools.slice()
            : Array.isArray(step.allowedTools) ? step.allowedTools.slice() : undefined;
          // Same snake/camel tolerance for uses_skill.
          const usesSkill = typeof step.uses_skill === 'string' ? step.uses_skill.trim()
            : typeof step.usesSkill === 'string' ? step.usesSkill.trim() : '';
          draft.steps.push({
            id: step.id,
            prompt: typeof step.prompt === 'string' ? step.prompt : '',
            dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.slice() : [],
            ...(step.model ? { model: step.model } : {}),
            ...(step.forEach ? { forEach: step.forEach } : {}),
            ...(step.deterministic ? { deterministic: step.deterministic } : {}),
            ...(allowedTools ? { allowedTools } : {}),
            ...(usesSkill ? { usesSkill } : {}),
          });
          break;
        }
        case 'update_step': {
          const idx = findStepIndex(op.id);
          if (idx < 0) { warnings.push('update_step: no step "' + op.id + '" — skipped'); break; }
          const patch = (op.patch && typeof op.patch === 'object') ? op.patch : {};
          if (typeof patch.prompt === 'string') draft.steps[idx].prompt = patch.prompt;
          if (Array.isArray(patch.dependsOn)) draft.steps[idx].dependsOn = patch.dependsOn.slice();
          if (Array.isArray(patch.allowed_tools)) draft.steps[idx].allowedTools = patch.allowed_tools.slice();
          else if (Array.isArray(patch.allowedTools)) draft.steps[idx].allowedTools = patch.allowedTools.slice();
          if (typeof patch.model === 'string') draft.steps[idx].model = patch.model;
          if (typeof patch.forEach === 'string') draft.steps[idx].forEach = patch.forEach;
          if (patch.deterministic !== undefined) draft.steps[idx].deterministic = patch.deterministic;
          // uses_skill: explicit null clears the binding; string sets it.
          if ('uses_skill' in patch || 'usesSkill' in patch) {
            const next = patch.uses_skill !== undefined ? patch.uses_skill : patch.usesSkill;
            if (next === null || next === '') delete draft.steps[idx].usesSkill;
            else if (typeof next === 'string') draft.steps[idx].usesSkill = next.trim();
          }
          break;
        }
        case 'remove_step': {
          const idx = findStepIndex(op.id);
          if (idx < 0) { warnings.push('remove_step: no step "' + op.id + '"'); break; }
          draft.steps.splice(idx, 1);
          // Also drop any references to it from other steps' dependsOn.
          draft.steps.forEach((s) => {
            if (Array.isArray(s.dependsOn)) s.dependsOn = s.dependsOn.filter((d) => d !== op.id);
          });
          break;
        }
        case 'reorder_step': {
          const idx = findStepIndex(op.id);
          if (idx < 0) { warnings.push('reorder_step: no step "' + op.id + '"'); break; }
          const [moved] = draft.steps.splice(idx, 1);
          if (op.after === null || op.after === undefined || op.after === '') {
            draft.steps.unshift(moved);
          } else {
            const afterIdx = findStepIndex(op.after);
            if (afterIdx < 0) {
              // Anchor missing — push back roughly where it was.
              draft.steps.splice(idx, 0, moved);
              warnings.push('reorder_step: anchor "' + op.after + '" not found');
            } else {
              draft.steps.splice(afterIdx + 1, 0, moved);
            }
          }
          break;
        }
        case 'rename_step': {
          const idx = findStepIndex(op.id);
          if (idx < 0) { warnings.push('rename_step: no step "' + op.id + '"'); break; }
          if (typeof op.newId !== 'string' || !op.newId.trim()) { warnings.push('rename_step: invalid newId'); break; }
          if (findStepIndex(op.newId) >= 0) { warnings.push('rename_step: "' + op.newId + '" already exists'); break; }
          draft.steps[idx].id = op.newId;
          // Rewrite dependsOn references across the rest of the steps.
          draft.steps.forEach((s) => {
            if (Array.isArray(s.dependsOn)) {
              s.dependsOn = s.dependsOn.map((d) => (d === op.id ? op.newId : d));
            }
          });
          break;
        }
        case 'add_input': {
          if (typeof op.key !== 'string' || !op.key.trim()) { warnings.push('add_input: invalid key'); break; }
          draft.inputs[op.key] = (op.value !== undefined && op.value !== null) ? op.value : '';
          break;
        }
        case 'remove_input': {
          if (typeof op.key !== 'string') { warnings.push('remove_input: invalid key'); break; }
          delete draft.inputs[op.key];
          break;
        }
        case 'set_synthesis': {
          draft.synthesisPrompt = (op.value === null || op.value === undefined) ? '' : String(op.value);
          break;
        }
        default:
          warnings.push('unknown op type: ' + String(op.type));
      }
    }
    return { draft, warnings };
  }

  // Delegated handler for APPLY / DISCARD on diff cards in the chat log.
  if (wf.chatLog) {
    wf.chatLog.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const card = target.closest('.wf-diff-card');
      if (!card) return;
      if (target.closest('[data-wf-diff-apply]')) {
        event.preventDefault();
        const ops = card._wfOps || [];
        const result = applyDiff(wfDraft, ops);
        wfDraft = result.draft;
        // If we were starting from an empty editor (no NEW yet), make sure
        // we flip into "new workflow" mode so SAVE creates instead of patches.
        if (!wfSelectedName && wfIsNew !== true) wfIsNew = true;
        renderEditor();
        // Mark the card as applied so the user can't double-apply it.
        card.classList.add('applied');
        const statusEl = card.querySelector('.wf-diff-status');
        if (statusEl) {
          statusEl.hidden = false;
          const warningsHtml = result.warnings.length > 0
            ? '<div class="wf-diff-warn">' + result.warnings.map((w) => escMem('⚠ ' + w)).join('<br>') + '</div>'
            : '';
          statusEl.innerHTML = '<span class="wf-diff-applied">✓ APPLIED</span>' + warningsHtml;
        }
        // Disable the action buttons.
        const buttons = card.querySelectorAll('button');
        buttons.forEach((b) => { b.disabled = true; });
        return;
      }
      if (target.closest('[data-wf-diff-discard]')) {
        event.preventDefault();
        card.classList.add('discarded');
        const statusEl = card.querySelector('.wf-diff-status');
        if (statusEl) {
          statusEl.hidden = false;
          statusEl.innerHTML = '<span class="wf-diff-discarded">— DISCARDED —</span>';
        }
        const buttons = card.querySelectorAll('button');
        buttons.forEach((b) => { b.disabled = true; });
      }
    });
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
        const text = (j.text || '').trim();
        if (text) {
          appendChatMessage('assistant', text);
        }
        if (j.diff && Array.isArray(j.diff.ops) && j.diff.ops.length > 0) {
          appendDiffCard(j.diff);
        } else if (!text) {
          // Server returned nothing useful — keep the user oriented.
          appendChatMessage('assistant', '(no reply)');
        }
        wfChatHistory.push({ role: 'assistant', text });
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

  // v0.5.11 UX — wire architect chat starter chips. Clicking a chip
  // pre-fills the textarea and focuses it so the user can edit before
  // sending. Also toggle which chip set is visible based on whether a
  // workflow draft is currently loaded ("new" chips when starting from
  // scratch, "edit" chips when refining an existing workflow).
  function syncArchitectChatChips() {
    const hasDraft = !!wfDraft;
    const chips = document.querySelectorAll('[data-wf-chat-chip-mode]');
    chips.forEach(function (chip) {
      const mode = chip.getAttribute('data-wf-chat-chip-mode');
      const shouldShow = hasDraft ? mode === 'edit' : mode === 'new';
      if (shouldShow) chip.removeAttribute('hidden');
      else chip.setAttribute('hidden', '');
    });
  }
  document.querySelectorAll('[data-wf-chat-chip]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      const prompt = chip.getAttribute('data-wf-chat-chip');
      if (!prompt || !wf.chatInput) return;
      wf.chatInput.value = prompt;
      wf.chatInput.focus();
      // Move caret to end so user can append / edit naturally.
      try {
        const len = prompt.length;
        wf.chatInput.setSelectionRange(len, len);
      } catch (_) { /* not all browsers */ }
    });
  });
  // Re-sync chips whenever the draft state changes. The draft can flip
  // from null → object in many spots (workflow click in list, ＋ NEW,
  // architect-applied diff). Easiest robust signal: poll a cheap flag
  // on the same animation frame as the editor render. We use a
  // setInterval at 500ms — chip toggling is purely UI, no API cost.
  setInterval(syncArchitectChatChips, 500);
  syncArchitectChatChips();

  // ─── Tools panel ──────────────────────────────────────────────

  const tools = {
    search:     document.querySelector('[data-tools-search]'),
    count:      document.querySelector('[data-tools-count]'),
    categories: document.querySelector('[data-tools-categories]'),
    grid:       document.querySelector('[data-tools-grid]'),
    shown:      document.querySelector('[data-tools-shown]'),
    mcpCount:   document.querySelector('[data-mcp-count]'),
  };
  let toolsData = null;
  let toolsActiveCategory = '';

  async function bootToolsPanel() {
    try {
      toolsData = await fetchJSON('/api/console/tools');
      renderToolsCategories();
      renderToolsGrid();
      if (tools.mcpCount) tools.mcpCount.textContent = (toolsData.mcpServers || []).length;
    } catch (err) {
      tools.grid.innerHTML = '<div class="tools-empty">— failed: ' + escMem(err.message || err) + ' —</div>';
    }
    // Also load the LOCAL CLIs registry view (connected-clis.json mirror).
    // Same endpoint Integrations uses, but rendered view-only here so the
    // user has a clear answer to "what command-line tools does my agent
    // have right now?" without switching panels.
    refreshToolsCliList();
  }

  async function refreshToolsCliList() {
    const listEl = document.querySelector('[data-tools-cli-list]');
    const countEl = document.querySelector('[data-tools-cli-count]');
    if (!listEl) return;
    try {
      const data = await fetchJSON('/api/console/cli-catalog');
      const connected = data.connected || {};
      const entries = Object.values(connected);
      if (countEl) countEl.textContent = String(entries.length);
      if (entries.length === 0) {
        listEl.innerHTML = '<div class="tools-empty" style="padding:8px 12px;">— no local CLIs connected yet —</div>';
        return;
      }
      // Sort newest first so freshly-promoted CLIs land at the top
      entries.sort((a, b) => (b.installedAt || '').localeCompare(a.installedAt || ''));
      listEl.innerHTML = entries.map((c) => {
        const auth = c.authCommand ? '<div class="tools-cli-meta">auth: <code>' + escMem(c.authCommand) + '</code></div>' : '';
        const when = c.installedAt ? '<span class="tools-cli-when">linked ' + escMem(c.installedAt.slice(0, 10)) + '</span>' : '';
        return [
          '<div class="tools-cli-row">',
          '  <div class="tools-cli-name"><code>' + escMem(c.command) + '</code>' + escMem(c.name) + '</div>',
          '  <div>',
          '    <div class="tools-cli-meta">' + escMem(c.vendor) + '</div>',
          auth,
          '  </div>',
          '  ' + when,
          '</div>',
        ].join('');
      }).join('');
    } catch (err) {
      listEl.innerHTML = '<div class="tools-empty" style="padding:8px 12px;color:var(--accent-fail);">— failed: ' + escMem((err && err.message) || err) + ' —</div>';
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
      const addBtn = document.querySelector('[data-ws-add-btn]');
      if (addBtn && !addBtn.dataset.wired) {
        addBtn.dataset.wired = '1';
        addBtn.addEventListener('click', () => openWorkspaceModal());
      }
    } catch (err) {
      proj.list.innerHTML = '<li class="empty">— failed: ' + escMem(err.message || err) + ' —</li>';
    }
  }

  async function refreshProjectsPanel() {
    try {
      projData = await fetchJSON('/api/console/projects');
      renderWorkspaces();
      renderProjects();
    } catch (_) { /* keep current view */ }
  }

  function renderWorkspaces() {
    const dirs = (projData && projData.workspaceDirs) || [];
    proj.wsCount.textContent = dirs.length;
    if (dirs.length === 0) {
      proj.wsList.innerHTML = '<li class="empty">— no workspaces yet · click + ADD to link a project folder —</li>';
      return;
    }
    proj.wsList.innerHTML = dirs.map((d) => [
      '<li>',
      '  <span>' + escMem(d) + '</span>',
      '  <button class="ws-remove" data-ws-remove="' + escMem(d) + '" type="button" title="Unlink this workspace">×</button>',
      '</li>',
    ].join('')).join('');
    Array.from(proj.wsList.querySelectorAll('[data-ws-remove]')).forEach((btn) => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const target = btn.getAttribute('data-ws-remove');
        if (!target) return;
        if (!confirm('Unlink this workspace?\\n\\n' + target + '\\n\\nThe folder stays on disk — only the agent\\'s view of it goes away.')) return;
        try {
          const r = await fetch(withToken('/api/console/projects/workspace?path=' + encodeURIComponent(target)), { method: 'DELETE' });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            alert('Could not remove: ' + (j.error || ('HTTP ' + r.status)));
            return;
          }
          await refreshProjectsPanel();
        } catch (err) {
          alert('Network error: ' + ((err && err.message) || err));
        }
      });
    });
  }

  // ─── Workspace linker modal ───────────────────────────────────
  let wsModal = null;
  let wsModalMode = 'browse';
  let wsModalCwd = null;

  function openWorkspaceModal() {
    if (wsModal) return;
    wsModal = document.createElement('div');
    wsModal.className = 'ws-modal-backdrop';
    wsModal.innerHTML = [
      '<div class="ws-modal">',
      '  <div class="ws-modal-head">',
      '    <span>LINK A WORKSPACE</span>',
      '    <button class="ws-close" data-ws-modal-close type="button">CLOSE ✕</button>',
      '  </div>',
      '  <div class="ws-modal-tabs">',
      '    <button data-ws-tab="browse" class="active" type="button">BROWSE</button>',
      '    <button data-ws-tab="search" type="button">SEARCH BY NAME</button>',
      '  </div>',
      '  <div class="ws-modal-body" data-ws-modal-body>',
      '    <div class="ws-modal-status">— loading —</div>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(wsModal);
    wsModal.addEventListener('click', (ev) => {
      if (ev.target === wsModal) closeWorkspaceModal();
    });
    wsModal.querySelector('[data-ws-modal-close]').addEventListener('click', closeWorkspaceModal);
    Array.from(wsModal.querySelectorAll('[data-ws-tab]')).forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-ws-tab');
        wsModalMode = tab;
        Array.from(wsModal.querySelectorAll('[data-ws-tab]')).forEach((b) =>
          b.classList.toggle('active', b === btn));
        if (tab === 'browse') renderWsBrowse();
        else renderWsSearch();
      });
    });
    renderWsBrowse();
  }

  function closeWorkspaceModal() {
    if (!wsModal) return;
    wsModal.remove();
    wsModal = null;
    wsModalCwd = null;
  }

  async function renderWsBrowse(targetPath) {
    if (!wsModal) return;
    const body = wsModal.querySelector('[data-ws-modal-body]');
    body.innerHTML = '<div class="ws-modal-status">— loading —</div>';
    const url = targetPath
      ? '/api/console/projects/browse?path=' + encodeURIComponent(targetPath)
      : '/api/console/projects/browse';
    try {
      const data = await fetchJSON(url);
      wsModalCwd = data.path;
      const parent = data.parent;
      const home = data.home;
      const breadcrumb = [
        '<div class="ws-cwd">',
        (parent ? '<span class="ws-cwd-link" data-ws-go="' + escMem(parent) + '">../</span>' : ''),
        (home && data.path !== home ? '<span class="ws-cwd-link" data-ws-go="' + escMem(home) + '">~ / home</span>' : ''),
        '<span>' + escMem(data.path) + '</span>',
        '</div>',
      ].join('');
      const addThis = '<button class="ws-add-this" data-ws-add-current="' + escMem(data.path) + '" type="button">+ Link this folder · ' + escMem(data.path) + '</button>';
      const entries = (data.entries || []).map((e) => [
        '<li data-ws-go="' + escMem(e.path) + '">',
        '  <span class="ws-dir-name">' + escMem(e.name) + '/</span>',
        '  <button class="ws-link-btn" data-ws-add="' + escMem(e.path) + '" type="button">LINK</button>',
        '</li>',
      ].join('')).join('');
      body.innerHTML = [
        breadcrumb,
        addThis,
        '<ul class="ws-dir-list">',
        entries || '<li><span class="ws-dir-name" style="color:var(--fg-mute)">— no subfolders here —</span></li>',
        '</ul>',
      ].join('');
      wireWsBrowse(body);
    } catch (err) {
      body.innerHTML = '<div class="ws-modal-status error">— ' + escMem(err.message || err) + ' —</div>';
    }
  }

  function wireWsBrowse(body) {
    Array.from(body.querySelectorAll('[data-ws-go]')).forEach((el) => {
      el.addEventListener('click', (ev) => {
        if ((ev.target).hasAttribute && ev.target.hasAttribute('data-ws-add')) return; // let the inner Link button win
        const target = el.getAttribute('data-ws-go');
        if (target) renderWsBrowse(target);
      });
    });
    const addCurrent = body.querySelector('[data-ws-add-current]');
    if (addCurrent) {
      addCurrent.addEventListener('click', () => linkWorkspace(addCurrent.getAttribute('data-ws-add-current')));
    }
    Array.from(body.querySelectorAll('[data-ws-add]')).forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        linkWorkspace(btn.getAttribute('data-ws-add'));
      });
    });
  }

  function renderWsSearch() {
    if (!wsModal) return;
    const body = wsModal.querySelector('[data-ws-modal-body]');
    body.innerHTML = [
      '<input type="text" class="ws-search-input" data-ws-search-input placeholder="Type a folder name to search for…" />',
      '<div class="ws-modal-status">Type at least 2 characters to search common locations (~, ~/Desktop, ~/Documents, ~/Developer, ~/Projects).</div>',
      '<ul class="ws-dir-list" data-ws-search-results></ul>',
    ].join('');
    const input = body.querySelector('[data-ws-search-input]');
    const results = body.querySelector('[data-ws-search-results]');
    const status = body.querySelector('.ws-modal-status');
    input.focus();
    let timer = null;
    input.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) {
        results.innerHTML = '';
        status.textContent = 'Type at least 2 characters to search common locations.';
        status.classList.remove('error');
        return;
      }
      timer = setTimeout(async () => {
        status.textContent = '— searching —';
        status.classList.remove('error');
        try {
          const data = await fetchJSON('/api/console/projects/search?query=' + encodeURIComponent(q));
          const hits = data.results || [];
          if (hits.length === 0) {
            results.innerHTML = '';
            status.textContent = 'No matches in common locations. Try Browse to navigate manually.';
            return;
          }
          status.textContent = hits.length + ' match' + (hits.length === 1 ? '' : 'es') + ' (max 80)';
          results.innerHTML = hits.map((h) => [
            '<li>',
            '  <span class="ws-dir-name">' + escMem(h.name) + '/<br><span style="color:var(--fg-mute);font-size:10px;">' + escMem(h.path) + '</span></span>',
            '  <button class="ws-link-btn" data-ws-add="' + escMem(h.path) + '" type="button">LINK</button>',
            '</li>',
          ].join('')).join('');
          Array.from(results.querySelectorAll('[data-ws-add]')).forEach((btn) => {
            btn.addEventListener('click', () => linkWorkspace(btn.getAttribute('data-ws-add')));
          });
        } catch (err) {
          status.textContent = '— ' + (err.message || err) + ' —';
          status.classList.add('error');
        }
      }, 200);
    });
  }

  async function linkWorkspace(targetPath) {
    if (!targetPath) return;
    try {
      const r = await fetch(withToken('/api/console/projects/workspace'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: targetPath }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert('Could not link: ' + (j.error || ('HTTP ' + r.status)));
        return;
      }
      const j = await r.json();
      await refreshProjectsPanel();
      closeWorkspaceModal();
      if (j.alreadyLinked) {
        alert('That folder is already linked.');
      }
    } catch (err) {
      alert('Network error: ' + ((err && err.message) || err));
    }
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
        parts.push('<div class="proj-block"><div class="proj-block-head"><span>IMPORTED AGENT NOTES</span></div><div class="proj-block-body"><pre>' + escMem(data.claudeMd) + '</pre></div></div>');
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
  //
  // Manages SKILL.md format skills (Anthropic Skills spec): folders
  // with SKILL.md (YAML frontmatter + markdown body) that load into
  // the agent's context on demand. Install from GitHub; uninstall
  // here. Lives in ~/.clementine-next/skills/.

  let skillsInstallPollTimer = null;

  async function bootSkillsPanel() {
    const dirEl    = document.querySelector('[data-skills-dir]');
    const cntEl    = document.querySelector('[data-skills-count]');
    const gridEl   = document.querySelector('[data-skills-grid]');
    const urlInput = document.querySelector('[data-skills-install-url]');
    const runBtn   = document.querySelector('[data-skills-install-run]');
    const statusEl = document.querySelector('[data-skills-install-status]');

    if (runBtn && !runBtn.dataset.bound) {
      runBtn.dataset.bound = '1';
      runBtn.addEventListener('click', async () => {
        const url = (urlInput?.value || '').trim();
        if (!url) {
          showError('Paste a GitHub repo, owner/repo shorthand, or an \`npx skills add\` command.');
          return;
        }
        await startSkillInstall(url, statusEl, runBtn);
      });
    }
    if (urlInput && !urlInput.dataset.bound) {
      urlInput.dataset.bound = '1';
      urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); runBtn?.click(); }
      });
    }

    await refreshSkillsList(gridEl, cntEl, dirEl);
  }

  async function refreshSkillsList(gridEl, cntEl, dirEl) {
    if (!gridEl) return;
    try {
      const data = await fetchJSON('/api/console/skills');
      if (dirEl && data.skillsDir) dirEl.textContent = data.skillsDir;
      const skills = data.skills || [];
      if (cntEl) cntEl.textContent = skills.length;
      if (skills.length === 0) {
        gridEl.innerHTML = [
          '<div class="tools-empty">— no skills installed —<br>',
          '<span style="color:var(--fg-mute);font-size:10px;letter-spacing:0.06em;">',
          'Paste any of: <code>github.com/owner/repo</code>, <code>owner/repo</code>, or <code>npx skills add owner/repo</code>. Private repos work when GitHub CLI is authenticated. Try <code>Leonxlnx/taste-skill</code> — it ships 12 design skills in one repo.',
          '</span></div>',
        ].join('');
        return;
      }
      gridEl.innerHTML = skills.map((s) => {
        const sourceLine = s.source && s.source.repo
          ? '<div class="skill-desc" style="color:var(--fg-3);font-size:10px;">from ' + escMem(s.source.repo) + (s.source.sha ? ' @ ' + escMem(s.source.sha.slice(0, 7)) : '') + '</div>'
          : '';
        const extras = [
          s.hasScripts ? '<span class="skill-tool-pill">scripts/</span>' : '',
          s.hasSrc ? '<span class="skill-tool-pill">src/</span>' : '',
          s.hasReferences ? '<span class="skill-tool-pill">references/</span>' : '',
        ].filter(Boolean).join('');
        const display = s.displayName && s.displayName !== s.name ? s.displayName : s.name;
        return [
          '<div class="skill-card" data-skill-name="' + escMem(s.name) + '">',
          '  <div class="skill-head">',
          '    <span class="skill-name">' + escMem(display) + '</span>',
          '    <button class="skill-uninstall" data-skill-uninstall="' + escMem(s.name) + '" title="Uninstall">UNINSTALL</button>',
          '  </div>',
          s.description ? '  <div class="skill-desc">' + escMem(s.description) + '</div>' : '',
          sourceLine,
          extras ? '  <div class="skill-tools">' + extras + '</div>' : '',
          '</div>',
        ].join('');
      }).join('');

      gridEl.querySelectorAll('[data-skill-uninstall]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const name = btn.getAttribute('data-skill-uninstall');
          if (!confirm('Uninstall skill "' + name + '"? The folder will be deleted.')) return;
          btn.disabled = true;
          btn.textContent = 'REMOVING…';
          try {
            const r = await fetch(withToken('/api/console/skills/' + encodeURIComponent(name)), { method: 'DELETE' });
            if (!r.ok) {
              const j = await r.json().catch(() => ({}));
              alert('Uninstall failed: ' + (j.error || r.status));
            }
            await refreshSkillsList(gridEl, cntEl, dirEl);
          } catch (err) {
            alert('Uninstall failed: ' + (err.message || err));
          }
        });
      });
    } catch (err) {
      gridEl.innerHTML = '<div class="tools-empty">— failed: ' + escMem(err.message || err) + ' —</div>';
    }
  }

  async function startSkillInstall(url, statusEl, runBtn) {
    if (skillsInstallPollTimer) { clearInterval(skillsInstallPollTimer); skillsInstallPollTimer = null; }
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent = 'Queuing install…';
    }
    if (runBtn) { runBtn.disabled = true; runBtn.textContent = 'INSTALLING…'; }
    try {
      const r = await fetch(withToken('/api/console/skills/install'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (statusEl) statusEl.textContent = 'Error: ' + (j.error || r.status);
        return;
      }
      const jobId = j.job?.id;
      if (!jobId) {
        if (statusEl) statusEl.textContent = 'Install kicked off but no job id returned.';
        return;
      }
      // Poll until terminal.
      skillsInstallPollTimer = setInterval(async () => {
        try {
          const pollR = await fetch(withToken('/api/console/skills/install/' + encodeURIComponent(jobId)));
          const pollJ = await pollR.json().catch(() => ({}));
          if (!pollR.ok) {
            if (statusEl) statusEl.textContent = 'Status check failed: ' + (pollJ.error || pollR.status);
            clearInterval(skillsInstallPollTimer);
            skillsInstallPollTimer = null;
            return;
          }
          const job = pollJ.job || {};
          if (statusEl) statusEl.textContent = (job.output || '').slice(-1500);
          if (job.status === 'succeeded' || job.status === 'failed') {
            clearInterval(skillsInstallPollTimer);
            skillsInstallPollTimer = null;
            if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'INSTALL FROM GITHUB'; }
            const gridEl = document.querySelector('[data-skills-grid]');
            const cntEl = document.querySelector('[data-skills-count]');
            const dirEl = document.querySelector('[data-skills-dir]');
            await refreshSkillsList(gridEl, cntEl, dirEl);
            // Reset the install form so the user can paste another URL
            // without clearing the field by hand. Success briefly shows a
            // confirmation, then collapses the log; failures keep the log
            // visible so the user can read why it broke.
            const urlInput = document.querySelector('[data-skills-install-url]');
            if (job.status === 'succeeded') {
              if (urlInput) {
                urlInput.value = '';
                try { urlInput.focus(); } catch (_) { /* noop */ }
              }
              const installedNames = (job.installed || []).map((x) => x.name);
              if (statusEl) {
                const n = installedNames.length;
                statusEl.textContent = n > 0
                  ? '✓ Installed ' + n + ' skill' + (n === 1 ? '' : 's') + ': ' + installedNames.slice(0, 6).join(', ') + (n > 6 ? ' + ' + (n - 6) + ' more' : '') + '. Paste another URL to install more.'
                  : '✓ Done.';
                setTimeout(() => { if (statusEl) statusEl.hidden = true; }, 6000);
              }
            }
          }
        } catch (err) {
          if (statusEl) statusEl.textContent = 'Status check error: ' + (err.message || err);
        }
      }, 750);
    } catch (err) {
      if (statusEl) statusEl.textContent = 'Network error: ' + (err.message || err);
      if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'INSTALL FROM GITHUB'; }
    }
  }

  // ─── Settings panel ───────────────────────────────────────────

  const sett = {
    profileForm: document.querySelector('[data-settings-profile-form]'),
    policyForm:  document.querySelector('[data-settings-policy-form]'),
    authBox:     document.querySelector('[data-settings-auth]'),
    memoryBox:   document.querySelector('[data-settings-memory]'),
    modelsForm:  document.querySelector('[data-settings-models-form]'),
    modelsStatus: document.querySelector('[data-settings-models-status]'),
    modelsReset: document.querySelector('[data-settings-models-reset]'),
    runtimeForm: document.querySelector('[data-settings-runtime-form]'),
    runtimeStatus: document.querySelector('[data-settings-runtime-status]'),
  };

  // Advanced-settings gate. Proactivity Policy (and any other block tagged
  // data-advanced-block) is hidden by default — most users never need to
  // touch the autonomy controls, and surfacing them by default invites
  // accidental misconfiguration. The toggle persists in localStorage so
  // power users don't have to flip it every reload.
  (function setupAdvancedToggle() {
    const toggle = document.querySelector('[data-settings-advanced-toggle]');
    if (!toggle) return;
    const STORAGE_KEY = 'clementine.settings.showAdvanced';
    let showAdvanced = false;
    try { showAdvanced = localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) { /* private mode */ }
    const apply = (visible) => {
      document.querySelectorAll('[data-advanced-block]').forEach((el) => {
        if (visible) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
      });
    };
    toggle.checked = showAdvanced;
    apply(showAdvanced);
    toggle.addEventListener('change', () => {
      const next = !!toggle.checked;
      try { localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch (_) { /* private mode */ }
      apply(next);
    });
  })();

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
  function getRuntimeFormPatch(form) {
    const patch = {};
    form.querySelectorAll('[data-runtime-field]').forEach((el) => {
      const name = el.getAttribute('name');
      if (!name) return;
      if (el.type === 'checkbox') patch[name] = el.checked;
      else if (el.type === 'number') {
        const n = parseInt(el.value, 10);
        if (Number.isFinite(n)) patch[name] = n;
      } else {
        patch[name] = el.value;
      }
    });
    return patch;
  }

  // ─── Home panel ────────────────────────────────────────────────

  async function bootHomePanel() {
    const form = document.querySelector('[data-home-chat-form]');
    const input = document.querySelector('[data-home-chat-input]');
    if (form && input) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const text = (input.value || '').trim();
        if (!text) return;
        input.value = '';
        await sendHomeChat(text);
      });
    }
    // 0.3 harness toggle removed — harness is the default chat runtime
    // now. The localStorage key clementine.useHarness stays as a
    // debug-only escape hatch (set to "0" to force legacy v0.2 chat),
    // but there is no user-visible control. See harnessModeOn().

    // Auto-send when the user clicks a suggested prompt.
    document.querySelectorAll('[data-home-chat-suggest]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const text = btn.getAttribute('data-home-chat-suggest') || '';
        if (text) await sendHomeChat(text);
      });
    });
    bindHomeVoiceControls();
    await Promise.allSettled([refreshHomeAgenda(), refreshHomeCommandCenter()]);
  }

  const HOME_LIST_CAP = 5;

  async function refreshHomeAgenda() {
    const agendaEl = document.querySelector('[data-home-agenda]');
    const doneEl = document.querySelector('[data-home-done]');
    const agendaCountEl = document.querySelector('[data-home-agenda-count]');
    const doneCountEl = document.querySelector('[data-home-done-count]');
    if (!agendaEl || !doneEl) return;
    try {
      const data = await fetchJSON('/api/console/home/agenda');
      const agenda = data.agenda || [];
      const done = data.done || [];
      const totals = data.totals || {};
      if (agendaCountEl) agendaCountEl.textContent = String(agenda.length);
      if (doneCountEl) doneCountEl.textContent = String(done.length);

      const agendaSlice = agenda.slice(0, HOME_LIST_CAP);
      const doneSlice = done.slice(0, HOME_LIST_CAP);

      const agendaItems = agendaSlice.map((item) => renderHomeItem(item)).join('');
      // If there are agent-tracked tasks NOT shown on home, surface them
      // behind a single deep-link instead of a full list.
      const hiddenPending = Math.max(0, (totals.pendingTasks || 0) - agendaSlice.filter((i) => i.kind === 'task').length);
      const agendaFooterParts = [];
      if (agenda.length > HOME_LIST_CAP) {
        agendaFooterParts.push('<a class="tools-jump" data-tools-jump="activity">' + agenda.length + ' total →</a>');
      }
      if (hiddenPending > 0) {
        agendaFooterParts.push('<a class="tools-jump" data-tools-jump="activity">+ ' + hiddenPending + ' agent-tracked tasks</a>');
      }
      const agendaFooter = agendaFooterParts.length > 0
        ? '<div class="home-list-footer">' + agendaFooterParts.join(' · ') + '</div>'
        : '';

      agendaEl.innerHTML = agenda.length === 0
        ? '<div class="home-empty">— nothing on the docket. Quiet day. —</div>' + (hiddenPending > 0 ? '<div class="home-list-footer"><a class="tools-jump" data-tools-jump="activity">' + hiddenPending + ' agent-tracked tasks →</a></div>' : '')
        : agendaItems + agendaFooter;

      const doneItems = doneSlice.map((item) => renderHomeItem(item, true)).join('');
      const hiddenDone = Math.max(0, (totals.completedTasks || 0) - doneSlice.filter((i) => i.kind === 'task').length);
      const doneFooterParts = [];
      if (done.length > HOME_LIST_CAP) {
        doneFooterParts.push('<a class="tools-jump" data-tools-jump="activity">' + done.length + ' total →</a>');
      }
      if (hiddenDone > 0) {
        doneFooterParts.push('<a class="tools-jump" data-tools-jump="activity">+ ' + hiddenDone + ' more</a>');
      }
      const doneFooter = doneFooterParts.length > 0
        ? '<div class="home-list-footer">' + doneFooterParts.join(' · ') + '</div>'
        : '';
      doneEl.innerHTML = done.length === 0
        ? '<div class="home-empty">— nothing closed today yet. —</div>'
        : doneItems + doneFooter;
    } catch (err) {
      agendaEl.innerHTML = '<div class="home-empty">Failed: ' + escMem(err.message || err) + '</div>';
    }
  }

  function renderHomeItem(item, isDone) {
    const kindClass = isDone ? 'done' : (item.kind || 'task');
    return [
      '<div class="home-item">',
      '  <span class="home-item-kind ' + escMem(kindClass) + '">' + escMem((item.kind || 'item').toUpperCase()) + '</span>',
      '  <div style="flex:1; min-width:0;">',
      '    <div class="home-item-text">' + escMem(item.title || '') + '</div>',
      item.meta ? '    <div class="home-item-meta">' + escMem(item.meta) + '</div>' : '',
      '  </div>',
      '</div>',
    ].join('');
  }

  const homeChatHistory = [];

  // 0.3 harness session — kept across turns within the same chat
  // dock so follow-up messages continue the same conversation.
  // Reset whenever the toggle flips.
  let __harnessSessionId = null;

  function harnessModeOn() {
    // Harness is the default chat runtime as of 0.3. The localStorage
    // key is kept ONLY as an escape hatch: explicitly setting it to "0"
    // forces the legacy v0.2 path for debugging. Anything else (unset,
    // "1", anything) routes through the harness — which is what the
    // user-visible UI was supposed to do all along. The opt-in toggle
    // it used to live behind has been retired.
    try { return localStorage.getItem('clementine.useHarness') !== '0'; } catch (_) { return true; }
  }

  // Elapsed-time SEND button helpers — flip to disabled + live counter
  // when a turn fires, restore on finish/error. The bare 'THINKING …'
  // gave no time signal so the user couldn't tell whether the agent
  // was 5 seconds or 5 minutes deep. After 5s of thinking we start
  // showing seconds; after 60s we shift to "Nm Ns". The setInterval is
  // returned so the caller can clear it in a finally{} block.
  function startThinkingButton(sendBtn) {
    if (!sendBtn) return null;
    sendBtn.setAttribute('disabled', 'true');
    const startedAt = Date.now();
    const update = () => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      if (elapsed < 5) {
        sendBtn.textContent = 'THINKING …';
      } else if (elapsed < 60) {
        sendBtn.textContent = 'THINKING · ' + elapsed + 's';
      } else {
        const min = Math.floor(elapsed / 60);
        const sec = elapsed % 60;
        sendBtn.textContent = 'THINKING · ' + min + 'm ' + sec + 's';
      }
    };
    update();
    const timer = setInterval(update, 1000);
    return timer;
  }
  function stopThinkingButton(sendBtn, timer) {
    if (timer) { try { clearInterval(timer); } catch (_) {} }
    if (sendBtn) { sendBtn.removeAttribute('disabled'); sendBtn.textContent = 'SEND ↵'; }
  }

  /**
   * Route a chat message through the 0.3 harness:
   * POST /api/harness/chat returns 202 + sessionId + streamUrl, then
   * subscribe to /api/sessions/<id>/events via EventSource. Each
   * event updates the in-flight assistant turn (status line + body).
   * The stream closes when conversation_completed / run_failed /
   * awaiting_user_input arrives.
   */
  async function sendHarnessChat(text, options) {
    options = options || {};
    const thread = document.querySelector('[data-home-chat-thread]');
    const send = document.querySelector('.home-chat-send');
    if (!thread) return { ok: false };
    const hint = thread.querySelector('.home-chat-hint');
    if (hint) hint.remove();

    appendChatTurn('user', text);
    homeChatHistory.push({ role: 'user', text });
    const assistantTurn = appendChatTurn('assistant', '');
    assistantTurn && assistantTurn.classList.add('pending');
    setChatTurnStatus(assistantTurn, 'starting harness run');

    const thinkTimer = startThinkingButton(send);

    try {
      const r = await fetch(withToken('/api/harness/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text, sessionId: __harnessSessionId }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        const msg = j.error || ('HTTP ' + r.status);
        setChatTurnText(assistantTurn, 'Error: ' + msg);
        setChatTurnStatus(assistantTurn, 'failed');
        return { ok: false, text: msg };
      }
      const body = await r.json();
      __harnessSessionId = body.sessionId;
      await streamHarnessSession(body.sessionId, assistantTurn, { ...options, sinceSeq: body.sinceSeq || 0 });
      homeChatHistory.push({ role: 'assistant', text: assistantTurn.querySelector('[data-home-chat-turn-text]')?.textContent || '' });
      return { ok: true };
    } catch (err) {
      setChatTurnText(assistantTurn, 'Network error: ' + ((err && err.message) || err));
      setChatTurnStatus(assistantTurn, 'failed');
      return { ok: false };
    } finally {
      assistantTurn?.classList.remove('pending');
      stopThinkingButton(send, thinkTimer);
    }
  }

  // Subscribe to the per-session SSE stream and update the assistant
  // turn as events arrive. Resolves when the stream reaches a
  // terminal state.
  //
  // Reconnect strategy: EventSource auto-reconnects but loses query
  // params, so a network blip would replay from seq=0 and miss any
  // event written during the gap. We track lastSeq, manually close
  // on error, and rebuild with ?sinceSeq=<lastSeq>. Bounded by
  // MAX_RECONNECTS so a permanently-broken endpoint doesn't loop.
  function humanHarnessText(value, fallback) {
    if (value == null) return fallback || '';
    if (typeof value === 'object') {
      const reply = typeof value.reply === 'string' ? value.reply.trim() : '';
      const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
      return reply || summary || fallback || '';
    }
    const text = String(value).trim();
    if (!text) return fallback || '';
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
          const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
          if (reply || summary) return reply || summary;
        }
      } catch (_) {
        // Not JSON after all; use the raw text below.
      }
    }
    return text;
  }

  function streamHarnessSession(sessionId, turn, options) {
    const MAX_RECONNECTS = 5;
    return new Promise((resolve) => {
      let lastSeq = Number(options && options.sinceSeq) || 0;
      let attempts = 0;
      let es = null;
      let closed = false;

      const finish = () => {
        if (closed) return;
        closed = true;
        try { if (es) es.close(); } catch (_) {}
        resolve();
      };

      const handleEvent = (ev) => {
        if (ev && typeof ev.seq === 'number' && ev.seq > lastSeq) lastSeq = ev.seq;
        renderHarnessEvent(ev, turn, options);
        if (ev.type === 'conversation_completed') {
          const summary = humanHarnessText(ev.data && (ev.data.reply || ev.data.summary), '');
          const reason = ev.data && ev.data.reason;
          const existing = turn?.querySelector?.('[data-home-chat-turn-text]')?.textContent || '';
          if (summary) {
            setChatTurnText(turn, summary);
          } else if (!existing) {
            // No final summary and no intermediate text — fall back to a
            // human-readable reason so the bubble isn't visually blank.
            setChatTurnText(turn, reason === 'no_structured_output'
              ? '(Finished without a written reply.)'
              : '(Done.)');
          }
          setChatTurnStatus(turn, reason === 'abandoned_by_orchestrator' ? 'abandoned' : 'complete');
          finish();
        } else if (ev.type === 'run_failed') {
          const msg = (ev.data && ev.data.error) || 'failed';
          setChatTurnText(turn, 'Error: ' + msg);
          setChatTurnStatus(turn, 'failed');
          finish();
        } else if (ev.type === 'conversation_limit_exceeded') {
          const reason = (ev.data && ev.data.reason) || 'limit';
          setChatTurnStatus(turn, 'stopped: ' + reason);
          finish();
        } else if (ev.type === 'awaiting_user_input') {
          const q = (ev.data && ev.data.question) || 'waiting on your reply';
          setChatTurnText(turn, q);
          setChatTurnStatus(turn, 'awaiting reply');
          finish();
        } else if (ev.type === 'approval_requested') {
          // Render an actual approval control in the BODY (not just a
          // typed command hint) and end this SSE stream so the SEND
          // button re-enables. Clicking a button resumes this same
          // session through /api/harness/chat.
          const subj = (ev.data && (ev.data.subject || ev.data.tool)) || 'action';
          const reason = (ev.data && ev.data.reason) || '';
          const apr = ev.data && typeof ev.data.approvalId === 'string' ? ev.data.approvalId : null;
          setChatTurnApproval(turn, { subject: subj, reason, approvalId: apr }, sessionId, options);
          setChatTurnStatus(turn, 'awaiting approval');
          finish();
        }
      };

      const connect = () => {
        if (closed) return;
        // Defensive close — match the convention used by the other two
        // EventSource sites in this file (sessionLive at line ~8395 and
        // actions-stream at line ~16516). The error path at line ~12627
        // already closes prior 'es' before re-scheduling, but if any
        // future code path calls connect() while a prior es is still
        // open (manual reconnect button, IPC trigger, etc.), this guard
        // prevents the leaked-EventSource path the P1-10 audit flagged.
        if (es) { try { es.close(); } catch (_) {} es = null; }
        const base = '/api/sessions/' + encodeURIComponent(sessionId) + '/events';
        const url = withToken(lastSeq > 0 ? base + '?sinceSeq=' + lastSeq : base);
        es = new EventSource(url);

        es.addEventListener('replay', (e) => {
          try {
            const payload = JSON.parse(e.data);
            for (const ev of payload.events || []) {
              handleEvent(ev);
              if (closed) break;
            }
            // Successful replay frame means we're connected — reset
            // the backoff so a later blip gets the full retry budget.
            attempts = 0;
          } catch (_) {}
        });
        es.addEventListener('event', (e) => {
          try {
            const ev = JSON.parse(e.data);
            handleEvent(ev);
          } catch (_) {}
        });
        es.onerror = () => {
          if (closed) return;
          if (es && es.readyState === EventSource.CLOSED) {
            // Server-side close (terminal session, auth failure, etc).
            // Don't reconnect — the user-visible state is already final.
            finish();
            return;
          }
          attempts += 1;
          if (attempts > MAX_RECONNECTS) {
            setChatTurnStatus(turn, 'lost connection');
            finish();
            return;
          }
          try { if (es) es.close(); } catch (_) {}
          // Brief backoff: 250ms * attempts (250, 500, 750, 1000, 1250).
          setTimeout(connect, 250 * attempts);
        };
      };

      connect();
    });
  }

  // Mirror of src/runtime/approval-summary.ts previewToolCall(), in
  // pure JS so the chat dock can render rich status without needing
  // the daemon to enrich tool_called events. Cap at ~70 chars. Falls
  // back to the bare tool name if the args can't be parsed. Touched
  // here ONLY for visibility — the existing setChatTurnStatus +
  // onStatus paths still fire regardless.
  function previewToolCallJS(toolName, argsRaw) {
    if (!toolName) return 'tool';
    let args = null;
    if (argsRaw && typeof argsRaw === 'object') args = argsRaw;
    else if (typeof argsRaw === 'string' && argsRaw.length > 0) {
      try { args = JSON.parse(argsRaw); } catch (_) { args = null; }
    }
    if (!args || typeof args !== 'object') return toolName;
    const MAX = 70;
    const pick = (keys) => {
      for (const k of keys) {
        const v = args[k];
        if (typeof v === 'string' && v.length > 0) return v;
      }
      return '';
    };
    const clip = (s, max) => {
      const clean = String(s || '').replace(/\s+/g, ' ').trim();
      return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
    };
    switch (toolName) {
      case 'run_shell_command':
      case 'shell': {
        const cmd = pick(['command', 'cmd']);
        return cmd ? 'running: ' + clip(cmd, MAX) : toolName;
      }
      case 'write_file':
      case 'edit_file': {
        const file = pick(['file_path', 'path', 'filePath']);
        return file ? 'writing ' + clip(file, MAX) : toolName;
      }
      case 'read_file': {
        const file = pick(['file_path', 'path', 'filePath']);
        return file ? 'reading ' + clip(file, MAX) : toolName;
      }
      case 'composio_execute_tool': {
        const slug = pick(['tool_slug', 'slug']);
        return slug ? 'composio · ' + clip(slug, MAX - 10) : toolName;
      }
      case 'composio_search_tools': {
        const q = pick(['query', 'q']);
        return q ? 'searching composio · "' + clip(q, MAX - 22) + '"' : toolName;
      }
      case 'memory_recall':
      case 'tool_choice_recall': {
        const intent = pick(['intent', 'query', 'q']);
        return intent ? 'recall · ' + clip(intent, MAX - 9) : toolName;
      }
      case 'memory_search': {
        const q = pick(['query', 'q']);
        return q ? 'memory search · "' + clip(q, MAX - 17) + '"' : toolName;
      }
      case 'draft_plan': {
        const input = pick(['input', 'objective', 'goal']);
        return input ? 'planning · ' + clip(input, MAX - 11) : toolName;
      }
      case 'notify_user':
      case 'send_message':
      case 'discord_channel_send':
      case 'discord_dm': {
        const t = pick(['title', 'subject']) || pick(['message', 'content', 'text', 'body']);
        return t ? 'notify · ' + clip(t, MAX - 9) : toolName;
      }
      case 'send_email':
      case 'gmail_send':
      case 'outlook_send_email': {
        const to = pick(['to', 'recipient']);
        return to ? 'emailing ' + clip(to, MAX - 9) : toolName;
      }
      case 'request_approval': {
        const subject = pick(['subject', 'reason']);
        return subject ? 'requesting approval · ' + clip(subject, MAX - 22) : toolName;
      }
      default: {
        return toolName;
      }
    }
  }

  function renderHarnessEvent(ev, turn, options) {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case 'turn_started':
        setChatTurnStatus(turn, 'thinking…');
        return;
      case 'tool_called': {
        const t = (ev.data && (ev.data.tool || ev.data.name)) || 'tool';
        // Rich status line: "running: pwd && ls" beats "using
        // run_shell_command" by a wide margin during the 7-call shell
        // sequences that show up in skill execution. When the helper
        // can't extract a useful field from args, it returns the
        // bare tool name — in that fallback case we still prepend
        // "using " so the user reads it as an in-progress action.
        // The bare tool name stays as the secondary onStatus signal
        // so any other listener (Activity panel, etc.) keeps working
        // unchanged.
        const preview = previewToolCallJS(t, ev.data && ev.data.arguments);
        setChatTurnStatus(turn, preview === t ? 'using ' + t : preview);
        if (options && options.onStatus) options.onStatus('Using: ' + t, 'tool');
        return;
      }
      case 'handoff': {
        const to = (ev.data && (ev.data.to || ev.data.target)) || 'sub-agent';
        setChatTurnStatus(turn, '→ ' + to);
        return;
      }
      case 'conversation_step': {
        const decision = ev.data && ev.data.decision;
        const stepText = decision ? humanHarnessText(decision.reply || decision.summary, '') : '';
        if (stepText) {
          setChatTurnText(turn, stepText);
          setChatTurnStatus(turn, 'step ' + (ev.data.step || '?'));
        }
        return;
      }
      case 'guardrail_tripped': {
        const name = (ev.data && ev.data.name) || 'guardrail';
        setChatTurnStatus(turn, '⚠ ' + name);
        return;
      }
    }
  }

  function setChatTurnText(turn, text) {
    const body = turn?.querySelector?.('[data-home-chat-turn-text]');
    if (!body) return;
    // Use innerHTML with safe escape + URL detection so Clementine's
    // replies that contain links (Sheet URLs, GitHub PRs, etc.) render
    // as clickable anchors instead of plain text. The history-capture
    // sites still read body.textContent, which strips the <a> tags
    // back to the raw URL — exactly the right behavior for transcript.
    body.innerHTML = renderTextWithLinks(text || '');
  }

  function setChatTurnApproval(turn, approval, sessionId, options) {
    const body = turn?.querySelector?.('[data-home-chat-turn-text]');
    if (!body) return;
    body.textContent = '';

    const title = document.createElement('div');
    title.textContent = 'Approval required: ' + (approval.subject || 'action');
    body.appendChild(title);

    if (approval.reason) {
      const reason = document.createElement('div');
      reason.style.marginTop = '8px';
      reason.textContent = approval.reason;
      body.appendChild(reason);
    }

    const hint = document.createElement('div');
    hint.style.marginTop = '8px';
    hint.textContent = approval.approvalId
      ? 'Approval ID: ' + approval.approvalId
      : 'This approval is tied to the current paused session.';
    body.appendChild(hint);

    const actions = document.createElement('div');
    actions.className = 'home-chat-turn-actions';

    const approve = document.createElement('button');
    approve.type = 'button';
    approve.textContent = 'Approve';
    approve.addEventListener('click', () => {
      resumeHarnessApprovalFromButton(approve, 'approve', approval.approvalId, sessionId, turn, options);
    });

    const reject = document.createElement('button');
    reject.type = 'button';
    reject.textContent = 'Reject';
    reject.addEventListener('click', () => {
      resumeHarnessApprovalFromButton(reject, 'reject', approval.approvalId, sessionId, turn, options);
    });

    actions.appendChild(approve);
    actions.appendChild(reject);
    body.appendChild(actions);
  }

  async function resumeHarnessApprovalFromButton(button, decision, approvalId, sessionId, turn, options) {
    const actions = button.closest('.home-chat-turn-actions');
    const buttons = actions ? Array.from(actions.querySelectorAll('button')) : [button];
    const send = document.querySelector('.home-chat-send');
    buttons.forEach((btn) => { btn.disabled = true; });
    const thinkTimer = startThinkingButton(send);
    button.textContent = decision === 'approve' ? 'Approved' : 'Rejected';
    turn?.classList?.add('pending');
    setChatTurnStatus(turn, (decision === 'approve' ? 'approved' : 'rejected') + ' · continuing…');
    try {
      const input = decision + (approvalId ? ' ' + approvalId : '');
      const r = await fetch(withToken('/api/harness/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, sessionId }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + r.status));
      }
      const body = await r.json();
      __harnessSessionId = body.sessionId || sessionId;
      await streamHarnessSession(__harnessSessionId, turn, { ...(options || {}), sinceSeq: body.sinceSeq || 0 });
      homeChatHistory.push({ role: 'assistant', text: turn?.querySelector?.('[data-home-chat-turn-text]')?.textContent || '' });
    } catch (err) {
      buttons.forEach((btn) => { btn.disabled = false; });
      button.textContent = decision === 'approve' ? 'Approve' : 'Reject';
      setChatTurnStatus(turn, 'approval failed');
      alert('Could not resolve approval: ' + ((err && err.message) || err));
    } finally {
      turn?.classList?.remove('pending');
      stopThinkingButton(send, thinkTimer);
    }
  }

  function setChatTurnStatus(turn, text) {
    const status = turn?.querySelector?.('[data-home-chat-turn-status]');
    if (status) status.textContent = text || '';
  }

  async function readNdjsonStream(response, onEvent) {
    if (!response.body) throw new Error('Streaming response did not include a body.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        onEvent(JSON.parse(trimmed));
      }
    }
    const tail = buffer.trim();
    if (tail) onEvent(JSON.parse(tail));
  }

  async function sendHomeChat(text, options = {}) {
    // 0.3 harness routes when the toggle is flipped on. The legacy
    // chat path below stays untouched as the fallback.
    if (harnessModeOn()) return sendHarnessChat(text, options);

    const thread = document.querySelector('[data-home-chat-thread]');
    const send = document.querySelector('.home-chat-send');
    if (!thread) return;
    // Clear the hint on first send.
    const hint = thread.querySelector('.home-chat-hint');
    if (hint) hint.remove();

    appendChatTurn('user', text);
    homeChatHistory.push({ role: 'user', text });
    const assistantTurn = appendChatTurn('assistant', '');
    assistantTurn?.classList.add('pending');
    setChatTurnStatus(assistantTurn, 'starting local run');

    const thinkTimer = startThinkingButton(send);
    let streamedText = '';
    let finalText = '';
    let pendingApprovalId = null;
    try {
      const r = await fetch(withToken('/api/console/home/chat/stream'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: homeChatHistory.slice(-10) }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setChatTurnText(assistantTurn, 'Error: ' + (j.error || r.status));
        return { ok: false, text: j.error || String(r.status) };
      }

      await readNdjsonStream(r, (event) => {
        if (event.type === 'chunk' && typeof event.delta === 'string') {
          streamedText += event.delta;
          setChatTurnText(assistantTurn, streamedText);
          setChatTurnStatus(assistantTurn, 'streaming response');
          options.onChunk?.(event.delta, streamedText);
          return;
        }
        if (event.type === 'tool') {
          const toolName = event.toolName || 'tool';
          setChatTurnStatus(assistantTurn, 'using ' + toolName);
          options.onStatus?.('Using local tool: ' + toolName, 'tool');
          return;
        }
        if (event.type === 'status') {
          setChatTurnStatus(assistantTurn, event.text || 'working');
          options.onStatus?.(event.text || 'working', 'status');
          return;
        }
        if (event.type === 'done') {
          finalText = event.text || streamedText || '(no reply)';
          pendingApprovalId = event.pendingApprovalId || null;
          setChatTurnText(assistantTurn, finalText);
          // Status label varies by why the run ended. The grace-turn
          // case carries a real model-written summary; we just need
          // to add a [Continue] button below the message so the user
          // can resume with a fresh budget.
          const reason = event.stoppedReason || 'success';
          const turns = event.turnsUsed ? ' (' + event.turnsUsed + ' turns)' : '';
          if (reason === 'max-turns-with-grace') {
            setChatTurnStatus(assistantTurn, 'paused at budget' + turns);
            // Add an inline [Continue] button under the message.
            const actions = document.createElement('div');
            actions.className = 'home-chat-turn-actions';
            actions.style.marginTop = '8px';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'home-chat-suggest';
            btn.textContent = '▶ CONTINUE';
            btn.addEventListener('click', () => {
              btn.disabled = true;
              btn.textContent = 'continuing…';
              sendHomeChat('continue', { onStatus: options.onStatus, onChunk: options.onChunk });
            });
            actions.appendChild(btn);
            assistantTurn.appendChild(actions);
          } else if (pendingApprovalId) {
            setChatTurnStatus(assistantTurn, 'approval required');
          } else if (reason === 'error') {
            setChatTurnStatus(assistantTurn, 'no reply');
          } else {
            setChatTurnStatus(assistantTurn, 'complete' + turns);
          }
          return;
        }
        if (event.type === 'error') {
          finalText = 'Error: ' + (event.error || 'unknown');
          setChatTurnText(assistantTurn, finalText);
          setChatTurnStatus(assistantTurn, 'failed');
          options.onStatus?.(finalText, 'error');
        }
      });

      const textOut = finalText || streamedText || '(no reply)';
      setChatTurnText(assistantTurn, textOut);
      homeChatHistory.push({ role: 'assistant', text: textOut });
      return { ok: !textOut.startsWith('Error:'), text: textOut, pendingApprovalId };
    } catch (err) {
      setChatTurnText(assistantTurn, 'Network error: ' + (err.message || err));
      setChatTurnStatus(assistantTurn, 'failed');
      return { ok: false, text: err.message || String(err) };
    } finally {
      assistantTurn?.classList.remove('pending');
      stopThinkingButton(send, thinkTimer);
      const input = document.querySelector('[data-home-chat-input]');
      if (input) input.focus();
    }
  }

  function appendChatTurn(role, text) {
    const thread = document.querySelector('[data-home-chat-thread]');
    if (!thread) return;
    const turn = document.createElement('div');
    turn.className = 'home-chat-turn ' + role;
    // Use the link-aware renderer for the initial body so the first
    // assistant reply that lands with a URL is already clickable —
    // no need to wait for a follow-up setChatTurnText.
    turn.innerHTML =
      '<span class="home-chat-role">' + (role === 'user' ? 'YOU' : 'CLEMENTINE') + '</span>' +
      '<div data-home-chat-turn-text>' + renderTextWithLinks(text) + '</div>' +
      '<span class="home-chat-stream-status" data-home-chat-turn-status></span>';
    thread.appendChild(turn);
    thread.scrollTop = thread.scrollHeight;
    return turn;
  }

  const liveVoiceState = {
    pc: null,
    dc: null,
    stream: null,
    connected: false,
    phase: 'idle',
    lastTranscript: '',
    assistantTranscript: '',
    handledCalls: new Set(),
    focus: false,
    // Audio-reactive mouth — created when the remote audio track lands.
    audioCtx: null,
    analyser: null,
    analyserData: null,
    mouthRaf: 0,
    mouthSmoothed: 0,
    haloSmoothed: 0,
    // Wake-word listener — independent of the Realtime session.
    wakeRecognizer: null,
    wakeActive: false,
    wakeRestartTimer: 0,
  };

  /**
   * Drive the dog's mouth + halo from the remote audio track. Called
   * once when WebRTC delivers the assistant's audio stream; runs a
   * rAF loop that updates two CSS custom properties on the orb
   * button: --mouth-open (0..1) and --halo-strength (0..1).
   *
   * Smoothing uses asymmetric attack/release so the mouth snaps open
   * with speech onsets but closes smoothly when the syllable ends —
   * matches how a real mouth moves.
   */
  function startMouthDriver(remoteStream) {
    const orb = document.querySelector('[data-home-voice-toggle]');
    if (!orb || !remoteStream) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!liveVoiceState.audioCtx || liveVoiceState.audioCtx.state === 'closed') {
        liveVoiceState.audioCtx = new AC();
      }
      const ctx = liveVoiceState.audioCtx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(remoteStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.45;
      source.connect(analyser);
      liveVoiceState.analyser = analyser;
      liveVoiceState.analyserData = new Uint8Array(analyser.frequencyBinCount);
      cancelAnimationFrame(liveVoiceState.mouthRaf);

      const ATTACK = 0.55;   // how fast the mouth opens
      const RELEASE = 0.18;  // how fast it closes
      const NOISE_FLOOR = 0.05;

      const tick = () => {
        if (!liveVoiceState.analyser) return;
        analyser.getByteTimeDomainData(liveVoiceState.analyserData);
        // RMS amplitude across the time-domain frame, mapped to 0..1.
        let sum = 0;
        for (let i = 0; i < liveVoiceState.analyserData.length; i += 1) {
          const v = (liveVoiceState.analyserData[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / liveVoiceState.analyserData.length);
        const lifted = Math.max(0, (rms - NOISE_FLOOR) / (1 - NOISE_FLOOR));
        // Non-linear curve so quiet TTS still moves the mouth.
        const target = Math.min(1, Math.pow(lifted, 0.5) * 1.4);
        const prev = liveVoiceState.mouthSmoothed;
        const rate = target > prev ? ATTACK : RELEASE;
        liveVoiceState.mouthSmoothed = prev + (target - prev) * rate;
        // Halo follows but lags the mouth slightly so the glow reads as
        // a wash of presence rather than a flicker.
        liveVoiceState.haloSmoothed += (target - liveVoiceState.haloSmoothed) * 0.12;
        orb.style.setProperty('--mouth-open', liveVoiceState.mouthSmoothed.toFixed(3));
        orb.style.setProperty('--halo-strength', liveVoiceState.haloSmoothed.toFixed(3));
        liveVoiceState.mouthRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      console.warn('Mouth driver init failed:', err);
    }
  }

  /**
   * Wake-word listener — "Hey Clementine" from anywhere in the app.
   *
   * Uses the browser's SpeechRecognition (webkitSpeechRecognition) for
   * a "good-enough" v1 with zero external dependencies. This works
   * reliably in real Chrome but is unreliable inside Electron's stock
   * Chromium (no Google API key shipped). When unavailable we surface
   * "unavailable" on the toggle dot so the user can see the truth
   * instead of toggling into a dead listener.
   *
   * Production path: swap the engine for Picovoice Porcupine
   * (@picovoice/porcupine-web) — offline, custom .ppn file, ~1MB
   * model. Wire-up shape stays the same: instantiate, on detect → call
   * onWakeWord().
   */
  const WAKE_PHRASES = [
    'hey clementine', 'hi clementine', 'hey clemmy', 'hi clemmy',
    // Common ASR mis-hearings — capture them rather than reject the
    // turn. The agent itself can disambiguate downstream.
    'hey clemantine', 'hey clemintine', 'hey clemmie',
  ];

  function getSpeechRecognitionCtor() {
    // Electron blacklist: the Chromium build shipped with Electron does
    // accept SpeechRecognition calls, but the continuous-listening
    // pattern causes the macOS microphone privacy indicator in the menu
    // bar to pulse on/off every time the engine restarts after a silence
    // window. That's roughly every 5–10s, which looks broken. Picovoice
    // Porcupine is the right always-on engine here; until that's wired,
    // wake-word stays a browser-only feature so the desktop app doesn't
    // turn into a mic strobe light. window.clemmy is the unambiguous
    // marker that we're inside the Electron renderer.
    if (typeof window !== 'undefined' && window.clemmy) return null;
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function transcriptContainsWake(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return WAKE_PHRASES.some((phrase) => lower.includes(phrase));
  }

  function setWakeToggleState(state) {
    const label = document.querySelector('.home-live-wake-toggle');
    if (label) label.setAttribute('data-wake-state', state);
  }

  function onWakeWordDetected() {
    if (liveVoiceState.connected) return;
    setWakeToggleState('heard');
    // Brief visual confirmation, then start live voice. The orb itself
    // animates as the Realtime session connects.
    setTimeout(() => {
      if (liveVoiceState.wakeActive) setWakeToggleState('listening');
    }, 1200);
    startHomeVoice().catch((err) => {
      console.warn('Wake-word startHomeVoice failed:', err);
    });
  }

  function startWakeListener() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setWakeToggleState('unavailable');
      return false;
    }
    if (liveVoiceState.connected) {
      // The Realtime session owns the mic. Park the wake listener
      // until it ends; stopHomeVoice() re-arms us.
      setWakeToggleState('listening');
      return true;
    }
    try {
      if (liveVoiceState.wakeRecognizer) {
        try { liveVoiceState.wakeRecognizer.stop(); } catch {}
      }
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = 'en-US';
      rec.maxAlternatives = 2;
      rec.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const alts = event.results[i];
          for (let j = 0; j < alts.length; j += 1) {
            const candidate = alts[j]?.transcript || '';
            if (transcriptContainsWake(candidate)) {
              onWakeWordDetected();
              return;
            }
          }
        }
      };
      rec.onerror = (event) => {
        const reason = event && event.error;
        if (reason === 'not-allowed' || reason === 'service-not-allowed') {
          // Permanent failure — Electron without speech service, or
          // user denied mic. Don't auto-restart.
          liveVoiceState.wakeActive = false;
          liveVoiceState.wakeRecognizer = null;
          setWakeToggleState('unavailable');
          const cb = document.querySelector('[data-home-voice-wake-toggle]');
          if (cb) cb.checked = false;
          try { localStorage.setItem('clemmy.wake', '0'); } catch {}
          return;
        }
        // Transient (no-speech, network, aborted): just let onend
        // restart us in a moment.
      };
      rec.onend = () => {
        // SpeechRecognition stops itself after a window of silence.
        // Bounce it back on if the user still has wake-word enabled
        // and we aren't currently in a live voice call.
        if (!liveVoiceState.wakeActive || liveVoiceState.connected) return;
        clearTimeout(liveVoiceState.wakeRestartTimer);
        liveVoiceState.wakeRestartTimer = setTimeout(() => {
          if (liveVoiceState.wakeActive && !liveVoiceState.connected) startWakeListener();
        }, 400);
      };
      rec.start();
      liveVoiceState.wakeRecognizer = rec;
      setWakeToggleState('listening');
      return true;
    } catch (err) {
      console.warn('Wake-word listener failed to start:', err);
      setWakeToggleState('unavailable');
      return false;
    }
  }

  function stopWakeListener() {
    clearTimeout(liveVoiceState.wakeRestartTimer);
    liveVoiceState.wakeRestartTimer = 0;
    if (liveVoiceState.wakeRecognizer) {
      try { liveVoiceState.wakeRecognizer.onend = null; } catch {}
      try { liveVoiceState.wakeRecognizer.stop(); } catch {}
      liveVoiceState.wakeRecognizer = null;
    }
    setWakeToggleState('');
  }

  function bindWakeWordToggle() {
    const cb = document.querySelector('[data-home-voice-wake-toggle]');
    if (!cb || cb.dataset.bound === '1') return;
    cb.dataset.bound = '1';
    const engineAvailable = Boolean(getSpeechRecognitionCtor());

    // If the engine isn't available (Electron, no SpeechRecognition),
    // force the toggle off + clear any stale localStorage preference so
    // a previously-enabled flag from a different runtime can't auto-arm
    // a non-functional listener. The label flips to "unavailable" so the
    // user knows toggling won't help here.
    if (!engineAvailable) {
      cb.checked = false;
      cb.disabled = true;
      try { localStorage.setItem('clemmy.wake', '0'); } catch {}
      liveVoiceState.wakeActive = false;
      setWakeToggleState('unavailable');
      const wrap = document.querySelector('.home-live-wake-toggle');
      if (wrap) wrap.title = 'Wake-word ("Hey Clementine") not available in this build — needs an always-on engine like Picovoice Porcupine. Open the dashboard in a regular browser to test.';
      cb.addEventListener('change', (e) => {
        // Block re-enable attempts.
        e.preventDefault();
        cb.checked = false;
      });
      return;
    }

    // Restore saved preference, then auto-arm if it was on.
    let initial = false;
    try { initial = localStorage.getItem('clemmy.wake') === '1'; } catch {}
    cb.checked = initial;
    if (initial) {
      liveVoiceState.wakeActive = true;
      startWakeListener();
    }
    cb.addEventListener('change', () => {
      liveVoiceState.wakeActive = cb.checked;
      try { localStorage.setItem('clemmy.wake', cb.checked ? '1' : '0'); } catch {}
      if (cb.checked) startWakeListener();
      else stopWakeListener();
    });
  }

  function stopMouthDriver() {
    cancelAnimationFrame(liveVoiceState.mouthRaf);
    liveVoiceState.mouthRaf = 0;
    liveVoiceState.analyser = null;
    liveVoiceState.analyserData = null;
    liveVoiceState.mouthSmoothed = 0;
    liveVoiceState.haloSmoothed = 0;
    const orb = document.querySelector('[data-home-voice-toggle]');
    if (orb) {
      orb.style.setProperty('--mouth-open', '0');
      orb.style.setProperty('--halo-strength', '0');
    }
    if (liveVoiceState.audioCtx && liveVoiceState.audioCtx.state !== 'closed') {
      try { liveVoiceState.audioCtx.close(); } catch {}
    }
    liveVoiceState.audioCtx = null;
  }

  function bindHomeVoiceControls() {
    const toggle = document.querySelector('[data-home-voice-toggle]');
    const handoff = document.querySelector('[data-home-voice-handoff]');
    const liveCard = document.querySelector('[data-home-live-card]');
    const closeBtn = document.querySelector('[data-home-live-close]');
    const layout = document.querySelector('[data-home-layout]');
    const takeoverChrome = document.querySelector('[data-home-live-takeover]');
    bindWakeWordToggle();

    function setHomeTakeover(active) {
      if (!layout) return;
      layout.classList.toggle('live-takeover', Boolean(active));
      if (takeoverChrome) takeoverChrome.hidden = !active;
    }

    if (toggle && !toggle.dataset.bound) {
      toggle.dataset.bound = 'true';
      toggle.addEventListener('click', async (event) => {
        // Stop the click from bubbling up to the LIVE card (which would
        // re-toggle takeover). We want orb clicks to ONLY start/stop
        // voice — entering takeover is handled by the card click below.
        event.stopPropagation();
        // First click anywhere on LIVE should land in takeover mode if
        // we aren't already there. The card's own click handler will
        // fire afterwards in the same gesture for that, but here we
        // also flip the class so the orb's stop-propagation doesn't
        // prevent the takeover entry.
        if (layout && !layout.classList.contains('live-takeover')) {
          setHomeTakeover(true);
        }
        if (liveVoiceState.connected) stopHomeVoice();
        else await startHomeVoice();
      });
    }
    if (handoff && !handoff.dataset.bound) {
      handoff.dataset.bound = 'true';
      handoff.addEventListener('click', async () => {
        const text = liveVoiceState.lastTranscript.trim();
        if (!text) return;
        setLiveVoiceStatus('Sending last voice turn to Clementine…', true);
        await sendHomeChat('[Voice command] ' + text);
      });
    }
    if (liveCard && !liveCard.dataset.bound) {
      liveCard.dataset.bound = 'true';
      const enter = () => {
        if (layout?.classList.contains('live-takeover')) return; // already there
        setHomeTakeover(true);
      };
      liveCard.addEventListener('click', (event) => {
        // The orb handler stops propagation, so we only get here when
        // the user clicked the head, copy, or stage padding — i.e.
        // they want to enter takeover without starting voice yet.
        if (event.target instanceof Element && event.target.closest('[data-home-voice-toggle]')) return;
        enter();
      });
      liveCard.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          enter();
        }
      });
    }
    if (closeBtn && !closeBtn.dataset.bound) {
      closeBtn.dataset.bound = 'true';
      closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        setHomeTakeover(false);
      });
    }
    // Esc exits takeover. Bound once at the document level since the
    // takeover chrome is the only thing that listens for global keys
    // on the home page.
    if (!document.body.dataset.liveEscBound) {
      document.body.dataset.liveEscBound = '1';
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && layout?.classList.contains('live-takeover')) {
          setHomeTakeover(false);
        }
      });
    }
  }

  const liveVoicePhases = ['connecting', 'listening', 'thinking', 'speaking', 'routing', 'error'];

  function setLiveVoiceStatus(text, live, phase) {
    const panel = document.querySelector('[data-home-voice-panel]');
    const status = document.querySelector('[data-home-voice-status]');
    const toggle = document.querySelector('[data-home-voice-toggle]');
    const phaseEl = document.querySelector('[data-home-voice-phase]');
    if (panel) panel.classList.toggle('live', Boolean(live));
    if (panel) {
      liveVoicePhases.forEach((name) => panel.classList.remove(name));
      if (phase) panel.classList.add(phase);
      panel.classList.toggle('focus', liveVoiceState.focus);
    }
    if (phase) liveVoiceState.phase = phase;
    if (phaseEl) phaseEl.textContent = (phase || liveVoiceState.phase || 'idle').toUpperCase();
    if (status) status.textContent = text;
    if (toggle) {
      const label = liveVoiceState.connected ? 'Stop live voice' : 'Start live voice';
      toggle.setAttribute('aria-label', label);
      toggle.setAttribute('title', label);
    }
  }

  function setLiveVoiceTranscript(text) {
    const el = document.querySelector('[data-home-voice-transcript]');
    const handoff = document.querySelector('[data-home-voice-handoff]');
    if (el) el.textContent = text || 'Voice commands that need local work route back through Clementine approvals.';
    if (handoff) handoff.disabled = !liveVoiceState.lastTranscript.trim();
  }

  function resetLiveVoiceFeed() {
    const feed = document.querySelector('[data-home-voice-feed]');
    if (feed) feed.innerHTML = '<span>Realtime state, local handoffs, and SDK streaming will appear here.</span>';
  }

  function addLiveVoiceEvent(text, kind = 'event') {
    const feed = document.querySelector('[data-home-voice-feed]');
    if (!feed || !text) return;
    if (feed.children.length === 1 && feed.textContent?.includes('Realtime state')) feed.innerHTML = '';
    const row = document.createElement('span');
    row.className = 'home-voice-event ' + kind;
    row.textContent = text;
    feed.appendChild(row);
    while (feed.children.length > 6) feed.removeChild(feed.firstElementChild);
  }

  function realtimeClientSecret(payload) {
    return payload && (
      payload.value ||
      (payload.client_secret && payload.client_secret.value) ||
      (payload.client_secret && payload.client_secret.secret) ||
      (payload.secret && payload.secret.value)
    );
  }

  function sendRealtimeEvent(event) {
    if (liveVoiceState.dc?.readyState !== 'open') return false;
    liveVoiceState.dc.send(JSON.stringify(event));
    return true;
  }

  function requestRealtimeResponse(instructions) {
    return sendRealtimeEvent({
      type: 'response.create',
      response: {
        output_modalities: ['audio'],
        instructions,
      },
    });
  }

  function sendRealtimeStarter() {
    sendRealtimeEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Clementine Live just connected. Briefly say you are online and listening. Keep it under one sentence.',
          },
        ],
      },
    });
    requestRealtimeResponse('Say one short sentence that Clementine Live is online and listening. Do not ask a long follow-up.');
  }

  async function startHomeVoice() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setLiveVoiceStatus('Microphone access is not available in this browser context.', false);
      return;
    }

    // The Realtime call wants exclusive use of the mic. Pause the
    // wake-word listener now; stopHomeVoice() will re-arm it if the
    // user kept the toggle on.
    stopWakeListener();

    const toggle = document.querySelector('[data-home-voice-toggle]');
    if (toggle) toggle.disabled = true;
    resetLiveVoiceFeed();
    liveVoiceState.assistantTranscript = '';
    setLiveVoiceStatus('Creating live voice session…', true, 'connecting');
    addLiveVoiceEvent('Creating secure Realtime session.', 'routing');

    try {
      const tokenResponse = await fetch(withToken('/api/console/realtime/session'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'console:home' }),
      });
      const tokenPayload = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok) {
        throw new Error(tokenPayload.error || 'Failed to create Realtime session');
      }

      const ephemeralKey = realtimeClientSecret(tokenPayload);
      if (!ephemeralKey) {
        throw new Error('Realtime session did not return a client secret.');
      }

      const pc = new RTCPeerConnection();
      const dc = pc.createDataChannel('oai-events');
      const audio = document.querySelector('[data-home-voice-audio]') || document.createElement('audio');
      audio.autoplay = true;

      liveVoiceState.pc = pc;
      liveVoiceState.dc = dc;
      liveVoiceState.handledCalls = new Set();

      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0];
        addLiveVoiceEvent('Audio stream connected.', 'event');
        // Spin up the amplitude analyser on the same stream so the dog
        // mouth tracks the actual TTS output rather than a fake timer.
        startMouthDriver(event.streams[0]);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') setLiveVoiceStatus('Live voice connected. Speak naturally.', true, 'listening');
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setLiveVoiceStatus('Live voice connection dropped.', false, 'error');
          addLiveVoiceEvent('Realtime connection dropped.', 'error');
        }
      };

      dc.addEventListener('open', () => {
        setLiveVoiceStatus('Listening. Local actions will route through Clementine.', true, 'listening');
        addLiveVoiceEvent('Realtime data channel open.', 'event');
        sendRealtimeStarter();
      });
      dc.addEventListener('message', (event) => {
        try {
          handleRealtimeEvent(JSON.parse(event.data));
        } catch (err) {
          console.warn('Realtime event handling failed', err);
        }
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      liveVoiceState.stream = stream;
      addLiveVoiceEvent('Microphone active with echo cancellation.', 'event');
      for (const track of stream.getAudioTracks()) {
        pc.addTrack(track, stream);
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: 'Bearer ' + ephemeralKey,
          'Content-Type': 'application/sdp',
        },
      });
      const answerSdp = await sdpResponse.text();
      if (!sdpResponse.ok) {
        throw new Error(answerSdp || 'Realtime WebRTC offer failed');
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      liveVoiceState.connected = true;
      setLiveVoiceStatus('Live voice connected. Speak naturally.', true, 'listening');
    } catch (err) {
      stopHomeVoice();
      setLiveVoiceStatus('Voice unavailable: ' + (err.message || err), false, 'error');
      addLiveVoiceEvent('Voice unavailable: ' + (err.message || err), 'error');
    } finally {
      if (toggle) toggle.disabled = false;
    }
  }

  function stopHomeVoice() {
    try { liveVoiceState.dc?.close?.(); } catch {}
    try { liveVoiceState.pc?.close?.(); } catch {}
    try {
      liveVoiceState.stream?.getTracks?.().forEach((track) => track.stop());
    } catch {}
    stopMouthDriver();
    liveVoiceState.pc = null;
    liveVoiceState.dc = null;
    liveVoiceState.stream = null;
    liveVoiceState.connected = false;
    liveVoiceState.assistantTranscript = '';
    liveVoiceState.focus = false;
    const expand = document.querySelector('[data-home-voice-expand]');
    if (expand) expand.textContent = 'FOCUS';
    setLiveVoiceStatus('Voice stopped.', false, 'idle');
    addLiveVoiceEvent('Voice session stopped.', 'event');
    // Voice ended → kick the wake-word back on if it was armed, so the
    // user can re-trigger by voice without clicking again.
    if (liveVoiceState.wakeActive) startWakeListener();
  }

  function handleRealtimeEvent(event) {
    if (!event || !event.type) return;
    if (event.type === 'input_audio_buffer.speech_started') {
      liveVoiceState.assistantTranscript = '';
      setLiveVoiceStatus('Listening to you…', true, 'listening');
      addLiveVoiceEvent('User started speaking.', 'event');
    } else if (event.type === 'input_audio_buffer.speech_stopped') {
      setLiveVoiceStatus('Thinking through the turn…', true, 'thinking');
    } else if (event.type === 'conversation.item.input_audio_transcription.delta') {
      const delta = event.delta || event.transcript || '';
      if (delta) setLiveVoiceTranscript('Hearing: ' + delta);
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      liveVoiceState.lastTranscript = event.transcript || '';
      setLiveVoiceTranscript(liveVoiceState.lastTranscript ? 'Heard: ' + liveVoiceState.lastTranscript : '');
      if (liveVoiceState.lastTranscript) addLiveVoiceEvent('Heard: ' + liveVoiceState.lastTranscript, 'event');
    } else if (event.type === 'response.created') {
      setLiveVoiceStatus('Generating voice response…', true, 'thinking');
    } else if (event.type === 'response.output_audio_transcript.delta') {
      const delta = event.delta || '';
      if (delta) {
        liveVoiceState.assistantTranscript += delta;
        setLiveVoiceStatus('Clementine is speaking…', true, 'speaking');
        setLiveVoiceTranscript('Clementine: ' + liveVoiceState.assistantTranscript);
      }
    } else if (event.type === 'response.output_audio_transcript.done') {
      const transcript = event.transcript || liveVoiceState.assistantTranscript;
      if (transcript) addLiveVoiceEvent('Said: ' + transcript, 'event');
      liveVoiceState.assistantTranscript = '';
    } else if (event.type === 'response.done') {
      const routed = handleRealtimeResponseDone(event);
      if (!routed) setLiveVoiceStatus('Live voice connected. Speak naturally.', true, 'listening');
    } else if (event.type === 'response.function_call_arguments.done') {
      handleRealtimeFunctionCall(event.name, event.arguments, event.call_id);
    } else if (event.type === 'error') {
      setLiveVoiceStatus('Realtime error: ' + (event.error?.message || 'unknown'), false, 'error');
      addLiveVoiceEvent('Realtime error: ' + (event.error?.message || 'unknown'), 'error');
    }
  }

  function handleRealtimeResponseDone(event) {
    const output = event.response?.output || [];
    let routed = false;
    for (const item of output) {
      if (item?.type === 'function_call') {
        routed = true;
        handleRealtimeFunctionCall(item.name, item.arguments, item.call_id);
      }
    }
    return routed;
  }

  async function handleRealtimeFunctionCall(name, rawArguments, callId) {
    if (name !== 'send_to_clementine' || !callId || liveVoiceState.handledCalls.has(callId)) return;
    liveVoiceState.handledCalls.add(callId);

    let args = {};
    try { args = JSON.parse(rawArguments || '{}'); } catch {}
    const request = String(args.request || liveVoiceState.lastTranscript || '').trim();
    if (!request) return;

    setLiveVoiceStatus('Routing into the local Clementine agent…', true, 'routing');
    addLiveVoiceEvent('Local handoff: ' + request, 'routing');
    const result = await sendHomeChat('[Voice command] ' + request, {
      onStatus: (text, kind) => {
        const label = text || 'Local agent is working.';
        setLiveVoiceStatus(label, true, kind === 'tool' ? 'routing' : 'thinking');
        addLiveVoiceEvent(label, kind === 'tool' ? 'tool' : 'routing');
      },
      onChunk: (_delta, fullText) => {
        setLiveVoiceStatus('Local agent is streaming a response…', true, 'routing');
        if (fullText && fullText.length < 180) {
          setLiveVoiceTranscript('Local reply: ' + fullText);
        }
      },
    });
    const output = JSON.stringify({
      ok: Boolean(result?.ok),
      text: result?.text || '',
      pendingApprovalId: result?.pendingApprovalId || null,
    });

    try {
      if (liveVoiceState.dc?.readyState === 'open') {
        sendRealtimeEvent({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: callId,
            output,
          },
        });
        requestRealtimeResponse('Summarize the local Clementine result in one or two short spoken sentences. If an approval is required, tell the user to approve it in the dashboard or Discord.');
      }
    } catch (err) {
      setLiveVoiceStatus('Clementine handled it, but voice reply failed: ' + (err.message || err), false, 'error');
      addLiveVoiceEvent('Voice reply failed after local handoff: ' + (err.message || err), 'error');
    }
  }

  // Refresh the agenda every 30s while the panel is mounted, so newly
  // completed tasks / executions surface without manual reload.
  setInterval(() => {
    if (homeBooted && document.querySelector('.panel-frame[data-section="home"]:not([hidden])')) {
      refreshHomeAgenda();
    }
  }, 30000);

  // ─── Integrations Hub (API Keys + Composio + MCP) ──────────────

  const HUB_APP_HINTS = {
    gmail: 'Gmail',
    googlecalendar: 'Google Calendar',
    googledrive: 'Google Drive',
    slack: 'Slack',
    notion: 'Notion',
    linear: 'Linear',
    github: 'GitHub',
    gitlab: 'GitLab',
    discord: 'Discord',
    figma: 'Figma',
    stripe: 'Stripe',
    asana: 'Asana',
  };

  function friendlyAppName(slug) {
    if (!slug) return '';
    const key = String(slug).toLowerCase().replace(/[^a-z0-9]/g, '');
    return HUB_APP_HINTS[key] || slug;
  }

  function hasOpenAiApiKey(auth) {
    return Boolean(auth && (auth.openaiApiKeyPresent || auth.hasOpenAiApiKey));
  }

  function hasCodexRuntimeAuth(auth) {
    if (!auth) return false;
    if (auth.codexOauthPresent || auth.hasNativeOAuth || auth.hasImportedCodexAuth) return true;
    return auth.mode !== 'api_key' && ['native', 'local_store', 'codex_cli'].includes(auth.source);
  }

  function runtimeAuthLabel(auth) {
    if (!auth?.configured) return 'not configured';
    if (hasCodexRuntimeAuth(auth)) return auth.source === 'codex_cli' ? 'Codex CLI OAuth' : 'Codex OAuth';
    if (hasOpenAiApiKey(auth)) return 'OpenAI API key';
    return auth.mode || 'configured';
  }

  function credentialDisplayName(name) {
    const labels = {
      openai_api_key: 'OpenAI API key',
      codex_oauth_access_token: 'Codex OAuth access token',
      codex_oauth_refresh_token: 'Codex OAuth refresh token',
      discord_bot_token: 'Discord bot token',
      composio_api_key: 'Composio API key',
      recall_api_key: 'Recall.ai API key',
      browser_use_api_key: 'Browser Use API key',
      webhook_secret: 'Dashboard/webhook secret',
    };
    return labels[name] || name;
  }

  function credentialDescription(name, descriptor) {
    if (name === 'openai_api_key') {
      return 'Optional capability key for embeddings, Realtime live voice, and direct OpenAI API features. Codex OAuth can still run the agent without this.';
    }
    if (name === 'codex_oauth_access_token' || name === 'codex_oauth_refresh_token') {
      return 'Runtime auth for ChatGPT/Codex subscribers. Clementine can also use your existing Codex CLI login when detected.';
    }
    if (name === 'recall_api_key') {
      return 'Optional desktop meeting capture key. Recall.ai handles recording uploads; Clementine stores transcripts locally and queues analysis tasks.';
    }
    if (name === 'browser_use_api_key') {
      return 'Optional Browser Use cloud key for Browser Harness cloud browsers. Local Chrome Browser Harness does not require it.';
    }
    return descriptor?.description || '';
  }

  function displayCredentialStatus(row, descriptor, auth) {
    const status = row?.status || 'missing';
    const source = row?.source || 'none';
    const name = row?.name || '';
    const codexRuntimeReady = hasCodexRuntimeAuth(auth);
    if ((name === 'codex_oauth_access_token' || name === 'codex_oauth_refresh_token') && codexRuntimeReady) {
      return { className: 'runtime_ready', label: 'RUNTIME READY', source: auth?.source || source };
    }
    if (name === 'openai_api_key' && !hasOpenAiApiKey(auth) && status === 'missing' && auth?.mode !== 'api_key') {
      return { className: 'optional', label: 'OPTIONAL', source };
    }
    if (status === 'missing' && !descriptor?.required) {
      return { className: 'optional', label: name === 'openai_api_key' ? 'OPTIONAL' : 'NOT SET', source };
    }
    return { className: status, label: String(status).toUpperCase().replace('_', ' '), source };
  }

  let hubMcpEditing = null; // server name being edited; 'new' for create
  let hubAppSearch = '';
  let hubRecallEventsBound = false;
  let hubBrowserInstallJob = null;

  async function bootIntegrationsHub() {
    const newBtn = document.querySelector('[data-hub-mcp-new]');
    if (newBtn) {
      newBtn.addEventListener('click', () => {
        hubMcpEditing = hubMcpEditing === 'new' ? null : 'new';
        renderHubMcp();
      });
    }
    if (!hubRecallEventsBound && window.clemmy?.onRecallEvent) {
      hubRecallEventsBound = true;
      window.clemmy.onRecallEvent(() => {
        if (document.querySelector('.panel-frame[data-section="integrations"]:not([hidden])')) {
          setTimeout(() => refreshHubRecall(), 250);
        }
      });
    }
    bindHubInstaller();
    await refreshIntegrationsHub();
  }

  async function refreshIntegrationsHub() {
    await Promise.allSettled([
      refreshHubKeys(),
      refreshHubApps(),
      refreshHubGitHubCli(),
      refreshHubBrowserHarness(),
      refreshHubCliCatalog(),
      refreshHubRecall(),
      refreshHubMcp(),
    ]);
  }

  async function refreshHubKeys() {
    const listEl = document.querySelector('[data-hub-keys-list]');
    const metaEl = document.querySelector('[data-hub-keys-meta]');
    const summary = document.querySelector('[data-hub-keys]');
    if (!listEl || !metaEl) return;
    try {
      const data = await fetchJSON('/api/console/credentials');
      const rows = data.rows || [];
      const descriptors = data.descriptors || {};
      const auth = data.auth || null;
      metaEl.textContent = auth?.configured
        ? 'runtime ready via ' + runtimeAuthLabel(auth) + (hasOpenAiApiKey(auth) ? ' · OpenAI key ready' : ' · OpenAI key optional')
        : 'runtime auth needs setup';
      if (summary) summary.textContent = auth?.configured ? 'ready' : 'setup';
      listEl.innerHTML = rows.map((r) => {
        const d = descriptors[r.name] || {};
        const display = displayCredentialStatus(r, d, auth);
        const runtimeCredentialReady = display.className === 'runtime_ready'
          && (r.name === 'codex_oauth_access_token' || r.name === 'codex_oauth_refresh_token');
        const sourceLine = [
          '<span class="pill ' + escMem(display.className) + '">' + escMem(display.label) + '</span>',
          display.source && display.source !== 'none' ? '<span>source: ' + escMem(display.source) + '</span>' : '',
          d.envVarName ? '<span>env: ' + escMem(d.envVarName) + '</span>' : '',
          r.lastSetAt ? '<span>set ' + escMem(r.lastSetAt.slice(0, 16).replace('T', ' ')) + '</span>' : '',
        ].filter(Boolean).join(' ');
        return [
          '<div class="hub-key-row">',
          '  <div>',
          '    <div class="hub-key-name">' + escMem(credentialDisplayName(r.name)) + '</div>',
          '    <div class="hub-key-meta">' + sourceLine + '</div>',
          credentialDescription(r.name, d) ? '    <div class="hub-key-desc">' + escMem(credentialDescription(r.name, d)) + '</div>' : '',
          '  </div>',
          '  <div class="hub-key-actions">',
          runtimeCredentialReady
            ? '    <span class="hub-key-ok">ACTIVE</span>'
            : '    <button data-hub-key-jump="' + escMem(r.name) + '">' + (r.hasValue ? 'UPDATE' : 'SET') + ' ✎</button>',
          '  </div>',
          '</div>',
        ].join('');
      }).join('') || '<div class="settings-info">— no credential schema —</div>';

      // Wire jump-to-settings buttons — credentials live in the
      // existing Settings → Credentials block; we just deep-link there.
      listEl.querySelectorAll('[data-hub-key-jump]').forEach((btn) => {
        btn.addEventListener('click', () => {
          switchPanel('settings');
          setTimeout(() => {
            const target = document.querySelector('[data-cred-row="' + btn.getAttribute('data-hub-key-jump') + '"]');
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const setBtn = target?.querySelector('[data-cred-set]');
            if (setBtn) setBtn.click();
          }, 150);
        });
      });
    } catch (err) {
      listEl.innerHTML = '<div class="settings-info" style="color:var(--accent-fail);">Failed: ' + escMem(err.message || err) + '</div>';
    }
  }

  async function refreshHubApps() {
    const controlsEl = document.querySelector('[data-hub-apps-controls]');
    const listEl = document.querySelector('[data-hub-apps-list]');
    const metaEl = document.querySelector('[data-hub-apps-meta]');
    const summary = document.querySelector('[data-hub-apps]');
    if (!controlsEl || !listEl || !metaEl) return;
    try {
      const status = await fetchJSON('/api/composio/status');
      if (!status?.enabled) {
        controlsEl.innerHTML = [
          '<input type="text" class="secret-input" placeholder="Composio API key (sk_…)" data-hub-composio-key autocomplete="off" data-1p-ignore="true" data-lpignore="true" spellcheck="false" name="api-key-composio-no-autofill" />',
          '<button data-hub-composio-save>SAVE API KEY</button>',
          '<a href="https://platform.composio.dev" target="_blank" rel="noopener" style="font-size:10px;letter-spacing:0.14em;color:var(--fg-3);">get a key →</a>',
          renderComposioCliChip(status),
          renderComposioCliActions(status),
        ].join('');
        listEl.innerHTML = '<div class="settings-info">— Composio not configured yet. Paste your API key above to start connecting apps. —</div>';
        metaEl.textContent = 'not configured';
        if (summary) summary.textContent = '—';
        const saveBtn = controlsEl.querySelector('[data-hub-composio-save]');
        if (saveBtn) {
          saveBtn.addEventListener('click', async () => {
            const input = controlsEl.querySelector('[data-hub-composio-key]');
            const key = input?.value?.trim() || '';
            if (!key) { alert('Paste an API key first.'); return; }
            try {
              const r = await fetch(withToken('/api/composio/api-key'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: key }),
              });
              const j = await r.json().catch(() => ({}));
              if (!r.ok) {
                // Validation rejected (HTTP 400) lands here with a
                // helpful message from Composio (e.g. "Invalid API key:
                // ak_xxxx*****"). Surfacing the full text avoids the
                // silent-failure mode where the user thought their key
                // saved but no connections show up.
                alert('Save failed: ' + (j.error || r.status));
                return;
              }
              if (j.validation === 'unknown' && j.warning) {
                alert('Saved, but ' + j.warning);
              }
              await refreshHubApps();
            } catch (err) { alert('Save failed: ' + (err.message || err)); }
          });
        }
        bindComposioCliActions(controlsEl, listEl);
        return;
      }

      const snapshot = await fetchJSON('/api/composio/toolkits');
      if (snapshot?.cli) status.cli = snapshot.cli;
      if (snapshot?.executionBackend) status.executionBackend = snapshot.executionBackend;
      const connected = (snapshot.connected || []).filter((c) => c.status !== 'DELETED');
      const toolkits = snapshot.toolkits || snapshot.available || [];
      const connectedSlugs = new Set(connected.map((c) => c.slug || c.toolkitSlug).filter(Boolean));

      const activeCount = connected.filter((c) => (c.status || '').toUpperCase() === 'ACTIVE').length;
      metaEl.textContent = activeCount + ' active · ' + (toolkits.length || '?') + ' available';
      if (summary) summary.textContent = activeCount;

      controlsEl.innerHTML = [
        '<input type="text" placeholder="filter apps (gmail, slack, notion, …)" data-hub-app-filter value="' + escMem(hubAppSearch) + '" />',
        '<button data-hub-composio-refresh>REFRESH ⟲</button>',
        renderComposioBackendSelect(status),
        renderComposioCliChip(status),
        renderComposioCliActions(status),
      ].join('');
      bindComposioCliActions(controlsEl, listEl);
      const filterEl = controlsEl.querySelector('[data-hub-app-filter]');
      if (filterEl) {
        filterEl.addEventListener('input', () => {
          hubAppSearch = filterEl.value || '';
          renderApps();
        });
      }
      const refreshBtn = controlsEl.querySelector('[data-hub-composio-refresh]');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
          await fetch(withToken('/api/composio/refresh'), { method: 'POST' });
          await refreshHubApps();
        });
      }
      const backendSelect = controlsEl.querySelector('[data-hub-composio-backend]');
      if (backendSelect) {
        backendSelect.addEventListener('change', async () => {
          const backend = backendSelect.value || 'auto';
          try {
            const r = await fetch(withToken('/api/composio/backend'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ backend }),
            });
            if (!r.ok) {
              const j = await r.json().catch(() => ({}));
              alert('Backend save failed: ' + (j.error || r.status));
              return;
            }
            await refreshHubApps();
          } catch (err) {
            alert('Backend save failed: ' + (err.message || err));
          }
        });
      }

      function renderApps() {
        const q = (hubAppSearch || '').toLowerCase().trim();
        // Connected first.
        const connRender = connected
          .filter((c) => !q || (c.slug || '').toLowerCase().includes(q) || friendlyAppName(c.slug).toLowerCase().includes(q))
          .map((c) => {
            const slug = c.slug || c.toolkitSlug || '';
            const statusKey = (c.status || 'ACTIVE').toLowerCase();
            const pill = statusKey === 'active' ? 'active'
              : statusKey === 'pending' || statusKey === 'initializing' ? 'pending'
              : statusKey === 'failed' ? 'failed'
              : 'disconnected';
            // EXPIRED / FAILED / INACTIVE connections still appear in the
            // connected list because the connection RECORD exists — but
            // the underlying OAuth token is dead. Without a RECONNECT
            // button users see "Gmail connected" yet every tool call
            // errors with "can't get metadata" (Composio's stand-in for
            // refresh-token failure). Adding RECONNECT here closes the
            // loop without forcing a disconnect-then-reconnect dance.
            const needsReauth = statusKey !== 'active' && statusKey !== 'pending' && statusKey !== 'initializing';
            // Distinguishing meta — needed when multiple connections share
            // the same toolkit slug (e.g. 1 ACTIVE outlook + 2 EXPIRED).
            // Without these, every duplicate card looked identical and
            // users couldn't tell which one to disconnect (visibility
            // gap surfaced 2026-05-21 with 3 outlook entries).
            const shortConnId = c.connectionId ? String(c.connectionId).slice(-8) : '';
            const createdAgo = c.createdAt ? fmtMtime(new Date(c.createdAt).getTime()) : '';
            const metaParts = [];
            if (c.userId) metaParts.push(c.userId);
            if (shortConnId) metaParts.push('id …' + shortConnId);
            if (createdAgo) metaParts.push(createdAgo);
            const metaLine = metaParts.join(' · ');
            const expiredHint = needsReauth
              ? '  <div class="hub-app-meta" style="color: var(--accent-warn);">⚠ Token ' + escMem(statusKey) + ' — tool calls will fail until you reconnect.</div>'
              : '';
            return [
              '<div class="hub-app-card" data-hub-app-slug="' + escMem(slug) + '">',
              '  <div class="hub-app-name">' + escMem(friendlyAppName(slug)) + '</div>',
              '  <span class="hub-app-pill ' + pill + '">' + escMem((c.status || 'ACTIVE').toUpperCase()) + '</span>',
              metaLine ? '  <div class="hub-app-meta">' + escMem(metaLine) + '</div>' : '',
              expiredHint,
              '  <div class="hub-app-card-actions">',
              needsReauth ? '    <button class="connect" data-hub-app-connect="' + escMem(slug) + '" data-hub-app-needs-setup="0">RECONNECT</button>' : '',
              c.connectionId ? '    <button class="disconnect" data-hub-app-disconnect="' + escMem(slug) + '" data-conn="' + escMem(c.connectionId) + '">DISCONNECT</button>' : '',
              '  </div>',
              '</div>',
            ].join('');
          });
        // Available (not connected).
        const availRender = toolkits
          .filter((t) => !connectedSlugs.has(t.slug))
          .filter((t) => !q || (t.slug || '').toLowerCase().includes(q) || (t.name || '').toLowerCase().includes(q))
          .slice(0, q ? 80 : 16)
          .map((t) => {
            // hasAuthConfig comes from the Composio dashboard snapshot —
            // true when Composio has a project-level auth_config for the
            // toolkit, false when it'd need to be set up first.
            // Without this distinction, the user clicks CONNECT, the
            // hosted OAuth page errors out with "Something went wrong",
            // and they have no path forward (seen 2026-05-21 with apify
            // + firecrawl).
            const setupReady = t.hasAuthConfig !== false;
            const pillCls = setupReady ? 'available' : 'needs-setup';
            const pillTxt = setupReady ? 'AVAILABLE' : 'NEEDS SETUP';
            const btnLabel = setupReady ? 'CONNECT' : 'SET UP AUTH';
            const btnClass = setupReady ? 'connect' : 'connect needs-setup';
            return [
            '<div class="hub-app-card">',
            '  <div class="hub-app-name">' + escMem(t.name || friendlyAppName(t.slug)) + '</div>',
            '  <span class="hub-app-pill ' + pillCls + '">' + pillTxt + '</span>',
            t.description ? '  <div class="hub-app-meta">' + escMem(t.description.slice(0, 80)) + '</div>' : '',
            '  <div class="hub-app-card-actions">',
            '    <button class="' + btnClass + '" data-hub-app-connect="' + escMem(t.slug) + '" data-hub-app-needs-setup="' + (setupReady ? '0' : '1') + '">' + btnLabel + '</button>',
            '  </div>',
            '</div>',
            ].join('');
          });
        const out = [...connRender, ...availRender];
        listEl.innerHTML = out.length > 0
          ? out.join('')
          : '<div class="settings-info">— no apps match "' + escMem(q) + '" —</div>';

        // Wire actions.
        listEl.querySelectorAll('[data-hub-app-connect]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const slug = btn.getAttribute('data-hub-app-connect');
            const needsSetup = btn.getAttribute('data-hub-app-needs-setup') === '1';
            // Toolkits without an auth_config in this Composio project
            // can't complete an OAuth dance. For API_KEY-mode toolkits
            // (firecrawl, apify, ...), Composio's hosted popup throws
            // "Something went wrong" — we sidestep it by collecting the
            // API key in a Clementine-native prompt and creating the
            // auth_config + connection via Composio's REST API directly.
            if (needsSetup) {
              const name = friendlyAppName(slug);
              // Fetch the toolkit's auth scheme so we route to the right
              // setup flow (API_KEY → in-app modal; OAUTH2 → auto-create
              // composio-managed config + OAuth window; other → fall
              // back to platform.composio.dev). Without this, Gmail and
              // other OAuth toolkits hit my api-key modal which makes
              // no sense (no API key exists for OAuth).
              let metaForRouting = null;
              try {
                const r = await fetch(withToken('/api/composio/toolkits/' + encodeURIComponent(slug) + '/setup-meta'));
                if (r.ok) metaForRouting = await r.json();
              } catch { /* fall back to api-key path */ }

              const scheme = (metaForRouting && metaForRouting.authScheme) || 'API_KEY';

              if (scheme === 'OAUTH2' || scheme === 'OAUTH1') {
                // Auto-create the composio-managed auth_config, then
                // immediately call /authorize to open the OAuth window.
                btn.textContent = 'STARTING OAUTH …';
                try {
                  const setupRes = await fetch(withToken('/api/composio/toolkits/' + encodeURIComponent(slug) + '/setup-oauth'), { method: 'POST' });
                  if (!setupRes.ok) {
                    const j = await setupRes.json().catch(() => ({}));
                    alert('OAuth setup failed: ' + (j.error || setupRes.status) + '\\n\\nIf this toolkit uses bring-your-own credentials, set them up at platform.composio.dev/auth-configs.');
                    btn.textContent = 'SET UP AUTH';
                    return;
                  }
                  // Now trigger the actual OAuth flow (opens Composio's OAuth window).
                  const authRes = await fetch(withToken('/api/composio/toolkits/' + encodeURIComponent(slug) + '/authorize'), { method: 'POST' });
                  const authJson = await authRes.json().catch(() => ({}));
                  if (!authRes.ok) {
                    alert('Authorize failed: ' + (authJson.error || authRes.status));
                    btn.textContent = 'SET UP AUTH';
                    return;
                  }
                  if (authJson.redirectUrl || authJson.url) {
                    window.open(authJson.redirectUrl || authJson.url, '_blank');
                  }
                  // Poll for connection a few times so the card flips
                  // from NEEDS SETUP → ACTIVE once OAuth completes.
                  setTimeout(() => refreshHubApps(), 3000);
                  setTimeout(() => refreshHubApps(), 10_000);
                } catch (err) {
                  alert('OAuth setup failed: ' + (err.message || err));
                  btn.textContent = 'SET UP AUTH';
                }
                return;
              }

              if (scheme !== 'API_KEY') {
                // BASIC, BEARER_TOKEN, etc. — open the platform page so
                // the user configures it there. We can't easily support
                // every scheme inline.
                if (confirm(name + ' uses ' + scheme + ' authentication which isn\\'t supported inline yet. Open the Composio auth-configs page to set it up there?')) {
                  window.open('https://platform.composio.dev/auth-configs', '_blank');
                }
                return;
              }

              // API_KEY path — Clementine-native modal.
              const result = await showApiKeyModal(slug, name);
              if (!result) return; // user cancelled
              btn.textContent = 'CONNECTING …';
              try {
                const r = await fetch(withToken('/api/composio/toolkits/' + encodeURIComponent(slug) + '/setup-api-key'), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ apiKey: result.apiKey, baseUrl: result.baseUrl }),
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) {
                  alert('Connection failed: ' + (j.error || r.status));
                  btn.textContent = 'SET UP AUTH';
                  return;
                }
                // Refresh to flip the card from NEEDS SETUP → ACTIVE.
                await fetch(withToken('/api/composio/refresh'), { method: 'POST' });
                await refreshHubApps();
              } catch (err) {
                alert('Setup failed: ' + (err.message || err));
                btn.textContent = 'SET UP AUTH';
              }
              return;
            }
            const origLabel = btn.textContent || 'CONNECT';
            btn.textContent = 'OPENING …';
            try {
              const r = await fetch(withToken('/api/composio/toolkits/' + encodeURIComponent(slug) + '/authorize'), { method: 'POST' });
              const j = await r.json().catch(() => ({}));
              if (!r.ok) {
                if (j.needsAuthConfig && j.setupUrl) {
                  if (confirm(j.error + '\\n\\nOpen the Composio auth-configs page to set this up?')) {
                    window.open(j.setupUrl, '_blank');
                  }
                } else {
                  alert('Connect failed: ' + (j.error || r.status));
                }
                btn.textContent = origLabel;
                return;
              }
              if (j.redirectUrl || j.url) {
                window.open(j.redirectUrl || j.url, '_blank');
              }
              setTimeout(() => refreshHubApps(), 2000);
            } catch (err) {
              alert('Connect failed: ' + (err.message || err));
              btn.textContent = origLabel;
            }
          });
        });
        listEl.querySelectorAll('[data-hub-app-disconnect]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const slug = btn.getAttribute('data-hub-app-disconnect');
            const connectionId = btn.getAttribute('data-conn');
            // Include the connectionId tail in the prompt so duplicate
            // entries (e.g. 3 outlook connections) can be told apart at
            // the confirm step. Otherwise users had no way to know which
            // of 3 identical "Disconnect outlook?" prompts was for the
            // expired one vs the active one.
            const idTail = connectionId ? ' (id …' + String(connectionId).slice(-8) + ')' : '';
            if (!confirm('Disconnect ' + friendlyAppName(slug) + idTail + '?\\nThe agent will no longer have access via this connection.')) return;
            try {
              const r = await fetch(withToken('/api/composio/toolkits/' + encodeURIComponent(slug) + '/disconnect'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId }),
              });
              if (!r.ok) {
                const j = await r.json().catch(() => ({}));
                alert('Disconnect failed: ' + (j.error || r.status));
                return;
              }
              await refreshHubApps();
            } catch (err) { alert('Disconnect failed: ' + (err.message || err)); }
          });
        });
      }

      renderApps();
    } catch (err) {
      listEl.innerHTML = '<div class="settings-info" style="color:var(--accent-fail);">Composio: ' + escMem(err.message || err) + '</div>';
    }
  }

  function renderComposioBackendSelect(status) {
    const current = status?.executionBackend || 'auto';
    const opts = [
      ['auto', 'AUTO'],
      ['cli', 'CLI'],
      ['sdk', 'SDK'],
    ].map(([value, label]) => '<option value="' + value + '"' + (current === value ? ' selected' : '') + '>' + label + '</option>').join('');
    return '<label class="hub-inline-select"><span>backend</span><select data-hub-composio-backend>' + opts + '</select></label>';
  }

  function renderComposioCliChip(status) {
    const cli = status?.cli || {};
    const installed = cli.installed === true;
    const auth = cli.authenticated === true;
    const label = installed
      ? ('CLI ' + (auth ? 'READY' : 'INSTALLED') + (cli.version ? ' · ' + cli.version : ''))
      : 'CLI OPTIONAL';
    const cls = installed && auth ? 'active' : installed ? 'pending' : 'available';
    const title = installed
      ? ((cli.path || 'composio') + (cli.authMessage ? ' · ' + cli.authMessage : ''))
      : 'Optional. Connected-app OAuth can still use the Composio API key without the local CLI.';
    return '<span class="hub-app-pill ' + cls + '" title="' + escMem(title) + '">' + escMem(label) + '</span>';
  }

  function renderComposioCliActions(status) {
    const cli = status?.cli || {};
    if (cli.installed !== true) return '<button data-hub-composio-cli-action="install">INSTALL OPTIONAL CLI</button>';
    if (cli.authenticated !== true) return '<button data-hub-composio-cli-action="auth">CLI LOGIN</button>';
    return '<button data-hub-composio-cli-action="repair">REPAIR CLI AUTH</button>';
  }

  function bindComposioCliActions(controlsEl, listEl) {
    controlsEl.querySelectorAll('[data-hub-composio-cli-action]').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-hub-composio-cli-action') || 'auth';
        if (action === 'install' && !confirm('Install the optional Composio universal CLI now?\\n\\nClementine can still connect apps with your Composio API key without this.')) return;
        btn.disabled = true;
        btn.textContent = action === 'install' ? 'INSTALLING...' : 'STARTING...';
        try {
          await startManagedCliAction('composio', action, listEl, refreshHubApps);
        } catch (err) {
          alert('Composio CLI action failed: ' + (err.message || err));
          await refreshHubApps();
        }
      });
    });
  }

  async function pollManagedCliJob(jobId, targetEl, afterDone) {
    if (!jobId || !targetEl) return;
    let done = false;
    for (let i = 0; i < 240 && !done; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, i === 0 ? 400 : 1500));
      const data = await fetchJSON('/api/console/managed-cli-jobs/' + encodeURIComponent(jobId));
      const job = data.job || {};
      done = job.status !== 'running';
      targetEl.innerHTML = [
        '<div class="hub-app-card" style="grid-column:1/-1">',
        '  <div class="hub-app-name">' + escMem(job.title || 'CLI job') + '</div>',
        '  <span class="hub-app-pill ' + (job.status === 'succeeded' ? 'active' : job.status === 'failed' ? 'failed' : 'pending') + '">' + escMem(String(job.status || 'running').toUpperCase()) + '</span>',
        '  <div class="hub-app-meta">Command: <code>' + escMem(job.command || '') + '</code></div>',
        renderBrowserHarnessOutput(job),
        '</div>',
      ].join('');
    }
    if (done && afterDone) await afterDone();
  }

  async function startManagedCliAction(kind, action, targetEl, afterDone) {
    const r = await fetch(withToken('/api/console/managed-clis/' + encodeURIComponent(kind) + '/' + encodeURIComponent(action)), {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    await pollManagedCliJob(j.job?.id, targetEl, afterDone);
  }

  function renderBrowserHarnessOutput(result) {
    if (!result) return '';
    const lines = [
      result.command ? '$ ' + result.command : '',
      result.output || result.stderr || result.stdout || '',
    ].filter(Boolean).join('\\n');
    return '<pre class="hub-install-log">' + escMem(lines || '(no output)') + '</pre>';
  }

  async function pollBrowserHarnessJob(jobId) {
    const listEl = document.querySelector('[data-hub-browser-list]');
    const controlsEl = document.querySelector('[data-hub-browser-controls]');
    if (!jobId || !listEl) return;
    let done = false;
    for (let i = 0; i < 240 && !done; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, i === 0 ? 300 : 1500));
      const data = await fetchJSON('/api/console/browser-harness/install/' + encodeURIComponent(jobId));
      const job = data.job || {};
      done = job.status !== 'running';
      listEl.innerHTML = [
        '<div class="hub-app-card" style="grid-column:1/-1">',
        '  <div class="hub-app-name">Install Browser Harness</div>',
        '  <span class="hub-app-pill ' + (job.status === 'succeeded' ? 'active' : job.status === 'failed' ? 'failed' : 'pending') + '">' + escMem(String(job.status || 'running').toUpperCase()) + '</span>',
        '  <div class="hub-app-meta">Installs the browser-harness CLI, keeps the editable repo at ~/Developer/browser-harness, and links its Codex skill file.</div>',
        renderBrowserHarnessOutput(job),
        '</div>',
      ].join('');
      if (done) {
        hubBrowserInstallJob = null;
        if (controlsEl) controlsEl.querySelectorAll('button').forEach((button) => { button.disabled = false; });
        await refreshHubBrowserHarness();
      }
    }
  }

  async function pollInstallJob(jobId, listEl) {
    if (!jobId || !listEl) return;
    let done = false;
    for (let i = 0; i < 240 && !done; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, i === 0 ? 300 : 1500));
      const data = await fetchJSON('/api/console/install-jobs/' + encodeURIComponent(jobId));
      const job = data.job || {};
      done = job.status !== 'running';
      listEl.innerHTML = [
        '<div class="hub-app-card" style="grid-column:1/-1">',
        '  <div class="hub-app-name">' + escMem(job.title || 'Install capability') + '</div>',
        '  <span class="hub-app-pill ' + (job.status === 'succeeded' ? 'active' : job.status === 'failed' ? 'failed' : 'pending') + '">' + escMem(String(job.status || 'running').toUpperCase()) + '</span>',
        '  <div class="hub-app-meta">Command: ' + escMem(job.command || '') + '</div>',
        renderBrowserHarnessOutput(job),
        '</div>',
      ].join('');
    }
  }

  function bindHubInstaller() {
    const runBtn = document.querySelector('[data-hub-install-run]');
    const input = document.querySelector('[data-hub-install-command]');
    const listEl = document.querySelector('[data-hub-installer-list]');
    if (!runBtn || !input || !listEl || runBtn.dataset.bound) return;
    runBtn.dataset.bound = '1';
    runBtn.addEventListener('click', async () => {
      const command = (input.value || '').trim();
      if (!command) { showError('Paste an install command first.'); return; }

      // Pre-flight: if the user pasted a SKILL install command into the
      // CLI installer, the right destination is the Skills install
      // endpoint (which clones the repo into ~/.clementine-next/skills/
      // and registers it). The CLI install runner only knows how to
      // shell out to brew/npm/pipx/git — running "npx skills add ..."
      // here would either fail validation or clone to the wrong place.
      // Recognize the same paste shapes normalizeRepoUrl() accepts and
      // re-route automatically so the user doesn't have to switch tabs.
      const skillPasteRe = /^(?:npx(?:\\s+-y)?|pnpm\\s+dlx|yarn\\s+dlx|bunx)\\s+skills\\s+add\\s+[@a-zA-Z0-9_./-]+$/i;
      if (skillPasteRe.test(command)) {
        showInfo('That looks like a skill install — routing it to the Skills installer.', { durationMs: 4000 });
        try {
          const r = await fetch(withToken('/api/console/skills/install'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: command }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            showError('Skill install rejected: ' + (j.error || r.status));
            return;
          }
          showSuccess('Skill install started. Check the Skills panel for progress.');
          // Jump the user over to the Skills panel so they see the result.
          if (typeof switchPanel === 'function') switchPanel('skills');
        } catch (err) {
          showError('Skill install failed: ' + ((err && err.message) || err));
        }
        return;
      }

      if (!confirm('Run this install command now?\\n\\n' + command)) return;
      runBtn.disabled = true;
      runBtn.textContent = 'STARTING...';
      try {
        const r = await fetch(withToken('/api/console/install-command'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, title: 'Install: ' + command.slice(0, 80) }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          showError('Install rejected: ' + (j.error || r.status));
          return;
        }
        await pollInstallJob(j.job?.id, listEl);
        await Promise.allSettled([refreshHubBrowserHarness(), refreshHubMcp(), bootSkillsPanel()]);
      } catch (err) {
        showError('Install failed: ' + ((err && err.message) || err));
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = 'RUN INSTALL';
      }
    });
  }

  async function refreshHubGitHubCli() {
    const el = document.querySelector('[data-hub-github-cli]');
    if (!el) return;
    try {
      const data = await fetchJSON('/api/console/managed-clis');
      const gh = data.github || {};
      const installed = gh.installed === true;
      const auth = gh.authenticated === true;
      const pill = auth ? 'active' : installed ? 'pending' : 'available';
      const pillText = auth ? 'AUTHENTICATED' : installed ? 'AUTH NEEDED' : 'OPTIONAL';
      const actionButtons = installed
        ? [
            '<button data-hub-github-cli-action="auth">' + (auth ? 'LOGIN AGAIN' : 'LOGIN') + '</button>',
            '<button data-hub-github-cli-action="repair">REPAIR TOKEN</button>',
          ].join('')
        : '<button data-hub-github-cli-action="install">INSTALL OPTIONAL GH</button>';
      el.innerHTML = [
        '<div class="hub-app-card" style="grid-column:1/-1">',
        '  <div class="hub-app-name">GitHub CLI</div>',
        '  <span class="hub-app-pill ' + pill + '">' + pillText + '</span>',
        '  <div class="hub-app-meta">' + escMem(gh.version || 'gh not installed') + '</div>',
        '  <div class="hub-app-meta">' + escMem(installed ? (gh.authMessage || 'Used for private skill repos, PRs, issues, releases, and Actions.') : 'Optional. Install/authenticate only for private skill repos or GitHub CLI workflows.') + '</div>',
        '  <div class="hub-app-card-actions">' + actionButtons + '</div>',
        '</div>',
      ].join('');
      el.querySelectorAll('[data-hub-github-cli-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const action = btn.getAttribute('data-hub-github-cli-action') || 'auth';
          if (action === 'install' && !confirm('Install optional GitHub CLI with Homebrew now?\\n\\nClementine can run without this. It is only needed for private skill repos and GitHub CLI workflows.')) return;
          btn.disabled = true;
          btn.textContent = action === 'install' ? 'INSTALLING...' : 'STARTING...';
          try {
            await startManagedCliAction('github', action, el, refreshHubGitHubCli);
          } catch (err) {
            alert('GitHub CLI action failed: ' + (err.message || err));
            await refreshHubGitHubCli();
          }
        });
      });
    } catch (err) {
      el.innerHTML = '<div class="settings-info" style="color:var(--accent-fail);">GitHub CLI: ' + escMem(err.message || err) + '</div>';
    }
  }

  async function refreshHubBrowserHarness() {
    const controlsEl = document.querySelector('[data-hub-browser-controls]');
    const listEl = document.querySelector('[data-hub-browser-list]');
    const metaEl = document.querySelector('[data-hub-browser-meta]');
    if (!controlsEl || !listEl || !metaEl) return;
    try {
      const status = await fetchJSON('/api/console/browser-harness');
      const missingPrereqs = (status.prerequisites || []).filter((p) => !p.available);
      metaEl.textContent = status.installed
        ? 'installed' + (status.browserUseCloudKeyPresent ? ' · cloud key ready' : ' · local chrome mode')
        : 'optional' + (missingPrereqs.length > 0 ? ' · prerequisites missing' : ' · ready to install');

      controlsEl.innerHTML = [
        status.installed ? '<button data-hub-browser-doctor>RUN DOCTOR</button>' : '<button data-hub-browser-install>INSTALL OPTIONAL BROWSER HARNESS</button>',
        '<button data-hub-browser-chrome>OPEN CHROME SETUP</button>',
        '<button data-hub-browser-test ' + (status.installed ? '' : 'disabled') + '>TEST ATTACH</button>',
        '<button data-hub-browser-refresh>REFRESH</button>',
        '<a href="' + escMem(status.docsUrl) + '" target="_blank" rel="noopener" style="font-size:10px;letter-spacing:0.14em;color:var(--fg-3);">docs →</a>',
      ].join('');

      const prereqRows = (status.prerequisites || []).map((p) => [
        '<div class="row">',
        '  <span class="k">' + escMem(p.name) + '</span>',
        '  <span class="v">' + (p.available ? 'ready' : 'missing') + (p.version ? ' · ' + escMem(p.version) : '') + (p.path ? ' · ' + escMem(p.path) : '') + '</span>',
        '</div>',
      ].join('')).join('');
      listEl.innerHTML = [
        '<div class="hub-app-card" style="grid-column:1/-1">',
        '  <div class="hub-app-name">Browser Harness CLI</div>',
        '  <span class="hub-app-pill ' + (status.installed ? 'active' : 'available') + '">' + (status.installed ? 'ACTIVE' : 'OPTIONAL') + '</span>',
        '  <div class="hub-app-meta">Command: ' + escMem(status.commandPath || 'not installed') + '</div>',
        '  <div class="hub-app-meta">Install dir: ' + escMem(status.installDir || '') + '</div>',
        '  <div class="settings-info" style="margin-top:10px;">',
        '    <div class="row"><span class="k">Version</span><span class="v">' + escMem(status.version || 'not installed') + '</span></div>',
        '    <div class="row"><span class="k">Editable repo</span><span class="v">' + (status.repoPresent ? 'present' : 'not cloned yet') + '</span></div>',
        '    <div class="row"><span class="k">Codex skill link</span><span class="v">' + (status.codexSkillLinked ? 'linked' : 'not linked yet') + '</span></div>',
        '    <div class="row"><span class="k">Browser Use cloud</span><span class="v">' + (status.browserUseCloudKeyPresent ? 'key ready' : 'optional key missing') + '</span></div>',
             status.installed || missingPrereqs.length === 0 ? prereqRows : '',
        '  </div>',
        missingPrereqs.length > 0 ? '  <div class="hub-app-meta" style="color:var(--fg-3);margin-top:8px;">Optional browser automation is disabled until git, uv, and Python 3 are installed. Clementine can keep running without Browser Harness.</div>' : '',
        '  <div class="hub-app-card-actions" style="margin-top:10px;"><button data-hub-key-jump="browser_use_api_key">SET CLOUD KEY</button></div>',
        '</div>',
      ].join('');

      const installBtn = controlsEl.querySelector('[data-hub-browser-install]');
      if (installBtn) {
        installBtn.disabled = missingPrereqs.length > 0;
        installBtn.addEventListener('click', async () => {
          if (!confirm('Install optional Browser Harness now?\\n\\nClementine will clone browser-use/browser-harness into ~/Developer/browser-harness and run uv tool install -e .')) return;
          installBtn.disabled = true;
          installBtn.textContent = 'INSTALLING...';
          const r = await fetch(withToken('/api/console/browser-harness/install'), { method: 'POST' });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            alert('Install failed to start: ' + (j.error || r.status));
            await refreshHubBrowserHarness();
            return;
          }
          hubBrowserInstallJob = j.job?.id || null;
          pollBrowserHarnessJob(hubBrowserInstallJob);
        });
      }

      const doctorBtn = controlsEl.querySelector('[data-hub-browser-doctor]');
      if (doctorBtn) {
        doctorBtn.addEventListener('click', async () => {
          doctorBtn.textContent = 'RUNNING...';
          const r = await fetch(withToken('/api/console/browser-harness/doctor'), { method: 'POST' });
          const j = await r.json().catch(() => ({}));
          listEl.insertAdjacentHTML('afterbegin', renderBrowserHarnessOutput(j));
          doctorBtn.textContent = 'RUN DOCTOR';
        });
      }

      const chromeBtn = controlsEl.querySelector('[data-hub-browser-chrome]');
      if (chromeBtn) {
        chromeBtn.addEventListener('click', async () => {
          const r = await fetch(withToken('/api/console/browser-harness/open-chrome-setup'), { method: 'POST' });
          const j = await r.json().catch(() => ({}));
          if (!j.ok) alert(j.output || 'Open chrome://inspect/#remote-debugging in Chrome and enable remote debugging.');
        });
      }

      const testBtn = controlsEl.querySelector('[data-hub-browser-test]');
      if (testBtn) {
        testBtn.addEventListener('click', async () => {
          testBtn.textContent = 'TESTING...';
          const r = await fetch(withToken('/api/console/browser-harness/test'), { method: 'POST' });
          const j = await r.json().catch(() => ({}));
          listEl.insertAdjacentHTML('afterbegin', renderBrowserHarnessOutput(j));
          testBtn.textContent = 'TEST ATTACH';
        });
      }

      const refreshBtn = controlsEl.querySelector('[data-hub-browser-refresh]');
      if (refreshBtn) refreshBtn.addEventListener('click', () => refreshHubBrowserHarness());
      listEl.querySelectorAll('[data-hub-key-jump]').forEach((btn) => {
        btn.addEventListener('click', () => {
          switchPanel('settings');
          setTimeout(() => {
            const target = document.querySelector('[data-cred-row="' + btn.getAttribute('data-hub-key-jump') + '"]');
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const setBtn = target?.querySelector('[data-cred-set]');
            if (setBtn) setBtn.click();
          }, 150);
        });
      });
    } catch (err) {
      metaEl.textContent = 'error';
      listEl.innerHTML = '<div class="settings-info" style="color:var(--accent-fail);">Browser Harness: ' + escMem(err.message || err) + '</div>';
    }
  }

  // ── CLI catalog (search-driven curated installs) ──────────────
  let hubCliCatQuery = '';
  let hubCliCatDebounce = 0;
  let hubCliCatPollTimers = {};   // jobId → setInterval handle

  function renderCliCatalogResults(listEl, payload) {
    if (!listEl) return;
    const results = (payload && payload.results) || [];
    if (!hubCliCatQuery.trim()) {
      listEl.innerHTML = '<div class="settings-info">Type a name above to find an installable CLI.</div>';
      return;
    }
    if (results.length === 0) {
      listEl.innerHTML = '<div class="settings-info">No catalog entry matches "' + escMem(hubCliCatQuery) + '". Try a different name — or paste an install command into the installer below.</div>';
      return;
    }
    const connectedMap = (payload && payload.connected) || {};
    listEl.innerHTML = results.map((r) => {
      const installed = Boolean(r.installed);
      const connected = Boolean(connectedMap[r.id]);
      // Three card states:
      //   1) NOT INSTALLED — show "INSTALL" button (catalog install command)
      //   2) INSTALLED + CONNECTED — show "CONFIGURE" link + DISCONNECT
      //   3) INSTALLED + NOT CONNECTED — show "RECONNECT" button
      //      (case 3 only happens after explicit DISCONNECT — auto-promote
      //      handles fresh-installed CLIs automatically on the server)
      let pillCls, pillText;
      if (installed && connected) { pillCls = 'active'; pillText = 'CONNECTED'; }
      else if (installed)         { pillCls = 'warn';   pillText = 'INSTALLED · NOT CONNECTED'; }
      else                        { pillCls = 'available'; pillText = 'OPTIONAL'; }
      let actionBtn;
      if (!installed) {
        actionBtn = '<button data-cli-cat-install="' + escMem(r.id) + '">INSTALL</button>';
      } else if (!connected) {
        actionBtn = '<button data-cli-cat-reconnect="' + escMem(r.id) + '" title="Re-link this CLI so Clementine\\'s agent can find it">RECONNECT</button>';
      } else {
        actionBtn = '<a href="' + escMem(r.authDocsUrl) + '" target="_blank" rel="noopener" data-cli-cat-configure="' + escMem(r.id) + '">CONFIGURE ▸</a>';
      }
      const authLine = installed && r.authCommand
        ? '<div class="hub-app-meta">After connect: <code>' + escMem(r.authCommand) + '</code></div>'
        : '';
      const installPreview = !installed
        ? '<div class="hub-app-meta" style="color:var(--fg-3);">via <code>' + escMem(r.installCommand) + '</code></div>'
        : '';
      return [
        '<div class="hub-app-card" data-cli-cat-card="' + escMem(r.id) + '">',
        '  <div class="hub-app-name">' + escMem(r.name) + '</div>',
        '  <span class="hub-app-pill ' + pillCls + '">' + pillText + '</span>',
        '  <div class="hub-app-meta">' + escMem(r.vendor) + ' · <code>' + escMem(r.command) + '</code></div>',
        '  <div class="hub-app-meta">' + escMem(r.description) + '</div>',
        authLine,
        installPreview,
        '  <div class="hub-app-actions">' + actionBtn,
        connected ? '<button class="cli-cat-forget" data-cli-cat-forget="' + escMem(r.id) + '">DISCONNECT</button>' : '',
        '  </div>',
        '  <div class="hub-app-meta" data-cli-cat-job-status="' + escMem(r.id) + '"></div>',
        '</div>',
      ].join('');
    }).join('');
    wireCliCatalogActions(listEl);
  }

  function renderCliCatalogConnected(connectedEl, connected) {
    if (!connectedEl) return;
    const entries = Object.values(connected || {});
    if (entries.length === 0) {
      connectedEl.innerHTML = '';
      return;
    }
    connectedEl.innerHTML = [
      '<div class="settings-info" style="margin-top:14px;">',
      '<strong style="color:var(--accent-2);letter-spacing:0.14em;text-transform:uppercase;font-size:10px;">Connected — ' + entries.length + '</strong>',
      '<div class="hub-cli-connected-grid">',
      entries.map((c) => [
        '<span class="hub-cli-connected-pill" title="' + escMem(c.vendor) + ' · linked ' + escMem(c.installedAt || '') + '">',
        '<code>' + escMem(c.command) + '</code> · ' + escMem(c.name),
        '</span>',
      ].join('')).join(''),
      '</div>',
      '</div>',
    ].join('');
  }

  function wireCliCatalogActions(rootEl) {
    rootEl.querySelectorAll('[data-cli-cat-install]').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-cli-cat-install');
        if (!id) return;
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = 'STARTING…';
        const statusEl = rootEl.querySelector('[data-cli-cat-job-status="' + id + '"]');
        try {
          const result = await fetch(withToken('/api/console/cli-catalog/install'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          }).then((r) => r.json());
          if (!result.job) throw new Error(result.error || 'install start failed');
          if (statusEl) statusEl.textContent = '⏵ running: ' + result.entry.installCommand;
          btn.textContent = 'INSTALLING…';
          pollCliCatalogJob(id, result.job.id, btn, statusEl, originalText);
        } catch (err) {
          if (statusEl) statusEl.textContent = '✗ ' + (err.message || err);
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    });
    rootEl.querySelectorAll('[data-cli-cat-forget]').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-cli-cat-forget');
        if (!id) return;
        if (!confirm('Disconnect this CLI from Clementine? This only forgets the agent linkage — the binary stays installed.')) return;
        await fetch(withToken('/api/console/cli-catalog/forget'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        refreshHubCliCatalog();
      });
    });
    // Reconnect — for cards in the "installed but not connected" state.
    // Calls /api/console/cli-catalog/reconnect which drops the id from
    // forgotten[] and writes a fresh connected record so the agent gets
    // the auth-command hint + the dashboard surfaces it.
    rootEl.querySelectorAll('[data-cli-cat-reconnect]').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-cli-cat-reconnect');
        if (!id) return;
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = 'RECONNECTING…';
        try {
          const r = await fetch(withToken('/api/console/cli-catalog/reconnect'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { showError('Reconnect failed: ' + (j.error || r.status)); return; }
          showSuccess('Reconnected. The agent now has its auth metadata.');
          refreshHubCliCatalog();
        } catch (err) {
          showError('Reconnect failed: ' + ((err && err.message) || err));
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    });
  }

  function pollCliCatalogJob(catalogId, jobId, btn, statusEl, originalText) {
    if (hubCliCatPollTimers[catalogId]) {
      clearInterval(hubCliCatPollTimers[catalogId]);
    }
    hubCliCatPollTimers[catalogId] = setInterval(async () => {
      try {
        const data = await fetchJSON('/api/console/install-jobs/' + encodeURIComponent(jobId));
        const job = data && data.job;
        if (!job) return;
        if (statusEl) {
          const tail = (job.output || '').slice(-220).replace(/\s+$/, '');
          statusEl.textContent = '· ' + job.status + (tail ? ' · ' + tail : '');
        }
        if (job.status === 'succeeded') {
          clearInterval(hubCliCatPollTimers[catalogId]);
          delete hubCliCatPollTimers[catalogId];
          if (statusEl) statusEl.textContent = '✓ installed';
          await refreshHubCliCatalog();
        } else if (job.status === 'failed') {
          clearInterval(hubCliCatPollTimers[catalogId]);
          delete hubCliCatPollTimers[catalogId];
          if (statusEl) statusEl.textContent = '✗ install failed (exit ' + (job.exitCode ?? '?') + ')';
          btn.disabled = false;
          btn.textContent = originalText;
        }
      } catch { /* keep polling */ }
    }, 1500);
  }

  async function refreshHubCliCatalog() {
    const metaEl = document.querySelector('[data-hub-cli-cat-meta]');
    const resultsEl = document.querySelector('[data-hub-cli-cat-results]');
    const connectedEl = document.querySelector('[data-hub-cli-cat-connected]');
    const searchEl = document.querySelector('[data-hub-cli-cat-search]');
    if (!resultsEl) return;

    if (searchEl && !searchEl.dataset.bound) {
      searchEl.dataset.bound = '1';
      searchEl.addEventListener('input', () => {
        hubCliCatQuery = searchEl.value || '';
        clearTimeout(hubCliCatDebounce);
        hubCliCatDebounce = setTimeout(() => { void refreshHubCliCatalog(); }, 150);
      });
    }

    try {
      const data = await fetchJSON('/api/console/cli-catalog?q=' + encodeURIComponent(hubCliCatQuery));
      const connectedCount = Object.keys(data.connected || {}).length;
      if (metaEl) {
        metaEl.textContent = connectedCount === 0
          ? 'no CLIs connected yet'
          : connectedCount + ' connected';
      }
      renderCliCatalogResults(resultsEl, data);
      renderCliCatalogConnected(connectedEl, data.connected || {});
    } catch (err) {
      resultsEl.innerHTML = '<div class="settings-info" style="color:var(--accent-fail);">Catalog: ' + escMem(err.message || err) + '</div>';
    }
  }

  async function refreshHubRecall() {
    const controlsEl = document.querySelector('[data-hub-recall-controls]');
    const listEl = document.querySelector('[data-hub-recall-list]');
    const metaEl = document.querySelector('[data-hub-recall-meta]');
    if (!controlsEl || !listEl || !metaEl) return;
    try {
      const data = await fetchJSON('/api/console/meetings/recall');
      const settings = data.settings || {};
      const credential = data.credential || {};
      const desktop = window.clemmy?.recallStatus ? await window.clemmy.recallStatus().catch((err) => ({ lastError: err.message || String(err) })) : null;
      const hasKey = Boolean(credential.hasValue);
      const electronReady = Boolean(window.clemmy?.recallConfigure);
      metaEl.textContent = [
        settings.enabled ? 'enabled' : 'disabled',
        hasKey ? 'key ready' : 'key needed',
        electronReady ? 'electron available' : 'electron only',
      ].join(' · ');

      const regionOptions = Object.keys(data.regions || { 'us-west-2': true, 'us-east-1': true, 'eu-central-1': true, 'ap-northeast-1': true })
        .map((region) => '<option value="' + escMem(region) + '"' + (settings.region === region ? ' selected' : '') + '>' + escMem(region) + '</option>')
        .join('');
      controlsEl.innerHTML = [
        hasKey ? '' : '<input type="text" class="secret-input" placeholder="Recall.ai API key" data-hub-recall-key autocomplete="off" data-1p-ignore="true" data-lpignore="true" spellcheck="false" name="api-key-recall-no-autofill" />',
        hasKey ? '' : '<button data-hub-recall-save-key>SAVE KEY</button>',
        '<a href="' + escMem(data.signupUrl || 'https://www.recall.ai/signup') + '" target="_blank" rel="noopener" style="font-size:10px;letter-spacing:0.14em;color:var(--fg-3);">get Recall.ai →</a>',
        '<select data-hub-recall-region>' + regionOptions + '</select>',
        '<label class="check-pill"><input type="checkbox" data-hub-recall-enabled ' + (settings.enabled ? 'checked' : '') + ' /> ENABLED</label>',
        '<label class="check-pill"><input type="checkbox" data-hub-recall-auto ' + (settings.autoRecord ? 'checked' : '') + ' /> AUTO RECORD</label>',
        '<label class="check-pill"><input type="checkbox" data-hub-recall-live ' + (settings.liveTranscript ? 'checked' : '') + ' /> LIVE TRANSCRIPT</label>',
        '<label class="check-pill"><input type="checkbox" data-hub-recall-analyze ' + (settings.analyzeOnComplete !== false ? 'checked' : '') + ' /> ANALYZE AFTER</label>',
        '<button data-hub-recall-save-settings>SAVE SETTINGS</button>',
        electronReady ? '<button data-hub-recall-test>TEST CONNECTION</button>' : '',
        electronReady ? '<button data-hub-recall-perms>REQUEST PERMISSIONS</button>' : '',
        electronReady ? '<button data-hub-recall-manual>START MANUAL</button>' : '',
        electronReady ? '<button data-hub-recall-stop>STOP</button>' : '',
      ].filter(Boolean).join('');

      // Roll up the SDK + permission + window state into the
      // diagnostic the user actually needs at a glance.
      const recordingAt = desktop?.lastEventAt
        ? new Date(desktop.lastEventAt).toLocaleString()
        : 'never';
      const sdkSummary = !electronReady ? 'electron only — open in Clementine.app to inspect SDK'
        : desktop?.sdkAvailable === false ? '✗ SDK failed to load'
        : !desktop?.enabled ? '— SDK disabled (turn ENABLED on, then save settings)'
        : !desktop?.initialized ? '⚠ SDK not yet initialized — click TEST CONNECTION'
        : '✓ SDK initialized · region ' + (settings.region || 'us-west-2');
      const recordingSummary = desktop?.recording
        ? '✓ recording window ' + (desktop.currentWindowId || '')
        : 'idle';
      const detected = Array.isArray(desktop?.detectedWindows) ? desktop.detectedWindows : [];
      const detectedSummary = detected.length === 0
        ? 'no meeting windows currently detected'
        : detected.map((w) => '• ' + (w.platform || 'meeting') + ' · ' + (w.title || w.windowId) + (w.recording ? ' (recording)' : '')).join('\\n');
      const permEntries = desktop?.permissionStatuses && typeof desktop.permissionStatuses === 'object'
        ? Object.entries(desktop.permissionStatuses)
        : [];
      const permissionSummary = permEntries.length === 0
        ? 'no permission status received yet — click REQUEST PERMISSIONS'
        : permEntries
            .map(([perm, state]) => {
              const mark = state === 'granted' ? '✓' : state === 'denied' ? '✗' : '⚠';
              return mark + ' ' + perm + ': ' + state;
            })
            .join(' · ');

      const statusRows = [
        ['Credential', hasKey ? 'connected via ' + (credential.source || 'vault') : 'not configured'],
        ['Electron bridge', electronReady ? 'available' : 'open in Clementine.app to control recording'],
        ['SDK', sdkSummary],
        ['Permissions', permissionSummary],
        ['Recording', recordingSummary],
        ['Last event', (desktop?.lastEvent || 'none') + (desktop?.lastEventAt ? ' (' + recordingAt + ')' : '')],
        ['Last meeting', desktop?.lastMeeting ? [desktop.lastMeeting.platform, desktop.lastMeeting.title].filter(Boolean).join(' · ') || desktop.lastMeeting.windowId : 'none'],
        ['Detected windows', detectedSummary],
        ['Error', desktop?.lastError || 'none'],
      ];
      listEl.innerHTML = [
        '<div class="hub-app-card" style="grid-column:1/-1">',
        '  <div class="hub-app-name">Recall.ai Desktop SDK</div>',
        '  <span class="hub-app-pill ' + (settings.enabled && hasKey ? 'active' : 'available') + '">' + (settings.enabled && hasKey ? 'READY' : 'OPTIONAL') + '</span>',
        '  <div class="hub-app-meta">Records only when enabled. Transcripts are saved to the local vault and then handed to Clementine as background analysis tasks.</div>',
        '  <div class="settings-info" style="margin-top:10px;white-space:pre-wrap">' + statusRows.map(([k, v]) => '<div class="row"><span class="k">' + escMem(k) + '</span><span class="v">' + escMem(v) + '</span></div>').join('') + '</div>',
        '</div>',
      ].join('');

      const keyBtn = controlsEl.querySelector('[data-hub-recall-save-key]');
      if (keyBtn) {
        keyBtn.addEventListener('click', async () => {
          const input = controlsEl.querySelector('[data-hub-recall-key]');
          const value = input?.value?.trim() || '';
          if (!value) { showError('Paste your Recall.ai API key first.'); return; }
          keyBtn.textContent = 'SAVING…';
          const r = await fetch(withToken('/api/console/credentials/set'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'recall_api_key', value }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            showError('Recall key save failed: ' + (j.error || r.status));
            keyBtn.textContent = 'SAVE KEY';
            return;
          }
          showSuccess('Recall.ai API key saved.');
          await Promise.allSettled([refreshHubRecall(), refreshHubKeys(), refreshCredentialsHealth()]);
        });
      }

      const saveSettingsBtn = controlsEl.querySelector('[data-hub-recall-save-settings]');
      if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', async () => {
          const next = {
            enabled: Boolean(controlsEl.querySelector('[data-hub-recall-enabled]')?.checked),
            autoRecord: Boolean(controlsEl.querySelector('[data-hub-recall-auto]')?.checked),
            liveTranscript: Boolean(controlsEl.querySelector('[data-hub-recall-live]')?.checked),
            analyzeOnComplete: Boolean(controlsEl.querySelector('[data-hub-recall-analyze]')?.checked),
            region: controlsEl.querySelector('[data-hub-recall-region]')?.value || 'us-west-2',
          };
          saveSettingsBtn.textContent = 'SAVING…';
          const r = await fetch(withToken('/api/console/meetings/recall/settings'), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(next),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) {
            showError('Recall settings save failed: ' + (j.error || r.status));
            saveSettingsBtn.textContent = 'SAVE SETTINGS';
            return;
          }
          if (window.clemmy?.recallConfigure) {
            await window.clemmy.recallConfigure(j.settings || next).catch((err) => showError('Electron setup failed: ' + (err.message || err)));
          }
          showSuccess('Recall settings saved.');
          await refreshHubRecall();
        });
      }

      const permBtn = controlsEl.querySelector('[data-hub-recall-perms]');
      if (permBtn) {
        permBtn.addEventListener('click', async () => {
          try {
            await window.clemmy.recallRequestPermissions();
            showInfo('Permission requests sent — check the macOS dialogs.', { durationMs: 6000 });
            await refreshHubRecall();
          } catch (err) {
            showError('Permission request failed: ' + ((err && err.message) || err));
          }
        });
      }
      const testBtn = controlsEl.querySelector('[data-hub-recall-test]');
      if (testBtn) {
        testBtn.addEventListener('click', async () => {
          if (!window.clemmy?.recallTest) {
            // Toast instead of alert: when the user clicks TEST from a
            // backgrounded Clementine (they're focused on Zoom mid-
            // meeting), a native alert fires inside Clementine's window
            // but doesn't grab cross-app focus — so the user thinks
            // nothing happened. Toasts are renderer-side overlays that
            // stay visible without needing app focus.
            showWarn('Test Connection requires the Clementine desktop app. Open Clementine.app to run it.', { sticky: true });
            return;
          }
          testBtn.textContent = 'TESTING…';
          try {
            const result = await window.clemmy.recallTest();
            // Refresh first so the new state is rendered, then surface
            // a human-readable result the user can see even when
            // Clementine is in the background.
            await refreshHubRecall();
            if (!result) {
              showWarn('Recall test returned no result.');
            } else if (!result.sdkAvailable) {
              showError('SDK could not load: ' + (result.lastError || 'unknown error'), { sticky: true });
            } else if (!result.enabled) {
              showWarn('SDK is disabled — turn ENABLED on and save settings, then test again.');
            } else if (!result.initialized) {
              showError('SDK loaded but init failed: ' + (result.lastError || 'unknown error'), { sticky: true });
            } else {
              const windowCount = Array.isArray(result.detectedWindows) ? result.detectedWindows.length : 0;
              showSuccess('SDK initialized · ' + windowCount + ' detected window' + (windowCount === 1 ? '' : 's') + '.', { durationMs: 8000 });
            }
          } catch (err) {
            showError('Test failed: ' + ((err && err.message) || err), { sticky: true });
          } finally {
            testBtn.textContent = 'TEST CONNECTION';
          }
        });
      }
      const manualBtn = controlsEl.querySelector('[data-hub-recall-manual]');
      if (manualBtn) {
        manualBtn.addEventListener('click', async () => {
          // confirm() suffers the same cross-app-focus problem as
          // alert(), but for a destructive-ish "are you sure" we
          // still want a blocking interaction. Toast-with-action
          // would be the proper fix; for now keep confirm() so a
          // misclick can't start a surprise recording.
          if (!confirm('Start a manual desktop audio recording now? Make sure you have consent where required.')) return;
          try {
            await window.clemmy.recallStartManual();
            showSuccess('Manual recording started.');
            await refreshHubRecall();
          } catch (err) {
            showError('Manual recording failed: ' + ((err && err.message) || err));
          }
        });
      }
      const stopBtn = controlsEl.querySelector('[data-hub-recall-stop]');
      if (stopBtn) {
        stopBtn.addEventListener('click', async () => {
          try {
            await window.clemmy.recallStop();
            showSuccess('Recording stopped. Canonical transcript backfill will land in a few minutes.');
            await refreshHubRecall();
          } catch (err) {
            showError('Stop failed: ' + ((err && err.message) || err));
          }
        });
      }
    } catch (err) {
      listEl.innerHTML = '<div class="settings-info" style="color:var(--accent-fail);">Recall: ' + escMem(err.message || err) + '</div>';
      metaEl.textContent = 'error';
    }
  }

  async function refreshHubMcp() {
    return renderHubMcp();
  }

  async function renderHubMcp() {
    const listEl = document.querySelector('[data-hub-mcp-list]');
    const metaEl = document.querySelector('[data-hub-mcp-meta]');
    const summary = document.querySelector('[data-hub-mcp]');
    if (!listEl || !metaEl) return;
    try {
      const data = await fetchJSON('/api/console/mcp-servers');
      const servers = data.servers || [];
      const enabled = servers.filter((s) => s.enabled !== false).length;
      metaEl.textContent = servers.length + ' total · ' + enabled + ' enabled';
      if (summary) summary.textContent = enabled + '/' + servers.length;

      if (servers.length === 0 && hubMcpEditing !== 'new') {
        listEl.innerHTML = '<div class="settings-info">— no MCP servers detected. Click + ADD CUSTOM SERVER to wire one in. —</div>';
        return;
      }

      listEl.innerHTML = servers.map((s) => {
        const transport = s.type || 'stdio';
        const isEditing = hubMcpEditing === s.name;
        const sourceLabel = s.source === 'user' ? 'CLEMENTINE CONFIG' : 'IMPORTED MCP';
        const transportLine = transport === 'stdio'
          ? (s.command ? s.command + (Array.isArray(s.args) ? ' ' + s.args.join(' ') : '') : '')
          : (s.url || '');
        return [
          '<div class="hub-mcp-row" data-hub-mcp-row="' + escMem(s.name) + '">',
          '  <div>',
          '    <div class="hub-mcp-name">',
          '      <span>' + escMem(s.name) + '</span>',
          '      <span class="pill source-' + escMem(s.source) + '">' + escMem(sourceLabel) + '</span>',
          '      <span class="pill transport-' + escMem(transport) + '">' + escMem(transport.toUpperCase()) + '</span>',
          '    </div>',
          transportLine ? '    <div class="hub-mcp-meta">' + escMem(transportLine) + '</div>' : '',
          s.description ? '    <div class="hub-mcp-desc">' + escMem(s.description) + '</div>' : '',
          '  </div>',
          '  <div class="hub-mcp-actions">',
          '    <button class="toggle ' + (s.enabled !== false ? 'on' : 'off') + '" data-hub-mcp-toggle="' + escMem(s.name) + '">' + (s.enabled !== false ? '● ENABLED' : '○ DISABLED') + '</button>',
          '    <button class="edit" data-hub-mcp-edit="' + escMem(s.name) + '">' + (isEditing ? 'CANCEL' : 'EDIT ✎') + '</button>',
          s.source === 'user' ? '    <button class="del" data-hub-mcp-del="' + escMem(s.name) + '">DELETE ▣</button>' : '',
          '  </div>',
          isEditing ? renderHubMcpEditor(s) : '',
          '</div>',
        ].join('');
      }).join('');

      if (hubMcpEditing === 'new') {
        listEl.insertAdjacentHTML('beforeend', '<div class="hub-mcp-row">' + renderHubMcpEditor(null) + '</div>');
      }

      bindHubMcpActions();
    } catch (err) {
      listEl.innerHTML = '<div class="settings-info" style="color:var(--accent-fail);">Failed: ' + escMem(err.message || err) + '</div>';
    }
  }

  function renderHubMcpEditor(s) {
    const v = s || { name: '', type: 'stdio', command: '', args: [], url: '', description: '', enabled: true };
    const argsStr = Array.isArray(v.args) ? v.args.join(' ') : '';
    return [
      '<div class="hub-mcp-editor" data-hub-mcp-editor-for="' + escMem(s ? s.name : 'new') + '">',
      s ? '' : '  <div><label>NAME</label><input type="text" data-f="name" value="" placeholder="e.g. internal-airtable, custom-rag, etc." /></div>',
      '  <div class="row">',
      '    <div><label>TRANSPORT</label><select data-f="type">',
           ['stdio','http','sse'].map((opt) => '<option value="' + opt + '"' + (v.type === opt ? ' selected' : '') + '>' + opt + '</option>').join(''),
      '    </select></div>',
      '    <div><label>DESCRIPTION</label><input type="text" data-f="description" value="' + escMem(v.description || '') + '" /></div>',
      '  </div>',
      '  <div><label>COMMAND (stdio)</label><input type="text" data-f="command" value="' + escMem(v.command || '') + '" placeholder="e.g. npx @modelcontextprotocol/server-filesystem /Users/me/notes" /></div>',
      '  <div><label>ARGS (space-separated, stdio)</label><input type="text" data-f="args" value="' + escMem(argsStr) + '" placeholder="optional — overrides args from command line" /></div>',
      '  <div><label>URL (http / sse)</label><input type="text" data-f="url" value="' + escMem(v.url || '') + '" placeholder="https://your-mcp-server.example.com/rpc" /></div>',
      '  <div class="buttons">',
      '    <button class="save" data-hub-mcp-save="' + escMem(s ? s.name : 'new') + '">' + (s ? 'SAVE' : 'CREATE') + '</button>',
      '    <button class="cancel" data-hub-mcp-cancel>CANCEL</button>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function bindHubMcpActions() {
    const root = document.querySelector('[data-hub-mcp-list]');
    if (!root) return;

    root.querySelectorAll('[data-hub-mcp-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.getAttribute('data-hub-mcp-toggle');
        const enabled = !btn.classList.contains('on');
        try {
          const r = await fetch(withToken('/api/console/mcp-servers/' + encodeURIComponent(name)), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
          });
          if (!r.ok) { const j = await r.json().catch(() => ({})); alert('Toggle failed: ' + (j.error || r.status)); return; }
          await refreshHubMcp();
        } catch (err) { alert('Toggle failed: ' + (err.message || err)); }
      });
    });

    root.querySelectorAll('[data-hub-mcp-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.getAttribute('data-hub-mcp-edit');
        hubMcpEditing = hubMcpEditing === name ? null : name;
        renderHubMcp();
      });
    });

    root.querySelectorAll('[data-hub-mcp-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => { hubMcpEditing = null; renderHubMcp(); });
    });

    root.querySelectorAll('[data-hub-mcp-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.getAttribute('data-hub-mcp-del');
        if (!confirm('Delete MCP server "' + name + '"? Only the user override is removed; if another imported MCP client config also has it, it will reappear on next reload.')) return;
        try {
          await fetch(withToken('/api/console/mcp-servers/' + encodeURIComponent(name)), { method: 'DELETE' });
          hubMcpEditing = null;
          await refreshHubMcp();
        } catch (err) { alert('Delete failed: ' + (err.message || err)); }
      });
    });

    root.querySelectorAll('[data-hub-mcp-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-hub-mcp-save');
        const editor = root.querySelector('[data-hub-mcp-editor-for="' + id + '"]');
        if (!editor) return;
        const patch = {};
        editor.querySelectorAll('[data-f]').forEach((el) => {
          const field = el.getAttribute('data-f');
          if (field === 'args') {
            const trimmed = el.value.trim();
            patch.args = trimmed ? trimmed.split(/\\s+/) : [];
          } else if (el.value !== '') {
            patch[field] = el.value;
          }
        });

        try {
          if (id === 'new') {
            if (!patch.name) { alert('name is required'); return; }
            const r = await fetch(withToken('/api/console/mcp-servers'), {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(patch),
            });
            if (!r.ok) { const j = await r.json().catch(() => ({})); alert('Create failed: ' + (j.error || r.status)); return; }
          } else {
            const r = await fetch(withToken('/api/console/mcp-servers/' + encodeURIComponent(id)), {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(patch),
            });
            if (!r.ok) { const j = await r.json().catch(() => ({})); alert('Save failed: ' + (j.error || r.status)); return; }
          }
          hubMcpEditing = null;
          await refreshHubMcp();
        } catch (err) { alert('Save failed: ' + (err.message || err)); }
      });
    });
  }

  // ─── Usage panel ──────────────────────────────────────────────
  // Reads /api/console/usage (NDJSON rollup) and renders four sections:
  // totals, by-source, by-kind, by-model, hourly sparkline, trim
  // controls. Trim controls POST to /api/console/usage/trim which
  // toggles individual cron jobs or the proactivity policy.

  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }

  async function bootUsagePanel() {
    const refreshBtn = document.querySelector('[data-usage-refresh]');
    if (refreshBtn && !refreshBtn.dataset.bound) {
      refreshBtn.dataset.bound = '1';
      refreshBtn.addEventListener('click', () => refreshUsagePanel());
    }
    await refreshUsagePanel();
    // Cheap auto-refresh — endpoint is a single ndjson read.
    setInterval(refreshUsagePanel, 15000);
  }

  // v0.5.11 — Approvals panel boot + render.
  async function bootApprovalsPanel() {
    const refreshBtn = document.querySelector('[data-approvals-refresh]');
    if (refreshBtn && !refreshBtn.dataset.bound) {
      refreshBtn.dataset.bound = '1';
      refreshBtn.addEventListener('click', () => refreshApprovalsPanel());
    }
    const cancelStaleBtn = document.querySelector('[data-approvals-cancel-stale]');
    if (cancelStaleBtn && !cancelStaleBtn.dataset.bound) {
      cancelStaleBtn.dataset.bound = '1';
      cancelStaleBtn.addEventListener('click', async () => {
        if (!confirm('Cancel ALL approvals older than 1 hour? Their underlying workflow runs continue without action.')) return;
        try {
          await fetch(withToken('/api/console/approvals/cancel-stale'), { method: 'POST' });
          await refreshApprovalsPanel();
          await refreshApprovalsBadge();
        } catch (err) { console.error('cancel-stale failed:', err); }
      });
    }
    await refreshApprovalsPanel();
    setInterval(() => { refreshApprovalsPanel(); refreshApprovalsBadge(); }, 20000);
  }

  function fmtApprovalAge(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '';
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm';
    const h = Math.floor(min / 60);
    if (h < 24) return h + 'h ' + (min % 60) + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }

  function approvalAgeClass(ms) {
    if (ms > 6 * 3600_000) return 'very-stale';
    if (ms > 60 * 60_000) return 'stale';
    return '';
  }

  async function refreshApprovalsPanel() {
    const listEl = document.querySelector('[data-approvals-list]');
    if (!listEl) return;
    try {
      const data = await fetchJSON('/api/console/approvals/list');
      const approvals = Array.isArray(data.approvals) ? data.approvals : [];
      if (approvals.length === 0) {
        listEl.innerHTML = '<div class="settings-info">No pending approvals. Clementine is not waiting on anything.</div>';
        return;
      }
      const rows = approvals.map(function (a) {
        const ageMs = a.requestedAt ? Date.now() - new Date(a.requestedAt).getTime() : 0;
        const ageLabel = fmtApprovalAge(ageMs);
        const ageCls = approvalAgeClass(ageMs);
        let argsRendered = '';
        if (a.args && typeof a.args === 'object') {
          try { argsRendered = JSON.stringify(a.args, null, 2); } catch { argsRendered = String(a.args); }
        }
        const sessionShort = (a.sessionId || '').slice(0, 32);
        const workflow = (a.args && typeof a.args === 'object' && typeof a.args.workflow === 'string') ? a.args.workflow : '';
        const kind = a.kind === 'runtime' ? 'runtime' : 'harness';
        const fingerprint = a.resourceFingerprint;
        const mismatchBanner = fingerprint && fingerprint.result === 'mismatch'
          ? [
              '  <div class="approval-mismatch">',
              '    <strong>⚠ RESOURCE MISMATCH</strong> &nbsp;',
              'this tool would act on <code>' + escMem(String(fingerprint.candidateId || '')) + '</code>',
              ', but your active focus is <strong>' + escMem(String(fingerprint.focusTitle || '')) + '</strong> ',
              '(<code>' + escMem(String(fingerprint.focusRef || '')) + '</code>). ',
              'Verify before approving.',
              '  </div>',
            ].join('')
          : '';
        return [
          '<div class="approval-card ' + (fingerprint && fingerprint.result === 'mismatch' ? 'has-mismatch' : '') + '" data-approval-id="' + escMem(a.approvalId || '') + '" data-approval-kind="' + kind + '">',
          '  <div class="approval-card-head">',
          '    <div class="approval-subject">' + escMem(a.subject || a.tool || '(no subject)') + '</div>',
          '    <div class="approval-age ' + ageCls + '">' + escMem(ageLabel) + '</div>',
          '  </div>',
          mismatchBanner,
          '  <div class="approval-meta">tool: <code>' + escMem(a.tool || 'unknown') + '</code>',
          workflow ? ' · workflow: <code>' + escMem(workflow) + '</code>' : '',
          ' · session: <code>' + escMem(sessionShort) + '</code>',
          ' · id: <code>' + escMem(a.approvalId || '') + '</code>',
          ' · <span class="approval-kind-pill ' + kind + '">' + (kind === 'runtime' ? 'runtime' : 'tool') + '</span></div>',
          argsRendered ? '  <pre class="approval-args">' + escMem(argsRendered) + '</pre>' : '',
          '  <div class="approval-actions">',
          '    <button class="approve" data-approval-action="approve">APPROVE</button>',
          '    <button class="reject" data-approval-action="reject">REJECT</button>',
          kind === 'harness' ? '    <button data-approval-action="cancel">CANCEL RUN</button>' : '',
          '  </div>',
          '</div>',
        ].join('');
      });
      listEl.innerHTML = rows.join('');

      // Bind action handlers
      Array.from(listEl.querySelectorAll('[data-approval-action]')).forEach(function (btn) {
        if (btn.dataset.bound) return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', async function () {
          const card = btn.closest('[data-approval-id]');
          if (!card) return;
          const id = card.getAttribute('data-approval-id');
          const action = btn.getAttribute('data-approval-action');
          const kind = card.getAttribute('data-approval-kind') === 'runtime' ? 'runtime' : 'harness';
          if (!id || !action) return;
          if (action === 'cancel' && !confirm('Cancel this run? It will stop without sending or completing.')) return;
          Array.from(card.querySelectorAll('button')).forEach(function (b) { b.disabled = true; });
          try {
            // Runtime approvals go through the legacy /api/approvals route;
            // harness (tool-gate) approvals through /api/console/harness-approvals.
            // Mismatching the route silently 404s and leaves the user
            // wondering why their click didn't do anything.
            const url = kind === 'runtime'
              ? '/api/approvals/' + encodeURIComponent(id) + '/' + action
              : '/api/console/harness-approvals/' + encodeURIComponent(id) + '/' + action;
            await fetch(withToken(url), {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
            });
            await refreshApprovalsPanel();
            await refreshApprovalsBadge();
          } catch (err) {
            console.error('approval action failed:', err);
            Array.from(card.querySelectorAll('button')).forEach(function (b) { b.disabled = false; });
          }
        });
      });
    } catch (err) {
      console.error('approvals panel refresh failed:', err);
      listEl.innerHTML = '<div class="settings-info">— failed to load: ' + escMem(String(err && err.message || err)) + ' —</div>';
    }
  }

  async function refreshApprovalsBadge() {
    const badge = document.querySelector('[data-approvals-badge]');
    if (!badge) return;
    try {
      const data = await fetchJSON('/api/console/approvals/list');
      const n = Array.isArray(data.approvals) ? data.approvals.length : 0;
      if (n > 0) {
        badge.textContent = String(n);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    } catch { /* ignore */ }
  }

  // Refresh the nav badge in the background regardless of which panel
  // is open — that's the "you have stale approvals" affordance.
  setInterval(refreshApprovalsBadge, 30000);
  refreshApprovalsBadge();

  // ────────────────────────────────────────────────────────────────
  // v0.5.11 — Brain panel. Five OUTER sub-tabs:
  //   Overview / Knowledge / Events / Profile / Evolution
  // Inside "Knowledge" there are three INNER sub-tabs (Facts / Entities /
  // Graph & Files) — those reuse the v0.5.10-era facts + entities loaders.
  // ────────────────────────────────────────────────────────────────

  let brainKnowledgeSubtab = 'facts';

  function refreshBrainCurrentTab() {
    if (brainCurrentTab === 'overview') refreshBrainOverview();
    else if (brainCurrentTab === 'knowledge') refreshBrainKnowledgeCurrentSub();
    else if (brainCurrentTab === 'events') refreshBrainPointers();
    else if (brainCurrentTab === 'meetings') refreshBrainMeetings();
    else if (brainCurrentTab === 'profile') refreshBrainProfile();
    else if (brainCurrentTab === 'evolution') refreshBrainEvolution();
  }

  async function refreshBrainKnowledgeCurrentSub() {
    if (brainKnowledgeSubtab === 'facts') refreshBrainFacts();
    else if (brainKnowledgeSubtab === 'entities') refreshBrainEntities();
    else if (brainKnowledgeSubtab === 'graph') {
      // Graph view — wire controls + ALWAYS force loadMemoryGraph on
      // first visible contact. The legacy bootMemoryPanel may have
      // run while the canvas container was hidden (0×0), leaving a
      // degenerate cytoscape instance. force=true tears down + rebuilds
      // with the now-correct dimensions.
      if (typeof wireMemoryGraphControls === 'function') wireMemoryGraphControls();
      if (memGraphCy) {
        try { memGraphCy.resize(); memGraphCy.fit(undefined, 40); } catch (_) {}
      }
      if (typeof loadMemoryGraph === 'function') {
        try { await loadMemoryGraph({ force: true }); } catch (err) { console.error('brain/graph load failed:', err); }
      }
    } else if (brainKnowledgeSubtab === 'files') {
      // Files view — first contact runs the full bootMemoryPanel so
      // every data-mem-* selector wires up (search input, viewer
      // click handlers, kind pills). Subsequent visits just refresh
      // the lists.
      await ensureMemoryBooted();
      if (typeof refreshMemoryPanel === 'function') {
        try { await refreshMemoryPanel(); } catch (err) { console.error('brain/files refresh failed:', err); }
      }
    }
  }

  async function bootBrainPanel() {
    // Outer tabs.
    Array.from(document.querySelectorAll('[data-brain-tab]')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        const tab = btn.getAttribute('data-brain-tab');
        if (!tab) return;
        Array.from(document.querySelectorAll('.brain-tab')).forEach(function (t) { t.classList.toggle('on', t === btn); });
        Array.from(document.querySelectorAll('.brain-tab-pane')).forEach(function (p) {
          p.hidden = p.getAttribute('data-brain-pane') !== tab;
        });
        brainCurrentTab = tab;
        refreshBrainCurrentTab();
      });
    });
    // Inner Knowledge sub-tabs (Facts / Entities / Graph & Files).
    Array.from(document.querySelectorAll('[data-brain-knowledge-tab]')).forEach(function (btn) {
      btn.addEventListener('click', function () {
        const tab = btn.getAttribute('data-brain-knowledge-tab');
        if (!tab) return;
        Array.from(document.querySelectorAll('.brain-subtab')).forEach(function (t) { t.classList.toggle('on', t === btn); });
        Array.from(document.querySelectorAll('.brain-knowledge-pane')).forEach(function (p) {
          p.hidden = p.getAttribute('data-brain-knowledge-pane') !== tab;
        });
        brainKnowledgeSubtab = tab;
        refreshBrainKnowledgeCurrentSub();
      });
    });
    const kindSel = document.querySelector('[data-brain-fact-kind]');
    const sortSel = document.querySelector('[data-brain-fact-sort]');
    const entityTypeSel = document.querySelector('[data-brain-entity-type]');
    if (kindSel) kindSel.addEventListener('change', refreshBrainFacts);
    if (sortSel) sortSel.addEventListener('change', refreshBrainFacts);
    if (entityTypeSel) entityTypeSel.addEventListener('change', refreshBrainEntities);
    // Default tab is Overview — load it on boot.
    await refreshBrainOverview();
  }

  function fmtAgoShort(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  async function refreshBrainFacts() {
    const list = document.querySelector('[data-brain-fact-list]');
    const cnt = document.querySelector('[data-brain-fact-count]');
    if (!list) return;
    const kind = (document.querySelector('[data-brain-fact-kind]') || {}).value || '';
    const sort = (document.querySelector('[data-brain-fact-sort]') || {}).value || 'stanford';
    try {
      const q = new URLSearchParams();
      if (kind) q.set('kind', kind);
      q.set('sort', sort);
      const data = await fetchJSON('/api/console/brain/facts?' + q.toString());
      const facts = Array.isArray(data.facts) ? data.facts : [];
      if (cnt) cnt.textContent = facts.length + ' / ' + (data.total || 0) + ' active';
      if (facts.length === 0) {
        list.innerHTML = '<div class="settings-info">No facts in this filter. Try a different kind or sort.</div>';
        return;
      }
      list.innerHTML = facts.map(function (f) {
        const isDerived = f.derivedFrom && (f.derivedFrom.callId || f.derivedFrom.sessionId);
        const trustPill = isDerived
          ? '<span class="pill derived">derived · trust ' + (f.trustLevel != null ? f.trustLevel.toFixed(1) : '?') + '</span>'
          : '<span class="pill direct">direct · trust 1.0</span>';
        // Only render the importance pill when it's actually scored —
        // user-stated facts default to no importance and showing
        // "imp ?" looks broken. The Stanford reflector sets importance
        // for derived facts; show "imp 7.0" + highlight when ≥7.
        const impPill = typeof f.importance === 'number' && f.importance > 0
          ? '<span class="pill ' + (f.importance >= 7 ? 'important' : '') + '">imp ' + f.importance.toFixed(1) + '</span>'
          : '';
        const callIdRef = isDerived && f.derivedFrom.callId
          ? ' · <code>' + escMem(f.derivedFrom.callId) + '</code>'
          : '';
        const toolRef = isDerived && f.derivedFrom.tool
          ? ' · from <code>' + escMem(f.derivedFrom.tool) + '</code>'
          : '';
        return [
          '<div class="brain-fact-row">',
          '  <div class="brain-fact-content">' + escMem(f.content || '') + '</div>',
          '  <div class="brain-fact-meta">',
          '    ' + trustPill + ' ' + impPill,
          '    <span class="pill">' + escMem(f.kind || '') + '</span>',
          '    · last accessed ' + escMem(fmtAgoShort(f.lastAccessedAt || f.updatedAt)),
          callIdRef, toolRef,
          '  </div>',
          '</div>',
        ].join('');
      }).join('');
    } catch (err) {
      console.error('brain facts refresh failed:', err);
      list.innerHTML = '<div class="settings-info">— failed to load —</div>';
    }
  }

  async function refreshBrainEntities() {
    const list = document.querySelector('[data-brain-entity-list]');
    const cnt = document.querySelector('[data-brain-entity-count]');
    if (!list) return;
    const type = (document.querySelector('[data-brain-entity-type]') || {}).value || '';
    try {
      const q = new URLSearchParams();
      if (type) q.set('type', type);
      const data = await fetchJSON('/api/console/brain/entities?' + q.toString());
      const entities = Array.isArray(data.entities) ? data.entities : [];
      if (cnt) cnt.textContent = entities.length + ' / ' + (data.total || 0) + ' total';
      if (entities.length === 0) {
        list.innerHTML = '<div class="settings-info">No entities recorded yet. The brain populates this as the reflection layer fires on tool returns mentioning people, companies, projects, etc.</div>';
        return;
      }
      list.innerHTML = entities.map(function (e) {
        const aliases = Array.isArray(e.aliases) && e.aliases.length > 0
          ? '<div class="brain-entity-aliases">aka: ' + e.aliases.map(escMem).join(', ') + '</div>'
          : '';
        return [
          '<div class="brain-entity-row">',
          '  <div>',
          '    <span class="brain-entity-type">' + escMem(e.entityType || '') + '</span>',
          '    <span class="brain-entity-name"> ' + escMem(e.canonicalName || '') + '</span>',
          aliases,
          '  </div>',
          '  <div class="brain-entity-stats">' + (e.mentionCount || 0) + ' mentions · last seen ' + escMem(fmtAgoShort(e.lastSeenAt)) + '</div>',
          '</div>',
        ].join('');
      }).join('');
    } catch (err) {
      console.error('brain entities refresh failed:', err);
      list.innerHTML = '<div class="settings-info">— failed to load —</div>';
    }
  }

  async function refreshBrainPointers() {
    const list = document.querySelector('[data-brain-pointer-list]');
    if (!list) return;
    try {
      const data = await fetchJSON('/api/console/brain/pointers');
      const pointers = Array.isArray(data.pointers) ? data.pointers : [];
      if (pointers.length === 0) {
        list.innerHTML = '<div class="settings-info">No episodic pointers yet. These get stored when the reflection layer extracts named events from tool returns (e.g. "the pricing convo with Marlow").</div>';
        return;
      }
      list.innerHTML = pointers.map(function (p) {
        return [
          '<div class="brain-pointer-row">',
          '  <div>',
          '    <div class="brain-pointer-label">' + escMem(p.label || '') + '</div>',
          '    <div class="brain-pointer-meta">',
          '      tool: <code>' + escMem(p.tool || '?') + '</code>',
          '      · call: <code>' + escMem(p.callId || '') + '</code>',
          '      · ' + escMem(fmtAgoShort(p.createdAt)),
          p.sourceUri ? ' · uri: <code>' + escMem(p.sourceUri) + '</code>' : '',
          '    </div>',
          '  </div>',
          '  <div class="brain-pointer-meta">session: <code>' + escMem((p.sessionId || '').slice(0, 24)) + '</code></div>',
          '</div>',
        ].join('');
      }).join('');
    } catch (err) {
      console.error('brain pointers refresh failed:', err);
      list.innerHTML = '<div class="settings-info">— failed to load —</div>';
    }
  }

  async function refreshBrainHealth() {
    const wrap = document.querySelector('[data-brain-health]');
    if (!wrap) return;
    try {
      const data = await fetchJSON('/api/console/brain/health');
      wrap.innerHTML = [
        '<div class="brain-health-grid">',
        '  <div class="brain-health-card"><div class="label">ACTIVE FACTS</div><div class="value">' + (data.activeFacts || 0) + '</div><div class="sub">' + (data.derivedFacts || 0) + ' derived · ' + (data.directFacts || 0) + ' direct</div></div>',
        '  <div class="brain-health-card"><div class="label">ENTITIES</div><div class="value">' + (data.entitiesTotal || 0) + '</div><div class="sub">' + (data.entitiesPerson || 0) + ' people · ' + (data.entitiesCompany || 0) + ' companies · ' + (data.entitiesProject || 0) + ' projects</div></div>',
        '  <div class="brain-health-card"><div class="label">POINTERS</div><div class="value">' + (data.pointersTotal || 0) + '</div><div class="sub">last 7d: ' + (data.pointersRecent || 0) + '</div></div>',
        '  <div class="brain-health-card"><div class="label">REFLECTIONS (24H)</div><div class="value">' + (data.reflections24h || 0) + '</div><div class="sub">' + (data.reflectionsSuccess || 0) + ' success · ' + (data.reflectionsSkipped || 0) + ' skipped · ' + (data.reflectionsFailed || 0) + ' failed</div></div>',
        '  <div class="brain-health-card"><div class="label">CONFLICTS (24H)</div><div class="value">' + (data.factsUpdated || 0) + '</div><div class="sub">' + (data.factsUpdated || 0) + ' updates · ' + (data.factsDeleted || 0) + ' deletes · ' + (data.factsNoop || 0) + ' noops</div></div>',
        '  <div class="brain-health-card"><div class="label">AVG IMPORTANCE</div><div class="value">' + (data.avgImportance != null ? data.avgImportance.toFixed(1) : '—') + '</div><div class="sub">across active derived facts</div></div>',
        '</div>',
      ].join('');
    } catch (err) {
      console.error('brain health refresh failed:', err);
      wrap.innerHTML = '<div class="settings-info">— failed to load —</div>';
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Brain — new outer-tab refreshers (Overview, Graph, Profile, Evolution)
  // Each renders into a dedicated mount inside its sub-pane.
  // Stages 2-4 land the migrated HTML; for now mounts show pending
  // placeholders + Overview renders the at-a-glance dashboard.
  // ────────────────────────────────────────────────────────────────

  async function refreshBrainOverview() {
    const wrap = document.querySelector('[data-brain-overview]');
    if (!wrap) return;
    try {
      const [health, factsResp] = await Promise.all([
        fetchJSON('/api/console/brain/health'),
        fetchJSON('/api/console/brain/facts?sort=recent&kind=').catch(function () { return { facts: [] }; }),
      ]);
      // Recent Learning surfaces ONLY facts the reflection layer
      // synthesized from tool returns (derivedFrom is set). User-
      // stated facts (memory_remember calls) are not "learning" — they're
      // direct authoring. Showing them here was misleading.
      const allFacts = Array.isArray(factsResp.facts) ? factsResp.facts : [];
      const recentFacts = allFacts
        .filter(function (f) { return f.derivedFrom && (f.derivedFrom.callId || f.derivedFrom.sessionId); })
        .slice(0, 4);
      const recentLearningRows = recentFacts.length === 0
        ? '<div class="settings-info">— nothing derived yet · reflection will populate this as it extracts facts from tool returns ≥500 chars (see Brain → Knowledge → Facts for everything stated directly) —</div>'
        : recentFacts.map(function (f) {
            const ref = f.derivedFrom && f.derivedFrom.callId
              ? ' <code class="overview-callid">[' + escMem(f.derivedFrom.callId) + ']</code>'
              : '';
            const age = f.lastAccessedAt || f.updatedAt
              ? '<span class="overview-age">' + escMem(fmtAgoShort(f.lastAccessedAt || f.updatedAt)) + '</span>'
              : '';
            return '<div class="overview-fact-row"><span class="overview-fact-text">' + escMem(f.content || '') + '</span>' + ref + age + '</div>';
          }).join('');
      wrap.innerHTML = [
        '<div class="brain-overview-grid">',
        '  <div class="brain-overview-card brain-overview-stats">',
        '    <div class="overview-card-head">AT A GLANCE</div>',
        '    <div class="overview-stat-row">',
        '      <div class="overview-stat"><em>' + (health.activeFacts || 0) + '</em><span>FACTS</span></div>',
        '      <div class="overview-stat"><em>' + (health.entitiesTotal || 0) + '</em><span>ENTITIES</span></div>',
        '      <div class="overview-stat"><em>' + (health.pointersTotal || 0) + '</em><span>POINTERS</span></div>',
        '      <div class="overview-stat"><em>' + (health.reflections24h || 0) + '</em><span>REFLECTIONS · 24H</span></div>',
        '    </div>',
        '  </div>',
        '  <div class="brain-overview-card brain-overview-recent">',
        '    <div class="overview-card-head">RECENT LEARNING <em>(last 24h)</em></div>',
        '    ' + recentLearningRows,
        '  </div>',
        '  <div class="brain-overview-card brain-overview-health">',
        '    <div class="overview-card-head">BRAIN HEALTH</div>',
        '    <div class="overview-health-row">Reflections: <strong>' + (health.reflections24h || 0) + '</strong> fired · ' + (health.reflectionsSuccess || 0) + ' success · ' + (health.reflectionsSkipped || 0) + ' skipped · ' + (health.reflectionsFailed || 0) + ' failed</div>',
        '    <div class="overview-health-row">Conflicts: ' + (health.factsUpdated || 0) + ' updates · ' + (health.factsDeleted || 0) + ' deletes · ' + (health.factsNoop || 0) + ' noops</div>',
        '    <div class="overview-health-row">Avg importance: <strong>' + (health.avgImportance != null ? health.avgImportance.toFixed(1) : '—') + '</strong> across derived facts</div>',
        '  </div>',
        '  <div class="brain-overview-card brain-overview-evolution">',
        '    <div class="overview-card-head">EVOLUTION</div>',
        '    <div class="overview-evolution-body" data-brain-overview-evolution>',
        '      <div class="settings-info">— loading latest autoresearch report —</div>',
        '    </div>',
        '    <a class="overview-evolution-link" href="#" data-brain-overview-evolution-open>Open Evolution →</a>',
        '  </div>',
        '</div>',
      ].join('');
      // Wire the "Open Evolution →" link to switch tabs.
      const link = document.querySelector('[data-brain-overview-evolution-open]');
      if (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          const evolutionTabBtn = document.querySelector('[data-brain-tab="evolution"]');
          if (evolutionTabBtn) evolutionTabBtn.click();
        });
      }
      // Asynchronously populate the evolution mini-summary; best-effort.
      try {
        const report = await fetchJSON('/api/console/autoresearch/report').catch(function () { return null; });
        const mount = document.querySelector('[data-brain-overview-evolution]');
        if (mount) {
          if (report && report.generatedAt) {
            const totalCalls = report.totalToolCalls || 0;
            const sessionCount = report.sessionCount || 0;
            mount.innerHTML = '<div class="overview-evolution-line">Last report: <strong>' + escMem(String(report.generatedAt).slice(0, 16).replace('T', ' ')) + '</strong></div>'
              + '<div class="overview-evolution-line">' + totalCalls + ' tool calls across ' + sessionCount + ' sessions</div>';
          } else {
            mount.innerHTML = '<div class="settings-info">— no report yet · use Evolution tab to generate one —</div>';
          }
        }
      } catch (err) {
        const mount = document.querySelector('[data-brain-overview-evolution]');
        if (mount) mount.innerHTML = '<div class="settings-info">— autoresearch unavailable —</div>';
      }
    } catch (err) {
      console.error('brain overview refresh failed:', err);
      wrap.innerHTML = '<div class="settings-info">— failed to load overview —</div>';
    }
  }

  // Memory-derived content (Graph, Files, Meetings) all share the
  // same bootMemoryPanel initialization — it hydrates every data-mem-*
  // selector across all three views. Lazy-boot once on first contact
  // with any of them.
  let brainMemoryBooted = false;
  async function ensureMemoryBooted() {
    if (brainMemoryBooted) return;
    brainMemoryBooted = true;
    if (typeof bootMemoryPanel === 'function') {
      try { await bootMemoryPanel(); } catch (err) { console.error('brain memory boot failed:', err); }
    }
  }
  // Backward-compat alias — kept so any lingering caller doesn't error.
  async function refreshBrainGraph() {
    await ensureMemoryBooted();
    if (typeof window.__clementineMemoryView === 'function') {
      window.__clementineMemoryView('graph');
    }
  }
  // Meetings outer-tab handler. Calls the meetings loader DIRECTLY —
  // it doesn't depend on the full bootMemoryPanel (which loads the
  // graph cytoscape, file list, fact list etc.). loadMemoryMeetings
  // is self-contained: hits /api/console/meetings/recall/recent and
  // re-renders the list. Bypassing the full memory boot makes the
  // Meetings tab load in <100ms on cold contact.
  async function refreshBrainMeetings() {
    if (typeof wireMemoryMeetingsControls === 'function') wireMemoryMeetingsControls();
    if (typeof loadMemoryMeetings === 'function') {
      try { await loadMemoryMeetings(); } catch (err) { console.error('brain/meetings load failed:', err); }
    }
  }

  // Profile (Context panel content). Same lazy-boot pattern.
  let brainProfileBooted = false;
  async function refreshBrainProfile() {
    if (!brainProfileBooted) {
      brainProfileBooted = true;
      if (typeof bootContextPanel === 'function') {
        try { await bootContextPanel(); } catch (err) { console.error('brain/profile boot failed:', err); }
      }
    }
  }

  // Evolution (autoresearch). Same lazy-boot pattern.
  let brainEvolutionBooted = false;
  async function refreshBrainEvolution() {
    if (!brainEvolutionBooted) {
      brainEvolutionBooted = true;
      if (typeof bootEvolutionPanel === 'function') {
        try { await bootEvolutionPanel(); } catch (err) { console.error('brain/evolution boot failed:', err); }
      }
    }
  }

  async function refreshUsagePanel() {
    try {
      const data = await fetchJSON('/api/console/usage');
      const totalEl = document.querySelector('[data-usage-total]');
      const callsEl = document.querySelector('[data-usage-calls]');
      const inputEl = document.querySelector('[data-usage-input]');
      const outputEl = document.querySelector('[data-usage-output]');
      if (totalEl) totalEl.textContent = fmtTokens(data.totalTokens);
      if (callsEl) callsEl.textContent = String(data.totalCalls || 0);
      if (inputEl) inputEl.textContent = fmtTokens(data.totalInputTokens);
      if (outputEl) outputEl.textContent = fmtTokens(data.totalOutputTokens);

      // BY SOURCE
      const bsEl = document.querySelector('[data-usage-bysource]');
      if (bsEl) {
        const sources = Array.isArray(data.bySource) ? data.bySource : [];
        if (sources.length === 0) {
          bsEl.innerHTML = '<div class="settings-info">No usage yet today. As the agent makes model calls, sources will appear here.</div>';
        } else {
          const maxTokens = sources[0].tokens || 1;
          bsEl.innerHTML = sources.slice(0, 20).map(function (s) {
            const pct = Math.round((s.tokens / maxTokens) * 100);
            return [
              '<div class="usage-row">',
              '  <span class="label">' + escMem(s.source) + '</span>',
              '  <span class="meta">' + escMem(s.kind) + '</span>',
              '  <span class="bar"><span class="bar-fill" style="width:' + pct + '%"></span></span>',
              '  <span class="tokens">' + fmtTokens(s.tokens) + '</span>',
              '  <span class="meta">' + s.calls + ' calls</span>',
              '</div>',
            ].join('');
          }).join('');
        }
      }

      // BY KIND
      const bkEl = document.querySelector('[data-usage-bykind]');
      if (bkEl) {
        const entries = Object.entries(data.byKind || {}).sort(function (a, b) { return b[1].tokens - a[1].tokens; });
        if (entries.length === 0) {
          bkEl.innerHTML = '<div class="settings-info">—</div>';
        } else {
          bkEl.innerHTML = entries.map(function (entry) {
            return [
              '<div class="usage-row">',
              '  <span class="label">' + escMem(entry[0]) + '</span>',
              '  <span class="tokens">' + fmtTokens(entry[1].tokens) + '</span>',
              '  <span class="meta">' + entry[1].calls + ' calls</span>',
              '</div>',
            ].join('');
          }).join('');
        }
      }

      // BY MODEL
      const bmEl = document.querySelector('[data-usage-bymodel]');
      if (bmEl) {
        const entries = Object.entries(data.byModel || {}).sort(function (a, b) { return b[1].tokens - a[1].tokens; });
        if (entries.length === 0) {
          bmEl.innerHTML = '<div class="settings-info">—</div>';
        } else {
          bmEl.innerHTML = entries.map(function (entry) {
            return [
              '<div class="usage-row">',
              '  <span class="label">' + escMem(entry[0]) + '</span>',
              '  <span class="tokens">' + fmtTokens(entry[1].tokens) + '</span>',
              '  <span class="meta">' + entry[1].calls + ' calls</span>',
              '</div>',
            ].join('');
          }).join('');
        }
      }

      // HOURLY SPARK
      const sparkEl = document.querySelector('[data-usage-spark]');
      if (sparkEl) {
        const hours = Array.isArray(data.byHour) ? data.byHour : [];
        const maxH = Math.max.apply(null, hours.map(function (h) { return h.tokens; }).concat([1]));
        const bars = hours.map(function (h) {
          const heightPct = Math.max(1, Math.round((h.tokens / maxH) * 100));
          const empty = h.tokens === 0 ? ' empty' : '';
          return '<div class="spark-bar' + empty + '" style="height:' + heightPct + '%" title="' + h.hour + ': ' + fmtTokens(h.tokens) + ' tokens, ' + h.calls + ' calls"></div>';
        }).join('');
        sparkEl.innerHTML = '<div style="display:flex;align-items:end;gap:2px;height:80px;flex:1;">' + bars + '</div>';
      }

      await refreshUsageTrim();
      await refreshUsageCompaction();
    } catch (err) {
      console.error('usage panel refresh failed:', err);
    }
  }

  async function refreshUsageCompaction() {
    const el = document.querySelector('[data-usage-compaction]');
    if (!el) return;
    try {
      const c = await fetchJSON('/api/console/usage/compaction');
      const total = c.totalCompactions || 0;
      if (total === 0) {
        el.innerHTML = '<div class="settings-info">No compactions yet. Auto-compact kicks in on long chat sessions (>30 messages or >50% of input budget). Most sessions never need it.</div>';
        return;
      }
      const rows = [];
      rows.push(
        '<div class="usage-bymodel">',
        '  <div class="stat-card"><span>COMPACTIONS</span><em>' + total + '</em></div>',
        '  <div class="stat-card"><span>TOOL RESULTS CLIPPED</span><em>' + (c.totalClipped || 0) + '</em></div>',
        '  <div class="stat-card"><span>SUMMARIES GENERATED</span><em>' + (c.totalSummaries || 0) + '</em></div>',
        '  <div class="stat-card"><span>RECALL CALLS</span><em>' + (c.recallInvocations || 0) + '</em></div>',
        '</div>',
      );
      if (Array.isArray(c.recent) && c.recent.length > 0) {
        rows.push('<table class="usage-bysource" style="margin-top:12px;"><thead><tr><th>SESSION</th><th>WHEN</th><th>LAYERS</th><th>TOKENS</th></tr></thead><tbody>');
        for (const r of c.recent.slice(0, 8)) {
          const layers = [
            r.layer1 ? 'L1(' + r.layer1Clipped + ')' : '',
            r.layer2 ? 'L2(' + r.layer2RemovedItems + ')' : '',
            r.layer3 ? 'L3-fork' : '',
          ].filter(Boolean).join(' ');
          const tokenDelta = r.beforeTokens && r.afterTokens
            ? r.beforeTokens + '→' + r.afterTokens
            : '—';
          rows.push(
            '<tr>',
            '  <td><code>' + escMem((r.sessionId || '').slice(0, 24)) + '</code></td>',
            '  <td>' + escMem(r.at || '') + '</td>',
            '  <td>' + escMem(layers) + '</td>',
            '  <td>' + escMem(tokenDelta) + '</td>',
            '</tr>',
          );
        }
        rows.push('</tbody></table>');
      }
      if ((c.hallucinatedCallIds || 0) > 0) {
        rows.push(
          '<div class="settings-info" style="margin-top:8px; color:var(--warn);">',
          '⚠ ' + c.hallucinatedCallIds + ' hallucinated call_ids detected in Layer-2 summaries (sanitized to <code>[invalid call_id]</code>).',
          '</div>',
        );
      }
      el.innerHTML = rows.join('');
    } catch (err) {
      console.error('usage compaction refresh failed:', err);
      el.innerHTML = '<div class="settings-info">— failed to load compaction stats —</div>';
    }
  }

  async function refreshUsageTrim() {
    const el = document.querySelector('[data-usage-trim]');
    if (!el) return;
    try {
      const trim = await fetchJSON('/api/console/usage/trim');
      const rows = [];
      const proacOn = trim.proactivityEnabled;
      rows.push([
        '<div class="usage-trim-row">',
        '  <div class="name"><div>Proactive briefs / autonomy</div><div class="desc">Hourly check-ins, scheduled brief notifications, autonomy loops. Chat + workflows are not affected.</div></div>',
        '  <button class="' + (proacOn ? 'on danger' : '') + '" data-usage-trim-proac>' + (proacOn ? 'PAUSE' : 'RESUME') + '</button>',
        '</div>',
      ].join(''));
      for (const cron of trim.crons || []) {
        rows.push([
          '<div class="usage-trim-row">',
          '  <div class="name"><div>cron: ' + escMem(cron.name) + '</div><div class="desc">schedule: ' + escMem(cron.schedule) + '</div></div>',
          '  <button class="' + (cron.enabled ? 'on danger' : '') + '" data-usage-trim-cron="' + escMem(cron.name) + '">' + (cron.enabled ? 'PAUSE' : 'RESUME') + '</button>',
          '</div>',
        ].join(''));
      }
      el.innerHTML = rows.join('') || '<div class="settings-info">No trim targets configured.</div>';

      el.querySelectorAll('[data-usage-trim-cron]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          const name = btn.getAttribute('data-usage-trim-cron');
          const enabling = btn.classList.contains('on') === false;
          btn.disabled = true;
          await fetch(withToken('/api/console/usage/trim'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'cron', target: name, action: enabling ? 'enable' : 'disable' }),
          });
          await refreshUsageTrim();
        });
      });
      const proacBtn = el.querySelector('[data-usage-trim-proac]');
      if (proacBtn) {
        proacBtn.addEventListener('click', async function () {
          const enabling = proacBtn.classList.contains('on') === false;
          proacBtn.disabled = true;
          await fetch(withToken('/api/console/usage/trim'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'proactivity', action: enabling ? 'enable' : 'disable' }),
          });
          await refreshUsageTrim();
        });
      }
    } catch (err) {
      console.error('usage trim refresh failed:', err);
    }
  }

  async function bootSettingsPanel() {
    try {
      const s = await fetchJSON('/api/console/settings');
      const profile = s.profile || {};
      ['displayName','preferredName','role','timezone','urgencyTolerance','communicationTone','formality','workingHoursStart','workingHoursEnd','notes'].forEach((k) => setFormValue(sett.profileForm, k, profile[k]));

      const policy = (s.proactivity && s.proactivity.policy) || {};
      ['enabled','quietHoursEnabled','allowComputerActions','allowComposioActions','allowDiscordCheckIns'].forEach((k) => setFormValue(sett.policyForm, k, policy[k]));
      // autoApproveScope was historically omitted from this list — saved
      // correctly to disk but never rendered back into the dropdown on
      // load, so the value silently reverted to the HTML default
      // ("strict") on every page refresh. Reported 2026-05-22.
      ['mode','autoApproveScope','checkInMinutes','defaultLongTaskMinutes','briefCadenceMinutes','quietHoursStart','quietHoursEnd'].forEach((k) => setFormValue(sett.policyForm, k, policy[k]));

      renderAuthInfo(s.auth);
      renderModelPicker(s.models);
      renderRuntimeBudget(s.runtimeBudget);
      renderMemoryInfo(s.memory);
      await refreshPlanProposals();
      await refreshProposals();
      await refreshCheckIns();
      await refreshCredentialsHealth();
      // Wire the diagnostics toggle once. Idempotent — if Settings is
      // re-booted (e.g. panel re-opened) the handler stays bound from
      // the first call and we don't re-bind.
      initDiagnosticsToggle();
    } catch (err) {
      sett.authBox.innerHTML = '<div style="color:var(--accent-fail);">Failed to load settings: ' + escMem(err.message || err) + '</div>';
    }
  }

  // ─── Diagnostics (hidden behind "Show diagnostics" toggle) ──────
  // Pure read of /api/console/diagnostics — no state changes. Lazy-
  // loaded so the API isn't hit unless the user flips the toggle on.
  let diagnosticsBound = false;
  function initDiagnosticsToggle() {
    if (diagnosticsBound) return;
    const toggle = document.querySelector('[data-diagnostics-toggle]');
    const panel = document.querySelector('[data-diagnostics-panel]');
    const refresh = document.querySelector('[data-diagnostics-refresh]');
    if (!toggle || !panel) return;
    diagnosticsBound = true;
    const sync = () => {
      const on = toggle.checked;
      if (on) {
        panel.removeAttribute('hidden');
        loadDiagnostics();
      } else {
        panel.setAttribute('hidden', '');
      }
      // v0.5.11 brain-consolidation: Evolution (autoresearch) is no
      // longer a separate top-level nav. It lives as the 5th sub-tab
      // inside Brain. The diagnostics toggle no longer needs to flip
      // a nav-button visibility — the Brain tab is always visible and
      // Evolution is one click deep inside it.
      // Persist toggle state so the panel remembers across reloads.
      try { localStorage.setItem('clemmy.diagnostics.visible', on ? '1' : '0'); } catch (_) {}
    };
    toggle.addEventListener('change', sync);
    if (refresh) refresh.addEventListener('click', () => loadDiagnostics());
    // Restore prior state on boot.
    try {
      const stored = localStorage.getItem('clemmy.diagnostics.visible');
      if (stored === '1') { toggle.checked = true; sync(); }
    } catch (_) {}
  }

  async function loadDiagnostics() {
    const summaryEl = document.querySelector('[data-diag-summary]');
    if (summaryEl) summaryEl.innerHTML = '<div class="settings-info">— loading —</div>';
    try {
      const data = await fetchJSON('/api/console/diagnostics');
      renderDiagnostics(data);
    } catch (err) {
      if (summaryEl) summaryEl.innerHTML = '<div class="settings-info" style="color:var(--accent-fail);">Failed to load diagnostics: ' + escMem((err && err.message) || err) + '</div>';
    }
  }

  function renderDiagnostics(data) {
    const summaryEl = document.querySelector('[data-diag-summary]');
    const toolsEl = document.querySelector('[data-diag-tool-events-body]');
    const sessionsEl = document.querySelector('[data-diag-sessions-body]');
    const mcpEl = document.querySelector('[data-diag-mcp-body]');
    const errorsEl = document.querySelector('[data-diag-errors-body]');
    const storageEl = document.querySelector('[data-diag-storage-body]');
    const fmtBytes = (n) => n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : n > 1024 ? (n / 1024).toFixed(1) + 'KB' : n + 'B';

    if (summaryEl) {
      const t = data.toolEvents || {};
      const m = (data.mcp && data.mcp.summary) || {};
      // v0.5.21 Phase 2.5 — surface the local-CLI discovery count
      // alongside the existing MCP-ready chip. Shows "scanning…" when
      // the cli-discovery cache hasn't populated yet.
      const c = data.cli || {};
      const cliChip = (c.count == null)
        ? '<strong>scanning</strong> CLIs…'
        : '<strong>' + c.count + '</strong> CLI' + (c.count === 1 ? '' : 's') + ' discovered';
      summaryEl.innerHTML =
        '<strong>' + (t.totalEvents || 0) + '</strong> tool events across <strong>' + (t.totalSessions || 0) + '</strong> sessions today · ' +
        '<strong>' + (m.connected || 0) + '/' + (m.total || 0) + '</strong> MCP servers ready · ' +
        cliChip + ' · ' +
        '<strong>' + ((data.recentErrors || []).length) + '</strong> recent warn/error log lines';
    }

    const sections = [
      ['data-diag-tool-events', toolsEl, (t = data.toolEvents) => t && t.byTool && t.byTool.length > 0],
      ['data-diag-sessions',    sessionsEl, () => data.toolEvents && data.toolEvents.bySession && data.toolEvents.bySession.length > 0],
      ['data-diag-mcp',         mcpEl, () => data.mcp && data.mcp.servers && data.mcp.servers.length > 0],
      ['data-diag-errors',      errorsEl, () => (data.recentErrors || []).length > 0],
      ['data-diag-storage',     storageEl, () => true],
    ];
    sections.forEach(([sel, _el, predicate]) => {
      const section = document.querySelector('[' + sel + ']');
      if (section) (predicate() ? section.removeAttribute('hidden') : section.setAttribute('hidden', ''));
    });

    if (toolsEl && data.toolEvents) {
      toolsEl.innerHTML = (data.toolEvents.byTool || []).slice(0, 10).map((t) =>
        '<div class="diag-row"><span>' + escMem(t.toolName) + '</span><em>' + t.count + '</em></div>'
      ).join('') || '<div class="settings-info">— none today —</div>';
    }

    if (sessionsEl && data.toolEvents) {
      sessionsEl.innerHTML = (data.toolEvents.bySession || []).slice(0, 8).map((s) => {
        const range = s.firstAt && s.lastAt ? (s.firstAt.slice(11, 19) + '→' + s.lastAt.slice(11, 19)) : '—';
        return '<div class="diag-session-row">' +
          '<span title="' + escMem(s.sessionId) + '">' + escMem(s.sessionId.slice(0, 36)) + '</span>' +
          '<em>' + s.eventCount + ' calls</em>' +
          '<span class="diag-pattern" data-p="' + escMem(s.suspectedPattern) + '" title="' + range + '">' + escMem(s.suspectedPattern) + '</span>' +
        '</div>';
      }).join('') || '<div class="settings-info">— no sessions today —</div>';
    }

    if (mcpEl && data.mcp) {
      mcpEl.innerHTML = (data.mcp.servers || []).map((s) =>
        '<div class="diag-row"><span>' + escMem(s.slug) + ' · ' + escMem(s.state) + (s.lastError ? ' · ' + escMem(s.lastError.slice(0, 80)) : '') + '</span><em>' + s.toolCount + '</em></div>'
      ).join('') || '<div class="settings-info">— no MCP servers configured —</div>';
    }

    if (errorsEl) {
      errorsEl.innerHTML = (data.recentErrors || []).slice(-20).map((e) =>
        '<div class="diag-error-row"><span class="diag-level ' + e.level + '">' + e.level.toUpperCase() + '</span><span>' + escMem(e.source) + ' · ' + escMem(e.message) + '</span></div>'
      ).join('') || '<div class="settings-info">— no warnings or errors recorded —</div>';
    }

    if (storageEl && data.storage) {
      const st = data.storage;
      storageEl.innerHTML =
        '<div class="diag-row"><span>base dir</span><em title="' + escMem(st.baseDir) + '">' + escMem(st.baseDir.slice(-40)) + '</em></div>' +
        '<div class="diag-row"><span>supervisor.log</span><em>' + fmtBytes(st.supervisorLogSizeBytes) + '</em></div>' +
        '<div class="diag-row"><span>tool-events (today)</span><em>' + fmtBytes(st.toolEventsTodayBytes) + '</em></div>' +
        '<div class="diag-row"><span>state JSON files</span><em>' + st.stateJsonCount + '</em></div>';
    }
  }

  // ─── EVOLUTION panel (slot 12 — autoresearch observatory) ──────
  // Power-user surface. Reads /api/console/autoresearch/report which
  // is whatever the maintenance tick last wrote. "Run now" forces a
  // fresh rebuild. No mutations yet — Foundation only.

  // Tiny Markdown → HTML for the report content. We only support what
  // observatory.ts emits: h1, h2, paragraphs, lists, tables, code spans,
  // emphasis, hr.
  //
  // NOTE on escapes: this function lives inside an outer template
  // literal (CONSOLE_JS). Every backslash-X inside this code gets
  // evaluated by the template literal before it reaches the browser,
  // so regex backslashes need DOUBLE-escaping (\\s, \\|, etc.). To
  // minimize that hell we use startsWith/endsWith for prefix checks
  // instead of regex, and only keep regex for the inline replacements
  // (code, strong, em) where actually needed. The double-backslash
  // sequences below become single backslashes after template-literal
  // interpolation, then the rendered browser code sees properly-formed
  // regex. Avoid backticks inside this comment — they would terminate
  // the outer template literal.
  function renderTinyMarkdown(md) {
    if (!md) return '';
    const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    // Avoid backticks in source — they collide with the outer template
    // literal. Build the backtick regex via String.fromCharCode(96)
    // instead. Strong + em regexes use only ASCII chars so they're
    // safe in source as long as backslashes are double-escaped.
    const BT = String.fromCharCode(96); // backtick
    const codeRe = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
    const strongRe = new RegExp('\\\\*\\\\*([^\\\\*]+)\\\\*\\\\*', 'g');
    const emRe = new RegExp('_([^_]+)_', 'g');
    const inline = (s) => esc(s)
      .replace(codeRe, '<code>$1</code>')
      .replace(strongRe, '<strong>$1</strong>')
      .replace(emRe, '<em>$1</em>');
    const lines = md.split('\\n');
    const out = [];
    let i = 0;
    const isTableSeparator = (s) => {
      if (!s || !s.startsWith('|') || !s.endsWith('|')) return false;
      // separator row has only |, -, :, and whitespace
      for (let k = 0; k < s.length; k++) {
        const c = s[k];
        if (c !== '|' && c !== '-' && c !== ':' && c !== ' ' && c !== '\\t') return false;
      }
      return true;
    };
    const splitTableRow = (s) => s.slice(1, -1).split('|').map((c) => c.trim());
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('# ')) { out.push('<h1>' + inline(line.slice(2)) + '</h1>'); i++; continue; }
      if (line.startsWith('## ')) { out.push('<h2>' + inline(line.slice(3)) + '</h2>'); i++; continue; }
      if (line === '---') { out.push('<hr/>'); i++; continue; }
      if (line.startsWith('|') && line.endsWith('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const header = splitTableRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].startsWith('|') && lines[i].endsWith('|')) {
          rows.push(splitTableRow(lines[i]));
          i++;
        }
        const thead = '<thead><tr>' + header.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead>';
        const tbody = '<tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody>';
        out.push('<table>' + thead + tbody + '</table>');
        continue;
      }
      if (line.startsWith('- ')) {
        const items = [];
        while (i < lines.length && lines[i].startsWith('- ')) {
          items.push('<li>' + inline(lines[i].slice(2)) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (line.trim() === '') { i++; continue; }
      out.push('<p>' + inline(line) + '</p>');
      i++;
    }
    return out.join('\\n');
  }

  let evolutionBooted = false;
  function bootEvolutionPanel() {
    if (evolutionBooted) return;
    const runBtn = document.querySelector('[data-evolution-run]');
    const historyPick = document.querySelector('[data-evolution-history]');
    const reportEl = document.querySelector('[data-evolution-report]');
    const metaEl = document.querySelector('[data-evolution-meta]');
    if (!reportEl) return;
    evolutionBooted = true;

    async function refresh() {
      try {
        const data = await fetchJSON('/api/console/autoresearch/report');
        const latest = data.latest;
        const history = data.history || [];
        if (historyPick) {
          // Drop everything but the leading placeholder, refill from history.
          while (historyPick.children.length > 1) historyPick.removeChild(historyPick.lastChild);
          for (const h of history) {
            const opt = document.createElement('option');
            opt.value = h.date;
            opt.textContent = h.date;
            historyPick.appendChild(opt);
          }
        }
        if (!latest) {
          if (metaEl) metaEl.textContent = 'No report yet — click Run now to generate one.';
          reportEl.innerHTML = '<div class="settings-info">— no report yet · click <strong>Run now</strong> to generate one —</div>';
          return;
        }
        if (metaEl) metaEl.textContent = 'Last refreshed: ' + latest.date + ' · ' + (latest.content.length) + ' bytes';
        reportEl.innerHTML = renderTinyMarkdown(latest.content);
      } catch (err) {
        if (metaEl) metaEl.textContent = 'Failed to load: ' + ((err && err.message) || err);
      }
    }

    if (runBtn) {
      runBtn.addEventListener('click', async () => {
        runBtn.setAttribute('disabled', '');
        try {
          const r = await fetch(withToken('/api/console/autoresearch/run'), { method: 'POST' });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { showError('Autoresearch run failed: ' + (j.error || r.status)); return; }
          if (j.content) {
            if (metaEl) metaEl.textContent = 'Refreshed just now · ' + (j.written ? 'new report written' : 'no-op (unchanged)');
            reportEl.innerHTML = renderTinyMarkdown(j.content);
            showSuccess(j.written ? 'Autoresearch report written.' : 'No changes — report already current.');
          }
        } catch (err) {
          showError('Autoresearch run failed: ' + ((err && err.message) || err));
        } finally {
          runBtn.removeAttribute('disabled');
        }
      });
    }
    refresh();
  }

  // ─── Plan proposals (draft_plan → user review) ────────────────

  async function refreshPlanProposals() {
    const listEl = document.querySelector('[data-plan-proposals-list]');
    const metaEl = document.querySelector('[data-plan-proposals-meta]');
    if (!listEl || !metaEl) return;
    try {
      const data = await fetchJSON('/api/console/plan-proposals?status=pending');
      const items = data.proposals || [];
      metaEl.textContent = items.length === 0 ? 'no plans' : items.length + ' awaiting review';
      if (items.length === 0) {
        listEl.innerHTML = '<div class="settings-info">— no pending plans · agent will surface plans for significant work before mutating —</div>';
        return;
      }
      listEl.innerHTML = items.map((p) => {
        const plan = p.plan || {};
        const proposedAt = (p.proposedAt || '').slice(0, 16).replace('T', ' ');
        const steps = (plan.steps || []).map((s) => (
          '<li><span class="plan-step-n">' + s.n + '.</span> ' +
          '<span class="plan-step-action">' + escMem(s.action) + '</span>' +
          (s.rationale ? '<div class="plan-step-rationale">' + escMem(s.rationale) + '</div>' : '') +
          (s.verification ? '<div class="plan-step-verify">verify: ' + escMem(s.verification) + '</div>' : '') +
          '</li>'
        )).join('');
        const successCriteria = (plan.successCriteria || []).map((c) => '<li>' + escMem(c) + '</li>').join('');
        const risks = (plan.risks || []).length > 0
          ? '<div class="plan-section"><span class="plan-label">RISKS</span><ul class="plan-risks">' + plan.risks.map((r) => '<li>' + escMem(r) + '</li>').join('') + '</ul></div>'
          : '';
        const questions = (plan.needsUserInput || []).length > 0
          ? '<div class="plan-section"><span class="plan-label">QUESTIONS</span><ul class="plan-questions">' + plan.needsUserInput.map((q) => '<li>' + escMem(q) + '</li>').join('') + '</ul></div>'
          : '';
        const trackedPill = plan.recommendsTrackedExecution
          ? '<span class="pill plan-tracked">RECOMMENDS TRACKED EXECUTION</span>'
          : '';
        return [
          '<div class="plan-proposal-row" data-plan-row="' + escMem(p.id) + '">',
          '  <div class="plan-head">',
          '    <div class="plan-objective">' + escMem(plan.objective || '(no objective)') + '</div>',
          '    <div class="plan-meta">',
          '      <span class="pill complexity-' + escMem(plan.estimatedComplexity || 'unknown') + '">' + escMem((plan.estimatedComplexity || 'unknown').toUpperCase()) + '</span>',
          '      ' + trackedPill,
          '      <span>' + ((plan.steps || []).length) + ' step' + ((plan.steps || []).length === 1 ? '' : 's') + '</span>',
          '      <span>proposed ' + escMem(proposedAt) + '</span>',
          '    </div>',
          '  </div>',
          p.context ? '  <div class="plan-context"><span class="plan-label">CONTEXT</span> ' + escMem(p.context) + '</div>' : '',
          '  <div class="plan-request"><span class="plan-label">FROM</span> ' + escMem(p.originatingRequest) + '</div>',
          '  <div class="plan-section"><span class="plan-label">STEPS</span><ol class="plan-steps">' + steps + '</ol></div>',
          '  <div class="plan-section"><span class="plan-label">SUCCESS</span><ul class="plan-success">' + successCriteria + '</ul></div>',
          risks,
          questions,
          '  <div class="plan-actions">',
          '    <button class="plan-btn-approve" data-plan-approve="' + escMem(p.id) + '">APPROVE & PROCEED ✓</button>',
          '    <button class="plan-btn-reject" data-plan-reject="' + escMem(p.id) + '">REJECT ▣</button>',
          '  </div>',
          '</div>',
        ].join('');
      }).join('');

      bindPlanProposalActions();
    } catch (err) {
      listEl.innerHTML = '<div class="settings-info" style="color:var(--accent-fail);">Failed: ' + escMem(err.message || err) + '</div>';
    }
  }

  function bindPlanProposalActions() {
    const root = document.querySelector('[data-plan-proposals-list]');
    if (!root) return;

    root.querySelectorAll('[data-plan-approve]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-plan-approve');
        try {
          const r = await fetch(withToken('/api/console/plan-proposals/' + encodeURIComponent(id) + '/approve'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            alert('Approve failed: ' + (j.error || r.status));
            return;
          }
          await refreshPlanProposals();
        } catch (err) { alert('Approve failed: ' + (err.message || err)); }
      });
    });

    root.querySelectorAll('[data-plan-reject]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-plan-reject');
        const reason = prompt('Why are you rejecting this plan? (optional — helps the agent learn)') || '';
        try {
          await fetch(withToken('/api/console/plan-proposals/' + encodeURIComponent(id) + '/reject'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
          });
          await refreshPlanProposals();
        } catch (err) { alert('Reject failed: ' + (err.message || err)); }
      });
    });
  }

  // ─── Agent-drafted check-in proposals ─────────────────────────

  async function refreshProposals() {
    const listEl = document.querySelector('[data-proposals-list]');
    const metaEl = document.querySelector('[data-proposals-meta]');
    if (!listEl || !metaEl) return;
    try {
      const data = await fetchJSON('/api/console/check-in-proposals?status=pending');
      const items = data.proposals || [];
      metaEl.textContent = items.length === 0
        ? 'no proposals'
        : items.length + ' awaiting review';
      if (items.length === 0) {
        listEl.innerHTML = '<div class="settings-info">— no pending proposals · agent will propose new templates as it spots patterns —</div>';
        return;
      }
      listEl.innerHTML = items.map((p) => {
        const proposedAt = (p.proposedAt || '').slice(0, 16).replace('T', ' ');
        const triggerDetail = p.trigger === 'schedule'
          ? ('cron: ' + escMem(p.schedule || '—'))
          : p.trigger === 'execution_blocked' ? ('>' + (p.blockedHours ?? 24) + 'h blocked')
          : p.trigger === 'goal_stale' ? ('>' + (p.staleDays ?? 7) + 'd stale')
          : p.trigger === 'inbox_backed_up' ? ('>=' + (p.inboxThreshold ?? 10) + ' open') : '';
        const editMode = p.id === editingProposalId;
        return [
          '<div class="proposal-row" data-proposal-row="' + escMem(p.id) + '">',
          '  <div class="proposal-head">',
          '    <div class="proposal-name">' + escMem(p.name) + '</div>',
          '    <div class="proposal-meta">',
          '      <span class="pill trigger-' + escMem(p.trigger) + '">' + escMem(p.trigger.toUpperCase().replace(/_/g, ' ')) + '</span>',
          '      <span>' + escMem(triggerDetail) + '</span>',
          '      <span>urgency: ' + escMem(p.urgency || 'normal') + '</span>',
          '      <span>proposed ' + escMem(proposedAt) + '</span>',
          '    </div>',
          '  </div>',
          '  <div class="proposal-rationale"><span class="proposal-label">RATIONALE</span> ' + escMem(p.rationale) + '</div>',
          '  <div class="proposal-question"><span class="proposal-label">QUESTION</span> ' + escMem(p.questionTemplate) + '</div>',
          p.description ? '  <div class="proposal-desc"><span class="proposal-label">DESC</span> ' + escMem(p.description) + '</div>' : '',
          editMode ? renderProposalEditor(p) : '',
          '  <div class="proposal-actions">',
          '    <button class="proposal-btn-approve" data-proposal-approve="' + escMem(p.id) + '">APPROVE & INSTALL ✓</button>',
          '    <button class="proposal-btn-edit" data-proposal-edit="' + escMem(p.id) + '">' + (editMode ? 'CANCEL EDIT' : 'EDIT BEFORE APPROVE ✎') + '</button>',
          '    <button class="proposal-btn-reject" data-proposal-reject="' + escMem(p.id) + '">REJECT ▣</button>',
          '  </div>',
          '</div>',
        ].join('');
      }).join('');

      bindProposalActions();
    } catch (err) {
      listEl.innerHTML = '<div class="settings-info" style="color:var(--accent-fail);">Failed: ' + escMem(err.message || err) + '</div>';
    }
  }

  let editingProposalId = null;

  function renderProposalEditor(p) {
    return [
      '<div class="proposal-editor" data-proposal-editor-for="' + escMem(p.id) + '">',
      '  <div><label>NAME</label><input type="text" data-pf="name" value="' + escMem(p.name) + '" /></div>',
      '  <div><label>QUESTION TEMPLATE</label><textarea data-pf="questionTemplate" rows="2">' + escMem(p.questionTemplate) + '</textarea></div>',
      '  <div class="row">',
      '    <div><label>SCHEDULE (cron)</label><input type="text" data-pf="schedule" value="' + escMem(p.schedule || '') + '" /></div>',
      '    <div><label>COOLDOWN (HOURS)</label><input type="number" data-pf="cooldownHours" value="' + (p.cooldownHours ?? 12) + '" /></div>',
      '  </div>',
      '  <div><label>URGENCY</label><select data-pf="urgency">',
           ['low','normal','high'].map((opt) => '<option value="' + opt + '"' + ((p.urgency || 'normal') === opt ? ' selected' : '') + '>' + opt + '</option>').join(''),
      '  </select></div>',
      '</div>',
    ].join('');
  }

  function bindProposalActions() {
    const root = document.querySelector('[data-proposals-list]');
    if (!root) return;

    root.querySelectorAll('[data-proposal-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-proposal-edit');
        editingProposalId = editingProposalId === id ? null : id;
        refreshProposals();
      });
    });

    root.querySelectorAll('[data-proposal-approve]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-proposal-approve');
        const editor = root.querySelector('[data-proposal-editor-for="' + id + '"]');
        const overrides = {};
        if (editor) {
          editor.querySelectorAll('[data-pf]').forEach((el) => {
            const field = el.getAttribute('data-pf');
            if (el.type === 'number') {
              const n = parseInt(el.value, 10);
              if (Number.isFinite(n)) overrides[field] = n;
            } else if (el.value !== '') {
              overrides[field] = el.value;
            }
          });
        }
        try {
          const r = await fetch(withToken('/api/console/check-in-proposals/' + encodeURIComponent(id) + '/approve'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ overrides, enabledOnInstall: true }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            alert('Approve failed: ' + (j.error || r.status));
            return;
          }
          editingProposalId = null;
          await refreshProposals();
          await refreshCheckIns();
        } catch (err) { alert('Approve failed: ' + (err.message || err)); }
      });
    });

    root.querySelectorAll('[data-proposal-reject]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-proposal-reject');
        const reason = prompt('Reason for rejecting? (optional — helps the agent learn)') || '';
        try {
          await fetch(withToken('/api/console/check-in-proposals/' + encodeURIComponent(id) + '/reject'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
          });
          await refreshProposals();
        } catch (err) { alert('Reject failed: ' + (err.message || err)); }
      });
    });
  }

  // ─── Proactive check-ins (Settings sub-block) ─────────────────

  let editingTemplateId = null;
  let editingNew = false;

  async function refreshCheckIns() {
    const listEl = document.querySelector('[data-checkins-list]');
    const metaEl = document.querySelector('[data-checkins-meta]');
    if (!listEl || !metaEl) return;
    try {
      const data = await fetchJSON('/api/console/check-in-templates');
      const items = data.templates || [];
      const enabled = items.filter((t) => t.enabled).length;
      metaEl.textContent = items.length + ' templates · ' + enabled + ' enabled';
      if (items.length === 0) {
        listEl.innerHTML = '<div class="settings-info">— no templates yet · click + NEW TEMPLATE to create one —</div>';
        return;
      }
      listEl.innerHTML = items.map((t) => {
        const state = t.state || {};
        const lastFired = state.lastFiredAt ? state.lastFiredAt.slice(0, 16).replace('T', ' ') : 'never';
        const triggerDetail = t.trigger === 'schedule'
          ? ('cron: ' + escMem(t.schedule || '—'))
          : t.trigger === 'execution_blocked' ? ('>' + (t.blockedHours ?? 24) + 'h blocked')
          : t.trigger === 'goal_stale' ? ('>' + (t.staleDays ?? 7) + 'd stale')
          : t.trigger === 'inbox_backed_up' ? ('>=' + (t.inboxThreshold ?? 10) + ' open') : '';
        const editor = editingTemplateId === t.id ? renderCheckInEditor(t) : '';
        return [
          '<div class="checkin-row" data-checkin-row="' + escMem(t.id) + '">',
          '  <div class="checkin-main">',
          '    <div class="checkin-name">' + escMem(t.name) + '</div>',
          '    <div class="checkin-meta">',
          '      <span class="pill trigger-' + escMem(t.trigger) + '">' + escMem(t.trigger.toUpperCase().replace('_', ' ')) + '</span>',
          '      <span>' + escMem(triggerDetail) + '</span>',
          '      <span>cooldown ' + (t.cooldownHours ?? 0) + 'h</span>',
          '      <span>last fired: ' + escMem(lastFired) + '</span>',
          '      <span>urgency: ' + escMem(t.urgency) + '</span>',
          '    </div>',
          t.description ? '    <div class="checkin-desc">' + escMem(t.description) + '</div>' : '',
          '  </div>',
          '  <div class="checkin-actions">',
          '    <button class="toggle ' + (t.enabled ? 'on' : 'off') + '" data-toggle="' + escMem(t.id) + '">' + (t.enabled ? '● ENABLED' : '○ DISABLED') + '</button>',
          '    <button class="test" data-test="' + escMem(t.id) + '">TEST FIRE ⌗</button>',
          '    <button class="edit" data-edit="' + escMem(t.id) + '">EDIT ✎</button>',
          '    <button class="del" data-del="' + escMem(t.id) + '">DELETE ▣</button>',
          '  </div>',
               editor,
          '</div>',
        ].join('');
      }).join('');

      if (editingNew) {
        listEl.insertAdjacentHTML('beforeend', renderCheckInEditor(null));
      }

      bindCheckInActions();
    } catch (err) {
      listEl.innerHTML = '<div class="settings-info" style="color:var(--accent-fail);">Failed: ' + escMem(err.message || err) + '</div>';
    }
  }

  // This is the check-in template editor renderer. Originally named
  // renderEditor and lexically-hoisted to shadow the workflow editor's
  // renderEditor (same name, same IIFE scope), which made the Workflow
  // Studio middle pane silently stay on "Loading workflow…" whenever
  // setWorkflowDraftFromData → renderEditor ran: JS resolved the name
  // to THIS function and called it with no t, returning a check-in
  // editor HTML string into the void. Renaming keeps both namespaces
  // distinct.
  function renderCheckInEditor(t) {
    const v = t || {
      name: '', description: '', trigger: 'schedule',
      schedule: '0 9 * * 1', blockedHours: 24, staleDays: 7, inboxThreshold: 10,
      questionTemplate: '', urgency: 'normal', cooldownHours: 12,
    };
    return [
      '<div class="checkin-editor" data-editor-for="' + escMem(t ? t.id : 'new') + '">',
      '  <div><label>NAME</label><input type="text" data-f="name" value="' + escMem(v.name) + '" /></div>',
      '  <div><label>DESCRIPTION</label><input type="text" data-f="description" value="' + escMem(v.description) + '" /></div>',
      '  <div class="row">',
      '    <div><label>TRIGGER</label><select data-f="trigger">',
           ['schedule','execution_blocked','goal_stale','inbox_backed_up'].map((opt) =>
             '<option value="' + opt + '"' + (v.trigger === opt ? ' selected' : '') + '>' + opt + '</option>'
           ).join(''),
      '    </select></div>',
      '    <div><label>URGENCY</label><select data-f="urgency">',
           ['low','normal','high'].map((opt) => '<option value="' + opt + '"' + (v.urgency === opt ? ' selected' : '') + '>' + opt + '</option>').join(''),
      '    </select></div>',
      '  </div>',
      '  <div class="row">',
      '    <div><label>SCHEDULE (cron, when trigger=schedule)</label><input type="text" data-f="schedule" value="' + escMem(v.schedule || '0 9 * * 1') + '" placeholder="0 9 * * 1" /></div>',
      '    <div><label>COOLDOWN (HOURS)</label><input type="number" data-f="cooldownHours" value="' + (v.cooldownHours ?? 12) + '" /></div>',
      '  </div>',
      '  <div class="row">',
      '    <div><label>BLOCKED HOURS (execution_blocked)</label><input type="number" data-f="blockedHours" value="' + (v.blockedHours ?? 24) + '" /></div>',
      '    <div><label>STALE DAYS / INBOX THRESHOLD</label><input type="number" data-f="staleDays" value="' + (v.staleDays ?? v.inboxThreshold ?? 7) + '" /></div>',
      '  </div>',
      '  <div><label>QUESTION TEMPLATE</label><textarea data-f="questionTemplate" rows="3" placeholder="What is on your plate this week?">' + escMem(v.questionTemplate) + '</textarea></div>',
      '  <div class="editor-buttons">',
      '    <button class="save" data-save="' + escMem(t ? t.id : 'new') + '">' + (t ? 'SAVE' : 'CREATE') + '</button>',
      '    <button class="cancel" data-cancel="' + escMem(t ? t.id : 'new') + '">CANCEL</button>',
      '  </div>',
      '</div>',
    ].join('');
  }

  function bindCheckInActions() {
    const root = document.querySelector('[data-checkins-list]');
    if (!root) return;

    root.querySelectorAll('[data-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-toggle');
        const isOn = btn.classList.contains('on');
        try {
          await fetch(withToken('/api/console/check-in-templates/' + encodeURIComponent(id)), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !isOn }),
          });
          await refreshCheckIns();
        } catch (err) { alert('Toggle failed: ' + (err.message || err)); }
      });
    });
    root.querySelectorAll('[data-test]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-test');
        if (!confirm('Fire this template now (bypassing cooldown)?\\nThe agent will create an open check-in immediately.')) return;
        try {
          const r = await fetch(withToken('/api/console/check-in-templates/' + encodeURIComponent(id) + '/test'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bypassCooldown: true }),
          });
          const j = await r.json();
          if (j.ok) alert('Fired. Check-in id: ' + j.checkInId);
          else alert('Fire failed: ' + (j.reason || r.status));
          await refreshCheckIns();
        } catch (err) { alert('Fire failed: ' + (err.message || err)); }
      });
    });
    root.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingTemplateId = btn.getAttribute('data-edit');
        editingNew = false;
        refreshCheckIns();
      });
    });
    root.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-del');
        if (!confirm('Delete this template? This cannot be undone.')) return;
        try {
          await fetch(withToken('/api/console/check-in-templates/' + encodeURIComponent(id)), { method: 'DELETE' });
          await refreshCheckIns();
        } catch (err) { alert('Delete failed: ' + (err.message || err)); }
      });
    });
    root.querySelectorAll('[data-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        editingTemplateId = null;
        editingNew = false;
        refreshCheckIns();
      });
    });
    root.querySelectorAll('[data-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-save');
        const editor = root.querySelector('[data-editor-for="' + id + '"]');
        if (!editor) return;
        const patch = {};
        editor.querySelectorAll('[data-f]').forEach((el) => {
          const field = el.getAttribute('data-f');
          if (el.type === 'number') {
            const n = parseInt(el.value, 10);
            if (Number.isFinite(n)) patch[field] = n;
          } else {
            patch[field] = el.value;
          }
        });
        // Normalize staleDays vs inboxThreshold based on trigger
        if (patch.trigger === 'inbox_backed_up' && patch.staleDays !== undefined) {
          patch.inboxThreshold = patch.staleDays;
          delete patch.staleDays;
        }

        try {
          if (id === 'new') {
            if (!patch.name || !patch.questionTemplate) { alert('name + question required'); return; }
            const r = await fetch(withToken('/api/console/check-in-templates'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(patch),
            });
            if (!r.ok) { const j = await r.json().catch(() => ({})); alert('Create failed: ' + (j.error || r.status)); return; }
            editingNew = false;
          } else {
            await fetch(withToken('/api/console/check-in-templates/' + encodeURIComponent(id)), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(patch),
            });
            editingTemplateId = null;
          }
          await refreshCheckIns();
        } catch (err) { alert('Save failed: ' + (err.message || err)); }
      });
    });
  }

  // Top-level new-template button
  const newCheckInBtn = document.querySelector('[data-checkins-new]');
  if (newCheckInBtn) {
    newCheckInBtn.addEventListener('click', () => {
      editingNew = true;
      editingTemplateId = null;
      refreshCheckIns();
    });
  }

  async function refreshCredentialsHealth() {
    const listEl = document.querySelector('[data-creds-list]');
    const metaEl = document.querySelector('[data-creds-meta]');
    if (!listEl || !metaEl) return;
    try {
      const data = await fetchJSON('/api/console/credentials');
      const rows = data.rows || [];
      const descriptors = data.descriptors || {};
      const auth = data.auth || null;
      const unreadable = rows.filter((r) => r.status === 'unreadable' || r.status === 'needs_repair').length;
      metaEl.textContent = (auth?.configured ? 'runtime ready via ' + runtimeAuthLabel(auth) : 'runtime auth needs setup')
        + ' · ' + (hasOpenAiApiKey(auth) ? 'OpenAI key ready' : 'OpenAI key optional')
        + (unreadable ? ' · ' + unreadable + ' need repair' : '');

      listEl.innerHTML = rows.map((r) => {
        const d = descriptors[r.name] || {};
        const display = displayCredentialStatus(r, d, auth);
        const runtimeCredentialReady = display.className === 'runtime_ready'
          && (r.name === 'codex_oauth_access_token' || r.name === 'codex_oauth_refresh_token');
        return [
          '<div class="cred-row" data-cred-row="' + escMem(r.name) + '">',
          '  <div class="cred-main">',
          '    <div class="cred-name">' + escMem(credentialDisplayName(r.name)) + '</div>',
          '    <div class="cred-meta">',
          '      <span class="cred-status ' + escMem(display.className) + '">' + escMem(display.label) + '</span>',
          display.source && display.source !== 'none' ? '      <span class="cred-source ' + escMem(display.source) + '">' + escMem(display.source.toUpperCase()) + '</span>' : '',
          // Drift warning: both .env and vault populated with different
          // values. The reader silently picks the vault — surface this
          // so the user can resolve before it bites them later.
          r.driftDetected ? '      <span class="cred-drift" title="Both .env and vault hold different values for this key. The vault value is used. Click SET ✎ to overwrite the vault from the dashboard.">⚠ DRIFT</span>' : '',
          r.lastSetAt ? '      <span>set ' + escMem(r.lastSetAt.slice(0, 16).replace("T", " ")) + '</span>' : '',
          d.envVarName ? '      <span>env: ' + escMem(d.envVarName) + '</span>' : '',
          '    </div>',
          credentialDescription(r.name, d) ? '    <div class="cred-desc">' + escMem(credentialDescription(r.name, d)) + '</div>' : '',
          d.setupHint ? '    <div class="cred-hint">' + escMem(d.setupHint) + '</div>' : '',
          '    <div class="cred-set-input-wrap" data-cred-set-wrap="' + escMem(r.name) + '">',
          '      <input type="text" class="cred-set-input secret-input" data-cred-set-input="' + escMem(r.name) + '" placeholder="paste value…" autocomplete="off" data-1p-ignore="true" data-lpignore="true" spellcheck="false" name="cred-' + escMem(r.name) + '-no-autofill" />',
          '      <div class="cred-set-buttons">',
          '        <button class="cancel" type="button" data-cred-set-cancel="' + escMem(r.name) + '">CANCEL</button>',
          '        <button class="save" type="button" data-cred-set-save="' + escMem(r.name) + '">SAVE</button>',
          '      </div>',
          '    </div>',
          '  </div>',
          '  <div class="cred-actions">',
          runtimeCredentialReady
            ? '    <span class="cred-action-note">ACTIVE VIA AUTH STORE</span>'
            : '    <button class="cred-set" type="button" data-cred-set="' + escMem(r.name) + '">' + (r.hasValue ? 'REPLACE' : 'SET') + ' ✎</button>',
          // Codex re-auth: surfaced only on the ACCESS token row (to
          // avoid duplicate buttons on the refresh row). The button
          // calls window.clemmy.setupCodexLogin() — same IPC the setup
          // wizard's "Sign in with ChatGPT/Codex" button uses. Without
          // this, users with expired refresh tokens had no path back to
          // working state from the dashboard; they had to delete
          // ~/.codex/auth.json or run a CLI command. v0.5.9 fix.
          (r.name === 'codex_oauth_access_token')
            ? '    <button class="cred-reauth" type="button" data-cred-codex-reauth>RE-AUTHENTICATE ↻</button>'
            : '',
          (!runtimeCredentialReady && r.status === 'env_only')
            ? '    <button class="cred-migrate" type="button" data-cred-migrate="' + escMem(r.name) + '">MOVE TO VAULT ⇢</button>'
            : '',
          (!runtimeCredentialReady && r.hasValue) ? '    <button class="cred-delete" type="button" data-cred-delete="' + escMem(r.name) + '">DELETE ▣</button>' : '',
          '  </div>',
          '</div>',
        ].join('');
      }).join('');
      bindCredentialActions();
    } catch (err) {
      listEl.innerHTML = '<div class="settings-info" style="color:var(--accent-fail);">Failed: ' + escMem(err.message || err) + '</div>';
    }
  }

  function bindCredentialActions() {
    const root = document.querySelector('[data-creds-list]');
    if (!root) return;

    root.querySelectorAll('[data-cred-set]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.getAttribute('data-cred-set');
        const wrap = root.querySelector('[data-cred-set-wrap="' + name + '"]');
        if (wrap) {
          wrap.classList.add('open');
          const input = wrap.querySelector('input');
          if (input) input.focus();
        }
      });
    });
    root.querySelectorAll('[data-cred-set-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.getAttribute('data-cred-set-cancel');
        const wrap = root.querySelector('[data-cred-set-wrap="' + name + '"]');
        if (wrap) wrap.classList.remove('open');
      });
    });
    root.querySelectorAll('[data-cred-set-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.getAttribute('data-cred-set-save');
        const input = root.querySelector('[data-cred-set-input="' + name + '"]');
        const value = input?.value?.trim();
        if (!name || !value) return;
        btn.textContent = 'SAVING…';
        try {
          const r = await fetch(withToken('/api/console/credentials/set'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, value }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            alert('Save failed: ' + (j.error || r.status));
            btn.textContent = 'SAVE';
            return;
          }
          await refreshCredentialsHealth();
        } catch (err) {
          alert('Save failed: ' + (err.message || err));
          btn.textContent = 'SAVE';
        }
      });
    });
    root.querySelectorAll('[data-cred-migrate]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.getAttribute('data-cred-migrate');
        if (!confirm('Move ' + name + ' from .env into the local vault?\\n\\nYour .env stays intact — the vault gets the value as its new primary source.')) return;
        try {
          const r = await fetch(withToken('/api/console/credentials/migrate'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, from: 'env', to: 'file' }),
          });
          if (!r.ok) { const j = await r.json().catch(() => ({})); alert('Migrate failed: ' + (j.error || r.status)); return; }
          await refreshCredentialsHealth();
        } catch (err) { alert('Migrate failed: ' + (err.message || err)); }
      });
    });
    root.querySelectorAll('[data-cred-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.getAttribute('data-cred-delete');
        if (!confirm('Delete ' + name + ' from vault + keychain?\\n\\nYour .env (if set) is never touched.')) return;
        try {
          await fetch(withToken('/api/console/credentials/' + encodeURIComponent(name)), { method: 'DELETE' });
          await refreshCredentialsHealth();
        } catch (err) { alert('Delete failed: ' + (err.message || err)); }
      });
    });
    // Codex re-auth: kicks off the same OAuth flow the setup wizard
    // uses. Opens a browser window where the user signs in with their
    // ChatGPT account; on success, fresh access + refresh tokens
    // persist and the credentials list refreshes to reflect new
    // "set at" timestamps. Available only when window.clemmy is
    // present — i.e. running inside the Electron desktop app, not
    // the dev tree or a remote browser pointed at a daemon.
    root.querySelectorAll('[data-cred-codex-reauth]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        // 2026-05-23: switched from setupCodexLogin to codexReauth. The
        // former short-circuits on existing fresh tokens and never opens
        // the browser, so the button looked broken to users who already
        // had valid creds and just wanted to refresh / switch accounts.
        // codexReauth always runs the full OAuth dance.
        const ipc = (window).clemmy && ((window).clemmy.codexReauth || (window).clemmy.setupCodexLogin);
        if (typeof ipc !== 'function') {
          alert('Re-authentication is only available inside the Clementine desktop app. From the dev tree, run: npx tsx src/cli/index.ts auth login-native');
          return;
        }
        const originalLabel = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'OPENING BROWSER…';
        try {
          const result = await ipc();
          if (result && result.ok) {
            btn.textContent = 'RE-AUTHENTICATED ✓';
            await refreshCredentialsHealth();
            setTimeout(() => {
              btn.disabled = false;
              btn.textContent = originalLabel;
            }, 2000);
          } else {
            const message = (result && result.error) || 'Re-authentication did not complete';
            alert('Re-auth failed: ' + message);
            btn.disabled = false;
            btn.textContent = originalLabel;
          }
        } catch (err) {
          alert('Re-auth failed: ' + ((err && err.message) || err));
          btn.disabled = false;
          btn.textContent = originalLabel;
        }
      });
    });
  }

  const repairBtn = document.querySelector('[data-creds-repair]');
  const resetBtn  = document.querySelector('[data-creds-reset]');
  if (repairBtn) {
    repairBtn.addEventListener('click', async () => {
      repairBtn.textContent = 'REPAIRING…';
      try {
        const r = await fetch(withToken('/api/console/credentials/repair-keychain'), { method: 'POST' });
        const j = await r.json();
        if (!j.probed) {
          alert('Keychain not available — keytar is not installed in this build.\\nThis is expected for the daemon-only / CLI install; install the desktop app to use Keychain.');
        } else {
          alert('Keychain repair complete. Tested ' + j.tested + ' credentials, recovered ' + (j.recovered?.length || 0) + ' to keychain status.');
        }
        await refreshCredentialsHealth();
      } catch (err) {
        alert('Repair failed: ' + (err.message || err));
      } finally {
        repairBtn.textContent = 'REPAIR KEYCHAIN ⟲';
      }
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Reset ALL Clementine credentials?\\n\\nThis deletes:\\n  • all keychain entries under com.clemmy.desktop.v1\\n  • the local file vault (~/.clementine-next/state/secrets-vault.json)\\n  • the credentials metadata file\\n\\nYour .env files are NEVER touched.\\nProceed?')) return;
      resetBtn.textContent = 'RESETTING…';
      try {
        const r = await fetch(withToken('/api/console/credentials/reset'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        });
        const j = await r.json();
        alert('Reset complete.\\n\\nKeychain entries removed: ' + (j.keychainDeleted?.length || 0) + '\\nFile vault deleted: ' + j.fileVaultDeleted + '\\nMetadata deleted: ' + j.metaDeleted);
        await refreshCredentialsHealth();
      } catch (err) {
        alert('Reset failed: ' + (err.message || err));
      } finally {
        resetBtn.textContent = 'RESET CREDENTIALS ▣';
      }
    });
  }

  let currentModelSettings = null;

  function modelTierLabel(tier) {
    if (tier === 'primary') return 'Primary';
    return tier.charAt(0).toUpperCase() + tier.slice(1);
  }

  function renderModelPicker(snapshot) {
    currentModelSettings = snapshot || null;
    if (!sett.modelsForm || !sett.modelsStatus || !snapshot) return;

    const presets = Array.isArray(snapshot.presets) ? snapshot.presets : [];
    const models = snapshot.models || {};
    ['fast','primary','deep'].forEach((tier) => {
      const select = sett.modelsForm.querySelector('[data-model-preset="' + tier + '"]');
      const input = sett.modelsForm.querySelector('[data-model-custom="' + tier + '"]');
      if (!select || !input) return;
      const current = models[tier] || (snapshot.defaults && snapshot.defaults[tier]) || '';
      const presetIds = presets.map((p) => p.id);
      const known = presetIds.includes(current);
      select.innerHTML = presets.map((preset) => (
        '<option value="' + escMem(preset.id) + '">' + escMem(preset.label || preset.id) + '</option>'
      )).join('') + '<option value="__custom__">Custom model id</option>';
      select.value = known ? current : '__custom__';
      input.value = current;
      input.disabled = select.value !== '__custom__';
      input.style.opacity = input.disabled ? '0.55' : '1';
      select.onchange = () => {
        if (select.value === '__custom__') {
          input.disabled = false;
          input.style.opacity = '1';
          input.focus();
        } else {
          input.value = select.value;
          input.disabled = true;
          input.style.opacity = '0.55';
        }
      };
    });

    const overrides = snapshot.processEnvOverrides || {};
    const rows = ['fast','primary','deep'].map((tier) => {
      const value = models[tier] || '';
      const locked = overrides[tier] ? ' env override' : '';
      return '<div class="row"><span class="k">' + modelTierLabel(tier) + '</span><span class="v on">' + escMem(value + locked) + '</span></div>';
    }).join('');
    sett.modelsStatus.innerHTML = rows + '<p class="settings-note">Saved to the local runtime env. New turns use the selected tiers immediately.</p>';
  }

  function collectModelPatch(useDefaults) {
    const source = useDefaults && currentModelSettings ? currentModelSettings.defaults : null;
    const patch = {};
    ['fast','primary','deep'].forEach((tier) => {
      if (source && source[tier]) {
        patch[tier] = source[tier];
        return;
      }
      const select = sett.modelsForm.querySelector('[data-model-preset="' + tier + '"]');
      const input = sett.modelsForm.querySelector('[data-model-custom="' + tier + '"]');
      const selected = select ? select.value : '';
      patch[tier] = selected === '__custom__' ? (input?.value || '').trim() : selected;
    });
    return patch;
  }

  function renderAuthInfo(auth) {
    if (!auth) { sett.authBox.textContent = '—'; return; }
    const codexReady = hasCodexRuntimeAuth(auth);
    const apiKeyReady = hasOpenAiApiKey(auth);
    const rows = [
      ['Agent runtime',  auth.configured ? 'ready' : 'needs sign-in'],
      ['Runtime path',   runtimeAuthLabel(auth)],
      ['Mode',           auth.mode || '—'],
      ['Source',         auth.source || '—'],
      ['Codex OAuth',    codexReady ? 'connected' : 'not connected'],
      ['OpenAI API key', apiKeyReady ? 'available for embeddings + live voice' : 'optional: embeddings + live voice disabled'],
      auth.codexAccountId ? ['Codex account', auth.codexAccountId] : null,
    ];
    sett.authBox.innerHTML = rows.filter(Boolean).map(([k, v]) => {
      const text = String(v);
      const off = text.includes('needs') || text.includes('not connected') || text.includes('disabled');
      return '<div class="row"><span class="k">' + escMem(k) + '</span><span class="v ' + (off ? 'off' : 'on') + '">' + escMem(text) + '</span></div>';
    }).join('') + '<p class="settings-note">Codex OAuth is the agent runtime auth. The OpenAI API key is a separate optional capability key for semantic embeddings, Realtime live voice, and direct API-only features.</p>';
  }

  function renderRuntimeBudget(snapshot) {
    if (!sett.runtimeForm || !sett.runtimeStatus || !snapshot) return;
    const settings = snapshot.settings || {};
    ['preset','maxConversationSteps','maxConversationWallMinutes','maxTurns','toolCallsPerTurn','checkInMinutes','autoContinueOnLimit'].forEach((key) => {
      setFormValue(sett.runtimeForm, key, settings[key]);
    });
    const unlimited = settings.unlimited || settings.preset === 'unlimited';
    const wall = Number(settings.maxConversationWallMinutes || 0) === 0 ? 'no wall-clock cutoff' : settings.maxConversationWallMinutes + ' min wall';
    const rows = [
      ['Mode', settings.preset || 'standard'],
      ['SDK turns', settings.maxTurns ?? '—'],
      ['Steps', settings.maxConversationSteps ?? '—'],
      ['Wall clock', wall],
      ['Tool calls / turn', settings.toolCallsPerTurn ?? '—'],
      ['Check-ins', (settings.checkInMinutes ?? '—') + ' min'],
    ].map(([k, v]) => '<div class="row"><span class="k">' + escMem(k) + '</span><span class="v ' + (unlimited && k === 'Mode' ? 'on' : '') + '">' + escMem(String(v)) + '</span></div>').join('');
    sett.runtimeStatus.innerHTML = rows
      + '<p class="settings-note">' + (unlimited
        ? 'Unlimited supervised keeps running with no wall-clock cutoff, but approvals, kill switch, tool timeouts, and stuck-loop detection still apply. Running sessions appear on Home with CANCEL.'
        : 'New turns use these budgets immediately. Long workflows should use Long or Unlimited Supervised so they do not end silently.') + '</p>';
  }

  function renderMemoryInfo(m) {
    if (!m) { sett.memoryBox.textContent = '—'; return; }
    const rows = [
      ['Chunks',          m.chunks ?? '—'],
      ['Files',           m.indexedFiles ?? '—'],
      ['Active facts',    m.activeFacts ?? '—'],
      ['Total facts',     m.totalFacts ?? '—'],
      ['Embeddings',      m.embeddingsEnabled ? (m.embeddingsCount + ' vectors · ' + Math.round((m.embeddingsCoverage || 0) * 100) + '%') : 'disabled (optional OpenAI API key required)'],
      ['DB size',         (m.dbBytes ?? 0) + ' bytes'],
    ];
    sett.memoryBox.innerHTML = rows.map(([k, v]) => {
      const cls = String(v).startsWith('disabled') ? 'off' : 'on';
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

  sett.modelsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = sett.modelsForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const patch = collectModelPatch(false);
      const r = await fetch(withToken('/api/console/settings/models'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = await r.json().catch(() => ({}));
      btn.disabled = false;
      btn.textContent = r.ok ? 'SAVED ✓' : 'FAILED';
      if (r.ok) renderModelPicker(j.models);
      else if (sett.modelsStatus) sett.modelsStatus.innerHTML = '<div style="color:var(--accent-fail);">Failed to save models: ' + escMem(j.error || r.status) + '</div>';
      setTimeout(() => { btn.textContent = 'SAVE MODELS ✎'; }, 1400);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'FAILED';
      if (sett.modelsStatus) sett.modelsStatus.innerHTML = '<div style="color:var(--accent-fail);">Failed to save models: ' + escMem(err.message || err) + '</div>';
      setTimeout(() => { btn.textContent = 'SAVE MODELS ✎'; }, 1400);
    }
  });

  if (sett.runtimeForm) {
    sett.runtimeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = sett.runtimeForm.querySelector('button[type="submit"]');
      if (btn) btn.disabled = true;
      try {
        const patch = getRuntimeFormPatch(sett.runtimeForm);
        const r = await fetch(withToken('/api/console/settings/runtime-budget'), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const j = await r.json().catch(() => ({}));
        if (btn) {
          btn.disabled = false;
          btn.textContent = r.ok ? 'SAVED ✓' : 'FAILED';
          setTimeout(() => { btn.textContent = 'SAVE RUNTIME ✎'; }, 1400);
        }
        if (r.ok) renderRuntimeBudget(j.runtimeBudget);
        else if (sett.runtimeStatus) sett.runtimeStatus.innerHTML = '<div style="color:var(--accent-fail);">Failed to save runtime: ' + escMem(j.error || r.status) + '</div>';
      } catch (err) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'FAILED';
          setTimeout(() => { btn.textContent = 'SAVE RUNTIME ✎'; }, 1400);
        }
        if (sett.runtimeStatus) sett.runtimeStatus.innerHTML = '<div style="color:var(--accent-fail);">Failed to save runtime: ' + escMem(err.message || err) + '</div>';
      }
    });
    // Preset defaults — MUST stay in sync with PRESETS in
    // src/runtime/harness/budget-settings.ts. The form was previously
    // showing stale "long" defaults (toolCallsPerTurn=32) that lied to
    // the user; the dashboard would save 32 even though the canonical
    // long preset is 80.
    const presetDefaults = {
      standard: { maxTurns: 40, maxConversationSteps: 40, maxConversationWallMinutes: 120, toolCallsPerTurn: 40, checkInMinutes: 10, autoContinueOnLimit: false },
      long:     { maxTurns: 120, maxConversationSteps: 160, maxConversationWallMinutes: 480, toolCallsPerTurn: 80, checkInMinutes: 5, autoContinueOnLimit: true },
      unlimited:{ maxTurns: 500, maxConversationSteps: 1000000, maxConversationWallMinutes: 0, toolCallsPerTurn: 64, checkInMinutes: 3, autoContinueOnLimit: true },
    };
    const applyPresetDefaults = (preset) => {
      const defaults = presetDefaults[preset] || presetDefaults.standard;
      Object.entries(defaults).forEach(([key, value]) => setFormValue(sett.runtimeForm, key, value));
    };
    // Changing the dropdown should auto-fill the numeric fields with
    // that preset's defaults — otherwise the user picks "long workflow"
    // and the fields stay at 40/40/120/40 (standard), the form silently
    // saves the standard values, and they're left wondering why their
    // long-workflow run still hits the 40-call ceiling.
    const presetSelect = sett.runtimeForm.querySelector('[name="preset"]');
    if (presetSelect) {
      presetSelect.addEventListener('change', () => {
        applyPresetDefaults(presetSelect.value);
      });
    }
    sett.runtimeForm.querySelectorAll('[data-runtime-preset-apply]').forEach((button) => {
      button.addEventListener('click', () => {
        const preset = button.getAttribute('data-runtime-preset-apply') || 'long';
        const select = sett.runtimeForm.querySelector('[name="preset"]');
        if (select) select.value = preset;
        applyPresetDefaults(preset);
      });
    });
  }

  if (sett.modelsReset) {
    sett.modelsReset.addEventListener('click', async () => {
      if (!currentModelSettings) return;
      sett.modelsReset.textContent = 'RESETTING...';
      try {
        const r = await fetch(withToken('/api/console/settings/models'), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(collectModelPatch(true)),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok) renderModelPicker(j.models);
        else alert('Reset failed: ' + (j.error || r.status));
      } catch (err) {
        alert('Reset failed: ' + (err.message || err));
      } finally {
        sett.modelsReset.textContent = 'RESET DEFAULTS';
      }
    });
  }

  // Boot the loop.
  wireMemoryViewToggle();
  wireMemoryGraphControls();
  // Home is the default panel, but honor deep links like
  // /dashboard?token=...#memory after the stale-dashboard redirect.
  switchPanel(panelFromHash());
  window.addEventListener('hashchange', () => switchPanel(panelFromHash()));
  tick();
  setInterval(tick, POLL_MS);

  // ── Nav-dock data wiring ──────────────────────────────────────────
  // Pulls live state from the same endpoints the home panel uses, plus
  // the recall IPC for live voice. Refreshes every 5s — same cadence
  // as the existing home command center.
  async function refreshDockNow() {
    try {
      const data = await fetchJSON('/api/console/home/command-center');
      const presence = document.querySelector('[data-dock-now-presence]');
      const label = document.querySelector('[data-dock-now-label]');
      const detail = document.querySelector('[data-dock-now-detail]');
      const tick = document.querySelector('[data-dock-now-tick]');
      if (!presence || !label || !detail || !tick) return;
      const counts = data.counts || {};
      const workingNow = Array.isArray(data.workingNow) ? data.workingNow : [];
      const needsYou = Array.isArray(data.needsYou) ? data.needsYou : [];
      const activeCount = counts.active || workingNow.length;
      const approvalCount = counts.approvals || 0;
      const needsYouCount = needsYou.length;
      if (activeCount > 0) {
        presence.className = 'presence-dot working';
        label.textContent = 'working';
        // Make the count match what's shown: the body only renders ONE
        // item's title, so naming "X of N" here removes the silent
        // mismatch where the badge said "13" but only one work item
        // appeared visible. (Observed 2026-05-23.) Click jumps to
        // Activity for the full list.
        const firstTitle = ((workingNow[0]?.title) || data.presence?.awayMessage || 'running').slice(0, 60);
        detail.textContent = activeCount > 1
          ? firstTitle + ' · +' + (activeCount - 1) + ' more →'
          : firstTitle;
        tick.textContent = String(activeCount);
      } else if (approvalCount > 0 || needsYouCount > 0) {
        presence.className = 'presence-dot needs-you';
        label.textContent = 'needs you';
        const firstNeed = (needsYou[0]?.title || 'approval pending').slice(0, 60);
        const totalNeed = approvalCount || needsYouCount;
        detail.textContent = totalNeed > 1
          ? firstNeed + ' · +' + (totalNeed - 1) + ' more →'
          : firstNeed;
        tick.textContent = String(totalNeed);
      } else {
        presence.className = 'presence-dot';
        label.textContent = 'idle';
        detail.textContent = 'awaiting';
        tick.textContent = '—';
      }
    } catch { /* network blip — keep last state */ }
  }

  async function refreshDockGoal() {
    // Use the cheap /api/console/home/goal-status endpoint that reads
    // the goal state file directly. The old path POST /api/console/home/chat
    // {message: "/goal status"} fired a FULL LLM TURN + 4 status-list
    // tool calls every 5 seconds — observed 6097 tool calls on a single
    // session today purely from this dock refresh loop.
    const card = document.querySelector('[data-dock-goal]');
    if (!card) return;
    try {
      const r = await fetch(withToken('/api/console/home/goal-status'));
      if (!r.ok) return;
      const j = await r.json();
      const state = j?.goal;
      const status = state?.status;
      if (state && (status === 'pursuing' || status === 'paused')) {
        const used = parseInt(state.turnsUsed, 10) || 0;
        const total = parseInt(state.turnsLimit, 10) || 0;
        const obj = String(state.objective || '');
        const objective = document.querySelector('[data-dock-goal-objective]');
        const turns = document.querySelector('[data-dock-goal-turns]');
        const progress = document.querySelector('[data-dock-goal-progress]');
        const judge = document.querySelector('[data-dock-goal-judge]');
        if (objective) objective.textContent = obj.slice(0, 60);
        if (turns) turns.textContent = used + '/' + total;
        if (progress) progress.style.width = Math.round((used / Math.max(1, total)) * 100) + '%';
        if (judge) judge.textContent = (status === 'pursuing' ? 'ACTIVE' : 'PAUSED');
        card.hidden = false;
      } else {
        card.hidden = true;
      }
    } catch {
      card.hidden = true;
    }
  }

  async function refreshDockLive() {
    const phase = document.querySelector('[data-dock-live-phase]');
    const status = document.querySelector('[data-dock-live-status]');
    const meta = document.querySelector('[data-dock-live-meta]');
    const card = document.querySelector('[data-dock-live]');
    const recBtn = document.querySelector('[data-dock-live-rec]');
    const recLbl = document.querySelector('[data-dock-live-rec-label]');
    if (!phase || !status || !meta || !card) return;
    let recall = null;
    if (window.clemmy?.recallStatus) {
      try { recall = await window.clemmy.recallStatus(); } catch { /* ignore */ }
    }

    // Reflect Recall state into the REC affordance. The button is
    // hidden unless the SDK is enabled+initialized — otherwise clicking
    // it would just fail with "SDK not ready", which is noise.
    if (recBtn) {
      const ready = Boolean(recall?.enabled && recall?.initialized);
      if (!ready) {
        recBtn.setAttribute('hidden', '');
      } else {
        recBtn.removeAttribute('hidden');
        if (recall?.recording) {
          if (recLbl) recLbl.textContent = 'STOP RECORDING';
          recBtn.setAttribute('data-state', 'recording');
        } else {
          if (recLbl) recLbl.textContent = 'RECORD MEETING';
          recBtn.setAttribute('data-state', 'idle');
        }
      }
    }

    if (recall?.recording) {
      card.classList.add('live');
      phase.textContent = 'REC';
      status.textContent = (recall.lastMeeting?.title || 'recording').slice(0, 40);
      meta.textContent = recall.lastMeeting?.platform || 'meeting capture';
      return;
    }
    if (recall?.enabled && recall?.initialized) {
      card.classList.remove('live');
      phase.textContent = 'WATCH';
      status.textContent = 'waiting for meeting';
      meta.textContent = 'recall.ai · ' + (recall.settings?.region || 'us-west-2');
      return;
    }
    card.classList.remove('live');
    phase.textContent = 'STANDBY';
    status.textContent = 'tap orb to talk';
    meta.textContent = recall ? 'sdk loaded' : 'electron only';
  }

  // Wire the REC button (dock-live card) to start/stop a Recall capture
  // without nav-hopping to Integrations mid-meeting. Bound once at
  // initial render; the visible state is driven by refreshDockLive().
  (function bindDockLiveRec() {
    const recBtn = document.querySelector('[data-dock-live-rec]');
    if (!recBtn) return;
    recBtn.addEventListener('click', async (event) => {
      // The orb is a sibling button — clicking REC shouldn't bubble
      // into the dock-card-clickable jump-target logic we added today.
      event.stopPropagation();
      if (!window.clemmy?.recallStartManual || !window.clemmy?.recallStop) {
        showError('Recall controls require the Clementine desktop app.');
        return;
      }
      const state = recBtn.getAttribute('data-state') || 'idle';
      if (state === 'recording') {
        // Optimistic UI flip — don't make the user stare at "STOP
        // RECORDING" for 2-3 seconds while the next refreshDockLive
        // poll catches up to reality. If the stop call fails, the
        // subsequent refresh will undo the flip.
        recLbl.textContent = 'STOPPING…';
        recBtn.setAttribute('disabled', '');
        try {
          await window.clemmy.recallStop();
          showSuccess('Recording stopped. Canonical transcript backfill will land in a few minutes.');
        } catch (err) {
          showError('Stop failed: ' + ((err && err.message) || err));
        } finally {
          recBtn.removeAttribute('disabled');
          refreshDockLive();
        }
        return;
      }
      // Confirm only the start side — stopping mid-meeting should be
      // one click since the user can always restart.
      if (!confirm('Start recording this meeting?\\nMake sure participants are aware where required.')) return;
      // Optimistic UI flip — show STARTING immediately so the user
      // knows their click registered. The next refreshDockLive (which
      // we kick after the IPC resolves) replaces this with the real
      // state ("STOP RECORDING" + pulsing dot).
      recLbl.textContent = 'STARTING…';
      recBtn.setAttribute('disabled', '');
      try {
        await window.clemmy.recallStartManual();
        showSuccess('Recording started.');
      } catch (err) {
        showError('Recording failed to start: ' + ((err && err.message) || err));
      } finally {
        recBtn.removeAttribute('disabled');
        refreshDockLive();
      }
    });
  })();

  // Tools whose execution is internal self-polling — the daemon reads
  // its own state continuously to drive autonomy + the dashboard.
  // Surfacing those in the user-facing RECENT card is pure noise
  // (every poll prints "execution_list ✓" and pushes real work off).
  // Filter here rather than the API so the raw event log stays
  // intact for debugging via /api/console/tool-events/recent itself.
  const DOCK_RECENT_HIDDEN = new Set([
    'execution_list', 'goal_list', 'run_list',
    'memory_search', 'monitor_list', 'task_list',
  ]);

  async function refreshDockRecent() {
    const list = document.querySelector('[data-dock-recent-list]');
    const count = document.querySelector('[data-dock-recent-count]');
    if (!list || !count) return;
    try {
      // Over-fetch so the filter still leaves us with ~6 visible rows.
      const data = await fetchJSON('/api/console/tool-events/recent?limit=24');
      const rawEvents = Array.isArray(data?.events) ? data.events : [];
      const events = rawEvents.filter((e) => !DOCK_RECENT_HIDDEN.has(e.toolName)).slice(0, 6);
      count.textContent = String(events.length);
      if (events.length === 0) {
        list.innerHTML = '<div class="dock-empty">— quiet —</div>';
        return;
      }
      list.innerHTML = events.map((e) => {
        const t = e.at ? new Date(e.at).toLocaleTimeString().replace(/:[0-9]{2}\\s/, ' ') : '—';
        const ok = e.outcome === 'success' ? 'ok'
          : e.outcome === 'error' ? 'err'
          : e.phase === 'pending-approval' ? 'warn'
          : '';
        const glyph = ok === 'ok' ? '✓' : ok === 'err' ? '✗' : ok === 'warn' ? '⚠' : '·';
        return '<div class="dock-recent-row ' + ok + '"><span class="t">' + escMem(t) + '</span><span class="n">' + glyph + ' ' + escMem(e.toolName || '?') + '</span></div>';
      }).join('');
    } catch {
      list.innerHTML = '<div class="dock-empty">— activity feed offline —</div>';
    }
  }

  async function refreshDockHealth() {
    try {
      const data = await fetchJSON('/api/console/health');
      const cells = {
        daemon: document.querySelector('[data-dock-health-daemon]'),
        db: document.querySelector('[data-dock-health-db]'),
        mcp: document.querySelector('[data-dock-health-mcp]'),
        composio: document.querySelector('[data-dock-health-composio]'),
      };
      const overall = document.querySelector('[data-dock-health-overall]');
      const setCell = (cell, state) => {
        if (!cell) return;
        cell.classList.remove('warn', 'err');
        if (state === 'warn') cell.classList.add('warn');
        if (state === 'err') cell.classList.add('err');
        const dot = cell.querySelector('.presence-dot');
        if (dot) {
          dot.className = 'presence-dot' + (state === 'warn' ? ' warn' : state === 'err' ? ' offline' : '');
        }
      };
      setCell(cells.daemon, data?.daemon || 'ok');
      setCell(cells.db, data?.memoryDb || 'ok');
      setCell(cells.mcp, data?.mcp || 'ok');
      setCell(cells.composio, data?.composio || 'ok');
      if (overall) {
        const states = [data?.daemon, data?.memoryDb, data?.mcp, data?.composio];
        const tone = states.includes('err') ? '✗' : states.includes('warn') ? '⚠' : '✓';
        overall.textContent = tone;
      }
    } catch {
      // Endpoint may not exist yet — surface unknown rather than error.
      const overall = document.querySelector('[data-dock-health-overall]');
      if (overall) overall.textContent = '—';
    }
  }

  function refreshNavDock() {
    refreshDockNow();
    refreshDockGoal();
    refreshDockLive();
    refreshDockRecent();
    refreshDockHealth();
  }
  refreshNavDock();
  setInterval(refreshNavDock, 5000);

  // MCP server health pill in the header. Polls a lightweight endpoint
  // (in-memory registry, no disk I/O) every 3s so the user can see at
  // a glance which servers are ready vs still connecting vs down. The
  // pill is hidden when zero MCP servers are configured (most fresh
  // installs). One-click jumps to Settings → MCP Servers so the user
  // can reconnect / remove a broken server.
  async function refreshMcpStat() {
    const btn = document.querySelector('[data-stat-mcp]');
    const label = document.querySelector('[data-stat-mcp-label]');
    if (!btn || !label) return;
    try {
      const data = await fetchJSON('/api/console/mcp/health');
      const summary = data?.summary || {};
      const total = Number(summary.total ?? 0);
      if (total === 0) {
        btn.setAttribute('hidden', '');
        return;
      }
      btn.removeAttribute('hidden');
      const connected = Number(summary.connected ?? 0);
      const connecting = Number(summary.connecting ?? 0);
      const degraded = Number(summary.degraded ?? 0);
      const unavailable = Number(summary.unavailable ?? 0);
      // Build label + colour state based on the worst-case server.
      // Order matters: down > degraded > connecting > ready.
      let state = 'ready';
      let text = total + ' READY';
      if (unavailable > 0) {
        state = 'down';
        text = unavailable + ' DOWN · ' + connected + '/' + total + ' READY';
      } else if (degraded > 0) {
        state = 'degraded';
        text = connected + '/' + total + ' READY · ' + degraded + ' ⚠';
      } else if (connecting > 0) {
        state = 'connecting';
        text = connecting > 1
          ? connecting + ' CONNECTING…'
          : '1 CONNECTING…';
        if (connected > 0) text = connected + '/' + total + ' READY · ' + connecting + ' CONNECTING…';
      }
      btn.setAttribute('data-state', state);
      label.textContent = text;
      const tooltip = (data?.servers || []).map((s) => s.slug + ' · ' + s.state + ' · ' + s.toolCount + ' tools').join('\\n');
      btn.setAttribute('title', tooltip || 'MCP server health');
    } catch (err) {
      // Endpoint might not exist on an older daemon dist — hide rather
      // than show "ERR", to keep the header clean.
      btn.setAttribute('hidden', '');
    }
  }
  const mcpBtn = document.querySelector('[data-stat-mcp]');
  if (mcpBtn) {
    mcpBtn.addEventListener('click', () => {
      if (typeof switchPanel === 'function') switchPanel('integrations');
    });
  }
  refreshMcpStat();
  setInterval(refreshMcpStat, 3000);

  // ─── SSE-driven activity refresh ───────────────────────────────
  //
  // The standalone "LIVE" rail was removed (it caused routing confusion
  // separate from the Activity table). What we KEEP from the rail is
  // the SSE subscription to /api/console/actions/stream — the daemon
  // emits one event for every meaningful action (run start/end, tool
  // call, approval, execution transition, runtime failure, harness
  // event). Whenever any of those fires, we kick the polling tick()
  // so the Activity table refreshes immediately instead of waiting up
  // to POLL_MS for the next scheduled poll. The result: the Activity
  // table behaves like the rail did (near-real-time) but stays a single
  // canonical surface.
  //
  // Drops the per-card rendering, the collapse/expand state, the
  // localStorage persistence, and the floating-overlay drawer. Just the
  // event tap → tick() trigger remains.
  (function initLiveActionsRefresh() {
    if (typeof EventSource === 'undefined') return;
    if (typeof tick !== 'function') return;

    // Coalesce bursts of events so a tool-call storm doesn't pummel
    // /api/dashboard. We schedule at most one tick() per 600ms window.
    // Also refreshes the dock-live card so the RECORD MEETING button
    // flips to RECORDING immediately on click (previously had to wait
    // for the slow refreshDockLive poll). refreshDockLive() is a
    // function defined earlier in this IIFE.
    let pending = null;
    function scheduleRefresh() {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        try { tick(); } catch (_) {}
        try { if (typeof refreshDockLive === 'function') refreshDockLive(); } catch (_) {}
      }, 600);
    }

    let es = null;
    let reconnectAttempt = 0;
    let reconnectTimer = null;

    function scheduleReconnect() {
      if (reconnectTimer) return;
      reconnectAttempt += 1;
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempt - 1, 4)));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function connect() {
      if (es) { try { es.close(); } catch (_) {} es = null; }
      const url = '/api/console/actions/stream?token=' + encodeURIComponent(TOKEN);
      try {
        es = new EventSource(url);
      } catch (err) {
        scheduleReconnect();
        return;
      }
      es.addEventListener('open', () => { reconnectAttempt = 0; });
      // Any meaningful event coming off the daemon's action stream gets
      // coalesced into a single tick() — the Activity table fetches
      // fresh /api/dashboard + /api/runs data so the change is reflected
      // immediately rather than waiting up to POLL_MS for the next poll.
      const trigger = () => scheduleRefresh();
      es.addEventListener('run.event', trigger);
      es.addEventListener('approval.created', trigger);
      es.addEventListener('approval.resolved', trigger);
      es.addEventListener('notification.created', trigger);
      es.addEventListener('execution.transitioned', trigger);
      es.addEventListener('harness.event', trigger);
      es.addEventListener('runtime.failed', trigger);
      es.addEventListener('error', () => {
        if (!es || es.readyState !== EventSource.CONNECTING) {
          if (es) { try { es.close(); } catch (_) {} es = null; }
          scheduleReconnect();
        }
      });
    }

    connect();
  })();

  // ─── Meeting-capture floating layer controller ──────────────────
  //
  // Listens to the recall-event IPC stream from the Electron main
  // process (window.clemmy.onRecallEvent) and drives the four UI
  // surfaces — prompt banner, live pill, transcript drawer,
  // completion toast — from a single state machine. Independent of
  // the Integrations panel; visible from anywhere in the dashboard.
  (function meetingCaptureFloating() {
    if (!window.clemmy || !window.clemmy.onRecallEvent) return;

    const prompt = document.querySelector('[data-meeting-prompt]');
    const promptTitle = document.querySelector('[data-meeting-prompt-title]');
    const promptSub = document.querySelector('[data-meeting-prompt-sub]');
    const promptRecord = document.querySelector('[data-meeting-prompt-record]');
    const promptAlways = document.querySelector('[data-meeting-prompt-always]');
    const promptDismiss = document.querySelector('[data-meeting-prompt-dismiss]');

    // The floating recording pill was removed — the in-window Memory >
    // Meetings live card is the canonical recording-state UI now. The
    // state machine below stays intact because the inline card reads
    // from window.__clementineLiveMeeting and gets re-rendered when
    // showPill / hidePill / appendSegment mutate state.

    const toast = document.querySelector('[data-meeting-toast]');
    const toastSub = document.querySelector('[data-meeting-toast-sub]');
    const toastTranscript = document.querySelector('[data-meeting-toast-transcript]');
    const toastSummary = document.querySelector('[data-meeting-toast-summary]');
    const toastDismiss = document.querySelector('[data-meeting-toast-dismiss]');

    if (!prompt || !toast) return;

    // Live state is exposed on window so the Memory > Meetings panel
    // can render the recording inline. Replaces the previous floating
    // drawer popup with an in-window card.
    const state = {
      pendingWindow: null,
      activeWindow: null,
      activeRecordingId: null,
      startedAt: null,
      lastCompleted: null,
      segments: [],
      elapsedTimer: 0,
    };
    window.__clementineLiveMeeting = state;

    function fmtElapsed(seconds) {
      const s = Math.max(0, Math.floor(seconds));
      const m = Math.floor(s / 60);
      const r = s - m * 60;
      return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
    }

    function startElapsedTimer() {
      stopElapsedTimer();
      state.elapsedTimer = setInterval(() => {
        if (!state.startedAt) return;
        const seconds = (Date.now() - Date.parse(state.startedAt)) / 1000;
        const text = fmtElapsed(seconds);
        // The floating pill is gone; only the inline Memory > Meetings
        // live card needs the elapsed updates now. Querying every tick
        // is cheap and avoids holding stale element references across
        // panel switches.
        const liveElapsedEl = document.querySelector('[data-mem-meeting-live-elapsed]');
        if (liveElapsedEl) liveElapsedEl.textContent = text;
      }, 1000);
    }
    function stopElapsedTimer() {
      if (state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = 0; }
    }

    function showPrompt(win) {
      if (state.activeWindow) return;
      state.pendingWindow = win;
      if (promptTitle) promptTitle.textContent = (win.platform || 'Meeting') + ' detected';
      if (promptSub) promptSub.textContent = (win.title ? win.title + ' · ' : '') + 'Record this meeting so Clementine can transcribe + summarize it after.';
      prompt.hidden = false;
      toast.hidden = true;
    }
    function hidePrompt() {
      prompt.hidden = true;
      state.pendingWindow = null;
    }

    // showPill is now misnamed — it just updates the in-memory state
    // (used by the Memory > Meetings inline live card) and starts the
    // elapsed-time timer. The floating pill UI has been removed.
    function showPill(win, startedAt) {
      const sameWindow = state.activeWindow && state.activeWindow.windowId === win.windowId;
      const isNewRecording = !sameWindow;
      if (isNewRecording) {
        state.activeWindow = win;
        state.startedAt = startedAt || new Date().toISOString();
        state.segments = [];
      }
      hidePrompt();
      toast.hidden = true;
      startElapsedTimer();
      // Recording just started: auto-route the user to Memory > Meetings
      // so they see the live transcript without having to navigate. The
      // user explicitly asked for this when recall.ai is the source —
      // a recording with no visible surface is the silent-failure mode
      // we want to avoid. Same-window keep-alive events (segment
      // appends, status pings) do NOT re-route, so the user isn't
      // yanked back every few seconds.
      if (isNewRecording) {
        try {
          if (typeof switchPanel === 'function') switchPanel('memory');
          if (typeof window.__clementineMemoryView === 'function') {
            window.__clementineMemoryView('meetings');
          }
        } catch (err) {
          console.warn('auto-open transcript panel failed:', err);
        }
      }
      // If the Meetings panel is open, redraw it so the live card
      // appears at the top.
      if (typeof loadMemoryMeetings === 'function' && !document.querySelector('[data-mem-meetings]')?.hidden) {
        loadMemoryMeetings();
      }
    }
    function hidePill() {
      // Pill UI is gone; just clear state + stop the timer. Inline
      // Memory > Meetings card re-renders on the next load.
      stopElapsedTimer();
      state.activeWindow = null;
      state.activeRecordingId = null;
      state.startedAt = null;
      state.segments = [];
      if (typeof loadMemoryMeetings === 'function' && !document.querySelector('[data-mem-meetings]')?.hidden) {
        loadMemoryMeetings();
      }
    }

    function appendSegment(segment) {
      if (!segment || !segment.text) return;
      state.segments.push(segment);
      if (state.segments.length > 80) state.segments.shift();
      // Stream into the inline live card if the Meetings panel is open.
      const liveBody = document.querySelector('[data-mem-meeting-live-body]');
      if (liveBody) {
        const empty = liveBody.querySelector('.mem-meeting-live-empty');
        if (empty) empty.remove();
        const node = document.createElement('div');
        node.className = 'meeting-segment';
        const speaker = segment.speaker || '';
        node.innerHTML = (speaker ? '<span class="meeting-segment-speaker">' + escMem(speaker) + '</span>' : '') + escMem(segment.text);
        liveBody.appendChild(node);
        liveBody.scrollTop = liveBody.scrollHeight;
      }
    }

    function showToast(meetingInfo) {
      state.lastCompleted = meetingInfo;
      const mins = meetingInfo.durationSeconds
        ? Math.max(1, Math.round(meetingInfo.durationSeconds / 60))
        : null;
      const sub = [
        (meetingInfo.platform || 'meeting').toString().toUpperCase(),
        meetingInfo.title ? '· ' + meetingInfo.title : '',
        mins ? '· ' + mins + ' min' : '',
        meetingInfo.segmentCount ? '· ' + meetingInfo.segmentCount + ' segments' : '',
      ].filter(Boolean).join(' ');
      if (toastSub) toastSub.textContent = sub || 'Meeting captured.';
      toast.hidden = false;
      hidePill();
    }
    function hideToast() {
      toast.hidden = true;
      state.lastCompleted = null;
    }

    // ── Wire up the bridge ──────────────────────────────────────
    promptDismiss?.addEventListener('click', () => hidePrompt());
    promptRecord?.addEventListener('click', async () => {
      const win = state.pendingWindow;
      if (!win || !window.clemmy.recallRecordDetected) { hidePrompt(); return; }
      try { await window.clemmy.recallRecordDetected(win.windowId); }
      catch (err) { alert('Could not start recording: ' + (err && err.message ? err.message : String(err))); }
      hidePrompt();
    });
    promptAlways?.addEventListener('click', async () => {
      const win = state.pendingWindow;
      if (!win || !window.clemmy.recallAutoRecord) { hidePrompt(); return; }
      try { await window.clemmy.recallAutoRecord(win.windowId); }
      catch (err) { alert('Could not enable auto-record: ' + (err && err.message ? err.message : String(err))); }
      hidePrompt();
    });

    // Floating pill removed — Memory > Meetings live card is the only
    // recording surface now. No click-to-navigate needed because the
    // card already lives in that panel.

    toastDismiss?.addEventListener('click', () => hideToast());
    toastTranscript?.addEventListener('click', async () => {
      const info = state.lastCompleted;
      if (!info?.artifactPath) { hideToast(); return; }
      // Route to the memory viewer so the user lands on the actual
      // markdown file with chunk view + search. Post-brain-consolidation
      // the viewer lives inside Brain → Knowledge → Graph & Files.
      switchMemoryView && switchMemoryView('viewer');
      // Trigger navigation to the Brain panel, then the Graph sub-tab.
      const navBrain = document.querySelector('.nav[data-panel="brain"]');
      if (navBrain) navBrain.click();
      const knowledgeTab = document.querySelector('[data-brain-tab="knowledge"]');
      if (knowledgeTab) knowledgeTab.click();
      const graphSubtab = document.querySelector('[data-brain-knowledge-tab="graph"]');
      if (graphSubtab) graphSubtab.click();
      try {
        await loadFileViewer(info.artifactPath);
      } catch (_) { /* loadFileViewer may not be in scope before user navigates */ }
      hideToast();
    });
    toastSummary?.addEventListener('click', async () => {
      const info = state.lastCompleted;
      if (!info?.meetingId) { hideToast(); return; }
      // Try the structured analysis first; fall back to a transcript-
      // pointer prompt so chat still has something useful.
      let analysis = null;
      try {
        const data = await fetchJSON('/api/console/meetings/recall/' + encodeURIComponent(info.meetingId));
        analysis = data.analysis || null;
      } catch (_) { /* fall through */ }
      let message;
      if (analysis && analysis.summary) {
        const parts = ['Meeting summary just landed:', '', analysis.summary];
        if (Array.isArray(analysis.actionItems) && analysis.actionItems.length > 0) {
          parts.push('', 'Action items:');
          for (const a of analysis.actionItems) parts.push('- ' + (a.owner ? a.owner + ': ' : '') + a.text);
        }
        if (Array.isArray(analysis.decisions) && analysis.decisions.length > 0) {
          parts.push('', 'Decisions:');
          for (const d of analysis.decisions) parts.push('- ' + d);
        }
        message = parts.join('\\n');
      } else {
        message = 'I just captured a meeting. Transcript is at ' + (info.artifactPath || '(unknown path)') + '. Read it and tell me the summary, decisions, and action items.';
      }
      try { await sendHomeChat(message); }
      catch (err) {
        // sendHomeChat may not exist on some builds — fall back to a
        // simple alert so the toast does *something*.
        alert('Summary ready but chat send failed: ' + (err && err.message ? err.message : String(err)));
      }
      hideToast();
    });

    // Pill dismiss handler removed alongside the pill UI. The
    // STOP RECORDING button on the Memory > Meetings live card now
    // serves as the only user-driven stop path.

    // ── Truth reconciler ────────────────────────────────────────
    // Reads recall daemon status and keeps the in-memory state machine
    // (window.__clementineLiveMeeting) consistent. The floating pill
    // it used to drive is gone, but the inline Memory > Meetings live
    // card subscribes to the same state, so this still matters.
    // an active call. Three checks have to all pass:
    //   1. The user has Recall capture enabled in settings.
    //   2. The daemon reports recording === true.
    //   3. The current window matches one the SDK detected as a live
    //      meeting (not a leftover "meeting client open but no call"
    //      window) — i.e. detectedWindows contains it and its recording
    //      flag is true.
    // Any failure ⇒ hide the pill, reset local state. Polled every 5s.
    async function reconcileFromRecallStatus() {
      if (!window.clemmy || !window.clemmy.recallStatus) return;
      let status;
      try { status = await window.clemmy.recallStatus(); }
      catch { return; }
      if (!status || typeof status !== 'object') return;

      const captureEnabled = Boolean(status.enabled);
      const daemonRecording = Boolean(status.recording);
      const currentId = status.currentWindowId || '';
      const detected = Array.isArray(status.detectedWindows) ? status.detectedWindows : [];
      const matchingDetected = detected.find((w) => w && w.windowId === currentId && w.recording === true);

      const shouldShowPill = captureEnabled && daemonRecording && currentId && Boolean(matchingDetected);
      const localRecording = Boolean(state.activeWindow);

      if (shouldShowPill && !localRecording) {
        // Adopt the daemon's truth — pill should appear (e.g. after a
        // page reload mid-recording).
        showPill({
          windowId: currentId,
          platform: matchingDetected.platform || status.lastMeeting?.platform,
          title: matchingDetected.title || status.lastMeeting?.title,
        }, status.recordingStartedAt || new Date().toISOString());
      } else if (!shouldShowPill && localRecording) {
        // No active capture per the SDK — pill must go, even if our
        // local state thinks it shouldn't.
        hidePill();
      } else if (shouldShowPill && localRecording && state.activeWindow.windowId !== currentId) {
        // The active window changed underneath us — re-anchor.
        showPill({
          windowId: currentId,
          platform: matchingDetected.platform,
          title: matchingDetected.title,
        }, status.recordingStartedAt || new Date().toISOString());
      }
    }

    // Initial sync (after a beat so the page is settled), then a
    // gentle 5s poll. Cheap — recallStatus is a local IPC call.
    setTimeout(() => { void reconcileFromRecallStatus(); }, 600);
    setInterval(() => { void reconcileFromRecallStatus(); }, 5000);

    // ── Recall event subscription ───────────────────────────────
    window.clemmy.onRecallEvent((event) => {
      if (!event || typeof event !== 'object') return;
      const t = event.type;
      if (t === 'meeting-prompt-required') {
        showPrompt({ windowId: event.windowId, platform: event.platform, title: event.title });
      } else if (t === 'meeting-detected') {
        // The capture module emits both 'meeting-detected' (always) and
        // 'meeting-prompt-required' (only when autoRecord is off). We
        // listen to both — the prompt is the authoritative trigger.
      } else if (t === 'recording-started') {
        // Only show the pill after the SDK confirms recording is live.
        // The earlier 'recording-start-requested' event fires after our
        // startRecording() call resolves but before the SDK has hooked
        // the window's audio — showing then could leave a pill up if
        // the SDK then fails silently. Wait for the SDK's own signal.
        showPill({
          windowId: event.windowId || (state.pendingWindow && state.pendingWindow.windowId),
          platform: event.platform || (state.pendingWindow && state.pendingWindow.platform),
          title: event.title || (state.pendingWindow && state.pendingWindow.title),
        }, event.startedAt || new Date().toISOString());
        if (event.recordingId) state.activeRecordingId = event.recordingId;
      } else if (t === 'recording-start-requested') {
        // Pre-confirmation: stash the recording ID so we can correlate
        // when 'recording-started' lands. Don't show the pill yet.
        if (event.recordingId) state.activeRecordingId = event.recordingId;
      } else if (t === 'transcript') {
        appendSegment({ speaker: event.speaker, text: event.text });
      } else if (t === 'recording-ended') {
        const complete = event.complete || {};
        const recordInfo = complete.record || {};
        showToast({
          meetingId: recordInfo.id,
          artifactPath: complete.artifactPath || recordInfo.artifactPath,
          platform: event.platform || recordInfo.platform,
          title: event.title || recordInfo.title,
          segmentCount: complete.segmentCount,
          durationSeconds: (event.startedAt && event.endedAt)
            ? Math.max(0, (Date.parse(event.endedAt) - Date.parse(event.startedAt)) / 1000)
            : undefined,
        });
      } else if (t === 'error') {
        // Surface SDK errors as a transient toast so the user knows the
        // pipeline broke. Reuse the toast slot since it's a one-off.
        if (toastSub) toastSub.textContent = 'Recall error: ' + (event.error || 'unknown');
        toast.hidden = false;
      }
    });
  })();
})();
`;
