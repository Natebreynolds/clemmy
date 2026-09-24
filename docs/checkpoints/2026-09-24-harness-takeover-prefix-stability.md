# Harness takeover — prefix stability, judge view, pilot lifecycle — 2026-09-23/24

Taken over from the Codex handoff (`2026-09-23-agent-handoff-current.md`) at
17:00 PT. Owner directives for this wave: hotpatch and run any model quick and
token-efficient with no regression, use the Jev routing already built, and
prove every change against the hotpatched installed app, never with isolated
tests as the proof. No tag, no push, no main merge. UI untouched.

## Installed state

| Item | Value |
| --- | --- |
| Worktree / branch | `clementine-next-harness-3-19` / `harness/3.19` |
| Installed daemon | `5f5a6d738e6cf1dc36c480103949874596c3ba55`, fingerprint `affaa12c33d2c2d4eec929cc1bd1a74cbeff74d56a5e9388dfe35a8e24010bdc` |
| Hotpatch receipts | `/tmp/clem-surface-patch` (88c4e917), `/tmp/clem-judge-patch` (f8b5c211), `/tmp/clem-lifecycle-patch` (5f5a6d73); each keeps `rollback/` and the daemon `dist.backup-*` |
| Desktop asar | unchanged, `44cf6d91…` |
| Updater | `pending.held-20260921-215159` still held |
| Brain during all live work | Together `zai-org/GLM-5.3-Flash`, owner-selected; judge grok-4.3; Jev routing on |

This docs commit sits on top of the installed candidate; the fingerprint
includes docs, so a rebuild before the next hotpatch is required as usual.

## 1. Root cause of same-source cache misses (measured, not inferred)

Read from `model_request_provenance.provenance_json.layers` per request and
`accepted_model_batch_admissions.pre_history_json` per frame. Every same-source
zero-cache frame on 09-23 (45 frames, ~2.1M uncached Opus tokens; the Together
lane identical) was a frame whose `catalog` layer changed while the model INPUT
was 100% append-only: `plan_task` joining mid-turn (+9.9 KB), plan_task or
work_call leaving after activation, or the set reordering on a host re-entry.
Tool definitions lead every provider's cache prefix, so one change re-billed
50–75k tokens on the next frame.

Fix (88c4e917, host-turn-runner): advertised-surface memory per accepted
source. A tool the model has been shown keeps its wire position and its last
shown schema for the rest of the source across re-entries; enablement still
decides callability; a call to a retained-but-disabled tool is a typed
effect-free pre-dispatch refusal. Pin appended to host-turn-runner.test.ts.
Also landed the handoff's fixture repairs, including the getAllTools MCP case:
the fixture now records the turn's proven read resolution the way admission
does; no runner guard was relaxed. Runner file: 305 tests, 285 pass, the same
20 pre-existing failures as before (attribution still owed).

Live proof (source 293174, Flash): the pilot-prep turn that failed twice for
the previous agent completed with reason success and raised card `apr-m60x`
in 120 s; catalog byte-stable across all 7 provenance frames; Flash cached
40,320–44,800 of 48–55k tokens on every frame after the first.

Remaining known break in this class: plan_task JOINING for the first time when
the planning catalog gains its first capability (seen once in source 293289,
one 63k re-bill). Its enable rule requires a non-empty catalog and is pinned by
`plan-tools-topology.test.ts` after a measured 16-refusal spam. Owner decision:
advertise plan_task from frame 1 on act turns (saves one re-bill per planning
turn, risks early refused calls on weaker models) or accept one break.

## 2. Judge could not see the reviewed projection (f8b5c211)

First approved pilot run `trigger-0a70cd32`: the read node ran and settled
(dataforseo__docs_list_sections, structured evidence) in 10 s, but the workflow
goal judge saw only the opaque `retained_canonical_entity_read` handle, scored
1/5 ("no records list or count shown"), the run needed attention, and the
Space projection — produced only when the run needs no attention — was
withheld. Space `{}`, projection row stuck `queued`.

