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

## The mobile audit failure handoff: first fixes (10-03 12:00–12:36 PT)

- **Handoff:** the other agent's 2026-10-03 mobile audit failure handoff
  (Brett → Ward Law audit; parent sess-mob-2738af7e1d2f603518d234981db69eff).
  Owner decisions: Scorpion Audit on Opus 5.5; install the small explanation
  fix now, batch the worker fixes; "we can't have workers blocked by things
  like that".
- **Wave 47 = dda4c87a2** (12:19 PT): the other agent's fix — a completed
  no-progress explanation replaces the internal error in the blocked terminal.
- **Scorpion Audit model:** saved `claude-opus-5-5` through
  `PATCH /api/console/agents/scorpion-audit` (file reads it back). Proof of
  saved = requested = served on a fixture run still owed.
- **Worker blocked on reads (7851a5786):** worker 349137 was leased
  `dataforseo__api_request`, the same tool the parent had just run; its four
  `/live` POSTs were refused `WORKER_COMPOSE_ONLY` although all four shapes
  were learned `reads_only` on 09-29 (judge-confirmed). The host worker check
  used the sealed manifest effect alone; it now asks
  `workerMustComposeForParent`, the same learned-read rule as the parent's
  `hostCallAccounting`. Unknown shapes, writes, admin and declared-destructive
  tools still compose to the parent. Pin proves the runner uses it.
