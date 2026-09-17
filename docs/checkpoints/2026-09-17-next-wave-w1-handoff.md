# 2026-09-17 — Next-wave W1 handoff (recovery surface, off-surface carry, inner next-edge)

Status: **uncommitted working tree, hotpatched into the owner's local install, not tag evidence.**
Audience: the next implementing agent.
Date of this soak: 2026-09-17.

Parent brief (normative for this wave): [`docs/NEXT-WAVE-NORTHSTAR-IMPROVEMENTS.md`](../NEXT-WAVE-NORTHSTAR-IMPROVEMENTS.md)
Constitution: [`docs/north-star-unification.md`](../north-star-unification.md)
If this checkpoint and the brief conflict, the brief wins. If the brief and the constitution conflict, the constitution wins.

---

## 0. What you are taking over

This session shipped the **reliability pair + the host-disposition next-edge slice** from the next-wave brief, then hotpatched the daemon. It did **not** start **W0** (stage-then-commit / no per-write cards). That is the next product workstream.

The git working tree was already dirty with a large Spaces/workspace wave when this session started. **Do not treat `git status` as this session's diff.** Files for *this* wave are listed in §3. Everything else in the status is someone else's in-flight work — do not revert, restyle, or "clean up" it.

Package version on HEAD / `package.json`: **3.18.9**. No tag has been cut for this soak.

---

## 1. Installed bytes (hotpatch)

| | |
|---|---|
| App | `~/Applications/Clementine.app` |
| Was | 3.18.9 (prior soak: W1a/W1b only, fingerprint `8b74b885…`) |
| Now | same version string, **this slice** fingerprint **`01da950172b204aa6c9b928047a7a885771025d8101fec450c8f9270d9001d9e`** |
| Daemon rollback | `Contents/Resources/daemon/dist.backup-icZwuY` |
| Skills rollback | `Contents/Resources/daemon/builtin-skills.backup-K5JY3K` |
| UI | desktop/web **unchanged** by this hotpatch |

Apply path used: quit app → `npm run build` → `node --import tsx scripts/hotpatch-daemon.mjs`.

The app is **not running** after this patch. Owner launches it to soak.

---

## 2. What landed (in order)

### W1a — recovery advertised-list stability (~10 stuck turns/day)

**Done.** Ordinary no-progress recovery **no longer shrinks** `modelStepSchemas` to the permitted set. The accepted-turn tool array stays on the wire (cache-stable). Permission is still enforced at **admission** via `permittedNoProgressRecoveryToolNames`.

**Exception (keep it):** the one Plan-exhaustion **publish-only** step still advertises `publish_plan` (+ `ask_user_question`). Live 2026-09-15: the model never published if it could still see discovery. Test: `an exhausted Plan turn gets one publish-only step before it stops`.

**Do not** retune `hostNoProgressRecoveryToolNames`. Offline it is already correct (`recovery-not-a-dead-end.test.ts`). The live bug was shrinking the advertised list so the next step's `available` log lost the carrier.

Logging already on `recovery_surface_reprompt`: `attempted`, `permitted`, `available`, `consequenceStage`. Do not re-add it.

### W1b — off-surface direct calls carried at admission (~9/day)

**Done.** If the model calls `read_file` / `workspace_roots` / a slug by **direct** name and that name is not in `toolByName`, admission **carries** the invoke through `call_tool` (registry local/read/control) or `work_call` (business/send/admin) and runs **that carrier's** reachability.

**Sealed identity stays the authored call.** `{ callId, name, arguments }` on the top-level pair remain the model's name. Do **not** rewrite `call.name` to `call_tool`. `mirrored-call-identity.test.ts` is the cousin: one invocation observed twice is still one.

Unreachable names still `not_reachable`. A carried send does **not** skip W0 (W0 is not implemented yet; do not invent YOLO).

Helper: `resolveOffSurfaceDirectCarry` in `src/runtime/harness/tool-effect.ts`. Tests: `src/runtime/harness/off-surface-direct-carry.test.ts`.

### W1 — inner-tool next-edge on host dispositions

