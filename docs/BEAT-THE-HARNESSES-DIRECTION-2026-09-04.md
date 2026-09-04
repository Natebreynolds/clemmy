# Beating DeepSeek Harness and Hermes: the direction, backed by our own data

Date: 2026-09-04
Status: direction document. The owner approved the P0 and P1 phase starts on
2026-09-04. Before P2, P3, P4, or P5, report the preceding phase's measured
evidence, name the exact next-phase scope and safety invariants, ask `Start Pn?`,
and wait for the owner's answer. Every tag and push still requires its own explicit
owner approval.
Provenance: every number below was **measured this session** — a 49-agent adversarial
audit (5.2M tokens, 1,886 tool calls) over the live daemon log, the event journal, the
dirty working tree, and git. 30 candidate claims were generated; **17 were refuted on
measurement and are not in this document.** Line numbers were verified 2026-09-04
against the working tree (host-turn-runner.ts at 9,088 lines) and **drift within
hours** — re-verify before editing.

Companion sources: [DEEPSEEK-HARNESS-RESEARCH-2026-08-22.md](./DEEPSEEK-HARNESS-RESEARCH-2026-08-22.md),
[HERMES-HARNESS-RESEARCH-2026-08-22.md](./HERMES-HARNESS-RESEARCH-2026-08-22.md),
[GRAPH-DRIVER-SUBTRACTION-BRIEF-2026-09-04.md](./GRAPH-DRIVER-SUBTRACTION-BRIEF-2026-09-04.md),
[NEXT-TAG-RELEASE-GATE.md](./NEXT-TAG-RELEASE-GATE.md).

**For the executing agent — read this first.** This document is self-contained: the
canary recipe (§10), suite hygiene (§10), and the verified-trap register (§11) are
included inline so you do not need any other session's memory. Execute the phases in
§5 in order. Two hard rules override everything you may infer along the way:
(1) the owner approves every `git push` and every tag — prepare both, then ask;
P0 and P1 may start now, while P2–P5 use the phase-start ritual above;
(2) do not diagnose by reading code — 17 of the 30 claims behind this doc's first
draft died on measurement, and four prior fixes on one seam were written against
code that was never even exercised. Run the real function on the real bytes, or
write the red journey, before you believe a mechanism.

---

## 0. What "beat them" means

From our own research docs, the bar is one sentence:

> **Simpler than both in the foreground, stronger than both at external effects, and
> genuinely durable for real-world projects.**

- **DeepSeek Harness** (`dsh-v0.1.1-rc.2`): one concrete loop in one package;
  `tools/pre-execute` returns allow | deny | ask **per call**; the append-only session
  log is the spine for resume/replay/UI; features attach at typed checkpoints. Its
  workflow seam is deliberately weak: no journaling, no restart resume, no durability.
- **Hermes** (`v2026.8.19`): one `AIAgent` owner; stall guards; byte-identical results
  become references; oversized results spill to files; a wall-clock budget asks the
  model to wrap up; multi-question clarification is first-class; lossy compaction with
  an addressable `session_search` recovery pointer.
- **bb**: thread + event log; **an ask pauses the same turn** and follow-ups queue;
  plan is optional; no graph compiler in front of chat.

None of the three can do what Clem's kernel already does (§3). All three do what
Clem's foreground currently cannot: **finish an ordinary write task**.

---

## 1. The scoreboard, honestly (measured 2026-09-04)

