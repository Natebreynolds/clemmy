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
