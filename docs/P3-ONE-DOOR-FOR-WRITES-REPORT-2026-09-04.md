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

`5b8dd86a` adds bounded automatic re-entry for `local_work_incomplete` in the
existing loop: only missing accepted items, no new permission, no replay of
successful siblings. Unchanged missing work stops with its typed next edge rather
than spinning. The actual-child follow-up below also pins checkpoint continuity.

### Worker-child connection and failed-receipt follow-up

Reviewer §12 23:40 A–C are now covered by real host-child fixtures, not replaced
tool bodies. The coordinator records each packet's exact parent source/logical
call and item scope, then uses the existing host runner in an ordinary child
session namespace. Each child acquires its own exact tool attestation through the
same pre-dispatch door; it cannot modify the parent's call root. Existing dispatch
leases follow only the verified owning parent call, carry cancellation, and reject
another live lease in that same parent session. Compose-only children cannot
dispatch external writes/admin or mint approval cards.

Typed `worker_result` receipts retain exact parent logical call plus accepted
source. A failed batch settles failure, not a successful prose summary or poisoned
parent root. Only an exactly bound, returned, nonbusiness local coordinator failure
can project its failure bytes through the existing checkpoint boundary: zero
provider/nonreturned crossings, one returned host crossing, no reconciliation,
local-envelope/local-write binding and same-call/source failed receipts. No
successful handle or replay permission results. Unknown business-local/external/
admin writes and unrelated receipts remain held.

The real 7/8 → 8/8 repair exposed a second connection gap: partial completion text
had changed canonical history without a settled checkpoint. Continuing now retains
the full partial reply in the existing guardrail event/directive and leaves the
canonical response chain at its settled checkpoint. Only missing `audit-8` retries;
successful siblings do not. **That retry fixture explicitly authorizes the retry;
it is not the byte-identical live canary, which forbids a second worker batch.**

Measured local evidence (overlapping counts, all real exit 0): actual worker/
checkpoint/host-completion cohort 281/281
(`/private/tmp/p3-worker-recovery-final-regression.log`), manifests 32/32,
source-backed obligations 5/5, routing 73/73
(`/private/tmp/p3-worker-route-fixtures-green3.log`), lease/basic 13/13,
independent final authority review 16/16
(`/private/tmp/p3-final-worker-authority-review.log`), and typecheck.
Uniform 0/8 failure, full 8/8 success and failed-item-only recovery are all pinned.
Live replay remains a separate acceptance requirement; these are offline models.

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

## Identical cold worker replay — dispatch GREEN; premium overlap not proven

- Frozen SHA `1931743f2fdf8e9f542a0a096110af078114098a`, clean source
  `/private/tmp/clem-p3-worker-replay-source.S51n5j`, fingerprint
  `c110b3a465963f51e154c2dce20b33782583194419e8616d8c0eb906c1d7def2`.
- Evidence `/private/tmp/clem-p3-worker-replay-live.HK5tfj/evidence`;
  session `sess-desktop-a6a8d5e987b032a07d8c65ef`.
- Exact original prompt/packet byte equality both true; prompt hash
  `118fbc087c24ff362e93a54ed301bc87e10c9044b4410b5db6c1007b0dba7023`, packet hash
  `e93ad673509adc166814a505c631d4c20caa34127757f3b8cd8c00839537b382`.
- 06:34:29.364 → 06:35:28.160 UTC, **58.8 seconds**. One worker batch, 8 starts,
  8 successful exact nonce receipts, eight distinct child host sessions with real
  successful `read_file` settlements, all eight exact lines in the user result,
  terminal `done`. Workers genuinely overlapped; all eight effective routes Codex
  Terra. Zero business mutations, external-write events or approval rows across
  parent AND children; one nonbusiness local coordinator bookkeeping settlement.
- Actual watcher wire: Claude Sonnet 5, `claude_code_headless`, provider session
  `100b6000-834c-461f-9b91-7c072a3af122`, 06:34:59.852–06:35:04.321 UTC,
  4.469 seconds, healthy cross-family metrics (`selfJudge:false`).
