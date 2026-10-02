# Reuse stable event SQL without retaining results

## Why this correction

The frozen edee94b25 candidate passed the full suite (19,523 pass, 8 skip, zero fail), then returned 200 pass and one timing failure in serialized journeys. The ordinary-conversation host wall p95 was 50.078 ms against its unchanged 50 ms gate. No hidden-call, tool-surface or semantic gate failed. That failed receipt remains recorded; a later profile is not its replacement.

Recording-only attribution found a median 308 SQLite prepare calls per positive conversation, consuming 4.278 ms median. Four fixed event-log shapes were still prepared repeatedly despite the existing connection-bound statement cache: the generic event insert, event-ID read, session timestamp update and session-ID read. This is attribution of all preparation, not a claim that this patch saves all 4.278 ms.

## What changed and what stays authoritative

Reuse the existing prepareCached helper for these exact SQL strings. Both ordinary and internal transactional event insertion use the same eight-column, eight-parameter SQL. Each operation still binds its own arguments and executes its existing SQL within its existing transaction. Current rows, source ownership, terminal winner, approved plan, account and effect authority are not cached or relaxed. There is no schema change, provider branch, result cache or durability change.

The cache now gives a reentrant call a temporary independent statement when the cached statement is busy. It leaves the original iterator and its bound parameters intact, and resumes reuse after that iterator finishes. Closed connections still report the native prepare error; reopened paths receive a different connection cache. Existing callers must continue to avoid bind/pluck/raw/expand/safeIntegers mutations on cached statements.

## Verification at working source

- At the exact predecessor edee94b25, the six new/cache tests returned four pass and two intended failures: nine event insert compilations instead of one, and an active iterator sharing its statement with a nested read. The temporary detached worktree was removed after retaining the log.
- Corrected focused checks: 14/14 pass. Broader serialized event-log, lineage, accepted authority, terminal publication, restart, exact-learning lookup, conversion and storage-reporting checks: 173/173 pass. Typecheck: exit 0.
- Fresh uninstrumented ordinary journey: 3/3 pass, 62 recording-model positive samples, host median 25.800 ms / p95 33.310 ms. No competitive gate violation. This is a local fixture measurement, not a matched installed-app latency or token claim; the previous failed p95 receipt is retained.
- Reads after a correction, wrong-scope bindings, schema alteration, Unicode event payloads, independent session writes, internal writes and close/reopen all remain exact. Repeated insert compilation is pinned at one for nine writes; all nine writes still execute.

Logs are under output/storage-efficiency/statement-reuse-{at-predecessor,focused,regressions,typecheck,ordinary-journey}.log. The earlier misconfigured baseline setup ran only the two old tests and is separately retained as statement-reuse-baseline-setup-failed.log; it is not attribution evidence. The isolation sentinel was NOT PERFORMED because the running live daemon writes the observed home. No production rows, settings, credentials or model-provider calls were made by these fixtures.

## Qualification still owed

Commit and build this combined source, then run the full suite and serialized journeys at its clean frozen revision. The edee94b25 suite/build receipts do not qualify these newer bytes. Recheck premium-UX ownership and main before integrating. The prepared installer must be repinned to the new build and requires the coordinated owner installation window and a verified consistent recovery snapshot before schema 88 to 91 migration.

Installed/live-home acceptance of exact history reads, recovery, plans, approvals, completed-write non-replay, learned proof lookup and storage UI remains mandatory. Historical conversion is not scheduled yet; a small controlled conversion must pass first. No production conversion, physical shrinking, hotpatch, tag or main merge is claimed here. Compression and whole-history sharing do not fully eliminate repeated unique prefixes; shared segments and independently verified learning certificates remain subsequent architecture work.
