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

2. **Confirm the baseline.** `docs/checkpoints/2026-10-10-ci-baseline.md` already
   names all 22 CI failures case by case, reconstructed in a clean container and
   matched to CI's count. With CI green at the hygiene step, let the unit job run
   once and diff its failing files against that list; record any difference
   there. Every later PR compares against the list, never against a count.

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

4. **The cutover-hold closure pin.** `src/daemon/cutover-hold-structure.test.ts`
   fails because `src/config.ts:8` now reads credentials through
   `runtime/credential-private-filesystem.ts` (the Windows credential policy),
   which brings `windows-private-filesystem.ts`, `sync-directory.ts` and
   `ascii-json.ts` into the held parent's closure. Accept it: move the pin and
   say in its comment that the hold reads its home through the credential policy.
5. **The reconciliation regex pin.** `src/runtime/harness/reconcile-only-irreversible-effects.test.ts`
   expects two clauses in `settlementRequiresReconciliation`
   (`host-turn-runner.ts:7447-7450`); v3.18.32 added the third,
   `&& !providerAnsweredWithRefusal(...)`, on purpose. Widen the regex to admit
   it; the second assertion (only `external_write` and `admin` reconcile) stays.
6. **What this PR does not fix, by design.** The other eighteen cases are
   owned by PR-14 (all-in BYO identity), PR-15 (fixed host sentences and stale
   pins), PR-17 (browser no-change settlement), PR-18 (kernel names no provider),
   and the orchestrator fan-out case (owner decision, see the checkpoint §2b).

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
