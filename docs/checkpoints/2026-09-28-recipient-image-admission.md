# Recipient approval context and attachment admission — 2026-09-28

Framework work in codex/meeting-analysis-save, building on installed 32290857a.

## Observed failures

- Live source 323133 / sess-desktop-749990bcd0529eb9a4247544: Slack lookup verified Adam Long, OPEN_DM bound U0AV61PAN to D0BKE5V0T, but approval apr-u8qs displayed only the channel ID. The owner approved; exactly one physical SEND succeeded (ts 1790636094.670389), with a reviewed terminal. Judge requested GLM5.2, provider reported GLM5.3: not exact-pin acceptance.
- Live source 323234 / sess-desktop-a3dd9f8195abca0a17ff659d: image calendar request stopped after before_bridge in 20ms, before any model/tool call. Attempt marked completed with no terminal, leaving the running marker. Replay identity compared attachment-enriched source.text with unaugmented displayMessage.

## Changes

- Match accepted source displayText against request displayMessage, falling back to source.text for older records. Session/source/attempt correlation still applies. Preserve enriched model input and original immutable source.
- Desktop admission publishes an exact failed terminal when its bridge returns blocked/error without a terminal or durable workflow handoff. A success lacking proof is never synthesized as done.
- Adapter-owned Slack destination presentation joins redeemed single-user OPEN_DM arguments/results to verified user lookup results. Evidence is same accepted source and same durable account binding. No proximity/name guessing, no group-member inference, no new model call for proven identity, no consent changes. Missing/foreign/conflicting evidence cannot produce this label. Existing generic Jev labels remain available for other identifiers.
- Connection alias (when uniquely bound to that exact account) is display context only. Exact channel value and provider arguments remain untouched; desktop/mobile already render optional labels.

## Verification and limits

Evidence and final receipts: output/recipient-image-0928/.
The image HTTP pin fails on the previous bridge (zero model invocations); with the fix it preserves the image path, invokes once, closes the terminal and does not repeat on request retry. Replay pin keeps foreign text/run refusal. Adapter pins reject ambiguous/foreign/group destinations.
Typecheck passed before final build. Final test/build and installed acceptance are recorded in that output directory, not inferred from source changes.
No business messages or calendar invitations are authorized for this task's controlled acceptance. Do not approve the owner's older pending Slack sends. The original screenshot lacks a year and contains TBD and multi-day dates: extracting it is not permission to invent event dates or attendees.
No tag/main merge here. Native shell/signature stays unchanged for a runtime-only hotpatch. Full image read acceptance, not merely disappearance of Thinking, is required before calling the image path fixed.
