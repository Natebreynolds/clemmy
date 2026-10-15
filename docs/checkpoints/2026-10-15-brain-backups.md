# 2026-10-15 — backup brains

Trigger: Together's DeepSeek V4 endpoints returned 503 after 30 s for about
an hour (other Together models were fine). Every chat waited about 60 s and
stopped; the owner had no warning and no offer to switch.

Owner decisions (10-15):

- When the chosen brain stops answering and a backup is set: switch, then
  tell.
- Backups are only models the owner lists. There is no automatic order.
- All chats move on a switch.
- Memory keeps waiting for its own model.

## What changed

- `src/runtime/harness/brain-backups.ts`: `CLEMMY_BRAIN_BACKUPS` holds the
  ordered list (at most 3 connected brain choices). An empty list means no
  switch.
  - The outage record lives in `state/brain-outage.json`.
  - It opens after two no-answer failures in ten minutes, but only while a
    backup is listed. No-answer means overload, 5xx, transport or first-content
    timeout, response wall, host stall, or an empty completion.
  - A pace wall, a rate limit, an auth failure or a caller stop never counts.
  - A background check asks the down model one short question: first after 2
    minutes, then backing off to 30. When it answers, the record is marked
    recovered.
  - The backups keep answering until the owner chooses.
- `router-model.ts`: a brain request's chain is the chosen brain followed by
  the owner's backups. A brain request is one of:
  - the default model,
  - the conversation's brain,
  - a model in an outage,

  as long as it is outside a worker and outside a background job.
  - The built-in chain is gone: BYO siblings, `codex:rescue` and
    `claude:rescue`.
  - Workers keep their small-model rescue.
  - Every other request (memory, checker, writer) is served by its own model
    alone.
- `fallback-model.ts`: a chain marked with `brainLabel` feeds the outage
  record. While an outage is open, the chain starts on the backups
  (`preselected-brain-outage`). This applies to every conversation, pinned or
  not.
- `falloverBrainModelIds` (mid-turn and workflow-step fallover) and the
  chat/workflow gates read the same list.
- `src/dashboard/active-brain-switch.ts` is the one function that switches the
  active brain. The Settings route and the owner's "No, keep the backup"
  answer both use it. Any manual switch closes an open outage.
- `src/dashboard/brain-outage.ts` puts two cards on Home, both carrying typed
  facts and voiced by Clem:
  - When the backups take over: an update, with no push.
  - When the chosen brain answers again: a question with Yes and No buttons.
    - Yes switches back.
    - No makes the backup the brain and moves every conversation pinned to the
      old one.
    - Later hides the card until tomorrow, and the backup keeps answering.
- Settings → Models has a new "If it stops answering" row with up to three
  ordered pickers. The retired Codex rescue field is gone. The phone gets the
  same data and route.