- **Final completion judge also reached Claude's wire**, provider session
  `e35d5209-e2a6-422e-9bbb-9222d68d124e`, 06:35:25.315–06:35:28.105 UTC,
  2.790 seconds, actual model Sonnet 5, verdict done, `selfJudge:false`.
- Driver exit 0. Stronger collector remains **exit 4 solely because the watcher
  did not overlap workers**: it finished before first worker at 06:35:07.455.
  This proves reviewer §12 23:40's expected 8/8 + done + Claude wire, NOT the
  premium claim that a judge audited the children while they worked. §15 broader
  subagent auditing remains separate scope, not silently shipped or waived.
- Collector correction is explicit: `nonreturned_crossing_count` is a derived
  count over physical dispatches, not a settlement-table column. The first
  instrument therefore wrongly counted the coordinator's local bookkeeping as a
  business mutation. Corrected SQL preserves the zero-unknown/nonreturned check;
  initial and corrected collector logs remain retained. No runtime was changed.
- Daemon PID 26781/64244 stopped normally, actual exit 0, before SQLite collection.
  Both subscription families were available; isolated Claude access expired at
  07:11:59 UTC, after this run. Main dev stayed down.

Reviewer 23:35's two intermediate count failures were on `9b1b9e20` (before
worker commit `8b9cbc07`); that old fixture line 166 asserts two model calls
unconditionally. The fixed line 235 belongs to the newer worker fixture. Final
local 281/281 evidence and this live replay use the newer bytes, not that
intermediate checkout. Final release gates are still owed on final bytes.

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

### Same draft canary on `1931743f` — RED, no write occurred

Resume used the unchanged task/contract/model and the previously accepted mailbox
answer through the supported Inbox route. Evidence is
`/private/tmp/clem-p3-draft-canary-evidence.GhAH2o` (including the stopped database
snapshot); accepted source 442, session
`background:bg-graph-driver-tag-canary-20260904`. The task resumed at
06:38:54 UTC and its terminal committed at 06:43:55.664 UTC. It is
`blocked / control_no_progress_exhausted / repeated_refused_frame`, resumable true.
**Zero distinct drafts, zero write-success events, zero approval requests and zero
send crossings. P3 acceptance remains RED.** Driver and collector exit 0 mean
evidence captured, never business success. PID 35464/64245 stopped normally, exit 0,
before database collection. Main dev remains down.

The repaired measurement instrument records 18 prompt compositions and 18 accepted
model batches (overlapping, never summed), 26 emitted calls, five visible tool
invocations, 14 settlements and 20 guardrail events. Account-answer repair is live
confirmed: the first search resolves the already-selected mailbox, there is no
repeated account question; total searches two, versus eleven on P2. The second
search was an unsuccessful attempt to find a plan-reset tool, not account recovery.

Measured causal chain from canonical model-facing results:

1. Discovery supplies the exact draft operation, account, provider schema, and
   carrier example. `plan_task` accepts five distinct draft operations, each over
   the same five company-name universe members: 25 planned instances for the
   user's five-draft objective.
2. First draft frame selects `/to_recipients/0` (an email) while its universe item
   is a company name. Actual refusal: `work_cardinality_mismatch`, selected
   argument members do not match the accepted universe instance. The alternative
   `/arguments/to_recipients/0` does not resolve in normalized arguments.
3. Correctly shaped singleton envelopes without the selector then hit
   `bound_catalog_call_does_not_match_exact_schema_and_arguments` despite a durable
   matching operation/account/schema binding. That exact comparison still needs a
   P3 reproduction; the narrower mechanism is NOT inferred from code alone.
   `policy_denial / work_binding:sibling_frame_replanned_before_dispatch` is the
   nominal settlement cleanup label, not the diagnostic the model received.
4. Two later malformed carriers receive `effective_inner_name_missing`, whose
   guidance says to amend the plan. The attempted five-single-write amendment is
   itself refused before the plan body: `fresh_plan_already_activated`.
