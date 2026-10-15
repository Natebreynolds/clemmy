---
name: workflow-builder
description: Build, change, optimize, test, fix, or explain a saved workflow — a reusable, step-by-step job that runs on a schedule, on an event, or when asked. Covers shaping the steps, wiring data between them, choosing tools, telling the user what a run will cost before saving, reviewing an existing workflow for a better way to run it, rehearsing it without running it for real, reading the result, and fixing what it flags. Use for any request to automate a recurring task, create, edit, improve or optimize a workflow, job, automation, routine, or pipeline, or find out why one failed.
applicability:
  toolFamilies: [workflow, workflows, automation, automate, automated, recurring, scheduled, job, routine, schedule, pipeline, optimize, optimise, improve]
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

Then, in the same message, offer the improvement that matters. When a step starts an agent for every item and the list can run past about ten, or a run takes more than a few minutes, always offer one concrete alternative and say what it saves. Do this even when you are also asking the user something else; one message can carry both. For example:

> "research_angles starts a research agent for every account. With 50 accounts that's 50 agents per run, about 10 minutes, every weekday. I can cap it at the 10 most recent accounts (about 2 minutes), only research accounts that are new since the last run, or research them all in one batched step. Which would you like, or keep all 50?"

Other alternatives worth offering when they fit:

- Use a `call` step instead of an agent for a fixed read or write.
- Merge two agent steps that only pass text between them.
- Put `requiresApproval` on a send the user wants to see first.

Offer one to three. Let the user choose, and build what they pick; don't lecture.

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

## 6. Improve or optimize a workflow that exists

When the user asks you to optimize, improve, review or clean up a workflow, look at all of it before changing anything:

1. **Read the whole definition** with `workflow_get`: every step's prompt or call, its `allowedTools`, the skills it uses, its inputs, resources, trigger and goal.
2. **Read how it has actually run.** `workflow_run_status` with `workflow` lists its runs. With a `run_id` it shows each step's result, and adding `step_id` gives that step's full output: the work the run actually did. Look for which steps take the time, which fail, which come back empty or thin, and what each run costs.
3. **Question every step and every tool it names**, against what this setup actually has connected:
   - Is this the best tool here, or does a connected tool do the job more directly? Examples: an API instead of driving a browser, one batched call instead of one per item, a `call` step instead of an agent for a fixed read or write.
   - Does the step name a tool or app this setup doesn't have or doesn't use? Workflows written elsewhere often do. Replace it with what is here, and tell the user.
   - Is each attached skill and allowed tool still needed? An unused tool is a wider door than the step needs.
   - Could two agent steps be one? Does a per-item step need to run for every item, or only new ones?
4. **Apply the changes** with `workflow_edit_step`, one step at a time, then run `workflow_test`. Fix anything it flags and test again.
5. **Report what changed, step by step:** what it was, what it is now, why, and what that does to a run (agents, time, cost). Include the rehearsal result.

Finish the work before you report. Never end on "let me check X next": check it, change it, test it, then report.

When the user also asks you to make sure it works end to end, the rehearsal is not the end. Writes and sends are only previewed there. Offer one real run with the smallest input that exercises every step, run it once they agree, and fix what it shows.

When the user asks about a run ("About run … of my … workflow"), read that run first: its step results, then the full output of the steps that matter. Talk about what it actually produced, then offer the improvements it points to.

## 7. When a real run stops

- **The cause is the workflow's own setup** (a step's arguments, its instructions, or its output not matching what the next step needs). That is yours to fix: correct the step with `workflow_edit_step`, run `workflow_test`, then run it again. Tell the user what was wrong and what you changed.
- **The cause is outside the workflow** (an app to connect, an account to choose, a person's decision). Name that one thing and wait for it.

Never hand the user a reason code. Say what happened in plain words.

## 8. Workflows from someone else

A workflow imported from another person's setup arrives off. It arrives without their accounts, connections or chosen models, and it's rehearsed here before it can turn on. Treat its first rehearsal's result like any other.

## 9. Report like a colleague

When it's saved, tell the user five things:

- what it does;
- when it runs;
- what it changes;
- what a run costs;
- what, if anything, they still need to do.

Use plain words. Never paste internal reason codes, run ids or tool names at them.
