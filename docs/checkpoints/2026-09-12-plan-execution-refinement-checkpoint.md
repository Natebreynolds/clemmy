# Plan preparation and exact execution checkpoint — 2026-09-12

Status: harness candidate built and locally qualified; ready for owner hotpatch and installed-app testing. No commit, tag, push, app replacement or authentication-store change performed. Other agent's Home mock work remains untouched.

## Purpose

Plan should spend its effort understanding the goal, reading relevant evidence and choosing a method. It should use appropriate skills, preferences and remembered procedures, validate current tools, and preserve the preparation for Execute. Act remains able to answer and perform authorized work without an explicit Plan.

## Candidate

- HEAD: `2be6fa443c136580dccad413706a57c66e424a49`, with uncommitted harness refinements and separate Home/UI work.
- Live-tested source fingerprint: `dd454be5abf3178ecc0440521a8b51d6f6f7eb061ea020d5e9e8fcb72e854ce8`.
- Live-tested daemon dist digest: `9fdd250df342addfb6152dcb2d853ec819acbd7f56afdb80388aae18855550be`.
- No version bump; package remains 3.18.5.
- This checkpoint is included in the source fingerprint, so the final rebuild has a new stamp. `output/reviewer-monitor/2026-09-12-plan-review/final-candidate-manifest.json` records that stamp and the byte comparison against the live-tested daemon. Only build-stamp metadata may differ; no runtime code changes follow live qualification.

## Changes in this pass

1. **One authored plan.** `publish_plan` exposes one structured outline. `execution_draft` is null/omitted; the host compiles topology, bindings and evidence from reviewed steps and checked descriptors. The large duplicate action-draft schema no longer goes to the model. Existing saved execution drafts remain readable and executable. Legacy internally prepared drafts still receive consistency validation.
2. **Dependencies and complete diagnostics.** A typed data binding supplies its producer dependency automatically. Missing producers and cycles still fail. Independent argument-preparation errors are collected into one reply. Actual argument bytes are retained; no truncation or fabricated future values.
3. **Discovery identity transition.** A provisional resolution-proof digest can resolve to the current callable descriptor only when the complete same-source provider definition, account, operation, effect, schema/definition fingerprints, version, invocation port and operation contracts agree. This reads existing authority; it neither provisions a tool nor grants execution. A changed contract remains rejected.
4. **Useful blocked-work explanations.** The host-owned, tool-free conversational check-in is no longer judged as a fresh attempt to complete the original job. The caller retains the original blocked/needs-input status. Ordinary completion judging remains in place.
5. **Planning context.** Plan instructions now explicitly select relevant skills and memory, load a chosen skill's method, distinguish recalled candidates from current tool proof, preserve relevant methods/constraints in the saved plan, and plan useful parallelism/check-ins. The procedural tool-memory path already existed; it was verified, not duplicated. Execute guidance reuses gathered evidence unless freshness or the reviewed verification requires another read.
6. **Progress visibility.** Desktop now consumes the shared model-phase progress handling. Its elapsed timer continues between tools; a discovery return no longer overwrites meaningful progress with a generic label. Negative tool results carry their negative status before diagnostic clipping, so rejected publication does not become a green success on the public stream. This is observable progress, not raw private model reasoning.

## Validation

- Focused publisher, native Space Plan→Execute, registered-provider Plan→Execute, hooks and read-only execution tests pass.
- The three synthetic provider writes execute through the real host boundaries and deterministic provider fixture; this is not a live Outlook write test.
- Delayed provider publication is separately qualified through publication and exact Execute reopen. The synthetic delayed fixture has no provider reversibility declaration, so it does not claim actual write qualification. The changed-contract and wrong-source controls remain negative.
- Regression group: 354 passing tests, including host runner, context packet, discovery surface/provider sources, plan topology, execution bridge, argument preparation, public presentation and catalog recovery.
- Final schema-change group: 29 passing tests. Desktop/shared progress group: 53 passing tests. Groups overlap; do not add them as unique tests.
- Backend and desktop typechecks pass. Clean daemon build and desktop web build pass. Desktop build emits existing bundle-size warnings.
- Desktop reducers and build were qualified; installed desktop/mobile rendering has not been requalified on this candidate.

### Live Claude — final candidate

Isolated local daemons, real Claude calls, exact accepted-source/model checks. A selected skill and a seeded user preference are combined with four actual local file reads. Plan prepares the output text without writing it. Execute selects the saved revision, creates one file, and reads it back. Output must match the approved content byte for byte, include every source marker plus the skill method and preference, and require no new tool discovery.

| Brain | Case | Wall | Model requests | Publication repairs | Functional result |
|---|---|---:|---:|---:|---|
| claude-sonnet-5 | chat | 7.6s | 1 | 0 | pass |
| claude-sonnet-5 | plan-four-reads | 35.2s | 5 | 1 | pass |
| claude-sonnet-5 | execute-reviewed-brief | 27.0s | 4 | 0 | pass |
| claude-opus-5 | chat | 8.1s | 1 | 0 | pass |
| claude-opus-5 | plan-four-reads | 29.1s | 3 | 0 | pass |
| claude-opus-5 | execute-reviewed-brief | 36.8s | 4 | 0 | pass |

