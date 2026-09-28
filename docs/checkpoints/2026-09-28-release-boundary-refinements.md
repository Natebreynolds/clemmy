# Release boundary refinements — 2026-09-28

## Verified

The combined source at `887e8ceaf` was fast-forwarded to local main and pushed
to origin/main. It remains the installed runtime in this wave. Owner edits and
the parked journey experiments in the integration checkout were preserved.

Additional recording/fixture checks on that candidate passed:

- Workflow-parent review/continuation: 11 tests.
- Compaction, accepted-source continuity, restart and workflow author/edit/run:
  11 tests.
- Familiar learned-tool binding and the 100-worker competitive journey: 5 tests.
- Public repository hygiene passed before the source push.

These are correctness checks, not installed-app acceptance or latency results.
The machine was under unrelated process load; no wall-time benchmark claim is
made from these checks. No live generative provider was invoked by these tests.

### iOS project generation

CI at `887e8ceaf` failed before compiling tests: XcodeGen generated project
format 77, which the runner's Xcode 15.4 could not open. `006343a38` specifies
`projectFormat: xcode15_3`, the documented XcodeGen compatibility option.
Local generation and project inspection passed. CI at `d25495c0a` subsequently
passed the iOS unit-test job.

Reference: https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md

### Windows checkout integrity

CI at `887e8ceaf` passed Windows readiness and core tests but failed daemon
startup: the shipped invoke artifact no longer matched its content address.
A disposable Git checkout with `core.autocrlf=true` reproduced this mismatch.
`d25495c0a` marks only the emitted implementation artifacts as `-text`, keeping
their exact bytes on checkout. The runtime hash verification remains intact.
The new regression failed before the attributes change; all four artifact
freshness tests passed afterward. CI at `d25495c0a` passed Windows startup.

CI evidence: https://github.com/Natebreynolds/clemmy/actions/runs/36391776097

### Native MCP argument repair

The older lifecycle fixture expected the carrier to disappear in cold state
and all prior catalog entries to be injected unconditionally on warm turns.
It now exercises the current stable carrier and successful-run learning with
a recorded Jev turn-start selector. It does not seed learned strategies or
manifests. The fixture explicitly disables completion review because it tests
capability routing with a recording brain, not generative judgment.

This exposed a real defect: turn-start re-attestation refreshed the MCP input
schema, but an old argument shape could still reach the provider. The accepted
MCP carrier now applies the existing conservative schema walker to its exact
accepted schema before metadata/business I/O and before consuming consent.
Missing required fields and explicitly closed-object fields receive bounded,
value-free repair information. Open provider data remains accepted; account,
definition, mutation-consent and fresh-preparation checks remain in place.

The missing-argument regression failed with `Missing expected rejection` before
the runtime fix. The corrected carrier, production MCP carrier, and ordinary
channel lifecycle journey passed **54 tests**, with no failures or skips.
The lifecycle fixture uses a real mutable stdio peer and retains:

- Cold discovery: 3 recording-model frames.
- Learned warm reuse: 2 frames, no discovery frame.
- Changed schema: 4 frames, only the corrected business call crosses.
- Renamed operation: 4 frames, exact successor and predecessor retirement.
- Removed operation: 3 frames, explicit retained pre-dispatch refusal and no
  business crossing. Pre-admission refusal does not fabricate a paid settlement.

There were four total provider business calls and 31 metadata list calls.
The latter is a future optimization target, not evidence that freshness probes
can be omitted. Source checks are not proof that this fix is installed.

## Skipped or not established

- No reboot, Keychain reset, password change, ACL/partition-list widening,
  personal CLI reauthentication, or live-home fixture reset.
- No new installed-app acceptance for the native MCP argument refinement yet.
- No claim that all pinned CLIs are healthy. Cached CLI health and current
  credential readability are different observations.
- No new matched billed-token or production latency comparison.
- No full-suite success or updated aggregate journey pass count yet. Older
  journey debt remains until the exact final candidate passes its required gates.
- No release tag or signed/notarized release artifact was produced.

## Still owed before release

1. Build the final reviewed revision, install through the coordinated hotpatch
   procedure, verify served identity and run controlled live-home acceptance.
2. Finish exact-candidate full tests, canonical journeys, package/upgrade and
   release artifact qualification. The passing iOS/Windows jobs do not replace
   those gates. Do not waive named failures without investigation.
3. Resolve the OS credential problem or explicitly document its verified
   environmental boundary. An unlocked Keychain still failed the Salesforce
   credential read from both the agent parent and Terminal; the targeted CLI
   inspection fix does not repair that credential. Signing is also unproven.
4. Triage dependency advisories against the shipped lockfiles. Current high
   severity runtime entries include adm-zip 0.6.0, sharp 0.35.3, fast-uri 3.1.4,
   ip-address 10.2.0 and js-yaml 3.15.0 in the root tree, plus js-yaml 4.3.0 in
   the desktop updater tree. Advisory fixes reported by GitHub are respectively
   0.6.1, 0.35.4, 3.1.6, 10.3.1, 3.15.2 and 4.3.2. The web app also has a
   nanoid advisory. No dependency upgrade was slipped into this wave; exact
   shipped reachability and compatible updates still require validation.
5. Repeat matched installed-app work for total task tokens, latency, exact
   reviewer/model/account routing, workflow author/enable/execute, corrected
   approvals and continuation without replaying completed writes.

Local detailed receipts are in the qualification and release-journey
checkouts' `output/release-readiness-2026-09-28/` directories. Preserve those
receipts across a reboot; committed work is already remotely backed up.
