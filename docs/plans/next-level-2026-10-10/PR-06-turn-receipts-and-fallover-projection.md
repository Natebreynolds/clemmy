# PR-06 — Turn receipts and the model events the owner never sees

Size S · risk additive (projection + presentation) · depends on PR-01

## Why

The owner's rule is "render the ledger". For models the ledger is rich and the
rendering is blank:

- A finished turn folds to one receipt line, "Worked 18s · read calendar view ·
  created draft" (`packages/chat-engine/src/live-work.ts`, v3.18.35). Who did the
  work, how many calls it took, how much was cached and which model checked it
  are all in `state/token-usage` with a trace to the accepted source
  (`UsageEvent.trace`, `usage-log.ts`), and nowhere on screen.
- `brain_fallover` is one of 33 owner-meaningful events listed in
  `AWAITING_PROJECTION` (`packages/chat-engine/src/reduce-lifecycle.ts:64-105`) that
  the daemon never publishes. When the brain falls over to another model
  (`router-model.ts:414` chain), the owner's only trace is a later "Reconnect X"
  notification, if the cause was a dead login.
- Cost appears only under Advanced › Usage, in account percent meters, and as
  per-step dollars on the workflow run board.

A model harness the owner can trust tells them, per turn, which models did what.

## Change

### 1. A per-turn usage line, from the ledger

- `src/runtime/harness/accepted-source-usage.ts` already totals usage per accepted
  source. Add `turnUsageReceipt(sourceId)` returning
  `{ calls: {brain, worker, reviewer, router, memory, writer, quick}, models: {role → label}, uncachedInputTokens, cachedReadTokens, cacheHitRate, wallMs, certified }`,
  computed from certified rows only (uncertified ⇒ `certified:false` and the UI
  says "about").
- Emit it as a `turn_usage_receipt` event at terminal delivery (after the
  completion review has settled, so the reviewer's calls are included), through
  `public-presentation.ts` with bounded numeric fields and role→label strings
  (labels, never ids or accounts).
- `live-work.ts` `workReceiptLine` gains an optional second segment:
  `Worked 18s · read calendar view · created draft · 4 calls · 41K tokens, 81% cached · checked by Haiku`.
  Desktop `TurnReceipt.tsx` and the phone's receipt line read the same presenter.
  "Full trace" (already in `WorkLine.tsx`) opens the per-role table.

### 2. Model events the owner can see

Project a first slice of `AWAITING_PROJECTION` through `projectData()`
(`src/runtime/harness/public-presentation.ts:1058`), each bounded and
enum-whitelisted, with the fold already written in `reduce-lifecycle.ts`:

| Event | Owner line (Clem's words, from the presenter) |
|---|---|
| `brain_fallover` | "Claude was rate-limited, so I switched to Codex for this turn." (reason enum: `rate_limited | auth_expired | overloaded | timeout | refused`; from/to as labels) |
| `completion_review_skipped` | "Not checked: this was a read." / "…the checker was unavailable." (reason enum) |
| `judge_fallback_used` | "Checked by Luna; Haiku was unavailable." |
| `route_policy_pick` (PR-05) | "Helpers ran on Kimi K3, Clem's pick." |

Each appears as one muted activity row inside the turn (the same place "Checked
against your goal" lives, `reduce-lifecycle.ts:74`), never as a bubble, and is
also a line in the Full trace.

### 3. A weekly line on Home

A heartbeat (the PR-02 registry) writes one From Clem update each Monday morning,
local time, from the PR-01 30-day scorecard: "Last week: 212 turns on Claude, 81%
cached, 14 checks by DeepSeek, one fallover to Codex. One suggestion for you." with
the PR-03 suggestion attached when one is open. Quiet on a blank home.

## Files

- `src/runtime/harness/accepted-source-usage.ts` (+ test)
- `src/runtime/harness/host-turn-runner.ts` (emit at terminal), `public-presentation.ts`
- `packages/chat-engine/src/live-work.ts`, `reduce-lifecycle.ts`, `reduce-activity.ts` (+ tests)
- `apps/console-web/src/components/chat/TurnReceipt.tsx`, `WorkLine.tsx`;
  `apps/mobile-web/src/screens/Chat.tsx` receipt line
- `src/agents/heartbeats.ts`, `src/dashboard/from-clem.ts`

## Tests

- Receipt math on fixture ledgers (certified/uncertified mix; a turn with a
  reviewer call after delivery is included; a turn with no reviewer shows no
  "checked by").
- Projection coverage: `event-coverage.test.ts` and the `AWAITING_PROJECTION` test
  flip the four events from awaiting to projected; payload bounds (enum reasons,
  label length).
- `live-work.test.ts` pins the receipt wording with and without the usage segment.
- Phone/desktop parity on the receipt line and the fallover row.
- Blank home: the weekly line is not written when nothing ran.

## Done when

A turn on the installed app ends with the usage segment on both surfaces, the
numbers match `npm run measure:turns` for that source (certified uncached input,
cached share), and a forced helper fallover in a fixture shows the fallover line
inside the turn.

## Do not

- Do not estimate dollars.
- Do not show account names or raw model ids in the line; labels only, ids under Details.
- Do not project the other 29 awaiting events here; PR-07 takes the work-manifest trio.
