# Release efficiency repair — 27 September 2026

The owner set an active goal: ship the next tag tonight only if it is measurably better than v3.18.21 and qualified for long conversations and long-horizon fan-out. This checkpoint records source work, not release acceptance.

## Live evidence motivating this repair

Installed 9b2da1e62, fingerprint e5293757eaab9ef9c722b35a36e6e88031e958edf0b48bd87f6e4b914ff2da4c, completed trial 3 with Grok 4.7 brain/judge and owner fallback off. Four tasks took 331.7 seconds and 410,429 attributed prompt tokens versus 207.9 seconds and 181,554 attributed prompt tokens on previous patch 729e01807. Prior attribution omitted 7,055 memory input tokens; this does not explain the regression. This comparison is NOT against the last tag. Last-tag commit is 07fb6f850bae4cabfee207d2c1ee5c1c9d23a6f0 (v3.18.21), verified on origin.

Saved-comparison recall took 21 logical tool calls and 10 brain frames. A medium claims-only review found two factual wording issues, then full confirmation of the same draft timed out after about 90 seconds before repair proceeded. The heartbeat question used a full tool desk merely because a known operation existed, doubling estimated schema tokens from 4,198 to 9,097. Missing Space reads gave no navigation assistance and prompted additional guesses/directory scans. The new calendar path was materially faster and correct; it must stay intact.

## Bounded framework changes

- **Known operations are not delegation.** Tool-desk promotion now reads durable dispatches of registry-declared delegation primitives; an unfinished work manifest still promotes long work. Merely holding a discovered/read capability no longer expands the whole session to the full desk. First-class run_worker, same-source reuse, session floor, plan/act/execution scope, deferred-tool naming and both discovery/carrier doors are preserved. The old integration assertion equating a Space capability with delegation was replaced with real read-carrier reachability plus recorded delegation and unfinished-work/reopen checks. This changes a false structural premise, not an execution permission.
- **Repair reviewed claims before reviewing the unchanged draft again.** For read/plan work, a parsed claims-only or reply-format verdict goes to the existing repair owner immediately. It remains done=false; no confirmation or success is fabricated. The corrected answer still goes through existing completion review and reply-digest checks. Writes retain their full-depth review; unscoped missing-work negatives retain full confirmation. No provider/model names enter the decision.
- **Missing resource reads offer current locators.** A missing exact Space slug returns bounded metadata candidates ranked from current slug/title/objective matches and retains space_list as the complete navigation door. It does not read candidate datasets, select a replacement, change a Space or grant write authority. Archived metadata is excluded. This is a shared read-path recovery change; no personal Space/data was altered.

## Validation so far

- 77 tool-desk/continuity/plan/worker tests pass, including compaction continuity, accepted-source conversation continuity, direct worker dispatch and delegated-write protections.
- Expanded core pack: 461 tests pass, including the full completion runner, objective judge, BYO reviewer wire, and Space tools. No failures/skips. This overlaps the separate 77-test judge run; do not add those twice.
- Each of the three new behavioral pins fails with its corresponding pre-fix implementation, then passes with the repair. Temporary restoration was limited to this task's own clean integration worktree paths and restored byte-for-byte; no stashes or shared-main edits.
- Root typecheck passes after all three runtime changes; diff whitespace checks pass. Tests use the repository's outer disposable-home runner, never live-home fixture resets. Because the installed daemon is active, the runner explicitly cannot certify a static live-home sentinel. No new live acceptance or performance improvement is claimed.

## Qualification still owed

The updated source has not been built, installed or accepted live. Full exact-commit suite, serialized journeys, build/pack/upgrade/release closure, last-tag matched measurement, installed workflow author/enable/execute, corrected approval, long-chat continuation and no-replay fan-out remain. Existing inherited journey failures are not waived by this checkpoint.

A 100-worker journey currently confuses cache-stable plan_task schema visibility with plan activation. Its next repair must assert exact durable accepted-source plan authority and retain all worker/restart/one-write assertions; it is separate unqualified test work until run. No goal is declared complete and no tag is created here.

The machine's company-management notifier was consuming ~160–180% CPU continuously. The owner was asked whether correctness checks may proceed under that load while timing benchmarks wait; the earlier idle-machine agreement remains in force until answered. Do not stop unrelated services to force a green timing run.

Runtime-only local hotpatch signing limitations remain: native signature was preserved, but the old bundle resource seal does not validate newly swapped resources. Proper release packaging/signing evidence is still required. Do not ask the owner to unlock repeatedly: the previous keychain status was already unlocked; no credential/trust changes were made.

Detailed receipts: output/takeover-2026-09-27/BENCHMARK-TRIAL-3.md and output/release-3.18.22-2026-09-27/. The goal and outstanding gates are recorded in the latter PLAN.md.
