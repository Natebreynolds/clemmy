---
name: workflow-builder
description: Build, change, optimize, test, fix, or explain a saved workflow — a reusable, step-by-step job that runs on a schedule, on an event, or when asked. Covers shaping the steps, wiring data between them, choosing tools, explaining expected run work, cost estimates and unknowns before saving, reviewing an existing workflow for a better way to run it, rehearsing it without running it for real, reading the result, and fixing what it flags. Use for any request to automate a recurring task, create, edit, improve or optimize a workflow, job, automation, routine, or pipeline, or find out why one failed.
applicability:
  toolFamilies: [workflow, workflows, automation, automate, automated, recurring, scheduled, job, routine, schedule, pipeline, optimize, optimise, improve]
  entitySlots: [step, trigger, schedule, forEach, input, test]
tools: [workflow_get, workflow_create, workflow_update, workflow_edit_step, workflow_set_enabled, workflow_run, workflow_run_status]
---

# Workflow builder

A workflow saves how work gets done without you in the room. Build it to succeed when nobody is watching. Explain its workload, effects and known cost; label estimates and unknowns.

The user describes what they want; turning that into a working workflow is your job, whatever tools it needs. Never stop at "I can't build that". If something is missing (an app, an input, a decision only the user can make), build everything else, save it off, and name the one thing that remains.

## 1. Shape it before you save it

For creation, check a name collision only when needed with `workflow_list(query="<intended name>", detail="names")`. Use current tool schemas for authoring examples, not unrelated saved workflow definitions; preserve the user's resource restrictions. A requested review of an existing workflow still needs its whole relevant definition.

Decide these before calling `workflow_create`:

1. **Steps and completion**: one meaningful job per step, with dependencies where needed. Preserve the whole objective, standing instructions and required deliverables. Declare output contracts for downstream consumers and a saved goal when completion needs whole-run verification.
2. **What each step does to the world**, declared on the step as `sideEffect`:
   - `read`: gathers information and changes nothing (a search, a scrape, a query, reading a file).
   - `write`: changes something reversible (a file, a sheet row, a record, a draft).
   - `send`: reaches people or can't be undone (an email, a post, a message).

   Declare it honestly. It decides what a test runs for real and what it only previews.
3. **How each step runs**:
   - **`call` step:** one exact tool with known arguments, without a reasoning model. Use it for fixed reads and writes; prefer `args_json` (JSON-object text).
   - **`transform` step:** a pure closed JSON expression for supported parsing, filtering, mapping, sorting or aggregation. Use it for deterministic data shaping; it has no tools, files, network or shell. Declare `sideEffect: read` and every upstream dependency.
   - **`prompt` step:** a model that reasons with tools. Use it for judgment, choosing an approach or writing prose. Name the needed discovered tools in `allowedTools`.
