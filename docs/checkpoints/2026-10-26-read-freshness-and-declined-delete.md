# Read freshness and declined workflow decisions — 2026-10-26

Base: peer `claude/daemon-loop-holds` at `d8ad0862984c6af1df92f431becfcf211c200ede`, fast-forwarded into `codex/memory-completion-refinement`. Peer edits, token meter, protected Needs You surfaces and notification eligibility are preserved.

## Changes

- Creation-test reuse now carries the original read's run, observation time and admission time through later copies. Per-step freshness and displayed age use that original observation; a file saved after original admission invalidates the copy. Unknown legacy inherited provenance forces a new read. The existing fifteen-minute and calendar-day rule is checked again when the result is actually consumed, so an earlier slow step cannot extend its life. Existing journal metadata is used; no new persistence layer or schema.
- A rejected local `workflow_delete` stays rejected for the same target set when a retry changes omitted/null confirmation to true, uses name/names, or repeats/reorders targets. The equivalence is confined to the trusted local operation and uses a distinct key; provider lookalikes and other schemas retain their existing comparison. Different targets and later user requests remain distinct. This adds no dispatch authority.
- Mobile shows a recoverable tool failure during a still-running turn as a warning, matching desktop. Terminal failures retain their existing presentation.

## Validation before build/install

- Creation-test regression suite: 10/10 passing after reproduced failures for chained age, intermediate file saves, unknown inherited provenance and expiry during execution.
- Declined-action unit and production host pause/reject/retry integration tests: 6/6 passing after reproducing repeated approval cards and a provider identity collision. Both retry variants assert no second card or physical dispatch.
- Adjacent creation-test scheduling and chat approval-resume tests: 58/58 passing. Network access and live-home reads denied by the test sandbox.
- Independent bounded review found no remaining actionable issue. Full candidate builds and installed acceptance are separate subsequent qualifications.

Evidence: primary repository `output/end-to-end-review-2026-10-26/` (sanitized receipts, RED/GREEN logs, hashes and patches). No savings claim: retained accepted-task usage lacks complete all-leg inventory and backend/account qualification.

## Current qualification limits

The independently observed installed app remains peer source `d8ad08629`, version 3.18.55, fingerprint `acb7159d872db11e12a924629ca16abb74f782a8efcf2e309bcb29e788aae562`, schema 99, daemon started 2026-10-26T04:12:31.989Z. At 04:25Z there were zero unfinished run attempts; active-work still reported unverified retained ownership and is not proof that all work is idle. Recheck actual execution, capture, updater and peer state immediately before any lifecycle action.

The widget/Watch commits are already merged into the peer branch. Build 19 archive and successful upload receipts were located; physical iPhone/Watch behavior and TestFlight availability are not proved by those receipts. The latest full retained peer matrix is Claude 12/13, GPT 11/13 and DeepSeek 9/13; c19 reran only two workflow-author cases, passing both for Claude/GPT. It does not establish a full passing matrix. GPT connected deletion approve/reject still needs targeted installed acceptance.

The earlier delayed memory autocapture aggregate/duplicate finding is still open; correction and fresh recall acceptance were not completed. No personal memory or integration repair is authorized. No release/tag/publication is implied by this candidate.
