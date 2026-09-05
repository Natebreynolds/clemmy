# P3 — one door for writes

Status: IN PROGRESS. Owner explicitly said “Start p3.” This is an evidence ledger,
not a green phase report or a release authorization. No P3 push or tag has run.

## Scope and invariants

Execute direction §5 P3 and reviewer §12: fix the three P2-derived preconditions,
connect exact nominated mutations to the existing consent reducer and existing
external port in the same step, generalize live-catalog resolution, use one risk
attestation builder, and aggregate `plan_task` repairs. Keep external-crossing CAS,
exact source/account/schema binding, durable results and reconcile-only uncertain
writes. Genuine sends/deletes/admin/sealed bulk still need exact consent.

P4 same-turn asks, P5 remaining plan/account simplification, and §15 broader
subagent auditing are not approved by this phase. Parallel trajectory auditing is
already configured; do not claim it audits a child merely because it overlaps the
parent's model call.

## Landed batches and local evidence

All commands below used the isolated test runner with actual exit codes. Counts
overlap; do not add them together. Providers in unit/integration tests are stubs
unless explicitly marked live.

| Commit | Change | Evidence |
| --- | --- | --- |
| `27787ce5` | Explicit completion judge cannot lose to a different-provider hedge; unavailable pin is unjudged, not silent self-judging | `/private/tmp/p3-judge-pin-red.log`: exit 1, 5 failures/6; green 6/6; focused 170/170 and typecheck exit 0 |
| `752603bf` | Remove the prose-census precondition for an already advertised, scoped `run_worker`; retain exact refusal reason/call | Captured call SHA256 `911ffe5ed7a731b2a130b5987db3e989a37c4f57a5843ac4ff2a5dc0aabc6695`; RED `coverage_missing`; `/private/tmp/p3-worker-final2.log` 371/371, receipt follow-up 224/224, exit 0 |
| `b699ad38` | Accepted declared local item demand is completed by item receipts, not preceding package reads or final prose | `/private/tmp/p3-local-work-red.log` exit 1; final suite 258/258, typecheck exit 0; actual stopped P2 ledger projects exactly eight missing items |
| `8cb61013` | One live catalog resolver accepts exact effect/account, retaining current manifest/port attestation and revocation | RED 11 pass/2 fail; `/private/tmp/p3-catalog-final.log` 24/24, typecheck exit 0; runner write wiring is a separate batch |
| `ddccda93` | Six consent adapters use one call/coverage value builder; exact graph-neutral catalog call uses existing reducer and durable approval | `/private/tmp/p3-consent-direct-red.log` 0/4, exit 1; final expanded suite 54/54, typecheck exit 0. Covers reversible draft, send/delete/admin ask, args/account/schema drift, exact approval replay and uncertain-crossing reconciliation |
| `79686a6b` | An unavailable judge pin does not prevent non-judgment structured extraction | Actual extractor invocation RED; extraction plus judge regression 14/14, exit 0 |
| `64c3bfa5` | Release hygiene fixture and dynamic release-schema assertion | Release assets RED 52/53 → GREEN 53/53. Hygiene green after reviewer corrected their own quoted URL; reviewer changes committed verbatim |
| `72565801` | Existing consent effect/account/risk fields survive live and replayed approval presentation; authority stays private | Targeted card 3/3, public 41/41, loop 27/27, isolated chat 19/19; typecheck exit 0. One combined process flake passed isolation; not chased |
| `cf50388e` | Strict plan validation happens once inside the tool body; aggregate shape/missing-write/lineage repairs and hash the full issue set | Actual invocation RED 2 failures, exit 1; `/private/tmp/p3-plan-singlepass-final.log` 80/80, typecheck exit 0 |
| `f616da92` | Exact live write resolution, logical admission, existing consent and existing direct invoke happen in one model step; exact approval resume shares that call | `/private/tmp/p3-direct-core-final.log` 258/258, typecheck exit 0. Pins draft allow, send/delete/admin ask, rejection/changed/wrong/expired approval zero dispatch, uncertain write no replay, and JIT read→write reclassification before consent |
| `9358dc08` | Resumed accepted source includes the original objective plus the actual answer, not private host instructions | Real producer→bridge RED exit 1; lifecycle/bridge 25/25 and account regressions 22/22, typecheck exit 0. Existing answer selects the right account and remains recoverable on continuation; unknown answer still asks |

