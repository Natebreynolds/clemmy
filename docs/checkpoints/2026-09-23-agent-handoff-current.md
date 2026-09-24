# Clementine harness handoff — September 23, 2026

## Start here

Continue the existing release objective: an intelligent, fast, token-efficient harness with reliable discovery, memory, long-running execution, workflows, approvals and proactive behavior. This is **not release-ready**. Do not turn focused test passes into a broad acceptance claim, or replace the original pilot with an easier example.

The owner is handing further work to another agent. This document distinguishes the installed candidate from uncommitted test work. No tag, push or merge was performed in this handoff.

Read the repository AGENTS instructions and these existing mandates before editing:

- `docs/NEXT-TAG-HANDOFF-2026-09-22.md`, especially section 6.
- `docs/JEV-FRAMEWORK-HANDOFF-2026-09-21.md` (the owner's uncommitted copy on main is intentional).
- `docs/NEXT-TAG-RELEASE-GATE.md`, particularly candidate/tag procedure.
- September 19 current-framework-state, active-configuration and weekend-refinements checkpoints.
- `docs/checkpoints/2026-09-23-host-runner-test-debt.md` for the current local test evidence.

## Exact source and installed state

| Item | Verified value |
| --- | --- |
| Harness checkout | `~/clementine-next-harness-3-19` |
| Harness branch | `harness/3.19` |
| HEAD | `a8b0cb9478b9c827b37024f1831011cb054868a6` |
| Shared main checkout | `~/clementine-next` |
| Main HEAD | `e77215d008623bf30bddf13448f00496483a5e2c` |
| Installed app | `~/Applications/Clementine.app` |
| Running gitSha | `a8b0cb9478b9c827b37024f1831011cb054868a6` |
| Running fingerprint | `50b78c6dd10ac2d4af89c5f19503638298beb4a8e8916bb4b10813580933bf30` |
| Build-info version/schema | 3.18.19 / 81; source package version is 3.18.20 |
| Daemon | PID 80652, instance `0d0cf4a5-ff14-4d90-8f81-dd739bffb08f` |

Build-info was rechecked while writing this handoff. Recheck it again before live work. A version label alone does not identify hotpatched bytes.

The harness worktree has an uncommitted change to `src/runtime/harness/host-turn-runner.test.ts` and untracked checkpoint documents. **These test/doc edits are not installed.** Preserve them and inspect their diff; one latest MCP fixture edit is still failing. Main's user/UI-owned edits were not changed. Do not use `git add -A`.

## Installed runtime fixes and their limits

Two latest commits address the actual controlled pilot failure:

1. `7f829641dceaf15a470886dd83743b8fbdada65b` makes pilot contract refusals explain the exact mismatches instead of only `dataset_contract_unrepresented`: record/evidence paths, identity/merge/outcome requirements and approved bounds. Existing admission predicates remain intact.
2. `a8b0cb9478b9c827b37024f1831011cb054868a6` classifies narrowly typed pilot contract refusals as repairable arguments. Previously a repairable refusal moved the runner onto a retained-readers-only recovery surface, which then blocked the corrected pilot call before validation. Only the three explicitly typed contract-refusal classes receive the marker; no blanket retry, authority or consent relaxation.

Evidence: `2026-09-23-together-flash-pilot.md`, `2026-09-23-pilot-repair-classification.md`, and `output/harness-acceptance/2026-09-23-pilot-flash/`. The latter fix had 107 focused checks pass across pilot/bridge and recovery/projection checks; build and typecheck passed. Both are installed, but **the original pilot has not passed live on this candidate**.

Installed patch receipt: `/tmp/clem-contract-diagnostic-patch/apply.command`; daemon backup `daemon/dist.backup-ZhvgSa`, skill backup `daemon/builtin-skills.backup-Aygw2C`, outer-bundle rollback `/tmp/clem-contract-diagnostic-patch/rollback`. Same Developer ID signature and strict verification passed. Desktop asar was unchanged, SHA256 `44cf6d91df5d32c50c712d188178d4572e43fb6e01d28740e30823874942ce8e`.

Earlier desktop notification fix was installed and the owner reported seeing and clicking the notification. Do not present that as proof of every notification-center/mobile route. Earlier fixes and their evidence remain in the checkpoints; do not blindly replay completed live sources.

## Together AI: positive balance, unresolved provider rejection

Last deliberately selected brain: Together `zai-org/GLM-5.3-Flash`, globally and on the controlled pilot session. The browser later showed the DeepSeek-V4.1-Flash model page; **that is not evidence that Clem's selected model changed**. Read the current settings before choosing a model.

Authenticated billing inspection showed $24.82 credit balance and $0.18 monthly spend. Clem's installed configured key matched the active dashboard key suffix `eAQE`. Do not expose the full key.

A single tiny direct request with that installed credential (`Reply with OK.`, max output 32) still returned HTTP 402, type `credit_limit`, request ID `2a9d68e6-aws_uw1`. Thus a large harness prompt alone does not explain this rejection. Together documents 402 as account spending-limit enforcement and 429 as rate limiting. Account/project enforcement or credit propagation remains unresolved; do not claim the owner has no credits, buy more credits, raise caps, or repeatedly retry paid work.

Evidence: `together-bounded-diagnostic.json` and `billing-followup.json` under the pilot-flash output directory. No billing settings were changed and no support message was sent. No switch to another provider was made after this error. Do not use Claude/Codex quota for generative testing. A provider change needs the owner's selection rather than silently substituting and calling the requested provider validated.

## Original live pilot — continue this exact work

- Proposal: `automation_3da1c635b0a7dd98a928b7957369731f`, revision 3.
- Proposal digest: `9574eff2192f943e63a3ae49e3f4d7122082f04d8ab8f716e623bf444ff8f207`.
- Session: `sess-branch-fc6e72b7adb9606216979cc582e5b9fdaafa857a`.
- Controlled title: Harness acceptance — documentation inventory 0923.
- Requirement: `doc-section-inventory-read`; phase `read-inventory`.
- Objective: read-only provider documentation section inventory, free metadata only.
- Provider operation: DataForSEO MCP `docs_list_sections`, no arguments; 13 text lines observed.
- Output: at most five records with section_name/source_ref/run_ref/observed_at and host provenance.
- Space: `harness-acceptance-doc-inventory-0923`, revision 1, digest `fb7ef4fd31762adc2da215976ad3bc28c38437b1eab802c33cf335bb86d6e526`.

Pilot review approval precedes execution. Recurrence requires separate approval after a proven pilot. No approved pilot execution or schedule is proven yet. Do not alter personal/business Spaces or resume unrelated parked workflows.

Recorded failed runs:

| Brain | Source → terminal | Wall | Usage and result |
| --- | --- | --- | --- |
| GLM-5.2 | 292863 → 292914 | 26.963 s | 9 usage rows, 183,981 input / 76,096 cached / 3,504 output; only acquisition_list executed, repeated negative review, blocked |
| GLM-5.3-Flash | 292990 → 293095 | 177.855 s | 18 usage rows across Flash/Jev/Grok, 340,822 input / 189,696 cached / 14,974 output; two opaque pilot refusals, corrected call blocked by recovery surface, then 402 |

Flash-only share: seven requests, 314,540 input (188,160 cached; 126,380 uncached), 14,368 output; estimated $0.0317858 at the published prices, not an invoice. The last prompt estimate was 59,398 tokens. This is failed-work overhead, **not a successful speed or efficiency benchmark**. The repeated 998-token outputs in the earlier run suggest a cap worth examining, but there was no preserved finish_reason proving truncation. Do not raise limits speculatively.

## Local regression work: completed and unfinished

All changes below are in the uncommitted test file, with no runtime changes.

Completed fixture repairs:

- Host stepping now supplies accepted source, wrapped tool, envelope and production runner; original call/body/hook assertions unchanged.
- Retained-result reading expects task_work, consistent with the already shipped behavior, rather than a stalled dependency lookup. Discovery retry limits remain asserted.
- Eight transport cases now exercise a declared reversible provider operation with exact consent grant and structured durable receipt. They verify one completed write, no partial-intent dispatch, retained evidence, bounded retries, and no retries on cancellation/permanent errors. Provider bodies are recording stubs; no network writes.

Last completed combined check **before the newest context edits**: 364 tests, 341 pass, 23 fail, 29.60 s; typecheck passed; no newly failing top-level names. This comprises host-turn-runner plus host-no-progress-projection, not the repository suite. Eight transport cases passed in the full file. Each repaired transport test had been reproduced alone at both HEAD and last tag v3.18.19.

Latest context edits, made after that combined check:

1. Dynamic instruction refresh fixture: focused pass; still asserts revisions 1 and 2 on successive requests.
2. Newly enabled tool preserves existing schema prefix: focused pass; still asserts unchanged ordering after appending the new tool. No measured live cache saving is claimed.
3. `host tool resolution includes enabled MCP tools through agent.getAllTools`: **still fails**. It now materializes a controlled MCP read definition, returns it only through getAllTools, binds the envelope and enables tool brackets. Yet the host refuses it as not a configured harness-bound tool; provider body count stays zero. Exact diagnostic: `the selected host engine only admits configured harness-bounded tools`. Keep the assertion; determine whether configuredToolRefs/getAllTools ownership or fixture attestation is missing. Do not simply put the tool in agent.tools: that would evade the behavior this test is meant to prove.

Those three names each failed independently at HEAD and tag before editing. Evidence copied under `output/harness-acceptance/2026-09-23-host-runner-debt/context/`. Latest typecheck and diff check passed. All test/typecheck processes started for this handoff have finished; no paid run was launched. The full combined file has NOT been rerun after these three edits. The prior 23-failure count must not be described as the latest uncommitted candidate's verified total.

The shared transport helper restores catalog, manifest store, ports and brackets on normal test completion. Consider making cleanup registered before setup assertions, so a fixture setup failure cannot contaminate later cases. Do not broaden production exceptions to repair tests.

Last tag baseline checkout: `/tmp/clem-release-baseline-0923`, v3.18.19 at `8c11aa3c068ffc73813fec286ac3090214b8fb49`, with its own npm-ci dependencies. Whole-file baseline had 297 tests, 255 pass, 42 fail. Whole-file overlap alone is not individual attribution.

## Other verification already completed on a8b

- Release assets 56/56.
- Release closure 138/138.
- Smoke gate passed its deterministic setup checks; not visual fresh-installer acceptance.
- Packaged upgrade 21/21, disposable migration and two boots; not proof of another user's actual signed installer.
- Focused constraint/checkpoint process checks 5/5.

Receipts: `output/harness-acceptance/2026-09-23-release-a8b/`. Full suite and journeys still owed on an otherwise idle machine. Isolated-runner sentinel explicitly reported NOT PERFORMED while the live daemon owned the real home; never call that proof of live-home isolation. Tests themselves set disposable homes and recording transports.

## Next steps and remaining release gates

1. Inspect current diff and finish the getAllTools MCP failure without weakening the test. Continue the other remaining failures with independent HEAD/tag attribution. Commit only reviewed, complete changes; rebuild after any commit because fingerprints include HEAD/docs/scripts/src.
2. Resolve or have the owner select a usable provider, then drive the original pilot on the installed candidate. Capture one accepted source, exact settlements and terminal. No blind replay of a failed accepted source, no simpler substitute task.
3. Complete pilot review → execution → Space records/provenance → separate recurrence approval. Then measure matched successful work, including judge/repair usage, cached and uncached tokens, tool calls, wall and first-content latency.
4. Preserve the full section-6 matrix: mobile approval after restart and duplicate tap; read/draft/gate/send/uncertain-write crash recovery; quota-review behavior; request-sized silence/liveness; Jev trajectory decision after evidence; cold unfamiliar tool discovery; full idle-machine suite/journeys and failure attribution.
5. Remaining product evidence includes physical mobile routing, fresh/upgrade installation, retained-memory correction, mixed native/MCP/CLI/Composio use, long-horizon context/plan preservation and proactive goal/heartbeat surfaces. Earlier bounded passes do not prove this entire candidate.

Also still open: prompt/context growth, review-negative versus unavailable vocabulary, early usage attribution, model catalog/context-window truthfulness. Do not change a negative review to success or infer subscription exhaustion from standalone CLI auth. Clem owns its Claude OAuth credentials.

## Operating rules

- Framework fixes only. Controlled fixtures in installed app/live home for acceptance; never destructive resets against `~/.clementine-next`.
- Launch exact app path, not `open -a Clementine` (stale app risk).
- Hotpatch through the existing Terminal `.command` recipe only after verifying no active requests/dispatches/recording and coordination with the UI owner. Quit cleanly, preserve rollback, sign/strict-verify, reopen by path, verify served fingerprint.
- UI agent owns UI/release tagging. Narrow desktop notification work was separately authorized; do not infer broad UI ownership.
- Do not tag from this evidence. Full completion, speed gains and provider acceptance remain unproven.

## Prompt to continue

Continue the Clementine harness release work from this document in the existing harness/3.19 worktree. First inspect the exact installed fingerprint and uncommitted diff. Preserve the user's and UI agent's edits. Finish the getAllTools MCP fixture/admission issue without moving its tool into agent.tools or weakening assertions; then close the remaining attributed failures. Keep the original live pilot and full release matrix intact. Resolve the Together 402/positive-balance contradiction or use the owner's chosen provider before paid live testing. No Claude/Codex generative tests, no blind retries, no destructive live-home fixtures. Prove changes in the installed app with exact source/settlement/terminal and complete cost/latency accounting before claiming readiness. Do not tag or silently substitute a smaller acceptance task.
