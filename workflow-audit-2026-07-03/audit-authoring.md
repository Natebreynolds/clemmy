# Clementine Workflow Authoring/Creation Subsystem — Audit

## Executive summary

Workflows are stored as **linear DAGs of typed steps** (a `WorkflowDefinition` serialized to `<name>/SKILL.md`). The contract is rich on *per-step data/verification/side-effect/retry semantics* but structurally it is a **dependency DAG only** — no control-flow substrate (no conditional branch, no while/until, no join/merge in the executed model). Iteration exists in three narrow, bounded forms: `forEach` fan-out over a materialized array, step-level `loopUntil` (retry-until-contract-passes), and run-level goal re-pursuit. A richer graph model with `condition`/`fanout`/`join`/`branch` nodes exists (`workflow-graph.ts`) but is **compiled-from and unused by** the authoring and execution paths — it's a visualization snapshot.

Authoring is a **hybrid**: an LLM authors by calling `workflow_create` with step prompts/tools (advanced mode) or a deterministic keyword heuristic drafts steps (simple mode); then a large deterministic pipeline (bind → auto-repair → validate → gap-test → real read-only smoke test) hardens and gates the write.

---

## 1. The workflow contract shape

Core type, `src/memory/workflow-store.ts:263`:

```typescript
export interface WorkflowDefinition {
  name: string;                        // kebab-case; must match dir name
  description: string;                 // one-line, used for tool-discovery
  enabled: boolean;
  whenToUse?: string;
  trigger: WorkflowTrigger;            // { schedule?: cron, manual?, timezone? }
  allowedTools?: WorkflowAllowedTool[];// tool surface, filtered per step
  steps: WorkflowStepInput[];
  inputs?: Record<string, WorkflowInputDef>;
  synthesis?: WorkflowSynthesis;       // optional final rollup prompt
  description_body?: string;
  allowSends?: boolean;                // default true = autonomous sends
  goal?: WorkflowGoal;                 // run-level pinned goal + re-pursuit
}
```

The step, `workflow-store.ts:35` (abridged — this is where all the power lives):

```typescript
export interface WorkflowStepInput {
  id: string;
  prompt: string;
  dependsOn?: string[];               // the ONLY structural edge — a DAG dep
  model?: string; intent?: string; tier?: number; maxTurns?: number;
  useHarness?: boolean;
  forEach?: string;                   // fan-out over an upstream output array
  deterministic?: { runner: string }; // skip LLM, run a scripts/ helper
  allowedTools?: string[];
  sideEffect?: 'read' | 'write' | 'send';
  usesSkill?: string;
  requiresApproval?: boolean; approvalPreview?: string;
  inputs?: Record<string, WorkflowStepInputBinding>;  // typed input contract
  output?: WorkflowStepOutputContract;                // typed output contract
  retryBudget?: number;               // transient-failure retries (0..10)
  loopUntil?: { maxAttempts?: number };  // retry-until-contract-passes (1..5)
  loopSafe?: boolean;                 // author asserts write idempotency
}
```

Output contract, `workflow-store.ts:177`:

```typescript
export interface WorkflowStepOutputContract {
  type?: 'string'|'number'|'boolean'|'object'|'array';
  required_keys?: string[];
  non_empty?: string[];               // dot-paths that must be non-empty
  min_items?: Record<string, number>; // dot-path → min array length
  verify?: { path_exists?: string[]; url_present?: string[] }; // real artifact check
  description?: string;
}
```

Run-level goal, `workflow-store.ts:242`:

```typescript
export interface WorkflowGoal {
  objective: string;                  // judged EXTERNALLY at run completion
  successCriteria?: string[];
  maxAttempts?: number;               // total run attempts, clamped 1..3, default 2
}
```

Triggers/inputs/bindings: `WorkflowTrigger` (`:213`, cron + IANA timezone + manual), `WorkflowInputDef` (`:222`), `WorkflowStepInputBinding` (`:165`, `from: input.<k> | steps.<id>.output[.path] | item[.path]`).

**Persistence:** frontmatter (typed config) + markdown body (`## step: <id>` anchors hold prompts as editable prose). Read/write single-sourced in `workflow-store.ts` (`readWorkflowDefinitionFile:399`, `writeWorkflowToDir:569`). Directory layout with optional `scripts/` and `references/`.

