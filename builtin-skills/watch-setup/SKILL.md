---
name: watch-setup
description: Set up, change, or explain a watch — a standing, read-only look at a source the owner hands you (an inbox or label, a Slack channel, a Drive folder, a CRM view, a repo, a local folder) so you learn their work and tell them when something they care about shows up. Use when the owner asks you to keep an eye on, watch, monitor, track, or follow something, or when you suggest watching a source.
applicability:
  toolFamilies: [watch, watches, monitor, workflow, workflows]
  entitySlots: [source, inbox, channel, folder, schedule, what to look for]
tools: [workflow_create, workflow_update, workflow_run, workflow_run_status]
---

# Watch setup

A watch is how the owner hands you a source the way they would hand a personal assistant access to their email or a shared folder. Each watch adds to what you know about their work, and what you know compounds: what you learn becomes memory, and what matters reaches them in From Clem as "Your <source> watch".

A watch is a saved workflow with a `watch` field (`source`, `look_for`, `purpose`). The workflow owns the read and its schedule. A watch only reads: it never sends, posts, or changes anything outside this computer. Drafting or acting on what it finds is a separate workflow you can suggest later, once the owner has seen what the watch finds.

## 1. Agree the watch in one question

Before saving, confirm the watch with the owner once, in plain words:

- **Source and scope**: exactly what you will read (which inbox or label, which channel, which folder). Prefer the narrowest scope that covers what they asked.
- **What to look for**: in their words ("a client who sounds unhappy", "a deal that slips a stage").
- **How often**: match how fast the source changes. When the source can notify on arrival, prefer an event trigger over polling.
- **Tell me, or just learn**: `tell_me` raises what matters; `learn` only remembers.

Ask this as one question with your proposal filled in, so they can answer "yes" or adjust one part. Do not ask again once they have answered. Ask in your own voice about what they asked for: the owner never hears about this guide, its rules, or a step that "wants" something, only what you will set up and whether that matches.

## 2. Build it

- Use the source through a connected tool, CLI, or local read the owner already has. When nothing can read it, offer the connection instead of saving a watch that cannot run.
- Keep it to two or three steps: exact `call` steps to list and read (`list_files`, `read_file`, a provider read), then ONE model step that judges what matters against what the owner asked you to look for. Listing or reading never needs a model step.
- Read what is recent; do not build your own record of what was already seen. The host remembers every finding's `key` and never raises the same one twice, so re-reading an item is harmless. Bound the read by time when the source is large (for example `{{now-2h}}` for a two-hour cadence).
- A watch needs no saved `goal`: its findings list is its result, and the host flags a run that returns none. A goal adds a judge to every run and to every rehearsal.
- The LAST step returns JSON and nothing else:

```json
{"findings": [{"title": "Acme's champion sounds frustrated about the delayed rollout", "detail": "Two messages today asking for a date; tone is sharper than last week.", "link": "https://…", "key": "<stable id of the message or record>"}],
 "learned": ["Acme's champion is Dana Ortiz; she escalates when a date slips."]}
```

  - `findings`: only new items that match what the owner asked for. An empty list is a normal, good run.
  - `title` is one plain sentence a person would want to read; `detail` says why it matters. Never paste raw records or ids into them.
  - `key`: a stable id from the source, so the same item is never raised twice.
  - `learned`: durable things about the owner's work worth remembering (who matters, recurring asks, how things usually go). Skip one-off facts.
- Give that step an output contract with `findings` as a required key.

## 3. After saving

- Run it once now so the owner sees what it finds, and tell them in one or two sentences what you are watching and how often.
- The owner can tell you rules in their own words ("only during work hours", "skip anything from the bot account"); add them as rules on the watch. They can pause it or narrow it any time.
- When a watch keeps finding the same kind of thing, suggest the next step with the evidence: an alert they can rely on, a draft you prepare for review, a Space that shows it, or taking over a routine they do by hand. Suggest one thing at a time, and only what the watch has actually shown.
