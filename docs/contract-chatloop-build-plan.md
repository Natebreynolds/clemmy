# Contract + Chat-Loop Build Plan (FINAL, decisions locked 2026-05-31)

Branch: feat/approval-parking-durability. Do NOT touch main / retag v0.5.40.
Source maps: workflow wf_808a5f72-17b. Research: docs/hermes-toolcall-research.md,
docs/workflow-run-rootcause.md. Decisions: [[feedback_no_rollout_flags]],
[[project_workflow_input_schema_decision]].

## Owner decisions (binding)
1. **Kill rollout flags.** No new behavior flags; collapse existing ones to the
   default path. Keep ONLY genuine user settings (autonomy scope, quiet hours, etc.).
   Safety = tests + commit discipline, NOT flags. Higher "tested-green-before-commit"
   bar accepted in exchange (no instant rollback).
2. **workflow inputs = JSON-string param** (z.string(), parsed in handler), mirroring
   composio `arguments` (198/198 fill). NOT z.record (0/223). NOT named props
   (impossible for a generic runner).
3. **Loop hard-stop at block-threshold (~6)** — escalate one repeat after the existing
   block threshold; conservative first ship.
4. **Hard-cut workflow_run inputs to JSON-string only** — no dual-path. Old saved run
   files still read fine via normalizeWorkflowRunInputs (handler-side Record).

## Flag collapse (part of this build, not optional)
- WORKFLOW_TYPED_CONTRACT → REMOVE gate. Runnability + token-binding validation always
  runs (every error = a workflow that would fail at runtime anyway). Collapse the two
  divergent readers (enforce.ts:21, runner.ts:1826) by DELETING the env read and making
  validation unconditional.
- CLEMMY_PLAN_CONTINUITY → REMOVE gate. Ask-then-resume is the only behavior. Delete the
  env read; keep the on-path.
- CLEMMY_CHAT_CONVERSE → REMOVE gate (the clarify-first / ambiguity behavior becomes
  default; shouldUsePlanFirst narrowing is unconditional anyway).
- NO new CLEMMY_GUARDRAIL_EXACT_ESCALATE flag — escalate is just the behavior.
- Update .env: remove CLEMMY_CHAT_CONVERSE / CLEMMY_PLAN_CONTINUITY lines (now no-ops).
- KEEP (genuine settings / out of scope): autoApproveScope, CLEMMY_CONFIRM_FIRST,
  CLEMMY_TOOL_GUARDRAIL mode, WORKFLOW_APPROVAL_PARKING, quiet hours, cadences.

## Build order — 4 commits, each tsc-clean + full-suite green before the next

### Commit A — fillable workflow inputs (fixes the revill failure)
1. orchestration-tools.ts (~after line 35): add pure helpers `parseWorkflowRunInputsJson(s)->Record<string,string>` and `parseWorkflowInputsSchemaJson(s)->Record<string,{type?,default?,description?}>`; empty->{}, JSON.parse, reject non-object/array with descriptive Error. Mirror parseArgumentsJson (composio-tools.ts:64-75). Unit tests.
2. orchestration-tools.ts:396 workflow_run `inputs: z.record(...)` → `z.string().optional().describe('JSON object of key:value, e.g. {"url":"https://..."}. Call workflow_get first for required input names.')`. Handler ~398-403: `const parsed = inputs ? parseWorkflowRunInputsJson(inputs) : {}; const normalized = normalizeWorkflowRunInputs(parsed);`. Leave missingWorkflowRunInputs check untouched.
3. orchestration-tools.ts:333 (create) + :525 (update) `inputs: z.record(...)` → `z.string().optional().describe(schema-map example)`; handlers parse via parseWorkflowInputsSchemaJson before assigning def.inputs (create ~:374, update ~:565). Verify workflow_get still renders inputs.

### Commit B — runnability contract (can't author an unrunnable workflow); flag removed
4. enforce.ts:20-22 + runner.ts:1825-1827: DELETE the WORKFLOW_TYPED_CONTRACT env gate; make typed-contract validation UNCONDITIONAL in both. Single behavior, no drift.
5. enforce.ts (~after checkSendGate :111): add `checkRunnabilityConstraints(def):string[]` — for each required input (collectRequiredWorkflowInputs: declared, no default) on a schedule-only trigger (no manual path) that is NOT a COMMON_WORKFLOW_INPUT_KEY and has no default → error 'required input X has no supply path for scheduled trigger'. Wire into checkWorkflowForWrite (~:118-123). Unit tests (5 cases).

