I have everything I need from the five dimension analyses and the Clementine architecture brief. This is a synthesis task — no file reads required. Producing the gap analysis directly.

---

# OpenHarness vs Clementine — Gap Analysis

## 1. Verdict

OpenHarness is a strong, well-instrumented harness whose center of gravity is **multi-agent orchestration over a real codebase**: backend-agnostic executors (subprocess/in-process/tmux/iterm2), git-worktree isolation per worker, file-based mailboxes for async handoff, persistent teams, and an **Autopilot daemon** that ingests GitHub/chat tasks and runs an intake→execute→verify→repair→merge loop. That coordination layer plus its **per-turn auto-compaction** (microcompact-first) and **per-turn carryover metadata buckets** are where Clementine is genuinely behind. Everywhere else Clementine is **ahead or equal**: skills (Clementine has the auto-distiller + execution-verification gate OpenHarness entirely lacks), memory (semantic vector recall + always-on brain vs OpenHarness's token-overlap heuristic + episodic auto-dream), send safety (Clementine's destination/grounding/confirm-first gates have no OpenHarness equivalent), and autonomy-as-product (Clementine's Goal Contract is more than OpenHarness's repo-only Autopilot for non-coding tasks). The honest read: **OpenHarness's coordinator/worktree/continuation model is the one area worth seriously mining; its memory and skills systems are weaker than what you already ship.** Do not chase its compaction or permission-mode design as wholesale ports — selectively steal two or three mechanisms.

## 2. Top Gaps (ranked, deduped)

**1. Persistent worker continuation (continue vs. spawn)** — *severity: high*
OpenHarness coordinators can `send_message` to an existing worker to reuse its full context (explored files, tool history) instead of always spawning fresh, with explicit continue-vs-spawn rules (`coordinator_mode.py:403-445`). Clementine's `run_worker` is stateless fan-out only — every worker re-explores the codebase from zero. For research→implement→verify chains this is real token and latency waste. **Lands in:** `OrchestratorDecision` (add optional `continue_agent_id`) + a worker-context cache keyed by `(agent_id, task_type)`. **Effort: medium.** This is the single highest-value steal — it doesn't require abandoning the stateless model, just adding a reuse path.

**2. Git-worktree isolation per worker** — *severity: high*
OpenHarness gives each writing agent an isolated git worktree (symlinked `node_modules`/`.venv`, slug-validated, `cleanup_stale()` on dead agents; `swarm/worktree.py`). Parallel writers don't collide; coordinator merges/rebases after. Clementine's fan-out workers have no write isolation — parallel writes to the same repo either serialize or conflict. **Lands in:** wrap `run_worker` write-permission spawn with a `WorktreeManager`; reconcile on completion. **Effort: high.** Only matters once you actually run parallel *writing* workers; if fan-out stays read/research-heavy, downgrade priority.

**3. Per-turn auto-compaction (microcompact-first)** — *severity: med*
OpenHarness checks token estimate before each API call and runs a cheap microcompact (strip old `ToolResultBlock` content) before falling back to full LLM summarization (`service/compact/__init__.py:41-50`, `query.py:712`). Clementine compacts **reactively only** on over-limit errors. Multi-hour sessions hit mid-turn failures + expensive recompaction that proactive trimming avoids. **Lands in:** `runTurn`, pre-model token estimate → microcompact phase. **Effort: medium.** The microcompact idea (drop tool-result bodies, keep the rest) is the cheap win here even if you skip the full proactive-summarize pipeline.

**4. Autopilot continuous work queue** — *severity: high (strategically), but partially covered*
OpenHarness's Autopilot daemon ingests tasks (GitHub issues/PRs, chat, manual ideas), source-scores priority (`_SOURCE_BASE_SCORES`: ohmo_request:100 … candidate:45), fingerprint-dedups, and runs execute→verify(multi-gate)→repair→merge with configurable policy (`autopilot/service.py`, `types.py`). **Honest caveat:** Clementine's Goal Contract (parked goals, daemon resume, anti-spin breaker, stages, external validation) already covers most of this for *general* tasks. The genuine gap is narrower: **repo-task-card intake from external sources + multi-gate verification policy (pytest/ruff/tsc) + auto-merge-on-green**. **Lands in:** a `RepoTaskCard`/`RepoRunResult` layer riding the existing Goal Contract daemon, not a new daemon. **Effort: medium** (because the daemon substrate exists). Don't double-build the autonomy loop.

**5. Per-turn carryover metadata buckets** — *severity: med (downgrade from "high")*
OpenHarness keeps bounded, deduped per-turn state — `task_focus_state` (goal, recent_goals, active_artifacts, verified_state, next_step), read-file/skill/async-agent/work-log buckets — updated via `_record_tool_carryover`, cap-and-rotate (`query.py:166-506`). This lets the model reason about focus without recomputing. **Honest caveat:** Clementine's memory primer + Active-Task pin + Goal Contract stages already deliver much of `task_focus_state`. The real delta is the **cheap in-turn work-log/active-artifacts buckets** that avoid vault FTS round-trips every turn. **Lands in:** a lightweight per-session carryover struct threaded into the memory primer. **Effort: medium.** Treat as an optimization, not a missing capability.

