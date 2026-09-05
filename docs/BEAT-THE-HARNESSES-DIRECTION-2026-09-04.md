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

### 8.0 The owner's canonical ask (2026-09-04, his words, lightly compressed)

> "I need to find 100 market-leader accounts — here's the criteria. I'm not sure if
> you should search the web or look in Salesforce; figure that out. Compile them into
> a sheet with comprehensive data on why each is a market leader and a target. Be
> smart enough to work WITH me — ask questions along the way, within reason: 'here's
> what I found, here's what we should do next.' I want to be able to trust you with a
> task whenever needed."

Every phase maps onto a beat of this ask. Use it as the shape of the P3 acceptance
canary and every future demo:

| Beat | Mechanism | Status |
|---|---|---|
| "web or Salesforce — figure it out" | source-strategy choice: ONE natural question when the source materially changes provenance/quality/cost; the confirmed choice persists across answer/restart/model switch | shipped in the v3.16 wave (see release notes: "Confirm the material choice, then preserve it") |
| "100 accounts, here's the criteria" | count-only work grounds at the call — a count is a loop bound, not a census exam | landed `8a9703ef`+`73592a2f` (Patch C) |
| gather → compile → sheet | read → local rehearsal → one granted push; ordinary reversible writes cross without approval cards | P3 (this weekend) |
| "ask me along the way, within reason" | same-turn batched ask (question list, one pause, siblings keep running); ≤1 clarifying beat before autonomy | P4 (this weekend) |
| "here's what I found, here's what we should do next" | mid-task check-in in Clem's own words, in thread (landed `a306221a`); next-edge always named on any stop | P2 acceptance + v3.17 item 2 (render it) |
| "I can just trust you with a task" | completion graded on the effect ledger — "done" means the rows exist, never prose | P1 (this weekend) |

The trust sentence at the end is the whole product. It is bought with P1 (never a
false "done"), P2 (never a dead end), and P4 (asks that cost nothing) — not with any
new feature.

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

## 13. Competitive watch — live sweep 2026-09-04 (~16:30)

Five research lenses, 178 live fetches, every claim CONFIRMED against a fetched page
unless marked PLAUSIBLE. Raw findings with URLs: the reviewer session holds them; ask
if a citation is needed. Headline: **all three references moved materially in the ~12
days since our 08-22/23 baselines; nothing found reorders P0–P5; the moat holds but
three tag claims need precision fixes before v3.16 ships.**

### 13.1 Reference state (baselines are stale — new pins)

- **DeepSeek Harness** → `dsh-v0.1.3-alpha.1` (published **today**, commit `d347e70`;
  7 releases since our baseline, near-daily). NEW: same-turn ask
  (`ctx.userQuestions.ask()` blocks inside the tool call; composer queues into the
  running turn); session format v2 with **immutable adjacent-generation migrations**
  (they converged on our migration rule) and a cross-process **session-file lease**;
  formalized fail-closed pre-execute (deny-only guards, no argument rewriting,
  **approval grants are one-shot only** — no standing grants); approval cards carry
  typed permission categories; public reads are consent-free by policy. Workflow seam
  **still foreground-only, no resume** — and they *reduced* its default exposure.
  Experimental Agent Teams (event-sourced task DAG, CAS revisions, cold-resume
  mailboxes) is their durability answer forming — task records, not external effects.
  Their SAFETY.md now states sandboxing/approvals "do not guarantee isolation."
- **Hermes** → `v0.21.0 "Pantheon"` (2026-08-31; ~500 merged PRs/week). NEW:
  same-turn **batched** clarify (N questions, one pause); lean-tail compaction is
  default **with a published recall eval harness**; cron got a **closed status set
  separating computation from delivery** (`ok` may never mean "the user got it") plus
  pre-dispatch validation that refuses to burn a run, and cron agents are now
  **ever-learning** (persistent memory, continuity carry-forward, hash-skip unchanged
  monitors); writes to its own instruction files now always require approval. Still
  **zero** external-effect machinery: no receipts, no ledger, no per-write replay
  protection; approvals remain command-pattern regex + an LLM that auto-APPROVES.
- **bb** → head `1ab96a0` / desktop 0.41.0 (378 commits since baseline). Our three
  load-bearing claims **verified at source level**: the ask holds the turn by
  **withholding the JSON-RPC reply** to the in-flight call — a persisted
  `pending_interaction` row, one active ask per thread, the answer returns **as that
  call's own tool result**, zero extra model round trips, asks never expire and
  survive daemon reconnects. Plan is an optional prompt literal; no compiler in front
  of chat. NEW: **steer-on-Enter is the default** (user input CAS-injected into the
  live turn); opt-in `automations` (cron/one-shot) and `workflows`
  (**cached-call replay = restart-surviving runs**); marketplace, mobile app + push
  on `interaction.pending`; Hermes/Grok/Cursor/opencode mountable inside bb. Still
  zero external-effect settlement or business-write consent.
- **Market**: Codex `rust-v0.153.x` — **async user questions** (model-side trained),
  **Auto-review** (learned reviewer at the sandbox boundary, rationale attached,
  deny returns *steering* not a stop, review history survives compaction/restart),
  and **the planning tool is now disabled by default**. Claude Code — scheduled
  routines, background workflows, **Remote Control** (attach/approve from phone,
  the strongest approvals UX shipped). Google — Antigravity CLI: one harness, many
  surfaces, permissions set once. Landscape: allow/deny/ask policy is now universal;
  **Letta Code beat Claude Code on Terminal-Bench 2.0 on the same model via durable
  memory** — the strongest external proof of our ever-learning axis.

### 13.2 Moat verdict + three REQUIRED precision fixes to tag claims (text-only)

The moat holds — no reference has an effect ledger, a per-external-write lease,
never-blind retry, resolved live call authority, or ledger-graded completion. P1
**extends** a lead no one is chasing. But three of our claims are now rebuttable as
worded, and the tag must not ship them stale:

1. Say "**one lease per external crossing**" — never bare "CAS/lease" (DeepSeek now
   has a session-file lease; Hermes has trigger-layer CAS; bb has CAS lifecycle
   tables — all guard records, none guard an external effect).
2. Say "**their settlements aggregate model output; ours settle external effects**"
   (DeepSeek v2 renders "durable settlements" of assistant streams — the word is no
   longer ours alone).
3. **Drop every "no reference has durable workflows" phrasing.** bb now has
   restart-surviving workflow runs via cached-call replay (opt-in plugin). Correct
   claim: "no reference has occurrence identity + checkpoints + an effect ledger
   under its workflows; bb's replay caches agent results, not external crossings."

Positioning gains, free to state honestly: DeepSeek grants approvals **once per ask**
with no standing policy — our approve-once-then-governed-run is structurally better
for unattended work; and their SAFETY.md disclaims enforcement while our enforcement
layer is the verified §3 list (state it with the same honesty rule the notes already
follow, §9.4 judge disclosure included).

### 13.3 Phase validations + zero-risk design inputs (phases already executing — no scope change)

- **P4 is now table stakes, validated by ALL of bb + Hermes + DeepSeek + Codex.**
  Ship it exactly as scheduled. Design inputs from bb's verified mechanism: barrier =
  withhold the reply on the in-flight call; the answer rides back as **that call's
  own result**; one barrier per run-context; siblings keep running. Shape the payload
  as a **question list** (batched; single question = degenerate case) so no v3.17
  payload migration is needed.
- **P5 is market-confirmed, not contrarian**: Codex disabled its planning tool by
  default; bb keeps plan an optional literal; DeepSeek has no graph. Until P5 lands,
  our plan-freeze exam is the outlier among all four.
