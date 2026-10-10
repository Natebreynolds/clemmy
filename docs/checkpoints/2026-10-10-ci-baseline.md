# CI baseline on main `b0612dd` (v3.18.35), case by case

2026-10-10 · written for PR-00 of `docs/plans/next-level-2026-10-10/` · provisional
until the detached full run in this container finishes (see §4)

CI's last complete unit run was run 725 on `cb5814cd` (v3.18.34, 2026-10-09):
21,284 tests, 21,209 passed, **22 failed**, 53 skipped, 61 minutes. Every push
since fails at the public-hygiene step (fixed by PR-00's one-line change), so
the per-file list below was rebuilt by running files one at a time on
`b0612dd` in a clean 4-core container with root, desktop, console and phone
dependencies installed. The CI job log itself could not be downloaded here (the
signed log URL is refused by the container's egress policy), so the list is
reconstructed, not copied.

## 1. Failing cases found so far (15 of the 22), classified

| File | Case | Expected / actual | Class | Fix lives in |
|---|---|---|---|---|
| `src/runtime/harness/model-roles.test.ts` | all_in declared gpt-shaped BYO binding and inactive reporting stay on the BYO provider | inactive binding `provider: 'byo'` / `'codex'`; reason regex pinned to an older sentence | real (reporting) + stale reason regex | PR-14 |
| `src/runtime/harness/model-role-options.test.ts` | an explicitly selected fallback keeps connected subscription and API routes separate from an all-in brain | ordinary options contain no `codex` group in all-in / they do | real | PR-14 |
| same | all_in is provider-isolated and gpt-shaped BYO ids remain BYO in role/UI reporting | ambiguous id not offered / offered | real | PR-14 |
| `src/memory/memory-model-route.test.ts` | the fast-tier jobs name the model the router actually serves them, and the meter tags that account | `byo-memory-model` / `gpt-5.6-luna` | real (attribution) | PR-14 |
| `src/runtime/harness/respond-bridge-one-gate-wiring.test.ts` | completed-work recovery candidate … a genuine no-work candidate stays blocked | no "ask me / continue / retry / resume" on an ownerless terminal / "…Ask me to check what completed…" | real (voice rule) | PR-15 |
| same | ownerless narration give-up closes factually without asking for a continuation | same | real (voice rule) | PR-15 |
| `src/runtime/harness/loop-structured-output-guard.test.ts` | guard: parse error with no recoverable text → safe fallback string | `/couldn't be structured/` / "Clementine couldn't prepare a usable reply…" | stale pin (legacy sentence) | PR-15 |
| same | guard: parse recovery does not reuse stale assistant text from prior turns | same | stale pin | PR-15 |
| `src/runtime/harness/claude-agent-brain.test.ts` | Claude brain closes a prepared workflow batch as a nonterminal dispatch before judge or narration | "Started — I'll post…" / "Queued — waiting for the workflow to start…" | stale pin (wording changed 10-07) | PR-15 |
| same | Claude brain preserves a prepared workflow handoff when the provider throws after workflow_run | same | stale pin | PR-15 |
| same | SDK brain keeps a still-pending automatic memory capture non-done (two wordings) | `stoppedReason: 'unverified'`, terminal `blocked`, no "Saved —" claim / `'success'` with the claim | real (legacy SDK lane; "done is evidence") | PR-15 |
| `src/channels/discord-harness-terminal.test.ts` | provider replied means dispatch ACK delivered while the exact logical edge remains pending | "Started —" / "Queued —" | stale pin | PR-15 |
| `src/channels/discord-harness.test.ts` | async dispatch releases only its exact placeholder with a compact deterministic ACK | "Started —" / "Queued —" | stale pin | PR-15 |
| `src/daemon/cutover-hold-structure.test.ts` | held parent and migration child have exact minimal runtime import closures | the closure gained `src/runtime/ascii-json.ts`, `credential-private-filesystem.ts`, `sync-directory.ts`, `windows-private-filesystem.ts` | structural drift from the Windows beta (`d4e6242e` and after) | PR-00 item 4: decide prune or accept, then move the pin |
| `src/agents/orchestrator.test.ts` | near-action and affirmative follow-up without the host plain proof retain semantic scope and fanout | `assert.match(instructions, …)` on the composed instructions no longer matches | see §2 | PR-00 item 5 |

The 10-07 checkpoint also named `autonomous-send-consent-crash-matrix.red.test.ts`;
that file no longer exists on main (fixed in 3.18.30, removed since). Not a
failure.

## 2. The orchestrator case needs a reading, not a pin move

The test composes a near-action turn with an affirmative follow-up and asserts
two things survive without the host's "plain proof": the scope-only prior-input
read (`allowedServerSlugs` names the provider; passes) and a fan-out
conversation read named in the instructions (`assert.match` at
`orchestrator.test.ts:3542-3545`; fails). The 10-08 change "Only an explicit
`/background` command routes to the background; words reach Clem" (`d86d9e1e`)
and the 10-09 tool-surface commits reworded what the orchestrator says about
reads and fan-out. Whoever takes PR-00 reads the regex against the current
instruction text and decides whether the behaviour (the conversation read
staying active) was lost or only its wording. If the behaviour was lost it is a
regression of the semantic-scope retention the test protects and goes to the
owner before any pin moves.

## 2a. Gates and intermittent cases seen in the container

| Gate or file | Result here | Reading |
|---|---|---|
| `npm run test:release-closure` (151 tests) | 149 pass, 2 fail: `scripts/dev-down-active-acceptance.test.mjs` both cases, exit code `null` where 0 was expected | environment: the dev-down script does not run to completion in a Linux container; this gate runs on macOS in `release-desktop.yml`, where v3.18.35 shipped. Verify on the Mac before counting it. |
| `src/execution/coding-run-git.test.ts` · "a timed out test also stops its descendant process" | failed once in the detached full run under full CPU load | intermittent: the 10-06 Windows checkpoint records "one joined POSIX cancellation check failed without retaining its descendant PID; its cause remains unknown". Rerun alone before classifying; if it fails alone it is a real process-group cleanup race. |
| `src/agents/orchestrator.test.ts` · the fan-out case | passes at `v3.18.26` (`4c3a9e42`, 10-02), fails at `v3.18.30` (`1a17e070`, 10-07) and at `v3.18.34` | a change in the 10-02 → 10-07 waves (301 commits) stopped the batch-shape mandate (`src/tools/batch-shape-directive.ts:43`, injected at `orchestrator.ts:2453` unless `hostFreshPlanning`) from reaching the affirmed follow-up's instructions. Bisect result below. |

## 2b. The orchestrator fan-out case, bisected

`git bisect` between `v3.18.26` (good) and `v3.18.30` (bad), running the single
case through the real runner at each step, names **`d222b5f3`** (2026-10-05,
"Clarification revision work exactly as installed on 10-05 (from the Codex
tree)", 68 files) as the first bad commit. Inside it, the relevant change is
`src/runtime/harness/multi-item-intent.ts` (+48/-?): count-only prose now needs
an operation **in its own clause** (`countedClause`), ranges and bounds ("10–12
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

## 2c. The detached full run so far

At 9,412 of 21,284 tests the detached run has 7 failures: the orchestrator
fan-out case (§2b), the two Discord queued-wording pins (PR-15), the
cutover-hold closure (§2a), the descendant-process case (§2a, intermittent), the
memory fast-tier attribution (PR-14), and one not yet classified:
`src/runtime/graph/turn-graph-semantics.test.ts` · "a participated failed admission stays graphless and commits a
blocked zero-tool terminal". Run it alone before classifying.

## 3. What the classes mean

- **stale pin**: the sentence or shape changed on purpose, in a commit whose
  notes say so; move the pin to the new text, never the text to the pin.
- **real**: the test states an owner rule or a product fact and the code does
  not meet it; fix the code (PR-14, PR-15).
- **structural drift**: a closure or manifest pin grew from an unrelated wave;
  prune or accept with a reason in the commit.

Rule for every later run: compare the failing-file **list** against this
document. A file not listed here is a regression. A listed file that goes green
is recorded here with the commit that fixed it.

## 4. Still to confirm

- The remaining 7 of the 22 CI failures. A detached full run of
  `scripts/run-tests-isolated.mjs --test-concurrency 3` is in progress in the
  container that wrote this document; its failing lines will be appended here
  with their files when it ends. Until then, treat any failing file not in §1 as
  "unclassified", not as new.
- The four Windows modules enter the cutover-hold closure through one import:
  `src/config.ts:8` now reads credential files through
  `runtime/credential-private-filesystem.ts` (the Windows credential policy),
  which pulls `windows-private-filesystem.ts`, `sync-directory.ts` and
  `ascii-json.ts`. `config.ts` was already in the closure, so the growth is the
  credential policy itself, not a stray import. Recommended: accept, move the
  pin, and note in the pin's comment that the hold reads its home through the
  credential policy since the Windows beta.