**Done for the host-disposition path only.** Recoverable `retry: 'replan'` refusals from `dispositionResult` in `host-turn-runner.ts` now attach a typed `HostNextEdgeV1` whose `.tool` is the **inner** refused operation (`edgeToolName` unwraps `call_tool` / `work_call` / `composio_execute_tool`).

This is the 2026-09-11 defect: the host told a stuck Plan turn, verbatim, `Use call_tool to resolve this step` three times.

`describeCanonicalHostModelResult` round-trips `marker.nextEdge` so history still matches. Receipt **fallback reconstruction** from `host_model_result_receipts` still rebuilds the default edge from `toolName` (no next-edge column). Restart prefers the committed history item when it matches the receipt hash. If history is missing and the refusal used an inner-tool edge, reconstruction fail-closes (hold) rather than minting different bytes. Do not add a schema column in this wave unless restart-without-history of wrapped refusals is proven broken live.

**Not done (remaining W1):** confirm-first, destination-gate, constraint-guard, and other gate copy that still names a wrapper in prose. Do not boil the ocean. The live wrapper-retry path was the host disposition.

### Proof check retune

`scripts/proof/scenarios/schema-on-demand.ts`: the check is now **omitted schema was invoked (direct or carried)**. Pass if `workspace_roots ≥ 1`. Direct dispatch after W1b is success; `call_tool × 0` is not a fail.

---

## 3. Files that belong to this wave

Touch these; leave the rest of the dirty tree alone.

| File | Why |
|---|---|
| `docs/NEXT-WAVE-NORTHSTAR-IMPROVEMENTS.md` | Wave brief. W0 is next. |
| `docs/README.md` | Index line for that brief. |
| `src/runtime/harness/host-turn-runner.ts` | W1a no shrink; W1b carry at `executeCall` + recovery admission; W1 inner next-edge in `dispositionResult`. |
| `src/runtime/harness/tool-effect.ts` | `resolveOffSurfaceDirectCarry`. |
| `src/runtime/harness/next-edge.ts` | `edgeToolName`, `isWrapperEdgeTool`. |
| `src/runtime/harness/next-edge.test.ts` | Inner-tool edge + round-trip. |
| `src/runtime/harness/host-model-result-receipt.ts` | Parse/pass `nextEdge` on rebuild. |
| `src/runtime/harness/recovery-not-a-dead-end.test.ts` | W1a: no `recoveryTools` shrink; Plan-final exception. |
| `src/runtime/harness/off-surface-direct-carry.test.ts` | **New.** W1b helper + sealed-name pin. |
| `scripts/proof/scenarios/schema-on-demand.ts` | Proof check retune. |

---

## 4. Tests already green (do not re-litigate)

Focused (this session):

```
node scripts/run-tests-isolated.mjs src/runtime/harness/next-edge.test.ts
```

**9/9 pass** (2026-09-17, after this hotpatch build). Includes `edgeToolName names the inner refused tool` and `a wrapped refusal tells the model to repair the inner tool, not call_tool`.

Earlier in the session (same tree, before this last hotpatch, still the same W1a/W1b/W1 source):

- `recovery-not-a-dead-end.test.ts` + `off-surface-direct-carry.test.ts` + `host-no-progress-governor.integration.test.ts` — 30/30 then 27/27 after Plan-publish exception.
- `host-no-progress-projection.test.ts` + next-edge + preparation diagnostics — 70/70.
- Isolated runner sentinel **NOT PERFORMED** while a live daemon owned the real home. CI will prove isolation. Do not "fix" that by pointing tests at the owner's home.

---

## 5. Live Codex Terra proof (dev evidence only)

Command:

```
npx tsx scripts/proof/run-proof.ts --allow-dirty-dev --brain codex --require-brains codex --scenario converse-first,schema-on-demand
```

Result (2026-09-17, **before** the proof-check retune and **before** W1 next-edge; W1a/W1b were in):

