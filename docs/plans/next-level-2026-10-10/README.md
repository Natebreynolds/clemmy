# Next level: Clem knows her models, explains her choices, proposes the next step

2026-10-10 · status: proposed, waiting for the owner's go · written for an implementing agent · based on main `b0612dd` (v3.18.35)

This folder is a plan and a set of pull-request briefs. Each brief (`PR-NN-*.md`) is
self-contained: why, where, how, tests, done-when, do-not. Pick them up in the order
of §4 unless the owner reorders. Read `AGENTS.md` and the three 09-19 checkpoints
before any of them.

## 1. Where main stands after the last ten days

Fifty commits landed on the public history between v3.18.26 (10-02) and v3.18.35
(10-10). Every feature branch of this period is contained in main
(`claude/queued-actions`, `claude/card-ask-back-ui`, `claude/windows-beta-33`,
`claude/windows-on-main`, `claude/windows-daemon-credential-reuse`,
`claude/answered-refusal-replan`, `feature/workflow-canvas`; `claude/windows-file-fixes`
is one commit main already carries). Nothing product-shaped is waiting on a branch.
Open PRs are dependabot bumps, a draft Windows release-gate PR (#97) and two
community fixes from September that main never took (#90 embedding-worker
recursion, #91 test-concurrency cap).

What the owner can feel, by theme:

| Theme | What landed | Where it is proven |
|---|---|---|
| Clem speaks, the harness carries facts | Declines in words, a stray "yes", "you choose, just go", a host stop explained in Clem's words, background work as Clem's own choice (only `/background` routes directly), a card whose question the model left out asks in Clem's words. | v3.18.29–v3.18.33 live waves; `task-continuity-runtime`, `plan-first`, `chat-approval-resume` pins |
| One card, answered anywhere, edited by hand | Cards written by Clem (question, why, "Exactly what happens"); answered in words or by tap on desktop, phone, Home and Needs you; a change in words links old and new card; hand edits bind by hash into the queued action; a tap on a Home choice is the approval; cards list outgoing files. | v3.18.29, v3.18.32, v3.18.35; `approval-card-edit`, crash matrix 26/26 |
| Honest effect endings | Provider refusal envelopes are read back, not parked; only a dropped acknowledgement hard-stops; four honest endings for a failed approved action; no replay of an uncertain write. | v3.18.32 Slack reminder scenario, ten live runs |
| Faster turns through cache discipline | Tools block byte-identical across a turn's restarts (`5479d37`); `work_call`'s ready list rides the turn context (`8049ddd`); desk climbs and mid-turn promotions held while the cached prefix is large and recent (`11c1d3d`, `7cb73f2`); a layout probe no longer flips on a provider cache miss (`2b439af`); a search answers before the account review (`1d909b4`, 5.3 s median → 250 ms). | v3.18.35: turns start with 7–25K cached tokens instead of 2–4K, the third turn costs half, ~20% faster |
| Only the models you connected | The brain runs on the connected model; a Claude sign-in makes Claude the brain even with an OpenAI key saved; the OpenAI key serves voice and embeddings only; a rate-limited helper falls back inside the brain's family; scheduled jobs wait instead of failing; memory jobs follow the memory model. | v3.18.34 |
| Lighter reviews on reads | A turn that only reads gets one `fast` review; writes keep the full other-family review; cancelled turns cancel their reviews; Jev has a hard deadline. | v3.18.34 (~60% fewer review output tokens); 10-09 data: reads still send 16–54K **uncached** input to the reviewer |
| Files beside the chat, computer access | Saved files appear beside chat on both surfaces; first run asks once what Clem can reach; Settings → Computer access; Spotlight search; `file_query` refuses credential files. | v3.18.35 |
| Windows x64 beta | Sixteen runner rounds: PowerShell 5.1 launch, ASCII JSON over stdin, credential-policy bundle, cold-boot waits, tray icon, unsigned installer. | run 37712746814 |
| Spaces as a framework (step 2) | One schedule per Space (the feed workflow owns it); Refresh runs the feed; the Space shows its feed; `clem.onData`; whole-or-nothing page edits with undo. | v3.18.34; `docs/plans/spaces-framework-2026-10-09.md` |
| Reports land where you look | Scheduled results show in From Clem with full text, Open run, Done; posted once to Clem's pinned thread; phone notified. | v3.18.34 |
| Projects, specialists, scoped memory, graded learning, two modes, Noticing, Goals | On main since the 09-29 → 10-02 waves. | `2026-09-29-project-agent-foundation.md`, `2026-09-30-two-modes.md`, `2026-10-01-wave-after-31824.md` |

What the repo's own records say is still open (not my inference):

- The read-turn completion review is light in effort, not in size: nine desktop runs on 10-10 sent 16–54K uncached tokens to a second model for a read-only answer (`docs/checkpoints/2026-10-09-read-review-cost-data.md`). `reviewAtStakes` (`src/runtime/harness/objective-judge.ts:1563`) changes effort and timeout only; the evidence string is the same.
- No general cost or speed win is proven for memory; recall ranking and scope precision remain incomplete (09-19, reaffirmed 10-02). Memory work was about 47% of priced cost in one 72 h window (09-27).
- A correct answer was graded `goalOutcome=gap` because the reviewer did not see the owner's standing instruction (10-02 §4.3).
- An auto-resumed chat run can wedge the HTTP server into a liveness kill loop; the hard reconciliation stop still speaks machine text (v3.18.32 known limits).
- With several cards open, a bare "yes" in words moves to a fresh conversation (v3.18.33 known limits).
- Plan candidates bypass the completion-review continuation cap (`host-turn-runner.ts:4788`); 7.92M uncached tokens were once spent after a final rejection (09-21).
- **Main's CI is red at its first step.** `npm run check:public-hygiene` rejects `packages/chat-engine/src/live-work.test.ts:18` (a Salesforce-shaped contact id in a fixture string, commit `b0612dd`), so no unit test has run on main since v3.18.34's "22 known failures" baseline. PR-00 fixes it.

## 2. The gap this plan closes

Clem is a multi-model harness in the engine and a single-model product in the hand.
The engine already has six roles (`brain | worker | judge | writer | memory | quick`,
`src/runtime/harness/model-roles.ts:70`), three provider classes plus any
OpenAI-compatible endpoint, a cross-family checker, a hedged judge, automatic
brain fallover, a per-call usage ledger with roles and certified cache accounting
(`src/runtime/usage-log.ts:40`), a route-metrics database with objective and
tool-success rates per (role, intent, model), and a Thompson-sampling route policy
(`src/runtime/harness/route-policy.ts`). But:

- **Every model decision the owner makes is a bare dropdown.** Settings → Models
  has seven role selects, a "What should X do?" strip of four buttons after
  connecting a provider (`ModelProviderForms.tsx:196-244`), and per-task rules in
  Advanced. None of them says why, what it costs, how it has performed, or what
  Clem would pick. The only nudge is the post-turn "Use X for Y from now on?" offer.
- **The one adaptive selector is dark.** The route policy is off by default
  (`CLEMMY_ROUTE_POLICY`, `route-policy.ts:107`), has no UI and is not a developer
  flag. Its outcome data (success, objective met, tool success, latency, tokens,
  explicit billed cost) is being recorded anyway.
- **What Clem measures, nobody sees.** The usage ledger carries role, model,
  account, backend, cache dialect and a trace to the accepted source; `rollupUsage`
  groups by kind, source, model and hour, never by role; the UI shows account
  percent meters and tokens-by-model under Advanced. There is no per-role, per-model
  scorecard, no per-turn cost line, and `brain_fallover` is one of 33 owner-meaningful
  events the daemon never projects (`packages/chat-engine/src/reduce-lifecycle.ts:64`).
- **Automatic defaults are compiled-in ids**, not derived from what the owner
  connected: `claude-opus-4-8` (`config.ts:322`), `gpt-5.6-terra/sol/luna`
  (`config.ts:373`), checker `claude-haiku-4-5` or Luna (`judge-family.ts:533`),
  fallback checker `claude-sonnet-4-6` (`config.ts:337`), adoption `claude-sonnet-5`.
- **Proactivity has engines but few doors.** Noticing proposes one thing per tick
  with evidence; `proactive-offers.ts` (goal, space, skill, workflow, question) is
  injected only into turn context (`src/agents/harness-context.ts:4`) and has no
  UI; "Set up next" in From Clem is a fixed ordered list (`from-clem-setup.ts:31`).
- **The surfaces still stop short of the engine.** A paused turn shows the pill
  "Paused — say "continue" to pick up" and no button (`ChatBubble.tsx:832`, phone
  `Chat.tsx:1115`); `ProgressRail` (think → work → write → check) exists in both
  shells and is mounted in neither; the work-manifest fold is inert; Auto/Ask sits
  under Advanced › Autonomy on desktop while the phone has it in Settings.

The thesis: **make Clem the one who knows her models.** She measures them (she
already does), she explains every automatic choice in her own words with the
evidence beside it, she proposes the next improvement as one card the owner can
tap, and only with the owner's yes does anything change. The same primitive that
carries a model suggestion carries any other suggestion Clem makes, on desktop and
phone alike.

## 3. Binding rules for every PR in this plan

These come from `PRODUCT.md`, the 09-19 checkpoints, the 10-02 handoff and the
owner's recorded decisions. A PR that breaks one is not done, whatever its tests say.

1. **Byte-identical when nothing is accepted.** With no suggestion accepted and no
   new setting on, model resolution, prompt composition, review depth and every
   projection are byte-identical to main. Characterize it the way `route-policy.ts`
   does ("with an empty policy table or the flag off, resolution is byte-identical").
2. **Suggestions never apply themselves.** The only automatic model switches remain
   the ones that exist today: brain fallover, helper benching, dead-login pause,
   quota latch. A suggestion is a durable record the owner answers.
3. **Two families check the work.** The checker stays a different family from the
   brain. No suggestion, policy or default may put them in one family; a plan that
   cannot satisfy it says so instead.
4. **Never route up, never swap a pin.** Premium models are an explicit owner
   binding only (the route policy's own rule). A saved agent's pinned model is used
   exactly or refused (`router-model.ts:239`). Nothing substitutes a provider silently.
5. **No price tables.** The ledger accepts only adapter-reported billed cost
   (`model-route-metrics.ts:1046`, deliberate). Evidence is measured tokens,
   cache rate, time, objective rate, tool-success rate, failures and quota or
   balance where the provider reports them.
6. **Derive, never compile in.** A recommendation engine reads the catalog snapshot
   (`modelRoleOptionCatalogSnapshot`), the capability table, observations and the
   scorecard. No "best model" lists in product code (`PRODUCT.md`; the
   `no-hardcoded-provider-pins` ratchet).
7. **Render the ledger.** Every card, line or chip is a projection of a durable row
   or event, never inferred from assistant text. New events go through the
   fail-closed allowlist in `public-presentation.ts:1058` with bounded,
   enum-whitelisted payloads.
8. **Clem's voice.** Anything she says is written as a person; machine ids fold
   under Details, as the approval cards do.
9. **No new paid traffic by default.** A "try it" that spends tokens is explicit,
   capped and visible. Component timing never counts as proof of a live win; use
   `scripts/session-comparison.ts::measureAcceptedTurn` for before/after.
10. **One record, both surfaces.** Preferences and dismissals live server-side
    (`home-preferences.ts` is the pattern); every card the console renders is also
    rendered by the phone's `ChatEngine`, with a parity test, because the console
    still runs its own `lib/useChat.ts`.
11. **Framework only, live-home acceptance.** Named synthetic fixtures in the
    installed app; never a destructive reset of the live home; preserve other
    agents' edits and the token-meter work.

## 4. The pull requests, in order

| # | Title | Size | Risk | Depends on |
|---|---|---|---|---|
| [PR-00](PR-00-green-main.md) | Green main: the hygiene fixture, the two September fixes | XS | none | — |
| [PR-01](PR-01-model-scorecard.md) | Model scorecard: what each model did, per role, on both surfaces | M | read-only | PR-00 |
| [PR-02](PR-02-suggestion-primitive.md) | "Clem suggests": one durable suggestion record, one card, both surfaces | M | additive | PR-00 |
| [PR-03](PR-03-routing-recommendations.md) | Routing recommendations from what the owner connected | M | additive | PR-01, PR-02 |
| [PR-04](PR-04-clem-sets-herself-up.md) | Clem sets herself up: one plan card after connecting, on first run, on the agent form | M | additive | PR-03 |
| [PR-05](PR-05-governed-auto-routing.md) | Governed auto-routing for helpers: the route policy gets a door and a log | S | opt-in | PR-01, PR-03 |
| [PR-06](PR-06-turn-receipts-and-fallover-projection.md) | Turn receipts and the model events the owner never sees | S | additive | PR-01 |
| [PR-07](PR-07-continue-progress-rail.md) | One-tap Continue, the progress rail, and the work manifest made visible | S | additive | — |
| [PR-08](PR-08-byo-keys-to-vault.md) | BYO keys go to the vault, not `.env` | S | low | — |
| [PR-09](PR-09-local-and-router-presets.md) | Local models (Ollama, LM Studio) and OpenRouter as first-class presets | S | additive | PR-03 |
| [PR-10](PR-10-read-review-evidence-cap.md) | Read-turn review: bounded evidence, measured | M | measured | PR-06 |
| [PR-11](PR-11-capability-learning.md) | Capability learning: what a model proved it can and cannot do | M | additive | PR-03 |
| [PR-12](PR-12-settings-clarity-and-palette.md) | Settings that explain themselves, and a command palette that acts | S | low | PR-02 |
| [PR-13](PR-13-later.md) | Later, each behind its own measurement: plan continuation cap, watcher budget, effort routing, model tryouts, quota-aware scheduling, phone parity, console on ChatEngine | — | — | — |
| [PR-14](PR-14-all-in-byo-identity.md) | All-in BYO identity: options, inactive bindings and memory attribution agree with the router (four baseline failures) | S | low | PR-00 |
| [PR-15](PR-15-last-fixed-sentences.md) | The last fixed host sentences and three stale pins (six baseline failures) | S | low | PR-00 |

PR-00, PR-07, PR-08, PR-12, PR-14 and PR-15 have no dependencies beyond PR-00 and can start today; PR-14 should land before PR-03 reads the catalog snapshot. PR-01 and
PR-02 are the foundation; PR-03 and PR-04 are the owner-visible payoff and should
ship as one release. PR-05 is the first automatic behaviour and stays opt-in.

## 5. What "set apart" looks like when this lands

- The owner connects a second provider and Clem answers with one card: "Here's
  how I'd use what you connected", every row explained, Accept or edit.
- Settings → Models reads like a report, not a form: for each role, the model, why
  it is there, what it did this week (calls, cached share, time, checks passed),
  and Clem's one suggestion if she has one.
- A turn's receipt says who did the work and what it cost in tokens and time, and
  when the brain fell over to another model the owner sees it as a line, not a
  mystery.
- A model that has quietly been doing well for helpers earns a suggestion; a model
  the owner connected and never used earns a bounded tryout; a provider about to
  run out of quota earns a plan before it fails.
- Nothing switches on its own. The owner's yes is the only authority, on either
  surface, and every accepted suggestion can be undone and is followed up with
  "did it help?".

## 6. Companion documents

- [RUNBOOK-local-merge-and-test.md](RUNBOOK-local-merge-and-test.md): merging this branch, the baseline, the hotpatch traps, per-PR fixtures, the handoff prompt.
- [TEST-LANDSCAPE.md](TEST-LANDSCAPE.md): what the suite proves and does not, the baseline classification, rules for touching a failing case.
- `docs/checkpoints/2026-10-10-ci-baseline.md`: the failing-file list on `b0612dd`, case by case.

## 7. Measurement that every PR reports

- `npm run typecheck`, the touched test files one at a time via
  `scripts/run-tests-isolated.mjs`, the release-closure gate where UI is touched.
- For anything on the turn path: `npm run measure:turns` on a named fixture
  before and after, same model, account and cache state; report certified uncached
  input, cached share, wall time, calls by role.
- For anything that changes a review: `measure:judge-calibration` unchanged or
  better, plus the nine-run read fixture from the 10-09 data.
- Installed-app acceptance with a named fixture, receipts kept under `output/`.