| Metric | Value | Source |
|---|---|---|
| READ tasks completed end-to-end today | **2/2 (100%)** | Platform 49; Sheets canary (3 real crossings 09:42–09:43, zero cards, zero denials) |
| WRITE tasks completed end-to-end today | **2/30 (6.7%)** | daemon log + event journal |
| External crossings, last 8 days | **11 across 3,152 started turns (0.35%)** | event journal |
| Tag canary today | **25 runs, 58 turns, 62 tool calls, 77 guardrail trips, 0 external mutations — ever** | daemon log |
| "Completed" reports that were false today | **6 of 10** (four made ZERO tool calls; one's own text read "Objective not met. Zero Outlook drafts exist." and settled `reason=success`) | gate functions executed on the real bytes |
| Real write crossings reported to the user as FAILURES today | **5 of 7** | event journal vs. delivered outcomes |
| Blocked terminals that were `resumable:false` | **85% (22 dead ends)** | daemon log |
| Blocked terminals that were a safety refusal or a downed tool | **0 of 26** | gate census |
| Iteration cycle | boot 12s + run 44s, but **13.8 min boot-to-boot (93% orchestration)**; a green 8s harness-level instrument already exists | measured |

Two conclusions that must drive everything else:

1. **"Clem owns a task, she works it end to end" is true for reads and false for
   writes.** That is the entire competitive gap. Not discovery, not memory, not
   scheduling, not the ledger.
2. **The scoreboard itself is broken in both directions** — false greens AND false
   reds — so no fix, good or bad, is currently measurable in one cycle. The
   instrument must be fixed before (or with) the first behavior fix.

---

## 2. Root cause, one sentence

> **Patch D removed the graph from the front door, but the back end still speaks only
> graph.**

Verified mechanism: `ResolvedCallAuthorityV1` requires `graphId/graphHash/nodeId`;
`claimPhysicalIo` keys its lease on a graph node; and the no-progress governor's only
operation-progress token JOINs `expected_work_call_bindings` — a table written solely
by `expected-work-admission.ts:3250`. A graph-neutral call is therefore invisible to
progress, authority, and identity at once. The day's single successful direct-mutation
nomination (13:58:27, `OUTLOOK_CREATE_DRAFT`) was followed by
`control_no_progress_exhausted` **128 ms later**.

Everything in §4 is a consequence of this plus five concentrated defects. It is not
"too many bugs"; it is one seam and a handful of one-line-to-one-file fixes.

---

## 3. What we already win at — protect these in every change

The audit verified these against the working tree; the four core files are **clean**
(untouched by the current wave):

| Asset | Where | Why neither reference has it |
|---|---|---|
| Physical-crossing CAS | `physical-io-claim.ts` | one lease per external crossing; a crash cannot double-fire a write |
| Never-blind retry | settlement disposition | an uncertain write becomes reconcile-only; DeepSeek/Hermes re-run and hope |
| Resolved call authority | `resolved-call-authority.ts` | live schema/account/effect re-observed and bound to one accepted call — registry entry ≠ authority |
| Redeemable result handles | `logical-call-settlement-store.ts` | digest-bound raw results survive restart; compaction can never become authority |
| One consent reducer | `interactive-consent-policy.ts` (454 lines) | this **already is** DeepSeek's `pre-execute` allow\|deny\|ask |
| In-place carrier repair | carrier-completion path | **80×/day** the host proves what the model meant and repairs the frame inline, zero round trips. bb and DeepSeek charge a model round trip for the same malformed call. This is our one loop behavior that is already *better* than both — and it is the template for §4. |
| Durable workflow engine | occurrence/node-attempt identity, checkpoints, resume | DeepSeek's own docs list its workflow seam as foreground-only, no resume |

Owner floor, unchanged: exact user grant for send/delete/admin/sealed bulk; no blind
replay of uncertain writes; "wrote, could not verify" over refusing a crossed write;
migrations immutable.

---

## 4. The five verified defect classes standing between us and the bar

All five were adversarially verified; each lists its measured cost and its class fix.
None adds a door, a flag, or a provider-named branch.

### D1. Completion authority is prose, not the ledger — THE ONE THING, fix first

Completion is graded by English regexes over the prompt and a keyword scan of the
model's reply (`matchesBlockedText`, `taskRequiresExternalSendReceipt`,
`completionLacksDeliverableEvidence` — all executed on the real bytes and all
returning false for a reply that literally says "Objective not met"). Meanwhile the
runtime already computes the truth and throws it away:
`assessBackgroundTaskRestartSafety` (`background-tasks.ts:4227-4237`) builds
`externalCallIds` — the settled external crossings — and discards it.

- Cost: 6/10 false greens and 5/7 false reds today. Five whole canary runs re-ran
  work that was already done; four false "completed"s ended runs that did nothing.
- Fix: the durable effect ledger becomes the completion authority, unconditionally.
  A task whose objective implies an external effect is `done` iff
  `external_write_succeeded` exists for the run; with zero ambiguous writes, no prose
  heuristic and no failed readback may downgrade below "done with an unverified
  readback." Delete the prose gates this replaces. **Pure subtraction; the field is
  already computed.**
- Proof: ship alone in one commit, re-run the same cold canary unchanged. Expected
  flip: tag canary reports **blocked** instead of completed; the sheet-v7/v13/v25/v27
  class reports **done**. That before/after is the proof the instrument works.

### D2. The governor denies the retries the design promises, then burns turns that cannot succeed

Four verified mechanisms, in the order they kill a run (net effect measured on the
canary: **4 model steps per run, 3 of them structurally unable to produce work**):