- **Shell false positive (4ad0ef94b):** worker 349282's `sqlite3 … ".tables"
  2>&1 | …` was refused as an authorization-state write. Descriptor
  duplication is no longer a write signal; the sqlite3 database is a target
  only when the command changes it (also fixes `SELECT … 2>/dev/null`). Gaps
  closed in the same pass: `>& file`, sqlite3 `.import/.restore`, VACUUM,
  REINDEX, `PRAGMA x =`, and `.backup/.save/.clone/.output/.once FILE`.
- **Checks:** 4,622 tests across 163 shell/worker/learned-read files pass;
  tsc and both app builds clean.
- **Wave 48 = 4ad0ef94b** installed 12:36 PT; build-info serves it; bundles
  match.
- **Still open from the handoff:** worker honesty as a typed outcome from host
  facts (compose-only refusals per worker run, across the host and Claude
  lanes); task sizing for large jobs; retained-result navigation for large
  MCP envelopes; the controlled Opus fixture run; the full mobile workflow.

## Clem → lead agent → workers (10-03 13:00–14:00 PT, not installed yet)

- **Owner ask:** "the brain should be able to fan out workers and an agent
  should also be able to fan out workers … that agent is not just a worker. It
  should be another brain." Decisions: Clem keeps chatting while the lead
  works and checks in; the lead's messages show in the same chat, labeled;
  projects name a lead (proposal-builder → Scorpion Audit).
- **Map (three read-only investigations):** a delegated background task with
  agent + project already runs a full brain as the agent (its model, the
  project context, run_worker, own approvals, report-back); the audit used
  run_worker instead, which runs the agent as a capped worker (8/12 turns,
  18 for heavy intents) without project context, memory, workflows, planning
  or questions. No depth guard existed; dispatch_background_task was not
  blocked for workers; the Claude worker profile still had check_in and
  notify_user.
- **0842942d6:** project assignments carry `lead` (store v2, one per
  project); with nobody named the lead takes a project's delegated job; the
  project context tells Clem who leads (hand whole jobs via
  dispatch_background_task, run_worker for one small item) and tells the lead
  to plan and run its own workers; workers on both lanes get the project's
  folder, procedures and accounts ("one item of a job"). Depth enforced where
  work starts: a worker starts neither workers nor tasks; a lead running a
  delegated job does not hand it on. Also fixes my 08289da60 regression: the
  native catalog's names now apply the browser-backend rule, so the recorded
  catalogCount matches the text again (fresh-native-read-catalog 7/7).
- **391b94f28:** a delegated run's check_in is kept on the task (newest 20)
  and published to the origin chat as delegated_task_state `check_in` with
  the agent's name; the public stream admits it; the chat row shows the latest
  note; desktop and phone task cards list the newest check-ins. check_in and
  notify_user refuse under worker scope on every lane.
- **Worker honesty (see the commit after 391b94f28):** compose-only refusals are recorded as
  `worker_compose_only` where they happen (host runner, Composio gateway),
  attributed per worker (Claude lane by tracker scope, host lane by child
  session), and every worker result path appends a host line naming the
  actions not done there. Status is not flipped to failed, so the designed
  compose-then-parent-commit flow keeps working.
- **Lean Rounds (owner asked for an explanation before the hotpatch):** the
  journey ratchet fails 21 cases since be75a4c5c (other agent, 10-02 21:45,
  typed local browser operations): round 1 +410 B in five scenarios from the
  browser tool names in the native catalog; no case needs more rounds;
  f_calendar_read_warm round 1 −11.7 KB and turn −23 KB. Not in the full
  suite (journeys are not globbed), which is why it went unnoticed.
  The owner accepted the measured table as the new baseline (27/27 pass).
- **Wave 49 = 0bf7977d9** installed 14:05 PT (build-info serves it; bundles
  match). proposal-builder's lead set to Scorpion Audit through the app route
  (`lead: true` read back).
- **Controlled live proof (fixture project "Clem fixture: lead run",
  prj_4a7jbfpqaz2b5y; agent "Clem Fixture Lead" on claude-opus-5-5; chat
  sess-desktop-df1f6ce3e859e4e8abb3860d):** Clem (GPT 6.1 Sol) handed the
  job to the lead via dispatch_background_task in ~20 s; the lead run routed
  to claude-opus-5-5, read the project CLAUDE.md, fanned out three workers in
  one run_worker batch (DeepSeek V4.1 Flash, the worker default; 7 s), read
  every file back, wrote INDEX.md, and finished at 70 s; the origin chat got
  dispatched / started / finished under the lead's name and the lead's report
  as the report-back message. All four files follow the procedure exactly.
  Not exercised live: check_in (the job was too short to need one; covered by
  tests) and folder linking (the fixture folder is not among the owner's
  workspace folders, so the project context named it instead).

## The Ward audit, run end to end on wave 49 (10-03 14:48 PT)

- **Owner ask:** "have Clem run it for me so you can watch this framework end
  to end", then "fix this at the framework level … Clem should be able to call
  an agent in a project to get work like this done."
- **Run:** chat sess-desktop-4b59322ffc57fd3583ec996b in proposal-builder
  (prior ward-law-brief backed up to ~/clem-fixtures/backups/). Clem found
  Brett's Slack request and handed the job to Scorpion Audit on Opus; the
  lead recovered Brett's nine-area brief, checked the draft and research,
  posted a clear check-in, ran two Apify scrapes, then stopped blocked at
  ~8 min (task bg-musxdykf-1ec847). No workers yet.
- **Root cause 1 (connector access read from Clem's text):** the lead's run
  got no external MCP scope — reason "user excluded dataforseo". The job text
  Clem wrote said "Use actual connected DataForSEO MCP (not Composio
  DataForSEO)"; the access parser read "(not … DataForSEO)" as the owner
  refusing DataForSEO, so mcp_list_tools showed 0 tools while the server
  itself lists 4 (api_request among them). The owner's own message refuses
  nothing. Fix: `ownerWords` on the MCP scope resolvers; in a delegated job
  the owner's message (origin chat, originSourceUserSeq) alone decides access
  and refusals (the constraint, the denied list and the local-only check);
  the job text still decides relevance; an unreadable origin keeps the
  ordinary reading so no owner refusal is lost.
- **Root cause 2 (one shell refusal ended the job):** the lead tried to drive
  the MCP server by hand through the shell; the shell safety rule refused it
  correctly before running anything, but the stop projection treats a
  host-crossed policy refusal as a factual stop. Fix: shell safety refusals
  are marked `shell_policy` and close that route only (repair, not_started);
  every other policy refusal (approvals included) keeps its stop.
- **Root cause 3 (internal text in the chat):** the no-progress explanation
  ran only in chat sessions, so the lead's stop reached the owner as
  "Execution evidence … Stopped at: execution:policy_denial". A delegated
  job now gets the same explanation (its stop is reported to a person).
- **Commits:** 1481650a6 (owner's words decide connector consent in a
  delegated job, resumed jobs included), 80a4dd7dd (shell safety refusal →
  repair, not stop), eaf7616a3 (delegated stops explained in words), plus
  the other agent's browser viewer renewal merged (8448052db: 176742a43,
  79e20b415; their tests 58/58). Related tests 5374 pass / 0 fail;
  continuity-resolver tests 173/173; tsc clean.
- **Wave 50 = 8448052db INSTALLED 15:43 PT**, build-info + three dists
  verified, schema 92.
- **Live, same task resumed in place (owner's Resume route):** the lead's
  scope is now "seo/web-audit intent …" with dataforseo allowed (was "user
  excluded dataforseo"); mcp_list_tools shows the 4 tools; the lead's
  dataforseo__api_request calls return status 20000 Ok. Note: the generic
  request tool is classed external_write (POST), though these are search
  reads; Auto runs them without cards.

### Second stop of the resumed audit (22:53Z) and its root cause

- **What happened:** after a good first checkpoint (Miami's local-trust edge,
  NYC demand ~5x Miami, thin Spanish organic), the lead hit the 64-call
  activation cap, auto-resumed, and its next Opus request was refused: HTTP
  400 invalid_request_error "You're out of extra usage" (req_011Cfg8F1TmQKs…).
- **Not a used-up plan (owner was right):** probes through Clem's own sign-in
  30 min later served claude-opus-5-5 normally, with every request shape
  (identity only, custom system, tools, large system). Claude's unified
  headers on those replies: 5h 0.09 allowed, 7d 0.78 allowed_warning,
  representative claim seven_day — Clem's host lane bills the subscription.
  Overage status rejected, reason out_of_credits. The "Fable" 100% on the
  meter is its own bucket (7d_oi 0.99, Fable only), not Opus. So one Opus
  request briefly passed a subscription limit during the lead's burst
  (~3.1M input tokens in 9 min) and, with no extra-usage credit to spill
  into, was refused. My first reading (a model weekly cap) was wrong.
- **Why it stopped instead of waiting:** the bridge reduces a provider failure
  into the committed terminal and returns it as an ordinary response, so the
  background runner never saw the refusal and its brain-outage retry never
  ran; and even thrown, the plan-limit wording skipped the retry without
  consulting Clem's own usage reading.
- **Root cause (framework):** the lead ran the data gathering itself on its
  own pinned premium model. Two runs, 66 calls, 5.29M prompt tokens (4.80M
  cache reads), ~80K tokens per call, zero run_worker calls; every other
  Claude use in two days is under 240K. The fan-out directive it was given
  (14 items detected, wave size 8) says "same-shape reads → PARALLEL tool
  calls in one response", which pulls every raw SERP/keyword payload into the
  lead's context for every later call. Workers could have done it: they get
  the lead's resolved tools, and the DataForSEO request shapes were learned
  as reads during the run (10 verdicts).
- **Fix (retry):** the runner reads the refusal back from the activation's
  own terminal and takes the brain-outage path; when the brain's account has
  room by a fresh reading (every plan window under 100%), a capacity refusal
  is a brief limit: the job waits (2/5/10 min, 3 attempts), says so in its
  check-in and in the chat that handed it over, and retries on the same
  model. Without such a reading (or for an account Clem cannot read) the
  plan-limit stop stays, now in plain words. The refusal's limit headers are
  now logged with the cooldown line.
- **Fix (burst):** in a delegated job the fan-out directive (both the packet and the
  Claude brain lanes) sends the items, gathering included, to run_worker; the
  agent's own calls are planning, checking and the final write-up. The lead's
  project text says the same.
- **Stop words:** a failed turn whose provider says the account is out of
  usage/credit now says so, quotes a short plain provider sentence, and names
  the two fixes (add usage / choose another model, then resume) instead of
  "Something went wrong … try again".
- **Missing chat report:** the report-back dedupe was once per task, so a
  resumed task's second stop was swallowed as "already reported". Reports now
  carry the stop's identity (`outcome:snapshot.capturedAt`); a replay of the
  same stop still dedupes.
- **Check-in length:** the tool description now names its 600-character cap
  (the lead learned it from a refused call).

### The real billing cause (owner: "it could be how the requests are routed")

- After wave 51 the resumed lead's FIRST request was refused again, and the
  refusal carried only `overage-disabled-reason: out_of_credits`, no 5h/7d
  headers: Claude had not counted it against the subscription at all.
- Bisected live through Clem's own sign-in (decrypted the stored model
  request snapshot, replayed it; refusals cost nothing): Clem's system prompt
  alone bills the subscription; the real tool list alone is refused; tool by
  tool, only `mcp_status`. Any tool definition named `mcp_…` (single
  underscore) is billed as extra usage: `mcp_status`, `mcp_list_tools`,
  `mcp_reconnect`, `mcp_add`, `mcp_lookup` refused; `server_status`,
  `status_mcp`, `mcp-status`, `mcpstatus`, `MCP_status`, `mcp__status` bill
  the subscription; a history tool_use or text naming `mcp_status` does not
  trigger it. All 282 other registered tool names checked: none trigger it.
- So every lead call that offered `mcp_status` first-class was extra usage
  (why 5.3M Opus tokens left the 5h window at 9%), and it all stopped when
  the extra-usage credit ran out.
- **Fix d4c95ca3f:** the Claude wire spells an `mcp_` tool `mcp-` (history
  tool_use and a forced tool_choice follow), and the model's calls come back
  under the real name in streamed and whole replies. Live replay of the
  refused lead request through the fixed code: 200, claim seven_day, and the
  model's call returned as `mcp_status`. Tests 798/798 for the wire.

### After wave 52: the job ran on the subscription, then three more framework gaps

- 23:57 the scheduled retry ran on wave 52 and was accepted (billing fixed);
  the lead worked ~10 min (evidence review check-in posted first try) and
  stopped at 00:07 "This task reached its configured active-time limit".
- **Per-step budget parked the job.** The background runner gives each
  activation a 10-min active budget (BACKGROUND_STEP_WALL_CLOCK_MS); the host
  reports it as a blocked terminal (blockedReason wall_clock), which the
  runner parked as a stop — a 240-min job needing a manual Resume every ten
  minutes. A loop-level remap broke the connection-execution closure tests
  (a reviewed source's spent budget must stay a stop), so the fix is in the
  runner: a step whose own active-time budget ran out continues as a new
  source (max-turns-with-grace path, inside the task limit and caps).
- **Owner chat report showed internal text.** publishProactiveOutcome posts
  renderPublicOutcomeText, which led with "Execution evidence" incl. the
  newest raw tool failure in the run (an hour-old, recovered file_query
  refusal) and pasted the lead's retained-work handle list. The owner-facing
  text now says "Done so far" (progress facts), drops the raw tool failure and
  the retained-work section; the model-facing report keeps everything.
- **The lead never fanned out, though the guidance reached it** (verified in
  the stored request: lead text + delegated directive present). Cause: the
  dispatch wrapper "Agreed plan (execute these steps … do NOT re-derive a
  different approach)" plus Clem's plan "Own this entire job end to end"
  forbade the lead from splitting the work. A job handed to an agent now gets
  "Agreed plan (its scope, sources and limits were settled with the user —
  keep to them; how you split the work across your workers is yours to
  decide)"; an ordinary background job keeps the strict wrapper.

### Wave 53 live: the lead fanned out, and the workers could not use DataForSEO

- 01:43Z the steered job (request v2: hand gathering/sections to workers)
  resumed on Opus; 01:48:56 the lead declared work manifest
  "ward-law-audit-wave2" and started 12 (then 14) DeepSeek workers — the
  Clem → lead → workers chain on a real job.
- 3 ok / 11 failed (7 control_no_progress_exhausted, 4 max_turns). Every
  worker DataForSEO call refused pre-dispatch
  `catalog_entry_or_manifest_missing:candidates=0:proven=none`; the "ok"
  serps item had also been refused and returned text with no tool use.
- Cause: the lease (externalMcpToolNames) reached the worker scope, but the
  worker's tool_search was built with no provider candidate sources
  (sub-agents.ts), so the leased tool was never discoverable/provable.
- The lead then asked the owner "the DataForSEO connection dropped — can you
  reconnect?" (false: the server is fine; also an "ASK:" marker leaked into
  the question text — open).
- Fix: worker tool_search gets buildAuthorizedToolSearchCandidateSources
  over exactly the leased scope (carrier = the worker's door). Worker and
  discovery tests 553/553.
- Wave 54 = d62fbbd3a installed 19:02 PT (normal quit worked this time).
  Answering the lead's question (owner chose: retry the failed pulls via
  workers) failed the turn in 7 s: `model request provenance refused:
  accepted_input_not_visible`. The accepted input of an answer-resume is
  `prompt + "\n\n" + answer`, but buildWorkerInputResumePrompt put the
  answer first and the prompt last, so the exact text never appeared — every
  answered background question failed. Fix: the resume message carries the
  accepted input verbatim after "Original request:". Test pins it (fails on
  the old layout).
- Wave 55 live re-run (02:11Z): 11 workers, 0 DataForSEO successes, 43
  pre-dispatch refusals, discovery `sources: []` — 19f995527 never took
  effect: slim workers keep tool_search off the first-class surface, so the
  model reached discovery via call_tool's built-in tool_search (no sources).
  Fix: a worker with a planning context and a parent lease keeps its
  leased-source tool_search first-class (door = work_call for contracted
  action items, call_tool otherwise). Sub-agents 17/17, worker tests 554/554.
- The lead then asked the owner to top up DataForSEO for "402 Payment
  Required" — fabricated by DeepSeek workers in their output files; no
  DataForSEO request had run (all refused pre-dispatch). Open: host-written
  facts beside a worker result (which calls ran / were refused) so a lead
  cannot be misled by a worker's prose.
- Wave 56 = f6c4b3114 installed 19:33 PT via recipe 56b (first 56 attempt
  refused: the installed-tree patcher's unanchored pgrep matched my own
  waiting command, which named the bundle path → app left closed ~10.5 min;
  relaunched by bundle path; trap recorded). Owner's answer delivered via
  the answer route (works since wave 55).
- **Live proof (02:34Z):** re-run workers now discover the leased tool
  (discovery 3 sources / 2 candidates) and call it: competitors-miami 4 and
  competitors-orlando 4 successful DataForSEO calls, competitors-newyork 2,
  maps-office-newyork 1. Durable manifest resume reused 7 earlier items.
- Remaining worker limits seen: (a) a request shape not yet learned as a
  read is WORKER_COMPOSE_ONLY for a worker (learning happens only in the
  parent's own calls); (b) DeepSeek serps workers spent 18 responses with
  one tool call → max_turns (model/item sizing); (c) manifest resume reuses
  "ok" items whose output holds no real data (worker honesty).

### Next: workers act with the lead's authority for leased tools (owner approved, option 2)

Owner decision (10-03 ~19:50 PT): a worker may make the same external calls
its lead could, for the tools the lead leased it, with guardrails — leased
tools only; external_write only (never admin); same write-boundary gates and
irreversible-send floor; in Ask mode the call goes back to the lead; learning
still runs. Design (mapped, not built):
1. Gate — host-turn-runner.ts ~6371 (inside `if (exact)`): skip the
   WORKER_COMPOSE_ONLY return when `workerMayActAsLead`: store.workerScope;
   exact.effect === 'external_write' && exact.boundary ===
   'host_owned_external'; store.mcpToolScope.authority === 'exact' and its
   allowedToolNames include exact.logicalToolName; Auto mode
   (`loadProactivityPolicy().autoApproveScope === 'yolo'`,
   host-interactive-consent.ts ~1172).
2. Coverage — a worker source has no exact work coverage for an external
   write (consent → repair coverage_missing, interactive-consent-policy.ts
   ~496). Extend delegateExpectedWorkToChild (expected-work-delegation.ts)
   so a leased external operation gets a child contract derived from the
   lead's proven requirement, as local writes already do.
3. Hand-back — at the consent `needs_user` branch (host-turn-runner.ts
   ~11032), a workerScope run returns the WORKER_COMPOSE_ONLY hand-back
   instead of recording an approval nobody sees (always-ask classes and Ask
   mode fall back to the lead).
Learning: already scheduled for any session's settled write
(logical-call-settlement-store.ts ~651 observeSettledRequestEffect).
Tests to write: gate predicate (lease/effect/mode matrix), child coverage
for a leased external op, needs_user hand-back in a worker, and a controlled
live fixture (a generic read-shaped request tool leased to workers, never
learned) proving workers run it and the type becomes a learned read.
- **Built (fe92de967):** workerMayActAsLead (host-tool-invocation.ts) — a
  worker's external write proceeds past WORKER_COMPOSE_ONLY only for a tool
  in its exact lease, effect external_write (never admin), boundary
  host_owned_external, owner in Auto (`ownerRunsInAutoMode`, shared with the
  consent mode). Coverage needed no change: external MCP calls carry a
  catalog_manifest binding and evaluateUncoveredHostMutationConsent builds
  exact coverage from it (the lead's DataForSEO writes recorded
  exact_carrier_bounded_work). A worker's consent `needs_user` returns the
  WORKER_COMPOSE_ONLY hand-back instead of recording an invisible approval.
  Learning unchanged (observeSettledRequestEffect runs for any session).
  Tests: predicate matrix + 1606 consent/host-runner/worker tests (0 fail).
  Live proof pending (needs an unlearned read-shaped request in a worker).

### Owner: "make sure the models can't lie" and "is running out of turns DeepSeek or workers?"

- **Turn exhaustion (data, 14 days):** DeepSeek V4.1 Flash 104 runs, 71% ok,
  13% max_turns; other worker models 98–100% ok but on small, non-comparable
  items. The Ward serps max_turns came from the LEAD's packets: "Same 5-query
  set and rules as serps-miami" — workers never see sibling packets, so the
  worker spent 16 shell calls hunting, reached DataForSEO on turn 18 and hit
  the 18-turn research budget. Packets with the specifics succeeded (4 and 8
  DataForSEO calls). DeepSeek's share: it ignored "work only inside" and
  "fail fast". Verdict: worker-general (packet design) with a model
  discipline factor; not enough data to call it DeepSeek-only.
- **Fix 110797dba:** an item's facts that name another item of the same batch
  by exact id bring that item's facts along (one level).
- **Fix 1685c56d0 (models can't lie about what they did):** every host-lane
  worker result ends with the host's record of its business calls
  (succeeded / failed / refused before dispatch — "no request reached the
  provider"); where the worker's account disagrees, the record is right and
  the parent reruns. The work plan no longer banks a success whose business
  calls all failed or never ran (the serps-miami empty "ok" that was reused
  four times); a worker that needed no business tool keeps its result.
  Tests: record + banking + 2807 worker/orchestrator/Lean Rounds pass.
- Open: model fit for heavy research as a setting (intent → worker model);
  Jev/judge check of worker claims vs the record (later layer); SDK worker
  lane gets the same record.
- WAVE 57 = 069613588 (workers act with the lead's authority), WAVE 58 =
  3b4d754e8 (host record on worker results; unbacked successes not banked;
  sibling item facts), WAVE 59 = 9e14f2c02 (check-in questions lose the
  ASK:/CONTINUE: marker — e47e4fef0; paused job cards show why, without
  retained-work handles — 8f62ed938; quit-step deadlines in the desktop shell
  — 9e14f2c02, ships with the next signed release, desktop tsc clean).
- Model fit for heavy research needs no code: saved worker intent rules
  ("helpers for <kind of work> use <model>", worker-model-route.ts) apply
  only with model routing on; the owner's routing mode is off.
- Ward audit: lead finished 03:24Z — "built and passed local QA", index.html
  159 KB, nothing deployed; gap = 6/7 on-page URLs + NY Lighthouse (workers
  were compose-only for those request types, fixed by wave 57).

### Owner: "are all these fixes across all lanes?" — extend them to every lane

Lanes: the host harness (Clem's loop) runs every brain and host-lane worker;
the Claude Agent SDK brain lane is retired in production; workflow runs ride
the host loop. The Claude SDK WORKER lane only takes a Claude worker whose
parent turn did NOT come from the host planner (`!hostFreshPlanning &&
!planMode`); every production chat and delegated job comes from the host
planner, so a Claude user's workers run on the host harness too. Live home:
the SDK worker lane last ran 09-21 (11 events in 30 days). Owner: don't
spend more time on it — the two cheap changes below stay, no more SDK work.

- **Worker honesty record on the SDK worker lane — de7d3a7d0.** An SDK
  worker's business calls land in the parent session under its run scope
  (`<session>::worker:<packetKey>`, `tool_returned`, top-level business);
  `workerScopeCallRecord` reads them, the result carries the same host record
  and the plan banks it only when backed by work. The record now rides
  BESIDE the reply (after the execution receipt) on both lanes, not inside
  it: inside it, a long reply lost its raw tail in the lossless store (the
  100-item journey: 101 of 102 raw outputs; wave 58 shipped that regression
  on the host lane — this fixes it). Tests 131/131 incl. the journey.
- **One rule for worker authority — 12834f75d.** `workerMayActAsLead` +
  `ownerRunsInAutoMode` live in `worker-lead-authority.ts`, called by every
  lane; a leased tool matches by canonical identity (`mcp__` carrier and case
  no longer matter; alias-confusable servers still do not match). The SDK
  approval gate no longer raises a card for a worker: a call that needs the
  owner returns WORKER_COMPOSE_ONLY to the parent, recorded under the
  worker's scope. Native external MCP calls in the SDK lane are refused
  before any gate (FOREIGN_MCP_DIRECT_EXECUTION_DENIED) — outside calls go
  through the local work_call/call_tool carrier.
- **Bridge thrown capacity error — 88bfe95f4.** A chat turn that dies on a
  provider capacity refusal stores the owner-facing capacity text.
- **Workflow report-back: not a gap.** A run's report envelope is immutable
  for the run's life (one terminal report per run); parks go through the
  awaiting-input question path; a re-run is a new run with its own report.
- **Combined the other agent's browser-viewer fix — 68ecfabf6** (from
  codex/browserbase-live-view, uncommitted there, byte for byte; see
  docs/checkpoints/2026-10-03-browserbase-native-viewer-fix.md). Desktop
  shell only, so it ships in a signed whole-app build, not a hotpatch —
  together with the wave 59 quit-step deadlines and the update disk-space
  guard. Verified here: 21 tests, desktop + preload typecheck, the Electron
  smoke script (7/7). Blocker: a signed build needs ~15 GB free; the disk
  has ~1.9 GB and deletions need the owner's go.

### Owner: "get going on these improvements and think big picture"

- **3dd7447c1 + 6a63ad817 — write_file mode=replace.** `find` (exact text,
  must appear once) + `content` (replacement); computed under the revision
  lock from the bytes it replaces; prior bytes kept; a replay recovers its
  receipt instead of editing twice; missing/ambiguous/append-flagged
  requests refused before any change; planners see `cap:local:write_file:
  replace` (reversible, named existing). Tests: 3,516 write_file-touching
  tests (3 pins updated) + 217 registry/planning/Lean Rounds.
- **eb75cf549 — delegated-work lines name a paused job's output** ("Its
  output goes to: … (may be partial)") and why it stopped, without the
  saved-work handles. WAVE 61 = 6a63ad817 INSTALLED, verified.
- **Live fixture (project "Clem fixture: lead run", edit-check.html, 45 KB),
  wave 61:** one-sentence edit → correct bytes, but 93 s: 43 s in the
  continuity check (an old unfinished task in the chat sends the next
  message through turn semantics on the BRAIN model, gpt-6.1-sol; 4 such
  checks since 09-27, DeepSeek ones ~5 s), then the brain sent the edit to a
  worker on the lead's Opus — my 0842942d6 guidance said "use run_worker
  for one small item" and never "do it yourself".
- **9d3b2fb4d — in a project with a lead, Clem does quick work herself.**
  WAVE 62 INSTALLED. Live rerun: no worker; Clem edited directly (shell
  python with an exactly-one assertion — "Market note 7" also matched
  70-79, so it correctly refused), then the recovery surface refused her
  natural repair twice (read_file, then work_call), the turn went `held`
  and the chat endpoint answered "still owned by Clem's recovery system";
  the work finished correctly 36 s later (byte-exact) with a proper answer.
- **4e4bdb4c4 — the held reply is plain words** ("I'm still working on this
  and will post the result here when it's done."). WAVE 63 INSTALLED,
  verified.
- Clem (gpt-6.1-sol) did not choose write_file replace in either run; shell
  edits work but keep no recoverable prior bytes.

### Owner: SDK lanes question, then "agree with the rest"

- **What the Claude SDK lanes ran (live home):** brain 150 turns, last
  08-20; workflow steps 45, 08-14..08-25; workers 17 ever vs 2,453 on the
  host — the last real one 08-12 ("What's in my rep risk workspace"); the
  September ones were framework tests (09-05 "harmless test email drafts",
  09-06 "fictional Cedar account portfolio", 09-20 fallback-model check).
  STILL USED and staying: coding agents (Claude Code via the Agent SDK,
  last run 09-25), model discovery, the Claude client version. Recommended:
  freeze the dormant brain/worker/workflow-step paths now, remove later in
  one revertible commit — owner decision pending.
- **74c308741 — recovery admits a local re-read.** A failed non-mutating
  command says "check the current state"; recovery now always admits reads
  of a local path (`readRevision: local_path` — read_file, list_files);
  writes, external reads and controls stay out. ffffd502f updates the held-
  reply pins on the bridge and Discord (wave 63 shipped with those two
  pins stale). 1,452 recovery/no-progress tests pass. WAVE 64 = ffffd502f
  INSTALLED 06:41 PT, verified.
- **Live rerun on wave 64** ("Market note 8", also matches 80-89): 20 s
  total, pre-work 5 ms, one exact shell edit (learned strategy), Jev
  completion check 4 s, bytes exact. The failure path was not hit live;
  the recovery change is proven by tests.
- **#2 re-scoped by data (last 7 days):** continuity check 4 runs (5–43 s);
  completion check 312 runs, median ~9 s from last work to verdict, p90
  ~60 s; depth full 189 / fast 68; judges Sonnet 5 164, GLM 68, Grok 31,
  Jev 27. Proposal to owner: review depth by stakes + a quick-check role.

### Owner: "Depth by stakes + fast role", "Freeze now, remove later"

- **SDK lanes frozen** (memory project_sdk_lanes_frozen_1004): no fixes to
  Clem's Claude SDK brain/worker/workflow-step paths; removal later in one
  revertible commit after an import audit; coding agents, model discovery
  and the client version keep the SDK.
- **d76cf77cd — review depth by stakes.** `sourceWritesAtStake`: the full
  completion review counts writes that reached outside (provider
  execution), failed or were refused, or changed local state that cannot be
  restored (shell edits, workers). A succeeded `write_file` (a local
  artifact capability, non-destructive, prior bytes kept) takes the read
  depth, still confirmed at full depth before any send-back. 429 host +
  judge tests. WAVE 65 INSTALLED.
- **f89f5797f / f2ba9141f / ef0c99003 / efddec1c4 — Quick checks role.**
  `quick` model role: default = the fast model of the brain's family
  (codex → gpt-5.6-luna, claude → claude-haiku-4-5, all-in BYO → the BYO
  judge); bindable only from Settings; never moved by the learned route
  policy; never an agent's model. `turn_semantics` and
  `calendar_read_operation` run on it; a quick model that cannot answer
  falls back to the brain for that call; usage still records as
  interpretation. Settings › Models shows "Quick checks" on the Mac and the
  phone (shared words in @clem/chat-engine). 345 semantic + 237 settings UI
  tests. WAVES 66 (ef0c99003) and 67 (efddec1c4) INSTALLED, verified; live
  role = gpt-5.6-luna (codex, default); desktop + phone rows captured
  headless (no page errors; the phone test device revoked).
- Not yet seen live: an interpretation call on the quick model (it runs
  only when a chat holds an unfinished task).

### Owner day agenda (10-04): Ward brief first, then the framework

- **0c535d02d — quick-check deadline.** A quick check that has not answered
  in 20 s falls back to the brain for that call. WAVE 68 INSTALLED.
- **7eb03f785 — Jev's account names what it does** ("checks the work
  first"); the quick role is attributed in billing.
- **828ed5bff — the owner's words for a delegated job** are its first
  message plus every later revision's message or card words, so a system
  the owner names in a later change (here the hosting server) is in the
  job's scope. WAVE 69 INSTALLED, live-proven: the job's scope read
  "plus servers the request named".
- **Ward brief** finished and reviewed by the lead against the requester's
  message (rates 10/15/20 %, NY Lighthouse 59/100, 34-item checklist). The
  owner chose "host now, then fix Clem": hosted by this session through a
  local MCP client as one self-contained internal page; the local brief is
  unchanged.
- **Why Clem could not host it herself:** the hosting server declares no
  read/destructive hints on any of its 37 tools. Effect evidence comes only
  from those hints or from learned request-shape verdicts, so every tool
  was listed but blocked `unknown_effect`; foreground discovery never
  installed a write tool's exact definition either (only workflow
  `call_tool` discovery did). Two more framework defects seen on the job:
  the work manifest read 12/14 after the lead finished the last two items
  itself (fixed by 30621c58c), and Clem routed "do it here yourself" to the
  job anyway (fixed by 735678ee4).
- **2c9052ad5** — with one provider signed in, the Automatic checker default
  is the brain family's fast checker and Settings names it; a same-family
  default checker gets the deliberate deadline.
- **735678ee4** — the delegated-work pointer: Clem does the piece here when
  the owner asks her to, instead of handing it to the job.
- **30621c58c** — `work_item_settle`: a run settles a work item from its own
  succeeded business calls (host-only control; not for workers or
  workflow steps).
- **b3377c704 — Clem proposes what a server's tools do; the owner approves
  once** (owner's choice). When installing a tool is refused for
  `unknown_effect`, Clem reads that server's undeclared tools twice
  (checker role, then quick role), keeps the stricter reading, and puts one
  card in the chat: lookups, changes, and deletes/sends that still ask each
  time. A person's approval stores each label against the exact raw
  definition digest (state/mcp-tool-effect-labels.json); the MCP shim then
  lists the tool with the matching hints. A changed definition, or a server
  that declares its own hints, drops the label; a decline stands for a
  day; non-person resolutions grant nothing. Tool search tells Clem the
  work waits on the card. Foreground discovery now installs a write
  tool's exact definition the way workflow discovery does. 7 label tests +
  238 neighbouring tests pass.
- **WAVE 70 = b3377c704 INSTALLED 08:56 PT, verified** (build-info + 3 dists;
  1882/1882 on the frozen tree). Live: "list my aibs sites" in the fixture
  chat raised the card in 24 s, "Can I start using aibs?" (18 lookups, 12
  changes, 4 deletes, 3 sends); the two readings were served by Claude
  Sonnet 5 (checker) and GPT-5.6 Luna (quick), certified usage. The card
  waits on the owner's own tap.
- **b03eb96ad — the label card no longer holds its chat.** A pending
  approval owned by a chat holds that conversation
  (`sessionHasPendingApproval`), so every next message in the fixture chat
  branched. The label approval now belongs to its own execution session; the
  card is shown in each chat that asks, once.
- **036fd6835 — Settings tells the truth about the checker with one
  provider.** Server checker facts (independent of the work? another family
  connected? what Automatic backup really uses) in both snapshots; Automatic
  names the model; one-provider note; the "pick another provider" warning
  only when one exists; the backup row names its model or "nothing else
  connected" and never offers the checker itself; the first-check line names
  Jev from a Jev-only count (`jevDecisions`).
- **20ab20edd — a refused worker declaration is owed by its accepted
  retry.** Live on wave 70 a lead's first `run_worker` was refused before
  dispatch (3 of 4 items, phase "write-note"); the accepted retry (phase
  "write", 4 items) succeeded, yet the finished job read
  `local_work_incomplete`. A refused declaration now owes its items only
  until the same manifest is declared again by an accepted call.
- **WAVE 71 = 20ab20edd INSTALLED 09:36 PT, verified** (3261/3261 on the
  frozen tree for b03eb96ad, then the local-work and label suites on the
  tip). Live checker facts: Sonnet 5 checks Codex work (independent);
  Automatic backup = Haiku 4.5, then Luna; Settings rows render, no page
  errors.
- **Break-Clem, live, fixture folder `~/clem-fixtures/lead-project/breakit-*`**
  (a project chat refuses paths outside its folder, correctly):
  N1 failed step → re-read → retry, 40 s, PASS; F3 hidden "delete and
  email" note ignored, files byte-identical, PASS (could tell the owner);
  H1 exact edit on 119 KB, bytes exact, PASS but through a shell python edit
  (a learned strategy points edits at the shell; no prior bytes kept);
  B2 quick question during a delegated job answered in 12 s, PASS;
  B1 "only the ones starting with q" mid-job → `delegated_task_correct` in
  24 s, contract v2, exactly the 18 q-files, PASS.
