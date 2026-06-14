All facts confirmed against the codebase. Key corrections to the audit's framing: `clearAutonomyAgentCache` lives in **autonomy-v2.ts** (not v1), so the 9 console-routes cache call-sites block v2 deletion specifically; and v1 imports `AUTONOMY_V2_AGENTS` env to partition ownership, so v1 and v2 are coupled (deleting v2 while v1 reads the env is harmless, but deleting v1 requires the daemon caller and dashboard exports to move first). Here is the decision-ready plan.

---

# Phase-2 Legacy Deletion Plan — Clementine FORK-Collapse

## 1. HEADLINE
- **Total deletable: ~5,065 LOC across 5 ordered waves.** Wave 1 (~146 LOC) is adversary-confirmed dead and ships today; the remaining ~4,919 LOC is gated behind 4 migrations.
- **Risk posture:** Forward-only, suite-green per wave, every wave keeps a kill-switch or fallback until the wave after it proves green in production. Wave 1 is zero-risk; the FORK core (Waves 4-5) is the only place the 5 safety gates could be bypassed, and it stays as degraded-mode fallback until its last direct caller is migrated.

---

## 2. WAVES (ordered)

### WAVE 1 — Truly-dead residue (ship now, zero migration)
**Delete:**
- `assemblePromptContext()` — `src/memory/context.ts` (~20 LOC). Sync variant; only `assemblePromptContextAsync` is imported anywhere (confirmed: grep shows the sole non-async reference is its own definition).
- `cli/autonomy-run.ts` (full file, ~121 LOC) **+** its only consumer `runAgentCycleV2ForTest()` in `autonomy-v2.ts` (~5 LOC). Confirmed: the test wrapper is referenced *only* by this CLI file; not in `package.json`, `src/index.ts`, CI, or any `.test.ts`. Daemon uses `runAgentCycleV2` directly.

**Why safe now:** Adversary-confirmed zero live callers. No dynamic dispatch, no env trigger, no package entry.
**Verify after:** `tsc --noEmit` + full suite green. Grep `runAgentCycleV2ForTest` / `assemblePromptContext` returns zero hits.
**Rollback:** Pure git revert; nothing runtime-gated.

> Note: `notifyCodexAuthExpired` was proposed as delete-now but the adversary **downgraded** it correctly — it has 4 live call-sites (2 self, 2 in the live `auth-keepalive` tick every 5 min). It does NOT belong in Wave 1. It dies in Wave 4 with `CodexNativeRuntime`, after extraction.

---

### WAVE 2 — Autonomy v1 retirement (migration: agents → v2 / goals)
**Delete:**
- `processAgentAutonomy()` + `syncAutonomyInputs()` + 6 inbox-sync sub-fns + `readV2OwnedAgentSlugs()` — `src/agents/autonomy.ts` (~888 LOC, minus the two exports moved below).

**Migration required first (the blocker):**
1. Confirm **every** standing agent is in `AUTONOMY_V2_AGENTS` or converted to a self-driving goal. Today only `clementine` is in the env; any other `autonomyEnabled=true` agent silently falls to v1. **This must be audited live, not assumed.**
2. **Move, don't delete:** `listAgentStates()` + `listAgentInboxCounts()` (~30 LOC) are imported by `dashboard/state.ts:190-191`. Relocate them to a neutral module (e.g. `agent-state.ts`) or back them with v2/goal state *before* deleting the file. Deleting `autonomy.ts` outright breaks the dashboard StateSnapshot.
3. Remove the v1 call at `daemon/runner.ts:1230`.

**Why safe after migration:** v1's only live entry is the daemon tick; once no agent is v1-owned and the dashboard exports are relocated, it's dead.
**Verify after:** Daemon tick runs clean for ≥1 production cycle with all agents on v2/goals; dashboard agent cards still render; suite green.
**Rollback:** Re-add the `runner.ts:1230` call and the deleted file from git. Reversible until Wave 5 deletes the FORK core that v1 depended on (`assistant.respond`).

---

### WAVE 3 — Autonomy v2 retirement (migration: standing agents → goal contracts)
**Delete (only after goals fully own standing-agent cadence):**
- `processAgentAutonomyV2()` + v2 internals (`buildPolicyText`, `runAgentCycleV2`, guardrail wiring, etc.) — `src/agents/autonomy-v2.ts` (~858 LOC)
- `autonomy-guardrails.ts` (~130 LOC) — imported only by v2 (line 573).
- `run-tracking.ts` autonomy functions (~230 LOC) — live calls only inside v2's cycle.
- `agent-runs-tools.ts` (~82 LOC) — MCP visibility into autonomy runs, vestigial once no runs are recorded.