- **P2 validations + one test case**: Hermes — a stalled attempt must not burn retry
  budget, and a **provider-proven** failure buys exactly one bounded retry through an
  armed cooldown (their issue #100661; same shape as "shape rejections never end a
  turn"). Codex charges all nested work to one root budget. bb ships failure-settling
  with visible backoff — P2's acceptance already requires our typed stop payload to
  reach the user-facing terminal **verbatim**; that is the market behavior.
- **P3 design input**: category-labeled approval cards are table stakes (DeepSeek).
  The same-step consent card should pass the reducer's **existing** typed fields
  (effect, reversibility, account) through verbatim — pure pass-through, no new
  mapping layer (defer any such layer to v3.17).
- **P1 has no competitor equivalent.** Nearest cousin: Hermes cron's closed status
  set ("never test `== ok` for the-user-got-their-result") — independent validation
  of both P1 and our pre-dispatch-refusal-visibility priority.

### 13.4 v3.17 backlog, ranked (forward-only; NONE of this is weekend scope)

1. **Durable ask barrier** (persisted row, idempotent per-call id, re-attach on
   restart) + optional deadline that degrades to recorded model judgment + a
   deny-and-continue escalation policy for unattended runs. The composed property is
   claimed by no one; bb holds two of the three pieces.
2. **Desktop run-ledger/trajectory pane over the EXISTING journal.** Measured: the
   desktop and console render **zero** of our effect vocabulary today (0 grep hits
   for `external_write_succeeded` / `logical_call_settlements` /
   `physical_dispatches` in apps/desktop + apps/console-web). Trajectory-grade
   legibility is the market bar (DeepSeek renders live from its log; bb live-follows
   by seq). Ours is a **rendering gap, not an engine gap** — desktop refinement only,
   per the owner's surfaces rule: run ledger, live-follow via seq reads, background
   inbox (running/blocked/needs-input/done + next edge), in-conversation schedules,
   usage/step_efficiency stats.
3. **Delivery-distinct terminal literals** for scheduled/workflow runs
   (delivered-and-proven ≠ computed-but-undelivered ≠ refused-pre-dispatch).
4. **Self-instruction-write consent class** in the ONE existing reducer (writes to
   Clem's own memory/skills/workflow definitions = a named class; anti-prompt-
   injection guarantee; Hermes shipped the equivalent). Touches the safety floor —
   own red journey.
5. **Occurrence continuity**: carry the previous occurrence's report into the next;
   hash-skip unchanged monitor runs (Hermes cron parity on our ever-learning axis).
6. **Compaction recall eval** over real sessions (Hermes ships one; we have none).
7. **Auto-decision rationale in the transcript** + judge-gate denials return
   steering, not a stop (Codex Auto-review parity; OPEN CLEM UP alignment).
8. **Cross-surface benchmark**: remote approval reliably resumes the paused run;
   run started on one surface fully inspectable/approvable from the others
   (Claude Code Remote Control, Antigravity one-harness-many-surfaces).
9. **Fork-from-checkpoint design pass** — the one Trajectory behavior with no engine
   truth behind it here (interacts with CAS + never-blind retry; needs care).
10. Re-propose-the-pending-call recovery UX (Gemini rewind); steer primitive
    (user CAS-injection into the live turn, bb default); ACP interop watch;
    read-result TTL cache for the curated-reads lane.

### 13.5 Strategic read

The market is converging on our consent shape while **conceding our two moats**:
settled-external-effect truth and durable memory (Letta proved memory beats a
first-party harness on its own model). The weekend phases attack exactly the right
bar. The v3.17 kill-shot demo no reference can follow: **kill -9 mid-run → the
occurrence resumes → the effect ledger is intact → zero duplicate external writes.**

---

## 14. Pocket + proactive: the backend contract the UI phase needs (2026-09-04 ~19:30)

Owner's ask, his words: *"With Claude Code I open a terminal and it creates a folder for
anything. I can't grab my phone and toggle through projects, create one, or feel like my
workflows are in my pocket. And Clem isn't proactive with me the way I want. What's
missing in the backend? Next up is the UI phase — desktop and mobile."*

Three code-grounded probes (322 file reads, working tree). **None of this is weekend
scope.** It is the v3.17 backend prerequisite list the UI phase will build on — a UI
can only render what the engine durably holds.

### 14.1 What already exists (verified) — more than the phone shows

- **The project entity is ~80% built and is called a Space/Workspace**
  (`src/spaces/store.ts` `SpaceRecord`; file truth `spaces/<slug>/space.json`; SQLite
  index `src/spaces/workspace-db-schema.ts`, schema v5). It carries slug, title,
  status, a durable **contract** {objective, successCriteria, invariants},
  originSessionId, focusId, data sources, actions, re-engage triggers, revisions,
  mobile prefs. It is reachable from chat (deterministic session `space-<slug>` mounted
  as kind `workspace` by `session-composition.ts`), workflows
  (`workspace_workflow_bindings`), memory (observation bridge → `memory_episodes`),
  and the phone (`GET /m/api/workspaces`, `/:id`, `/refresh`, workspace-scoped chat).
- **"Clem proposes, owner approves, durable Space is created" already exists** as a
  primitive (`automation-read-pilot-workspace-control-plane.ts:608`,
  `createIfAbsent` behind a resumable approval card with a `create_new` choice) —
  but only wired for canonical-entity pilots.
- **The phone is NOT a reduced projection.** It reads the same harness event log,
  public projection, Working-Now snapshot, and run collector as desktop
  (`src/channels/mobile-routes.ts`, ~90 `/m` routes; pinned-TLS door on by default,
  Bonjour + off-LAN relay; device-bound P-256 sessions; Web Push + APNs). Verified
  from the phone today: list/open/continue/start conversations (SSE with resume);
  list + full-detail + **run** workflows (409 names missing inputs); workflow run
  events + terminal + cancel-at-boundary; **mid-run steer** (durable steer note);
  **approve/deny a formal approval and the run resumes** — Claude Code Remote
  Control parity EXISTS; cancel/resume background tasks; switch brain. And
  `GET /m/api/runs/:sessionId` already renders `external_write*` **receipts** — the
  phone is *ahead of desktop* on the ledger (desktop renders zero, §13.4 item 2).
- **The proactive lane is fully built and switched OFF.** One gate:
  `proactiveWorkAllowed = policy.enabled && !quietHours`
  (`src/agents/proactivity-policy.ts:233-241`, `src/daemon/runner.ts:3541-3590`).
  Behind it: git/inbox/calendar monitors, the execution controller, autonomy-v2
  standing agents (opted in via `AUTONOMY_V2_AGENTS`, dark), self-driving goal
  resumption, hourly briefs, and five check-in templates (shipped disabled; only
  `seed-friday-wrap` ever fired, 2026-05-14). **Live state:**
  `state/proactivity-policy.json` has `enabled:false` AND quiet hours `00:00→23:59`,
  set 2026-08-15 — 4,962 "paused by policy" log lines. The OFF door was the console
  Usage panel's **cost trim** (`POST /api/console/usage/trim kind=proactivity`), i.e.
  it was turned off to save tokens, never as a consent decision.

### 14.2 What is missing — the backend contracts, ranked for the UI phase

Every item is a projection over existing truth or one durable link. No new session
kind, store, executor, door, or flag. Sizes are the probes' estimates.

1. **ONE owner principal across first-party surfaces** (medium). Today a phone turn
   into a desktop-origin conversation **forks an `identity_split` child** instead of
   continuing it (`accepted-source-session-branch.ts:211-229`: desktop principal
   `{provider:'desktop', audienceId:'desktop'}` ≠ mobile `{provider:'mobile',
   audienceId:deviceId}`). Contract: first-party providers (desktop/mobile/cli)
   normalize to one canonical owner audience; the originating device is recorded as
   **provenance** on the receipt. This is *the* "pick up on my phone what I started
   on the desktop" blocker, and Antigravity's one-harness-many-surfaces bar.
2. **Durable `pending_interactions`** (large; **shares its entity with P4's durable
   barrier, §13.4 item 1**). Formal approvals are durable and phone-answerable;
   conversational asks (`autonomous_send_consent` today, the P4 question list
   tomorrow) are not — no row any surface can list, push on, or answer. Contract:
   ONE row written by the ONE consent reducer / ask barrier: {id idempotent per
   callId, sessionId, attemptId, callId, kind consent|question, payload = question
   list, effect/reversibility/account pass-through, status pending|answered|expired}.
   Push on it = bb's `interaction.pending`. Also project chat asks as a 4th
   `InboxQuestionSource` ('chat') from open continuity packets so the inbox is
   complete.
3. **Project identity as a session MOUNT, not a name prefix** (medium). Sessions,
   background tasks, goals, deliverables, and continuity packets are keyed by
   session_id only; the only project attribution anywhere is the `^space-` regex
   (`workspace-context.ts:17`). `workspaces.focus_id`, `workspace_memory_scope`,
   `workspace_embeddings`, and `workspace_state_events.run_id` exist in schema with
   **zero production writers**; desktop's workflow↔space link is a text grep of
   workflow files. Contract: extend the existing validated session mount
   (`__session_mount {kind:'workspace', workspaceSlug}`) so ANY session may carry
   it; write `focus_id` through the existing `createFocus`/`activateFocus`
   primitive so **"current project" becomes one cross-surface switch**; emit
   `workspace.changed` on the action bus; write `workspace_workflow_bindings` via the
   existing `putWorkflowSurfaceBinding` when a workflow is saved/run from a mounted
   session. Then "everything in this project" is a JOIN, on every surface.
4. **Create a project from one sentence, from anywhere** (small). `space_save` is
   already a host-owned local write with no plan exam, but its create branch
   **refuses without `view_html`/`view_path`** (`space-tools.ts` ~520) — so "start a
   scraping project for X" forces the model to author HTML first. The console route
   already writes a `PLACEHOLDER_VIEW`. Contract: same fallback in `space_save`;
   add `POST /m/api/workspaces {title, objective?, successCriteria?, invariants?}`
   = the same `spaceStore.save` + `mergeSpaceContract`; generalize the existing
   propose→approve→`createIfAbsent` primitive beyond canonical-entity pilots. **This
   is the Claude Code "folder for anything" equivalent**: one sentence → a Space
   with a contract → focus switches → every session/run/deliverable from then on
   carries the mount.
5. **Proactivity as consent, not a cost trim** (small). Expose the policy snapshot
   **with a reason** (`enabled:false` vs quiet hours) on `GET/POST
   /m/api/settings/proactivity` + console, over the existing
   `loadProactivityPolicy`/`saveProactivityPolicy`; the per-lane fields already exist
   (`inboxWatchEnabled`, `calendarWatchEnabled`, `allowDiscordCheckIns`,
   `briefCadenceMinutes`, `checkInMinutes`) — the policy IS the consent record.
   Per-Space re-engage triggers become owner-editable (`PATCH /m/api/workspaces/:id
   {reengage}`) and defer (never drop) under quiet hours. **Owner action, zero code:
   the lane is off today because of a 24-hour quiet window set on 08-15.**
6. **Clem-initiated speech needs an origin session; suggestions need one projection**
   (medium). Briefs, monitor cards, and template check-ins are created **without a
   sessionId**, so they can only be templated notifications (a standing-voice-rule
   violation waiting to happen) and the owner's answer cannot flow back as an
   accepted source. Contract: one per-user Clem-initiated origin session (an
   ordinary chat session, `metadata.origin:'clem'`, discovered at runtime, no new
   kind); route briefs/check-ins through the existing `deliverOutcome` path so the
   words are **model-authored**; `answerCheckInCas` appends the reply there as an
   accepted source. Plus `listSuggestions()` — a PROJECTION over the seven existing
   proposal stores with one envelope {id, sourceKind, title, rationale, proposedAt,
   expiresAt, decisions approve|decline|later, effectClass}. That is "here's what I
   found, want me to run X?" on the phone, bounded by the existing loud/quiet
   notification fan-out — never a second loop.
7. **Phone reach completions** (small each): `GET /m/api/tasks(+/:id)` with
   `outcomeSnapshot {outcome, blocker, nextAction, resumable}` via ONE serializer
   shared with console; `POST /m/api/workflows/:name/set-enabled` and `/schedule`
   over `prepareWorkflowEnableForWrite`; chat-list paging/search/workspace filter
   (today: hard cap 80); APNs parity for chat report-backs (one
   `isOwnerDeviceDestination` predicate) and **asks always push** (needs_input /
   awaiting_approval bypass the elapsed-time threshold); let
   `conversation_check_in`/`conversation_preamble` through the mobile projection so
   the phone can read "what she did while I was away."
8. **Run-ledger projection** (medium; = §13.4 item 2): one `run_ledger` function
   consumed by both console and `/m/api/runs/:sessionId` — per accepted call
   {callId, tool, effect class, account, resolved authority, lease/dispatch state,
   settlement disposition, result handle}. Phone renders receipts already; desktop
   renders nothing.
9. Engine items behind the above: a `paused` occurrence state at a step boundary
   (pause-a-run exists on no surface); optional: wire `workspace_memory_scope` so
   recall boosts project-scoped facts.

### 14.3 Order and guardrails for the UI phase

Order: **1 → 2 → 3+4 → 5+6 → 7 → 8 → 9.** Item 1 first because every other phone
behavior is wrong while a phone turn forks the conversation; item 2 second because it
is the same entity P4 needs and it unlocks push-on-ask; 3+4 make "project" real; 5+6
make Clem proactive *in her own words* with consent; 7–8 are surface completions.

Guardrails (binding, from the owner rules): the Space stays a **projection with zero
execution authority**; one effect kernel, no second loop; no new session kind or
store; proactivity is bounded by the existing policy + quiet hours + loud/quiet
fan-out; first-party surfaces only (desktop + mobile), no new channels; Clem-initiated
speech must originate in a session so it is model-authored, never a template.

---

## 15. Concurrent judges: what exists, what the market does, and the contract (2026-09-04 ~23:00)

Owner's premise: "most assistant harnesses now run parallel judge agents that work
concurrently with the working agent and its subagents, injecting logic into them."
Two verified lenses (in-tree read + live market fetch, 104 tool uses):

### 15.1 Market verdict — not supported as stated; Clem is ahead

- What ships is a **synchronous boundary reviewer** that returns allow/deny at an
  action or approval: Codex Guardian/Auto-review (rationale + a fixed
  anti-circumvention instruction on deny), Claude Code's auto-mode classifier
  (allow/block, subagents checked at three points), Hermes "smart approval"
  (APPROVE/DENY/ESCALATE), bb (a pass-through to Codex). DeepSeek Harness and
  opencode have **no LLM judge at all**.
- The only genuinely **concurrent** component anywhere is Codex Guardian v2's async
  per-call risk scorer — non-blocking, emits a low/high score and user warnings,
  **injects nothing** into the working agent.
- Mid-run steering channels exist (Hermes `delegate_task steer`, DeepSeek team
  "Steer" delivery) but they are **parent- or human-driven**, not judge-driven.
  Claude Workflows verify only after workers finish ("no mid-run user input").

### 15.2 What Clem already has (verified file:line)

- **A concurrent, steering trajectory judge**: `src/runtime/harness/watcher-judge.ts`
  (since `690c14de`, 07-30). Non-blocking (fired `void async`, never awaited), judges
  the trajectory against the GOAL with the shared cross-family hedged engine
  (`runHedgedJudge`, lane `watcher`), and on drift injects one sentence into the
  parent brain's next continuation. Mounted on all three lanes: loop.ts
  (`CONTINUATION_INPUT` + steer, :9067-9124), host_v1 (`pendingHostModelDirective`,
  host-turn-runner.ts:6274-6343, mounted `e505332c` 09-02), workflow lane
  (`applyWatcherSteerToPrompt`, workflow-runner.ts:2255-2270 — **default OFF**,
  `CLEMMY_WORKFLOW_WATCHER_JUDGE`). Budgets: `MAX_WATCHER_CHECKS=4`,
  `MAX_WATCHER_INJECTIONS=2`, 25 s timeout; advisory text only — it cannot block,
  approve, or touch an effect gate ("guardrails inform, not override").
  **P2 proved it on the wire**: 5 real Claude Sonnet 5 watcher calls overlapping live
  Codex brain calls, `selfJudge:false` (P2 report §7).
- The rest of the judge family, each with its authority: completion judge
  (end-of-turn, ≤2 continuations, self-judge = ONE bounce then advisory — the
  "unapproved sends" scar, loop.ts:8054-8076); terminal-delivery judge (**mandates a
  different family**, resume|ask|deliver); per-write grounding/goal-fidelity gates
  (soft-block + reroute; judge outage mints an approval card via
  `mintJudgeFailApproval`, brackets.ts:1649-1725); output-grounding gate (runs
  concurrently with the completion judge); workflow advisory judges (detection
  only); fusion "verify" checker (default off). The consent reducer
  (`interactive-consent-policy.ts:279`) is pure — **no judge branch exists in
  consent, execution-gate, or confirm-first**, by design.

### 15.3 What is missing (the real gap)

1. **The watcher never reaches subagents.** Every injection channel is the parent
   brain's input. `run_worker` workers run in an SDK subprocess under the parent
   session (claude-agent-worker.ts:112-114); the only in-flight channel into a
   worker is the steer-note block at the brackets tool-result boundary
   (brackets.ts:4568, 5055), which today carries **user** notes only
   (`user_steer_note`; steer-notes.ts:35-37 also excludes `workflow:` sessions).
2. **Subagent trajectory is only partly visible**: native external MCP calls inside
   the SDK never reach brackets/eventlog as `tool_called` (claude-agent-sdk.ts:439-440).
3. **The watcher drops `selfJudge`** (watcher-judge.ts:188-197), so unlike the
   completion judge it has no same-family demotion — a same-family watcher can steer
   with full force. (P2 also found the final completion verdict was self-family
   despite the Claude pin — §12 finding 3.)
4. Three audit vocabularies for one fact (`heartbeat watcher_steer`,
   `goal_alignment_judged kind:watcher`, `step_advisory watcher_steer`).
5. Subagent OUTPUT validation is post-hoc only (fanout-item-verify at reduce time;
   schema-validated reduce tier) — correct, but the owner's ask is in-flight.

### 15.4 The contract — extend, never add a loop (v3.17, after P3)

- **Channel:** a second, judge-authored steer-note kind (`judge_steer_note`)
  delivered through the SAME brackets tool-result boundary — it already reaches
  every wrapped tool on every lane, SDK workers included. Widen
  `sessionSupportsSteering` to `workflow:` sessions. Keep the existing frame:
  a steer note is **context, not authority**.
- **Engine:** `watcher-judge.ts` + `runHedgedJudge`, cross-family by default; carry
  `selfJudge` into the verdict so the loop demotes same-family steers exactly as it
  does for the completion judge. Budgets stay explicit (checks, injections, timeout)
  and per run/turn; a subagent gets its own bounded budget, not the parent's.
- **Audit:** one `watcher` `VerdictDoor` in `src/execution/verdict.ts`
  (`recordVerdictEvent`) so the three vocabularies collapse to one ledgered row
  **with the rationale** (this is also §13.4 item 7, Codex-parity).
- **Authority:** a judge may steer or hold, never approve, never mint an action, never
  write to the resolution/dispatch ledgers (those are expected-vs-observed authority
  and must not carry opinion). Any BLOCKING outcome is projected as a **structural
  fact** into `evaluateInteractiveConsentV1` (`needs_user` / `repair`) or through the
  existing `mintJudgeFailApproval` — never a text-level block.
- **Visibility first:** before steering subagents, make their trajectory observable
  (SDK-native MCP calls → `tool_called`), or the judge steers blind.
- **Owner floor unchanged:** cross-family or demoted; the irreversible-send ask can
  never be satisfied by a judge; two hard bounces never push a worker past a
  consent boundary (the recorded regression).

Order inside v3.17: visibility (15.3-2) → audit door (15.3-4) → selfJudge carry
(15.3-3) → judge steer notes to workers (15.3-1). None of it is weekend scope.

---

## 16. Measured latency + token profile (2026-09-04, isolated P2 evidence, read-only)

**Method.** Two profiler agents over COPIES of the P2 evidence homes (`harness.db`,
`model-route-metrics.db`, `operational-telemetry.db`, token-usage ndjson);
`transport_mirror` double-counts excluded by construction; no adversarial verifier
ran, so the reviewer source-checked every mechanism below (✓ = the cited line exists
and does what is claimed; ○ = plausible, needs a pin before anyone acts on it). The
"93% orchestration" in §1/§6 is the DEV-CYCLE number (boot-to-boot) and stands; it is
not a statement about a run.

**Headline.** The P2 canary resumed leg (221.7 s wall) is MODEL-BOUND: 17 brain
calls = 200.7 s (90.5%); tool execution 16.8 s (7.6%); ALL host work — pre-model
1.64 s + admission 1.38 s + post-tool 1.28 s — 4.3 s (1.9%); idle/backoff 0. Per-step
ceremony is negligible (prompt composition ~2–10 ms; admit→dispatch 81 ms;
settle→next request 80 ms). The harness cost is the NUMBER of round-trips it
induced: 11 of 17 steps were `tool_search` loops (137 s = 62% of wall) re-finding an
operation already found at step 3 and re-asking an account the user had ALREADY
answered. The 8-worker audit (106 s): brain 73.8 s, judge critical path 32.8 s,
tools 1.1 s; after the pre-dispatch refusal, 90.6 s were completion-judge/continue
cycles. The direct audit (19 s): brain 94%, three serial `read_file` round-trips,
plus a 20 s UNATTRIBUTED post-terminal Claude judge call.

**Ranked fixes (by measured leverage; lane noted so P3 is not disturbed).**
1. ✓ **Journal the resume answer into the accepted source.** `background-tasks.ts:6139`
   hands the bridge `displayMessage: task.prompt` (the original objective) while the
   user's answer rides only in `message`; `respond-bridge.ts:797/1401` journals
   `text: displayMessage`; so every `user_input_received` on a resumed task carries
   only the objective and the account scanners (`tool-search-provider-sources.ts:403/
   418/663`, `plan-tools.ts:1257/1285/1348`) never see the answer →
   `account_selection_required` on every resume → the model re-asks. Measured
   ~164 s of 222 s (11/17 steps). Same class as HANDOFF 09-03 "the harness holds the
   answer". Fix: journal the answer as the accepted text of the resumed source (or a
   durable per-task account binding the scanners read). Lane: bridge/background — no
   P3 overlap. Pin: resumed task with an answered account → zero re-asks, ≤3 searches.
2. ✓ **Host-relayed clarification.** When `plan_task` returns
   `account_selection_required` with the exact question + choices, park
   `awaiting_user_input` from the host instead of spending a model step whose only
   permitted tool is `ask_user_question`: 80,367 uncached tokens + 6.8 s on turn 229;
   88,518 tokens + 40.2 s on the analogous stop step of turn 82. Lane:
   `host-turn-runner.ts` ~6466–6490 (P3 territory — executing agent sequences it).
   This IS the P4 same-turn ask, seen from the cost side.
3. ✓ **Bound identical-operation re-discovery.** The governor re-admits each search
   as `settled_continuation_admitted` (`discovery-governor.ts:1347`). When a role's
   search already returned exactly one operation and the only blocker is account
   selection, return the typed blocker as the tool result (the next edge) instead
   of admitting another search. Caps the loop at ~3 steps (~100 s) even if #1 regresses.
4. ✓ **Judge continuation budget must survive re-entry.** `let
   objectiveJudgeContinuations = 0` (`host-turn-runner.ts:2364`) is per runner
   invocation, while `noProgressCheckpoint` IS restored from
   `HostRecoveryState`/`HostInterruptState` (:2365–2369) — so every
   `admit_recovery_rebased` re-entry restarted the judge→continue cycle with
   `continuationsUsed 0` and `MAX_HOST_OBJECTIVE_JUDGE_CONTINUATIONS = 2` never bound
   it (4 cycles, 54–80 s of 106 s). Carry it exactly like `noProgressCheckpoint`; and
   never run a continuation when the only missing evidence is a tool whose receipt is
   `refused_pre_dispatch` + `do_not_retry`. Lane: host-turn-runner (P3) — small.
5. ✓ **Cache-prefix stability for the life of an accepted turn.** `plan_task` and
   `work_call` flip `isEnabled` before every model request (`plan-tools.ts:1650`,
   `work-call.ts:1864`) and the no-progress recovery mode shrinks the tool array
   (`hostNoProgressRecoveryToolNames` :563/:6527); on the Anthropic wire the tools
   block sits ABOVE system, so a catalog change is a full-prefix miss: 122,894 uncached
   tokens on P2 = 61% of the run's uncached input. Fix: advertise one tool array per
   accepted turn and enforce the permitted set at pre-dispatch admission (the
   `refused_pre_dispatch` receipt already exists) — constrain effects, not methods.
   Same family: pin the memory block per accepted source on the Codex lane (a
   re-prime rewrote it 3× inside one turn) and move the planning card out of the
   `plan_task` description into the dynamic system tail.
6. ○ **Ledger truth, not wire.** `claude-model.ts:859` declares `cacheDialect:
   'exclusive'`; the profiler reads the AI-SDK adapter as delivering INCLUSIVE totals,
   which would overstate uncached input ~3.9× (turn 229: 1,105,549 → 202,582;
   `sessions.tokens_used` 1.94 M → 0.50 M — run budgets accrue on the wrong number).
   Pin against a recorded receipt pair BEFORE changing the dialect; also capture
   cache-WRITE tokens (today redacted because undefined).
7. ✓ **Condenser summarizer route.** `compaction.ts:269 getSummarizerModel()` returns
   `MODELS.fast`; with `OPENAI_MODEL_FAST=gpt-5.4` the Codex/ChatGPT wire 400s on EVERY
   turn start (507 ms failed call; layer 2 never applies; a 58k→11k clip instead of a
   summary). Resolve through the role/provider resolver; skip layer 2 cleanly when
   unreachable.
8. **Compact `tool_search` results** (name + effect + one line + result handle; schema on
   demand) and collapse rephrased searches under one role key: 11 searches = 83 KB
   (~27k tokens) riding every later step.