---

## 2. LOOPING — what the contract can and cannot express

**It is a linear/DAG step list.** The only structural relation between steps is `dependsOn` (`workflow-store.ts:38`); cycles are a hard validation error (`workflow-validator.ts:434` `detectCycles`, `:644`). Iteration is expressible only in these bounded forms:

| Loop form | Where | Bound | Evidence |
|---|---|---|---|
| **For-each over a list** | `step.forEach` names an upstream output; runner fans out with bounded concurrency, one call per item, `{{item}}` injected | Windowed at **200 items/run** by default | field `workflow-store.ts:60-67`; `forEachMaxItems()` default 200 `workflow-runner.ts:161`; `runWithConcurrency` `:901` |
| **Retry-until-contract-passes** | `step.loopUntil.maxAttempts`; re-runs a step until its `output` contract passes, folding failure evidence into the next prompt | **1..5 attempts**; read-only (write needs `loopSafe`, send never loops) | `workflow-store.ts:141-160`; `stepLoopUntilEnabled` `workflow-runner.ts:1991`; `loopUntilMaxAttempts` `:2001` |
| **Transient-failure retry** | `step.retryBudget`, exponential backoff, transient errors only | **0..10** | `workflow-store.ts:132-140` |
| **Whole-run re-pursuit** | `goal.maxAttempts` — an unmet pinned goal re-runs the entire workflow with validation feedback | **1..3**, never past an executed irreversible step | `workflow-store.ts:242-249`; runner `~:4201`, `:4236` |

**What it CANNOT express:**
- **No `while`/`until` over an external/dynamic condition** — the only "until" is `loopUntil`, whose exit condition is *this step's own output contract*, not a queried state ("until inbox empty", "until API returns done"). Evidence: `stepLoopUntilEnabled` requires `step.output` as the sole exit, `workflow-runner.ts:1992`.
- **No conditional branching in the executed model.** There is no if/else edge; every declared `dependsOn` edge always fires. A `condition`/`branch` node type and `condition`/`failure`/`always` edge types are *defined* in `workflow-graph.ts:7-21`, with branch-decision/graph-patch executors (`applyWorkflowGraphBranchDecision:281`, `applyWorkflowGraphPatch:238`), **but the compiler never emits them**: `compileWorkflowStepsToGraph` produces only `type:'dependency'` edges (`workflow-graph.ts:119`) and `stepToGraphNode` hard-codes `type:'step'` for every node (`workflow-graph.ts:295-298`). The runner uses the graph purely as a persisted snapshot for visualization (`persistWorkflowGraphSnapshot`, `workflow-runner.ts:4712-4721`), not as the execution substrate — execution walks the linear `WorkflowDefinition.steps`.
- **No dynamic fan-out re-materialization** — `forEach` iterates a snapshot of the upstream array; items can't spawn new items (no recursive/worklist expansion).
- **No `run_worker` inside a step** — the validator explicitly tells authors forEach is the *only* fan-out primitive available in a step (`workflow-validator.ts:509`).

---

## 3. Authoring end-to-end

Two entry modes into `workflow_create` (`orchestration-tools.ts:762`):

**Simple mode (no steps given)** — *deterministic, no LLM*: `analyzeWorkflowIntent` (`workflow-builder-analysis.ts:276`) keyword-matches the description against hardcoded pattern tables (`INTENT_TO_TOOLS:45`, `WORKFLOW_PATTERNS:74`, `identifyPattern:122`) → `synthesizeWorkflowDefinition` (`workflow-builder-synthesis.ts:73`) emits generic step prompts from templates (`generateStepPrompt:12`). Produces skeletal, low-fidelity workflows.

**Advanced mode (steps given)** — *the LLM is the author*: the model writes each step's `prompt`, `allowedTools`, `dependsOn`, `output`, `sideEffect`, `forEach`, `goal` directly as tool arguments. The tool description at `:762-771` is the authoring spec the model follows.

