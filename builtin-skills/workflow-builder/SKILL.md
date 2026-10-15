---
name: workflow-builder
description: Build, change, test, fix, or explain a saved workflow — a reusable, step-by-step job that runs on a schedule, on an event, or when asked. Covers shaping the steps, wiring data between them, choosing tools, telling the user what a run will cost before saving, rehearsing it without running it for real, reading the result, and fixing what it flags. Use for any request to automate a recurring task, create or edit a workflow, job, automation, routine, or pipeline, or find out why one failed.
applicability:
  toolFamilies: [workflow, workflows, automation, automate, automated, recurring, scheduled, job, routine, schedule, pipeline]
  entitySlots: [step, trigger, schedule, forEach, input, test]
---

# Workflow builder

A workflow is work the user wants done again without you in the room. You author it once; after that it runs on its own. Build it so a run succeeds when nobody is watching, and so the user knows what each run does and costs before it ever starts.

The user describes what they want; turning that into a working workflow is your job, whatever tools it needs. Never stop at "I can't build that". If something is missing (an app, an input, a decision only the user can make), build everything else, save it off, and name the one thing that remains.

## 1. Shape it before you save it

Decide these before calling `workflow_create`:

1. **Steps**: one job per step, in the order the work happens. A step that reads, a step that decides, a step that writes.
2. **What each step does to the world**, declared on the step as `sideEffect`:
   - `read`: gathers information and changes nothing (a search, a scrape, a query, reading a file).
   - `write`: changes something reversible (a file, a sheet row, a record, a draft).
   - `send`: reaches people or can't be undone (an email, a post, a message).

   Declare it honestly. It decides what a test runs for real and what it only previews.
3. **How each step runs**:
   - **`call` step:** one exact tool with known arguments, no model. Use it for fixed reads and writes. It's fast and cheap. Prefer `args_json` (JSON text) for the arguments.
   - **`prompt` step:** an agent that reasons with tools. Use it when the step has to think, choose, or write prose. Name the tools it may use in `allowedTools`.
4. **Data flow**: `dependsOn` lists the steps whose output a step needs. Refer to output as `{{steps.<id>.output}}` (add `.path` for a field).
5. **Per-item work**: `forEach` runs a step once per item of a list. The source can be written `steps.<id>.output[.path]`, `{{steps.<id>.output}}`, `<id>.output`, a bare step id, or `input.<key>`. Inside the step, `{{item}}` is the current item. On a recurring workflow, `forEachNewOnly: true` skips items earlier runs already finished.
6. **Trigger**: manual, a schedule (`trigger_schedule` plus `trigger_timezone` in the user's zone), or an event.
7. **Inputs** the user gives each run, with defaults where you can. Fixed accounts, sheets, folders and channels go in `resources`, not inputs.

Find tools before you name them. Use `tool_search` to get the exact operation names this setup has, then put them in the step's `call.tool` or `allowedTools`. Never invent an operation name.

A monitor ("only the new ones since last time") keeps its own memory with `workflow_state` under its own workflow name:

- `filter_unprocessed` returns the items not handled yet.
- `mark_processed` records the ones finished.

## 2. Tell the user what a run will cost, then improve it

Before saving, work out what one run does and say it plainly, in your own words:

- **How many times each step runs.** A `forEach` step runs once per item.
- **How many agents a run starts.** Each `prompt` step is one agent per run, or one per item under `forEach`. Agents are the slow, costly part: often tens of seconds each, with up to five running at once. A `call` step is one direct tool call and takes seconds.
- **Roughly how long a run takes.** Estimate it as items ÷ 5 × time per item, for each agent step.
- **What it changes and where**, and whether any step will stop to ask the user first.
- **How often it runs.** A per-run cost repeats on every scheduled run.

Then suggest the improvement that matters, if there is one. For example:

> "research_angles starts a research agent for every account. With 50 accounts that's 50 agents per run, about 10 minutes. I can cap it at the 10 most recent, or research them in one batched step."

Other common improvements:

- Use a `call` step instead of an agent for a fixed read or write.
- Use `forEachNewOnly` on recurring runs.
- Merge two agent steps that only pass text between them.
- Put `requiresApproval` on a send the user wants to see first.

Offer one to three; don't lecture.

## 3. Missing apps, accounts and inputs

- **An app a step needs isn't connected.** Save the workflow anyway. It stays off, and its rehearsal names the app. Offer the user the connection. Never block on it, and never swap in a different provider without saying so.
- **The user asked generically** ("search the web", "check my calendar"). Use what this setup already has connected.
- **Several accounts could run a step.** The rehearsal asks once, and the answer is saved on the step.
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
| **not checked** | It depends on a previewed step, or on a provider definition still settling. | Nothing. A real run handles it. |
| **needs \<app\> connected here** | A dependency, not a defect. | Offer the connection, then `workflow_test` again. |
| **needs your answer** | One question, usually which account to use. | Ask it plainly. |
| **returned nothing** | Either a quiet day or a broken read. | Look at the step's output and say which. |
| **failed / hit an error** | A real defect. | Read the detail and fix the step. |

To fix a step, use `workflow_edit_step` with a patch of only the fields that change. Then run `workflow_test`. Don't resend the whole workflow with `workflow_update` to change one step.

## 6. Workflows from someone else

A workflow imported from another person's setup arrives off. It arrives without their accounts, connections or chosen models, and it's rehearsed here before it can turn on. Treat its first rehearsal's result like any other.

## 7. Report like a colleague

When it's saved, tell the user five things:

- what it does;
- when it runs;
- what it changes;
- what a run costs;
- what, if anything, they still need to do.

Use plain words. Never paste internal reason codes, run ids or tool names at them.
