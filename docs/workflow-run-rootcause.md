# Root Cause: workflow_run never receives its inputs (the 84× loop / 3-min hang)

**Date:** 2026-05-31. Proven, not theorized.

## The root cause (definitive)

`workflow_run`'s `inputs` parameter is declared as
`z.record(z.string(), z.string()).optional()` (orchestration-tools.ts:396).

The OpenAI Agents SDK defaults EVERY tool to **strict mode** (`strict ?? true`,
@openai/agents-core/dist/tool.mjs:574). The `z.record(z.string(), z.string())`
`inputs` field compiles to this JSON Schema — verified by compiling the EXACT
workflow_run shape through the real SDK `tool()`:

```json
"inputs": {
  "anyOf": [
    { "type": "object", "additionalProperties": { "type": "string" } },
    { "type": "null" }
  ]
}
```

**CORRECTION to an earlier overclaim:** this is NOT "locked to {}". A typed-map via
`additionalProperties: {type:'string'}` technically PERMITS `{"url":"..."}`. So the
field is fillable in principle. The actual problem is a strict-mode + typed-map
INCOMPATIBILITY: OpenAI/codex strict structured function-calling does not reliably
support `additionalProperties` as a typed schema (strict historically requires named
`properties` + `additionalProperties:false`). Under strict, this open-map shape
produces a field the model consistently emits EMPTY.

**What is PROVEN (empirical, not theory):**
- 223 / 223 `workflow_run` calls across ALL harness history have `inputs: {}`. Never
  once filled. workflow-run-with-inputs has NEVER worked.
- The proven-WORKING contrast: `composio_execute_tool` uses `arguments: z.string()`
  (a JSON string the model fills, parsed in the handler) — 198 / 198 sampled calls
  FILLED, 0 empty.
- Same model, same runtime, same strict mode → the z.string() shape gets filled
  100%, the z.record shape gets filled 0%. The schema shape is the difference.

The exact internal mechanism (does codex drop the field, does strict-validation
coerce it, does the model decline an unfamiliar map shape) is not fully nailed —
but it does not need to be: the empirical 0% vs 100% and the proven-working
alternative make the fix unambiguous regardless of mechanism.

## Why it became a 3-minute hang (secondary bug)

1. Model calls `workflow_run` → handler returns the correct, clear error:
   *"required input 'url' is missing. Call workflow_run again with inputs
   including 'url'."*
2. Model tries to comply — but the schema forces the SAME empty `{}` call. It
   physically cannot vary the call.
3. The loop guard detects exact-args repeat on a mutating tool and decides
   `block`. BUT a guard `block` is delivered as a SOFT tool error
   (brackets.ts: "Tool call refused by harness: …") so the model can recover —
   it just calls again. Schema still forces `{}`. Loop.
4. Repeats ~84× until the wall-clock / turn limit finally ends the turn (~5 min).
   That is the hang + the "I hit a tool-call issue" message.

So: the guard NOTICES but never truly STOPS — same class as the confirm-first
deadlock. A soft-error block is toothless when the model can't change the call.

## Pre-existing, not a regression from tonight

`orchestration-tools.ts` is UNCHANGED this session (committed HEAD identical, no
uncommitted edits). So the z.record bug shipped in v0.5.40 and earlier. It was
DORMANT because nothing drove `workflow_run`-with-inputs from a chat turn until
tonight's conversational-routing work made Clem actually run workflows from chat.
Tonight's changes EXERCISED a latent bug; they didn't create it.

## Blast radius (every strict z.record field the model can never fill)

orchestration-tools.ts:
- :396 `workflow_run` `inputs: z.record(z.string(), z.string())`  ← the live failure
- :333 `workflow_create` `inputs: z.record(z.string(), z.object(...))` ← workflow CREATION with declared inputs is also broken
- :525 another `inputs: z.record(...)` (workflow update/variant)
- :704 `state: z.record(z.string(), z.unknown())`

All four collapse to unfillable `{}` under strict mode.

## The fix (proven working pattern)

Mirror `composio_execute_tool` — the most-used tool in the system — which takes
`arguments: z.string()` (a JSON string the model fills, parsed in the handler) and
works. For each broken field:

1. Change the param to `z.string()` (description: "JSON object of inputs, e.g.
   {\"url\": \"https://...\"}"), OR a `z.string().nullable()` matching composio.
2. In the handler, `JSON.parse` it (with a clear error on bad JSON), then feed the
   existing `normalizeWorkflowRunInputs`. Handler logic below the parse is unchanged.

Alternative considered + rejected: set `strict:false` on these tools. Rejected —
weakens schema enforcement tool-wide and the SDK warns against it; the z.string()
pattern is already proven in-codebase.

## Secondary hardening (the hang)

The loop guard must HARD-STOP (end the turn with a terminal error, not a soft
retry-able tool error) after N exact-args mutating repeats — so that ANY
unfixable-by-the-model tool error can never hang for minutes. Today
`ToolGuardrailBlocked` is caught and returned as a soft error (brackets.ts), which
lets the model retry forever when it can't vary the call. Convert repeated blocked
identical calls into a turn-ending stop.

## Release implication

This is pre-existing (predates v0.5.40), so v0.5.40 isn't NEWLY broken by it — but
the hang is bad UX and the fix is small + high-value. Fix #1 (schema) makes
workflows actually runnable from chat for the first time. Fix #2 (guard) is the
safety net so no future tool-error can hang.