- Banner: `DEV EVIDENCE ONLY — sourceClean=false`. Not tag evidence.
- `codex × (brain-served)` **pass**. Terra served.
- `converse-first` **fail (6/8)**. Isolated proof home has no Salesforce/Slack. She searched, `call_tool`×2, `mcp_status`, `space_list`, then said reconnect Zephyr. **Zero outward writes.** Scorer wanted a which-tracker / which-channel question. Scenario mismatch, not a harness regression. Do not "fix" converse-first by wiring fake CRM into the proof home.
- `schema-on-demand` **fail (16/17)** on `call_tool × 0, workspace_roots × 1`. That is W1b: she called `workspace_roots` **directly** and it ran (10s, no shell, no fail-open). The check has since been retuned. **Re-run this scenario** after the owner launches if you want a green scoreboard; it was not re-run after the retune in this session.

Proof home kept for forensics (may already be gone): `/var/folders/2p/26lnqgjn0jg78_wwpg2y4l1c0000gp/T/clemmy-proof-codex-IgULx5`
Reports: `proof-report.json`, `proof-reports/2026-09-17T06-47-08-069Z-662733ddfde5.json`

---

## 6. Binding laws you must not break

From the brief, restated for this handoff:

1. **Reroute, do not bypass.** A gate names the next legal move. It never becomes skip-confirm-first or retry-the-uncertain-write.
2. **Side-effect law.** A send is one attempt. Never auto-retry `effectState: unknown`.
3. **Consent is a plan plus one commit conversation, never a card per write (law 9).** Planning cards stay. After Execute: rehearse (zero external crossings) → one conversational review of the saved packet → leased dispatch. **W0 is the next workstream.** Do not mint per-write `approval_requested` cards while doing anything else.
4. **Execute ≠ dispatch grant.** Approving a plan does not authorize physical sends.
5. Do not rewrite sealed `{ callId, name, arguments }` to the carrier.
6. Do not retune `hostNoProgressRecoveryToolNames` to paper over a missing carrier in `tools`.
7. Do not shrink ordinary recovery advertised schemas. Plan-final publish-only shrink stays.

---

## 7. What you do next

Sequence in the brief §8, with this session's progress:

| Order | Workstream | Status |
|---|---|---|
| — | W1a recovery advertised-list | **landed + hotpatched** |
| — | W1b off-surface carry | **landed + hotpatched** |
| — | W1 host-disposition inner next-edge | **landed + hotpatched** (gates besides host disposition still open) |
| **1** | **W0 stage-then-commit** | **open — start here** |
| 2 | W1 remainder (confirm-first / destination / constraint copy) | only if post-Execute still names wrappers; do not block W0 |
| 3 | W2 lease watchdog | after W0/W1 |
| … | W3, W10, W9, W4… | see the brief |

**W0 first PR** (from the brief §13): inventory post-Execute `approval_requested` emitters; add host `rehearse` vs `dispatch`; stage high-consequence intended crossings as artifacts; one origin-session `needs_input` in Clem's voice; one grant over the packet digest; keep the planning card. Default if unanswered: one packet-level Send control is allowed; per-item Approve/Reject is not. Outlook draft-id is an external create unless the plan named drafts.

Do **not** mix W0 into sealed-identity or next-edge files unless a refusal on the rehearsal path has no edge.

---

## 8. Suggested soak (owner)

Launch the hotpatched app. One cheap Plan:

> Plan a local note that lists this repo's workspace roots. Don't send anything.

Wanted: she reads/discovers, publishes a plan, no "Tool not found", no recovery death spiral, no `Use call_tool` as the only next move.

Optional Terra re-proof (dirty-dev):

```
npx tsx scripts/proof/run-proof.ts --allow-dirty-dev --brain codex --require-brains codex --scenario schema-on-demand
```

Expect `workspace_roots ≥ 1` pass even if `call_tool × 0`.

---

## 9. Rollback

If the soak is bad:

1. Quit Clementine.
2. Restore `Contents/Resources/daemon/dist.backup-icZwuY` over `dist` (and skills backup if needed).
3. Do not `git checkout` the whole tree — you will clobber the unrelated Spaces wave.

---

## 10. Addendum — follow-up review of this wave (same day)

Reviewed after the soak build. Four changes, all pinned, then hotpatched together with the Spaces/reliability tree.

