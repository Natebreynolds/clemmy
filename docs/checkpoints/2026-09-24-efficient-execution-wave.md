# 2026-09-24 — Efficient agent execution: WP1–WP5 status (installed-app evidence)

Worktree `clementine-next-harness-3-19`. Every claim below was measured on the
installed app after a hotpatch of the named commit (`/api/console/build-info`
gitSha), never on isolated tests alone. Isolated pins are listed as the sanity
gate that ran before each patch.

## Completed fixes (this wave)

| Commit | What | Live proof |
|---|---|---|
| `c830e3d7c` | Same-source settled-read replay extended from Composio reads to declared local reads (`readReuse: 'settled_within_source'` on `space_get`, `read_file`, `list_files`, `workflow_get`, `memory_recall_all`, `memory_search`). Status polls stay undeclared. Reuse keeps the existing marker, `providerDispatched:false` row and learning exclusion. | Hotpatched; heavy-session re-run 294084 issued both reads once in frame 1 (no repeat occurred to reuse). Fixture: identical read → 1 execution + replay row; write between → 2; undeclared status read → 2. |
| `2bd69510c` | Freshness gap closed (reviewer point 1): each reusable read declares a `readRevision` source (one local path; Space dir + canonical-entity store incl. `-wal`; saved workflows; memory db incl. `-wal`). Hooks record `resourceRevision` on the read's lifecycle row; replay refused unless the same probe matches now. Reads without a revision source (`skill_read`, `workspace_roots`) withdrew reuse. | Pins: file edit, sibling noise, dir entry, Space dataset write, projection through WAL, memory write, traversal, undeclared poll; host-runner pin gained an outside-edit variant (2 executions). Hotpatched as part of `4c212ec06`. |
| `4c212ec06` + `4940f5711` + `934d2557e` | WP1: proven strategies naming native MCP / reviewed CLI reads are re-acquired through the same acquisition discovery uses (live tools/list, attestation, exact materialization, request MCP scope) and recorded as the source's proven resolution before frame 1; outcomes per operation recorded on `proven_operation_selected.liveReadOutcomes`. Root cause of the first two live failures: `dataforseo__docs_search` passed the Composio slug shape test because `dataforseo` is also a connected toolkit. | Turn A (294189, fresh): learned `["dataforseo__docs_search"]`. Turn B (294238, before fix): strategy selected, `liveReads: []`, tool_search still paid. Turn B2 (294294, instrumented): `liveReadOutcomes: []` → id never reached the live-read branch → classifier fix. Turn C (294347, fixed): warmed in 1.6 s, no tool_search, brain frames 4→2, total prompt 86k→55k. |
| `484dfde36` | WP3 pin: forced Layer 1 + Layer 2 over a session with an approved-plan decision, 14 older reads, a settled mutating write with retained receipt, a later user correction and a pending approval: all user messages verbatim and ordered, pending approval in the tail, write visible (verbatim or in the already-done ledger), history shrinks, reopen byte-identical, second commit of the settled write refused. | Isolated pin only; installed-app scenario still owed (see gates). |

## Live measurements (installed app, `scripts/measure-source-turn.mjs`)

Same status question ("what does the acceptance Space hold / did its pilot run"), read-only:

| Run | Build | Wall s | Brain frames | Reviewer / router calls | Total prompt tok | Largest prompt | Uncached tok | Tool calls | Correct |
|---|---|---|---|---|---|---|---|---|---|
| heavy session, before Layer 0 (earlier checkpoint) | d8362bf6 | 282 | 5 | — | — | — | 295,037 | — | no |
| heavy session, after Layer 0 (earlier checkpoint) | af92f465 | 42 | 3 | — | 91k | — | 49k (brain) | — | yes |
| heavy session 294084 | c830e3d7c | 28 | 2 | 2 / 1 | 121,121 | 51,189 | 80,481 (brain 60,553) | 2 | yes |
| fresh session 294134 (cold) | c830e3d7c | 40 | 4 | 3 / 2 | 92,431 | 15,798 | 78,479 (brain 45,153) | 4 | yes |

DataForSEO docs question (native MCP read), read-only:

| Run | Build | Wall s | Brain frames | Reviewer / router | Total prompt | Uncached | Tool calls | Repairs | Warm path |
|---|---|---|---|---|---|---|---|---|---|
| A 294189 fresh (learning run) | 4c212ec06 | 35 | 4 | 2 / 4 | 86,885 | 72,997 | tool_search + docs_search | 0 | n/a (learned) |
| B 294238 fresh | 4c212ec06 | 69 | 3 | 2 / 2 | 96,374 | 73,654 | tool_search + docs_search | 0 | selected, liveReads [] |
| B2 294294 fresh | 4940f5711 | 44 | 4 | 2 / 1 | 86,456 | 72,632 | direct call refused → tool_search → docs_search | 1 refused_pre_dispatch | selected, outcomes [] (classifier) |
| C 294347 fresh | 934d2557e | 26 | 2 | 2 / 1 | 55,367 | 50,567 | docs_search only (no tool_search) | 0 | `liveReads: [dataforseo__docs_search]`, installed in 1.6 s |

