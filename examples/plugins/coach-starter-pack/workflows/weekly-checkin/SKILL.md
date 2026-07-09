---
name: weekly-checkin
description: Every Monday morning, draft the week's client check-in notes from recent session notes and open commitments — drafts only, nothing sends without approval.
enabled: true
trigger:
  schedule: "0 9 * * 1"
steps:
  - id: gather
  - id: draft
---

## step: gather

Review memory and recent notes for every active coaching client: last session's summary, open commitments and their due dates, and anything the coach owes them. Produce a short per-client digest. If there are no active clients yet, say so and stop — do not invent clients.

## step: draft

For each client digest from the previous step, draft a short, warm check-in message (3-5 sentences): acknowledge last session's focus, name the open commitment and its date without nagging, and offer one specific support. Present all drafts for review — these are drafts for the coach to send; never send anything directly.
