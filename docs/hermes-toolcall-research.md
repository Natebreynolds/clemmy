# How Hermes (and the broader agent field) handle tool inputs + the missing-input/retry problem

Research 2026-05-31, from primary sources. The question this answers: *what stops
an agent from creating/calling a tool (or workflow) it can never execute, and how is
the missing-input → infinite-retry failure avoided?*

## 1. Hermes tool-input SCHEMA format (NousResearch/Hermes-Function-Calling)

Hermes uses **JSON Schema with NAMED properties + a `required` array** — never a
free-form map. Exact format from the repo:

```json
{"type":"function","function":{
  "name":"get_stock_fundamentals",
  "description":"...",
  "parameters":{"type":"object",
    "properties":{"symbol":{"type":"string"}},
    "required":["symbol"]}}}
```

The model emits the call as a JSON object inside `<tool_call>` tags:
```
<tool_call>{"name":"get_stock_fundamentals","arguments":{"symbol":"TSLA"}}</tool_call>
```

**Key contrast to Clementine's bug:** Hermes' input schema is ALWAYS named
`properties` with `required`. It does NOT use an open `additionalProperties` map for
the arguments a model must fill. Named properties are exactly what strict
function-calling needs — and exactly what `workflow_run`'s `z.record` lacks. The
model fills `{"symbol":"TSLA"}` reliably because `symbol` is a named, required
property it can see. (This is the root-cause confirmation for our workflow_run bug:
the working pattern names the keys.)

## 2. The "Hermes pattern" — JSON emission + boundary validation (synilogictech)

Three layers, in order:
1. **Schema definition**: "tools described in plain English + a JSON Schema for each."
2. **Argument generation**: model emits `{"tool":"<name>","args":{...}}`.
3. **Boundary validation BEFORE execution**: "validates every parsed call against
   JSON Schema before execution… the difference between an agent that works in tests
   and one that survives production."

Recovery is BOUNDED, not infinite:
- Parse failure → "re-prompt the model ONCE … recovers 95%+ of errors."
- Schema-validation failure → resubmit schema + the specific error message to the model.
- JSON-mode prompt flag → 5–10× fewer errors.

The load-bearing idea: **validate at the boundary, give the model the SPECIFIC error,
re-prompt ONCE — never let it spin.**

## 3. Argument validation + repair pattern (Data Science Collective / Pydantic)

"Three-layer defense": **Pydantic schema contracts → pre-execution validation →
ONE-SHOT repair.** Quote: *"We're treating our tools like suggestions, hoping the LLM
figures it out. The real solution is to treat tool calls with the same discipline we
use for any other API integration: strict contracts, validation, and a clear plan for
when things go wrong."* One-shot repair is explicitly "distinct from repeatedly asking
the model to fix itself" — i.e. the anti-pattern is exactly what bit us (84× retry).

## 4. Tool error MESSAGE design (apxml)

When a tool gets a missing/invalid argument it should return a **structured,
LLM-targeted error**: Error Type + Descriptive Message + Context. Example:
`"Invalid user_id: '{user_id}'. ID must be a positive integer."` This lets the model
"adjust its next call with the correct argument, rather than repeating the same failed
invocation." Critically: **input-validation errors should FAIL FAST with a clear
message — NOT auto-retry.** Retries are only for transient external failures, and
those are capped.

