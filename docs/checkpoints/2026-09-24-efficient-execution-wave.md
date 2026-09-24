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
