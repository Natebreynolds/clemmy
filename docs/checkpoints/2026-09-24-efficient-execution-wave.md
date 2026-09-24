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
| `4c212ec06` + `4940f5711` + `<classifier fix>` | WP1: proven strategies naming native MCP / reviewed CLI reads are re-acquired through the same acquisition discovery uses (live tools/list, attestation, exact materialization, request MCP scope) and recorded as the source's proven resolution before frame 1; outcomes per operation recorded on `proven_operation_selected.liveReadOutcomes`. Root cause of the first two live failures: `dataforseo__docs_search` passed the Composio slug shape test because `dataforseo` is also a connected toolkit. | Turn A (294189, fresh): learned `["dataforseo__docs_search"]`. Turn B (294238, before fix): strategy selected, `liveReads: []`, tool_search still paid. Turn B2 (294294, instrumented): `liveReadOutcomes: []` → id never reached the live-read branch → classifier fix. Turn C: see "Live results" below. |
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
| C | classifier fix | (pending) | | | | | | | |

Reading the two measures separately, as asked: a reused read saves a
provider/local crossing (counted from `tool_returned.providerDispatched:false`
and `same_source_settled_read_replay` markers); it does not remove the brain
frame that asked. In 294084 and 294134 the brain did not repeat a read, so
zero crossings were saved and zero frames; the fresh run spent two extra brain
frames on three differently-argued `workflow_run_status` polls (undeclared,
physical by design).

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
