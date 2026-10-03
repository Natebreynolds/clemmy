# Website feature evidence

Source audit for the mobile and six-chapter revision, 2026-10-02. These references
support product copy and illustrative interactions. They do not constitute fresh
installed-app or website acceptance. Shared checkout: `main`; unrelated edits
were preserved. The installed daemon was present, but its settings and build-info
endpoints required authentication, so no current served-model claim is made.

## Recording

Supported copy: **“Turn a conversation into a transcript, decisions, and next
steps.”**

- In-person recording captures the microphone through the desktop bridge, with
  `video: false`: [local-meeting-recorder.ts](../../console-web/src/lib/local-meeting-recorder.ts#L97).
  Local Whisper produces an incremental transcript view; the full transcription
  after stopping remains authoritative:
  [live-transcript.ts](../../../src/integrations/local-meetings/live-transcript.ts#L1).
- Structured analysis contains a summary, decisions, action items with optional
  owner/due date, topics, and participants:
  [meeting-analysis-tools.ts](../../../src/tools/meeting-analysis-tools.ts#L13).
  User notes marked during the meeting inform the analysis:
  [buildAnalyzerPrompt](../../../src/integrations/recall/meeting-capture.ts#L1772).
- Follow-up discussion uses the full transcript and asks what the user wants to
  act on: [buildMeetingChatPrompt](../../../src/integrations/recall/meeting-capture.ts#L1819).

Limits: analysis does not send messages, schedule work, or execute action items
([explicit tool contract](../../../src/tools/meeting-analysis-tools.ts#L66)).
Current local transcription uses English `base.en`; raw audio is deleted after
successful transcription by default, with keeping audio an opt-in
([settings](../../../src/integrations/local-meetings/meeting-capture.ts#L35)).
Do not describe all recording or subsequent analysis as offline. Connected Recall
capture is a separate configured service; its native recorder supports Apple
Silicon macOS and x64 Windows, not Intel Mac
([platform gate](../../../apps/desktop/src/recall-capture.ts#L103)).

Website example: a labeled 12-minute launch sync, with Transcript/Summary/Actions
tabs and matching sample decisions and owners. The waveform is illustrative;
the website requests no microphone access and does not execute the action items.

## Interactive Spaces and workflows

Supported copy: **“An interactive place for the work—its data, its view, and the
actions you choose.”**

- Spaces persist an agent-authored view, datasets, notes, and configuration:
  [store.ts](../../../src/spaces/store.ts#L1).
- Sources can use authored scripts, approved fixed CLI calls, or connected
  Composio operations. A source can refresh on demand or on its configured
  schedule: [SpaceDataSource](../../../src/spaces/store.ts#L183).
- Views can invoke declared server-side actions:
  [SpaceAction](../../../src/spaces/store.ts#L210). Approval-gated effects bind
  authority to the actual workspace, action, and arguments:
  [space-action-authority.ts](../../../src/spaces/space-action-authority.ts#L184).
- Concrete intended uses include a task board, inbox triage, daily brief, and
  deal board: [starter-recipes.ts](../../../src/spaces/starter-recipes.ts#L35).
  Reusable workflows have configured triggers and per-step approval gates:
  [workflow-store.ts](../../../src/memory/workflow-store.ts#L484),
  [approval policy](../../../src/memory/workflow-store.ts#L257).

Limits: a static Space does not automatically gain connected sources, refreshes,
or actions. Changes and “since last time” claims require comparable successful
observations. A saved analysis is not an executed workflow. Permissions and
configured sources still apply; the rendered view does not receive credentials.

Website example: an illustrative launch board with Open/All filters and a source
preview that returns to the previous filter. Workflow controls change an example
on-demand, scheduled, or event-triggered trace. These local state changes neither
refresh a live account nor create a real Space or workflow.

## Multi-model and multi-agent architecture

Supported copy: **“Let one model plan, specialists do the work, and a reviewer
check the result.”**

- Canonical roles distinguish the orchestrator, delegated worker, reviewer,
  optional writer, and background memory model:
  [model-roles.ts](../../../src/runtime/harness/model-roles.ts#L54).
- Saved specialists carry standing instructions, skills, workflows, tool
  families, a named model or role, and a memory scope:
  [agent-record.ts](../../../src/agents/agent-record.ts#L41).
  Worker dispatch resolves the saved agent and its model pin:
  [agent-binding.ts](../../../src/agents/agent-binding.ts#L115).
- Independent worker items can run concurrently in separate contexts with a
  bounded pool and per-item outcomes:
  [worker-tools.ts](../../../src/tools/worker-tools.ts#L172).
- Projects hold purpose, goals, shared context, resources, and explicit agent
  assignments: [project-record.ts](../../../src/projects/project-record.ts#L1).
  Completion review compares requested deliverables with evidence:
  [objective-judge.ts](../../../src/runtime/harness/objective-judge.ts#L45).

Limits: a saved specialist is a chosen working context within the shared harness,
not an independent execution engine. Not every request uses every role, parallel
workers, or distinct models. The writer defaults to the brain unless explicitly
bound. Available providers and configuration determine actual routing; example
model choices do not establish provider availability or guarantee correctness.
Project membership grants no additional action authority.

Website example: one project request passes through specialist lanes and a
reviewer. Native selectors independently change model pins and retain those
choices while navigating; source copy distinguishes roles from model families.

## System One / Jev

Use **“built-in System One integration, when connected.”** The request targets
TypeSafe's System One API
([system-one.ts](../../../src/runtime/jev/system-one.ts#L9)); the client requires
an enabled integration and configured key
([client.ts](../../../src/runtime/jev/client.ts#L63)). It supports typed decisions
within the harness. Do not present it as an always-running local model, another
specialist, or a guarantee that every result is correct.

## Revision status

The new recording/Spaces demos and mobile reading flow completed bounded
browser acceptance, recorded in [mobile and feature verification](mobile-features-verification.md).
Earlier production test totals describe the prior revision. This source audit
made no live-home, integration, runtime-setting, or deployment changes.