Both execution turns: exactly one executed mutation, no `tool_search`, no republished plan, exact prepared file content. All original source files remain unchanged. Both daemons stopped; retained test homes sanitized.

The earlier candidate also completed both journeys, but Opus took 134 seconds and re-read all four sources. Final-candidate timings are observations of individual runs, not a controlled latency benchmark.

### Test-driver corrections, preserved

The first fixture setup used invalid fact kind `preference`; it failed before LLM calls. Corrected to the real `user` fact kind in the isolated home. See `plan-execute-live/setup-failure/`.

The first candidate's repair assertion referenced nonexistent `operation_id`/`outcome` settlement columns. It did not measure publication cleanliness. Recomputed from exact source-scoped `tool_attempt_settled` events: both earlier Plan turns repaired once. Raw reports remain under `plan-execute-live/first-candidate/`; `AUDIT.json` records the correction. The final driver reports `publicationRepairs` and `cleanAttempt` independently from functional completion. Sonnet's final Plan has one repair; Opus's has zero. Do not call all six turns clean attempts.

## Hotpatch and next live test

Quit Clementine, then from the repository root:

```sh
node --import tsx scripts/hotpatch-daemon.mjs --check
node --import tsx scripts/hotpatch-daemon.mjs
```

The script checks source/build identity, stages before replacing installed bytes, and retains the previous daemon for rollback. It does not copy credentials, alter the frontend, or patch a running app. Claude Sonnet 5 and Opus 5 both passed on this daemon candidate.

**Frontend boundary:** the desktop progress changes are in the built `apps/console-web/dist` bundle. A daemon-only hotpatch will not display them. Coordinate a frontend/full-app refresh with the UI owner; that bundle also contains their current Home mock WIP. Do not quietly ship that separate work as part of a harness-only patch.

After hotpatch, rerun the original Google Doc + Apify/DataForSEO Plan task in Claude, then discuss/revise the saved plan and Execute the selected revision when ready. This original connected-service journey has not been replayed live on the new candidate. Its prior source `197538` remains preserved and terminal; no original business artifacts were modified.

## Remaining work, in order

1. **Avoid guessed local capability refs.** Final Sonnet guessed `cap:local:write_file:reversible`; current discovery returned `cap:local:write_file:create`. It repaired and completed, but first-attempt selection is not fully reliable. Improve delivery of exact current refs where the schema is already known; do not accept fabricated account/manifest identities.
2. **Runtime synthesis in long plans.** Today's strong proof is prepared-content execution. A future research result followed by model-written synthesis is not the same case. Dynamic arguments currently consume actual settled tool outputs; a `compute` step with `capabilityRef:null` is not a durable producer. `produce_document` renders supplied content; it does not itself reason about new evidence. Qualify or implement a real result-producing synthesis/worker path before claiming arbitrary research→report journeys are solved. Avoid freezing invented future report text or mislabeling a tool-free step as a receipt.
3. **Scalable explicit Plan fan-out.** This pass does not remove the existing 32-operation topology ceiling or add per-member reviewed arguments. Do not conflate fewer duplicated fields with unbounded explicit Plan execution. Model/tool batch and durable universe support must be aligned end to end, preserving completion counts and avoiding repeated effects.
4. **Installed UI and full connected workflow qualification.** Verify progress through tool gaps, publication repair, user steering and Plan→Execute in desktop and mobile. Then exercise the actual connected research task and a controlled long conversation before judging tag readiness.

## Evidence and source map

- `output/reviewer-monitor/2026-09-12-plan-review/plan-execute-live/`: final reports, raw events, first candidate and corrections.
- `output/reviewer-monitor/2026-09-12-plan-review/plan-execute-qualification.mts`: repeatable live driver.
- `output/reviewer-monitor/2026-09-12-plan-review/sonnet-research-live/`: original installed failure review, red/green local tests, build logs.
- `src/tools/publish-plan.ts`: authoritative outline compilation and preparation diagnostics.
- `src/runtime/semantic-boundary/admit-and-compile-accepted-source.ts`: exact discovery→callable descriptor comparison.
- `src/runtime/harness/host-turn-runner.ts`: check-in explanation handling.
- `src/agents/orchestrator.ts`: Plan and Execute guidance.
- `src/runtime/harness/hooks.ts`, `apps/console-web/src/lib/useChat.ts`, `apps/console-web/src/components/chat/ActivityCard.tsx`: observable progress and honest tool-result status.
- Earlier context: `docs/checkpoints/2026-09-12-plan-turn-root-cause-handoff.md` and `docs/checkpoints/2026-09-11-tool-result-and-routing-framework.md`.