Both modes converge on the **canonical deterministic pipeline**, `commitAuthoredWorkflow` (`orchestration-tools.ts:103`):
1. `autoTagStepsWithModelRoleIntents` — role→model routing (`:183`)
2. `bindStepsToToolChoices` — bake proven CLI/MCP commands into prompts, lock tool surface off the composio drift gateway (`:242`); plus `bindChatDiscussedToolkits` (`:370`) commits a toolkit the user named in-chat.
3. `prepareWorkflowForWrite` (`workflow-enforce.ts:591`) = **auto-repair** (`autoRepairWorkflowDefinition:403`: wire missing deps, declare referenced inputs, derive `sideEffect`, add/harden output contracts, pin a goal) **then validate** (`checkWorkflowForWrite:556`).
4. `writeWorkflow` — persist only if valid (`workflow-store.ts:710`).
5. `analyzeWorkflowGaps` — clarifying questions (`workflow-gap-test.ts:88`).
6. Back in the handler: if the workflow has a testable read-only step, it saves **DISABLED** and queues a **real creation-time smoke test** against live tools; auto-enables on a clean pass (`orchestration-tools.ts:892-935`, `workflowNeedsCreationTest` `workflow-enforce.ts:153`).

**LLM vs deterministic split:** the LLM authors *intent* (prompts, tool choices, contracts) in advanced mode; *everything else is deterministic* — analysis heuristics, binding, repair, validation, gap questions, smoke test. Note the two builder modules (`workflow-builder-analysis/synthesis.ts`) are **pure keyword heuristics with zero LLM calls** despite the "intelligent" naming.

---

## 4. Ad-hoc run → workflow promotion (`workflow_from_session`)

`trace-to-workflow.ts` is a **thin reader over the harness event log**. `readSessionTrace` (`:285`) pulls `tool_called` events; `traceToWorkflowDraft` (`:209`) reconstructs steps: coalesces consecutive same-slug composio calls into one step, locks each step's `allowedTools` to the exact tool used (the determinism lever), chains steps linearly, and converts a preceding `request_approval` into a declarative `requiresApproval` gate. Then `draftToDefinition` (`orchestration-tools.ts:124`) → the same `commitAuthoredWorkflow` pipeline, saved DISABLED. Handler at `orchestration-tools.ts:947`.

**Fidelity lost (all surfaced honestly in `draft.notes`, `trace-to-workflow.ts:245-266`):**
- **No parameterization** — observed values (URLs, names) are baked into prompts; user must hand-replace with `{{input.X}}` (`:250`).
- **No data-flow wiring** — steps chain in run *order*, not by real output→input dependency; `{{steps.<id>.output}}` references must be added by hand (`:251`). `getToolOutput` is imported but explicitly unused (`:320-322`, "v1 keeps the linear chain").
- **forEach is lost** — a tool that ran N times becomes one step with a *prose hint* to "refine into a forEach" (`:156-158`), not an actual `forEach`.
- **Prompts are auto-generated skeletons** from arg-key summaries, not real task descriptions (`buildStep:149`).
- **Secrets risk** — shell commands captured verbatim into prompts (`:263`).
- Approval as the *last* call is dropped (nothing to gate) with a note (`:258`).

---

## 5. What makes a workflow "valid" — and what slips through

`validateWorkflowDefinition` (`workflow-validator.ts:609`) — **errors block save, warnings advise**. Errors: missing name/steps/ids, empty prompts, duplicate ids, unknown `dependsOn`, dependency **cycles**, invalid cron/timezone, malformed template tokens (`{{url}}` vs `{{input.url}}`), `{{input.X}}` with no declared input, `{{steps.X.output}}` where X isn't a transitive dependency, **hand-off language** ("a future turn will handle this" — the class that stranded 9 drafted emails, `:109-144`), approval incoherence, and a **forEach source that isn't an upstream dependency** (`:718-736`, would silently iterate nothing). Plus `workflow-enforce.ts` gates: `checkSendGate`, `checkLoopUntilAuthoring` (`:248`), `checkGoalAuthoring` (`:292`).

