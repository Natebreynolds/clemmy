# PR-02 — "Clem suggests": one durable suggestion record, one card, both surfaces

Size M · risk additive · depends on PR-00 · carries PR-03, PR-04, PR-09, PR-12

## Why

Clem already proposes things in four unrelated shapes, each with its own storage
and door:

| Today | Store | Door | Owner's answer |
|---|---|---|---|
| "Keep this model for this kind of work?" (`src/runtime/harness/worker-model-offer.ts`) | per conversation | `ModelRuleOfferCard` in `TurnReceipt.tsx:243`, phone equivalent | Save / Just this once |
| "Set up next" (`src/dashboard/from-clem-setup.ts:31`) | fixed ordered list | From Clem pane | Open / Help me / Not now / Don't suggest |
| Noticing proposals (`src/agents/noticing.ts`) | heartbeat ledger | From Clem, Needs you | in words |
| Proactive offers (`src/runtime/proactive-offers.ts`: goal, space, skill, workflow, question) | none | **turn context only** (`src/agents/harness-context.ts:4`) | none |

The model suggestions of PR-03 need a door that is durable, shared by desktop and
phone, answerable by tap, that remembers "never for this", and that can apply a
typed settings change with undo. Rather than a fifth ad-hoc shape, this PR adds
the one record the others can move onto later. It changes none of them.

## Change

### 1. The record

`src/runtime/suggestions/suggestion-record.ts` (new):

```ts
export interface SuggestionV1 {
  version: 1;
  id: string;                         // sug-<digest of kind+subject+proposal>, so a repeat never duplicates
  kind: string;                       // 'model_role' | 'model_tryout' | 'provider_connect' | 'setting' | ... (open set, enum-whitelisted at projection)
  subject: string;                    // what it is about, e.g. 'role:judge', 'account:codex'
  words: { ask: string; why: string };// Clem's voice; machine detail folds under Details
  evidence: SuggestionEvidenceV1[];   // {label, value, source: 'scorecard'|'status'|'catalog'|'capability'|'event', ref?}
  proposal: SuggestionProposalV1;     // what a yes does, see §2
  createdAt: string; expiresAt?: string;
  state: 'open' | 'accepted' | 'snoozed' | 'declined' | 'never' | 'expired' | 'applied' | 'undone';
  decidedAt?: string; decidedOn?: 'desktop' | 'phone';
  followUp?: { afterTurns: number; dueAt?: string; result?: 'helped' | 'no_change' | 'worse' | 'unknown' };
}
```

Storage: `state/suggestions.json` written with the atomic tmp+rename helper
(`src/runtime/atomic-json.ts`), one owner, same pattern as `home-preferences.ts`.
Keep at most 200 records; expired and decided records older than 90 days are
pruned on write. A `never` decision is kept forever as a standing answer keyed by
`kind + subject` (the Noticing "never for this" rule), so the same kind of
suggestion is not raised again.

### 2. What a yes does

`SuggestionProposalV1` is one of:

- `{ type: 'settings', call: { method: 'PATCH', path: '/api/console/settings/models/roles', body: {...} }, undo: { ...the inverse call... } }`
  The path must be on an allowlist of existing settings endpoints (`settings/models/roles`,
  `settings/active-brain`, `settings/models/judge-fallback`, `settings/policy`,
  `settings/home`, …). Applying it calls the same handler the Settings UI calls
  (`persistModelRoleSetting` for roles), records the previous value as `undo`, and
  writes an `applied` state. It never bypasses a handler's own validation
  (`validateRoleModelBinding`).
- `{ type: 'turn', prompt: string }`: a yes starts an ordinary turn with this
  prompt in the origin conversation (Noticing's rule: she acts only on a yes,
  through an ordinary turn).
- `{ type: 'open', place: AppPlace }`: opens a place (`packages/chat-engine/src/app-places.ts`).
- `{ type: 'tryout', role, modelId, cap: { calls: number } }`: reserved for PR-13's
  model tryouts; refused as `unsupported` until that lands.

### 3. Lifecycle and routes