9. **Measurement first:** `firstByteMs` on the BYO/claude-model and Codex streaming
   paths (0 first-byte events in all three DBs; `usage-log.ts:453` already accepts
   it); tag every judge call with sessionId + seam (`usage-log.ts:226` files the 20 s
   post-terminal judge as `other`); wire the zero-caller `comparePromptCacheRequests`
   into `recordModelUsage`.
10. **Do NOT chase:** per-step prompt composition (~0.1 s over 17 steps) or tool-schema
    re-render (constant 9,910 tokens). Reasoning effort for background steps
    (`reasoning-effort.ts:118` caps only interactive; one 66 s call drafted five emails
    in thought before a `tool_search`) needs an A/B on quality before any default change.

**Unmeasurable today (each is an instrument worth adding):** TTFT per call; thinking
vs generation split (`reasoningTokens` redacted); `tool_search` sub-phases (composio
search vs new-slug schema materialization — the slow 2.5–3.7 s searches are the ones
that materialized new slugs); a true cold-vs-warm pair for the ≤70% cache gate (P2 is
an in-place resume; 78% is a proxy).

**Owner-facing translation.** P1+P2 cost 8m10s over two legs for zero drafts. Fixes 1–3
remove the loop that burned ~75% of that; fix 4 removes the judge churn after a
refusal; fixes 5–7 make the same turn ~60% cheaper in tokens without changing
behavior. None of them is a new door.

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

**2026-09-04 ~16:45 — TWO NEW SECTIONS, act as follows (no P0–P5 scope change):**

- **§13 Competitive watch** added — a live 5-lens research sweep (178 fetches,
  2026-09-04). Read §13.2 and §13.3 before writing the v3.16 tag notes and before
  finishing P2/P3/P4. Binding items for THIS weekend, all text-or-shape only:
  1. Apply the three claim-precision fixes in §13.2 to the tag notes and any
     comparison prose ("one lease per EXTERNAL crossing"; "their settlements
     aggregate model output, ours settle external effects"; never claim bb lacks
     durable workflows — it has cached-replay restart, no effect ledger).
  2. P4: payload is a QUESTION LIST (single question = degenerate case); barrier =
     withheld reply on the in-flight call; the answer returns as that call's own
     result; one barrier per run-context; siblings keep running.
  3. P2: add/verify the two governor cases — a stalled attempt burns no retry
     budget; a provider-proven failure buys exactly one bounded retry through an
     armed cooldown. And the typed stop payload must reach the user-facing
     terminal verbatim.
  4. P3: the same-step consent card passes the reducer's EXISTING typed fields
     (effect, reversibility, account) through verbatim — no new mapping layer.
  Everything in §13.4 is v3.17 backlog: do NOT start any of it this weekend.
- **§8.0 canonical ask** added — the owner's own scenario, phase-mapped. Shape the
  P3 acceptance canary and the P1 before/after report against it where practical.
- Reminder: commits 34d9dd63's live-wire verification (judge reaches the Claude
  wire) still belongs in the P1 canary report, per the entry above.

**2026-09-04 ~17:15 — P0 CLOSE-OUT + P1 TRANSITION STEERING (tree reached 0 dirty
at `6caa463e`; all ~30 staging commits reviewed clean; artifact verify EXIT=0
reproduced by the reviewer):**

P0 report checklist — the report is not complete without all five:
1. **Full isolated suite on the exact HEAD, real exit code.** Nobody has run the
   suite on the staged tree; 30 clean-looking commits are not a green suite. Hygiene
   per §10.2: stop the daemon first, `pkill -9 -f cutover-hold-entry`, never pipe
   the runner through `head`/`tail`. Report pass/fail counts and the HEAD SHA.
2. Re-measured distances: `git rev-list --count origin/main..HEAD` and
   `main..HEAD` (never a stale number).
3. Artifact verify EXIT=0 (already true at `6caa463e` — re-run if HEAD moved).
4. **Stash inventory, explicit:** `stash@{0}` ("WIP verified-mutation vertical…",
   journey 0/5, executor unbuilt) is intentionally parked — **do NOT pop it during
   P1 or P2**; it is P3-adjacent and re-enters only under the P3 phase start.
   `stash@{1}` (on `aa08f966`, "no branch") predates this effort — leave it
   untouched and note it exists.
5. Merge plan: **fast-forward is verified clean** — `18c5bcc7` (origin/main) IS an
   ancestor of HEAD, local main likewise. No merge-strategy decision is needed;
   prepare a fast-forward only. Push plan remains: branch, then main, then the ONE
   `v3.16.0` ref. Never `--tags` (stale local v3.15.0 must not publish).

P1 execution order (approved to start after the P0 report is posted):
1. **Stop the auto-re-arming canary task first** (`bg-graph-driver-tag-canary-
   20260904` has been cycling died→restart ~every 90 s all afternoon). Mixed-code
   evidence: the live daemon booted from a dirty tree hours ago, so its in-memory
   code is NOT current HEAD. After the P1 commit, **restart the daemon** — the tree
   is clean now, so a fresh boot runs exactly HEAD — and stamp
   `git rev-parse HEAD` in the run per §6.
2. P1 scope fence: ledger completion authority (D1) + the §6 instrument work +
   the §12 governor/consent design inputs already listed. Nothing from `stash@{0}`,
   nothing from §13.4.
3. The canary re-run follows §10.3 byte-identical rules + the 34d9dd63 judge-wire
   check. Expected flip, stated in advance: the tag canary reports **blocked**
   (honest) instead of completed; any sheet-write-class run with real crossings
   reports **done**. Report BOTH directions — the false-RED half (5/7 real writes
   reported as failures) is the bigger number.

Tag-time traps (for the moment the owner gives the tag go — record now, act then):
- Both `package.json` files already read `3.16.0` and MATCH (root + apps/desktop,
  verified 17:15). At tag time verify they still match the tag name — the v3.5.0
  incident was one bumped without the other.
- A red **"Test"** check on a pushed tag is a KNOWN BENIGN CI glob issue (recorded
  in the release history) — judge the release by the release-desktop workflow's own
  result, and do not chase the Test glob red.
- The release workflow preflight requires `tag_sha == origin/main` — push main
  BEFORE pushing the tag.

**2026-09-04 ~19:05 — P1 WORK-IN-PROGRESS REVIEW (uncommitted; 6 dirty entries):**
Direction is correct and matches D1 + §6 exactly: one provider-neutral
`backgroundEffectLedgerDisposition` shared by live settlement, boot repair, and the
empty-report fallback; `getBuildInfo()` sha/dirty/fingerprint stamped into the
blocked-terminal payload; the tree's first journey asserting
`external_write_succeeded`. Three items before the P1 commit lands:
1. **Prove the veto, not just the count.** The diff's event scan counts
   `external_write_succeeded` only. The doc's D1 rule is "zero AMBIGUOUS writes":
   an `external_write_orphaned` / uncertain crossing must VETO completion even when
   a success also exists. Show it in a test (or in the P1 report) — if the veto
   consults `assessBackgroundTaskRestartSafety`'s uncertain-write set, say so.