Reading the two measures separately, as asked: a reused read saves a
provider/local crossing (counted from `tool_returned.providerDispatched:false`
and `same_source_settled_read_replay` markers); it does not remove the brain
frame that asked. In 294084 and 294134 the brain did not repeat a read, so
zero crossings were saved and zero frames; the fresh run spent two extra brain
frames on three differently-argued `workflow_run_status` polls (undeclared,
physical by design).

## DeepSeek V4.1 Flash brain + workers, Claude Opus 5.5 judge (owner's tag-readiness test, 09-24)

Switched on the installed app through the settings API (no restart): active brain
`api_key` → `deepseek-ai/DeepSeek-V4.1-Flash` (Together AI, learned catalog, 1M
context, $0.30/$1.20 per M, cached input $0.006); role bindings judge →
`claude-opus-5-5`, worker → `deepseek-ai/DeepSeek-V4.1-Flash`. Previous values to
restore: brain `zai-org/GLM-5.3-Flash`, judge `grok-4.3`, worker `claude-haiku-4-5`.
Usage rows confirm who served what (`role:model`).

| Run | Task | Wall s | Brain frames (DeepSeek) | Reviewer frames (Opus) | Router | Total prompt | Uncached | Outcome |
|---|---|---|---|---|---|---|---|---|
| 294384 fresh | scorpion-outbound skill: one cold email, present for approval | 30 | 4 | 3 (trajectory review + completion judge) | 3 | 159,213 | 113,901 (reviewer 55,216) | success; skill + 6 reference files read; 82-word on-brand draft; proof point flagged for verification; judge `fulfills: true` |
| 294452 fresh | same skill, three prospects, explicit worker fan-out | 43 | 5 | 3 | 2 | 107,256 | 55,416 | `awaiting_user_input`: `run_worker` refused ×3 — the pattern detector read "with 40 reviews" as a 40-item contract (`fanout_policy_decision.itemCount: 40`) and the gate rejected the 3-item declaration; DeepSeek's third packet was otherwise correct and it stopped retrying as told |
| 294528 fresh, after `f89bf014e` | same | 62 | 4 (+ 3 DeepSeek workers, 6 worker frames) | 6 (1 packet check, 4 watcher, 1 completion) | 6 | 194,220 | 141,745 (reviewer 110,385) | detector still read 40; arbitration accepted (`quantified_universe_arbitrated.accepted: true`); 3 workers started and returned; all three drafts delivered with checklist notes; **completion judge failed open**: Opus wrote a 2,827-token review with no verdict line → `unreadable verdict`, `failedOpen: true` |

Observations for the tag decision:
- DeepSeek V4.1 Flash follows a multi-file skill faithfully at ~30 s and produces
  a draft the Opus judge accepts; the judge's own reason text is specific and
  checkable. Reviewer cost is the largest uncached block (55k) on the single-email
  turn: the completion judge and the trajectory watcher each re-read the skill
  evidence.
- The fan-out failure was a harness defect of the banned class (regex over user
  text as a hard validator), not a model failure. Fix: a chat-session disagreement
  between the detected count and the declared universe is arbitrated by Jev's
  system-one; execution/background sessions stay fail-closed (`f89bf014e`,
  hotpatched and proven live on 294528).
- Second harness defect, judge side: a flagship reviewer over a large evidence
  packet wrote the review and skipped the one verdict line; the harness declared
  it unreadable and failed open. Fix staged (working tree, not yet committable, see
  below): one bounded re-ask for the verdict line from the reviewer's own words,
  no evidence resent; a persisting failure carries the head of the review in the
  recorded reason. Pins green (3) and the judge suite green under the isolated
  runner (66/66). Not yet built or hotpatched.
- Reviewer spend is now the dominant uncached block on DeepSeek turns (55k on one
  email, 110k on three): the completion judge re-reads the full evidence, and the
  trajectory watcher reviews every worker. Worth a separate look before tagging.
- Worktree state at the end of this session: three files hold merge-conflict
  markers from an accidental `git stash pop` of another agent's parked stash
  (stash@{0}, still intact): `src/agents/tool-catalog.test.ts`,
  `src/tools/publish-plan.test.ts`, `src/tools/publish-plan.ts`. Until they are
  returned to HEAD (`git checkout HEAD -- <those three>`), no commit, typecheck or
  build succeeds in this worktree. The judge repair sits staged behind that.