- `src/runtime/suggestions/suggestion-store.ts`: `raise(s)` (idempotent by id; a
  standing `never` for the kind+subject refuses), `decide(id, decision, surface)`,
  `apply(id)` (settings proposals), `undo(id)`, `list(state?)`, `dueFollowUps()`.
- Daily cap and quiet hours: reuse the Noticing boundaries (one open suggestion
  per kind at a time; at most 3 new suggestions a day across kinds; none in quiet
  hours) so Clem does not become a notification feed.
- Routes: `GET /api/console/suggestions`, `POST /api/console/suggestions/:id/decide`
  (`accept | snooze | decline | never`), `POST .../undo`; phone twins under `/m/api/`.
  Both check the proposal allowlist again at apply time.
- Events: `suggestion_raised`, `suggestion_decided`, `suggestion_applied`,
  `suggestion_undone` appended to the harness event log and added to the
  `public-presentation.ts` allowlist with enum-whitelisted fields (kind, subject,
  state, surface) and never the proposal body.
- Follow-up: when `followUp.afterTurns` turns have run since `applied`, a daemon
  tick (the heartbeat registry in `src/agents/heartbeats.ts:22`) computes a
  before/after from the PR-01 scorecard for the subject role and writes `result`.
  A `worse` result raises exactly one new suggestion: "Undo the change?".

### 4. One card, two apps

- `packages/chat-engine/src/suggestion-presentation.ts` (new): the card model.
  Ask (Clem's words), why, evidence lines, answers "Yes, do that" / "Not now" /
  "No" / "Never for this", Details (the exact settings call, folded), and after a
  yes the applied state with "Undo". A `turn` proposal's yes reads "Go ahead" and
  shows the prompt under Details.
- Desktop: `SuggestionCard` rendered in `FromClemPane.tsx` (where "Set up next"
  renders) and in Settings next to the thing it is about (PR-03 places the model
  ones). Needs you lists an open suggestion under its own small heading only when
  the owner opened it from a notification; suggestions are never counted in the
  Needs-you badge.
- Phone: the same card from the same presenter in the From Clem list and in the
  models sheet.
- Parity test: one fixture record renders the same words through the console
  component and the phone component (the two chat state machines are the known
  risk, README rule 10).

## Files

- new `src/runtime/suggestions/{suggestion-record,suggestion-store,suggestion-apply}.ts` + tests
- `src/dashboard/console-routes.ts`, `src/channels/mobile-routes.ts`
- `src/runtime/harness/public-presentation.ts` (four events)
- `src/agents/heartbeats.ts` (follow-up tick)
- new `packages/chat-engine/src/suggestion-presentation.ts` + test
- `apps/console-web/src/components/home/FromClemPane.tsx`, new `components/SuggestionCard.tsx`
- `apps/mobile-web/src/...` From Clem list, new `SuggestionCard`

## Tests

- Store: idempotent raise, `never` standing answer refuses a repeat, daily cap,
  quiet hours, prune, atomic write survives a torn file (keep the original bytes,
  as the recurring-ledger rule requires).
- Apply: a `settings` proposal calls the real handler with the real validation
  (an inactive model is refused and the suggestion stays open with the refusal in
  its words); `undo` restores the exact previous binding; a path off the allowlist
  is refused before any call.
- Follow-up: fixture scorecards before/after produce `helped | no_change | worse`;
  `worse` raises the single undo suggestion once.
- Projection: the four events pass the allowlist coverage test; proposal bodies
  never appear in a projected event.
- UI: console and phone render the fixture identically; Needs-you count unchanged
  by open suggestions; blank home shows nothing.

## Done when

A fixture suggestion raised by a test route appears as one card on desktop and
phone, a tap applies a role change through the same code path Settings uses,
Undo restores it, "Never for this" stops the kind for good, and with no
suggestions in the store every screen is byte-identical to main.

## Do not

- Do not migrate the worker-model offer, "Set up next" or Noticing onto this
  record in this PR; leave them untouched and list the migration under PR-13.
- Do not let a suggestion apply itself on expiry, on a timer, or on a follow-up.
- Do not store proposal bodies or evidence in the public event; ids and enums only.
- Do not add a browser-local store; the record is server-side for both surfaces.
