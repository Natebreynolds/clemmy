# Streaming turn: progress rail and step timeline — September 26

Owner request (09-26 morning, with a screenshot of a 2m38s live turn): "refine the
streaming in the chat on desktop and mobile to make it just better, not just a
line-item checklist. Progress bars would be nice." An earlier mockup had been
approved but the live view still rendered a checklist of tool names.

## What changed (`claude/stream-progress`, commit `2b957009a`)

A turn has no known step count, so a percent bar over steps would be a guess. What
every turn does pass through is four phases the client can see start and end from
events it already holds. The chat now shows:

- **A progress rail** while live: Thinking → Working → Writing → Checking. Done
  segments fill, the current one sweeps, a declared count (batch or work manifest)
  fills the Working segment to a real fraction, a phase the turn never entered is a
  dashed gap. Only the current phase carries a caption ("6 steps · 1 running",
  "3 of 10", "correcting"); a check that found issues or passed says so.
- **A step timeline**: each step row gets a hairline under its label whose offset
  and length are its share of the turn's time, so the list reads as where the time
  went. Running steps reach the right edge. Nested helper steps show parallelism.
- **Less duplication**: the beat line under the rail shows only what no step row
  carries (the wait before the first step, the engine's own line between steps).
  The right-hand actions (Move to background, Full trace) moved off the rail row so
  all four labels fit at 1280px.
- **Honest settled count**: the desktop's narration now hides the model-wait row
  once a turn settles, as the engine already did, so "Worked 16s · 2 steps" no
  longer counts thinking as a step.

Shared model: `packages/chat-engine/src/turn-progress.ts` (`turnProgress`,
`timelineBounds`, `timelineSpan`, 11 tests). The engine reducer now records
`finishedAt` when a step settles (tool return, helper result, batch/manifest
completion, coding run), which gives the phone durations for the first time.
Desktop: `ProgressRail.tsx`, `WorkLine.tsx`, `ActivityCard.tsx` (`StepRow` takes an
optional `timeline`; Space and background cards unchanged). Phone:
`components/ProgressRail.tsx`, `screens/Chat.tsx`, `styles.css`.

## Evidence

- Live desktop preview against the running daemon (working-tree dist via route
  interception, one controlled fixture each): light, "What is on my calendar
  today?" — rail Thinking → Working · 1 step → Checking → settled at 75s; dark,
  "Find the three most recent files in my workspace" — Working · 5 steps with
  two failed tool rows drawn in the danger colour, settled at 130s. Screenshots in
  session 9736c85b scratchpad `shots/` and `shots-dark/`.
- Gates on the merged tree (`88e44e856` = installed `4117d82c9` + this work): root
  tsc, console-web tsc + vite build, mobile-web tsc + vite build all clean; engine
  184/184; chat + lib tests 598/599. The one failure, ChatBubble.test "a confirmed
  change in another app shows while the turn is still live", fails identically on
  the unchanged base `def826f03`.

## Not done / owed

- **Not installed.** The UI-only dist swap (`swap-web-dists.command` in the session
  scratchpad: moves both installed `apps/*/dist` aside as `dist.backup-<ts>`, copies
  the built dists in, verifies digests, no daemon change, no app quit) was blocked
  by the session's permission mode. Installed app still serves `4117d82c9`.
- **Phone live acceptance** owed: the phone rail and step bars are typechecked and
  built but were not captured live (needs the QR pair-code recipe).
- The pre-existing ChatBubble test failure above is not addressed here.
- Peers `clementine-next-ad` (installed 4117d82c9 at 09:18 PT) and
  `clementine-next-f8` (daemon-only hotpatch planned) were told the swap did not run
  and were given the merged sha.
