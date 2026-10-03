# Framework improvements, weekend of 2026-10-03

The running record of improvements to the shared framework, starting from
v3.18.26 (tag 4c3a9e421). Each entry names the live problem it answers, what
changed, where, how it is proven, and whether it is installed. Branch:
`claude/blank-state-quiet`. Every entry is framework-level: nothing here
repairs or tunes a personal Space or integration.

Status words: **installed** = hotpatched into the owner's app and serving;
**live-proven** = exercised on the installed app with a named fixture;
**tested** = covered by an automated test that fails on the old code.

## A home nobody has set up shows no failures

- **Problem (live 10-02):** on another owner's computer, Home's From Clem was
  full of "Read failed", "Could not finish" and raw errors from things that
  were never set up (no calendar, no model, no workflows).
- **Change:** never-set-up features stay quiet; set-up-then-broken still says
  so once. Calendar watch is quiet until a calendar is found (7e5ae1f15);
  Noticing waits quietly for a model (8b929d413); a heartbeat whose latest
  check failed shows its name and time only (48c5448d4); scheduled jobs on a
  home with no model wait instead of failing (dc7e73df3); setup notice reworded
  (0e4b193b0).
- **Proof:** `src/dashboard/home-blank-state.test.ts` runs every heartbeat in a
  blank home and finds no failure words; it fails on v3.18.26.
- **Status:** installed, tested.

## An agent pinned to a model answers on it

- **Problem:** switching a conversation to Design Studio (set to Opus) still
  answered on the owner's DeepSeek.
- **Change:** a conversation switched to a saved agent with a model answers on
  that model until the owner picks one for the conversation; the chip names it
  on desktop and phone (092f80557, d33757917).
- **Proof:** live fixture `clem-fixture pinned model` (Claude Haiku): turn 1 on
  DeepSeek, switch, turn 2 requested and resolved claude-haiku-4-5; desktop
  chip "Haiku", phone chip "Claude Haiku 4.5".
- **Status:** installed, live-proven.

## Approval cards speak as Clem, like the question card

- **Problem (live 10-02):** cards read "Approve: cli_setup: install" over raw
  argument names; Needs you said "I'm ready to cli_setup: install"; a reopened
  chat showed "Approval required for … Review apr-7rqj to continue." and a
  "Retained work (durable checkpoint)" list of rh_ ids; the owner's own bubble
  read "approve apr-7rqj". The question card was the one the owner loved.