**Migration required first (the blocker — this is the hard one):**
1. **Clementine itself must move to a goal contract.** v2 agents *auto-wake on cadence*; goals require explicit pin/activation. This is a genuine execution-model change, not a flag flip — `goal-resume` must own Clementine's standing cadence with no behavioral regression.
2. **Relocate `clearAutonomyAgentCache()`** — it lives in **autonomy-v2.ts:451** and is called from **9 console-routes sites** (MCP/model/proactivity/budget mutations). These must become goal-cache-invalidation equivalents or no-ops *before* deleting v2.
3. Port observability: create `goal_runs_recent` / `goal_run_get` MCP tools before retiring `agent-runs-tools`, or accept losing autonomy-run visibility.
4. Remove the v2 call at `runner.ts:1235`; drop the `tickCount % 4` cadence gate on goals (`runner.ts:1242`) so goals fire on their own `nextResumeAt`.

**Why safe after migration:** v2's only entry is the daemon tick; guardrails/run-tracking/runs-tools are v2-private once it's gone.
**Verify after:** Clementine wakes and acts on cadence via goals for ≥1 production cycle; the 9 console mutation paths still invalidate correctly; suite green.
**Rollback:** `AUTONOMY_V2_AGENTS` env + re-added `runner.ts:1235` call restores v2 instantly — keep the env var live as the rollback lever until Wave 3 has soaked.

---

### WAVE 4 — Codex runtime deletion (migration: auth-mode → API_KEY)
**Delete:**
- `CodexNativeRuntime` (~1,746 LOC) — `src/runtime/codex-native-runtime.ts`
- `notifyCodexAuthExpired()` (~5 LOC) dies *with* the file — **but only after extraction** (see step 1).

**Migration required first:**
1. **Extract `notifyCodexAuthExpired` to `auth-store.ts`/`auth-utils.ts`** and repoint `auth-keepalive.ts:27` import. Confirmed live: keepalive tick calls it every 5 min. This is the first concrete step.
2. **Flip `factory.ts`** — `createRuntimeFromConfig()` returns `CodexNativeRuntime` only when `AUTH_MODE != 'api_key'` (line 16). Either default to `OpenAIRuntime` (validated live) or deprecate Codex-auth mode. The API_KEY path is already proven.
3. The runtime's only caller is `assistant.respond()` (the FORK core) — so this wave is tightly coupled to Wave 5 and may ship together with it.

**Why safe after migration:** Once auth is API_KEY-only and keepalive uses the extracted notifier, nothing instantiates or imports the Codex runtime except the FORK core (deleted in Wave 5).
**Verify after:** App runs on `OpenAIRuntime` only; auth-expiry notifications still fire; suite green.
**Rollback:** `AUTH_MODE` env flips back to Codex — **keep this env path until Wave 4 soaks.** This is the resilience lever; do not delete the env-mode branch in the same commit.

---

### WAVE 5 — FORK core deletion (migration: streaming-cli + discord)
**Delete:**
- `ClementineAssistant.respond()` (~334 LOC) — `src/assistant/core.ts`
- Collapse `respondPreferHarness()` to a thin harness-only wrapper (Phase 2.5).

**Migration required first (the 3 direct, non-bridge callers):**
1. **`console-routes.ts:6686` (streaming-cli SSE):** needs `onToolActivity` + `onReasoning` callbacks the bridge doesn't forward (confirmed at lines 6694/6701). Either add callback support to harness `RunConversationOptions`+loop, or migrate this endpoint to a direct gated-harness API. **This is the gating work for Wave 5.**
2. **`discord.ts:2347`:** guarded by `DISCORD_HARNESS_ENABLED`. Remove the legacy `else` branch once the kill-switch is deprecated. Low effort, low risk.
3. **`autonomy.ts:779`:** already removed in Wave 2.

**Why safe after migration:** With all direct callers on the gated harness and all bridge fallbacks no-op, the ungated path has no entry.
**Verify after:** Streaming-cli SSE still streams tool activity + reasoning; discord continue-button works on harness; **every surface confirmed on the harness loop with the 5 gates active**; suite green.
**Rollback:** This is the last off-ramp. Keep `respondPreferHarness` fallback + per-surface `CLEMMY_HARNESS_<SURFACE>=off` switches alive through Wave 5's soak; collapse the bridge to harness-only **only after** a full production cycle proves no fallback fired.