Response to reviewer §12 22:57 write-bar question: `f616da92` connects the
mutation resolver in `host-turn-runner.ts` (`provenWriteCandidate`): it calls
`resolveProvenLiveCatalogEntry` with `effect: decision.effect` for external_write
or admin. No explicit capability reference means a unique current account is
required, not a synthetic default-account id. The fixture registers the exact
write after the model request froze its empty catalog and proves one dispatch.
Thus this is a connected write fallback, not only a read resolver or a claim that
consent makes resolution unnecessary.

Reviewer accepted judge/worker dispatch changes and local completion's grading
half. Reviewer requires bounded automatic re-entry for `local_work_incomplete`,
with exact missing items, before its next-edge half can close. That work is not
waived by marking the terminal resumable.

## First live P3 precondition replay — RED, retained

- Frozen SHA: `b699ad38760bdb2120ca69d1dc40c208f5f4e072`.
- Clean source: `/private/tmp/clem-p3-workers-frozen.yC1vzr`.
- Source fingerprint: `1a31417cf1471f518e106d6babd4f391dcef5a1228644cd532b71f7e8d9a326a`.
- Isolated home/evidence: `/private/tmp/clem-p3-workers-live.GHYMN5`.
- Port 64244; daemon PID 11689 stopped normally, exit 0. Main dev stayed down.
- Session: `sess-desktop-45fc9a99b421dd4df963180b`.
- Same acceptance shape as P2: two parent package reads, one eight-item local
  nonce worker packet, Codex Terra brain/workers, pinned Claude Sonnet 5 judge.
- Actual parent accepted and dispatched one eight-item worker call. Eight worker
  starts, eight effective Codex routes, eight failed worker results, no nonce
  outputs. Driver and offline collector both exited 4.
- All child failures retained the same cause:
  `LogicalCallPreDispatchAuthorityError: host call lacks exact live capability attestation`.
  Nested SDK execution attempted a tool without the host attestation; the parent
  accepted authority was then poisoned and could not settle/reopen its checkpoint.
- Required follow-up to reviewer §12 23:40: the full stopped home database has
  **one session, the parent**, no child sessions. Its `host_v1` authority is
  `conflict` with that exact close reason. Only five parent logical rows exist
  (two searches/two reads settled, `run_worker` open); there are no admitted child
  rows. All eight errors explicitly report `(conflict)`, not `missing`. This
  resolves the reviewer's two-site hypothesis at the host-attestation match before
  child-row admission; it is not evidence of a missing isolated child database.
- Terminal: `blocked`, `resumable:true`, retained two package-read handles, no
  external changes. This is not a successful fan-out or P3 acceptance.
- One real Claude Sonnet 5 watcher call succeeded on `claude_code_headless`,
  provider session recorded, 05:34:08.020–05:34:10.482 UTC, 2.462 seconds.
  It audited alongside the parent, before the failed workers. No final completion
  judge wire was exercised; the live completion-pin proof remains owed.
- Stronger local reproduction now runs the actual nested `Agent.asTool` SDK
  runner, not a replacement `asTool.invoke`. Only the model and local read body
  are deterministic. `/private/tmp/p3-worker-sdk-red.log`: 3/4 pass, exit 1;
  reproduces both missing attestation and parent authority poisoning.

This exposed a gap in the earlier pool fixture: stubbing `asTool.invoke` proved
the coordinator/pool but skipped the child SDK tool boundary. The original RED
log remains retained. The replacement pin keeps a byte-identical captured
coordinator boundary case, and replaces the child-provider response only for
full/partial/uniform-failure cases; genuine `read_file` dispatch and settlements
are required. Those local child cases substitute only an isolated nonce-file
path. They are not the byte-identical live replay.

The next cold live replay uses a fresh ledger, the new frozen implementation,
and the exact prior `submitted-prompt.json` prompt/packet, including original
read-only package/nonce paths. Setup copies the original nonce expectations into
the new collector home without changing the original files. Record prompt and
packet hashes plus byte-equality checks; no revised task or stronger prompt.

## Same canary — invocation contract

