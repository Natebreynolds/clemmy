# Combined takeover — September 27

Owner authorized taking over the three usage-limited agents, finishing their work, combining it, hotpatching the installed application and measuring against this morning's tasks. No tag is claimed here. The monitoring automation is paused during implementation.

## Source included

Integration branch: codex/release-integration-0927, worktree clem-worktrees/combined-retry. Parent integration 829eba453 incorporates shipping/UI 7ff3ee3ee, memory workers and Lean Rounds wave one, plus no-answer transient retry. The temporary completion-repeat/focused reviewer experiment is excluded. Added retry comment 48ef396fb, Lean Rounds wave two dba889037, memory/context series through 419c20efd, asynchronous backup/phase lane 1ee829755 and sliced maintenance/cursor lane 9930f7dcc. The memory branch's older ratchet-only commit e79560b69 was omitted; the combined benchmark is rerun and only lower measured ceilings retained.

Voice branch 334a3a9e6 remains separate: do not describe it as installed or accepted.

## Unfinished work closed in this takeover

- Wire scheduled maintenance to sliced link/backfill/purge operations and resumable cursors. Space heavy catch-up jobs across daemon ticks, with startup/wake settling and bounded retry admission. Keep original job schedules and semantic decisions; this is not a new memory inference policy.
- Await worker-backed snapshots in asynchronous reconciliation. Preserve backup exclusion until a timed-out native worker actually exits.
- Record backup and link-organizing jobs in the shared Memory at work read model for desktop/mobile.
- Restore standing goal titles/next actions, eight held objectives and the loader's existing working-memory allowance. The unfinished branch had replaced goals with a count and clipped held tasks/checkpoints. A real host-turn test now checks those contents reach the brain request.
- Lexical similarity retrieves advisory examples only. Binding an operation requires an unambiguous exact accepted request or Jev's decision, followed by existing schema/account/effect attestation. Paraphrases and new targets remain usable through Jev. A read request cannot inherit a remembered delete operation based on shared words.
- Remove the added Jaccard suppression of advisory learned examples; retain two candidates and label them as candidates, not a semantic judgement.
- Stored-result JSON recovery accepts complete values and recognized host framing; it does not promote examples inside arbitrary documentation/prose to authoritative rows. Model structured-answer repair is unchanged. Mixed CLI help plus JSON stays available verbatim through the text reader; typed CLI stdout JSON remains queryable. The old test expecting arbitrary mixed prose to become records was replaced by explicit non-misclassification plus lossless text access checks; carrier-lineage fixtures now use actual structured data rather than fabricated H-prefix prose.

## Verification before installation

140 focused integrated tests passed for tool reachability, approval/resume memory, plan execution, and Lean Rounds. 115 focused restoration/parser/recall tests passed; 43 combined host-memory and benchmark checks passed. Root typecheck passed. Backup timeout, sliced-pass/cursor and admission fixtures passed; full source qualification and installation remain outstanding at this checkpoint.

Fixture tests use disposable homes, never destructive resets against the live home. Because the installed daemon remained active, the isolation runner's live-home sentinel explicitly reported NOT PERFORMED; it is not an isolation acceptance claim.

## Baseline and comparison

Installed source observed before takeover: 59d5cfe17b9f368671a3d308d3bd97b869b7fbaf, fingerprint 30526e04a5f10a7ca91d3b42d5d18dbd8807e4fa47b4ecef746982d8db5c5119, version 3.18.21. Served configuration: Grok 4.7 brain, DeepSeek V4.1 Flash worker, Claude Sonnet 5 completion judge. Preserve settings; validate actual served receipts rather than inferring authentication from coding-agent usage limits.

Morning accepted sources: saved-comparison 313499 (session sess-desktop-3ad280aeabe37e8d73206019), heartbeat rules 313591, Space/workflow 313645, calendar 313677 (last three share sess-desktop-ac680aef4b5316dc25a46349). Exact prompts and canonical read-only scores are retained under output/takeover-2026-09-27/before. The failed initial comparison at 313476 is a separate baseline failure, not a successful trial. Replay the three shared-chat prompts in order. Compare final answer correctness, tools, rounds, time, exact model/account/review disposition, all brain/reviewer/worker/memory/Jev tokens and cache accounting. Separate removal of experimental reviewer calls from brain/context improvements. One trial cannot establish a stable latency percentile.

## Installation and qualification still owed

Build after the final commit. Install daemon, both web bundles and the changed desktop shell through one signed Terminal .command recipe, retain rollback, hold the pending updater, launch ~/Applications/Clementine.app by path, verify served fingerprint. Verify graceful quit/reopen and run controlled installed/live-home acceptance, including workflow author/enable/execute, approval correction, continuation and no repeated completed effect. Preserve personal Spaces/workflows and the owner's dirty handoff/token meter. Do not tag on fixture checks alone.

## Traps retained

No stash round-trip or git add -A in shared worktrees. Main's uncommitted JEV handoff is intentionally owned by the user. Do not install a daemon-only patch and claim desktop quit fixes landed. Native SQLite worker termination is asynchronous. Low disk space was real: abandoned disposable test homes were removed only after checking no process used them; live data and rollback copies were preserved. Broad tests stopped once while source review found unfinished continuity defects; that partial run is not a pass. No paid model calls were made for these fixture checks.
