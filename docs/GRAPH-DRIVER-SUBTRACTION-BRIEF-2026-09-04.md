# Graph-driver subtraction brief

Date: 2026-09-04 (updated late afternoon: nomination without a graph is live; next is same-step dispatch; one loop, not three doors)

Audience: the agent on `wave/one-gate-and-hardcode-subtraction`. Nathan will point you here. Read this top to bottom once, then execute. Do not start V31. Do not add a third admission token. Do not grow `graph-neutral` into a second expected-work compiler.

Branch: `wave/one-gate-and-hardcode-subtraction`

HEAD: `38fa83ad` plus a large dirty tree. Latest tag: `v3.15.0`. Owner has not given a tag go.

Related reading (context only — this brief overrides their next-step advice where they conflict):

- [docs/PRETAG-LAST-25H-HARNESS-AUDIT-2026-09-03.md](./PRETAG-LAST-25H-HARNESS-AUDIT-2026-09-03.md)
- [docs/NORTHSTAR-NIGHT-ADDENDUM-2026-09-01.md](./NORTHSTAR-NIGHT-ADDENDUM-2026-09-01.md)
- [docs/HANDOFF-2026-09-03.md](./HANDOFF-2026-09-03.md)

External analogues, not ports:

- [get-bb/bb](https://github.com/get-bb/bb) — thread + event log; permission mode; ask pauses the **same turn**; plan is optional; no graph compiler in front of chat
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — one concrete loop; `tools/pre-execute` is allow | deny | ask; session log is the spine; features attach as listeners; **no graph in front of every message**
- In-repo: [docs/DEEPSEEK-HARNESS-RESEARCH-2026-08-22.md](./DEEPSEEK-HARNESS-RESEARCH-2026-08-22.md), [docs/HERMES-HARNESS-RESEARCH-2026-08-22.md](./HERMES-HARNESS-RESEARCH-2026-08-22.md)

Steal the **loop shape**. Do not copy plugin counts, Cordis, or “spawn Claude Code.”

---

## 0. Direction — one loop. Graph is a projection. Do not grow a second engine.

### What we are building

Northstar: Clem owns the objective and picks the next useful action. The host records every accepted call and result, protects real effects, and makes work resumable.

The **chat** path is DeepSeek / bb / Hermes:

```text
claim input
  -> assemble prompt + the live tools you actually dispatch
  -> one model step
  -> tools/pre-execute: allow | deny | ask
  -> execute through the existing port
  -> append logical call, physical crossing, settlement, result handle
  -> repeat until the turn owes nothing
```

Ask pauses **this** turn (bb). Follow-ups queue. Plan is optional. Sandbox/isolation is separate from approval (DeepSeek).

A **graph** is justified only when work must **outlive the turn**: saved workflow, recurrence, restart at an item. It is an amendable host projection of the ledger. It is not an entrance exam, not a consent subject, and not a reason to mint an approval card.

Clem’s extra strength vs those harnesses (keep): accepted user source, exact live schema/account/effect on a crossing, logical vs physical identity, no blind replay of uncertain writes, result handles, one real ask for send/delete/admin/bulk.

Clem’s extra driver (keep subtracting from chat):

```text
mandatory plan_task DAG
  -> evidence / coverage algebra
  -> expected-work freeze as license
  -> sealed enumerated universe as license
  -> consent from graph nodes
  -> wrapping an exact call back into prepareHostWorkCall
  -> empty card hiding advertised tools
  -> governor last-wording a nomination that has not invoked yet
```

Tool count, “five drafts,” and “read then write” do **not** earn a graph.

### One spine, not three doors

There must be **one** consent reducer ([interactive-consent-policy.ts](../src/runtime/harness/interactive-consent-policy.ts)) and **one** dispatch ledger. Fail closed if the call is not exact.

Do **not**:

- Keep a frozen expected-work compiler **and** a growing `graph-neutral` projector that duplicates it
- Add `issueHostDirectNestedCallAdmission` or any new authority token
- Reintroduce `host_owned_single_action_plan` / `configured_plan_task_missing`
- Trust the model’s `requirement_id` as capability identity
- Special-case Outlook, Sheets, Salesforce, Slack

`evaluateGraphNeutralHostMutationConsent` is a **bypass of the graph entrance**, not a second product. If it needs more than the existing reducer + current catalog attestation, you are rebuilding the exam.

### Landed (do not re-do)

- Semantic-basis approval wall: gone. Consent destination/local load from the binding, not `graph.nodes` / `goals.destinations`.
- Zero-crossing `policy_denial` does not seal a requirement.
- Hidden `host_owned_single_action_plan` enum: gone.
- Direct nomination without compiling a graph: **live** at 13:58 on PID 79474 (`host nominated one exact current-source mutation capability without compiling a graph`). Slug `OUTLOOK_CREATE_DRAFT`. Zero approval cards, zero `policy_denial`, zero `configured_plan_task_missing`.
- `preserveExternalCarrier` is `work_call && !directMutationCandidate` so a nominated mutation is `host_owned_external`.

### Live wall (13:58 PDT, same tag canary)

```text
nominated OUTLOOK_CREATE_DRAFT without a graph
  -> handed the reply to the model before a terminal
  -> control_no_progress_exhausted
  -> no external mutation crossed
```

Nomination is not invoke. DeepSeek would run `tools/pre-execute` then `tools/execute` in that step. bb would run the tool or ask. The governor must not treat “just nominated, zero crossings” as no-progress.

Earlier 12:06 wall `work_source_witness_missing` on `each:5` is **not** the 13:58 failure. Do not reopen universe algebra unless this resume dies on that string again.

### Patch D — nominated exact call consents and dispatches in the same step

Files: [src/runtime/harness/host-turn-runner.ts](../src/runtime/harness/host-turn-runner.ts), existing [evaluateGraphNeutralHostMutationConsent](../src/runtime/harness/host-interactive-consent.ts)

For the **exact nominated** mutation only:

1. Do not wrap it back into plan-required `work_call` / `prepareHostWorkCall`. That is the retired graph entrance.
2. Run the **existing** reducer (`proceed` / `needs_user` / `repair` / `refuse`). Ordinary reversible draft → `proceed`. Real send/delete/admin/bulk → one ask, same turn.
3. Invoke through the **existing** `host_owned_external` port and ledger (`prepareBeforePhysical` + `invoke` already on that production object).
4. Unknown, mismatched, or non-nominated calls still fail closed — including remaining `work_call` that is actually plan-bound.
5. Re-run nomination + consent on approval resume. Do not inherit a stale grant.
6. The no-progress governor must not last-word or exhaust a step whose last act was a successful nomination with no dispatch yet. Count crossings and named refusals, not “we nominated.”

Do not add a new call-authority type. Do not add a nested-admission primitive. Do not start a ledger-owned readback compiler in this patch. Missing readback after a real crossing is “wrote, could not verify,” not a refuse-before-dispatch.

Pin:

- Sole reversible external mutation, current catalog row, exact source proof → `host_owned_external` → reducer `proceed` → one physical crossing. No `prepareHostWorkCall`. No `plan_task`.
- Same call if attestation/catalog/args mismatch → fail closed, zero crossings.
- Nomination then zero crossings in the same step does not emit `control_no_progress_exhausted`.

### Then

Isolation once. Boot **once** from this tree. Resume `bg-graph-driver-tag-canary-20260904`. Watch drafts land or fail on a **new named** reason.

If the new reason is `work_source_witness_missing` / `each:5`: members from the settled result handle or the call’s own targets (Patch C already started in `expected-work-admission.ts`). A count is a loop bound, not a census.

If the new reason is empty-card hiding advertised tools: advertised schema must be dispatchable. One line, not a planner project.

Then stop.

### Out of scope

- V31, commit, tag, push
- New doors, flags, stores, expected-work kinds, host-direct tokens
- Making chat require `plan_task` again
- A second `graph-neutral` expected-work / verifier recipe compiler
- `plan_task` visibility RED tours, CLI envelope campaigns, `shouldDeferPrimaryModelPlanTask`
- Provider-named production branches

---

## 1. Operating rule

Clem owns the objective and chooses the next useful action.

The host binds every call to the accepted user source; records logical call, physical crossing, settlement, and result handle; asks only for send/delete/admin/irreversible/bulk or a real identity/credential gap; prevents blind replay of an uncertain write; infers dependencies from settled results.

The graph is an **amendable host projection**. It is not an entrance exam, not a consent subject, and not a reason to mint an approval card.

Nathan: Clem may do the work locally to validate, then push to Sheets/Outlook from what was asked. That is **rehearsal → one granted push**.

No Salesforce-, Sheets-, Slack-, or Outlook-named production branches.

---

## 2. Landed (do not re-do)

### Seam 1 — projector no longer fail-closes to a user wall

`semanticBasisForPrepared` returns `ready` / `repair` / `hold`, not `null`. The string `prepared capability has no exact current semantic basis` is gone from production code. Catalog node join is no longer the entrance exam. Missing current definition reproves internally.

### Seam 2 latch — zero-crossing denial is not discharge

`priorRequirementAllowsAdmission` drops `policy_denial` + `refused_pre_dispatch` + `physical_crossing_count = 0` from attempt accounting. That V29 string must not seal the requirement.

Still open from Seam 2: slug `GOOGLESHEETS_UPDATE_VALUES_BATCH` vs frozen `cap:resolved:…:definition:…`. Normalize at admission by capability identity if it still fires. Do not make it a third patch theme if Patch A/B + boot is ready — fold it if you touch admission anyway.

### Seam 3 — ledger lineage

Rule unchanged: settled read is a result handle; readback is a verifier only after a mutation of that destination. Do not retarget historical calls onto `n7:verify`. If this still happens on the tag resume, fix it then. Do not pre-audit it.

### Live evidence

Daemon PID 47450 (09:38 PDT) ran `bg-graph-driver-subtraction-canary-20260904`:

- 09:42 `GOOGLESHEETS_GET_BATCH_VALUES`
- 09:42 `GOOGLESHEETS_UPDATE_VALUES_BATCH`
- 09:43 `GOOGLESHEETS_GET_BATCH_VALUES`
- task completed
- 0 `interactive_consent`, 0 preapproval, 0 `policy_denial`, 0 approval cards

That is the original wall, gone on that path. Cell bytes were not independently re-read here; the log proves the three crossings.

`bg-graph-driver-tag-canary-20260904` then **false-greened**: zero Salesforce, zero Outlook, zero physical crossings, then `done/success`. Recovery promised a nonexistent next pass. Completion verifier minted `terminal_success` learning evidence. Resume that same task after A+B; do not treat `done` as success.

Original V29 specimen (PID 39305, 08:35 PDT, source 128908) is historical: consent conflict → `policy_denial` → `work_already_satisfied`. Do not re-diagnose it.

---

## 3. Strip — still do not land

- Any new graph grammar, evidence vocabulary, or “exact current semantic basis” check that can refuse an **already-bound** user-requested write
- Approval cards for ordinary/reversible writes, stale observations, missing `capability_resolution` rows, or restart-adopted catalog lines
- Treating host uncertainty as `policy_denial` that seals the requirement
- More V2x / V3x canary-specific Sheets patches
- A Sheets or Outlook **allowlist** in shared compilation
- New doors, flags, or authority stores
- Declaring success while destination/local consent still keys off a unique graph node

---

## 4. Keep

- Durable logical call + physical crossing + settlement + result handle
- Exact user grant for send / delete / admin / sealed bulk
- Authored-workflow `requiresApproval` as the only in-workflow human gate
- No blind replay of uncertain writes
- “Wrote, could not verify” rather than refusing a write that already crossed
- Provider-neutral repairs only
- Discovery/account pins already landed: standing preference in planning, exact toolkit before top-N

---

## 5. Acceptance after A+B + boot

### Tag canary (the only live test that counts now)

Resume `bg-graph-driver-tag-canary-20260904` on the new daemon.

1. Salesforce read actually crosses. Not a discovery-only turn marked done.
2. Local rehearsal / packaging may happen with **zero** external-write consent.
3. Outlook drafts: ordinary/reversible draft is **not** an approval card and **not** an irreversible send. Genuine send/delete/admin still `needs_user`.
4. Zero `interactive_consent` conflicts of the old semantic-basis shape. Zero `policy_denial` seals on zero-crossing misses.
5. Terminal is done only if drafts exist. False `done` on zero crossings is a product fail, even if the background task says completed.
6. No Salesforce/Outlook-named code in the patch.

Owner rule: do not tag until that run completes end to end with mutating writes. Ask before the tag.

### Sheets path (already crossed once; do not make it the next campaign)

If you re-run it after A+B: same three crossings, no card, no denial latch. Then leave it.

---

## 6. Pins for A and B

Red before green.

1. Bound ordinary catalog write, `goals.destinations` empty or aggregated → still `proceed` (`exact_ordinary_work` / `exact_reversible_work`). No hold, no card.
2. Bound local write/read, graph node missing or duplicated → definition loads from the binding, not from unique explicit node names.
3. Mutation whose adapter declares a compatible readback → verifier selected by family/handle, including a non-Sheets family in the fixture.
4. Mutation with no compatible readback → write admitted; obligation carried; not `verification_successor_required` as a user wall.
5. Keep existing: zero-crossing `policy_denial` retries; internal metadata reproof.

Isolation sentinel before claiming the live daemon is the candidate.

---

## 7. bb, in one paragraph

[get-bb/bb](https://github.com/get-bb/bb): thread + event log, not a model-authored DAG. Default `auto`: sandbox + provider auto-review for routine work. A real ask pauses the **same turn**; follow-ups queue. Plan is optional.

Copy: isolate or rehearse, proceed on ordinary bound work, pause the same turn on a true ask, never freeze a host miss as satisfied.

Do not copy: wrapping Clem as “spawn Claude Code,” or deleting the durable ledger.
