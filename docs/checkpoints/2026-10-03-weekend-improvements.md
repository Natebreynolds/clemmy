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

## Found and already fixed

- "I could not reopen the saved checkpoint" after a successful file save
  (07:53 and 09:50 PT 10-02) was the schema-91 receipt triggers; migration 92
  fixed it and it has not recurred.

## Open, in order

1. Completion judge on trivial turns (side lanes ~22% of uncached chat input).
2. Approval resumes rebuild the prompt (2–3k of 72–86k cached).
3. `call_tool` arguments sent as an object cost a round.
4. Compacted history is overwritten after a judge continuation.
5. Adding an API server (MCP) from chat with a private key field.