Resume `bg-graph-driver-tag-canary-20260904`, never recreate it. Original prompt:

> Find five suitable prospects in Salesforce, enrich them with DataForSEO, use my outbound skill to prepare and validate the outreach locally, then create five Outlook drafts. Do not send anything.

Prompt SHA256: `1a24a4992bf18e8031dc0cb4766d06025a543db699216756193a3c9c170dc1cf`.
Keep Claude Sonnet 5, contract version 1 and zero contract revisions. The P2 home
is `/private/tmp/clementine-p1-canary-ef04f7db.GBCFDh`; it is parked at the connected
mailbox question. The mailbox answer already exists in its stopped event journal
(seq 90). Resume that exact durable question via the supported Inbox answer route,
not a direct task JSON edit or a fresh task. Preserve “drafts only; do not send.”

Before live acceptance: freeze a clean implementation SHA, verify provider
availability, use access-only isolated auth (never copy a rotating refresh token),
record daemon SHA/fingerprint/schema, then invoke once. Inspect live state via
API/task files; open SQLite only after the isolated daemon stops.

Acceptance still owed: real Salesforce read, DataForSEO enrichment, local
rehearsal, five ordinary reversible draft write receipts with zero approval cards
and zero sends, terminal truth from the ledger; plus live worker success and
actual pinned cross-family completion-judge transport evidence. Local tests alone
do not satisfy this list.

## Release status

### Reviewer §12 23:06 — current-byte verification and correction

The owner prioritized this family before live replay. Measured on `5b8dd86a`
plus the explicitly uncommitted worker fixes (no live daemon):

- The exact Search → verified Batch → Workspace journey failed, exit 1,
  `/private/tmp/p3-workspace-head-reviewer-recheck.log`. Its actual diagnostic was
  `work_source_selection_invalid`, not external-write attestation/consent.
- A temporary diagnostic, removed before commit, measured accepted
  `asOf=2026-09-05T06:11:07.300Z`, first post dates September 1 and 3, and a valid
  desktop view. The existing calendar contract rejects past publication dates;
  that validator is byte-identical in candidate `64c3bfa5`. This is stale fixture
  content, not evidence that P3 mistyped a local create as external. The reviewer
  independently corrected the regression attribution in §12 23:15.
- Fixture content now uses one reference day inherited by cold-process fixtures:
  recent publications stay recent, stale negatives stay stale, and campaign dates
  retain the original 1/3/8/10/15-day offsets. Runtime clocks, leases, consent and
  payload validation are unchanged. Exact Search → Batch → create is GREEN 1/1,
  real exit 0, `/private/tmp/p3-workspace-relative-dates-first.log`.
- Full family then measured 12/15, exit 1. Two remaining assertions incorrectly
  froze the initial empty planning-card projection. They now assert the immutable
  accepted call-authority digest/root, retain all exact writes/receipts/zero-replay
  checks, and pass both real-process recoveries: 2/2, exit 0,
  `/private/tmp/p3-workspace-recovery-authority-green.log`.
- One real cleanup issue remains assigned: completed async cold recovery leaves
  `runInFlightSince()` non-null although its private recovery state is gone and
  its Workspace committed exactly once. No full-family green claim yet.
- The cited new unit failure already passes on current bytes: all five tests in
  `plan-tools-completeness.red.test.ts`, exit 0,
  `/private/tmp/p3-plan-head-reviewer-recheck.log`. `cf50388e` changed that producer
  and fixture after the review's tested `72565801`; no second speculative fix.

The four new journey failures are reproduced separately, real exit 1
(`/private/tmp/p3-four-journeys-current.log`). Two still require the removed
hidden-until-plan worker surface; one maps Home `transferred` to error; one calls
created-resource target lineage `dataFrom` despite literal, user-supplied content.
They remain assigned; neither the stale-unit attribution nor the Workspace
correction waives those failures.

Reviewer heavy-gate measurements on `64c3bfa5` are baseline evidence, not results
on final P3 bytes. Preserve their exact counts and exits in direction §12. Re-emit
implementation artifacts once the implementation settles and run verification
without a pipe. Re-read §12 before each themed batch and at the phase boundary.
Do not start P4 or push/tag without the owner's separate approval.