NOTE: Clementine's `workflow_run` ALREADY returns a near-perfect message of this kind
("required input 'url' is missing. Call workflow_run again with inputs including
'url'."). The message wasn't the problem — the SCHEMA made it impossible for the model
to comply, so a perfect error caused an infinite loop.

## 5. Action verification + retry bounding (ingramhaus) — the gold-standard loop

- **LLMs can't self-verify** ("terrible at self-correcting"). Use external verifiers:
  a NL verifier (another LLM judges quality) AND code verifiers (file exists, JSON
  valid, value in range). BOTH must pass or the action is marked failed. (This is the
  Hermes "concrete handle / artifact verification" our typed-contract memo cites.)
- **Three hard guardrails**: max turns (e.g. 25 LLM calls → stop), max time (e.g.
  5 min → kill), **repetition detection ("same action 3× in a row → stop")**.
- After failed identical attempts → **REPLAN**, don't retry: "the agent goes back,
  reviews what went wrong across all attempts, and asks for a new plan," using the
  verifier's specific feedback.
- Error classification: 429 → backoff+jitter; validation fail → rewrite prompt with
  feedback (don't repeat); server error → retry once/twice then log+move on; tool
  failure → "pause and notify rather than continuing."
- **Idempotency**: unique task IDs, log completed ones, so retries can't double-send.
- **Human escalation**: notify a human after 3 retries / max turns.

## 6. Real-world failure mirror (EurekaClaw / "openclaw" issue #34)

Independent agent project hit OUR EXACT failure family: (a) tool results never
truncated → context blow-up; (b) transient 500s not retried → crash. Their fixes:
char-level truncation of tool results (`MAX_TOOL_RESULT_CHARS = 30_000`) + add 500 to
the retryable set with exponential backoff. Confirms our large-tool-output digest +
SSE-retry work was the right class of fix, and that bounding/structuring tool I/O is a
universally-needed discipline.

---

## What this means for Clementine (the synthesis)

The field converges on a **3-part contract**, and Clementine has each part PARTIALLY:

1. **NAMED, typed input schema the model can fill** (Hermes: named `properties` +
   `required`). → Clementine's `workflow_run` uses an open `z.record` map → model
   fills it `{}` 223/223. **THE root-cause fix: name the inputs (or accept a JSON
   string like composio's `arguments`, which works 198/198).**

2. **Validate at the boundary + return a structured, actionable error, fail-fast,
   re-prompt at most ONCE** (everyone). → Clementine's error message is already good;
   what's missing is the "at most once" — the schema made compliance impossible AND
   the loop guard only WARNED, so it retried 84×.

3. **Bounded loop: repetition detection → REPLAN or ASK, never spin; verify the
   action with a code/NL check** (ingramhaus). → Clementine HAS repetition detection
   (`tool-guardrail.ts`) but it delivers a SOFT, retryable error instead of a hard
   stop, so it doesn't actually stop the loop. And there's no "ask the user for the
   missing input then resume" path from a chat turn.

**Answer to "what stops Clem authoring a workflow she can't run":** the field's answer
is the typed CONTRACT verified at BOTH ends — author-time (the declared inputs are
real + named) AND call-time (the run tool's schema can supply exactly those named
inputs). Hermes gets this for free because tool schemas are generated from typed
function signatures (named params), so author-time and call-time are the SAME schema.
Clementine's workflow inputs are authored as free-form records and the run tool also
takes a free-form record — so the two halves are "compatible" only by being equally
unfillable. The fix is to make workflow inputs NAMED/typed end to end (or pass them as
a parsed JSON string), and add an author/enable-time check that every required input
has a real supply path — which is exactly the `WORKFLOW_TYPED_CONTRACT` plan, which
this incident proves needs to ship default-on.

## Sources
- https://github.com/NousResearch/Hermes-Function-Calling
- https://synilogictech.com/blog/hermes-agent-pattern/
- https://markaicode.com/hermes-agent-tool-calling-python/
- https://medium.com/data-science-collective/stop-trusting-your-agent-with-tool-arguments-dbe45fe158ad
- https://apxml.com/courses/building-advanced-llm-agent-tools/chapter-1-llm-agent-tooling-foundations/tool-error-handling
- https://ingramhaus.com/action-verification-and-retries-in-llm-agent-execution-loops
- https://github.com/EurekaClaw/EurekaClaw/issues/34
- https://deepwiki.com/NousResearch/hermes-agent
