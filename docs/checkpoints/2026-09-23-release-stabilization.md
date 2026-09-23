# Release stabilization — 2026-09-23

## Owner's acceptance bar

Owner challenged whether our new work is creating failures and reiterated that
things cannot fail in this release. Known broken required user flows block the
tag, regardless of whether the mechanism predates our branch. A passing build,
a narrow test, a partial lifecycle or a pre-existing label is not acceptance.
No new rollout flags, new harness components or discretionary feature expansion.
Hold further hotpatches and paid pilot retries while attributing current failures
and qualifying repairs. Keep the full north-star/release requirements open.

Installed candidate at this checkpoint is 5ee596f98574fe389f4f5eea5f40093a3704cebe,
fingerprint0e9e18020f3e070bcfedc93c459db3a70f3f40cc206efbb1a74c5ea0dc454df5.
Main remains e77215d008623bf30bddf13448f00496483a5e2c. Work is in harness/3.19;
no main, UI source, tag or push changes. Preserve other agents' edits.

## Matched attribution

Same standalone lifecycle test, Node/dependency installations already present,
same isolated runner, new disposable home for each run, no model/provider call:

| Source | Revision | Native read before a view exists | Snapshot before a view exists |
| --- | --- | --- | --- |
| v3.18.19 | 8c11aa3c | FAIL ENOENT view/index.html | FAIL ENOENT view/index.html |
| main | e77215d00 | FAIL same path | FAIL same path |
| candidate | 5ee596f98 | FAIL same path | FAIL same path |

Named cases: `new Workspace remains readable through the native tool before
view generation` and `new Workspace snapshot remains readable before view
generation`. Each source ran alone; each exited1 with two assertions failing.
The input follows the existing Workspace creation control plane's createIfAbsent
shape, with no viewContent. Creation succeeds but reading then fails. This
reproduces an existing lifecycle incompatibility now exposed by the live pilot;
it is not proof that every business workflow failure predates the new work.

Evidence script and logs:
output/harness-acceptance/2026-09-23-release-attribution/.
Invocation: CLEM_ATTRIBUTION_ROOT=<exact-checkout> node
scripts/run-tests-isolated.mjs /tmp/clem-workspace-lifecycle-attribution.test.mts.
Existing baseline checkout read only; no source edits there. Sentinel reports
NOT PERFORMED while daemon owns the live home; do not claim live-home isolation
proof from that sentinel. These diagnostic fixture tests are not app acceptance.

Desktop route mechanism is also present in v3.18.19 source: pushState uses /inbox
while the console is mounted at /console. That source attribution does not
replace native notification-click acceptance. UI ownership permission remains
required; no desktop source edits made here.

## Scope of new work and unresolved attribution

main..5ee596f98 contains47commits and143changedfiles. Of the additions,3488lines
are docs,3948tests/fixtures,3035implementation; implementation changes span82files
(704lines removed). No UI source files differ in this harness series. Do not
present total changed lines as all new runtime code, or infer safety from size.

Pilot machinery itself predates this series (ca95f0333). The two-phase local
output, host provenance, merge policy and text interpretation extensions are new
and lack complete live qualification. Their validation/authoring failures are
ours to resolve, not evidence the existing workflow lifecycle was qualified.
The 5ee live retry branched after the earlier cancellation, then failed before
pilot authoring: Workspace scope/list retrieval overhead, missing-view read,
and stale result recovery. Source292077 ended292286 blocked despite an accepted
cancel request.110504ms,10top-levelcalls,425742input/287948cached/137794uncached/
3699output;23usage records, exact attribution certified but4uncertified calls.
No pilot card or execution. Do not restart or recancel that terminal attempt.

## Repairs under qualification, not installed

- Read manifest-only Spaces without inventing a view. Missing view is explicit,
  contributes to the snapshot revision, and cannot alias an empty saved file.
  Only ENOENT is treated as absence; other I/O failures remain errors.
- Static replacement still requires existing view bytes before any mutation.
- Native Space read reports missing view instead of promising saved HTML.
- Workspace inventory accepts the exact declared output pair just as creation
  review does; acquisition remains read-scoped. Optional exact workspace_id
  lookup avoids broad inventory, fuzzy selection and unrelated data.

Three targeted regression cases pass. Broader tests, final typecheck, code review,
build and live acceptance remain owed before shipping these edits. Full suite,
package/upgrade checks, actual notification click, physical mobile and the original
release gates are still open. Do not use this checkpoint to waive any of them.

Broader qualification result:126checks passed across full store, static document
update, native Space tools and pilot control-plane files, serial concurrency1.
No failures or skips. Log /tmp/clem-workspace-stabilization-regressions.log,
session67461 exit0. Includes existing commit/recovery/read/edit/preview cases,
new missing-view read/preview, absent-versus-empty revision separation,
non-ENOENT I/O propagation, and a static replacement refusal proving all retained
manifest/data/receipt bytes unchanged and no new observation/view created.
Final typecheck passed (/tmp/clem-workspace-stabilization-typecheck-final.log,
session65587 exit0). Whitespace diff check passed. Still no installed acceptance
of these edits, no full-suite/package qualification, no tag authorization.

## Desktop notification repair authorized

Owner explicitly authorized narrowly scoped apps/desktop routing/read-ack repair,
rebuild and real native click acceptance. This supersedes the permission-pending
note above; other UI ownership remains unchanged. Desktop boundary now prefixes
validated Inbox routes with /console, preserves selection/query/hash, waits for
load and successful navigation before read acknowledgement, and preserves
markReadOnOpen:false. Failed/destroyed/untrusted renderer leaves notice unread.
21 toast/navigation/media-policy checks pass; desktop TypeScript/preload/native
helper build passes. Installed main.js differs from the rebuilt main.js only in
this repair; delivery must replace app.asar, not merely the daemon. Preserve
archive unpack flags, executable modes, unchanged entries and signing identity.
Native click and installed acceptance are still owed at this checkpoint.

Additional recorded native plan/Space regression suite:15/15 pass, including
read/write/read, retained plan requirements, workflow enable/reopen and one
mutation. No paid providers. /tmp/clem-workspace-plan-regressions.log.