**6. File-based async worker mailbox** — *severity: med*
OpenHarness uses atomic file-per-message mailboxes (write `.tmp` → `os.rename`; `swarm/mailbox.py`) so leader writes-and-forgets, workers drain between turns, and state survives a leader crash. Clementine's `run_worker` blocks the harness loop until completion. This is the prerequisite for long-lived/pausable workers and out-of-order results. **Lands in:** make `run_worker` return a `task_id` immediately + background mailbox drain; orchestrator handles async arrivals. **Effort: medium.** Note: this couples with #1 — do them together or not at all.

**7. Completion-token-limit negotiation (turn-count-oblivious retry)** — *severity: med*
When a provider rejects `max_tokens`, OpenHarness parses the error for the supported limit, lowers it, and retries the **same turn without decrementing the counter** (`query.py:755-767`). Clementine's tool-level retry doesn't renegotiate `max_tokens` per provider, risking false max-turn exhaustion on OpenAI-compatible endpoints. **Lands in:** `runTurn` error path — regex-detect token-limit errors, clamp effective max_tokens, continue. **Effort: low.** Cheap robustness win, especially relevant with your model-tiering plan (MiniMax/DeepSeek under Codex).

**8. Sensitive-path hardcoding (defense-in-depth)** — *severity: med*
OpenHarness denies access to `~/.ssh`, `~/.aws`, `~/.kube`, `~/.gnupg`, credentials.json via non-overridable fnmatch patterns regardless of permission mode (`permissions/checker.py:14-37`) — protection against prompt-injected reads/writes. Clementine's gates are write/send-oriented; there's no equivalent unconditional read-block on credential paths. **Lands in:** a constant deny-list in `wrapToolForHarness` for file/bash tools, mode-independent. **Effort: low.** Small, high-leverage safety addition given Clementine has full CLI + computer-use reach.

## 3. Novel Ideas Worth Stealing

1. **Microcompact before full summarize** — strip old `ToolResultBlock` bodies as a cheap first pass; only escalate to LLM summarization if still over budget. Cuts redundant summarization API calls (`service/compact/__init__.py:41-50`).
2. **Continue-vs-spawn decision rules as explicit guidance** — high context overlap → continue; wrong-approach context → fresh worker; verifier always gets fresh eyes (`coordinator_mode.py:403-445`). Cheap prompt/heuristic even without full continuation infra.
3. **`disable_model_invocation` per-skill flag** — lets a skill be user-only (`/<name>`) but invisible to the model (deprecated/internal/test skills). ~80 LOC into skill-store metadata; closes a real gap in Clementine's skill control surface.
4. **Bounded entrypoint truncation** — MEMORY.md capped at 200 lines OR 25KB with explicit warning (`schema.py:137-169`). Clementine already trimmed MEMORY.md 68→23KB; a hard cap-with-warning prevents silent regrowth.
5. **Source-based task prioritization scoring** — fingerprint-dedup + source-weighted intake (`_SOURCE_BASE_SCORES`) is a clean pattern for the Goal Contract queue if you add external intake — prevents task thrashing without hand-tuned rules.

## 4. What Clementine Does Better (do NOT change)

1. **Skill distillation + execution-verification gate.** OpenHarness has *zero* auto-distillation (entirely manual authoring) and *no* completion check that a recommended skill actually executed. Clementine's distiller (novelty-gated: ≥5 calls, ≥2 tool families) + `skill-execution.ts` gate are a clear lead. Keep them.
2. **Send-safety gates.** Destination gate, grounding gate (verify payload vs session artifacts before irreversible send), and confirm-first batch review have **no OpenHarness equivalent** — its `SendMessage` has no recipient-level approval. This is a major safety lead for a multi-surface agent.
3. **Semantic vector memory + always-on brain.** OpenHarness uses brittle token-overlap heuristic recall and *episodic* auto-dream (fires on time/session gates → staleness windows). Clementine's embedded `consolidated_facts` + continuous primer-time reflection is materially better recall.
4. **Unified privacy-aware memory.** OpenHarness's personalization (regex env-fact extraction → separate `facts.json`) is decoupled from memory TTL/importance/usage, and it has **no recall-time privacy gate** — a private fact can leak into a shared channel. Clementine's unified fact store with scoping is ahead.
5. **One gated loop across all surfaces.** Clementine's CANON-ONE-LOOP convergence (Electron/web/Discord/mobile/CLI all on the same gated harness) avoids the fork OpenHarness implies between coordinator-mode, swarm backends, Autopilot, and ohmo. Don't re-fragment chasing OpenHarness's backend zoo.

## 5. Recommendation

**Worth a focused build — but only one cluster.** Steal the **coordinator continuation + file-mailbox + (optional) worktree isolation** trio (gaps #1, #6, #2) as a single multi-agent-efficiency epic, plus two low-effort safety/robustness one-offs (sensitive-path deny-list #8, token-limit renegotiation #7). Skip the memory, skills, and permission-mode redesigns — Clementine already leads there, and porting OpenHarness's versions would be a regression.