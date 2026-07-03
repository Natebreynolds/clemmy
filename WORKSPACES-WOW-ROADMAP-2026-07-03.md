# Workspaces → Wow: competitive roadmap (2026-07-03)

## Where the market is (July 2026)
- **Claude Live Artifacts** (May 2026): artifacts pull real-time data via MCP connectors; shareable web pages anyone can open; Claude Code can emit self-updating dashboards. This is the majors converging on Workspaces' concept.
- **ChatGPT**: Canvas (collaborative doc), scheduled Tasks, Agent mode (browser autonomy), Projects + memory.
- **Lindy** (~400K paying users, ~$50/mo): owns *recurring* inbox/calendar workflow reliability.
- **Manus** (Meta-owned): owns one-off deep autonomy in a cloud sandbox (own browser/terminal/FS).
- **Dust**: agent fleets with per-agent instructions/data + shared skills.

## Clementine's structural edge (what none of them combine)
Local-first + plugged into the user's REAL systems (Composio/CLIs/MCP) + proactive monitors/goals/cron + compounding memory + multi-brain no-dead-turns + **Workspaces that ACT** (gated one-click actions), self-refresh server-side with no chat session open, and re-engage the user when a condition fires.

The gap is not capability — it's **distribution, activation, and reach**:
1. Workspaces are loopback-only (no share links) while Claude artifacts are "a web page anyone can open."
2. First-run is a blank canvas (no starter templates; no proactive first workspace).
3. Zero mobile reach (spaces absent from the PWA; the Cloudflare-tunnel + PIN infra already exists).

## The four tracks (ranked by wow-per-effort)

### Track 1 — Share links (distribution wow)  [~1 day]
"Send your client a live dashboard" is the agency killer feature + viral loop.
- `space_publish` → static SNAPSHOT export (inline data.json, strip clem.* action bridge) deployed via the existing Netlify deploy path Clem already uses for sites. Re-publish on demand or on runner refresh (opt-in).
- Phase 2 (later): signed live links over the existing tunnel (`/m/`-style wrapper, read-only, expiring token).
- Safety: snapshot-only by default (no actions, no tokens — the view never sees credentials today, keep it that way); publish is an external write → approval gate.

### Track 2 — First-workspace activation (first-10-minutes wow)  [~1-2 days]
- **Starter recipes**: 5-8 workspace templates (Deal Board, SEO Rank Tracker, Inbox Triage, Daily Brief, Content Calendar, Client Health) as data — each = prompt skeleton + runner patterns + required connections. Discovered at runtime from what's actually connected (global, no hardcoding).
- **Proactive first build**: after setup completes and ≥1 account connects, Clem OFFERS (never auto-builds): "I can build you a live X from your Y — want it?" One yes → she builds it → the gallery isn't empty on day one.
- Fix the stale `space_save` tool text (scheduling "later phase" — it shipped) + paused-build stranding (auto-retry runner once, then Ask-Clem banner).

### Track 3 — Mobile reach (continuity wow)  [~1 day]
- Mount read-only space views on the mobile PWA (`/m/spaces/:id/view`, same security posture as existing /m/ wrappers: tunnel + PIN, no action bridge on mobile v1).
- Gallery cards on mobile Tasks board. "Check your board from your phone" completes the desktop↔everywhere continuity story.

### Track 4 — Compounding loops (the moat, from the 20-patterns review)  [~2-3 days]
- Closed prompt/rubric evolution against the eval corpus (rewrite → re-score → keep-if-better → human-gated apply).
- Pre-flight error-library: "have I failed at this shape before?" line in the context packet.
- Cost/latency-aware proposer directives from measure-efficiency.
These don't demo as loudly but make month-6 Clementine visibly smarter than day-1 — the retention moat vs all four competitors.

