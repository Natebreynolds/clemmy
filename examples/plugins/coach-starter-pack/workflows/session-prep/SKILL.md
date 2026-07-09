---
name: session-prep
description: Before a coaching session, assemble a one-page prep brief for a named client — history, open commitments, and a suggested opening.
enabled: true
trigger:
  manual: true
inputs:
  client:
    type: string
    required: true
    description: The client's name, exactly as it appears in session notes.
steps:
  - id: prep
---

## step: prep

Assemble a one-page prep brief for the client named in the inputs. Pull from memory and prior session notes:

- **Last session**: summary + how it ended.
- **Open commitments**: each with its by-when and current status if known.
- **Running themes**: patterns across the last few sessions.
- **Suggested opening**: one question to open with, grounded in their open commitment (see the coaching principles in memory — accountability before agenda).

If the client has no history yet, produce a first-session brief instead: what to establish (goals, cadence, how they want to be held accountable). Never fabricate history.