4. **Data flow**: `dependsOn` lists the steps whose output a step needs. Refer to output as `{{steps.<id>.output}}` (add `.path` for a field).
5. **Per-item work**: `forEach` runs a step once per item of a list. The source can be written `steps.<id>.output[.path]`, `{{steps.<id>.output}}`, `<id>.output`, a bare step id, or `input.<key>`. Inside the step, `{{item}}` is the current item. On a recurring workflow, `forEachNewOnly: true` skips items earlier runs already finished. Structured `call` fan-out supports reads only.
6. **Trigger**: manual, a schedule (`trigger_schedule` plus `trigger_timezone` in the user's zone), or an event.
7. **Inputs** the user gives each run, with defaults where you can. Fixed accounts, sheets, folders and channels go in `resources`, not inputs.

Use exact operation names and argument schemas already supplied by current tool definitions, this turn's discovery or proven-operation evidence. Search with `tool_search` only for a missing operation or schema; do not rediscover the same known operation. Put executable names in `call.tool` or `allowedTools`, never capability references or invented names. The host binds and checks accounts at dispatch.

For current saved Workspace inputs, use a `call` to `space_get` with its exact `slug` and optional `source_id`; the workflow result holds the saved value in `data` and its identity/revision in `workspace`. Save those inputs before creating the workflow, because creation immediately rehearses its reads. Do not replace this native read with a model searching local files. Pass the returned data explicitly to the reasoning step. If `space_set_data.data_json` needs a JSON string, use a `jsonStringify` transform on the actual preceding output, not a model retyping the dataset. Missing inputs are a prerequisite to fix, not permission to search other resources.

An available CLI, MCP server or provider operation can supply a capability. Use the actual executor and its schema; do not assume a particular connector is required. Keep an explicitly requested provider, account and destination. A generic request lets you choose a suitable available path that fulfills the same task. Read-only does not establish connection, authorization or zero cost.

**A workflow connected to a Space writes into it.** When the workflow feeds a Space (its drafts, its findings, its status), its last step is a `space_set_data` call that writes the shaped rows into that Space under a named source, from a transform step's output. Never leave the result only in the run's output; the Space is where the owner sees and acts on it. For work the owner reviews first, write each item with `status: "draft"` and its full content, and build the matching Approve workflow (the Space's button runs it) that publishes that exact item and sets its status. The workspace-builder skill describes the review queue.

A monitor ("only the new ones since last time") keeps its own memory with `workflow_state` under its own workflow name:

- `filter_unprocessed` returns the items not handled yet.
- `mark_processed` records the ones finished.

## 2. Explain the workload and choose an efficient approach

As you save, summarize the workload, changes and cadence without adding a separate confirmation round:

- Count executor invocations, including per-item work; use a formula or labeled range for unknown item counts. A prompt invocation may include several model calls.
- Estimate elapsed time from comparable runs or stated dependency/concurrency assumptions. Label cold-start and provider uncertainty; neither summed overlapping durations nor a fixed worker count proves wall time.
- Available usage must cover attributable execution, reviews, retries/failures and memory across providers. Keep missing legs unqualified. Distinguish measured tokens, estimated provider cost and actual billing. Without evidence, say cost or duration is unknown.
- Say what changes, where, how often, and any genuine decision or approval still needed.

Choose efficient means that preserve the requested scope: reuse known calls, use transforms for mechanical work, batch compatible reads, or combine reasoning steps when no separate contract or review is needed. Do not claim savings without a comparable baseline or weaken required evidence to make a run cheaper.

Make delegated choices without an extra optimization question. Use the runtime-resolved current account/default first, honoring user pins; do not add a prose question when dispatch or rehearsal already resolves it. Ask only for consequential unresolved facts or scope, budget, provider/account, destination or permission decisions. Capping a list, processing only new items or dropping deliverables changes scope. Explain one useful alternative when needed, and continue independent work.

## 3. Missing apps, accounts and inputs

- **A required capability isn't available here.** Check the current tools, including CLI and MCP paths, before declaring an app disconnected. Save the rest of the workflow; it stays off if a required step cannot rehearse. Name the missing connection or definition and offer the concrete next step. Keep an explicit provider/account choice unless the user agrees to change it.
- **Several accounts remain genuinely ambiguous.** The rehearsal owns one exact question/card; use it rather than asking again. Its answer is saved on the step.
- **An input has no default.** Pass a realistic value in `test_inputs` so the rehearsal can run.

## 4. Rehearse it: never test by running it for real

- **`workflow_create` rehearses as it saves.** Steps that read run for real against the connected tools. Steps that write or send are only previewed, never run. It turns the workflow on only if that passes, unless you saved it with `enabled: false`.
- **`workflow_test` rehearses a saved workflow at any time** without turning it on or off. Use it after changes, and whenever the user asks "does it work?".
- **`workflow_set_enabled enabled=true`** rehearses, then turns it on if that passes.
- **`workflow_run` is a real run.** Use it only when the user wants the work done, not to check it.

## 5. Read the rehearsal and fix what it flags

Each step comes back with one of these results:

| Result | What it means | What to do |
|---|---|---|
| **returned data** | It worked. | Nothing. |
| **previewed** | A step that makes changes; the test didn't run it, by design. | Nothing. |
| **checked on the first real run** | Readback depends on a mutation the rehearsal only previewed (`unverifiable`). | Explain the deferred check; do not claim the mutation or readback passed. |
| **did not run** | A required prerequisite, definition or effect check remains unresolved (`not_run`). | It is not a pass. Resolve the named prerequisite and test again; do not use a real run to bypass it. |
| **needs \<app\> connected here** | A dependency, not a defect. | Offer the connection, then `workflow_test` again. |
| **needs your answer** | One question, usually which account to use. | Ask it plainly. |
| **returned nothing** | Either a quiet day or a broken read. | Look at the step's output and say which. |
| **failed / hit an error** | A real defect. | Read the detail and fix the step. |

To fix a step, use `workflow_edit_step` with a patch of only the fields that change. Then run `workflow_test`. Don't resend the whole workflow with `workflow_update` to change one step.

## 6. Improve or optimize a workflow that exists

When the user asks you to optimize, improve, review or clean up a workflow, look at all of it before changing anything:

1. **Read the whole definition** with `workflow_get`: every step's prompt or call, its `allowedTools`, the skills it uses, its inputs, resources, trigger and goal.
2. **Read how it has actually run.** `workflow_run_status` with `workflow` lists its runs. With a `run_id` it shows each step's result, and adding `step_id` gives that step's full output: the work the run actually did. Look for which steps take the time, which fail, which come back empty or thin, and what each run costs.
3. **Question every step and every tool it names**, against what this setup actually has connected:
   - Could a known call, transform or compatible batch replace redundant discovery or reasoning?
   - Does a named capability exist here through a provider, MCP or CLI? Preserve explicit provider/account choices; similar names do not prove equivalent behavior.
   - Is each attached skill and allowed tool still needed? An unused tool is a wider door than the step needs.
   - Could two agent steps be one? Does a per-item step need to run for every item, or only new ones?
4. **Apply the changes** with `workflow_edit_step`, one step at a time, then run `workflow_test`. Fix anything it flags and test again.
5. **Report what changed, step by step:** what it was, what it is now, why, and the expected or measured effect on workload. Label time/cost estimates and unknowns. Include the rehearsal result and any acceptance still outstanding.

Finish the work before you report. Never end on "let me check X next": check it, change it, test it, then report.

When the user asks for end-to-end proof, the rehearsal is not the end: writes and sends were only previewed. Use the smallest authorized real run that exercises the required steps, then read back the actual deliverable and relevant visual evidence. If permission for those effects is missing, ask for that concrete decision. A queued run is not completion: report that it is running, let its automatic outcome arrive, and do not poll or duplicate its work unless a status check is requested.

When the user asks about a run ("About run … of my … workflow"), read that run first: its step results, then the full output of the steps that matter. Talk about what it actually produced, then offer the improvements it points to.

## 7. When a real run stops

Read the exact run with `workflow_run_status` before deciding how to recover. Keep completed outputs and distinguish effects that landed, were proven not dispatched, or remain uncertain. An error or timeout does not prove nothing happened.

- **The cause is the workflow's own setup** (arguments, instructions or an output contract). Correct the relevant fields with `workflow_edit_step` and rehearse with `workflow_test`. That prepares the saved definition; it does not authorize repeating earlier effects.
- **The run needs a connection or account choice.** Use the exact `workflow_capability_resolve` action and coordinates returned by status after the connection or human choice; resume that run rather than queueing a duplicate.
- **Only fan-out items failed.** When retrying them is authorized, use `workflow_rerun_failed_items` for the existing run so successful items and upstream work stay completed.
- **A write/send is uncertain or the user pressed Stop.** Preserve the run and reconcile against actual readback. Do not retry, choose another account/tool, change an effect declaration or start a fresh `workflow_run` to bypass the stop. Continue only through the supported exact recovery path with the needed authority. If no safe path is available, state what evidence or decision is missing.

Say what was fixed, what remains and the next concrete step in plain words. Never hand the user a reason code.

## 8. Workflows from someone else

A workflow imported from another person's setup arrives off. It arrives without their accounts, connections or chosen models, and it's rehearsed here before it can turn on. Treat its first rehearsal's result like any other.

## 9. Report like a colleague

When it's saved, tell the user five things:

- what it does;
- when it runs;
- what it changes;
- its expected workload and known or estimated cost, with unknowns labeled;
- what, if anything, they still need to do.

Use plain words. Never paste internal reason codes, run ids or tool names at them.