Fix: produce the reviewed projection lineage BEFORE the goal review
(idempotent, replay-safe) and put its facts in the judge evidence (records
projected, contract fields, target Space, write scope). Publication gate
unchanged: the projection still publishes only when the run needs no
attention. The auto-mode classifier refused the stronger version (publish
regardless of the judge and widen the judge-only advisory rule to reviewed
projections) as weakening a gate; that is an owner decision.

## 3. Pilot projection lifecycle had no terminal for an unproven run (5f5a6d73)

After the failed run, every request for the same proposal revision got the
same durable projection back (`cardCreated:false`) and the Flash brain spent
12 min, 1.3M input tokens, 34 tool calls (12 tool_search, 4 identical
workflow_run_status polls) looking for a "durable projection reconciliation"
control that did not exist, then ended blocked.

Fix: a queued projection whose run finished without proving the pilot (needs
attention, blocked, or any non-completed status) is released as a typed
`run_unproven` refusal — on the next request and in the boot/timer reconciler
— and the next exact request re-opens it: same durable identity and bytes, a
fresh approval and card, no receipt or run. Every other refusal stays final; a
live run still returns the existing projection with no second card. Pin in
automation-read-pilot-control-plane.test.ts (21/21 in that file).

## 4. Live end-to-end on the installed app (all three fixes)

Source 293628, Flash brain:

| Step | Result |
| --- | --- |
| Pilot prep turn | 4 tool calls, 3 Flash frames, 49 s wall, card `apr-6lp2` |
| Prep usage | 350,007 input / 206,400 cached / 143,607 uncached / 2,847 output; prefixReuse 0.919 (frames 2–3 cached 103,040 of ~113k) |
| Approved run | `trigger-cbba991a`, completed, needsAttention false, terminalOutcome succeeded, 1.0 s |
| Goal review | 5/5 criteria, "all criteria met" (judge saw the projection facts) |
| Space | canonical projection `available`: 5 canonical records, coverage complete/exhausted (5 of 5), provenance 20 assertions |
| Projection row | `queued` on the proven run with `apr-6lp2` — the durable authority for a separately approved recurrence |

Section 6 item 2 (durable pilot) is now proven through review → approved
execution → Space records with provenance. Recurrence was NOT activated; it
needs the owner's separate approval. The first frame of that session now costs
~111k tokens because the controlled session carries the whole failed history;
a fresh session would not.

## 5. Instrument corrections and provider facts

- `usageEfficiencyForEvents` chose the brain by call count, so eight Jev
  routing calls beside eight brain frames reported the whole turn as side
  traffic with prefixReuse 0. Now by prompt bytes (f8b5c211, pin added).
- Together returned 402 (monthly cap) until ~17:20 PT; cleared by the owner.
- Together ignores `thinking:{type:'disabled'}`, `chat_template_kwargs.enable_thinking=false`
  and `reasoning.enabled=false` for GLM-5.3-Flash: it reasons on every call
  (1.5–3.7k output tokens per tool frame at ~60–170 tok/s) and ~50 KB of
  reasoning is replayed per frame. Speed on Flash comes from fewer frames.
- Together caches the prefix in 4,480-token blocks; 5–7k uncached per frame is
  provider granularity.
- `sqlite3 … ?immutable=1` does not see the WAL; read the live DB with `?mode=ro`.

## Owed

- Owner decisions: publish-over-judge for reviewed projections; plan_task
  advertised from frame 1.
- Attribute the 20 remaining host-turn-runner failures against HEAD/tag.
- Full idle-machine suite/journeys; the rest of the section-6 matrix.
- Report copy for a clean pilot run says "routine read … nothing new" without
  naming the 5 projected records; the outcome composer should see the
  projection summary too.
- Promote the provenance layer-drift analysis into `scripts/`.
