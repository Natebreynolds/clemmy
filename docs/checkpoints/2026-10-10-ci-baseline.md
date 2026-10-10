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
- Whether the four Windows modules in the cutover-hold closure are needed by the
  held parent (they are if the credential policy gates the hold's home reads) or
  leaked in through an import of `credential-private-filesystem.ts`.