- **Change:**
  - the checker that already reads every card writes the card's question and
    why in Clem's voice and addresses any conflict to the owner as "you"
    (7065076c3);
  - desktop and phone cards show her question, why, the exact content under
    "Exactly what happens", and answers to tap ("Yes, go ahead", "No, don't do
    that", "Not now"); the owner's bubble shows the answer (8a4364e44);
  - Needs you, Home and the phone title cards with her question (7065076c3);
  - reopened conversations drop the retained-work block (b9b0e0545) and read
    an answered card as the question it asked (7065076c3);
  - the dashboard script permission card asks in words, schedule in words
    (20d79d9c7).
  - the public preview projection carries her words, so the live card and a
    reopened one both show them, and a still-pending card takes the place of
    the reply that paused on it instead of asking twice (1c6674c32);
  - Needs you lists the card by her question, previews her why, and answers
    "Yes, go ahead" / "No, don't do that"; the phone card shows her why
    (89e97b606).
- **Proof:** approval-precheck, approval-card-voice, transcript, sessions-api
  and source-pin tests. Live 10-02 19:03–19:30 PT on the installed app,
  fixture `clem-fixture card check 2` (sess-desktop-d97945b8640886734f2426ec):
  the checker wrote "Can I delete your clem-fixture-keychain-check workflow?"
  / "This permanently removes the workflow and can't be undone."; desktop
  card, phone card and Needs you all showed it with the tap answers; declined
  with the card's answer; the workflow is untouched; reopened, the
  conversation reads question → "No, don't do that." → Clem's reply.
- **Status:** installed, live-proven.

## Approvals ask only when they should

- **Problem (live 10-02):** one CLI install raised three cards in Auto mode and
  then ran through the shell with no card; a four-way "install / skip / use
  another API" question was answered by standing approval for the owner.
- **Change:** installing or signing in a CLI is local work like the shell
  (2fedf101a); standing approval answers only a yes/no — more than two options
  always reach the owner (e739a48ce); the installer uses the owner's own npm
  and records what it installs (abeeaf60a); an old saved main-model entry no
  longer shows as a false "stand-in" (f1824faeb).
- **Status:** installed, tested.

## Deleting a workflow the owner asks for reaches them as one card

- **Problem (live 10-02, fixture `clem-fixture-keychain-check`):** the delete
  had no door: refused as coverage_missing and not_reachable three times, then
  the shell was rightly denied — 22 model calls, 169 s, nothing to approve.
- **Change:** a single fully declared irreversible change enters local planning
  with a structural safe mode (workflow_delete: `confirm = true`); consent asks
  the owner with one exact card in Auto and Ask and never runs it as a planning
  probe; unattended workflow steps still refuse it (f5f0ad9ac).
- **Proof:** local-planning-capability, interactive-consent-policy,
  door-census and authored-workflow acceptance tests. Live: the same request
  paused on one card after 3 model calls and 29 s (before: 22 calls, 169 s,
  no card).
- **Status:** installed, live-proven.

## Prompt caching holds across turns

- **Problem (efficiency audit 10-02):** the first-class tool list changed turn
  to turn (10→15→15→13→14→13→14), re-billing the cached prefix: ~714k uncached
  tokens in a day, about half of all uncached chat brain prompt. An Opus worker
  sent 10 calls with 121k prompt tokens and cached none.
- **Change:** promoted tools stay steady within a conversation, at most eight,
  never discovery doors (f034ad961); a Claude transcript cache marker is gated
  on the whole prefix it caches (6c7807248).
- **Status:** installed, tested; measure on the next live day.

## A judge retry sends the compacted conversation

- **Problem (live 10-02, sess-desktop-c2d014f976a7282e1ac7e1c6, source
  345440):** a judge retry compacted the conversation 71.8k → 30.3k tokens,
  then sent ~83k on every frame of the retry. A same-source continuation runs
  on the source's exact accepted history (it must stay byte-exact for the
  accepted-batch chain), and that history begins with the conversation as it
  stood before the compaction.
- **Change:** the model-facing frame is projected: an input that begins with
  exactly the pre-compaction conversation is sent with its compacted form,
  recorded once as `condenser_applied` kind `continuation_projection`; the
  accepted history and a fresh turn are untouched (1eeb97f63).
- **Proof:** `continuation-compaction-projection.test.ts` fails on the old
  loop; 671/671 across loop, host-turn-runner and compaction tests.
- **Status:** installed (wave 37, 04:00Z 10-03), tested.

## The goal reviewer reads the owner's standing instructions

- **Problem (live 10-02, run trigger-572f895657a43e7bb043dfe0f5f61a14):** the
  weekly snapshot's worker followed the owner's standing rule to leave one
  person off weekly reports (in its memory packet, events 346166/346193/
  346228); the goal reviewer never saw that rule, scored the omission
  unsubstantiated against the saved workflow's older roster wording, and the
  run's notice read "Workflow completed" with no attention flag while its body
  asked the owner to look at a gap.
- **Change (79733bdec):**
  - the goal review receives the User Preferences and Standing Policies the
    run's workers had in context, read from the run's own retained memory
    packets (exact run scope, deduplicated, bounded), under one heading;
  - both goal reviewers carry one precedence rule: an applicable standing
    instruction is the owner's own; following it is not an invented
    preference, departing from it is a gap; it never adds a deliverable,
    reaches past its own scope or relaxes a user constraint;
  - a goal gap after landed work keeps the run a success and its effect as
    it is; its notice now reads "Done, with a gap: <workflow>", waits on
    Needs you and is never folded into a step's own report. Success learning
    already excluded a gap.
- **Proof:** `workflow-goal-standing-instructions.integration.test.ts` runs a
  real workflow through the runner and fails without the wiring;
  `workflow-landed-writes.integration.test.ts` now pins the gap notice and
  fails on the old runner with exactly "Workflow completed: …". 257/257 judge
  and goal-review tests, 228/228 notification and outcome tests.