1. **W1b authority parity (safety).** A carried off-surface direct call skipped `readOnlyCanaryRefusal` in `executeCall`, and the pre-approval loop never evaluated consent for it (its `canaryRefusal` was non-null, so `mutation` was false). Live effect in a fixture: `call_tool{note_create}` was refused before dispatch, while a direct `note_create` created the note. Fix: the pre-approval loop admits a carried call **as its carrier call** (same mode refusals, exact authority, consent) and queues the **authored** call (sealed name and admitted bytes unchanged); `executeCall` runs `readOnlyCanaryRefusal` with the carrier identity; the read-only canary lane mints its attestation with the carrier identity too. Pins: `host-turn-runner.test.ts` — "a write named directly off the surface meets exactly the host refusal its carrier call meets" and "production host carries a direct call to an off-surface reachable read through call_tool and keeps the authored name" (the end-to-end W1b row: one settlement, authored name, no refusal).
2. **W1a exception extended.** A required-question recovery (`consequence.recovery === 'ask_user'`) is a terminal one-move step like the Plan-exhaustion publish step, so it advertises only its permitted set. Without this, the existing pin "production host turns an exact plan account choice into one question with no provider body" fails. Source pin in `recovery-not-a-dead-end.test.ts` updated.
3. **Pre-W1b pins updated** in `native-read-argument-repair.test.ts`: an unpublished carrier-reachable read now runs when called directly (counts updated); the budget-exhaustion pin uses a name no carrier reaches, and asserts the contract (one decreasing budget, one consequence key, no execution, one blocked terminal, one check-in) instead of the old checkpoint-hop counts.
4. **Carrier output pairing** (`eventlog.ts carrierMirrorInvocationOutput`): an unparented transport-mirror return pairs only when the carrier call and return carry the same host `dispatchLeaseId`; the legacy non-host shape stays ambiguous (`skill-reference-producer.test.ts`).

Also: `reviewed-provider-identity.test.ts` same-millisecond schema observation race fixed in the test (6/6).

Full suite before these follow-ups: 16,409 tests, 5 failures, all addressed above; affected chunks and authority tests re-run green.

## 11. Addendum — two live calls before the 3.18.10 tag

Two calls on the hotpatched install (Plan soak, then the goal-driven Space prompt) each exposed a framework defect; all are fixed, pinned and re-verified live.

1. **Plan reply mismatch (pre-existing since 3.18.8).** The Plan judge hashes the reviewed `fullText`; desktop and mobile publish the card lead-in from `publishedPlanReplyText`. A ready plan ended `blocked` with `completion_review_reply_mismatch`. `delivery-committer.ts` accepts the lead-in only when the reviewed `planDigest` matches and the text is exactly `publishedPlanReplyText` of that reviewed plan. Pin: `host-turn-runner.test.ts` "final Plan review … (card_reply / card_reply_altered)"; it fails without the fix. Live: Plan soak `verified=1, planMatches=1, replyMatches=1`, delivered.
2. **Canonical scalar text.** The goal call ended `control_no_progress_exhausted` after sending `width:"1440"` to `space_preview` twice. `native-argument-repair.ts` reads a number or boolean sent as its exact canonical text as that value, on reads and ordinary writes. It covers JSON-Schema nullable unions; `"1e3"`, `"01440"` and `"1440px"` keep the refusal. Pins: `native-argument-repair.test.ts` and `call-tool.test.ts` "a carried read sending a number as its canonical text dispatches the number"; the latter fails without the fix.
3. **A committed write ends recovery.** After a refused `space_save`, the successful `space_edit_view` and `space_save` were `unmetered_attempt` with no authority gain, so the refusal's narrowed recovery surface stayed in force and refused a harmless `call_tool{space_get}`, spending the last retry. `host-no-progress-projection.ts` counts a successful mutating settlement with new receipt bytes as `settled_write_result` evidence; identical bytes add nothing. Pins in `host-no-progress-projection.test.ts`.
4. **Refresh receipts said zero rows.** `space_save` and `space_refresh` counted the first array one level down, which for command-line query output is `warnings: []`. The receipt said "open (0 rows)" while the data held 5/51/176/8 records, and the model told the owner the Space might be empty. Both now use `countWorkspaceRecords` (the `clem.rows` locator); an empty side list is unknown, not zero. Pins: `workspace-data-digest.test.ts`, `space-save-commit-coverage.test.ts`.

