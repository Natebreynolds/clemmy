# CI baseline on main `b0612dd` (v3.18.35), case by case

2026-10-10 · written for PR-00 of `docs/plans/next-level-2026-10-10/` · final

## 0. How this list was made

CI's last complete unit run was run 725 on `cb5814cd` (v3.18.34, 2026-10-09):
21,284 tests, 21,209 passed, **22 failed**, 53 skipped, 61 minutes. Every push
since fails at the public-hygiene step (fixed by PR-00's one-line change), and
the signed log URL cannot be downloaded from this container, so the list was
rebuilt:

1. the full suite (`scripts/run-tests-isolated.mjs --test-concurrency 3`) on
   `b0612dd` in a clean 4-core Linux container with root, desktop, console and
   phone dependencies: **21,465 tests, 21,375 passed, 31 failed, 59 skipped,
   58 minutes**;
2. every failing file run alone, on `b0612dd` and again in a worktree at
   `cb5814cd` (v3.18.34), to separate pre-existing from new and load-dependent
   from real;
3. one bisect (§2b).

Result: 22 of the 31 fail identically at v3.18.34 and match CI's count; 9 are
this container's (§2). No failure is new since v3.18.34.

## 1. The 22, classified

| # | File · case | Expected / actual | Class | Owner |
|---|---|---|---|---|
| 1 | `src/runtime/harness/model-roles.test.ts` · all_in declared gpt-shaped BYO binding and inactive reporting stay on the BYO provider | inactive binding `provider: 'byo'` / `'codex'`; reason regex pinned to an older sentence | real (reporting) + stale regex | PR-14 |
| 2 | `src/runtime/harness/model-role-options.test.ts` · an explicitly selected fallback keeps connected subscription and API routes separate from an all-in brain | no `codex` group in ordinary all-in options / present | real | PR-14 |
| 3 | same · all_in is provider-isolated and gpt-shaped BYO ids remain BYO in role/UI reporting | ambiguous id not offered / offered | real | PR-14 |
| 4 | `src/memory/memory-model-route.test.ts` · the fast-tier jobs name the model the router actually serves them, and the meter tags that account | `byo-memory-model` / `gpt-5.6-luna` | real (attribution) | PR-14 |
| 5 | `src/runtime/harness/respond-bridge-one-gate-wiring.test.ts` · completed-work recovery candidate … a genuine no-work candidate stays blocked | no "ask me / continue / retry / resume" on an ownerless terminal / "…Ask me to check what completed…" | real (voice rule) | PR-15 |
| 6 | same · ownerless narration give-up closes factually without asking for a continuation | same | real (voice rule) | PR-15 |
| 7 | `src/runtime/graph/turn-graph-semantics.test.ts` · a participated failed admission stays graphless and commits a blocked zero-tool terminal | no instruction on a blocked zero-tool terminal / "…Ask me to check the capability details…" (`public-presentation.ts:172,294-298`) | real (voice rule) | PR-15 |
| 8 | `src/runtime/harness/loop-structured-output-guard.test.ts` · guard: parse error with no recoverable text → safe fallback string | `/couldn't be structured/` / "Clementine couldn't prepare a usable reply…" | stale pin (legacy sentence) | PR-15 |
| 9 | same · guard: parse recovery does not reuse stale assistant text from prior turns | same | stale pin | PR-15 |
| 10 | `src/runtime/harness/claude-agent-brain.test.ts` · Claude brain closes a prepared workflow batch as a nonterminal dispatch before judge or narration | "Started —" / "Queued — waiting for the workflow to start…" | stale pin (wording changed 10-07) | PR-15 |
| 11 | same · Claude brain preserves a prepared workflow handoff when the provider throws after workflow_run | same | stale pin | PR-15 |
| 12 | same · SDK brain keeps a still-pending automatic memory capture non-done: original exact wording | `unverified` + `blocked`, no "Saved —" claim / `success` with the claim | real (legacy SDK lane) | PR-15 |
| 13 | same · … receipt eligible wording | same | real (legacy SDK lane) | PR-15 |
| 14 | same · SDK brain durably captures an exact pre-recorded source once and isolates compound-decline memory authority | — / "accepted-task authority admission conflict" | real (legacy SDK lane) | PR-15 |
| 15 | `src/channels/discord-harness-terminal.test.ts` · provider replied means dispatch ACK delivered while the exact logical edge remains pending | "Started —" / "Queued —" | stale pin | PR-15 |
| 16 | `src/channels/discord-harness.test.ts` · async dispatch releases only its exact placeholder with a compact deterministic ACK | "Started —" / "Queued —" | stale pin | PR-15 |
| 17 | `src/runtime/harness/browser-no-change-settlement.test.ts` · a browser open that proved nothing changed settles repairable, never uncertain | `invalid_arguments` + `host_reported:browser_not_dispatched` / `uncertain_write` | real (settlement) | PR-17 |
| 18 | same · with a cloud browser set up, the real local browser_open refuses without starting and settles repairable | same | real (settlement) | PR-17 |
| 19 | `src/runtime/harness/provider-neutral-kernel.test.ts` · shared execution kernel contains no customer-shaped or provider-branded policy | `host-turn-runner.ts` names Composio (`:3`, `:6340`) and Slack (`:7446`) | real (owner rule, ratchet) | PR-18 |
| 20 | `src/runtime/harness/reconcile-only-irreversible-effects.test.ts` · settlementRequiresReconciliation is gated on the irreversible boundary | two-clause regex / v3.18.32's intended third clause `!providerAnsweredWithRefusal(...)` (`host-turn-runner.ts:7447-7450`) | stale pin | PR-00 |
| 21 | `src/daemon/cutover-hold-structure.test.ts` · held parent and migration child have exact minimal runtime import closures | closure gained `ascii-json`, `credential-private-filesystem`, `sync-directory`, `windows-private-filesystem` via `src/config.ts:8` | structural drift (Windows beta) | PR-00 |
| 22 | `src/agents/orchestrator.test.ts` · near-action and affirmative follow-up without the host plain proof retain semantic scope and fanout | batch-shape mandate `THIS TURN IS BATCH-SHAPED: … ~18` in the instructions / absent | regression, bisected (§2b) | owner decision |

The 10-07 checkpoint also named `autonomous-send-consent-crash-matrix.red.test.ts`;
that file no longer exists on main (fixed in 3.18.30, removed since).

## 2. The 9 that are this container's, not CI's

| File · case | Why here |
|---|---|
| `src/runtime/read-path/capability-routing-production.test.ts` ×4, `learned-read-loop.test.ts` ×1, `learning-pipeline-closeout.test.ts` ×2, `verified-memory-closeout.test.ts` ×1 | These suites set `CLEMMY_LOCAL_EMBEDDINGS=on` and assert the local semantic tier ran ("the bundled local retrieval model did not load"). The model is a ~130 MB Transformers.js/ONNX download (`src/memory/embeddings.ts:52,542-580`) and this container has no egress to Hugging Face. On the owner's Mac and on CI the model loads. One more case in the first file ("ordinary chat reaches the same seam and pays nothing for it") failed once in a solo rerun and not in the full run: it measures cost under load. |
| `src/execution/coding-run-git.test.ts` · a timed out test also stops its descendant process | failed in both full runs under full CPU load, passes alone (7 tests, 0 fail). The 10-06 Windows checkpoint records the same case failing once "without retaining its descendant PID; its cause remains unknown". Intermittent under load; a real process-group cleanup race is possible and worth a dedicated look, but it is not in CI's 22. |

Not in the unit targets at all: `scripts/dev-down-active-acceptance.test.mjs`
(release-closure gate only) fails here with exit code `null`; it is a macOS
script and that gate runs on macOS in `release-desktop.yml`.

## 2b. The orchestrator fan-out case, bisected

`git bisect` between `v3.18.26` (good) and `v3.18.30` (bad), running the single
case through the real runner at each step, names **`d222b5f3`** (2026-10-05,
"Clarification revision work exactly as installed on 10-05 (from the Codex
tree)", 68 files) as the first bad commit. Inside it, the relevant change is
`src/runtime/harness/multi-item-intent.ts` (+48): count-only prose now needs an
operation **in its own clause** (`countedClause`), ranges and bounds ("10–12
cases", "up to 20") are masked so they do not become exact item sets, and
`sameShapeWork` requires a read or deep-work verb in that clause, an enumerated
list with a write, or an anaphoric operation ("research them"). Its own new test
(`multi-item-intent.test.ts`, +63) pins that precision.

The orchestrator fixture is a near-action request whose ~18 items were
established on an earlier turn and affirmed on this one; the batch-shape
mandate (`orchestrator.ts:2453`) is built from `multiItem.isMultiItem` and
`carriedFromPrior`. Under the stricter parser the carried scope no longer reads
as multi-item, so the mandate is dropped and the follow-up turn loses its
fan-out hint. Two rules collide, both reasonable:

- the 10-05 rule: a quantity in prose is not per-item work unless the operation
  sits beside it (prevents "10–12 cases" from spawning twelve jobs);
- the older rule the test states: an affirmative follow-up keeps the semantic
  scope and fan-out the prior turn established, without the host's plain proof.

Recommended reading: the collision is in **re-deriving** a carried scope from
text. A scope the prior turn already established (`carriedFromPrior`) should be
carried as a fact, not re-parsed under the new precision; a fresh count still
gets the strict parse. That keeps both pins. It is the owner's call whether
fan-out on an affirmed follow-up is wanted; if it is, the fix is in how
`multi-item-intent` treats `carriedFromPrior`, not in either test.

## 3. What the classes mean

- **stale pin**: the sentence or shape changed on purpose, in a commit whose
  notes say so; move the pin to the new text, never the text to the pin.
- **real**: the test states an owner rule or a product fact and the code does
  not meet it; fix the code (PR-14, PR-15, PR-17, PR-18).
- **structural drift**: a closure or manifest pin grew from an unrelated wave;
  prune or accept with a reason in the commit.
- **regression**: it passed at a named release and a named commit broke it;
  the owner decides which rule wins.

Rule for every later run: compare the failing-file **list** against §1. A file
not listed is a regression. A listed case that goes green is recorded here with
the commit that fixed it. The §2 cases are expected on any machine without the
local retrieval model and under full load; they are not a pass or a fail of a PR.