## Recommended sequence
1. **Tag + ship v0.12.48 now** (fully validated; don't let new work invalidate it).
2. v0.12.49 = Track 1 + Track 2 ("the Workspaces release" — share + activation, both demo in 60 seconds).
3. v0.12.50 = Track 3 + polish items from tonight (parked-turn question-not-summary, TTFT capture, streaming on dark surfaces).
4. v0.12.51 = Track 4 (learning loops).

## Follow-ups already logged from tonight's validation
- Chat endpoint returns decision summary (not the question) when a turn parks awaiting input.
- ttftMs null on the SDK lane (no turn_started events) — prerequisite for honest latency claims.
- Focus store can ingest stall-retry boilerplate as an ACTIVE focus (pollution class).
- Codex fan-out under provider degradation now recovers via fallover — consider native retry-with-schema-simplification as well.

## Track 5 — The Fast Lane (DeepSpec-inspired, added 2026-07-03)

DeepSpec (deepseek-ai) trains DRAFT models for speculative decoding: cheap model
proposes, big model verifies in one pass, accepted tokens ship. The serving-level
technique doesn't transfer (we don't run inference), but the pattern lifted to the
TURN level is our biggest realistic speed lever:

1. **TTFT measurement (prerequisite — SHIPPED with this doc edit)**: sdk_first_byte
   eventlog event + scorer fallback; the proof scoreboard's ttft column now fills
   on the SDK lane. No speed work without measured baselines — DeepSpec's whole
   discipline is measured acceptance rates.
2. **Speculative turn routing**: FAST model runs the whole turn; the strong brain
   VERIFIES the decision (not regenerate); reject → strong brain takes over.
   Compose from parts we already own: dynamic route policy (Phase E) picks the
   draft brain per intent · the judge layer is the verifier · the parse-exhaustion
   fallover (747b44fe) is already "rejected draft → stronger model". Add an
   `speculative_turn` telemetry event carrying {draftModel, accepted, verifyMs}
   so acceptance-rate per intent-class feeds BACK into the route policy
   (accept-rate <threshold → route class to the strong brain directly).
3. **Speculative prefetch**: while the brain thinks, warm the turn's top-ranked
   tool data (context packet already ranks skills/tools; prefetch = run the #1
   ranked READ eagerly and hold the result for the tool call that asks for it).
4. **Long arc**: recorded trajectories (Trace+Replay Lab) are to agent behavior
   what DeepSpec's 38TB teacher cache is to draft training — the skill distiller
   is the primitive form; replayable traces make task-specific "draft behavior"
   trainable/evaluable later.

Sequencing: (1) shipped · (2) after Trace+Replay lands (verify needs cheap replayed
evals) · (3) independent, small · (4) horizon.

## Execution review contract — Connection Command Center + Task Cockpit (2026-07-03)

Nathan assigned #1+#2 to the notification-work agent; this session reviews every
commit against these criteria (agreed traps, not new rules):

**Connection Command Center**
- MERGE, don't multiply: the Doctor + Connect screen + Notification settings must
  converge toward ONE surface. A fourth parallel door = the too-many-doors debt.
- Capability probes must be LIVE checks (actually attempt a DM-permission probe /
  channel read), not inferences from config. A green light the user can't trust
  is worse than none.
- Test-fire buttons route through the REAL delivery path (the queue + receipts),
  not a side send — otherwise the test passes while production delivery fails.
- "Send results here" writes the SAME BackgroundReportBackTarget the runtime
  reads (one schema, no parallel routing store).

**Task Cockpit**
- UPGRADE the existing Tasks board / BackgroundTasks surfaces — do NOT stand up a
  parallel board (the fork pattern). One task, one canonical surface.
- Data comes from existing stores: attempt_records ("tried"), needs_input
  ("needs"), reportBackTarget ("lands where"), SSE trace (live activity). New
  UI, no new state stores.
- Buttons reuse canonical actions: hold/resume/cancel exist (v0.12.29-32);
  "retry" should re-dispatch through enqueueDurableChatTask, "post elsewhere"
  through the reportBackTarget update — never bespoke side paths.
- Every button's effect must land in the eventlog (the receipt trail is the
  product).

**Both**: suite green per commit · no console-web state duplicated from the
daemon (fetch, don't mirror) · the packaged-app build (in flight) is the final
gate before any of this ships.