Re-verification after hotpatch: Plan soak delivered; the goal follow-up delivered with 40 tool calls, 0 failures, 0 refusals, every trajectory review on track, and correct record counts in the reply. Full isolated suite: 24 chunks, 0 failures.

Still owed: a local reversible write named with a sibling tool's `requirement_id`, or not yet disclosed for the source, costs one `tool_search` round trip. The host could publish the registry-declared definition itself, as W1b does for reads. The space gap test still refuses a save that adds a source before the view reads it.

## 12. Addendum — 3.18.11 follow-ups

1. **Space wiring step saves.** A declared source or action is exempt from the pre-save "view never references" refusal when the *saved* view does not read it either. The page renders exactly as before, and the post-save gap test still names the wiring as a fix. A new Workspace, or a view that stops reading what the saved view read, is still refused. Live (3.18.10 + patch): adding a `meetings` calendar source to The $40K Plan saved before the view read it. Re-saving that source's arguments before wiring was refused under the first rule (it keyed on "added this save"), which is why the rule is now keyed on the saved view. Pins: `space-tools.test.ts` "a source added to an existing Workspace before its view reads it saves…".
2. **Sibling requirement id.** `resolveHostLocalCallRequirement` (host-local-call-preparation.ts): a native write whose `requirement_id` names another configured local operation runs under the named operation's own current definition when exactly one of its write variants matches the arguments. The definition is published for the source the same way a remembered call is, and the host-prepared carrier bytes carry the corrected id. An id naming no configured local operation, or arguments matching no single variant, keep the refusal. Pins: `normal-native-write.integration.test.ts` (sibling runs, invented refused; the sibling case fails without the fix) and `host-local-call-preparation.test.ts`.
3. **Empty CLI sources.** `looksEmpty` (space-smoke.ts) decides by `countWorkspaceRecords` when a record list exists, so a query envelope with zero records becomes the zero-row gap question.
4. **Journeys.** The reviewer-unavailable note journeys now expect 3.18.8's plain sentence, with the operator reason on the review row. The unknown-external-mutation fixture is carrier-silent (`destructive: null`); carrier-declared non-destructive writes proceed by the 3.18.8 consent rule.

Open, with evidence:
- **Wall-clock gate.** `positive_host_wall_p95_le_50ms` measures p95 58–77 ms on the owner's loaded laptop (VS Code renderers ~150% CPU) at both 3.18.9 and 3.18.11; causal CPU p95 passes. It needs a quiet-machine or CI measurement.
- **CI Test workflow red for infrastructure.** A unit-test watchdog on `constraint-guard.test.ts` (600 s), the Windows daemon boot, the iOS project read, and runner shutdowns.
- **Completion review cannot fit large Space data.** The Space follow-up review was estimated at 1.24M tokens against a 712.8K window (703 calendar events). The review is complete-or-unavailable by design, so the result delivered as unreviewed. Whether a Space's data may be reviewed through its record digest instead of whole bytes is an owner decision.

## 13. Addendum — release publish is incremental

The v3.18.11 publish failed four times (HTTP 422, 400, 502, 400) on the 400–500 MB macOS assets. Evidence that it was GitHub's upload path, not this repo: the publish step took 0–2 minutes on the previous five releases with identical asset sizes; the same runner downloaded the same 1.8 GB artifact in 1.4 minutes; and 1 KB and 50 MB uploads to the same draft release from a workstation returned 201. Effective runner upload throughput fell from ~25 MB/s to ~0.4 MB/s.

What was ours: `gh release upload --clobber` re-sent every asset on each retry, so one flaky file cost 1.8 GB per attempt and never converged. The publish step now uploads one asset at a time, skips an asset whose uploaded size already equals the local file, replaces an incomplete one, retries a failed upload five times with linear backoff, and flips the draft only after every asset is verified present at its exact local size. Pin: `release-workflow.test.mjs` "a flaky upload costs one asset, and an incomplete set is never published" (fails against the old step).

The v3.18.11 draft was deleted and the work re-tagged as v3.18.12; its tag remains in history at ffe2b80c.