---

## 3. DO-NOT-DELETE (load-bearing, looks legacy but isn't)
- **`respondPreferHarness()` + bridge fallback** (`respond-bridge.ts`, ~266 LOC) — the reversibility substrate. `STAGING_SURFACES` is empty so everything defaults ON, but the per-surface kill-switches and auth/tool-exclude fallbacks are the only off-ramp. Collapsing it now locks in one-loop with no escape hatch. Survives until Wave 5 soaks, then thins to a wrapper.
- **`autonomy-action-tools.ts`** (~354 LOC) — misnamed. `notify_user`/`ask_user_question`/`surface_plan` etc. are used by orchestrator chat, goal-resume, and workflows — NOT autonomy-specific. Deleting breaks plan/check-in surfacing for all agents. Keep.
- **`processGoalResumptions`, `processExecutionController`, `processMonitors`, briefs, check-ins, memory-maintenance, reflection/hygiene ticks, the 5 independent setInterval handlers** — no scheduling duplication found; each owns a distinct concern. The only autonomy artifact here is the `tickCount % 4` gate on goals, which is removed *as part of* Wave 3, not as a deletion of its own.
- **`OpenAIRuntime`, `auth-keepalive` (post-extraction)** — the surviving runtime + live auth tick.

---

## 4. OPEN QUESTIONS for the owner
1. **Keep the legacy FORK as a permanent degraded-mode fallback, or go harness-only?** The 5 gates are *only* bypassed on the FORK path. Keeping it as resilience means accepting an ungated escape hatch forever; going harness-only means Wave 5 fully deletes it and the bridge becomes a thin wrapper. **Recommend harness-only after soak** — an ungated fallback that can silently skip the grounding/confirm/duplicate gates contradicts the "5 gates never bypassed" invariant.
2. **Clementine: v2-agent or goal contract?** Wave 3 hinges on this. Goals were validated live this session, but the auto-wake-vs-explicit-activation gap is real. Do you want Clementine's standing cadence to live as a pinned self-driving goal (and retire agent autonomy entirely), or keep v2 indefinitely and only delete v1?
3. **Deprecate Codex AUTH_MODE entirely?** Wave 4 flips `factory.ts` to OpenAIRuntime. Are you committed to API_KEY-only auth, or must the Codex-OAuth-subscription path survive (per the in-progress Claude OAuth brain work)? If Codex auth must stay, Wave 4 cannot proceed and the FORK core's runtime stays.
4. **Streaming-cli: add harness callback forwarding, or migrate the endpoint?** This is the single most concrete piece of net-new code in the whole plan. Worth confirming the owner wants callbacks in the harness loop (reusable) vs. a one-off gated API for this endpoint.

---

## 5. RECOMMENDED FIRST MOVE
Ship **Wave 1** today (`assemblePromptContext` + `cli/autonomy-run.ts` + `runAgentCycleV2ForTest`, ~146 LOC, adversary-confirmed dead, suite-green), then in the same PR or the next, **extract `notifyCodexAuthExpired` to `auth-store.ts`** — the cheapest, lowest-risk migration step that unblocks the entire Codex-runtime deletion path downstream.

Relevant files: `/Users/nathan.reynolds/clementine-next/src/memory/context.ts`, `/Users/nathan.reynolds/clementine-next/src/cli/autonomy-run.ts`, `/Users/nathan.reynolds/clementine-next/src/agents/autonomy-v2.ts` (line 856 `runAgentCycleV2ForTest`, line 451 `clearAutonomyAgentCache`), `/Users/nathan.reynolds/clementine-next/src/runtime/codex-native-runtime.ts` (line 178 `notifyCodexAuthExpired`), `/Users/nathan.reynolds/clementine-next/src/runtime/auth-keepalive.ts`, `/Users/nathan.reynolds/clementine-next/src/runtime/factory.ts`, `/Users/nathan.reynolds/clementine-next/src/agents/autonomy.ts` (lines 779, 861, 876), `/Users/nathan.reynolds/clementine-next/src/dashboard/state.ts` (lines 190-191), `/Users/nathan.reynolds/clementine-next/src/daemon/runner.ts` (lines 1230/1235/1242-1243), `/Users/nathan.reynolds/clementine-next/src/dashboard/console-routes.ts` (line 6686 streaming-cli), `/Users/nathan.reynolds/clementine-next/src/channels/discord.ts` (line 2347), `/Users/nathan.reynolds/clementine-next/src/runtime/harness/respond-bridge.ts`.