# PR-13 — Later: each behind its own measurement

These are real opportunities found in the audit that either change turn
behaviour (so they need a baseline first) or are larger than one PR. None of them
should start before PR-01 and PR-06 exist, because those are what make the
before/after measurable. Each line is a seed for its own brief.

## Harness, measured

1. **Plan-turn continuation cap.** `host-turn-runner.ts:4788`: a plan candidate
   bypasses `MAX_HOST_OBJECTIVE_JUDGE_CONTINUATIONS`; 7.92M uncached tokens were
   spent after a final rejection over 3.2 days (09-21). Give plan candidates their
   own generous cap (6) with a `plan_continuation_capped` event, and let the owner
   see it. Risk: a plan that legitimately needs many rounds; measure on the plan
   fixtures from v3.18.30.
2. **Trajectory watcher budget.** `watcher-judge.ts:78-84`: ≤4 checks, ≤2 steers,
   fire-and-forget; ~1.47M uncached tokens a day, 191 of 240 checks on-track, 43%
   of steers never injected (09-21). Skip the watcher on turns with ≤2 tool calls
   and after two consecutive on-track checks in one session; measure steer
   injection rate and turn outcomes before/after.
3. **Effort routing per turn shape.** The capability table knows which models take
   `reasoning.effort`; `NEXT-WAVE` §4 lists "no effort routing" as a gap. Reads and
   conversation at `medium`, plans and writes at the model's default; opt-in
   setting, PR-03 suggests it with measured latency; never below `medium` for the
   checker. Owner priority is judge accuracy, so this is suggestion-first.
4. **Model tryouts.** PR-02 reserves `tryout`. "Try DeepSeek on the next 20
   checks": the hedged judge (`judge-family.ts:218-615`) already runs a second
   model; a tryout records both verdicts, agreement, time and tokens into the
   scorecard without changing the verdict that counts, stops at the cap, and ends
   in one suggestion. Explicit, capped, visible (README rule 9).
5. **Quota-aware scheduling.** Codex and Claude windows are tracked
   (`model-status.ts`). Memory jobs and scheduled workflows could prefer the
   account with headroom and a local model (PR-09) outside the owner's working
   hours. Suggestion first (PR-03 R4), policy later with a visible log.
6. **Read-turn review on Jev alone.** After PR-10's measurement: when receipts are
   complete and Jev's size gate allows, settle a read review on Jev without
   starting the reviewer (today the reviewer starts after a 2.5 s hedge). Needs
   the 10-08 rule restated by the owner, since it changes who checks.
7. **Memory cost and use.** 47% of priced cost, 1,199 claims → 172 promotions,
   backlog ~1,290 (09-27); no measure of how much recalled memory a turn uses.
   Instrument "primer lines cited by the reply" before changing anything.
8. **The two machine-text stops.** The hard reconciliation stop still speaks
   machine text (v3.18.32); an auto-resumed chat run can wedge the HTTP server
   into a liveness kill loop. Both are framework defects named for the next wave.

## Surfaces

9. **Migrate the four suggestion shapes onto PR-02**: worker-model offer, "Set up
   next", Noticing proposals, proactive offers (goal/space/skill/workflow/question,
   which today have no door at all). One record, one card, one dismissal memory.
10. **The remaining awaiting projections.** After PR-06/PR-07 take seven of the 33
    in `AWAITING_PROJECTION`, the rest (`step_verified`, `output_grounding_judged`,
    `condenser_applied`, `memory_correction`, `connection_request`,
    `workflow_step_overbudget`, …) each need a bounded projection and a fold.
11. **Phone parity slice.** Run in background, "Not now" on cards, pending-action
    Execute, workflow create/edit/enable, Heartbeats, Goals and Meetings places
    (`app-places.ts:22-44` sets them to null), `phoneSwitcher` UI.
12. **Console on `ChatEngine`.** The console's 2,593-line `lib/useChat.ts` imports
    the shared reducers but not the engine the phone runs; every card is wired
    twice. Parity tests first (PR-02 and PR-07 add the first), then the move.
13. **One source of preference defaults.** `HomePreferences` defaults are copied in
    the daemon, the console and the phone (`home-preferences.ts:63-80`,
    `lib/home-prefs.ts:96-109`, mobile `:76`) with a drift warning; a shared module
    in chat-engine ends the drift.
14. **Inline step editing on the workflow page** (`WorkflowPage.tsx` step panel is
    read-only) and Undo beyond memory and workflow edits.

## Housekeeping

15. `src/setup/init-home.ts:185` example env still names gpt-5.4 tiers.
16. `PATCH settings/models` (tiers, `console-routes.ts:9579`) and
    `settings/model-backend` (:9615) have no UI caller; retire or document.
17. `nav.ts:82` still says "rewire its steps" for the canvas stub.
18. `providerAndToolOverhead` in the usage meter (17K on the 10-09 review) is
    unattributed; attribute image blocks so PR-10's measurement is exact.