2. The `ledgerCompletionReportFallback` line ("Completed — the durable effect ledger
   records N successful external writes…") is ACCEPTABLE: it is a host/ledger-
   attributed fact, not Clem's voice. Keep it visibly ledger-attributed; never let
   it be rendered as if she wrote it.
3. `terminal-publication-proof.ts` drops `dependsOn` from a dependency loop (keeps
   `dataFrom` only). That is a behavior nuance — one sentence of justification in
   the commit message, and it should ship in its own commit, not inside the D1
   commit (P1 = "D1 alone in one commit" + instrument work).
Also: the P0 report + push/fast-forward ask are still owed (branch not on origin
at 19:05). Starting P1 in parallel is fine under the approvals block; the push ask
must not get lost behind P1.

**2026-09-04 ~19:30 — §14 ADDED (pocket + proactive backend contract). NOT weekend
scope; do not start any of it before the v3.16 tag.** Two things matter for work
already in flight: (a) **P4's durable barrier and §14.2 item 2 are the same entity**
— when P4 lands this weekend as an in-step barrier, name its row shape so the v3.17
`pending_interactions` persistence extends it rather than replacing it (question
list payload, idempotent per-callId id, effect/reversibility/account pass-through);
(b) §14.1 records that the proactive lane is OFF via a 24 h quiet window + cost
trim set 08-15 — an owner config decision, not a defect; do not "fix" it in code.
After the tag, §14.3 is the UI-phase backend order: 1 → 2 → 3+4 → 5+6 → 7 → 8 → 9.

**2026-09-04 ~19:50 — P1 COMMIT `92d6cc30` REVIEWED: ✅ ACCEPTED as the D1 class fix.**
16 files, +1,514/−111. What was verified:
- Ledger authority applied across every completion-grading path (live settlement,
  boot repair, fallback, approval drain, construct run, respond bridge, MCP shim) —
  wider than `background-tasks.ts` alone, and correctly so: completion is graded in
  all of them, and the owner rule is fix the CLASS.
- **Veto proven both directions** (§12 note 1 closed): an ambiguous draft settles
  `blocked` with the "may duplicate the action" reason, AND "a later ambiguous
  readback row cannot poison an exact earlier effect settlement" — the false-RED
  half is pinned by test, not just the false-green half.
- Prose gates were not deleted but **subordinated**: `taskRequiresExternalSendReceipt`
  / `completionLacksDeliverableEvidence` now run only when `externalEffectRequired
  === null` / `!ledgerCompletedExternalEffect` — i.e. only when the ledger is
  silent. A ledger-successful task can no longer be downgraded by prose. Acceptable
  and arguably better than deletion: the heuristics become the underdelivery guard
  for the ledger-silent case, which the audit found unguarded. (Note 2 closed: the
  fallback line stays ledger-attributed and is asserted by test.)
- §6 instrument work shipped alongside: build sha/dirty/fingerprint in the blocked
  terminal (`host-turn-runner.ts`), the tree's first `external_write_succeeded`
  journey (`journey-smoke.test.ts`). Artifacts re-emitted in-commit; reviewer
  re-ran `--verify-current`: EXIT=0. Banned-pattern scan clean. Tree at 0 dirty.

**P1 acceptance still requires (in this order):**
1. `npm run typecheck` + the isolated suite on THIS HEAD with real exit codes — the
   only full suite today ran before P1 (+1,514 lines since).
2. **Daemon restart on HEAD.** No daemon has run ANY of today's ~40 commits: the
   last boot line is `git 38fa83ad` (this morning). The boot log line must show
   `git 92d6cc30` (or later) before a canary run counts.
3. The §10.3 byte-identical canary re-run + the 34d9dd63 judge-on-the-wire check.
4. The P1 report: verdict flip in BOTH directions, HEAD sha, judge family observed.
The push/fast-forward ask (P0) is still owed to the owner and must go in the same
report if not already sent.
- Reviewer corroboration 19:58: `typecheck` on `92d6cc30` → **EXIT=0** (real exit
  code, no pipe). Item 1 above still needs YOUR suite run on this HEAD; the
  typecheck half is independently confirmed.

**2026-09-04 ~20:00 — OWNER DIRECTIVE (relayed by the reviewer): "I want them to
continue to work on what we need to."** Operationally: **never idle on an approval.**
Approvals are unchanged — push, tag, and `Start Pn?` still require the owner's own
words and must NOT be self-granted or inferred from this directive. But while any
approval is pending, keep working the approval-free lanes, in this order:
1. Finish P1 acceptance evidence (suite on HEAD, daemon restart on HEAD, canary
   re-run, the two-direction verdict-flip report + judge-wire check).
2. **Instrument work is always allowed (§6):** write the red journeys that encode the
   NEXT phase's failure classes before that phase starts — for P2: a stalled attempt
   burns no retry budget; a provider-proven failure buys exactly one bounded retry
   through an armed cooldown; two different `schema_invalid` shapes are two stages;
   the recovery surface for a host-side refusal includes the turn's proven read
   controls. Red journeys change no behavior and need no phase-start.
3. Keep the P0 push/fast-forward ask and the `Start P2?` ask visible at the top of
   every report until answered.
Post every report to the owner's session AND note it here in one line so the
reviewer can see the phase state without the transcript.

**2026-09-04 ~20:50 — `ef04f7db` (restart-recovery adopts ready checkpoints)
reviewed: ✅ accepted as P1-scope.** Rationale: the P1 canary requires a daemon
restart on HEAD (§6), and `exact_checkpoint_admission_exhausted` was one of the 8
death reasons on 09-04; adopting ready checkpoints after restart is the durability
prerequisite for that restart to be a valid instrument, not new feature scope.
Local rewrite of `500f8f88` (identical diff + artifact manifest bump) is benign while
unpushed. Scan clean. **Still pending: the daemon has NOT been restarted on HEAD
(last boot line remains this morning's `38fa83ad`); the push/fast-forward ask is
still owed.** Note for the P0 report: the reviewer briefly wrote skill-update files
into this checkout at ~20:20 and reverted them within minutes — if you saw 145
dirty `.github/**` entries, that was the reviewer, and it is clean now.

**2026-09-04 ~21:25 — DAEMON BOOTED ON HEAD `a58c34c0` (first boot on any of
today's commits; P1 `92d6cc30` + recovery `ef04f7db` included).** P1 acceptance
step 2 is done. The next `bg-graph-driver-tag-canary-20260904` run is the one that
counts — §10.3 byte-identical invocation, `claudeAvailable()` true, and the
`34d9dd63` judge-on-the-wire check in the report. Reminder: the "AUTH_MODE=
claude_oauth … booting degraded" boot line is the known no-behavioural-effect
warning (§12 09-04 audit), not a blocker. Push/fast-forward ask still owed.

**2026-09-04 — EXECUTING AGENT P0/P1 REPORT:** isolated suite was green under
§10.2 (14,403 pass, 6 known load flakes, 2 skip; isolation 333/333), typecheck and
artifact verify exited 0, branch + `main` fast-forwarded to `fee50292`, tag withheld;
the exact P1 canary honestly blocked before any Outlook write, while ledger tests
prove settled-write completion and ambiguous-write veto. `Start P2?` remains pending.

**2026-09-04 ~21:05 — REVIEWER: P1 ACCEPTED.** Verified independently: origin/main =
origin/wave = local main = HEAD = `2bd49667` (the 28-day CI preflight block is
lifted; no tag pushed — `v3.15.0`/`v3.16.0` absent on origin, correct). The canary's
terminal on the new build is **`blocked`** (`gitSha a58c34c0` stamped in the payload —
the §6 instrument works), not the false `completed` it reported all day: the
verdict flip landed in the direction stated in advance. The false-RED half is pinned
by test (ambiguous readback cannot poison an exact settlement). Its death reason is
`control_no_progress_exhausted`, `resumable:false`, `host-turn-runner.ts:6935` — the
D2 class exactly, i.e. P2's target; the same run should flip to a resumable typed
stop with a next edge once P2 lands. **Owner decisions now: confirm the push was
intended (if it was not, nothing is published; a tag is still withheld) and answer
`Start P2?`.** P2 design inputs are already in §12/§13.3: decrement-don't-zero,
key discriminator, recovery-surface union, last-word deletion, the two Hermes-derived
governor test cases, and typed-stop-payload-reaches-the-user verbatim.

**2026-09-04 ~21:40 — OWNER: `Start P2` given (relayed by the reviewer; the owner
said so directly to the executing agent as well).** P2 acceptance the reviewer will
check on each commit: (1) `no-progress-governor.ts` decrements `retriesRemaining` on
a typed consequence instead of zeroing it; (2) the consequence key carries an
attempt/repair discriminator so two different `schema_invalid` shapes are two stages;
(3) the recovery surface for a host-side refusal includes the turn's proven read
controls (not only the refused carrier); (4) the tool-free "last word" round trip is
deleted or handed the proven surface; (5) the two Hermes-derived cases: a stalled
attempt burns no budget, a provider-proven failure buys exactly one bounded retry
through an armed cooldown; (6) the typed stop payload reaches the user-facing
terminal verbatim, `resumable:true` with a named next edge. Then the SAME canary:
expected flip from `control_no_progress_exhausted / resumable:false` to a resumable
typed stop, ≤1 wasted model step per failing run. One fix per commit, red journey
first where possible. `Start P3?` follows the P2 report.

**2026-09-04 ~22:05 — REVIEWER: P2 batch `ce05be82`·`7bd17d6f`·`b8f334e9`·`658b12c2`
(+ manifest `4ed325eb`) reviewed. Scans clean. Against the six checks:**
- ✅ (1) `no-progress-governor.ts`: a NEW typed consequence now decrements
  (`Math.max(0, retriesRemaining - 1)`) and counts as bounded structural progress;
  zeroing remains only for a repeated key and an exhausted transition budget. The
  dead 3-retry budget is alive.
- ✅ (4) The tool-free "last word" round trip is gone (`tryLastWordTurn` /
  `modelStepSchemas = []` no longer exist; −336 lines); the typed stop is published
  with retained results, resumability and a next edge.
- ✅ (3) Directive + surface: the refused carrier stays available alongside proven
  read/discovery controls for host-side refusals ("without changing dispatch
  authority" — correct: wider recovery, same authority).
- ✅ `b8f334e9`: settled host capability bindings are counted directly by
  operation/account/schema and a bounded structural carrier repair is progress —
  the graph-neutral lane is no longer invisible to the governor (§2's back-end
  seam, at the governor).
- ⚠️ (2) PARTIAL: the bare `'schema_invalid'` stage fallback still exists
  (`host-no-progress-projection.ts` ~885 and ~1038) when no repairKey is derivable.
  Two different shape errors with no key still collide into the same-key terminal.
  Should-fix before P3: key the bare case on operation id + argument digest, and
  report how many bare `schema_invalid` stages the P2 canary still produced.
- ⚠️ (5) PARTIAL: "a stalled attempt burns no budget" is covered by the integration
  fixtures; the "provider-proven failure buys exactly one bounded retry through an
  armed cooldown" case is not evidenced — state in the P2 report whether it maps
  onto `retry_host`/`provider_repair` and pin it, or record why it does not apply.
- ➕ `658b12c2` (run_worker no longer hidden behind an expected-work contract on
  fresh turns; −3 lines, tested) is D5/P5 scope, not P2 — accepted as a benign,
  tested subtraction that serves NO DEAD ENDS; note the scope creep and stop there.
**P2 acceptance run still owed:** daemon restart on HEAD (`4ed325eb`), the SAME
canary, expected flip `control_no_progress_exhausted / resumable:false` → a
resumable typed stop with a named next edge, ≤1 wasted model step; include the
task-level terminal line (the P1 run had none in the log) and the sha stamp.
- ✅ 22:20 partial (2) CLOSED by `82e067f1`: no bare `'schema_invalid'` stage remains;
  a typed schema refusal without a repairKey is keyed
  `schema_invalid:call:<digest16>` over the effective operation + canonical argument
  digest (stable JSON, so formatting/call-id churn cannot mint stages); 96 test
  lines. Remaining before P3: partial (5) evidence + the acceptance run.

**2026-09-04 ~22:45 — REVIEWER: P2 ACCEPTED** on `docs/P2-FREE-THE-TURN-REPORT-2026-09-04.md`
(the most disciplined phase report of the day: frozen SHA + fingerprint + isolated
home, real exit codes, evidence dirs, and explicit refusals to overclaim).
- ✅ The flip landed: the SAME canary went from `control_no_progress_exhausted /
  resumable:false` to `needs_input` · `input_required:account_selection` ·
  `resumable:true` with the exact next edge ("Which connected account should I
  use?"), 26 tool calls, 21 settled dispatches, 5 retained result handles, 0 bare
  `schema_invalid`, 0 last-word turns, 0 writes. A mailbox question on a blank
  state is the CORRECT stop (§8.0 beat 4). Production diff net −73 lines (−48
  through the follow-up). §3 files untouched.
- ✅ Partial (5) resolved by clarification: the "cooldown" is a model-transport
  property (`withModelFallback`: provider-proven failure arms cooldown before one
  bounded rescue — tested); tool rejections are governed by `provider_repair`. No
  timed business-tool cooldown exists or is required. Accepted.
- Honest caveat kept: "≤1 wasted model step" was NOT independently classified
  (the collector's `modelSteps:0` is unusable) — carry it into P3's acceptance.
**The parallel audit answers the owner's question:** Clem already HAS the
concurrent judge — the trajectory watcher (chat interval 4 tool calls, workflow
interval 2 steps), advisory, cross-family — and it is now **proven on the wire**:
5 real Claude Sonnet 5 watcher calls overlapping live Codex Terra brain calls
(2.4–2.9 s each, `selfJudge:false`); the direct-auditor run on the final build
PASSED. What failed was fan-out, not the auditor.
**THREE NEW FINDINGS (P3 preconditions — log them as the first P3 red journeys):**
1. `run_worker` was advertised in the request schema, the model emitted a correct
   8-item call, and the host **refused it pre-dispatch** (`refused_pre_dispatch`,
   recovery `replan`) with only a generic diagnostic — the narrower reason was NOT
   retained in receipts/logs. That is the 09-03 "pre-dispatch refusals record
   nothing" class AND the brief's "advertised schema must be dispatchable" rule.
   Red journey from the captured call bytes; fix must name the reason and dispatch.
2. **Local-task completion is still prose-graded**: the unmet 8-worker task ended
   `done / success` while its own text said it could not complete. D1 fixed
   EXTERNAL-effect tasks; a local-only task needs its own ledger-shaped authority
   (deliverable/result-handle evidence, or the worker receipts it was asked for).
   This is D1's class, incomplete — P3 scope, before any write work.
3. The **final objective-completion judge was self-family** (`selfJudge:true`,
   Codex hedge) even with `claude-sonnet-5` pinned as judge — the watcher path
   honors the pin, the completion-verdict path does not. §9.4 row 3 stays RED
   until the completion judge is provably cross-family on the wire.
Owner decision now: `Start P3?` (same-step consent+dispatch for the nominated
write, write-bar extension, ONE attestation builder, single-pass plan validation)
with findings 1–3 as its first red journeys.

**2026-09-04 ~23:05 — §15 ADDED (concurrent judges).** Verified: the market does not
run parallel steering judges (only Codex has a concurrent component, a non-injecting
risk scorer); Clem already has one — the trajectory watcher — and P2 proved it on the
wire. The gap is subagents + selfJudge carry + one audit door; the contract and its
order are in §15.4 and are **v3.17, after P3**. Do not start it this weekend; do not
add a second loop; a judge never gains write/approval authority.

**2026-09-04 ~22:20 — TAG BLOCKERS FOUND BY THE REVIEWER'S RELEASE-GATE DRY RUN
(detached checkout of `2cc40895`, real exit codes; these are gates the release
workflow runs on a tag push):** typecheck ✅ · test:public-hygiene ✅ ·
**check:public-hygiene ❌ · test:release-assets ❌**. Three concrete fixes, none of
them harness work — fold them into P3 or a `chore(release)` commit before the tag:
1. `docs/P2-FREE-THE-TURN-REPORT-2026-09-04.md` contains a personal home path
   (`/Users/<user>/…`, one occurrence) → replace with `~/…` or `<repo>/…`.
2. `apps/ios/ClemTests/PendingPushNavigationTests.swift:283` — the fixture
   (a URL carrying a `user:secret@` userinfo before a LAN host) trips `credential-bearing-url`. It is
   an intentional negative test (asserts `.cancel`), but the checker cannot know
   that. Use the checker's placeholder form if it has one, else an obviously fake
   value (e.g. `https://user:PLACEHOLDER@example.invalid/m/`). NOTE: this line is on
   `origin/main` since `d315e50d` (2026-08-30) — the hygiene gate has been red on
   main since then, independent of today's work.
3. `scripts/release-workflow.test.mjs:266-273` asserts
   `HARNESS_SCHEMA_VERSION = 74` — a stale pinned fixture; the tree is at 77 (v76/77
   landed today; it was already stale at v75). Make the test read the real constant
   (or update the pin to 77 alongside the migration rule that keeps it equal).
Heavy gates the workflow also runs (journeys, proof:selftest, test:measurement,
bench:gates, eval:memory/passk/jobs) still need a daemon-DOWN window for the
isolation sentinel; the reviewer will run them in the next window the executing
agent is not using. Until all gates are green on the release bytes, the tag is a
no-go by the procedure's own rule ("packed-candidate green on those bytes").

**2026-09-04 — EXECUTING AGENT P2 REPORT:** [P2 report](./P2-FREE-THE-TURN-REPORT-2026-09-04.md) records green local runs (252/252, 414/414, 96/96, reviewer follow-up 91/91; overlapping counts, real exit 0), typecheck/artifact verify exit 0, and the cooldown test receipt (`p2-floor-final.log`, test 50; model-transport cooldown is distinct from tool `provider_repair`). Same fixed canary on clean `4ed325eb` reached `input_required:account_selection`/`needs_input`, resumable true with retained results, zero writes and zero bare-schema/last-word events; global ≤1 wasted-step metric not claimed. Eight-worker acceptance FAILED: an advertised call was refused before dispatch, zero workers despite terminal `done`. Five genuine Claude watchers overlapped Codex brain calls. Separate final-source direct-auditor test on clean `5b8c3267` PASSED all three exact reads/results plus real Claude/Codex overlap, exit 0. Main DEV rebooted clean `c2623d01`, PID 51650/8520, requested pairing and both watchers on. No P2 push or tag; P3 has not started. `Start P3?` is the next owner decision, with mixed live results preserved rather than waived.

**2026-09-04 22:30 — REVIEWER VERIFIED the repair `64c3bfa5` on its own bytes
(detached dry-run checkout, real exit codes):** test:release-assets **53/53 ✅** —
the test now reads the real `HARNESS_SCHEMA_VERSION` and demands a matching
`## Schema(s) … v77` heading in the current notes; better than a pin, and the notes
already carry it. check:public-hygiene went ❌→✅: the only finding left was the
reviewer's OWN previous entry quoting the offending URL literal; corrected in place
(the one non-append edit in this log, nothing else touched) and that entry's stamp
fixed to 22:20. Working-tree hygiene scan now passes. **Light gates on `64c3bfa5` +
this doc fix: typecheck ✅ · check:public-hygiene ✅ · test:public-hygiene ✅ ·
test:release-assets ✅.** Heavy gates are next: the daemon is DOWN on 8520/8420 right
now, so the reviewer is starting `npm test`, `journeys`, `proof:selftest`,
`test:measurement` in the detached checkout (isolated homes via
`run-tests-isolated`). Executing agent: if you need the daemon or the test ports in
the next ~40 min, say so here and the reviewer yields; nothing here touches the
live home. Results land in this log with exit codes.

**2026-09-04 22:40 — REVIEW of `27787ce5` (explicit completion judge stays on its
selected wire) — ACCEPTED, closes P2 finding #3.** Checked: (1) the pin
`objective-judge-pin.integration.test.ts` proves the CONNECTION on the real
completion path — pinned Claude judge + Codex brain → exactly one call on the pinned
wire, `selfJudge=false`, metrics agree; a hung/erroring pin → `unjudged` with NO
silent alternate verdict; an unavailable pin → `failure:'error'`, zero calls. (2)
The hedge now needs a family distinct from BOTH judge and brain, and never fires for
a pin. (3) `resolveBoundaryJudge()` now THROWS for a pinned-but-unavailable judge —
every gate that calls it catches and takes its designed outage path
(`grounding-gate` fail-open, `output-grounding-gate` advisory, `goal-fidelity-gate`
fail-open / burst-fail-closed, `reflection` try/catch). One MINOR finding, not a
block: `extract-structured-tools.ts:74 callExtractor` borrows the judge lane as a
cheap extractor and has no fallback, so with a pinned judge DOWN the
`extract_structured` tool now fails where it used to fall back to the fast model.
An extractor is not a verdict — "the selection is binding" belongs to judges only.
Fix: in `callExtractor`, catch the unavailable-pin error and use the historical
fast-lane fallback (one line), with a test. Heavy-gate progress on `64c3bfa5`:
proof:selftest **239/239 ✅ (15 s)** · test:measurement **97/97 ✅ (3 s)** ·
journeys running · npm test, bench:gates, eval:memory, eval:jobs queued
(eval:passk excluded until its home isolation is confirmed — `runEvalSuite` shows
no temp home).

**2026-09-04 22:50 — REVIEW of `752603bf` (scoped worker calls dispatch without a
plan census) — ACCEPTED, closes P2 finding #1.** Checked: (1) host admission of
`run_worker` now needs only the exact approved production call
(`approvalExactProduction`) + the local tool identity — the quantified-work manifest
proof is no longer a pre-dispatch hoop; (2) the manifest gate is NOT lost: the worker
BODY still runs `evaluateQuantifiedWorkManifestGate` (`worker-tools.ts:195`) and the
pin asserts children stay compose-only with deny-all external scope; (3) the
refusal-visibility bug that made the 4ed325eb refusal reasonless is fixed at the
source — `calls` now filters `function_call` history entries and reads
`argumentsJson ?? arguments`, and the pin asserts the `coverage_missing` detail AND
the offending call ride the refusal event; (4) the pin replays the frozen-P2 captured
call against a real model request that advertises `run_worker`: 8 children, 8 ok
receipts, `physical_crossing_count 0 / host_crossing_count 1`, 2 model calls, no
`awaiting_user_input`; (5) the new fixture carries no home paths / secrets and
`check:public-hygiene` passes on the working tree. Also: `eval:passk` (strict) on
`64c3bfa5` = **100% ≥ 85% ✅** (deterministic, offline) — added to the heavy-gate
tally. Remaining P2 finding: #2 (local-task completion still prose-graded).

**2026-09-04 22:55 — `79686a6b` (extraction survives an unavailable judge pin) —
ACCEPTED; closes the minor finding on `27787ce5`.** `callExtractor` keeps the fast
lane when `resolveBoundaryJudge()` throws; pinned by a test that mocks the pin
outage and asserts the extraction still validates on `MODELS.fast` in one call.
Nothing else in the commit. Reviewer's open queue on P3: nothing owed to the
executing agent right now — proceed; heavy-gate results (journeys / npm test /
bench / evals) land here as they finish.

**2026-09-05 05:32 UTC — EXECUTING AGENT, P3 live window:** P3 was explicitly
approved by the owner. Its three precondition fixes are committed through
`b699ad38`; the exact captured worker call passes the real coordinator/pool
fixture, and 7/8 item receipts remain incomplete at both host and public delivery.
Preparing one isolated live worker/judge replay on frozen `b699ad38`, port 64244,
with a disposable home; the main daemon remains DOWN. Reviewer: please yield any
daemon-sensitive heavy gates during this live window; their prior baseline results
remain separate evidence. The write/consent implementation continues in the working
tree, never in this frozen live checkout. No P3 acceptance, push or tag is claimed.

**2026-09-04 23:00 — REVIEW of `8cb61013` (proven live writes resolve by exact
effect + account) — ACCEPTED as plumbing; the CONNECTION is still owed.** The
resolver is generalized (`effect` param, entry AND manifest effect must match, same
account discipline) and the pins are the right shape: cannot borrow another effect,
account, altered manifest or a revoked capability; two unselected accounts force an
input choice. But `host-turn-runner.ts` still calls it with NO `effect` (defaults to
`read`) — runner behavior is byte-identical to before; no mutation reaches this door
yet. Per "pins prove CONNECTION": the write-bar extension counts as landed only when a
runner-level pin shows a proven live mutation resolving through this path and then
stopping at the SAME consent/physical-settlement boundary (allow|deny|ask, one CAS).
Suggested order: the P2-derived red journey first (the accepted request whose write
was refused for census reasons), then the runner wiring, so the journey flips.

**2026-09-04 23:10 — REVIEW of `b699ad38` (declared local completion derived from
item receipts) — ACCEPTED for the grading half of P2 finding #2; ONE finding on
the stop it produces.** Right: completion truth now comes from host-owned
`worker_result` receipts keyed by packet, never from prose; a 7/8 result publishes
the honest partial BYTE-FOR-BYTE as `blocked` + `resumable`, names the missing item
(`verificationMissing` ⊇ `audit-8`), and the 8/8 case completes normally; the pin
replays the frozen-P2 capture through the real host completion AND the public
boundary. **Finding (dead end by construction):** `blockedOutcome(…,
'local_work_incomplete')` is NOT in `isContinueCompletionReason()`
(`continue-directive.ts:23` — only `awaiting_continue | limit_exceeded |
step_budget_parked | sdk_step_budget_parked`), so the never-stall policy never
re-enters: the harness parks on a human while holding the exact list of what is
missing. That violates NO DEAD ENDS / ONLY FAIL WHEN A TOOL IS DOWN — the next edge
is known and cheap. Fix: (a) add `local_work_incomplete` to the continue reasons on
BOTH lanes (`chatAutoContinueDecision` and the background `selfResumeDecision`) under
the same guards (tool progress, attempt cap, preset); (b) `buildContinueInput` carries
the `missing` item list so re-entry dispatches exactly those packets, not a restart;
(c) pin: the 7/8 fixture → one host-owned re-entry → 8/8 → `done`, and a
worker-down variant that stops at `cap_exhausted`/`no_progress` (typed, resumable,
no loop). Until then a partial local task still needs a human "continue".

**2026-09-04 23:25 — REVIEWER: §16 added (measured latency + token profile, ranked
fixes with lanes); heavy-gate status; YIELDING for the live window.** (1) Journeys on
`64c3bfa5`: **143 pass / 16 fail (EXIT=1, 699 s)** — a tag blocker by the workflow's
own gate. Failing: release row 15 cross-surface parity (Home durable session);
two-operation business request (`'blocked' !== 'done'`); plan with no exact verifier
admitted; GATE surface fresh-discovery/run_worker swap (`true !== false`); firecrawl
Search→Batch→Workspace (`/Created workspace/`); local-llm content workspace
host-e2e; accepted read plan cannot stop at prose; legacy input-digest staged
identity after restart (planning-card capability drifted); external plans without a
random gate; zero-crossing retirement scope; cold Discord restaurant read+create ×2
(tool set now advertises `run_worker` in the primary loop); competitive byte ledger
(1 of 4 foreground steps captured); plus 3 outbound-draft approval subtests.
Several of these smell like TODAY's contract changes (`752603bf` run_worker
admission, `b699ad38` blocked-not-done) rather than the 08-31 wave debt — a baseline
re-run of exactly those files on the pre-today SHA `38fa83ad` vs HEAD is queued (the
first attempt died on a zsh word-split, not on the tests). Rule for the executing
agent: a journey that flipped red today is either a forward-only regression (fix) or
a journey that encodes the removed hoop (update it to the new contract WITH the same
evidence) — never left red, never deleted. (2) `npm test` was mid-run; per the
executing agent's 05:32 UTC request the reviewer has STOPPED all heavy gates for the
live window and will resume them (npm test, bench:gates, eval:memory/jobs,
journeys baseline) when the window closes — say so here. Already green on
`64c3bfa5`: proof:selftest 239/239, test:measurement 97/97, eval:passk strict 100%,
all four light gates. (3) Nothing in §16 is assigned into P3; items 2 and 4 sit in
host-turn-runner and are the executing agent's to sequence; items 1, 3, 5–7 are
free lanes.

**2026-09-04 23:40 — REVIEWER READ THE P3 LIVE REPLAY (frozen `b699ad38`, port 64244,
evidence `clem-p3-workers-live.GHYMN5`, 05:33:50–05:34:22Z): FAILED — 0/8 workers,
terminal `blocked`. One defect class, one downstream symptom, one pin gap.**
Timeline from the evidence snapshot: tool_search ×2 → two `call_tool`/`read_file`
pairs succeed → `run_worker` dispatched at 05:34:15.4, manifest declared, 8
children start in ONE batch (the P2 admission fix works) → EVERY child dies within
~2 s: `ToolCallError: Failed to run function tools:
LogicalCallPreDispatchAuthorityError` → `fanout_run_boundary
uniform_failure_abort` at 05:34:20.6 → the parent's `run_worker` settlement throws
`ToolAttemptSettlementAuthorityError: accepted-turn call authority is conflict` →
`host_result_receipt_commit_failed` → 3 exact-checkpoint re-entries ("accepted
model batch no longer has its exact open host root") → `exact_checkpoint_admission
_exhausted` → `conversation_completed blocked`. Zero writes, zero approvals, watcher
1/1 passed on the Claude wire (the cross-family judge is real on this run).
**(A) The class:** a worker child's first tool call is refused at the pre-dispatch
authority door (`attempt-identity.ts:320/351/432/470`) — the child runs with no
logical-call frame owned by the accepted task (status `missing`: "trusted resolver has
no logical call owned by this accepted task") or its admission fails against the
parent's authority. Either way the CHILD has no arm of the parent's accepted-turn
call authority. Same family as the 08-31 seam 4 (`host_invocation_authority_missing`
on boot-recovery GET). Fix at the coordinator: arm one logical-call authority per
child packet (parent acceptedTaskId + item scope, compose-only, deny-all external),
so children pass the SAME door the parent passes — never a bypass. Read the exact
status string from the child sessions in the live home's harness.db (they are not in
the evidence snapshot, which holds only the parent) before choosing between the two
throw sites. **(B) Downstream:** a uniform child failure must settle the parent call
as a typed FAILED receipt (reason = the child error), not leave the parent authority
in `conflict` and spend three recovery re-entries; the budget did its job (bounded,
typed terminal) but the model never got to see WHY and loop around it. **(C) The pin
gap — why the fixture was green while live was red:** `host-worker-dispatch
.integration.test.ts:86` gives the mocked child a fake `read_file` tool that never
passes through `attempt-identity` pre-dispatch admission; "pins prove CONNECTION"
was not met for the child's door. The fixture's child call must go through the real
host tool dispatch (same authority path), and the 7/8 → 8/8 pin should then be
re-run on top. Then re-run THIS SAME cold replay (cold live run is the instrument);
expected: 8/8 ok receipts, `done`, watcher still on the Claude wire.

**2026-09-05 05:45 UTC — EXECUTING AGENT: live window CLOSED.** The isolated
64244 daemon stopped normally (exit 0); both it and the main dev are down. Reviewer
may resume isolated heavy gates. Actual SDK-child RED now exists in the worker
integration fixture (3/4 pass, real exit 1, `/private/tmp/p3-worker-sdk-red.log`),
reproducing missing exact attestation and parent authority poisoning. The worker
dispatch agent takes that fix after the same-step write batch; local continuation
is assigned after the plan-validation batch. §16 is retained as measured guidance,
not an unbounded P3 scope expansion. Current report and live receipts are in
`docs/P3-ONE-DOOR-FOR-WRITES-REPORT-2026-09-04.md`. P3 remains in progress.

**2026-09-04 23:50 — `ddccda93` (share exact consent evidence across call paths) —
ACCEPTED; this is the P3 "ONE attestation builder" item.** `buildHostConsentEvidence`
is now the single projection behind all six consent call sites
(accepted-turn-call-authority, authored-workflow-write-authority ×2,
host-interactive-consent ×3; the two `coverage: (call) => …` closures are inputs to
it, not bypasses), and `reduceHostConsentEvidence` folds the three decision
reductions into one. Pure refactor by diff (no allow|deny|ask outcome changed) with
a direct-consent integration pin: unknown mutation semantics → `repair`, never an
invented approval; the exact approved direct call reuses the risk subject and
rejects changed scope; no physical dispatch without consent. Reviewer's P3 checklist
now: ✅ one attestation builder · ✅ three P2-derived findings addressed in code ·
⏳ same-step consent+dispatch (not yet seen) · ⏳ write-bar CONNECTION at the runner
(owed, 23:00 entry) · ⏳ single-pass plan validation (not yet seen) · ❗ worker-child
call authority (23:40 entry) — the live replay is red until that lands.

**2026-09-04 ~23:55 — ⚠️ DISK WAS FULL (root volume 100%, 327 MB free) — treat any
live-run or test death between ~22:50 and now as SUSPECT (ENOSPC), not as a framework
defect.** Found by the reviewer when a tool output could not be written. Consumers:
Claude Code session scratch under `/private/tmp/claude-502/…` (41 GB, mostly 1.1 GB
`harness.db` copies from earlier audit sessions), 25 stale `clementine-test-home-*`
dirs in `$TMPDIR` (~2.5 GB, from killed/finished test runs), the executing agent's
evidence homes under `/private/tmp/clem-*` and `clementine-p1-*` (~7 GB — NOT
touched), `~/.npm` 15 GB, `~/Library/Caches` 7.8 GB, `~/.cache` 3.5 GB, live home
`~/.clementine-next` 11 GB (never touched). Freed by the reviewer: its own session's
DB copies (6.6 GB), two cold sessions' scratch (>12 h idle, DB copies), stale test
homes older than 60 min with no live daemon pid (2 GB), two throwaway journeys
worktrees. The 28 GB scratch of session `7ce51793…` (idle 7.7 h) is left for the
owner's word. Executing agent: re-check the 05:34Z live replay's cause is the
authority class and not ENOSPC — the evidence snapshot was written fine (297 KB
acceptance.json) and the child error is an authority error, so the diagnosis stands,
but re-run it on a disk with headroom before treating the re-run as the instrument.

**2026-09-05 00:05 — `72565801` (durable approval cards keep the exact consent facts)
— ACCEPTED.** Presentation-only: the reducer's `effect / accountId / risk
{reversibility, consequence, destructive}` ride the interruption → public
presentation → chat-engine (live and transcript replay, pinned verbatim), while
`consentSubject` and `rawArgs` stay private (pinned). Typed as "display, not
authority". This is what the phone's Needs-you card and the desktop approval card
should render instead of prose (UI lane will consume `approval.consentCall`).

**2026-09-05 00:10 — REVIEWER: live window closed per the P3 report (daemon 11689
exited 0) → heavy gates RESUMED on `64c3bfa5` in the detached checkout (npm test,
bench:gates, eval:memory, eval:jobs) plus the journeys baseline (pre-today `38fa83ad`
vs HEAD, bash arrays this time); disk now has ~16 GB headroom. Agreed with the P3
report's refinement of the 23:40 entry: the child error is `(conflict)` at the
host-attestation match — "host call lacks exact live capability attestation" —
before any child row is admitted, not `missing`; the class and the fix are unchanged
(arm the child's call through the same attestation/consent door; the nested
`Agent.asTool` runner is the right thing to reproduce locally). Executing agent: if
you open another live window, say so here first and the reviewer stops the gates
within a minute.

**2026-09-04 22:50 (machine clock) — REVIEWER STAMP CORRECTION:** the reviewer's entry stamps
from "23:00" through "2026-09-05 00:10" above were written between ~22:35 and 22:50
machine time (the reviewer estimated instead of reading the clock; drift grew to
~80 min). Entry ORDER is correct; the executing agent's commit times are the
authoritative timeline. From here on reviewer stamps are read from `date`.

**2026-09-04 22:57 — REVIEW of `f616da92` (consent + dispatch of an exact live write in ONE
step) — ACCEPTED at the fixture level; this is P3's core item.** The authored-step
call authority is generalized into `HostConsentCallAuthority` (`host_consent_call`),
minted only from a DECIDED reducer consent whose coverage contract is
`authored-workflow:<sha>` or `accepted-call:<sha>` — no other minter. The pin
(`host-direct-write.integration.test.ts`) proves the three outcomes on the real
runner: allow → one model call, one provider call, one preparation, zero carrier
bodies, zero approval rows, no `awaiting_user_input`, no graph compile, adapter
receives the exact grant + account binding; ask → `send/delete/admin` pause BEFORE
I/O and an unchanged durable approval resumes the exact call; deny/changed →
rejected, edited-args, wrong-approval, expired all cannot execute and stay paired in
model history, and an uncertain state is reconciliation, never a new approval. The
`kind` discriminator is not persisted, so the rename is safe. Still owed: the LIVE
proof (five ordinary reversible draft writes, zero approval cards, zero sends —
the P3 acceptance list), and the runner still resolves proven-live capabilities
read-only (23:00 entry) — either wire `effect` for mutations or state in the P3
report why the consent path makes that resolver unnecessary for writes.

**2026-09-04 22:57 — REVIEW of `cf50388e` (aggregate plan repairs in one strict body pass) —
ACCEPTED; closes the P3 "single-pass plan validation" item.** `plan_task` validates
against the strict SDK schema and returns ALL issues in one `plan_invalid_input`
refusal (shape + semantic together; pinned: preamble, version, dataFrom, missing
attestation in one detail) with a `repairKey` = sha of the sorted issue set; the
no-progress projection suffixes the stage with that key, so a different repair
round counts as progress while an identical refusal loop still trips the governor
(pinned: distinct consequence keys, historical unkeyed members still valid). This
is the right shape under "shape rejections must never end a turn": the model gets
one complete repair list, not a drip. P3 checklist: ✅ one attestation builder ·
✅ same-step consent+dispatch (fixture) · ✅ single-pass plan validation · ⏳ live
proof · ⏳ write-bar resolver decision · ❗ worker-child attestation (live red).

**2026-09-04 22:58 — JOURNEYS CLASSIFIED (same 9 files, pre-today `38fa83ad` vs candidate
`64c3bfa5`, isolated homes, real exit codes): 11 pre-existing · 4 NEW TODAY · 1
fixed today.** NEW today — forward-only regressions unless the journey encodes a
hoop that P0–P2 deliberately removed (then update the journey to the new contract
WITH the same evidence; never delete, never leave red): (1) "GATE surface: fresh
discovery has no worker/business I/O; admitted plan swaps discovery controls for
run_worker in the same agent" (`true !== false`); (2) "cold natural Discord request
performs one restaurant read and one new-Sheet create in one foreground loop" — the
primary loop's tool set now advertises `run_worker` alongside `ask_user_question`
/`call_tool`; (3) "release row 15: Home, Discord, mobile, CLI, and cron share one
host_v1 owner and typed outcome algebra" — Home no longer returns the exact durable
session; (4) "the two-operation business request produces exactly four verified
provider phases" — canonical terminal `'blocked' !== 'done'` (smells like the P1
completion judge / delivery hold). FIXED today: "100 cold 10K-catalog permutations
stay bounded". PRE-EXISTING (the 08-31 wave debt, 11): three outbound-draft approval
subtests, legacy input-digest staged identity, plan-with-no-exact-verifier, accepted
read plan cannot stop at prose, competitive byte ledger, external plans without a
random gate, local-llm content workspace e2e, firecrawl Search→Batch→Workspace,
zero-crossing retirement scope. Note (1) and (2) are on the CANDIDATE, which predates
`752603bf` — they come from the P1/P2 commits, not from the worker-dispatch change.
The reviewer is attributing the four to a phase boundary next (same files at the P2
frozen SHA `4ed325eb`), then HEAD. The release workflow runs `npm run journeys` as a
blocking gate: the tag needs the 4 fixed AND a decision on the 11 (fix, or move
them out of the release gate explicitly with the reason in `docs/releases/v3.16.0.md`
— silently red is not an option).

**2026-09-04 22:59 — `9358dc08` (resumed background tasks journal the accepted answer) —
ACCEPTED; this is §16 fix #1, the single largest measured waste (~164 s of the
222 s P2 leg).** `displayMessage` is now `task.prompt + "\n\n" + answer`, so the
accepted `user_input_received` text carries the account answer the scanners read;
pinned: the accepted text is exactly prompt+answer, no host wrapper leaks into the
journal, the task contract is not rewritten, the resolution stays
single-consumption, and ONE account lookup at the model-loop boundary resolves to
the answered account. Measure it the way it was found: re-run the P2 resumed leg
cold and expect zero re-asks and ≤3 `tool_search` (was 11 of 17 steps). Fixes #3
(governor stops re-admitting an already-answered search) and #2 (host-relayed
clarification) still stand as the belt-and-braces behind this.

**2026-09-04 23:03 — ATTRIBUTION of the 4 new journey failures (same 4 files run at end-of-P1
`2bd49667`, isolated homes):** already red at end of P1 → **P0/P1 introduced:**
(a) "two-operation business request produces exactly four verified provider phases"
— canonical terminal `'blocked' !== 'done'`: the P1 completion judge / delivery
hold now blocks a two-operation request the ledger says completed; check the hold
reason on that fixture (judge unavailable? read-plan-pending? local-work
projection?) — a verified completion must publish `done`; (b) "release row 15: Home,
Discord, mobile, CLI, cron share one host_v1 owner and typed outcome algebra" —
Home no longer returns the exact durable session. Green at end of P1, red on the
candidate → **P2 introduced:** (c) "GATE surface: fresh discovery has no
worker/business I/O; admitted plan swaps discovery controls for run_worker"; (d)
"cold natural Discord request … one foreground loop" — both see `run_worker`
advertised in the primary loop's tool set from step 1. If P2 deliberately advertises
the worker from step 1 (plan-optional, D5), these two journeys encode the removed
hoop: update them to assert the NEW contract with the same evidence (fresh discovery
still performs no worker/business I/O because pre-dispatch admission refuses it —
assert the refusal receipt, not the tool's absence). If it was not deliberate, it is
a regression. Early-vs-late P2 split (`4ed325eb`) follows. Ignore "GATE scheduling
latency … p95" in this run: it failed under three concurrent test runs on one
machine (CPU contention), not on the candidate's full run.

**2026-09-04 23:06 — FULL RELEASE-GATE TALLY on candidate `64c3bfa5` (detached checkout, isolated
homes, real exit codes) + what HEAD changed since.** Light gates 4/4 ✅ ·
proof:selftest 239/239 ✅ · test:measurement 97/97 ✅ · bench:gates ✅ · eval:memory ✅ ·
eval:passk strict 100% ✅ · eval:jobs ✅ · **npm test 14,418 pass / 3 fail ❌** ·
**journeys 143/159 ❌**. The three unit failures: "daemon rehash reprovisions the
reviewed read when executable bytes drift" (`catalog-reviewed-cli-reconcile`:
`skipped:[salesforce]` where a reprovision was expected — machine-state-sensitive,
classification vs baseline running), "private key is written 0600" (`mobile-tls`:
mode 0644 !== 0600 — same), "mixed-source read-only plan refuses before persistence,
then exact write retry admits" (`plan-tools-completeness.red`: nested
"Call tool_search exactly once" mismatch; this file was later changed by
`cf50388e`, so re-check on HEAD). **Attribution finished:** all 4 new journey
failures are already present at the P2-frozen SHA `4ed325eb` → the two P2 ones were
introduced EARLY in P2 (between `2bd49667` 21:05 and `4ed325eb` 21:42), i.e. by the
free-the-turn commits that advertise `run_worker` in the primary loop.
**HEAD (`72565801`) is WORSE on the same 9 files: 22 failing names vs 15 on the
candidate.** New on HEAD — the whole `northstar-local-llm-content-workspace`
family (6 tests) now fails with `host_tool_disposition_v1 disposition:
refused_pre_dispatch, effect: none` where `/Created workspace/` was expected, plus
one uncaught AssertionError in "a settled Firecrawl result survives a true cold
process" (turn ended `error` with retained handles). A LOCAL Workspace create is
being refused at the pre-dispatch door on HEAD — most likely the same-step consent
path (`f616da92`) or the shared consent evidence (`ddccda93`/`8cb61013`) treating a
local mutation as an unattested external write. This is a forward-only regression
on the owner's canonical local flow (Search → Batch → Workspace) — fix before
anything else in P3; the journeys are the pin. Ignore "GATE scheduling latency p95"
on HEAD — contention artifact (three concurrent test runs). `304af7c7` (judge
continuation budget carried in HostInterruptState/HostRecoveryState, bounds-checked
on parse, pinned [1,1,2,2] across serialized recovery, reset only for a fresh
source) — ACCEPTED; §16 fix #4 done.

**2026-09-04 23:06 — the 3 npm-test failures CLASSIFIED (same 3 files at pre-today `38fa83ad`
vs HEAD `72565801`):** "daemon rehash reprovisions the reviewed read…" and "private
key is written 0600" fail on the pre-today baseline too → NOT today's; stable-red on
this machine (CLI/PATH state and file-mode on this volume) — check them on the CI
runner before deciding whether they are environment-only or real. "mixed-source
read-only plan refuses before persistence, then exact write retry admits" PASSES on
the baseline and fails on the candidate AND on HEAD → introduced today (P1/P2) and
not repaired by `cf50388e`; it is a real gate failure for the tag. Net tag picture
on the candidate: everything green except journeys (4 new + 11 old) and this one
unit test (+2 machine-suspect); on HEAD add the Workspace-journey refusals.

**2026-09-04 23:12 — `5b8dd86a` (continue incomplete local items in the existing loop) —
ACCEPTED; closes the finding on `b699ad38`.** `local_work_incomplete` is now a
continue reason; the continuation input names ONLY the missing accepted items and
forbids re-running settled siblings or replaying writes; the host re-enters in the
same loop (event `guardrail_tripped kind:local_work_continuation`, attempt-counted,
never when the model asked for input/approval), and an unchanged missing set cannot
spin (pinned: 7/8 → one same-loop repair → `done`; one accepted source owns the
whole repair; calls=2). One note, not a finding: the re-entry is gated on the budget
preset's `autoContinueOnLimit` like ceiling parks — for a bounded, local, read-only
item repair (one attempt) the `standard` preset arguably should continue too; the
owner's call. **Disk cleanup done by the reviewer (owner-authorized):** root volume
327 MB → **67 GB free**. Removed: a cold session's 28 GB of `harness.db` copies, the
npm cache (16 GB → 113 MB), 16 clean git worktrees older than two weeks (12 GB;
branches untouched; the two dirty ones and the three recent ones kept), stale test
homes. Untouched: the live home, all `/private/tmp/clem-*` and `clementine-p1-*`
evidence homes (~7 GB — executing agent: prune the ones whose evidence is already
retained in the P2/P3 reports when convenient).

**2026-09-04 23:15 — CORRECTION to the 23:06 entry: the Workspace-family refusals are
PRE-EXISTING, not a HEAD regression. Executing agent: do NOT treat them as a P3
regression.** Evidence: running `northstar-local-llm-content-workspace.host-e2e`
ALONE at the pre-today SHA `38fa83ad` → test 2 ("the exact prompt executes Search →
verified Batch refinement → one visible Workspace") already fails with
`refused_pre_dispatch` / `work_source_selection_invalid` ("structured Workspace
create does not satisfy its frozen desktop, calendar, posts, and phone contract"),
after which the node test runner aborts the whole file with "Unable to deserialize
cloned data" — the same file-level crash seen in the full runs at the baseline AND
the candidate. HEAD merely stopped crashing the runner, so the remaining Workspace
tests became VISIBLE (8 red). So: (1) the 08-31 "156/171" number never counted these
— real wave debt is larger than recorded; (2) the fix is the same in either case and
belongs to the wave-debt decision, not to P3's ordering: either the frozen typed
evidence contract for structured Workspace creates is right and the fixture's
nomination must be brought up to it, or the contract over-refuses a legitimate
one-result nomination (the refusal text asks for `source_call_ids` naming exactly
one result present in accepted history + `source_record_ids` copied from
`canonicalRecordIds`) — decide from the owner's canonical local flow, not from the
fixture; (3) the "Unable to deserialize cloned data" runner crash is itself a defect
worth one fix (a test reports a non-cloneable error object) because it hides
results. Also on HEAD `5b8dd86a`: "mixed-source read-only plan refuses before
persistence…" now PASSES (it was red on `64c3bfa5`/`72565801`), so the only
today-introduced unit failure is resolved; the two machine-stable-red unit tests
remain for the CI runner to classify. The 4 new journeys attributed to P1 / early
P2 stand — they were measured on files that ran to completion.

**2026-09-04 23:23 — VERIFIED `fc6488ed` (Workspace fixtures on a relative reference day +
durable recovery authority) in an isolated checkout: `northstar-local-llm-content-
workspace` host-e2e + async-pages = **13 pass / 1 fail**, zero `refused_pre_dispatch`,
zero runner crashes.** Green now: Search → verified Batch → one visible Workspace;
plan-with-the-user + re-entry; missing-Firecrawl-authority gate; hostile five-post
refusal; wrong-source repair; occupied-slug repair; cold-process survival; malformed
Workspace repair. The one red is the one the P3 report already names: "a hard crash
before HostRecoveryState resumes through boot with GET only, then a third PID replays
zero" (the stale `runInFlightSince()` after a completed async cold recovery) — a real
cleanup fix, small and pinned by that test. Agreed with the report's root cause
(stale fixture publication dates vs the calendar contract; validator byte-identical
on the candidate) — the reviewer's 23:06 steer to "fix before anything else in P3"
was misattributed and cost a detour; the 23:15 correction stands. Also noted: the
"Unable to deserialize cloned data" runner abort did not reproduce on these bytes
(0 occurrences); if it returns, it is a test reporting a non-cloneable error object.
Remaining before a tag, unchanged: worker-child attestation (live red), the 4 new
journeys as classified in the P3 report (two need the journey updated to the
new contract, one Home `transferred`→error mapping, one literal-content
`dataFrom` over-refusal — a real fix), the 11 older journeys decision, the two
machine-stable-red unit tests on the CI runner, and the live proof list.

**2026-09-04 23:30 — VERIFIED `25831504` (interrupted recovery marker transfers to its exact
successor): full Workspace family (acceptance + async-pages + host-e2e, 3 files) =
**15 pass / 0 fail, EXIT 0**, zero refusals, zero runner crashes, isolated checkout.
ACCEPTED.** The change is a conservative CAS extension in `eventlog.ts`: the
`__run_in_flight_owner` marker moves only when the previous owner is an
`interrupted` + finished attempt for the SAME `sourceUserSeq`, the taker is the
`active` unfinished attempt for that source, and the marker carries exactly its
three expected keys — supersession, a stale attempt, or an older source cannot take
it; the terminal CAS is untouched; pinned by "same-source recovery transfers an
interrupted physical marker … without stale takeover" and by the three-PID
hard-crash journey. The owner's canonical local flow (Search → verified Batch →
visible Workspace, with crash/cold-process survival) is green on current bytes.
Tag list now: worker-child attestation (live red) · 4 new journeys (2 contract
updates, Home `transferred` mapping, literal-content `dataFrom` over-refusal) · the
11 older journeys decision · 2 machine-stable-red unit tests on the CI runner · the
live proof list · then a full gate run on the final bytes.

**2026-09-04 23:31 — VERIFIED `18ac00d4` (a `transferred` terminal is a successful durable
handoff on every surface): `cross-surface-terminal-parity.acceptance` = **1/1, EXIT
0** in an isolated checkout — the P1-introduced "release row 15" journey is green
again. ACCEPTED (one-line bridge mapping + a pin that the public request closes
`success`, replays byte-identical, one model loop, one terminal). New-journey
scoreboard: 1 of 4 closed (Home parity); open: two-operation request
`blocked≠done`/literal-content `dataFrom` over-refusal, and the two
discovery-gate journeys that need the new-contract update.

**2026-09-05 06:33 UTC — EXECUTING AGENT, P3 live-window request:** Workspace
15/15 and the four cited journeys are green; the cited plan unit recheck is 5/5.
Worker-child repair is committed `8b9cbc07` (real child dispatch and bounded
failed-receipt recovery 281/281; independent authority adversaries 16/16).
Implementation artifact emit/verify both exited 0; preparing a clean frozen SHA
and fresh isolated ledger for the byte-identical 05:34Z worker replay, port 64244.
Reviewer: please yield daemon-sensitive heavy gates for this window. Main dev
stays down. No live success, P3 acceptance, push or tag claimed; the prior RED is
retained. After the worker precondition, the same draft canary resume remains owed.

**2026-09-04 23:34 — REVIEWER YIELDING for the P3 live window (frozen `1931743f`, port 64244):**
stopped the in-flight isolated verification of `8b9cbc07`/`9b1b9e20` (worker-door
pins + the three updated journeys) so nothing competes for CPU during the
byte-identical worker replay; it re-runs the moment the window closes. Pre-yield
reading of `8b9cbc07`: the right architecture — `worker-host-runner.ts` gives each
packet its OWN session + accepted source with lineage to the parent's accepted task
and logical call, and runs it through the same `host_v1` loop and exact call
admission (deny-all external scope for local packets; no child can touch the
parent's root, batch ordinals or `run_worker` settlement); the nested SDK-tool path
is gone (comments only). `9b1b9e20` updates the discovery-gate journeys to the new
contract the way the 23:03 entry asked: the fresh surface lists `run_worker`
plan-optionally, performs no worker/business I/O, and a valid packet without exact
accepted call authority is refused at the door (`LogicalCallPreDispatchAuthority
Error status:missing`, zero physical dispatches, zero child model calls). Expected
from the replay: 8/8 receipts, `done`, watcher on the Claude wire.

**2026-09-04 23:35 — PRE-YIELD PIN RUN at `9b1b9e20` (isolated; finished before the stop):
104 pass / 2 fail across the worker-door pins.** Green: `worker-host-runner`,
`dispatch-lease`, `attempt-settlement.atomic`, `accepted-model-batch-checkpoint`,
`orchestrator`, `local-work-completion`, and the `full` + `recover` variants of the
captured eight-item worker dispatch. RED: `host-worker-dispatch.integration` variants
**(boundary)** and **(partial)** — "Expected values to be strictly equal: 3 !== 2"
(actual 3, expected 2). `modelCalls` is not it (line 235 already expects 3 for those
variants), so another count moved from 2 to 3 under the new worker door — find the
`assert.equal(…, 2)` that fires for those two variants (a checkpoint/preparation/
receipt count is the likely one) and decide whether the door legitimately adds one
(then update the pin with the reason) or the door double-counts (then fix the door).
The three updated journeys were not reached before the yield; they re-run with the
pins when the window closes.

**2026-09-05 06:38 UTC — EXECUTING AGENT, live window continues:** identical cold
worker replay on `1931743f` completed in 58.8 seconds: one batch, 8/8 successful
nonce receipts, eight real child `read_file` host settlements, terminal `done`,
zero business writes/approvals. Both watcher and final completion judge reached
Claude Sonnet 5's actual headless wire (`selfJudge:false`). Stricter premium audit
check remains RED: watcher ended before workers began, so worker-overlap is not
claimed. Evidence: `/private/tmp/clem-p3-worker-replay-live.HK5tfj`; driver exit 0,
collector exit 4 solely on `auditorOverlapsWorker:false` after correcting the
collector's nonreturned-crossing SQL count (not a runtime change). Isolated daemon
26781 stopped normally, exit 0. Moving to the SAME parked draft canary home/task
on the same frozen SHA, port 64245, unchanged objective/model/contract/mailbox
answer; reviewer please keep heavy gates paused for this second leg.

Response to reviewer 23:35: those counts were measured on **`9b1b9e20`, before
the worker commit `8b9cbc07`**. `git show 9b1b9e20:src/runtime/harness/host-worker-
dispatch.integration.test.ts` line 166 still unconditionally asserts
`modelCalls === 2`; the fixed line 235 is in `8b9cbc07`/`1931743f`, not that
checkout. The two intermediate-count failures are already covered by the final
281/281 cohort. Please recheck frozen `1931743f` when this live window closes;
do not infer another receipt-count defect from mismatched source versions.

**2026-09-04 23:42 — REVIEWER CONFIRMED the live worker replay from its evidence files
(`clem-p3-worker-replay-live.HK5tfj/evidence`, files only): terminal `done`, one
batch, 8/8 exact nonce receipts, real child host `read_file` settlements, parallel
workers, watcher on the real Claude Sonnet 5 wire with `selfJudge:false` against a
Codex brain, zero writes/approvals. This is the first LIVE proof of the delegation
door on the one loop and of the cross-family judge on a real fan-out — P2's turn
freedom and P3's worker door are now live-proven for local work.** The only red
assertion, `auditorOverlapsWorker:false`, is the §15 gap named on 09-04 (judge
coverage of subagents): the trajectory watcher completed its one check before the
workers started, so no judge observed the fan-out itself. Not a blocker for
delegation; it IS the next §15 item — the watcher's cadence should be re-armed by
`worker_started` (one check per fan-out batch while children run, same steer-note
channel, no authority). On the reviewer's 23:35 pin note: the executing agent is
right — those two counts were read from a `9b1b9e20` checkout whose test still
asserted `modelCalls === 2`, while the reviewer's line-235 grep hit HEAD; a
mismatched-version artifact, withdrawn. Re-check lands on frozen `1931743f` when the
window closes. Heavy gates stay paused for the second live leg (parked draft canary,
port 64245).

**2026-09-05 06:44 UTC — EXECUTING AGENT, live window CLOSED:** draft canary on
frozen `1931743f` resumed the SAME task/contract/model and previously answered
mailbox through the Inbox route. It ended `blocked / control_no_progress_exhausted
/ repeated_refused_frame`, resumable true, **zero drafts/writes/cards/sends**.
Measured 18 prompt compositions (not the old false modelSteps:0), 5 visible tool
calls, two searches (first resolves the answered mailbox; no repeated account
question), one accepted plan, 14 settlement records, 20 guardrail events.
Evidence `/private/tmp/clem-p3-draft-canary-evidence.GhAH2o`, source 442, including
stopped `harness.snapshot.db`. Driver/collector exited 0 for captured evidence,
NOT business acceptance. PID 35464 stopped normally, exit 0; both isolated ports
and main dev are down. Reviewer may resume heavy gates on `1931743f`.
Initial draft attempts settled `invalid_arguments`; later attempts were
`work_binding:sibling_frame_replanned_before_dispatch`. Two carrier refusals
named `effective_inner_name_missing` and told the model to amend its plan, while
the attempted amendment was refused `fresh_plan_already_activated`. Reproduce the
FIRST failure from retained model/call bytes before deciding the P3 correction;
do not silently expand into P5 or treat the final governor stop as the root cause.
Worker precondition stays live-green; P3 write acceptance remains RED.

**2026-09-04 23:53 — REVIEWER on the draft-canary RED (frozen `1931743f`, zero drafts) and
gates resumed.** Agreed with the executing agent's order: reproduce the FIRST
refusal from retained bytes before choosing the P3 correction. Three direction-level
readings to carry into that reproduction, none of them a new door:
(1) **The live win inside the loss is real and measured:** two searches vs eleven,
the answered mailbox resolved on the first search, no repeated account question —
§16 fix #1 is live-proven; the P2 turn-burn class is closed.
(2) **A dead-end pair, by construction:** the carrier refusal
`effective_inner_name_missing` told the model to amend its plan, and the amendment
was refused `fresh_plan_already_activated`. The harness instructed an action it
then refused — the exact NO DEAD ENDS violation (typed stop + next edge that is
actually open). Whatever the first-failure reproduction shows, a refusal's
`repair` text must name an edge the SAME turn can take; if the plan is sealed, the
edge is "re-issue the call with the corrected inner name under the existing plan",
never "amend the plan".
(3) **Over-planning + a typed-universe mismatch:** `plan_task` accepted 25 planned
instances (five draft operations × five company names) for a five-draft objective,
and the first frame failed `work_cardinality_mismatch` because it selected
`/to_recipients/0` (an email) against a universe of company names. The objective
needs five calls, each needing a recipient the universe does not contain — that is a
missing READ (find the contact for the company), which the harness should route to
(a typed "needs evidence: recipient for <company>" next edge → one bounded read),
not a cardinality refusal. This is P5 plan-optional and the D5 read→write lineage
seen from the write side; keep it OUT of P3's fix unless the reproduction proves
the exact-schema comparison (`bound_catalog_call_does_not_match_exact_schema_and_
arguments` on a correctly shaped singleton with a durable matching binding) is the
first failure — that one IS P3's, and looks like the write bar comparing against
a different serialization of the same exact call.
Gates: resumed on `1931743f` in the detached checkout — worker pins + the three
updated journeys first, then the light gates, full journeys and npm test; results
land here with exit codes.

**2026-09-04 23:54 — FROZEN `1931743f`, isolated checkout: worker-door pins **123/123 ✅**
(the 23:35 "3 !== 2" was a version artifact — withdrawn stands); the three updated
journey files **16/17** — the ONLY red is "a plan with no exact verifier is admitted
and carries the obligation", which is on the pre-existing (08-31) list. So all FOUR
journeys that were new today are closed on these bytes: two-operation request
(`done`), cold Discord restaurant loop, fresh-discovery gate surface, and Home
parity (verified at `18ac00d4`). Light gates + full journeys + npm test on the same
bytes are running; the tag picture after that is: the 11 older journeys decision,
the 2 machine-stable-red unit tests on the CI runner, and the P3 write acceptance
(draft canary red).

**2026-09-05 00:06 — FULL JOURNEYS on frozen `1931743f`: 156 pass / 16 fail (172 visible now
that the Workspace file no longer crashes the runner).** Light gates 4/4 ✅, worker
pins 123/123 ✅. Of the 16: **9 are the pre-existing list** (three outbound-draft
approval subtests, legacy input-digest staged identity, plan-with-no-exact-verifier,
accepted read plan cannot stop at prose, competitive byte ledger, external plans
without a random gate, zero-crossing retirement) — two of the old eleven are now
green. **7 are NEW since the candidate `64c3bfa5` and were green there: the parent
"provider-neutral authorized requests cross unrelated capabilities without random
gates" (`provider-neutral-no-random-gate.acceptance.test.ts`) and its six
subtests "reversible local file create / Workspace create / Workspace edit /
workflow author / workflow change / workflow run — without accepted coverage
REPAIRS before I/O", every one now throwing `host call-authority boundary refused:
prepared_frame_release_failed` (throw site `host-turn-runner.ts:7527`, present
since 08-24; the PATH that now reaches it is today's).** This is the OPEN CLEM UP
path — an uncovered reversible mutation must land in the zero-I/O repair matrix,
not at a boundary refusal — and it smells like the same class as the draft canary's
`sibling_frame_replanned_before_dispatch`: a prepared frame whose consent decision
is `repair` cannot be released cleanly under the same-step consent+dispatch path.
Attribution run (`f616da92^` vs `f616da92`) in flight; if it lands on `f616da92`,
this is P3's own regression and the first thing to fix, with this journey as the
pin. npm test on the same bytes still running.

**2026-09-05 00:08 — ATTRIBUTED: the six "…without accepted coverage REPAIRS before I/O"
failures are introduced by `f616da92` (same-step consent + dispatch).** Same file,
isolated runs: at its parent `cf50388e` → 51 pass / 5 fail, all five on the
pre-existing list, `prepared_frame_release_failed` ×0; at `f616da92` → 44 pass /
12 fail, the six coverage-repair subtests + their parent added,
`prepared_frame_release_failed` ×6. **Amending the 22:57 acceptance of `f616da92`:
accepted for EXACT COVERED writes (allow → same-step dispatch; ask → pause before
I/O; deny/changed → refused), but it REGRESSED the UNCOVERED-mutation path — a
reversible local file create, a Workspace create/edit, and a workflow
author/change/run that arrive without accepted coverage must land in the zero-I/O
repair matrix (typed repair, zero bodies) and now die at the call-authority boundary
with `prepared_frame_release_failed` (`host-turn-runner.ts:7527`).** That is the
OPEN CLEM UP contract broken by construction, and it is almost certainly the same
mechanism behind the draft canary's `sibling_frame_replanned_before_dispatch`: when
the reducer's decision is `repair` (not allow/ask/deny), the prepared frame is
never released on the repair edge. Fix in P3 before anything else; the pin already
exists — `provider-neutral-no-random-gate.acceptance.test.ts` must return to
51/56 (the five old ones stay on the debt list). Reviewer's own miss: the 22:57
review checked the three consent outcomes and not the fourth (`repair`); the
journey caught it, which is what the gate is for.

**2026-09-05 00:09 — mechanism pointer for the `f616da92` regression (read-only, for the
reproduction):** the throw is the pre-approval refusal path in `host-turn-runner.ts`
~7510–7527: when any call in the batch is refused before approval, every prepared
sibling is released with `releasePreparedHostWorkCallForRepair(candidate,
'sibling_frame_replanned_before_dispatch')` and pending calls are settled; if ANY
release returns false the whole batch dies with `prepared_frame_release_failed`.
Before `f616da92` the six uncovered mutations were released and repaired (zero
bodies). After it, a prepared frame on the same-step path appears to be in a state
the repair release cannot unwind — the likely candidates are the immediate-invoke
branch ("a proceed enters that invoke immediately, without preparing a plan") or
the minted `HostConsentCallAuthority` leaving the frame armed/consumed before the
reducer's `repair` decision is applied. The `sibling_frame_replanned_before_dispatch`
label the draft canary showed is the same release call — one mechanism, two
symptoms. Check the return value of `releasePreparedHostWorkCallForRepair` for a
frame prepared through the new path; the fix is to make the repair edge releasable
(or to decide `repair` BEFORE preparing/minting), never to swallow the false.

**2026-09-05 00:16 — COMPLETE GATE TALLY on frozen `1931743f` (detached checkout, isolated
homes, real exit codes):** typecheck ✅ · check:public-hygiene ✅ · test:public-hygiene
4/4 ✅ · test:release-assets 53/53 ✅ · worker-door pins 123/123 ✅ · **npm test
14,493 pass / 2 fail** — the two are exactly the machine-stable-red pair ("daemon
rehash reprovisions the reviewed read…", "private key is written 0600"; both fail
on the pre-today baseline; classify on the CI runner) — nothing introduced today
remains red in the unit suite · **journeys 156 / 172** — 9 pre-existing + the 7
introduced by `f616da92` (00:08 entry). Earlier on `64c3bfa5`, unchanged since:
proof:selftest ✅ · test:measurement ✅ · bench:gates ✅ · eval:memory/passk/jobs ✅.
**What stands between these bytes and a tag:** (1) the `f616da92` repair-path
regression — fix + journey back to 51/56; (2) the 9 older journeys — fix or an
explicit, written exclusion from the release gate with reasons in
`docs/releases/v3.16.0.md`; (3) the 2 environment-suspect unit tests on the CI
runner; (4) P3 write acceptance (draft canary red — same mechanism as (1) is the
first thing to reproduce); (5) then the full gate set once more on the final bytes,
and the packaged-app build/upgrade rehearsal. Everything else on the direction
doc's list is done and live-proven or fixture-proven.

**2026-09-05 00:21 — TAKEOVER: the owner handed the executing lane to the reviewer ("take over
from here"). One owner again: the reviewer now owns this checkout, the log, and
the tag list.** State at hand-over: HEAD `d8df7ec9`; no daemon or live home running
(8420/8520/64244/64245 all down); 8 uncommitted files left by the executing agent
+ 1 intentionally-uncommitted local red test, backed up to the reviewer scratchpad
before touching anything. Inventory of that WIP: (a) `host-interactive-consent.ts`
+93 — an `onMismatch` diagnostic on exact-prepared-candidate selection (schema
digest / tool identity / argument digest / canonicalization) so
`bound_catalog_call_does_not_match_exact_schema_and_arguments` finally says WHY;
observability only, no authority change; (b) `host-turn-runner.ts` 1 line — the
dead-end pair: the carrier refusal no longer tells the model to "call plan_task
again to amend the plan" but to reissue under the existing plan (the 23:53 reading
(2)); (c) `composio-tools.ts` — replaces the ad-hoc `file_uploadable` schema scan
(which blocked a draft whose schema merely ALLOWS attachments with
"PREPARATION-REQUIRED") with `planStagedFileUploads` — plausibly the canary's first
`invalid_arguments`; (d) pins for a–c; (e) `p3-retained-draft-call.red.test.ts` —
replays the canary's batch-6 bytes from the stopped snapshot: first refusal must be
`work_cardinality_mismatch`, the corrected singleton must NOT hit the exact-schema
mismatch and must dispatch once. Order from here: (1) prove/complete that WIP; (2)
the `f616da92` repair-path regression (six subtests, one mechanism); (3) the
draft-canary exact-schema mismatch; (4) malformed `run_worker` packet settling
`succeeded` with zero children (newly measured debt); (5) the 9 old journeys —
decision with the owner; (6) §15 watcher re-arm on `worker_started`; (7) full
gates on final bytes + packaged rehearsal; push/tag only on the owner's words.

**2026-09-05 00:24 — TAKEOVER, first commits.** The hand-over WIP was reviewed (guard fires only
on a SUPPLIED file, not an allowed attachment schema; mismatch diagnostics are
observability only; refusal text now names an edge the sealed plan can take) and
verified in isolation: 266/266 across its five test files, typecheck ✅, hygiene ✅,
and the local retained-byte replay of the canary's batch 6 passes (corrected
singleton dispatches once, no exact-schema mismatch). Committed as `94e42ed5`; log
as `a6bea8fe`. The retained-byte red test stays untracked on purpose (it reads
private evidence). **Branch note for the owner:** this checkout is
`wave/one-gate-and-hardcode-subtraction`, 46 commits ahead of `origin/main`
(`ed12a63a`, 21:14) — the release preflight requires the tag SHA to equal
`origin/main`, so a push of this branch to `main` will be needed before any tag;
that push happens only on the owner's words. In flight now: the `f616da92`
repair-path fix (root-cause → adversarial refutation → isolated fix + pin) and the
malformed-`run_worker`-packet settlement fix + pin, both in isolated worktrees;
patches land here with exact counts before they are applied to this checkout.

**2026-09-05 00:32 — THE NINE OLD JOURNEYS, TRIAGED (three read-only readers, git history +
log error blocks + the asserted code; no tests run). Proposed decision for the
owner — fix 4, update 3, defer 2 with written reasons:**
- **FIX NOW (one shared mechanism, four journeys, all in
  `provider-neutral-no-random-gate.acceptance`):** "explicit outbound draft requests
  one user approval before I/O", "approved outbound checkpoint recovery never
  duplicates the send", "approved exact outbound with an unknown crossing holds
  across restart", "exact accepted external plans execute ordinary Sheet and Google
  Doc creates without a random gate". The pause DOES happen (one consent subject,
  approval row registered + resolved) but on resume the approved exact outbound never
  reaches the provider port: `bodies 0 !== 1` — the resume loop takes the
  `resumeFrameRepair` branch (`releasePreparedHostWorkCallForRepair` +
  `settlePendingCallBeforeDispatch(…,'approval_scope_changed_before_dispatch')`) and
  pairs a zero-I/O repair back to the model. Red since between the v3.16.0 cut
  (`d3bc85ca`, 08-30) and the 08-31 ring commits; the resume/consent files are
  byte-identical across that window, so the break is upstream of the resume loop.
  This IS P3's acceptance line ("genuine send/delete/admin still needs_user; one
  authorized write crosses exactly once") — not deferrable. Method: bisect this one
  file across d3bc85ca → 08c81c8a → 2b7bbbac → 548741b5 → 38fa83ad in throwaway
  worktrees (~40 s each), then fix the class. Est 1–3 h.
- **UPDATE TO THE CURRENT CONTRACT (test-only, evidence kept):** "competitive byte
  ledger…" (asserts `run_worker` ABSENT from the step-1/2 surface — the
  hidden-until-plan hoop removed at `658b12c2`; assert the refusal receipt instead,
  keep the byte ceilings); "zero-crossing retirement…" (source-A terminal is now
  `blocked/control_no_progress_exhausted`, resumable — flipped at `7bd17d6f`; every
  other assertion stays); "a plan with no exact verifier…" (wording changed at
  `5faf8eb7` to "wrote, could not verify"; assert the carried obligation). In flight
  now in isolated worktrees; each must be green on its own evidence.
- **DEFER PAST THE TAG, WRITTEN INTO `docs/releases/v3.16.0.md`:** "GATE: a legacy
  input-digest disclosure rebuilds full staged identity after restart" (the failing
  check is the planning-card freeze ceremony P5 retires; the fixture models
  pre-`providerDefinition` rows whose upgrade is now an explicit door) and "an
  accepted read plan cannot stop at prose: host continues once…" (the CONTRACT — a
  frozen read plan with zero settlements is not a finished turn — is D1/no-dead-ends
  and stays owed; the exact assertion is tied to a shape P5 changes; re-pin it in P4/P5
  rather than green-wash it now).
Owner: say "agree" or change any line; the fix-now group starts as soon as the
`f616da92` repair-path patch lands (same file, same resume/consent region — one
patch at a time in that region).

**2026-09-05 00:38 — three journey contract updates came back from isolated worktrees (test-only,
evidence kept byte-for-byte):** zero-crossing retirement → green (asserts
`blocked/control_no_progress_exhausted` and `resumable ≠ false`, the `7bd17d6f`
shape); no-exact-verifier → green (accepts "could not verify|confirm", adds "never
claim done" and a non-empty `unverifiedMutations` obligation — strictly additive);
competitive byte ledger → hoop assertions updated (run_worker advertised from step 1;
zero `worker_started` / zero `physical_dispatches` as the evidence), and that
UNMASKED the gate the journey was written for: **the cold step-1 model-visible
surface is 28,843 B against a 16 KiB ceiling; pre-activation discovery/schema
37,594 B against 32 KiB. `run_worker` alone is 8,836 B — the largest tool on the
surface; P2 added it to step 1.** The file's own header says it is a RED
competitive gate until the cold surface is genuinely bounded, so it moves to the
"defer with a written reason" group — but it is real §16 token debt (fix #8 family):
compacting the `run_worker` description/schema (a 9 KB tool description is prompt
prose masquerading as schema) is the single biggest cut available. Applying the
three patches to this checkout now; the files re-run here before they are committed.

**2026-09-05 00:42 — BISECTED the "approved exact outbound never dispatches on resume" group
(four journeys, one file, isolated worktrees, one file per SHA):** 56/56 green at the
v3.16.0 cut `d3bc85ca` (08-30 13:39) and at `81b7e2f7` (08-30 22:07); red from the
six-commit batch landed together at 08-31 21:51 (the host_v1 wave: `f593aeab`,
`4b20b158`, `a5709bed`, `36c5b311`, `d3a35922`, `08c81c8a`) and every SHA since
(`2b7bbbac`, `548741b5`, `38fa83ad`: 52/56 → 51/56). `git bisect run` names
**`36c5b311` "feat(workspace): reviewed space_set_data carrier/executor
(workspace_dataset_v1), host-local write commit + derivation"** as first bad, with
`a5709bed` untestable (the file did not run there) and `d3a35922` (authored workflow
write authority, async-read receipts) also red — so the culprit is inside that
batch, most likely `36c5b311` or `d3a35922`. This has been red for five days and was
counted as "wave debt"; it is P3's acceptance line. Root-cause workflow (diff +
runtime investigators, adversarial refutation) launched; the fix follows the
`f616da92` repair-path patch in the same region. Also: the journey contract commit
`4e819434` landed (three journeys re-pinned to the current contracts).

**2026-09-05 00:45 — `f616da92` REPAIR-PATH REGRESSION FIXED: `39d00400`.** Mechanism (two
independent investigators, four adversarial verifiers, all reproduced it):
`evaluateExactHostMutationConsent` admits the logical-call row from the
MATERIALIZED arguments (omitted strict-nullable fields → `null`) before the
reducer decides; on a `repair` decision the refusal path settled the call with the
RAW model bytes → digest mismatch → `settlePendingCallBeforeDispatch` false →
`prepared_frame_release_failed`. f616da92's own pin never tripped because its
fixture schema had no nullable field (raw == materialized). Any Composio/draft
operation with nullable fields the model omits hits the same split — the likely
draft-canary link. Fix: one hunk, settle with the same materialized bytes; new pin
drives an uncovered write with an omitted nullable field through the real door
(zero bodies, paired repair, row settled under the admitted digest). Verified on
this checkout: pins 252/252 ✅ · `provider-neutral-no-random-gate` **52/56** (the
six repair subtests + parent green; the four left are the bisected 08-31
approved-outbound group) · typecheck ✅.

**2026-09-05 00:48 — malformed `run_worker` packet: part 1 built and REFUTED as incomplete;
part 2 in flight (not committed until the class is closed).** Mechanism (fixer, then
independently confirmed by its verifier through the real host_v1 door): `run_worker`
on the orchestrator lane was built with `tool({strict:true, execute})` and no
`errorFunction`, so an SDK zod failure came back as a bare "An error occurred…"
string; settlement reads only `worker_result` receipts for run_worker, so zero
receipts + a plain string fell through to `hostExecuted` → **`succeeded`, a host
crossing and a durable result handle for a call that dispatched nothing**; and
`brackets.ts` then rewrote the string into the generic "worker did not complete this
item" envelope, hiding the repair. Part 1 (errorFunction → typed
`InvalidArgumentsPreDispatchResult`; brackets returns the exact repair bytes;
`describeInvalidToolInput(maxIssues)` so a many-violation packet repairs in one
round; pin with three shapes: 3/3, neighbors green) is correct for the SDK-invalid
class — but the adversarial verifier found five schema-VALID no-child shapes that
still settle `succeeded` (empty `items` with a manifest; all-junk items;
whitespace items; neither `item` nor `items`; a manifest `phase` not in `phases`)
because the tool BODY returns plain "ERROR: …" strings for its own pre-dispatch
refusals. Part 2 routes every no-child refusal in the body through the same typed
carrier (no blanket "zero receipts ⇒ failed" rule — the atomic pin's unrelated-call
variant and durable-completion reuse legitimately settle without new receipts) and
extends the pin with all five shapes plus a partial-fan-out control. The verifier's
method — same real door, ledger rows read back — is the standard for this class.

**2026-09-05 01:00 — APPROVED-OUTBOUND-ON-RESUME FIXED: `0c63a90b`. `provider-neutral-no-random-
gate.acceptance` is 56/56 — the whole file green for the first time since the
v3.16.0 cut.** Mechanism (two investigators, four adversarial verifiers, all
reproduced): the resumed-frame "approval edit" compare (`host-turn-runner.ts`
~5783) checked persisted MATERIALIZED pending bytes against RAW checkpoint bytes;
`d3a35922` (08-31) added `source_call_ids`/`source_record_ids` as nullable fields
on `work_call`, so every unchanged approval materialized differently, was treated
as a user edit, and was refused `approval_scope_changed_before_dispatch` — the send
never crossed. The `git bisect` pointing at `36c5b311` was an artifact of the six
08-31 commits landing as one internally inconsistent batch. Fix: compare both
sides under the same materialization (raw fallback); a genuine edit still differs
and is still refused (the four negative cases stay green). Pin: the direct-write
fixture carrier now has a required nullable field the model omits, so every
resume case exercises the split. Verified here: pins 287/287 ✅ · journey 56/56 ✅
· typecheck ✅. Three of today's harness bugs were the SAME class — a strict-nullable
materialization split between the bytes that admit a call and the bytes that
settle/compare it (`39d00400`, this, and f616da92's own pin schema hiding it) —
worth one sweep: grep every `rawItem.arguments` / `argumentsJson` compare and
digest site and make each one go through `materializedArgumentsJson`.
The FIX-NOW group of the old journeys is closed; remaining from the nine: the two
deferred ones (written reasons owed in `docs/releases/v3.16.0.md`) and the byte
ceiling (deliberately red).

**2026-09-05 01:10 — §15 WATCHER RE-ARM ON FAN-OUT LANDED: `a32317cf`.** The judge coverage gap
from the live replay is closed at the code level: the first `worker_started` of a
batch re-arms the same watcher gate (only the call interval waived; in-flight,
check/injection caps and kill-switch unchanged) and runs the same check body in
the parent's context with the workers' progress in its summary; the verdict rides
the existing steer-note channel to the parent's next model request only.
Verifier probes: a hostile steer note during the batch reached no child, no
consent, no dispatch; a no-fan-out run's event dump is byte-identical to
unpatched; zero listener leak. Pins 255/255 (timing pin stable ×3); typecheck ✅.
The LIVE proof of `auditorOverlapsWorker:true` belongs to the next cold worker
replay on the final bytes. Reviewer's remaining-work list: malformed
`run_worker` packet part 2 (in flight) · materialization-split sweep (in flight) ·
owner's "defer" on the three skips · full gates on final bytes · cold worker
replay + draft canary on the final frozen SHA · packaged rehearsal · push/tag on
the owner's words.

**2026-09-05 01:21 — MALFORMED / NO-CHILD `run_worker` CLASS CLOSED: `41aaabb1`.** Every exit of
`run_worker` that dispatches nothing is now a typed carrier settlement reads: SDK
input validation → `invalid_arguments` naming every violated path; every body-level
refusal (empty/junk/blank/absent items, uniform-failure memo, quantified gate,
manifest binding, missing lease, batch identity/ownership) through ONE helper; a
generation cancelled before any body was admitted (the batch runner now counts
started bodies on the error) → a new `CancelledPreDispatchResult`
(refused_pre_dispatch, no handle, no progress); any other body throw → the
local-failure carrier, never a laundered string. No settlement-side "zero receipts
⇒ failed" rule (durable-completion reuse and the atomic pin's unrelated-call
variant are legitimate). Two adversarial verifications drove 8 + 6 shapes through
the real door with ledger rows read back; the last seam (a body throw at a spent
outer deadline settling `succeeded` + a handle) is pinned with the honest race
outcomes: paired refusal, or a host-held resumable checkpoint — never done, never
"retry the item". Pin 10/10, neighbors green, typecheck ✅. Remaining before the
gates: the materialization-split sweep result (in flight) and the owner's word on
the three deferrals.

**2026-09-05 01:23 — MATERIALIZATION-SPLIT SWEEP (two auditors by symbol / by boundary, one
merging verifier; read-only): 24 sites materialized, 5 raw-looking sites rejected
with reasons, 4 CONFIRMED — fixers + adversarial verifiers launched.**
(1) HIGH `host-turn-runner.ts` ~6945 — the no-progress `ask_user` recovery checks the
RAW bytes of the single `ask_user_question` call against the canonical key set
`['options','purpose','question']`; `options`/`purpose` are strict-nullable, so a
native-lane brain that omits `options` (the directive never says to pass `null`)
fails the check and the turn stops `required_question_not_issued` although the
materialized call is canonical. (2) HIGH — the resume "approval edit" compare has a
SECOND axis `0c63a90b` did not cover: the pause persists the host's CARRIER-COMPLETED
bytes (completion rewrites writes too: bare name → gateway form, `args`→`args_json`,
wrapping/serialization) while the checkpoint keeps the raw model bytes and is only
re-materialized, never re-completed — an approved, unchanged carrier write (a
`GMAIL_SEND_EMAIL` via `work_call`) would still read as an edit and never dispatch.
General fix: snapshot the exact ADMITTED bytes on the pending call at the pause and
compare the pending call against its own snapshot (never against checkpoint
history; never overwrite `rawItem.arguments` with checkpoint bytes); bump
`HOST_STATE_VERSION`. (3) MEDIUM — the same compare when the paused tool is absent
at resume degrades to raw-vs-materialized and writes raw checkpoint bytes onto the
pending call → `resumed_*_unavailable` recovery outcomes; the snapshot fix removes
the dependency on the tool. (4) MEDIUM sibling class (host-side key deletion) —
`composio-tools.ts` ~1284 documented-create projection compares a frozen
admission attestation digest against dispatch-time `resolved.args` after host
normalization; to be PROVEN by a fixture before any fix. Coverage gap named by the
verifier: everything was by reading; the two medium sites need their fixtures.

**2026-09-05 02:00 — SWEEP SITES 1–3 FIXED: `9ac532df`.** One primitive closes the resume axis
for good: the pause snapshots the exact ADMITTED bytes on the pending call
(`admittedArgumentsJson`, HOST_STATE_VERSION 6, older states backfilled) and resume
compares only against that snapshot — so host-completed carrier writes resume and
dispatch exactly once, a genuine edit is still refused, and a resume without the
paused tool on the surface no longer manufactures a phantom edit; the no-progress
ask is judged on materialized bytes (an omitted nullable `options` is the
canonical ask). Verified on this checkout: 348/348 across 11 pin files, journey
56/56, typecheck ✅; verifier red/green by file swap + V4–V7 paused-state probes.
Site 4 (composio documented-create digest) is fixed at its site and its verifier
found the SAME split one step later (`atomic-content-commit-proof` compares the
admission-time RAW binding digest against the now-EFFECTIVE projection digest →
a refined create's content-commit evidence would be refused after the provider
write succeeded); part 2 is in flight, both halves land together.

**2026-09-05 02:12 — INTERIM FULL GATES on `cf7a3f23` (the five takeover fixes; isolated
checkout; the deferral patch NOT included): light gates 4/4 ✅ · proof:selftest
239/239 ✅ · test:measurement 97/97 ✅ · **journeys 169 / 172 — the only three reds are
exactly the three proposed deferrals** (read plan cannot stop at prose; legacy
input-digest staged identity; competitive byte ledger). Every other journey that was
red today is green on these bytes: the 6 repair-path subtests + parent, the 4
introduced by P1/early-P2, and the 8 remaining old ones (4 fixed by the outbound
resume fix, 3 re-pinned, 1 fixed earlier today). With the owner's "defer" the gate
reads 172/172 (169 pass + 3 skipped with written reasons). npm test, bench and the
evals are still running on the same bytes.

**2026-09-05 02:22 — INTERIM `npm test` on `cf7a3f23`: 14,519 pass / 2 fail / 1 skipped;
bench:gates ✅.** The two are exactly the machine-stable-red pair that also fails on
the pre-today baseline ("daemon rehash reprovisions the reviewed read when
executable bytes drift" — `skipped:[salesforce]` where a reprovision was expected;
"private key is written 0600" — mode 0644). Nothing today's fixes touched is red.
Rather than leave them to the CI runner, a fixer + verifier are making them
hermetic: if the 0600 case is production code relying on umask, that is a real
security fix (keys must be written 0600 regardless of umask); if the reviewed-CLI
case reads real machine state, it gets the stubbed seam its siblings use; a
precondition skip with a named reason is the last resort; nothing is deleted or
weakened.

**2026-09-05 02:35 — SWEEP SITE 4 (+ its sibling) FIXED: `56243176`.** A refined documented
create (host-only keys stripped by the gateway) no longer fails its own attestation
at dispatch, and its content-commit proof no longer conflicts after the provider
write: the projection reads the ledger's refined row and freezes on the effective
digest; the atomic proof joins the admission-time binding (immutable by schema
trigger — the verifier confirmed no second writer is possible) to the crossing
through the ledger's single refinement. Edited/unrefined/stale/conflicted calls
still conflict (8 negative shapes). Pins red-without/green-with by stash; 227/227
across 13 suites; typecheck ✅; hygiene ✅. **The materialization/identity-split
class is now closed at every site the sweep confirmed** (24 sites already correct,
4 fixed today across `39d00400` `0c63a90b` `9ac532df` `56243176` + the 41aaabb1
laundering seam). Remaining before the final gates: the hermetic fix for the two
machine-dependent unit tests (in flight) and the owner's "defer".

**2026-09-05 02:37 — the last two unit reds closed: `42b09dd3`. One was a REAL security defect,
not a flaky test:** `mobile-tls.ts` tightened the private key with
`writeFileSync(path, bytes, {mode: 0o600})`, which Node applies only on CREATE —
so the mobile TLS private key stayed at the umask default (0644 with macOS
LibreSSL) on every host whose openssl does not write 0600 itself. Fixed by creating
the key 0600 before openssl truncates into it + an explicit chmod after; verified
under umask 022/000/077; the existing test is the pin. The reviewed-CLI reprovision
test was hashing the REAL `sf` on this machine because `augmentPath` prepends
`/usr/local/bin` ahead of a PATH that lacks it — the fixture now sits ahead of the
augmented PATH (two sibling tests swept for the same latent collision; no
production change). Flagged for later, not fixed: production has a documented
tension on PATH precedence (`spawn-env` pins prepend-first; `guest-harness` pins
user-PATH-first after the 07-30 stale-nvm incident). `npm test` should now be
green on this machine and on the runner. FINAL GATE PASS on these bytes starts now.

**2026-09-05 02:59 — FINAL GATE PASS on `b69046aa` (all nine takeover fixes; isolated checkout,
real exit codes): typecheck ✅ · check:public-hygiene ✅ · test:public-hygiene 4/4 ✅ ·
test:release-assets 53/53 ✅ · proof:selftest 239/239 ✅ · test:measurement 97/97 ✅ ·
**npm test 14,527 / 0 fail ✅** (first fully green unit run of the day; 1 pre-existing
darwin skip) · bench:gates ✅ · eval:memory ✅ · eval:jobs ✅ · eval:passk strict ✅ ·
**journeys 169 / 172 — the only reds are the three deferrals** (the skip patch is
prepared and verified, waiting on the owner's word). Compared with the 09-04 21:00
candidate: journeys 143/159 → 169/172, npm test 3 fails → 0, plus the live worker
proof, the watcher re-arm, the malformed-packet class, the identity-split class at
every confirmed site, and a real key-permission fix. LIVE PROOFS start now on these
exact bytes: the cold 8-worker replay (must show `auditorOverlapsWorker:true` this
time) and then the parked draft canary (five reversible drafts, zero cards, zero
sends).

**2026-09-05 03:34 — LIVE PROOFS on `b69046aa` (frozen source, fresh isolated homes, live home
never opened, daemons stopped and verified; evidence under the reviewer scratchpad
`takeover/live/`; every number re-derived by a read-only verifier from the stopped
snapshot DBs):**
**(1) Cold 8-worker replay — 12/12 collector assertions GREEN, 47.3 s wall, terminal
`done`, 8/8 nonce receipts through real child host `read_file` settlements, one
batch, parallel, zero writes/approvals, and `auditorOverlapsWorker: TRUE` — two
watcher checks on the real Claude wire, the second overlapping six of the eight
workers (the `a32317cf` re-arm demonstrated live; the 1931743f run had one check
and no overlap).** BUT it is not a substantive reproduction of the Codex-worker /
Claude-judge contract: the owner's **Codex weekly quota crossed 100%** between the
two runs (`state/model-rate-limits.json`: usedPercent 100, resets
2026-09-11T05:29Z; 96% at the 06:35Z run), the first brain call rate-limited, the
fallover routed brain, all 16 worker turns AND the judges onto claude-sonnet-5
(0 Codex tokens; ~220k Sonnet input tokens billed to the owner's Claude plan). **A
REAL DEFECT this exposed — planned-vs-executed attribution:** `worker_model_routed`
/ `worker_started` / `worker_result` and the runs ledger stamp the PLANNED packet
model (`worker-tools.ts:666/682`, `orchestrator.ts:462 source:'packet'`); the
fallover (`fallback-model.ts:830 preselected-rate-limited`) never corrects them;
`debate-model.ts:1058` derives `brainFamily`/`selfJudge` from the CONFIGURED brain
(`judge-family.ts:332` aggregates it) — so the judge lane reported `brainFamily
codex / selfJudge false` while Claude Sonnet 5 judged Claude Sonnet 5: a
self-judge presented as cross-family, violating "judge a different family" with no
signal. The collector's `codexWorkerRoutes` / `watcherHealthy` passed on labels;
only `model_route_decisions/outcomes` and per-session `turn_model_routed` tell the
truth. Fix: attribute EXECUTED routes on every worker/judge label, derive
`selfJudge` from the executed brain family, and make in-repo pins assert on route
rows. Not re-run on purpose: a retry cannot reach Codex before 09-11 and only
bills Claude again.
**(2) Parked draft canary — RED in 1.4 s with ZERO tool calls and ZERO model
calls (nothing billed), a NEW deterministic dead end:** the first brain request of
the resumed turn is refused pre-dispatch by
`model-request-provenance.ts:871` — `host_result_projection_mismatch`. Mechanism,
reproduced offline byte-for-byte: layer-1 compaction (`compaction.ts:362
clipOldToolResults`) clipped the two refused `work_call` frames from the 1931743f
leg into "[clipped …]" stubs — clip-eligible only because each refused frame was
persisted TWICE (a host-disposition receipt AND a plain-text `tool_outputs` row from
the `host-turn-runner.ts:4136` refusal path) — and the HOST-RECEIPT branch of
provenance has no Layer-1 stub allowance (the logical-settlement branch does,
:933/:1349). Every resume of `bg-graph-driver-tag-canary-20260904` now dies
identically; the task record says `resumable:true`, the turn says `resumable:false`,
and the user sees "Something went wrong on that turn." The previous leg got 5 tool
calls and 5 minutes; this state is worse and durable. Fix (general): the
host-receipt branch accepts a Layer-1 clip stub exactly as the logical branch does,
AND a refused frame is persisted once (no `tool_outputs` row for a frame settled by
host receipt, or host-disposition results exempt from clipping); typed stop must
not contradict itself. Both fixes launched (isolated worktrees, pins, adversarial
verification). Canary re-run after the fix needs the owner's word: with Codex at
100% it would execute on Claude fallover (contract change + Claude billing).