- Model configuration left as the owner asked for this test: brain + worker
  `deepseek-ai/DeepSeek-V4.1-Flash` (Together AI), judge `claude-opus-5-5`.
  Previous: brain `zai-org/GLM-5.3-Flash`, judge `grok-4.3`, worker
  `claude-haiku-4-5` (restore through Settings → Models or the same two PATCH
  routes: `/api/console/settings/active-brain`, `/api/console/settings/models/roles`).

## Remaining release gates (unchanged unless stated)

1. WP3 installed-app scenario: approved plan → correction → pending approval →
   restart → approve → exactly one write with truthful completion (isolated pin
   landed; live run not yet done).
2. WP4 matched cold/warm/long-conversation set, ≥3 runs per case, with first
   useful content time; only single runs exist above.
3. WP5 plan_task: host-side activation of a user-selected reviewed revision
   (remove the `{}` model round) — not started this wave; staged retirement plan
   in the 09-24 takeover checkpoint §7.
4. 20 pre-existing host-runner test failures remain unattributed (count
   unchanged before/after every change here: 20/310).
5. Full idle-machine suite not re-run this wave.
6. Owner decisions still open: publish reviewed projection over a failed judge;
   recurrence approval for the proven pilot.
7. Live proof of an actual reused local read is still owed: no natural repeat
   occurred in the re-runs; the mechanism is proven by pins and by the Composio
   rail it extends.

## Incident 2026-09-24 09:00 PT — team-activity-slack-updates posted nothing

Run `trigger-6e84aad2089a7ef1fba8bbd1b222890b`: `pull_activity` (deterministic
script) completed; `post_slack` had `SLACK_SEND_MESSAGE` refused pre-dispatch
twice with `workflow_write_constraints_unverified`, then closed blocked. No
message reached C0BHT7WHZDL; nothing was retried. The write-constraint
reviewer was `claude-opus-5-5` (the owner-selected judge binding set for the
DeepSeek/Opus test at 05:20 UTC) and answered `uncertain` twice: it could not
verify byte-for-byte that `markdown_text` equals the deterministic summary,
because that summary reaches the step as prompt context, not as retained
evidence the reviewer can open. Yesterday's 16:00 PT occurrence passed the same
review under `grok-4.3` in one 4k-token call. Judge binding restored to
`grok-4.3` at ~09:45 PT; brain and worker remain DeepSeek V4.1 Flash for the
test. Framework gaps left for the owner of workflow evidence: (1) deterministic
step outputs are not retained as reviewer-openable evidence; (2)
`refused_pre_dispatch.refusalDetail` is clipped to ~150 characters in the event
record, so the reviewer's actual reason is lost. Next natural check: the 16:00
PT occurrence today.

## WP5 stage 1 finding (branch wip/plan-host-activation, not on the candidate)

A host-side activation of the user-selected reviewed draft cannot be a helper
called before the turn: `settledPlanTaskActivationWinner` grants transition
authority only to a settled `plan_task` logical call whose redeemed result says
ok:true with its receipt, and the logical-call admission itself requires the
accepted source's persisted turn graph, which for a host-owned turn is created
inside the host call pipeline. The correct shape is a host-emitted frame-0
canonical `plan_task {}` call through the same pipeline (admission, graph,
settlement, receipt) with no model request, then the surface without
`plan_task`. The WIP branch holds the helper, the loop hook, the instruction
change and the pin updates; the integration pins fail on the graph precondition
and were not weakened. Stage 1 stays owed.

## Main is the release base (2026-09-24 ~09:30 PT)