1. `no-progress-governor.ts:700` sets `retriesRemaining: 0` on the **first** typed
   consequence instead of decrementing — the declared 3-retry budget is dead code for
   exactly the class it exists to survive. 39 zeroings today, 19 turns terminalized.
2. `:658` terminalizes on any repeated consequence key; the key has **no attempt
   counter and no repair discriminator**, so two *different* schema errors collide.
   Bare `schema_invalid` was today's #1 killer (7 of 26). A pre-dispatch refusal that
   names a repair is not "no progress" — increment only when a turn produced neither
   a dispatch nor a NEW typed refusal.
3. `host-turn-runner.ts:7382-7394` hands the one permitted retry a tool surface
   containing **only the tool just refused** — a closed loop by construction (18 of
   20 terminalize decisions today were on this class). Fix: for host-side refusals,
   union the turn's proven discovery/read controls back into the recovery surface.
4. The "last word" step advertises an **empty** tool surface (`modelStepSchemas = []`
   at `:7412`) while instructing the model to name the call it can no longer make,
   and every exit returns `blocked, resumable:false`. 20 occurrences, 0 completions
   today. Fix: compose the terminal from `retainedWorkSummary()` (already called
   inside `blockedOutcome`) and delete the extra model round trip — or hand the step
   the proven surface (`turnProvenEntries` + `directMutationNominations` already hold
   exactly this).

Also in this class: the host performs **105 successful repairs a day** (80 carrier
completions, 24 JIT provisions, 1 nomination) and none appends a progress event — the
host does the work, then terminates itself for not making progress. Host repair must
be a first-class progress token, and the model must be *told* about an in-place
carrier repair (one bounded line on the existing per-callId diagnostics channel) so
its frames converge instead of re-emitting the same shape all turn.

### D3. The write path refuses what it has already proven

- 12 of 18 pre-dispatch write refusals today said "use one of those exactly" and
  **listed the very operation just refused** — the model then retried both spellings
  (`cap:resolved:<op>` and `<OP>`) and died. Fix: extend the landed 09-01 READ BAR
  subtraction to writes on the write's own terms — `resolveProvenLiveReadCatalogEntry`
  → `resolveProvenLiveCatalogEntry` with `effect === decision.effect`, keeping every
  write-boundary proof (manifest, account, consent class).