- **Not done here:** the chat reviewer does not yet read the turn's standing
  policies the same way (it needs an A/B first: judge accuracy is the owner's
  priority). The Friday run was not resent and the rule was not touched.
- **Status:** installed (wave 37, 04:00Z 10-03), tested.

## Source comments state the rule

- This weekend's commits had put dates, counts, record ids and a model name
  into source comments, against the standing rule. b4018ab6b rewrote 26 of
  them to state the rule only; provenance stays here and in test notes.

## Found and already fixed

- "I could not reopen the saved checkpoint" after a successful file save
  (07:53 and 09:50 PT 10-02) was the schema-91 receipt triggers; migration 92
  fixed it and it has not recurred.

## Qualification receipts

- Full suite on `20d79d9c7`: 19,593 passed, 0 failed, 8 skipped.
- Full suite on `eb6cab5a2` (runtime/UI source `89e97b606`, run while live
  checks and installs loaded the machine): 19,547 passed, 3 failed, 1 file
  cancelled at its 600 s limit. All four — workflow-scheduler drain latency
  (1.23 s against a 1 s bound), the nested catalog settlement pair (3 s host
  deadline) and `loop.test.ts` — passed alone at the same revision: 291/291.
- The `40765e31b` suite was stopped deliberately (superseded); it has no result.
- Full suite on `79733bdec` (wave 37, run niced with a disk watchdog while
  another agent loaded the machine, load average 13–27): 19,592 passed,
  3 failed, 1 file cancelled, 8 skipped. Alone at the same revision: the
  store cross-process test, the SIGKILL checkpoint resume and
  connection-execution-closure all pass; the nested catalog settlement pair
  (3 s host deadline, 3.3 s even alone) failed once more under the same load
  and then passed 4/4. No regression attributed.
- Full suite on `652329119` (all phone and desktop slices through the
  desktop parity commit; run niced with the disk watchdog while two other
  agents loaded the machine, load average up to 45): 19,617 passed, 1
  failed, 8 skipped, 0 cancelled. The one failure is the same nested catalog
  settlement test (3 s host deadline); alone at the same revision it passed
  4/4. Commits after it (9f366b32e, 42c4c8830, 67933f9f0) are UI-only and
  their app suites pass (620 desktop, 348 phone).

## Plan from the review handoff

The review handoff `docs/checkpoints/2026-10-02-ui-harness-refinement-handoff.md`
orders the remaining weekend work: (1) continuity through compaction and
judge continuation, (2) one effective contract for execution and review,
(3) recoverable replies, decisions and selected context, (4) command-center
and desktop/mobile parity, (5) honest degraded states in background work,
(6) complete-task efficiency, (7) storage lifecycle. Entries below follow it.

## Open, in order

1. Completion judge on trivial turns (side lanes ~22% of uncached chat input).
2. Approval resumes rebuild the prompt (2–3k of 72–86k cached).
3. `call_tool` arguments sent as an object cost a round.
4. ~~Compacted history is overwritten after a judge continuation.~~ The
   model-facing frame is now projected (1eeb97f63); the snapshot overwrite
   itself is deliberate.
5. Adding an API server (MCP) from chat with a private key field.

## Disk nearly full (10-02 20:50 PT)

The wave 37 build failed with ENOSPC: 131 MB free of 460 GB. Freed without
touching the live home, other agents' worktrees or personal files: eight
leftover isolated test homes (~1.9 GB), superseded updater holds from the
install recipes (~3.8 GB) and 35 old rollback copies (~400 MB). Free space then
rose to 7.2 GB. The large consumers are outside this work and need the owner:
`/private/var/userToRemove` (15 GB of root-owned Jamf MakeMeAnAdmin log
archives), the live home's old backups (~6.5 GB across `backups/`,
`state/backups`, `state/pre-v69-20260829`, `state/backup-pre63`,
`state/dev-backups`) and stale worktrees (16 GB in `~/clem-worktrees`).

## Found live: a brain the account refuses reads as "Something went wrong"