5. Repeated carrier variations exhaust the frame governor. No provider write was
   dispatched; no failed write is being retried blindly.

Scope boundary is explicit: the exact bound-call comparison is approved P3 D3
work and is being reproduced first. Retiring the frozen model-created census or
globally reopening its topology is the document's P5 ceremony, not silently
authorized by P3. Repairing call matching alone does not prove the already-frozen
25-instance plan becomes the requested five-draft task. If that remains necessary,
report this phase conflict for owner/reviewer arbitration before expanding scope.

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
- The remaining real cleanup issue was the crashed attempt's running-marker
  ownership, not execution: a finished/interrupted attempt still owned the marker
  after its same-source successor completed. The existing producer now transfers
  that marker only from an interrupted owner to the active same-source attempt;
  mere supersession, a stale attempt, or an older source cannot take it. Terminal
  CAS is unchanged. Actual cold-crash RED and producer RED are retained in
  `/private/tmp/p3-workspace-cleanup-red.log` and
  `/private/tmp/p3-recovery-owner-red.log` (both exit 1). Recovery regressions
  pass 117/117, exit 0 (`/private/tmp/p3-recovery-owner-regression.log`).
- **Full Workspace family: 15/15, real exit 0** on `fc6488ed` plus the explicit
  recovery fix and uncommitted worker/bridge candidate, no live daemon:
  `/private/tmp/p3-workspace-complete-family-final.log`. This includes the exact
  Search → verified Batch → visible Workspace and the three-PID hard-crash,
  GET-only resume, then zero-replay journey. No runner crash reproduced.
- The cited new unit failure already passes on current bytes: all five tests in
  `plan-tools-completeness.red.test.ts`, exit 0,
  `/private/tmp/p3-plan-head-reviewer-recheck.log`. `cf50388e` changed that producer
  and fixture after the review's tested `72565801`; no second speculative fix.

The four new journey failures were reproduced separately, real exit 1
(`/private/tmp/p3-four-journeys-current.log`), and are now green:

- `18ac00d4`: Home `transferred` is successful request delivery, not `error`;
  durable task truth stays `transferred`, not `done`. Full bridge/parity cohort
  93/93, exit 0 (`/private/tmp/p3-transferred-bridge-regression.log`).
- `9b1b9e20`: the two obsolete hidden-until-plan worker assertions now follow the
  approved plan-optional surface. A schema-valid call with invented accepted
  source is refused by the real wrapper; listing tools causes zero worker/provider
  I/O. Original natural Discord business/receipt/replay assertions are retained.
  Both full files pass 12/12, exit 0
  (`/private/tmp/p3-plan-optional-surface-full.log`); exact authority pin 2/2.
- `9b1b9e20`: literal user-supplied header content has `dataFrom: []`, while
  `dependsOn` still binds the verified created destination. All four derived-write
  tests pass, exit 0 (`/private/tmp/p3-derived-contract-green.log`), including
  wrong-target zero update, exact four provider phases and zero-crossing replay.
  No runtime provenance or destination validation was weakened.
- Final cited unit recheck: 5/5, exit 0
  (`/private/tmp/p3-plan-final-release-recheck.log`).

Separate newly measured debt, not silently waived: an SDK-malformed `run_worker`
packet (`items` without required fields) returns the historical generic worker
error envelope but its parent settlement can say `succeeded` with zero children.
Actual RED: `/private/tmp/p3-worker-surface-journey-first.log`, exit 1. This is
distinct from the schema-valid authority/live replay and is not fixed by updating
surface tests. Retain for the release-debt decision; do not claim malformed-packet
settlement truth is proven.

Reviewer heavy-gate measurements on `64c3bfa5` are baseline evidence, not results
on final P3 bytes. Preserve their exact counts and exits in direction §12. Re-emit
implementation artifacts once the implementation settles and run verification
without a pipe. Re-read §12 before each themed batch and at the phase boundary.
Do not start P4 or push/tag without the owner's separate approval.
