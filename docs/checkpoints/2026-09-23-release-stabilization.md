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

## Installed 5dba1dd41 follow-up — partial qualification

Daemon source5dba1dd41c46b2204809b7ac3ab41055a84858ea is installed, fingerprint
b5324eab3cfc02a5a753efdb9658774ea4220272ca90c13bb31b806673bcf843,
instance15d1e10f-2f88-4332-a790-cbb0dbbc2738, pid81419. The desktop notification
fix is NOT installed. Signing the new archive with the existing Developer ID
failed errSecInternalComponent. A read-only login-keychain query also failed
with the OS passphrase error. No security controls changed; owner asked to
unlock login keychain. Do not infer exhausted model quota or bad OAuth from it.
Original app.asar, executable, Info.plist and CodeResources were restored and
matched byte-for-byte; native Home rendered again. New daemon remains installed.
Never infer shell bytes from daemon build-info. Native click acceptance remains
owed. All pending rollback artifacts are under /tmp/clem-notification-shell;
do not overwrite them by rerunning apply.command. Signing traverses13GB including
old retained backups; elapsed minutes were not proof of a hung credential dialog.

Qualification on installed modules, using Clementine's own Electron runtime
(ELECTRON_RUN_AS_NODE=1) against the existing controlled live-home Space:
- Manifest-only native space_get succeeds, explicitly reports missing view,
  leaves the snapshot unchanged and does not invent a view:194ms.
- Exact inventory with approved proposal revision3/digest9574eff… succeeds for
  both declared read and output pairs:9ms/7ms. Each returns exactly the named
  fixture, revision1/digestfb7ef4…; no binding/execution authority granted.
- Missing exact Workspace returns[], never broad inventory fallback.
- Inventory uses a HISTORICAL CONTEXT REPLAY of source292077; readonly SQLite
  verified its user_input_received event/session. This is not a new accepted
  chat turn, pilot creation, or full lifecycle acceptance. Zero model calls.

Initial system-Node replay hit native SQLite ABI127 versus packaged148. Do not
rebuild installed native dependencies to accommodate a test runner. Rerun using
the app's own runtime. The initial49ms native-read result is superseded by the
194ms correct-runtime measurement, not a before/after latency comparison.

Release-asset suite56/56 passes on5dba1dd41. This covers asset contracts, not a
new signed installer or native click. Full suite held while load was12/12/12;
no full-suite pass claimed. Evidence under output/harness-acceptance/
2026-09-23-notification-click/ and2026-09-23-workspace-installed-read/.
No business workflow rerun, no external message, no paid model, no tag/push.

## Correction: login keychain is unlocked; signing still fails

After owner reported unlocking, a disposable /usr/bin/true copy was signed via
Terminal .command with the existing Developer ID, without quitting Clem or
changing installed bytes. codesign still failed errSecInternalComponent.
SecKeychainCopySettings still reports its passphrase error, BUT this is NOT a
valid lock-state test: direct Security.framework SecKeychainOpen and
SecKeychainGetStatus both returned0, statusBits7. Local SDK SecKeychain.h defines
1=unlocked,2=readable,4=writable. Thus login keychain IS unlocked at this check.
Do not ask the owner to keep unlocking based solely on the settings error.
Keychain Access shows the Developer ID certificate valid, its private key
present, and existing access unrestricted. These were read-only inspections;
no key export, password access, trust change, permission change or reset.
Root cause of signing failure remains unknown. Asked whether Mac/company
password recently changed; no response yet. Probe log:
/tmp/clem-notification-signing-probe/result.log. Clem stays on the restored shell;
notification fix remains uninstalled. Rebuild after this docs commit before
any further daemon hotpatch; no further patch or paid test performed here.

## Reboot cleared signing; first native click still failed

After owner reboot, disposable Developer ID signing probe passed. Rebuilt and
installed31aab865b, fingerprint17306f38b4eca3ac73f0fc8315f2d89f7d225d4d4a64878cac7665fcb6f35bba.
Two-module repaired shell SHA023dbe8a… signed with same identity and preserved
metadata; strict signature verification passed. Exact app relaunched. Original
rollback retained, including a persistent copy under output/harness-acceptance/
2026-09-23-restart-recovery/. This is not notarized-installer acceptance.

First controlled native notice was not seen. macOS Settings confirms Clementine
notifications enabled for Desktop/Notification Center/Lock Screen, temporary
banners. No settings changed. Second local notice while app backgrounded was
seen and clicked per owner, but native AX remained Home and both fixture notices
stayed unread. This is a FAILED native-click acceptance, not a pass from signing.
Fixtures harness-notification-click-0923 and its -background suffix. No paid
model or external provider delivery; installed local notification store only.

Found another shell defect: locally scoped Notification objects are not retained.
Electron43 docs explicitly require retained references for interactions; new
objects can be removed on garbage collection. Added bounded strong ownership
until click/dismissal/failure, stable native IDs and redacted id-only show/click/
close/failure diagnostics in the existing supervisor log. Windows banner timeout
retains the Action Center handler. New code still needs rebuilt installed native
acceptance; do not equate the plausible cause with a proven live repair.
Reference: https://raw.githubusercontent.com/electron/electron/v43.0.0/docs/api/notification.md
