# Host runner test debt — 2026-09-23

Current installed runtime a8b0cb947 remains unchanged. No paid calls.

Full host-turn-runner file at clean HEAD:304 tests,271 pass,33 fail.
Last tag v3.18.19 (8c11aa3c0), detached /tmp/clem-release-baseline-0923,
with its own npm ci dependencies:297 tests,255 pass,42 fail.
Whole-file comparison found no HEAD-only top-level failing names, but that is
not individual attribution for every failure.

The exact "host stepping: N host steps = N getResponse; tools run on host;
hooks still fire" test failed alone at both HEAD and tag. It lacked accepted
source identity, a harness-bound tool and capability envelope, and host_v1
selection. The updated fixture supplies these and invokes productionHostRunRunner
without the test-only unowned-invocation shortcut. All original assertions remain:
two model calls, one tool body, exact start/end hooks, final answer, no interruption,
and a retained result in the next model projection. No production guard was relaxed.

Whole-file rerun after fixture correction:304 tests,272 pass,32 fail,23.96 seconds.
Typecheck passed. Test fixture and this checkpoint are
not yet committed. No hotpatch is required to demonstrate a test-only repair;
a future committed candidate still requires rebuilding under the normal rule.

Evidence:output/harness-acceptance/2026-09-23-host-runner-debt/.
Remaining32 failures need independent HEAD/tag attribution; full repository
suite and journeys remain owed on an otherwise idle machine. An active other
agent prevented calling this an idle-machine full-suite run. These are targeted
fixture tests, not installed-app acceptance. Live-home sentinel explicitly NOT
PERFORMED while daemon80652 owns the live home; never treat this as isolation proof.

## Retained-result progress expectation corrected

The exact “consequence-free dependency lookup and bounded authority retries
retain available result readers” test failed independently at HEAD a8b0cb947
and v3.18.19 with the same task_work/dependency_lookup mismatch. The file_query
registry explicitly declares readsRetainedOutput. Commit 69da86a24 already
classifies successful non-mutating retained-output reads as task_work, allowing
Clem to consume fetched evidence without spending a stalled-retry allowance.
The test still expected the earlier metered class. Corrected this single
expectation and added its semantic rationale; no runtime code changed.

The test now passes, including unchanged assertions for exactly two lookup
model calls, one lookup body, retained reader tools, and bounded authority
acquisition (five calls/bodies followed by control_no_progress_exhausted).
Do not revert retained reads to dependency_lookup merely to match the old test.
Repeated identical outcomes remain separately metered by production logic.

Combined host-turn-runner and host-no-progress-projection check: 364 tests,
333 pass, 31 fail, 27.14 seconds. Typecheck and diff whitespace check passed.
The previous single host-runner file had 32 failures after the first fixture
repair; this removes one more. Remaining failures are not cleared or attributed
individually by this result. Full suite/journeys and live acceptance remain owed.

Installed build-info rechecked: a8b0cb947, fingerprint
50b78c6dd10ac2d4af89c5f19503638298beb4a8e8916bb4b10813580933bf30,
daemon 80652. Test/doc changes remain uncommitted and uninstalled. No paid model
requests, hotpatch, tag, or changes to the other agent’s main worktree.
Evidence files: head-lookup-alone.log, tag-lookup-alone.log, fixed-lookup-alone.log,
two-fixes-combined.log, two-fixes-types.log in the evidence directory above.

## Transport fixture migration — incomplete, do not ship as accepted

Eight transport/stream retirement test names were each run alone at current
HEAD and v3.18.19; all sixteen invocations failed. Per-name results/logs are in
the transport subdirectory. Original failures stopped after their first tool
with accepted_source_context_mismatch, before testing transport recovery.

Work in progress converts these fixtures to runProductionHost with accepted
source, wrapped tools and a sealed capability envelope. Original invented
read_fixture/write_fixture names have unknown effects, so the candidate uses
recording stubs for declared native read_file/task_add/task_update effects.
All original no-duplicate, partial-intent rejection, retry and final assertions
remain. With this candidate, zero-retry stream retirement passes; the other
seven now reach missing write coverage. This is NOT a completed repair: a stub
needsApproval=false is not accepted work coverage. Next supply exact durable
authority for the controlled writes using the existing admission contracts;
do not bypass consent, relabel writes as reads, or weaken assertions.

No production runtime code changed, no new paid calls or hotpatch. These
eight test edits remain experimental/uncommitted; the earlier 333/31 combined
result predates them. Do not claim an updated whole-file pass count from the
1/8 focused result. Main remains e77215d00 and other agent edits are untouched.

## Transport fixtures completed — supersedes incomplete migration above

All eight transport/stream cases now pass independently as a focused group and
within the whole host-runner file. Replaced invented, unowned write stubs with
a declared reversible native-MCP capability, exact account/schema/independent
observation, registered recording-only provider port, and structured successful
receipt. Each body asserts it received the exact consent grant. Source text
explicitly requests one reversible draft. Tests use accepted source identity,
wrapped carrier and sealed envelope through productionHostRunRunner, with no
unowned invocation shortcut. No runtime admission rule changed.

The original assertions remain: exactly one settled write/read body, no partial
call dispatch, bounded retries, retained receipts in subsequent requests, no
partial model text in accepted history, cancellation/permanent errors not
retried, and a persistent transport failure becomes the existing saved-work
continuation question. A raw string fixture result was insufficient for the
external port's durable outcome evidence; the final fixture returns its
structured successful receipt. This does not prove arbitrary raw-string
provider-result acceptance and must not be represented as such.

Focused:8/8 pass. Combined host runner + progress projection:364 tests,341 pass,
23 fail,29.60 seconds. No new top-level failing names relative to the previous
333/31 combined check. Typecheck and diff check pass. Remaining23 failures,
repository-wide suite/journeys and installed-app live acceptance remain open.

Evidence:transport/authority-focused-green.log, authority-combined.log,
authority-types.log and authority-comparison.json. All changes remain test/doc
only, uncommitted and uninstalled. No hotpatch, tag, live-home writes or paid
model calls by these checks. The wrapper's live-home sentinel was NOT PERFORMED
because live daemon80652 remains active; its memory writes during the check
are not isolation proof.
