# PR-07 — One-tap Continue, the progress rail, and the work manifest made visible

Size S · risk additive · depends on nothing · can start today

## Why

Three things the engine already knows, which the surfaces stop short of:

1. **Continue has no button.** A paused turn shows the pill "Paused — say
   "continue" to pick up" on desktop (`apps/console-web/src/components/chat/ChatBubble.tsx:832`)
   and phone (`apps/mobile-web/src/screens/Chat.tsx:1115`). The board's
   `LiveTraceDrawer` already has a Continue button; chat does not. v3.18.30 made
   "continue" mean continue on every brain; the owner still has to type it.
2. **The progress rail exists and is mounted nowhere.** `ProgressRail`
   (think → work → write → check, `TurnPhaseId` in `turn-progress.ts:23`) is built
   in both shells (`apps/console-web/src/components/chat/ProgressRail.tsx`,
   `apps/mobile-web/src/components/ProgressRail.tsx`) and not rendered by either.
3. **Long tasks say "Thinking…".** The work-manifest fold in
   `packages/chat-engine/src/reduce-activity.ts:389-404` is written and inert
   because `work_manifest_declared`, `work_item_checkpoint` and
   `requirement_state` are never projected (`reduce-lifecycle.ts:64-70` names them
   first in `AWAITING_PROJECTION`, with `expected_work_progress` as the template).

## Change

1. **Continue is a tap.** Where the pill renders, add the primary action
   "Continue" and the secondary "Not now". The tap sends the literal reply
   `continue` through the exact path a typed reply takes (console `useChat`'s send;
   phone `ChatEngine.send`), with the same `clientRequestId` discipline, so the
   reply router (`task-continuity-runtime.ts`) treats it as the owner's words. No
   new endpoint, no new verb. The pill stays for a turn that is `needs_input` for
   any other reason.
2. **Mount the rail.** Render `ProgressRail` inside `WorkLine` (desktop) and the
   phone's live card, fed by the existing `TurnPhaseId` reducer; hide it on turns
   that finish inside 2 s (no flash). The rail is informational; it carries no
   actions.
3. **Project the manifest trio.** Add `work_manifest_declared`,
   `work_item_checkpoint`, `requirement_state` to `projectData()`
   (`public-presentation.ts:1058`) following the `expected_work_progress` case:
   bounded item counts, whitelisted enums for item state, labels truncated, no
   arguments or results. The existing fold then shows "Work mapped out: 5 items ·
   2 settled" under the live line, on both surfaces, instead of "Thinking…".
4. **Parity test.** One fixture event stream renders the same rail phases and
   manifest line through the console reducer and the phone `ChatEngine`.

## Files

- `apps/console-web/src/components/chat/ChatBubble.tsx`, `WorkLine.tsx`, `lib/useChat.ts`
- `apps/mobile-web/src/screens/Chat.tsx`, `components/ProgressRail.tsx`
- `src/runtime/harness/public-presentation.ts`
- `packages/chat-engine/src/reduce-lifecycle.ts` (move the trio out of `AWAITING_PROJECTION`),
  `work-manifest-activity.test.ts` (flip from inert to live), `event-coverage.test.ts`

## Tests

- Continue: the tap produces exactly the request a typed "continue" produces
  (fixture compares payloads); a second tap while the first is in flight is a
  no-op; the pill without a Continue action still renders for other `needs_input`
  kinds.
- Rail: phases advance on fixture events; hidden on a sub-2 s turn.
- Manifest: the three events pass the coverage test; the fold's existing test
  (`work-manifest-activity.test.ts`) turns from "inert" to "renders"; payload
  bounds hold (an item list of 500 is truncated with a count).
- Release-closure gate (`npm run test:release-closure`) green.

## Done when

On the installed app, a turn that pauses with `kind: continue` resumes from one
tap on desktop and phone; a long fixture task shows the rail and the manifest line
within the turn; a short answer shows neither.

## Do not

- Do not add a new chat verb or endpoint for Continue; it is the owner's words.
- Do not put actions on the rail.
- Do not project results, arguments or file paths in the manifest events.
