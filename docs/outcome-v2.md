# Outcome V2

**Status:** Next implementation tranche  
**Date:** 2026-07-17

## Objective

Every Clementine lane returns the same durable, renderable proof of work. Chat,
background tasks, workflows, schedules, meetings, Workspaces, notifications,
Discord, and mobile may format an outcome differently, but they must not invent
different meanings for completion.

## Contract

```ts
type OutcomeStatus = 'done' | 'blocked' | 'failed' | 'needs_input' | 'progress';

interface OutcomeV2 {
  version: 2;
  id: string;
  status: OutcomeStatus;
  summary: string;
  detail?: string;
  origin: {
    sessionId?: string;
    request?: string;
    sourceKind: 'chat' | 'background' | 'workflow' | 'schedule' | 'meeting' | 'system';
    sourceId: string;
  };
  artifacts: Array<{
    id: string;
    label: string;
    kind: string;
    uri?: string;
    preview?: string;
  }>;
  evidence: Array<{
    label: string;
    value: string;
    uri?: string;
  }>;
  delivery?: {
    status: 'not_applicable' | 'pending' | 'delivered' | 'failed' | 'unknown';
    destination?: string;
    receiptId?: string;
  };
  needs?: Array<{
    id: string;
    prompt: string;
    kind: 'input' | 'approval' | 'verification';
  }>;
  nextAction?: {
    label: string;
    action: string;
    args?: Record<string, unknown>;
  };
  startedAt?: string;
  completedAt?: string;
}
```

## Product rules

1. A terminal run cannot end without one terminal Outcome.
2. `done` means the requested result exists, not merely that execution stopped.
3. External delivery is never inferred from prose; it comes from a durable
   receipt or is marked `unknown`.
4. Artifacts and evidence remain addressable after the conversation scrolls
   away.
5. `needs_input` and `blocked` identify the exact decision that unblocks work.
6. Every surface renders the same primary hierarchy: result, proof, decision,
   next action. Runtime telemetry belongs in a secondary disclosure.
7. Outcome delivery is idempotent by Outcome id and origin session.

## Migration

1. Add V2 as a backward-compatible extension of the current Outcome type.
2. Teach background tasks and workflows to populate origin, artifacts, evidence,
   and delivery receipts.
3. Add an atomic notification-store-to-delivery-queue receipt boundary so an
   external delivery is never inferred from a local notification marker.
4. Split pinned-goal and auto-self-heal judging from their short, locked
   commit-and-requeue transactions.
5. Build one shared Outcome card for the desktop console.
6. Reuse the same view model in Tasks, Inbox, Workspaces, and Meetings.
7. Add compact Discord/mobile renderers from the same stored record.
8. Remove text-only completion fallbacks after all producers emit V2.

## Acceptance tests

- The same completed workflow has the same status, artifact ids, evidence, and
  next action in Chat, Tasks, and Inbox.
- A delivered email shows its destination and durable receipt; an ambiguous send
  never displays `delivered`.
- A blocked run exposes one actionable unblock decision.
- A completed artifact can be reopened from a fresh app session.
- Duplicate completion signals produce one Outcome card.
- A lane that exits without an Outcome is converted to a visible failed outcome
  by the watchdog.
