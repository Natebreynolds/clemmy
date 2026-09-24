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

## 6. Closing the original pilot — 2026-09-23 18:40 → 19:35 PT (owner directive: close it, no new features)

Installed now: `3230e3de8`, fingerprint `eb69d7619c58…`, receipts `/tmp/clem-roles-patch` (4f76b423) and `/tmp/clem-truth-patch` (3230e3de8), rollbacks kept.

### Completed and proven on the installed build

| Claim | Proof |
| --- | --- |
| Approval → execution → correct Space records | Card `apr-6lp2` approved 18:36 PT; run `trigger-cbba991a` completed in 1.0 s, terminal `succeeded`, goal 5/5. Canonical store: 5 records = the first five of the 13 raw lines (`- SERP API`, `- AI Optimization API`, `- Keywords Data API`, `- Domain Analytics API`, `- DataForSEO Labs API`), each with section_name, source_ref (page receipt `509edf14…`), run_ref (the run id), observed_at. The leading `- ` is the reviewed contract's `prefix: ""`, not a projection fault. |
| Restart / replay | Daemon restarted three times since publication (hotpatches 4f76b423, 3230e3de8 and one more). Head digest `f7011ae4…` unchanged, 5 records, 0 replayed/duplicate observations, 1 partition; boot reconcile logged `replayed: 1, projected: 0`. Projection row still `queued` on the proven run with `apr-6lp2`. |
| Failure / retry | The first approved run (`trigger-0a70cd32`, judged negative) left the Space empty and its projection stuck; after 5f5a6d73 the released projection re-opened with a fresh card and the second run published. Pinned end to end in `automation-read-pilot-control-plane.test.ts` (negative judge → no claim, no head; release; fresh card; clean run publishes exactly once with its own dataset; boot reconcile + second drain change nothing). |
| Early dataset commit vs negative review | Same pin: the lineage produced before the judge is never published while the run needs attention, and no record of the clean run cites the judged-negative run. The judge is asserted to have SEEN the projection facts. |
| Truthful completion | Run report now says "Projected 5 documentation_section records into the … Space" (pinned). `space_get` reports canonical records; fresh-session status turn at 19:26 PT answered with the five names, coverage 5/5, recurrence inactive. Before the fix (19:08 PT, same question in the pilot session) the reply said the Space "holds nothing". |
| Explicit request roles | Usage rows carry `role` + `roleReason`; the route layer tags judge→reviewer and worker at the wire. Rows since 19:26 PT: brain 5, reviewer 7 (incl. post-turn reflection judges that were `unset` at 19:13), router 2, unset 0. |
| Retention bounded + tested | 128 names per source, oldest disabled released first; pins: re-enable keeps place and sealed schema; a changed schema is refused by the sealed universe (unchanged behavior); a restart rebuilds first-seen order. |
| getAllTools MCP fixture | passes (fixture records the turn's proven read); runner file 305 tests, same 20 pre-existing failures. |

### Measured (scripts/measure-source-turn.mjs, live home)

| Turn | Wall s | Frames (brain/rev/router) | Uncached tok | Total prompt | Largest prompt | Output | Tool calls | Repairs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 293174 pilot prep (before lifecycle fix) | 120.6 | 21 (8 Flash) | 138,356 | 443,892 | 54,884 | 17,460 | 9 | 0 |
| 293289 stuck-projection loop | 806.4 | 40 (21 Flash) | 538,815 | 1,852,543 | 109,617 | 78,980 | 34 | 0 (2 retry decisions) |
| 293628 pilot prep (all fixes) | 49.0 | 8 (3 Flash) | 143,607 | 350,007 | 114,386 | 2,847 | 4 | 0 |
| 293703 status check, heavy session | 282.4 | 10 (5 brain) | 295,037 | 519,549 | 121,449 | 11,434 | 5 | 0 |
| 293783 status check, fresh session | 70.1 | 9 (5/2/2) | 83,775 | 119,935 | 20,214 | 4,928 | 6 | 0 |
| pilot run `trigger-cbba991a` | 1.0 | 0 model frames | — | — | — | — | 1 read | 0 |

Reading: the controlled session's own history (110k+ tokens) is now the dominant cost, not the harness: the same question costs 70 s / 84k uncached in a fresh session versus 282 s / 295k in the pilot session. Together GLM-5.3-Flash frames at 120k context took 66–98 s each. Together also misses the cache on a frame issued within ~1–2 s of the previous frame settling (frame 2 of 293783 and of 293628), and evicted once at 120k (frame 4 of 293703) with the input append-only — provider behavior, recorded, not ours.

### Still open (release gates, reported separately from the fixes above)

- **Owner decisions:** publish a reviewed projection over a failed judge (classifier refused; gate unchanged); advertise plan_task from frame 1 (one ~60k re-bill per planning turn today).
- **Recurrence:** proven pilot awaits the owner's separate recurrence approval; not activated.
- **Section 6 items 1, 3–8:** mobile approval after restart with duplicate tap; P1/P3 mutation crash matrix; judge under Claude quota; request-sized latency walls; Jev trajectory decision; cold unfamiliar-tool discovery; test debt (20 host-runner failures still unattributed) and the full idle-machine suite/journeys.
- **Not proven here:** a provider-failure path live (MCP server down during the read) — covered only by the blocked-status branch of the release pin; physical mobile routing; fresh/upgrade installer; long-horizon plan preservation; proactive surfaces.
- Contract authoring quality: the reviewed text interpretation kept the markdown bullet in section_name (`prefix: ""`); fine for acceptance, worth a nudge in authoring.
- No tag, push, or main merge. UI untouched.