At 20:40 PT 10-02 the active brain became GPT-5.2 Codex (a settings write;
no harness event, before the wave 37 install). The owner's Codex sign-in is a
ChatGPT account, and the provider refuses that model for it: `400 … The
'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT
account.` Every chat turn on the host engine then ends as "Something went
wrong on that turn. Please try again" — not honest, not actionable, and
retrying cannot help. The classifier reads the 400 as `runtime.unknown`; the
host engine has no switch/ask recovery for it. The picker's OpenAI list is the
union of API-key `/models` and the subscription catalog, so a model the
subscription cannot run can still be offered as a brain. The owner's brain
choice is theirs and was not changed.

**Fixed (e1869de38, tested, not yet installed):** a provider 400/404 that
names the requested model marks the error as a refusal of that model; the
shared run-error handler stops both engines with a resumable block that names
the model and says to pick another (one request, no quiet retry). The Codex
brain choices are the sign-in's own catalog once it is known. Proof:
`model-refused-turn.test.ts` (both engines fail without the new branch);
128/128 model and discovery tests.

## Fixtures to show the owner before removal

- workflow `clem-fixture-keychain-check`;
- agent `clem-fixture-pinned-model` and session sess-desktop-0a6b2325050cc3f818b1f066;
- sessions "clem-fixture card check" (×2), sess-desktop-c1f4fd9b4a714b2e8e5dd593;
- session sess-desktop-c064398279b2106370cc3a43 and memory fact 4370 ("leave
  fixture-rep-C off every clem-fixture weekly roster report", kind user, not a
  pinned policy) — captured from a P2 fixture message whose turn failed on the
  refused brain.

## Phone: conversations in the menu, running work visible, round doors

- **Ask (owner 10-02 ~21:30 PT, with Claude, Grok and Codex phone screenshots):**
  a cleaner, more refined phone; running chats stay visible after you leave;
  everything has its place; buttons make sense on a phone.
- **Change:**
  - the menu carries Recents (pinned, then latest) with one live mark per
    row — a turning ring while work is in flight, a dot for a reply that
    finished since you last looked — plus "All chats", the owner's initial
    for Settings and a floating New chat pill (ef48aa487);
  - the phone list reports `running` from the open run attempt; "news" is
    kept per phone against the Mac's own times (first list = baseline; the
    owner's own edits are not news) (ef48aa487);
  - the full list is flat rows with the same mark; heads in sentence case;
    the header doors (menu, Needs you with its count, New chat) and the
    thread doors (Back, agent, project) are one round 44pt style; a stale
    Needs-you count keeps its words and age (d9900bc42);
  - a card answer reads "Yes, go ahead." on the phone and in the live echo,
    from the recorded decision (d9900bc42).
- **Proof:** chat-seen tests, mobile-chat-running-routes (route marks running
  only while the attempt is open), public-presentation answer-words pin; 348
  phone tests; previews on live data via route interception.
- **Status:** committed, not installed (owner's other agent running).

## Phone, continued: one line to type, worded lists, one kind of door

- **Change:**
  - the composer rests as one line ("+", words, mic, send) and opens into the
    full card with its chips when touched; an empty send is grey; Today's
    decisions answer with compact pills; Today's Recent shows running and
    new-reply marks; section heads are sentence case (28761ca7b);
  - Activity rows fit the screen (a run row is a button that sized to its
    widest line) and are named by the work — never by a card answer
    ("reject apr-…") or a machine input ("Calendar watch tick-…: read
    OUTLOOK_…") (server `activityRunTitle`); New project and New agent are the
    same round + header door as New chat; Flows lists read as names; an
    agent's Message is a pill and its model reads as a name (1b9eee75b);
  - Needs you rows lead with Clem's question, then the subject in words;
    workflow ids read as names; kind tags are quiet words (03c957fa2);
  - Settings groups and Today's eyebrows are sentence case (cef16db19).
- **Proof:** activity title pin (webhook.test), worded-rows pin
  (needs-you-rows.test); 349 phone tests; previews on live data.
- **Deferred to after the other agent's merge (its branch edits Chat.tsx and
  BrainSheet):** the model chip's long label ("Codex — GPT 5…"), old approval
  cards that predate Clem's wording ("cli_setup: auth / Catalog id").
- **Status:** committed, not installed.

## Desktop at the phone's standard, and swipe on the phone

- **Change:**
  - desktop conversation list: the phone's live mark per chat (ring while
    running — sessions-api `running` from open run attempts — dot for a reply
    since you last looked, "Working…" in place of the preview); the seen rule
    moved into @clem/chat-engine (chat-seen) so both apps share it; heads
    in sentence case; New chat as an ink pill (5c53fc1c1);
  - Needs you on desktop named in words (list and detail); a card's exact
    details leave out content fingerprints (long hex digests, by shape) with
    one line "Locked to this exact version" (both apps, 5c53fc1c1); Today
    stays two columns until 1536 px and update titles wrap to two lines;
  - phone: swipe a conversation left for Pin / Archive (6831476d6);
  - desktop: Today's Needs-you rows drop the redundant "Approve:" before a
    worded request; Running board workflow cards show names; agent models
    read as names (f4815b17f).