- The nominated exact mutation must **consent and dispatch in the same step** (the
  brief's Patch D): run the existing reducer; `proceed` → the existing
  `host_owned_external` port; ordinary reversible draft crosses with zero cards.
  PROCEED is already same-step on the prepared path (`:8607-8610` → execute at
  `:8771`) — the graph-neutral lane just never got the behavior because it is a
  separate implementation (see D5).
- `plan_task` validation is sequential early-returns: the SDK zod boundary cannot run
  with the body, so a draft with three problems costs up to 4 round trips (7 of 20
  handbacks today began at the schema layer). Fix: permissive SDK schema, strict
  `safeParse` as the first body gate, **one refusal carrying all issues**, and give
  `plan_not_admitted` the repairKey digest over the full issue set (the schema layer
  already does exactly this at `plan-tools.ts:1831-1832`) so convergence reads as
  progress, not as a repeated failure.

### D4. An ask exits the turn (bb's property is the one we're missing)

Consent `proceed` matches DeepSeek. Consent `ask` does not match bb: the runner
returns `hasInterruptions` (`:8751`), the turn ends as `awaiting_approval`
(`loop.ts:10821`), and resume re-enters `runHostTurn` cold — re-refreshing tools,
re-minting authority, re-running consent. **2–3 turns per ask vs. bb's zero.**
Fix without a new primitive: make the ask a barrier *inside* the existing step —
`pendingBatch` is already ordered and already distinguishes `approved` from
undecided, and `mapHostCallAttemptsWithBarriersInOrder` (`:1507`) already serializes
a barrier against parallel siblings. Sibling calls before the barrier proceed;
the frame resumes where it paused.

Related, same family: the refusal unit is the whole model frame — one bad call
discards every legal sibling and a full paid round trip. `mayIsolateMalformedRead`
already proves the per-call isolation pattern; widen its predicate instead of adding
a lane.

### D5. The subtraction is being implemented as accumulation

- The branch named `one-gate-and-hardcode-subtraction` is **+7,550 production lines
  across 79 files** (+8,735/−1,185; ~7.4 added per line removed), plus +6,090 test
  lines. 09-03 was 25 `fix` commits vs 2 `subtract`.
- The duplication today's brief forbids has already happened: **six** builders of
  `CapabilityRiskAttestationV1` feed **one** reducer, and
  `evaluateGraphNeutralHostMutationConsent` (435 lines) re-implements
  `evaluatePreparedHostWorkCallConsent` (227 lines) instead of calling it — which is
  precisely why same-step dispatch exists on one path and not the other (D3).
  Fix: collapse to ONE attestation+coverage builder parameterized by
  (contractId, requirementId, cardinality).
- Account selection is still a planner special case, not a write class: **525 lines**
  of account machinery in one file vs. an 11-line `classifyExternalWrite` whose
  `ExternalWriteShape` has **no account field**; the repair string at
  `plan-tools.ts:1406` mandates 3 extra turns verbatim (fired 3× today). Fix: give
  `ExternalWriteShape` an account dimension; the ONE existing ask path at the write
  boundary raises it, with the work already in hand.
- `scratchpad/workflow-plan-task-subtraction.patch` (−352/+34, "a workflow is just
  another plan task") is still ~90% applicable. Its orchestrator hunks are the
  byte-exact reverse of `78c77f4d` — re-derive them rather than dropping one hunk
  (dropping only `@@ -3419` silently reverts that commit). Value is coupling removal,
  not turn recovery: the machinery it deletes fired **zero** times today.
- One-token latent false-green: `host-turn-runner.ts:7016` routes a **blocked**
  named-workflow dispatch through `completedOutcome`. Delete
  `|| uniqueDispatch.status === 'blocked'`.

---

## 5. The plan, in order

Phases are sequential because each one makes the next **measurable**. Do not
re-order; do not batch phases into one mega-change (no architecture churn).

### P0 — Unblock the pipeline and protect the work (hours, mechanical, zero risk)

The release has been CI-blocked for 28 days, independent of any code quality question:
`.github/workflows/release-desktop.yml:104-109` exits 1 unless `tag_sha ==
origin/main`'s SHA, and origin/main sits at `18c5bcc7` = **v3.14.0 (2026-08-07)**.
v3.15.0 was tagged locally and never pushed. HEAD is on no remote branch. Re-measure
the distance at closure with `git rev-list --count origin/main..HEAD` and
`git rev-list --count main..HEAD`; do not carry a stale commit count into evidence.

1a. Commit this direction document and its two companion 2026-09-04 plan/audit
    documents first, so the execution contract is durable before source cleanup.
1b. Commit the three **untracked production files** (661 lines, 11 tracked importers,
   one `git clean` from deletion): `current-task-authority.ts`,
   `external-write-event-projection.ts`, `production-composio-preparation.ts`.
   Keep eventlog migrations 76+77 with their projection in ONE commit (77 exists
   solely to correct 76 — migrations are immutable).
2. Re-measure the complete dirty tree with
   `git status --porcelain=v1 --untracked-files=all`; stage it into reviewed commits,
   drop the attempts documented as inert, and re-emit implementation artifacts once
   after the source tree settles. Never reconcile against the obsolete 163-path census.
3. Prepare the fast-forward wave → main integration. After separate owner approval,
   push the intended branch/main ref and then the one intended v3.16 ref only. Never
   use `git push --tags`: the unpublished stale v3.15 tag is not part of this release.
4. Tag **v3.16.0** with the graph-driver subtraction *named as honestly deferred*
   (the tag procedure explicitly permits deferred capabilities). The end-to-end
   mutating canary becomes the **v3.17.0** gate, where it gates work actually in
   scope. Demote the NEXT-TAG competitive-claim and provider-neutral matrices to a
   north-star conformance roadmap:
   a gate defined as "the architecture is finished" cannot pass while the
   architecture is being rewritten — and its own matrix journey is green in 14 s
   while containing **zero occurrences of `external_write`**.

### P1 — Ship the truth (one commit, then re-run the same canary)

D1's ledger completion authority, alone. Before/after on the unchanged cold canary is
the acceptance proof. Nothing else lands until this flips the two known-wrong verdict
classes. From here on, every fix is measurable in one cycle — and completion trust
becomes **model-independent**: prose grading varies by brain family, the effect
ledger is the same bytes for every brain (see §9.2).

### P2 — Free the turn (the four D2 fixes)

One-token budget decrement; consequence-key discriminator; recovery-surface union;
last-word deletion (or proven-surface handoff); host-repair-as-progress token; the
carrier-repair disclosure line. Acceptance: a canary death now costs ≤1 wasted model
step, terminals are `resumable:true` with a real next edge (NO DEAD ENDS), and the
same run's typed stop names the state it stopped ON, not the last failed row in
history.

### P3 — One door for writes (D3 + D5 collapse)

Same-step consent+dispatch for the nominated exact mutation through the existing
reducer and `host_owned_external` port; write-bar extension of the proven-catalog
subtraction; ONE attestation builder; plan_task single-pass validation. Acceptance:
**the tag canary completes end-to-end with real mutating writes on a frozen tree** —
Salesforce read crosses, rehearsal is consent-free, ordinary reversible drafts cross
with zero approval cards, genuine send/delete/admin still `needs_user`, and the
terminal is `done` only because the ledger says the drafts exist.

### P4 — The same-turn ask (D4)

Barrier-in-step via `pendingBatch`; per-call refusal isolation widened. Acceptance:
an ask costs zero extra model round trips beyond the ask itself; sibling calls
before the barrier settle in order. This is the last bb property we lack; with it,
the foreground loop is *simpler than both references* while keeping §3.

### P5 — Subtract the exam (D5 remainder)

Account-as-write-class; the re-derived workflow patch; retire the now-bypassed
plan-freeze ceremony for cardinality-once reversible writes (the file's own comment
already states the principle: "the standing gate is validate-before-write, not
envelope shape"). Only after P3 proves the one-door path — deleting the exam before
the door works would strand the canary with neither.

---

## 6. Fix the instrument, or every phase costs 100× (do this alongside P1)

Measured: the live cycle is **13.8 minutes per hypothesis, 93% orchestration**, and a
green 8-second harness-level instrument already exists. Today's canary was also **not
a controlled experiment**: the daemon runs `tsx` off the working tree; six of seven
core gate files were edited mid-canary; the same reason+detail pair logged from four
different line numbers; two of the eight observed death reasons exist nowhere in src,
dist, or git history. Eight distinct deaths were eight different programs.

Rules, standing:

1. **Freeze the tree for any canary series**; stamp `git rev-parse HEAD` into every
   blocked-terminal log line (`blockedOutcome` already builds the structured payload).
2. Every live canary death becomes a **red journey** that runs in seconds and carries
   the exact precondition (e.g. today's: operation absent from the frozen snapshot,
   present via mid-turn JIT, nomination registered, effect `external_write` — assert
   it DISPATCHES). Add the first journey in the tree that asserts
   `external_write_succeeded`; today there are none.
3. The live canary **confirms**; it no longer discovers. Canary homes copy the full
   recipe (vault, authority payloads, claude-auth, skills, `SLACK_ENABLED=false`) and
   override nothing else — see the 09-04 canary memory for the recipe and why.

---

## 7. What NOT to do (binding, consolidated from the briefs + owner rules)

- No new doors, flags, authority tokens, or nested-admission primitives. One consent
  reducer, one dispatch ledger, one attestation builder.
- No provider-named production branches (no Outlook/Sheets/Salesforce/Slack code).
- No prompt-level fixes for code-level defects; validated behavior is the default.
- Do not weaken §3: the CAS, never-blind retry, resolved authority, result handles,
  the irreversible-send floor, and authored-workflow `requiresApproval` survive every
  subtraction. When collapsing the graph entrance, give a graph-neutral crossing the
  lease shape `claimWorkflowPhysicalIo` already established (accepted source +
  logical call id) — never a fake graph node.
- Do not grow `graph-neutral` into a second compiler; it is a bypass being retired,
  not a product.
- Do not treat each typed reason as a bug. 26 gates stand between an authorized
  request and one reversible draft and **zero of them is the safety floor**
  (`autonomous-send-consent.ts:242` requires `irreversible` and structurally cannot
  fire for a draft). Fixing reasons one at a time is how 30+ runs produced eight
  death names and zero drafts.
- Do not diagnose by reading. 17 of 30 audit claims died on measurement; four prior
  fixes to one refusal were written against code that was never exercised. Run the
  real function on the real bytes first.

---

## 8. Definition of done: the "better than both" test

Unchanged from the research docs, now with the honest baseline attached. One
provider-neutral scenario from a truly blank home, no seeded manifests, must show:

1. cold understanding of an unfamiliar objective → **works today** (blank-state runs
   ask exactly the right questions);
2. ordinary conversation stays in one fast loop;
3. independent reads fan out with ordered results;
4. Clem proposes — never silently creates — a durable project;
5. one authorized pilot **write crosses a live capability exactly once** →
   **0.35% today; this is the whole fight (P1–P3)**;
6. crash after settlement reuses the durable result → kernel already proves this;
7. honest partial coverage, no universal claims from one page;
8. canonical records with provenance; Space projection without execution authority;
9. recurrence only from pilot evidence + separate consent, surviving restart;
10. one accepted source, one owner, one call ledger, **one terminal truth** on every
    surface → D1 is the gap.

Numeric targets to track per phase (baseline → bar):

| Number | Today | Bar |
|---|---|---|
| WRITE end-to-end completion (cold canary) | 6.7% | ≥ 90% |
| False `completed` / false `failed` verdicts | 6/10 · 5/7 | 0 · 0 |
| Wasted model steps per failing run | 3 of 4 | ≤ 1 |
| Dead ends (`resumable:false` without a next edge) | 85% | 0 (NO DEAD ENDS) |
| Turns per ask | 2–3 | 0 extra |
| Hypothesis cycle | 13.8 min | ≤ 30 s (red journey) |
| Safety floor regressions (send/delete/admin/bulk asks; blind replays) | 0 | 0, forever |

When rows 1–6 are green on a frozen tree and row 7 stays zero, Clem is simpler than
DeepSeek and Hermes in the foreground, stronger at effects, and durable in ways
neither ships. That is the win condition — and per §1, we are two phases of
subtraction away from being able to *see* it, and five from having it.

---

## 9. Trust across every model (brain + judge matrix)

"A harness we can trust" means: the same task, the same safety floor, and the same
honest verdict **regardless of which brain is driving**. A budget brain (GLM-class)
may need more steps; it must never get a different truth. Everything here is
verified — either live this session or recorded with commit pins.

### 9.1 The architecture that makes cheap brains trustworthy

The owner's target — a cheap efficient brain steered by a high-quality cross-family
judge — is expressible **today** and was verified working 2026-09-04:

```
MODEL_ROUTING_MODE=off
AUTH_MODE=api_key
OPENAI_MODEL_PRIMARY=glm-5.3
CLEMMY_MODEL_ROLES=[{"role":"judge","modelId":"claude-opus-5","scope":"durable","source":"settings"}]
  -> brain=glm-5.3/byo   judge=claude-opus-5/claude   CROSS=true
```

Three non-obvious constraints (all verified; violating any one silently degrades the
judge and therefore the completion gate):

1. **The brain cannot be set by a role pin.** It comes from the primary slot
   (`OPENAI_MODEL_PRIMARY` / `BYO_BRAIN_MODEL_ID`); a brain role pin is parsed and
   rejected.
2. **`MODEL_ROUTING_MODE=all_in` makes cross-family judging structurally
   impossible.** `RouterModelProvider.resolvePrimary` routes every model to the BYO
   backend, so brain and judge both report `provider: 'byo'` and
   `selfJudge` is always true — a judge pinned to a Claude id would be *sent to the
   BYO endpoint*. **Production `.env` is `all_in` today, so production currently has
   no cross-family judge.** This must change before any "trusted across models" tag.
3. **The judge candidate list is built from CONNECTED families.** Without
   `state/claude-auth.json` present in the home, no Claude judge is offered and the
   pin is rejected. Verify `claudeAvailable()` before trusting any judge verdict —
   an entire night of canary results was invalidated by this once.

Why it matters for trust: a **self-family** judge gets exactly ONE hard bounce and
then goes advisory (`loop.ts:8055` — deliberate; two hard self-bounces once drove
unapproved sends). A **cross-family** judge gets the full corrective budget
(`MAX_OBJECTIVE_JUDGE_CONTINUATIONS`, default 2) and *steers*: its reason is injected
into the brain's next input with the immutable objective. The fragment-as-success
incident (a turn shipping "Abstracting Salesforce data..." as `reason=success`) was
the self-judge downgrade firing — a config artifact, not a model failure. Knobs:
`CLEMMY_JUDGE_CROSS_FAMILY` (default on), `CLEMMY_DEBATE_CHECKER_MODEL`,
`CLEMMY_BOUNDARY_JUDGE_CLAUDE_MODEL`, `CLEMMY_OBJECTIVE_JUDGE_MAX_CONTINUATIONS`.

### 9.2 Why the phases in §5 are the cross-model plan

- **P1 (ledger completion) is the single biggest cross-model win.** Prose grading is
  brain-dependent by construction — different families phrase success differently,
  so the same outcome gets different verdicts. The effect ledger is the same bytes
  for every brain. One change converts "trust varies by model" into "trust is
  model-independent."
- **P2/P3 remove the taxes that hit budget brains hardest.** Slug-shaped
  vocabularies, sequential one-complaint-per-turn validation, and coarse
  `schema_invalid` keys are paid in *retries* — and retries are exactly what the
  governor currently denies (D2). A flagship brain sometimes guesses the slug on
  attempt one; a budget brain never gets attempt three. Fixing D2+D3 flattens the
  family difference instead of hardcoding around it.
- **The host-repair pattern (§3) is the "simple enough for GLM" mechanism.** When
  the host can prove what a shape-wrong carrier meant, it completes it — 80×/day —
  instead of refusing. Binding owner rule: a pseudo-flagship brain must be able to
  run tasks and existing workflows; the host completes from its own proof, never
  refuses what it already knows.

### 9.3 Known per-family traps (verified, with pins)

- **GLM emits the string `"null"` for omitted args.** Fixed once, centrally, at
  `materializeStrictNullableFields` (`e74598a0`). Any new strict schema must go
  through that materializer — never add a per-callsite guard.
- **Never let a gate's pass/fail depend on brain family** (`901e0c58` lesson: a
  business-evidence gate was accidentally brain-dependent). Gates read the ledger
  and the manifest, not the model's phrasing.
- **Claude-subscription brains share the owner's quota.** Big subagent fan-outs
  during a live test starve the daemon. Keep gate-qualifying canaries free of
  parallel Claude workloads.

### 9.4 Cross-model acceptance (add to §8's table)

| Number | Today | Bar |
|---|---|---|
| Brain families passing the SAME cold canary (frozen tree, cross-family judge live) | 0 verified (Sonnet attempted, not passing; GLM config verified but chain not passing) | **≥ 2** (one flagship + one budget, e.g. Sonnet and GLM 5.3) |
| Verdict parity: same run outcome ⇒ same completion verdict across families | unmeasurable (prose grading) | 100% after P1 |
| Judge is cross-family in the shipping default config | no (`all_in`) | yes, or the tag's release notes say exactly why not |

---

## 10. Operator appendix (self-contained — no other session's memory required)

### 10.1 Isolated canary home: the exact recipe

Copy into the fresh `CLEMENTINE_HOME`:

```
.env
state/secrets-vault.json            # THE SEAL — without it every reviewed CLI read fails
state/authority-payloads/
state/claude-auth.json              # without it: no Claude judge family (see §9.1.3)
state/keychain-migrated.json
state/composio-account-identities.json
state/connected-clis.json
state/reviewed-cli-read-descriptors.json
state/capability-live-identity.json
skills/                             # forgotten once; the run reported a missing skill
```

Override ONLY channel/port switches:

```
WEBHOOK_PORT=<spare>
DISCORD_ENABLED=false
SLACK_ENABLED=false                 # Socket Mode round-robins; a test daemon will
                                    # steal ~half the owner's real Slack traffic
CLEMENTINE_MOBILE_APP_LISTENER=off  # 8421 is a fixed port; two daemons collide
LOCAL_MCP_ENABLED=false
```

**Never override `MODEL_ROUTING_MODE` or `AUTH_MODE` in a canary home** — that
silently changes the judge family, which changes the completion gate, which changes
the outcome you are trying to measure.

Start with `node --import tsx src/index.ts daemon --foreground`.
**Never** `scripts/dev-up.sh` (it quits other daemons). **Never** `pkill` the live
daemon to free a port.

### 10.2 Suite + measurement hygiene

- `pkill -9 -f cutover-hold-entry` **before any full suite** — a failed run leaks a
  daemon per attempt, and the leaks make unrelated code look deterministically broken.
- Never `npm test | tail` or `| head` — the pipe returns the *pipe's* exit code and
  masks failures. This exact trap made a red artifact-verifier gate read as green
  during this audit.
- ~6 tests fail on wall-clock under suite+daemon load and pass in isolation; check
  isolation before believing a regression.
- Snapshot the event DB **with its `-wal`**, and delete each copy — 132 stale 1.1 GB
  copies once filled the disk and killed the daemon mid-run (`SQLITE_IOERR_SHMSIZE`).
- Even `sqlite3 -readonly` on the live DB trips the isolation sentinel; there is no
  `timeout` binary on macOS.
- Stop the daemon before any gate-qualifying suite run, or "full isolated suite
  passes" is unprovable on this machine.

### 10.3 The cold canary (the P1/P3 acceptance instrument)

- The canary is background task **`bg-graph-driver-tag-canary-20260904`** ("Graph
  driver tag canary") — the prospects/tag chain: Salesforce read → local rehearsal →
  Outlook drafts. It ran 25+ times on 2026-09-04 and has never crossed a mutation;
  that history is the baseline the P1 verdict-flip is measured against.
- Before shipping the P1 commit, record in the phase report: the exact objective
  text, the exact launch/resume command used, and `git rev-parse HEAD`. The before
  and after runs must be byte-identical in all three — otherwise the flip proves
  nothing.
- Run it on an isolated home per §10.1 with the tree frozen. A run counts only if
  the home copied `state/claude-auth.json` and `claudeAvailable()` is true (§9.1.3);
  a self-judged run measures a different completion gate.

---

## 11. Do-not-repeat register (each entry cost real hours; all verified)

1. **The carrier refusal at `call-tool.ts:908` ate FOUR failed fixes.** Each was
   written by reading code; instrumentation later showed the branch was sometimes
   never reached (contaminated home). Instrument the actual `target`, both set
   contents, and the flag state at the branch before editing a fifth time.
2. **A refusal payload that doesn't parse kills the turn silently.** `39214344`
   emitted a `recoveryTool` value outside the parser's admitted shape; the projection
   returned null and every affected run died `stop_factual` for hours. If you add or
   change a typed refusal, its parser must admit it — write the round-trip test.
3. **Read→work→write ALREADY EXISTS** (owner directive 2026-08-29, recorded at
   `plan-tools.ts` ~1298): an all-read plan is a legitimate gathering stage; the
   write is a separate accepted action. It has been "re-proposed" twice. Do not
   rebuild it.
4. **The 13:58 stale-refusal hypothesis is REFUTED.** The same catalog miss genuinely
   recurred while the recovery surface forbade any other call. Do not chase
   staleness on that seam.
5. **`provider carrier completed` ≠ settled.** 13/13 successful composio calls were
   once discarded as `execution_failed` because a string payload settles `unknown`.
   Still OPEN at last check — verify settlement on real bytes before trusting it.
6. **Green typecheck ≠ the field is read.** tsc is blind through a spread; check the
   read site, not the type.
7. **Line numbers in this document drift within hours** (host-turn-runner.ts grew
   9,012 → 9,088 during the audit itself). Re-grep for the named symbol; never edit
   at a remembered line number.

---

## 12. Reviewer log (append-only — executing agent: re-read at every phase boundary)

The reviewer session watches every commit and canary outcome against this doc.
Entries here are review feedback: act on them by committing a fix or by recording
your disagreement (with evidence) in your phase report. Do not edit or delete
entries; the reviewer appends, you respond in commits and reports.

**2026-09-04 ~16:00 — P0 staging review, commits `b5aaaaf0` → `4d9036a9`:**

- **All commits reviewed CLEAN.** Zero violations: no provider-named production
  branches, no new flags/doors, coherent themed batches, tests travel with their
  code. Provider names found only in test fixtures (allowed).
- `e82c240a`: migrations **76+77 landed together** with their projection —
  immutability rule honored. Consumers followed correctly in `911a6cf0`
  (brackets) and `fb71c914` (execution-tools + ledger write-truth batch).
- ⭐ **`34d9dd63` (honor explicit Claude routes in all-in) is on the §9 critical
  path and NEEDS LIVE VERIFICATION.** It deletes the all_in early-return behind
  §9.1 constraint 2. Before updating §9.1(2)/§9.4 row 3, the P1 canary report must
  prove the pinned judge reaches the **Claude wire** (provider label at the
  transport, not route metadata — the commit's own message records "route metadata
  said Claude while GLM was billed" as the failure mode). Include this check next
  to the §10.3 `claudeAvailable()` precondition.
- `a80f515f` → `87534a3d`: benign local rewrite (branch unpushed).
  **`src/runtime/harness/resolved-carrier-refusal.ts` was pulled back out of the
  batch and is dirty again** — make sure it lands in a themed commit and is not
  orphaned at P0 close.
- `ae6d3523` touches `call-tool.ts` on the four-failed-fixes seam but only the
  composio port-prep path, NOT the `:908` refusal branch — acceptable; the §11.1
  instrument-before-edit rule still stands for that branch.
- **Standing item for the owner:** the live daemon keeps auto-re-arming
  `bg-graph-driver-tag-canary-20260904` (~90 s died→restart loop) on the unfrozen
  tree — every run is non-evidentiary (§6) and spends real model quota. Consider
  pausing the task until P0 closes and the tree is frozen.
- **P0 remaining, being watched:** ~80 dirty entries; inert attempts must be
  DROPPED not committed; implementation artifacts re-emit
  (`--verify-current` must exit 0 — check the real exit code, never through a
  pipe); merge + v3.16.0 tag PREP (execution waits for owner approval).
