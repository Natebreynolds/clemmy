# Workflow authoring, human-in-the-loop, Spaces, latency — 2026-09-22

Continues `2026-09-22-calendar-watch.md`. Ten commits on shared `main`,
`4276ea62` (first candidate) → the Space view fix, accepted step by step in
the installed app against the live home. No release was published. Model
roles during the tests: brain grok-4.6, judge grok-4.3, worker moved to
glm-5.3 for the window and restored to claude-haiku-4-5 afterwards.

## What the owner asked for, and what was measured

**1. Workflow authoring end to end, live.** The same request ("Create a
workflow named 'Invite digest'…: read my Outlook calendar for the next 24
hours, draft a digest of invites awaiting my reply, ask me to review the
draft before saving, save to a file, manual only, enabled once it passes its
creation test") was driven three times through the installed app.

| Run | Build | Wall | Model rounds | Top-level calls | Prompt tokens | Terminal |
|---|---|---|---|---|---|---|
| before | `e1011bc8` | 517 s | 14 (grok-4.6) | 24: workflow_get ×10, run_status ×4, list ×3, tool_search ×4, create ×1 | 825k (428k cached) | **blocked** — Jev "named work still missing" on a created, tested, enabled workflow |
| after fixes 1–2 | `4276ea62` | 600 s+ (three attempts) | — | — | — | creation test parked on "which account?", then `live_observation_missing`; the brain thrashed with `workflow_update`/`set_enabled` |
| after fixes 1–5 | `eca325f1` | **333 s** | 5 (grok-4.6) | **8**: list, tool_search ×3, recall, get ×2, create | **281k** (105k cached) | **done** — "created, enabled… reads on nathan.reynolds@scorpion.co" |

**2. A human-in-the-loop workflow, authored and exercised.** `Invite digest`
(read calendar → draft → `save_digest` gated with `requiresApproval`) was
run from the console on `a11d7ca7`: the run read the calendar on the
author's routed account, drafted, parked at the review gate
(`apr-mjcq`, "Review the invite digest before saving it to digest.txt"), was
approved from the command-center route, wrote
`output/invite-digest/digest.txt` (four pending invites with times), and
completed with goal validation 5/5 — 21 s from resume to completion. The
run's first attempt on the older build had parked as "connect outlook".

**3. Space creation.** `Daily Brief` was created exactly as the New Space
modal does it (POST /api/console/spaces with the starter recipe's title and
objective, then the build request on session `space-daily-brief`). Result:
done, 2 live sources (calendar + inbox, 05:00 PT daily), health fresh, view
7.5 KB, the reply named the day's overlaps and a cancellation. Cost:
**1,034 s, 33 calls (tool_search ×16), 694k prompt tokens**. The rendered
board then showed "No meetings" and "Nothing needs a reply": the view's own
`rows()` helper did not know the `{complete, result}` read envelope the
sources are stored under. Fixed at the dataset boundary (see 7 below);
render verification after the last hotpatch is recorded at the end.

**4. Latency.** Calendar turn ("whats on my calendar tomorrow"), same
build family, same day:

| Build | Wall | Model time | Calls | Note |
|---|---|---|---|---|
| `e1011bc8` baseline | 82 s | 70 s | 3 (tool_search, read, query) | first frame 31 s for 79 output tokens |
| `4276ea62` | 60 s | 51 s | 3 | bound-account note alone did not stop the search |
| `eca325f1` | 100 s | 91 s | 5 (tool_search ×3) | "discovery-complete" line alone made it search for `work_call` |
| `a11d7ca7` | 361 s | **47.6 s** | 4 (tool_search ×1) | a 5-minute xAI transport stall inside one frame (`model.transport_timeout`, retried by the harness); model time is the lowest measured |

The structure of the turn is now known: ~2.6 s before the first model
call, a 4 s judge-lane call in parallel at turn start (`fusion_judge` seam,
680 tokens, off the critical path), the first frame 10–31 s of grok-4.6
reasoning at effort "none" (the wire cannot steer Grok's depth), then one
frame per tool call. The discovery frame is the lever that remains; the
work_call schema text landed last and its effect is one turn old.

## What had to be fixed underneath (all live-found, all pinned)

1. **Authoring is the outcome** (`4276ea62`). `workflow_create` is a
   control-role tool, so an authoring turn had no outcome evidence and Jev's
   INCOMPLETE was accepted against finished work. A control-role write whose
   settled result is a proven host-local authoring commit is now outcome
   evidence, and the evidence block says what the receipt proves.
2. **The tool waits for its own creation test** (`4276ea62`). Bounded and
   only inside a draining daemon; the receipt reports the settled outcome and
   the enabled state. Seven polling rounds (~90 s, ~100k tokens) are gone.
   The authoring tools get the external-work time budget.
3. **The origin routes the account** (`eca325f1`, `a11d7ca7`). A multi-account
   operation the step does not name is routed by the host's own
   source-account policy for the run's origin: the creation test's recorded
   source, the origin session, or (console/scheduled runs) the conversation
   that authored the workflow. Ambiguity that survives parks under
   `ambiguous-account` with the exact choice set, never "connect outlook".
4. **A background run refreshes its crossing-time observation** (`eca325f1`).
   The step catalog refreshes each selected manifest's independent
   observation and both crossing paths refresh a missing or stale one live;
   admission still decides.
5. **workflow_get shows the authorable shape** (`56d57fbd`+). A call step
   prints its call, args, approval flag and preview, inputs, output contract;
   no empty numbered prompt. Five example re-reads became two.
6. **Discovery on a proven turn** (`56d57fbd`, `a11d7ca7`). The planning
   instruction carries a discovery-complete line naming the proven operations
   and the bound account (recorded on the proven event), and `work_call`'s
   own schema names the proven disclosure as a source of its requirement.
7. **A Space view sees records** (last commit). The dataset handed to a view
   (live seed, bridge data route, published snapshot) carries each source's
   record list as `records`, located exactly as `clem.rows` locates it.

## Not done, stated plainly

- Space creation works end to end but costs 17 minutes and 16 discovery
  rounds; the Daily Brief's "open tasks" section has no live source yet.
- Authoring still prefers a prompt step for a connected read when the window
  is relative ("next 24 hours"); an exact `call:` step would be cheaper per
  run (the creation test's read step took 43 s on the worker).
- The turn-start judge call (`fusion_judge` seam) is unattributed to a lane
  and not on Jev; it costs 4 s of grok-4.3 per turn in parallel.
- Grok's reasoning depth cannot be steered on this wire; the first frame
  stays 10–31 s regardless of effort.
- Two `orchestration-tools.test.ts` failures pre-exist on `main` (a
  description regex and a workspace-inventory expectation) and are unrelated.
- The mobile UI was not driven; the account-choice card was rendered by the
  console feed only.