- **Proof:** needs-you-list pin (desktop), approval-presentation fingerprint
  pin, chat-swipe tests + a driven touch swipe in the preview (opens, tap
  closes, plain tap opens the thread), 620 desktop tests, 348 phone tests.
- **Status:** committed, not installed.
- Later the same night: Automate cards and Heartbeats' open items name
  workflows in words (9f366b32e); the phone's Updates render their reports as
  formatted Markdown that wraps inside the card, kinds as quiet words
  (42c4c8830); the desktop's notification pills drop the universal green
  "Sent" and name the kind in the phone's words, only "Failed" stands out
  (67933f9f0). All tested (620 desktop, 348 phone); not installed.

## Integration and install (wave 38), 10-03 ~01:00 PT

- **Owner:** "Start merging all the other work and then hotpatching so we can
  just start running tests … 3 tests … Opus 5.5, codex 6.1 and deepseek."
- **Branch `claude/integration-1003`** from this branch's tip, merged:
  `codex/browser-model-contracts` (Browserbase sessions, task browser docks,
  exact model selection, routing truth; clean merge), `main` (website),
  `codex/storage-efficiency` (history preparation + backlog inventory; nothing
  scheduled), and the relay readiness commit 004cfd7e7 cherry-picked (both
  sides of `mobile-relay.ts` kept: the heartbeat watchdog and the registration
  timeout + readiness check; 23/23 relay tests).
- **Held back:** `codex/storage-efficiency-with-cadence` — it schedules the
  history conversion on the owner's live 6.4 GB database; that plan awaits
  the owner's go. The stray "Release v3.18.26" commit on the relay branch
  (not the published tag) was not taken.
- **Merge fixes (e11c866c6):** the cloud browser stylesheet loads at the
  phone app's entry (node tests cannot load .css) and its stateful panel sits
  beside the stateless Connections page — 348 phone tests.
- **Checks:** three type-checks; 620 desktop, 348 phone, 525 merge-touched
  server tests; no schema change (92).
- **Installed:** wave 38 = e11c866c6 at 08:22Z (01:22 PT), dist + both web
  dists identical. Live: the picker's Codex list is the sign-in's own catalog
  (gpt-5.2-codex no longer offered); on the refused brain a fixture turn read
  "GPT 5.2 Codex isn't available on this sign-in, so I couldn't answer. Pick
  another model…" (blocked, not "Something went wrong").

## Three brains, three tests (live, 10-03 ~01:25–01:45 PT)

Owner-requested measurement on the installed app, live home, real chat
ingress (`scripts/live-ab/run.mjs`, one fresh session per test, one pass).
Brain switched through the app's own active-brain route; every brain call's
served model verified per session in `model-route-metrics.db`; reviewer
verdicts from `goal_alignment_judged`. Settings backed up first
(`.env.bak-brain-ab-1003`); the brain is left on DeepSeek V4.1 Flash.

| test | Opus 5.5 | GPT 6.1 Sol (Codex) | DeepSeek V4.1 Flash |
|---|---|---|---|
| one-sentence (no tools) | 1 round, 16.1k prompt, 5.8 s | 2 rounds (1 tool), 26.3k, 16.7 s | 1 round, 10.4k, 2.5 s |
| heartbeats-read | 4 rounds, 6 tools, 86.0k (39.9k uncached), 20.8 s, pass | 10 rounds, 10 tools, 121.0k (111.5k uncached), 58.8 s, pass | 4 rounds, 6 tools, 69.2k (29.0k uncached), 13.0 s, pass |
| file-write-read | 5 rounds, 95.7k (28.8k uncached), 21.2 s, pass; 1 argument repair | 4 rounds, 48.0k (43.8k uncached), 24.2 s, pass | 5 rounds, 69.9k (20.9k uncached), 8.1 s, pass; 1 argument repair |
| **total** | 10 rounds, 197.8k prompt / 84.8k uncached, 47.8 s | 16 rounds, 195.4k / 177.4k uncached, 99.7 s | 10 rounds, 149.5k / 60.4k uncached, 23.6 s |