### Commit C — loop hard-stop (kills the 84× hang); no new flag
6. tool-guardrail.ts: add 'escalate' to GuardrailAction (~:172); add exactArgsEscalateAt threshold (= exactArgsBlockAt, ~6) + per-(tool,signature) consecutive count in SessionTrackerState; in evaluateToolCall exact_args_repeat branch (~:316-330), MUTATING only, when consecutive >= escalateAt return action='escalate'; idempotent tools never escalate; signature switch resets counter. Unit tests.
7. brackets.ts: add+export `ToolGuardrailEscalated extends Error` next to ToolGuardrailBlocked (~:855); runBrackets decision check (~:603) include 'escalate' → throw ToolGuardrailEscalated; wrappedInvoke catch (~:786) `if (err instanceof ToolGuardrailEscalated) throw err;` BEFORE soft-error conversion. ToolGuardrailBlocked stays soft. Unit tests.
8. loop.ts handleRunError (~:2855, after ToolCallsLimitExceeded ~:2883): catch ToolGuardrailEscalated → emit guardrail_tripped {action:'escalate',toolName,signature,count}, mark failed, bumpTurnNumber, return status='limit_exceeded' msg 'agent stuck in unrecoverable loop'. Integration test: 6th identical mutating call ends turn, no hang.

### Commit D — ask-then-resume + chat-loop; flags removed
9. plan-proposals.ts: extend PlanProposal (~:44) with `kind?:'plan'|'workflow_pending_inputs'`, `workflowName?`, `requiredInputs?`, `pendingInputValues?`. Add `surfaceWorkflowPendingInputs(...)` after surfaceAskingPlan (~:253), reusing persistence; chat-only. Unit tests.
10. orchestration-tools.ts workflow_run missing-input branch (~:403-412): UNCONDITIONALLY (flag removed) call surfaceWorkflowPendingInputs + return SHORT ask ('I need <inputs> to run <workflow>. Reply with the values and I'll run it.') instead of model-directed retry.
11. plan-continuity.ts: REMOVE planContinuityEnabled gate (always on). findOpenQuestionPlan (~:37) also returns workflow_pending_inputs records; buildClassifierPrompt (~:71) workflow-inputs variant extracts values per field; routeOpenQuestionPlan (~:170) branch on kind → for workflow_pending_inputs+answers, accumulate + `resumeWorkflowRun(name,inputs,channel,sessionId)` re-invoking workflow_run with STRUCTURED inputs; supersede on success; re-ask once on partial (NO loop); supersede on abandon/new_topic. Integration test (revill flow).
12. plan-first.ts shouldUsePlanFirst (~:145-185): keep ONLY (a) EXPLICIT_PLAN_FIRST_RE; (b) hasExternalMutation && domains>=3 && (hasBatch||hasSequence); (c) hasExternalMutation && len>=550 && (hasBatch||hasSequence). REMOVE domains>=2 / len>=450 branches. Remove CLEMMY_CHAT_CONVERSE gate on the ambiguity path (now default). Default false. Update tests.
13. Verify (no structural change): instructions.ts:256 planner directive always injected; discord-harness IIFE order planContinuity→planFirst→orchestrator (~:1869); console-routes desktop path (~:5572). Confirm ordinary asks reach orchestrator on both surfaces.

## Test plan
Full `npm test` after EVERY step. Characterization FIRST where behavior flips
(workflow_run {} fill; 'make an SEO brief for <url>' currently plan-first). Live
smoke (hot-patch local app): (1) "run the SEO brief workflow" w/o url → short ask →
"https://revill.co.uk" → resumes, queues ONCE, no loop; (2) "make an SEO brief for
https://revill.co.uk" fresh → orchestrator asks ONE clarifying question, no plan card;
(3) confirm no "Tool call refused by harness" spam, one approval per task.

## Release note
Pre-existing bugs (unfillable inputs, 84× hang) — NOT new v0.5.40 regressions. Ships
NEXT client release after v0.5.40. Changelog must call out: chat narrowing (ambiguous
asks now conversational), loop hard-stop (stuck mutating loop → limit_exceeded), and
that workflow inputs now actually work. Monitor guardrail_tripped escalate telemetry
post-release. ASK owner before any release tag (CI trigger).

## Two deferred open questions (don't block the build; pick sane default + note)
- checkRunnabilityConstraints scheduled-trigger conservativeness: allow COMMON keys
  (url/domain/...) as injectable. (Default: allow common keys; only error on
  non-common required-no-default on schedule-only.)
- Escalate threshold = block threshold (~6). Locked.
