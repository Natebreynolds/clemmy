# Conversational Autonomy Build Spec

**Status:** spec — not yet built. Written 2026-05-30 after a read-only guard-surface
audit + verifying every claim against the live code.

**Goal (owner's words):** "I can throw anything at Clem and not have to babysit."
A vague request should make Clem *converse* first (clarify what memory can't fill),
then show a short plan, take **one** approval, then execute autonomously — coming
back only for genuinely irreversible steps. How chatty vs. autonomous she is must be
a **user-controlled dial**, including a "turn approvals off / YOLO" mode.

---

## What already exists (verified — do NOT rebuild)

1. **Execution-side autonomy dial is LIVE.** `autoApproveScope: 'strict' | 'workspace'
   | 'yolo'` (`proactivity-policy.ts:23`) is consumed on the real per-tool approval
   path via `evaluateAutoApprove({ scope })` (`tool-taxonomy.ts:492`,
   `plan-scope.ts:233`). Settings UI dropdown already exists (`console.ts:1470`).
2. **Catastrophic floor is absolute, even in YOLO.** `assertCommandAllowed`
   (`computer-tools.ts`) hard-blocks `rm -rf /`, `sudo`, `mkfs`, fork bombs regardless
   of scope. Taxonomy `'admin'` kind "always asks, even in YOLO" (`tool-taxonomy.ts:42`).
   → owner's "catastrophic always confirms" requirement = already satisfied.
3. **Severity gate (today's fix).** confirm-first only gates IRREVERSIBLE batch writes
   (`brackets.ts:696`, `shape.irreversible`). Reversible writes run free.
4. **plan-first machinery.** `shouldUsePlanFirst` + `runPlanFirstPreflight`
   (`plan-first.ts`) — clarify (`plan.needsUserInput`) → plan → surface for one
   approval. The planner already does adaptive memory-aware clarify via
   `PlanSchema.appliedInstructions` (mandatory memory recall) + `needsUserInput`.
5. **Live Discord routes through the harness** (`DISCORD_HARNESS_ENABLED`), and
   `runDiscordHarnessConversation` (`discord-harness.ts:1587`) ALREADY calls
   `shouldUsePlanFirst`. So plan-first is in the path — it just returns false too often.

## The actual gaps (what to build)

**Gap A — `shouldUsePlanFirst` fires on SIZE, not AMBIGUITY** (`plan-first.ts:52`).
Fresh-session needs `domains >= 2` or long batch+sequence. The vague test message
"can you get me a list of the deals we closed recently and put it somewhere i can
look at it" scores ~1 domain + short → false → straight to execution, no clarify.
The MOST ambiguous asks (deliverable named, but missing source/scope/destination)
score LOWEST. Note the existing test plan-first.test.ts:63 asserts vague→false with
intent "let chat clarify" — but chat does NOT clarify, so that promise is empty.

**Gap B — the autonomy dial doesn't drive the CONVERSATION front-end.** Clarify
behavior is fixed regardless of strict/yolo. The dial governs execution approvals
only.

## Build (all behind flag `CLEMMY_CHAT_CONVERSE`, default off until live-verified)

### 1. Add `balanced` to the autonomy levels
- `proactivity-policy.ts`: extend `AutoApproveScope` → `'strict' | 'balanced' |
  'workspace' | 'yolo'`. Default `DEFAULT_PROACTIVITY_POLICY.autoApproveScope` →
  `'balanced'` (owner pick). `normalizeAutoApproveScope` accepts it.
- Semantics map: **Careful=strict**, **Balanced=balanced (default)**, **YOLO=yolo**.
  (`workspace` stays as an existing power-user option.)
- `evaluateAutoApprove` (`plan-scope.ts:233`): `balanced` behaves like `strict` for
  the EXECUTION gate (plan-scope still required for run_shell/write_file) — balanced's
  difference is on the CONVERSATION side, not extra execution auto-approval. Keep
  execution conservative; the looseness is "ask less up front," not "write without a plan."
- Update settings UI dropdown (`console.ts:1470`) to list all four with one-line help.

### 2. Ambiguity trigger (Gap A) — `plan-first.ts`
- New exported pure fn `detectAmbiguousAction(input): { ambiguous: boolean; missing:
  ('source'|'scope'|'destination')[] }`. Heuristic: message is action-y (WRITE_RE or
  "get/pull/list … " + a deliverable noun) AND missing ≥1 slot:
  - **source**: no system named (no DOMAIN_PATTERNS hit) yet asks for data ("deals",
    "accounts", "emails", "leads").
  - **scope**: no range/filter ("recent", "lately", "some" present but no concrete
    window/owner).
  - **destination**: deliverable implied ("somewhere I can look", "put it") but no
    concrete target ("sheet", "doc", "email to X").
- `shouldUsePlanFirst`: add a branch — if `detectAmbiguousAction().ambiguous` AND
  level is Careful or Balanced → return true (engage clarify) EVEN when short/single-
  domain. YOLO → never engage on ambiguity (just execute). Keep all existing size
  branches unchanged so big jobs still plan.
- Reconcile plan-first.test.ts:63: under the new flag, vague action DOES engage (so the
  clarify actually happens). Update that test's intent comment + assertion to reflect
  "vague action → clarify via plan-first" rather than "→ stays in thin chat."

### 3. Dial drives clarify depth (Gap B) — `plan-first.ts` / caller
- Thread the level into `shouldUsePlanFirst` + `runPlanFirstPreflight` (already has
  `freshSession`; add `autonomy: AutoApproveScope`).
  - **Careful**: engage plan-first on any ambiguous OR mutating/multi-step action.
  - **Balanced (default)**: engage on ambiguity (clarify-light) + genuinely multi-step;
    let simple clear reversible asks ("what's on my calendar") execute directly.
  - **YOLO**: never engage plan-first from the conversation side; just execute (severity
    gate + catastrophic floor still hold downstream).

### 4. Adaptive (memory fills slots so she asks less over time)
- Already inherent: the planner's `appliedInstructions` recalls memory scoped to the
  objective before drafting, so a known preference ("deals = Salesforce Closed Won")
  fills the slot and drops out of `needsUserInput`. NO new slot-filler needed —
  verify it works end-to-end in the live test instead.
- Capture answers: when the user answers a clarify question, the existing
  `captureInteractionSignals` (already called in `runPlanFirstPreflight`, plan-first.ts:187)
  should persist the answer. Verify it captures source/scope/destination preferences;
  if not, add a targeted capture.

## Verification (non-negotiable)

- **Characterize:** `detectAmbiguousAction` unit tests (the exact test message →
  ambiguous, missing all three; "what's my calendar today" → not ambiguous; "send these
  40 emails" → action but not ambiguous, multi-step). `shouldUsePlanFirst` with the new
  branch under each autonomy level. Flag-off byte-identical to today.
- **Live test on the EXACT prompt**, flag on, hot-patched daemon:
  - **First time (Balanced):** "get me the deals we closed, somewhere I can look" →
    Clem asks "Pull from Salesforce? How far back? New sheet?" (clarify-light), then
    after answers shows a short plan + one approve, then executes + returns link.
  - **After teaching once:** same prompt → "Closed Won last 2 weeks → new Sheet, like
    usual — approve?" (memory filled source+destination; asks only what's unknown).
  - **YOLO:** same prompt → just executes, no questions, returns link.
  - **Catastrophic floor holds in YOLO:** an `rm -rf`-shaped op still blocks.
- Full suite green. Owner blesses live behavior BEFORE flag-on default.

## Rollback
- Flag `CLEMMY_CHAT_CONVERSE=off` → no conversation-side change; `shouldUsePlanFirst`
  ignores the ambiguity branch; autonomy dial governs execution only (today's behavior).
- `balanced` default is additive; existing strict/workspace/yolo users unaffected.

## Risk watch
- **Don't make her choke:** simple clear reversible asks MUST execute directly in
  Balanced — the ambiguity detector must be conservative (only fire when a real slot is
  missing). Build + test the "just do it" fast-path first; prove it can't regress.
- **Don't double-ask:** if the planner's memory recall already filled a slot, the
  clarify question for that slot must be suppressed (that's the adaptive promise).