- Every reply was correct; the reviewer (Claude Sonnet 5) passed every tool
  turn. With Opus as the brain that reviewer is the same family — not an
  independent review.
- **Found by the measurement and fixed (10becea4d, wave 39):** GPT 6.1 Sol
  refused the `none` reasoning effort used for simple turns on every turn,
  and the new refusal text misread it as "isn't available on this sign-in".
  Now the adapter learns the efforts a model takes from the provider's own
  error, retries once at the nearest one and clamps later requests; an error
  naming a request parameter is no longer read as a refused model. Its first
  run (wave 38) is superseded by the rerun above.
- One pass each (n=1); machine load 2.3–3.4 throughout.
- Full suite on `10becea4d` (wave 39): stopped by the disk watchdog at ~8,700
  of ~19,700 tests when free space fell under 3 GB (suite temp homes plus a
  system `log` collection run); the app was never at risk. One real failure
  before the stop: the JIT classification guard — the browser work moved
  `browser_harness_run` to discoverable while the rubric still names it (the
  browser branch fails it alone too). Classified as reachable on intent
  (3e6903d6b, test-only, 78/78). A complete suite run is owed once the disk
  has headroom.

## "Open a browser" from the phone ended in a generic error (10-03 07:33 PT)

- **Live:** sess-mob-bc99dc237345df65af2f525ae43ddde4 (brain GPT 6.1 Sol, the
  owner's pick at 07:32): `browser_open` (local Chrome) failed in 5 s, then
  the turn ended "I could not reopen the saved checkpoint…" —
  `exact_checkpoint_admission_exhausted` after five `evidence_unavailable`
  finalizations.
- **Cause 1 (8c9332292):** Chrome 154 listens on 9222 but the DevTools
  handshake hangs (consistent with Chrome asking on the Mac to allow remote
  debugging); the 5 s `TimeoutError` had an empty message, so the receipt
  could not prove nothing changed and the open read "uncertain". Now a 15 s
  handshake and a failure in words ("Chrome did not accept the connection…
  allow it in Chrome, then try again"); a message-less exception names itself,
  so a no-change failure is proven no change.
- **Cause 2 (c2d23b478, diagnosed on an APFS clone of the live DB):** the
  runner (09-08 rule) shows the model a local write's own result even when its
  effect is uncertain; the checkpoint treated every uncertain write as needing
  the effect-unknown marker the runner never writes for a local one, so the
  batch could never be saved. One shared rule now (`reconciliation-stop.ts`):
  only an external write or an admin action stops the turn; a returned local
  write with an uncertain effect checkpoints ready — no success handle, no
  replay. New checkpoint test fails on the old code; 562 neighbouring tests.
- **Browserbase:** in this build it drives its cloud browser over CDP through
  Browserbase's own connect URL (no local Chrome); it is not configured on
  this Mac (`configured:false`), and its own record says live/cloud
  acceptance is still owed.
- **Status:** wave 40 = c2d23b478 installed 07:51 PT (build-info serves it;
  daemon, desk and phone bundles match the build). Owner retest from the
  phone owed.

## Browserbase set up, but "open a browser" still used local Chrome (10-03 08:30 PT)

- **Live:** sess-desktop-49ef9f53e02ff150b0575b4f, after the owner saved
  Browserbase credentials (status `configured:true`, key available). The
  model searched the exact name `browser_open`, got only the local Chrome
  tool, and opened it; Chrome refused (the wave 40 words came back, receipt
  `effect: none`), and the turn still ended "The tool stopped after execution
  may have begun…" (`tool_effect_uncertain`).
- **Cause of the stop:** the local tool returned its typed non-write, but its
  text is the browser receipt with `ok:false`; the settlement read that as a
  returned failure of a mutation (`acknowledged=false` → `uncertain_write /
  unacknowledged_mutation`), and the no-progress projection turns any
  uncertain write into `reconcile`. Wave 40 fixed the checkpoint and the
  runner's own flag, not this settlement step.
- **Owner decision:** Browserbase is the browser; local Chrome is the fallback
  (or hidden). Built as one browser per machine.
- **Fix (08289da60):** each browser-driving tool declares `browserBackend`
  (`local`: the typed operations + harness run/setup/status; `cloud`: every
  `cloud_browser_*`). While a Browserbase project is set up (read from its
  own store, no Keychain), only cloud tools are discoverable or runnable;
  otherwise only local. A remembered local name refuses without starting
  Chrome. Settlement: a local tool's typed non-write is the no-change proof,
  so its `ok:false` text no longer makes it uncertain. Tests: new
  browser-backend + browser-no-change-settlement (the settlement test fails
  on the old code); 766 neighbouring tests and tsc clean.
- **Not changed:** a genuinely uncertain local or cloud write (e.g. a
  navigation that timed out mid-flight) still stops the turn through the
  no-progress projection, which has no effect class to apply the shared rule;
  follow-up.
- **Status:** wave 41 = 08289da60 installed 08:48 PT (build-info serves it;
  daemon, desk and phone bundles match; the installed build reads the live
  Browserbase setup: cloud offered, local not). Owner retest owed.

## The cloud browser started, and Browserbase refused the key (10-03 08:51 PT)

- **Live:** sess-desktop-0f85a0625277beaa2315068c on wave 41: the model used
  only cloud tools (`cloud_browser_resources`, then `cloud_browser_start`),
  and the turn kept going after the failure, as designed. Browserbase answered
  the session create with an error; the record went `uncertain /
  provider_refused` and the model said retrying was not safe.
- **Cause:** a read-only project check with the saved key returned 401
  Unauthorized; the saved key is not in Browserbase's key format (it does not
  begin `bb_live_`). The owner re-saved, but the save never landed (store
  unchanged since the failed start): `configure` refuses while any record is
  live, and the refused start had left one `uncertain` with no provider
  session, which maintenance skips, so it would have blocked every future
  save.
- **Fix (7d08ccc73):** a 4xx from Browserbase is a refusal before any effect
  (`credential_rejected` 401/403, `provider_limit` 402/429, else
  `provider_refused`; 408 and 5xx stay uncertain), so a refused start is
  `stopped`. Saving the connection first reads the project with the key: a
  rejected key or missing project is never saved; an unreachable Browserbase
  does not block the save. Only a record holding a provider session blocks a
  connection change; a record with no session expires once the provider's
  session timeout has passed. The model reads the refusal in words.
- **Status:** wave 42 = 7d08ccc73 installed 09:02 PT (build-info serves it;
  bundles match). The owner's key still needs re-entering
  (Browserbase dashboard → Settings → API Keys).

## The key worked; Clem refused Browserbase's regional connect URL (10-03 09:05 PT)

- **Live:** sess-desktop-9eba5cc092ee9ac627590974 after the owner re-saved the
  key (now accepted: project check 200, concurrency 3). `cloud_browser_start`
  created session f770961d (RUNNING, keepAlive, us-west-2), but the record
  went `uncertain / invalid_response` and the model said retrying was unsafe.
- **Cause:** Browserbase's create reply carries
  `wss://connect.usw2.browserbase.com/?signingKey=…` (regional host, signing
  key, no `sessionId`). The client's create parser and the CDP connection both
  required `connect.browserbase.com` with a `sessionId` parameter, so a
  started session was read as an invalid response and left running with no
  record of its id (it times out on its own at 16:35Z). Checked against
  Browserbase's create-session reference and the live session's own GET.
- **Fix (f7053d535):** one shared connect-URL rule
  (`browserbase-connect-url.ts`): `wss`, `connect.browserbase.com` or
  `connect.<region>.browserbase.com`, path `/`, bound by the matching
  `sessionId` or a non-empty `signingKey`; any other host, path, credentials
  or session is refused. The installed predecessor rejects the exact reply
  shape; the new build accepts it. 788 neighbouring tests and tsc clean.
- **Status:** wave 43 = f7053d535 installed 09:12 PT (build-info serves it;
  bundles match). Owner retest owed.
- **Follow-up:** when a create reply is rejected but names a valid session id,
  keep the id so the session can be released instead of orphaned.

## Every open browser in one place; hand a browser to Clem (10-03 09:20 PT)

- **Owner ask:** a spot listing current open browsers, open and close them
  from Clem, navigate to a page and have Clem use it or continue a session.
  Decisions: the Browser chip opens it; all three of hand-a-browser-to-Clem,
  keep sign-ins, and longer lifetimes, but still time out to save usage.
- **Built (206a65bc1 server, 7dfea5462 UI; chip wrap fix 4532dd948 not installed):**
  `GET cloud-browser/overview` lists every open browser across chats (chat
  title, page, `idleClosesAt`, `endsAt`, `usesProfile`) plus running sessions
  Clem started that no record holds (sessions are tagged
  `userMetadata.createdBy=clementine`; another tool's session is never listed
  or closed; Browserbase's list is asked at most every 20 s). `move` hands a
  browser to another chat under a new control epoch (old views detached);
  `unlinked/:id/adopt|close`. One open browser at a time holds a saved
  Browserbase context (`persist: true`) so sign-ins carry over; a second
  simultaneous browser starts without it (Browserbase warns two sessions on
  one context can log each other out). Idle close 15 min, max 2 h; setups
  saved with the earlier 5/30 min defaults load with these. Desktop and phone
  panels: chip "Browsers · N open"; "Other open browsers" with Use in this
  chat (moves it and gives Clem control), Open chat (desktop), Close; lost
  browsers with Use in this chat / Close; this chat's browser shows when it
  closes. 796 neighbouring tests, 39 app tests, both app builds and tsc clean.
- **Installed:** wave 44 = 7dfea5462 at 09:33 PT; live overview answered
  (limits 900/7200); desktop panel captured read-only with no page errors.
  The chip label wrapped to two lines; fixed in source, ships next install.

## The live view showed a blank tab; opening a site took 7 rounds (10-03 09:38 PT)

- **Live:** sess-branch-148d251f43ec8d12c57ed427afc7286d033bbe91 "Can you
  open Facebook in a browser" (GPT 6.1 Sol): success in 54 s. Browserbase
  work took ~3 s; seven model rounds took the rest (tool_search twice, a
  resources check the start description demanded, start, open, navigate,
  answer). The panel named Facebook but the live view area was empty.
- **Cause (probed with a short fixture browser, then stopped):** the live view
  loads and connects, but without a target it shows the browser's first tab.
  Clem opened a second tab and navigated that one, so the owner watched the
  untouched blank first tab.
- **Fix (2f74066c1):** the service keeps the page Clem last acted on
  (`focusTargetId`), serves the live view of that page by default (first page
  if it has closed), and both panels name it and swap the view when it
  changes. `cloud_browser_start` rejoins this chat's open browser, returns
  page handles, and takes an optional `url` opened in the first page in the
  same call; `cloud_browser_open` says it is only for a second tab. 838
  neighbouring and app tests, both app builds and tsc clean.
- **Status:** wave 45 = 2f74066c1 (with the chip one-line fix) installed
  09:49 PT; build-info serves it; bundles match. Owner retest owed.

## Wave 46: the other agent's check-ins, combined (10-03 10:47 PT)

- **Owner ask:** the other agent was preparing to hotpatch its combined code;
  owner asked this session to install it so testing can continue.
- **Candidate:** codex/mobile-checkin-hotpatch at ceff86213, which merged this
  branch's tip (bf929221a, containing installed 2f74066c1). Its commits: live
  check-ins published to subscribers and kept with their accepted task on
  desktop and phone; Jev completion screening abstains when the task text is
  clipped; approval-continuation completion measurement; session comparison
  script. No migration. claude/integration-1003 fast-forwarded to it.
- **Checks:** their tests plus chat-engine/Jev/event-log neighbours 894 pass,
  1 deliberate skip, 0 fail; browser and app neighbours 818 pass; tsc and
  both app builds clean.
- **Status:** wave 46 = ceff86213 installed 10:47 PT; build-info serves it;
  daemon, desk and phone bundles match; Browserbase still configured
  (900/7200).