**Bad authoring that slips through (warnings only, or not modeled at all):**
1. **A task needing a loop authored as one serial step.** `checkParallelismHint` (`workflow-validator.ts:503`) detects "for each of the 25 accounts…" without `forEach` but emits a **warning**, not an error (`:793`). The workflow saves and runs serially in one context — routinely covering only the first few items and dropping the rest.
2. **A "while/until external condition" task** has no representation, so it's authored as a single step that "does it all" in one pass — silently un-modeled.
3. **Simple-mode output is structurally weak** — generic template steps with `required_keys: ['status','data']` (`workflow-builder-synthesis.ts:56`) that pass validation but don't reflect the real task.
4. **Deliverable step with no output contract** → warning only (`checkOutputContractHint:538`); the run can report "done" with nothing verifiable.
5. **Empty-list-feeds-downstream** (the SF→Airtable `{prospects: []}` class) → a *gap question* (`workflow-gap-test.ts:161`), not enforced, unless the author adds `non_empty`/`min_items`.
6. **Prompt/`sideEffect` mismatch** (a send prompt declared `read`) → warning (`checkSideEffectCoherence:244`), weakening crash-resume safety.

Auto-repair mitigates several by *adding* contracts/deps/goals mechanically (`workflow-enforce.ts:403`), but it can't invent a loop the author didn't express.

---

## 6. Strengths and the top 5 gaps for robust looping workflows

**Strengths.** Rich per-step *data* contract with real artifact verification (`verify.path_exists`/`url_present`, `workflow-store.ts:204`). Genuine safety algebra tying `sideEffect` to retry/resume/loop eligibility (`workflow-enforce.ts:248`, `workflow-runner.ts:1991`). Author-time **auto-repair** turns would-be refusals into runnable saves in one shot (`:403`). A **real read-only smoke test at creation** catches doomed workflows before they're enabled (`orchestration-tools.ts:892`). Promotion and create share **one canonical write path** so they can't drift (`commitAuthoredWorkflow:103`). Validation encodes hard-won production failures as concrete checks (hand-off language, forEach-not-a-dependency).

**Top 5 concrete gaps for robust *looping* workflows:**

1. **No conditional/branch control flow in the authored model.** The `condition`/`branch`/`join` node and edge types are fully defined and even have branch-decision + graph-patch executors, but `compileWorkflowStepsToGraph` only ever emits `type:'step'` nodes and `type:'dependency'` edges — the capability is stranded. *Evidence:* `workflow-graph.ts:7-21` (types), `:281` `applyWorkflowGraphBranchDecision`, vs `:119` and `:295-298` (compiler emits step+dependency only); execution ignores the graph (`workflow-runner.ts:4712`).

2. **No while/until over external state.** `loopUntil`'s exit condition is the step's own output contract, not a queried condition, so "poll until the job finishes" / "keep paging until no cursor" cannot be authored. *Evidence:* `stepLoopUntilEnabled` requires `step.output` as the sole exit (`workflow-runner.ts:1992`); contract def `workflow-store.ts:141-154`.

3. **forEach is a fixed 200-item snapshot with no dynamic expansion.** Large lists are silently windowed and there is no worklist/recursive fan-out (an item can't enqueue more items). *Evidence:* `forEachMaxItems()` default 200 (`workflow-runner.ts:161`); iterates a materialized upstream array only (`coerceIterable` `~:835`, `forEachSourceStepId` `:862`).

4. **Multi-item work without `forEach` is a warning, not an error — the single most common looping-authoring defect ships.** A step that says "for each of the 25 firms, scrape and draft" saves and runs serially. *Evidence:* `checkParallelismHint` returns a warning (`workflow-validator.ts:503`), routed to `warnings` at `:792-793`; contrast the hard errors at `:756`/`:777`.

5. **Promotion drops all iteration fidelity.** A tool that ran N times in the ad-hoc session becomes one step with a prose hint, never an actual `forEach`; and no output→input data flow is inferred (`getToolOutput` deliberately unused). A promoted "loop" is authored as a single non-looping step. *Evidence:* `trace-to-workflow.ts:156-158` (repeat→prose hint), `:250-251` + `:320-322` (data flow / parameterization deferred to the human).

---

**Files read:** `src/memory/workflow-store.ts`, `src/execution/{workflow-builder-analysis,workflow-builder-synthesis,workflow-validator,workflow-enforce,workflow-gap-test,workflow-inputs,workflow-contract-proposals,trace-to-workflow,workflow-graph}.ts`, `src/execution/workflow-runner.ts` (loop/forEach/graph regions), `src/tools/orchestration-tools.ts` (authoring handlers). The richer-but-unused control-flow model lives in `workflow-graph.ts`/`workflow-graph-store.ts`; the executed model is the linear `WorkflowDefinition` DAG.
