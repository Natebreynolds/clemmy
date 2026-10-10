# PR-00 — Green main: the hygiene fixture, then the two September fixes

Size XS · risk none · depends on nothing · blocks every other PR's "no regression" proof

## Why

Main's `Test` workflow has failed on every push since v3.18.34 (runs 744, 741, 725,
686, 685). Run 744 on `b0612dd` dies at the first step:

```
> node scripts/check-public-hygiene.mjs
Public-repository hygiene check failed:
- provider-resource-id: packages/chat-engine/src/live-work.test.ts
```

`scripts/check-public-hygiene.mjs:21` treats `003` + 15 alphanumerics as a
Salesforce record id unless the value is placeholder-shaped
(`isFixtureResourceId`, :111). `packages/chat-engine/src/live-work.test.ts:18`
carries a Salesforce-shaped contact id in a JSON fixture string as a "machine text" sample.
Because the hygiene step runs before `npm ci`, no unit test has run on main since
the 22-known-failures baseline of v3.18.34, and no later PR can show it did not
regress anything.

## Change

1. **The fixture id.** Replace the Salesforce-shaped id with a fixture-shaped one
   that still reads as machine text to `looksLikeMachineText`:

   ```diff
   -    '[{"Id":"<the Salesforce-shaped id>","Name":"Mike"}]',
   +    '[{"Id":"contact-fixture-1","Name":"Mike"}]',
   ```

   Verified on 2026-10-10: `node scripts/check-public-hygiene.mjs` passes with this
   line; the test's assertion is on braces and quoted keys, not on the id shape
   (run `node scripts/run-tests-isolated.mjs packages/chat-engine/src/live-work.test.ts`
   to confirm after `npm ci`). This change is already applied on branch
   `claude/next-level-plan-2026-10-10`; cherry-pick it or re-apply.

2. **Record the baseline.** With CI green at the hygiene step, let the unit job run
   once and write the list of failing test files into
   `docs/checkpoints/2026-10-10-ci-baseline.md` (the "22 known" set of v3.18.34 is
   named only by count in `docs/releases/v3.18.35.md:73`; the 10-07 checkpoint names
   seven of them: `autonomous-send-consent-crash-matrix.red`, `memory-model-route`,
   `claude-agent-brain`, `loop-structured-output-guard`, `model-role-options`,
   `model-roles`, `respond-bridge-one-gate-wiring`). Every later PR compares
   against that list, never against "the same count".

3. **Take the two community fixes**, each re-validated on today's main (they are
   from 2026-09-14 and have not been rebased):
   - **#90 "An embedding worker no longer spawns another embedding worker"**
     (`origin/fix/embedding-worker-recursion`): a main-thread guard in
     `src/memory/embedding-worker.ts` plus `embedding-worker-lifecycle.test.ts`.
     Main still has no `isMainThread` guard there (grep is empty on `b0612dd`).
     The defect it describes (every worker generation importing `embeddings.js`
     and warming the provider, ~70 generations, 21 GB) is the kind of thing that
     kills CI runners after a green verdict. Re-run its test on main before merging.
   - **#91 "The test suite stops fanning out past what CI exercises"**
     (`origin/fix/test-runner-concurrency-cap`): caps default test concurrency at
     `min(4, availableParallelism() - 1)` in `scripts/run-tests-isolated-args.mjs`,
     with `--test-concurrency` to widen. CI itself is unchanged. Rebase and keep.

## Files

- `packages/chat-engine/src/live-work.test.ts` (one line)
- `docs/checkpoints/2026-10-10-ci-baseline.md` (new)
- `src/memory/embedding-worker.ts`, `src/memory/embeddings.ts`,
  `src/memory/embedding-worker-lifecycle.test.ts` (from #90)
- `scripts/run-tests-isolated-args.mjs`, `scripts/run-tests-isolated.test.mjs` (from #91)

## Tests

- `npm run check:public-hygiene` and `npm run test:public-hygiene` green.
- The touched test files, one at a time, via `scripts/run-tests-isolated.mjs`.
- The CI unit job runs to completion on the PR and its failing-file list equals
  the recorded baseline or is shorter.

## Done when

The `Test` workflow on main reaches the unit step, the baseline file names every
failing test file, and #90/#91 are merged or closed with a reason on the PR.

## Do not

- Do not loosen `isFixtureResourceId` or the hygiene regexes to admit the id.
- Do not fix the 22 baseline failures in this PR; name them. Each is its own
  change with its own owner (several are the model-role suites that PR-03 touches).
- Do not merge #90/#91 unrebased; both predate the public-history reset.