The Codex agent's last commit was a5a9e94ce at 08:41 PT with no activity after
it. `main` was fast-forwarded from e77215d00 to 49fb69653 (its 110 commits plus
this branch's three); the owner's uncommitted main edits were untouched. On
49fb69653: typecheck clean, public-hygiene and operation-identity gates pass,
the three files that regressed at bb13116fc pass 96/96. Built from main and
hotpatched; the installed app serves 49fb69653 (fp b4ed75d1f3e8).

Live proof of the Jev-first watcher, same three-prospect fan-out (298364):

| | before (294528, Opus judge) | after (298364, main, grok judge) |
|---|---|---|
| wall | 62 s | 94 s (6 DeepSeek brain frames vs 4) |
| flagship watcher calls | 5 | 0 on the parent, 1 of 5 worker windows escalated |
| trajectory windows decided by Jev | 0 | 6 of 7, confidence 0.99 |
| reviewer uncached tokens | 110,385 | 53,584 (completion judge 52,695 + one 889 packet check) |
| total uncached | 141,745 | 97,212 |
| completion verdict | unreadable → failed open | positive, specific, not failed open |

Started from main after the proof: full isolated suite then journeys
(`gates-main.sh`, logs in the session scratchpad). Still owed before a tag:
their results, fresh-install smoke, packaged-candidate smoke, upgrade
rehearsal, release-asset tests, `origin/main` equal to the release commit,
and the owner's Windows scope decision (`[mac-only]` or hold).

## Gate results on the release commit (2026-09-24 10:37 PT)

All local gates from `docs/NEXT-TAG-RELEASE-GATE.md` ran on `main`; the full table
is in `docs/releases/v3.18.20.md`. Summary: suite 17,072 with every failure either
passing alone or failing identically at v3.18.19; journeys 37 with three
pre-existing failures and no regression (down from 51 failures on the last full
journey gate); release closure 138/138; release assets, fresh-install smoke,
packaged candidate, v3.14 upgrade rehearsal and packaged upgrade (clean worktree,
own build, 21/21) all pass. Not done in this session: pushing `main`, cutting the
tag, and the 16:00 PT Slack occurrence check. Owner decisions pending: push, and
Mac-only versus hold for Windows.

## Release (2026-09-24, tagged 12:37 PT, published 13:28 PT)

v3.18.20 is tagged on `09fc7139a` (Mac-only) and published as the latest
release with signed and notarized arm64 and x64 builds. After the 10:37 PT
pass the release took three more commits: the organic-traffic refinements, the
learned effect for verb-less operations (the monday.com first-read refusal),
and the release commit. The published update's build stamp names `09fc7139a`,
a clean tree, and source fingerprint `6bb7af7a…`, the same fingerprint the
owner's app served for the canaries below. The full gate table is in
`docs/releases/v3.18.20.md`.

**Correction to the 10:37 PT summary.** "Journeys 37 with three pre-existing
failures" misread the log: 37 is the number of journey files, and that run
(`49fb69653`) failed 34 of 169 journey tests across 9 files. The tag fails the
same set minus the partition-ledger timeout. Against a full v3.18.19 run (174 tests, 43 fail in 10 files), no journey file
newly fails and two now pass, but six of the eight fail at a different point.
Traced: the restaurant-sheet journeys fail their first step since `45254ff2b`
(09-23, the work carrier stays visible on an empty catalog, an intentional
change the journey never absorbed). With that one expectation relaxed they
fail step two, because `a5fcba79f` (09-24 catalog ranking) fills the first
discovery page with built-in search tools and drops the Sheet operation.
Untraced: capability-lifecycle row 6, the local-LLM Workspace ask ("plan_task
retires after exact activation"), provider-neutral local plans (3 failing
subtests at v3.18.19, 6 here), and the 100-worker gate. When the runner's
result stream breaks, `--experimental-test-isolation=none` through the
isolated runner shows the real assertion.

**Canaries on the tag, installed fingerprint-exact:** read-only check 8 s; a
repeated standing rule recognized as already saved in 4 s with no tool call;
the organic-traffic ask in 54 s through five direct calls to the raw API
operation; the owner's monday.com first ask, refused before the fix, answered in
42 s, with both verb-less board operations learned as reads during the ask
(confidence 0.97 and 0.93). The owner-selected reviewer judged both provider
answers fulfilled.

**After the tag:** a comment-only commit on `main` clears the provider-literal
gate that the tag's CI run tripped. The marketing-site security merge also
landed on `main`; it does not ship in the desktop app.

**Owed:**
- Feed unannotated MCP operation definitions to the learned-effect mechanism;
  today only Composio operations learn their effect.
- Publish a cold toolkit's operation proof past the discovery deadline, so a
  freshly connected app's first ask does not pay the proof twice.
- Host activation of a selected reviewed plan (parked on
  `wip/plan-host-activation`).
- Retain a deterministic workflow step's output as evidence the write reviewer
  can open, and stop clipping the refusal detail.
- Fix the compound-request ranking regression from `a5fcba79f`, bring the
  restaurant journeys up to the 09-23 carrier change, and trace the four other
  journey differences.
- The packaged-candidate smoke needs `build:mobile-web` and `build:console-web`
  in the clean worktree before it runs.
- CI Test on main: four read-path files (capability routing, learned read loop,
  learning closeout, verified memory closeout) pass every test and then never
  exit on the Linux runner, so the file times out at 600 s; the CLI-setup
  repair test assumes the Salesforce CLI is installed. Both pass on the owner's
  machine.
