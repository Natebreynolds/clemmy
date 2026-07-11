I have full grounding across all facets. Here is the implementation spec.

---

# Build Spec — Composio Reliability Slice

## 1. Goal & design in a nutshell

**Goal:** kill the wrong-mailbox / "no connected account found" class that thrashes 15 calls when a user has multiple connections for one toolkit (the 3-Outlook-re-auth incident), and make the execute hot path snappy and self-healing — without ever silently sending from the wrong account.

**Design:**
- **Identity-based resolution.** Connection selection stops deferring to `user_id` on "more than one ACTIVE". It collapses same-mailbox re-auths into one identity (by normalized `accountEmail`), picks deterministically when there is exactly one distinct identity, and returns a three-valued outcome (`resolved | defer | ambiguous`) so genuinely-distinct mailboxes **ASK** instead of guessing.
- **Recall persists the email identity.** The tool-choice store learns the *stable email* an intent last used (never the volatile `ca_…` id). At execute time that email is the disambiguator: identity → current live `connectionId`.
- **SWR + self-heal hot path.** Drop pre-emptive `requireFresh` on the execute path (serve the connection snapshot instantly, revalidate in background), backstopped by a lazy self-heal that busts the cache and re-resolves once on a connection-not-found error.
- **`user_id` becomes an override, not a selector.** The dead auto-detect (SDK strips `user_id`) is deleted; `user_id` is codified as `configuredUserId()` override + `derivedComposioUserId()` creation entity only. The specific `connectedAccountId` (resolved by identity) decides the mailbox.

Ship in dependency order below. The resolution change (§2.B) and send-safety guards (§2.D) must land **together** — never ship identity-based auto-pick without the send-safety backstop. The SWR change (§2.E-1) must land **with** self-heal (§2.E-2).

---

## 2. Changes (grouped, ordered by dependency)

### A. Foundation (no deps)

**A1 — Capture `wordId`, keep the identity fields on `ConnectedToolkit`.**
`src/integrations/composio/client.ts` — `ConnectedToolkit` (73-83) and `refreshConnectedToolkits` mapping (790-800).
Add `wordId?: string` to the interface; populate it in the mapping from `str(item.wordId) ?? str(item.word_id)` (SDK preserves `word_id → wordId`, e.g. `gmail_red-castle`, index.mjs:1262). `accountEmail`/`createdAt` are already captured — no change. This gives the resolver both a human identity (email) and Composio's own stable disambiguation handle. Keep `authorizeToolkit`'s `allowMultiple:true` (client.ts:1109); add a comment that it is the source of the multi-connection state, making identity dedup mandatory.

**A2 — One shared junk-connection-id guard.**
Extract `export function isJunkConnectionId(v: unknown): boolean` (covers `['', 'null', 'undefined', 'none']` after `trim().toLowerCase()`) in `src/tools/composio-tools.ts`. Call it from `executeComposioTool` (client.ts:1487-1491) and `normalizeInlineConnectedAccountId` (composio-tools.ts:669-681). Delete the stale comment at client.ts:1486 that references `computer-tools.ts` (no such guard there) — point it at composio-tools.ts.

**A3 — One shared email normalizer.**
`normalizeEmail` (sender-verify.ts:37: `trim().toLowerCase().replace(/^smtp:/,'')`) is currently a private helper. Export it (or lift to a shared util) so the resolver, the recall store, and sender-verify all normalize identically. All identity comparisons use this.

### B. Resolution core — the root fix (depends on A1, A3)

**B1 — Rewrite `pickToolkitConnection` into an identity-layered, three-valued selector.**
`src/integrations/composio/client.ts:1569-1577`.

Introduce a new pure function returning a rich outcome, and keep the old `string | undefined` signature as a thin back-compat wrapper:

```
type ToolkitConnectionOutcome =
  | { kind: 'resolved'; connectionId: string }
  | { kind: 'defer' }                                   // 0 candidates → today's composio-default behavior
  | { kind: 'ambiguous'; candidates: DistinctIdentity[] } // N distinct mailboxes, no disambiguator
  | { kind: 'identity-absent'; want: string; candidates: DistinctIdentity[] } // recalled email no longer connected

DistinctIdentity = { email?: string; connectionId: string; wordId?: string }

selectToolkitConnection(toolSlug, conns, identityHint?): ToolkitConnectionOutcome
```

**Algorithm (explicit):**
1. **Canonical toolkit match** (fix the `startsWith` divergence). Match `c` when `toolkitOfSlug(toolSlug) === c.slug.toLowerCase()` **OR** `toolSlug.toLowerCase().startsWith(c.slug.toLowerCase() + '_')` **OR** `toolSlug.toLowerCase() === c.slug.toLowerCase()`. This handles underscore toolkit slugs (`one_drive`, `google_calendar`) that `toolkitOfSlug` truncates, and stops a bare-prefix slug (`google`) from matching an unrelated tool. Share this matcher with sender-verify/suppression so all layers select the same set.
2. `matched.isEmpty → { kind: 'defer' }`.
3. `liveish = matched.filter(isActiveish)` where `isActiveish = /active|enabled|initiat/i.test(status)` (reuse `isActiveConnectionStatus`). `liveish.isEmpty → { kind: 'defer' }` (matched but all inactive/initiated-never-completed).
4. **Same-identity dedupe.** Group `liveish` by `identityKey(c) = has('@', normalizeEmail(c.accountEmail)) ? normalizeEmail(c.accountEmail) : c.wordId ? 'word:'+c.wordId : 'conn:'+c.connectionId`. **Unknown-identity connections are NEVER merged** (each becomes its own group).
5. **Per-group representative:** sort by `activeTier ASC` (0 if `status.toUpperCase() ∈ {ACTIVE, ENABLED}`, else 1 for `initiat*`), then `createdAt DESC`, then `connectionId ASC`; take `[0]`. This makes "freshest genuine connection wins" while an in-flight re-auth (initiated, not active) **cannot** hijack a working connection.
6. `distinct` = one representative per group.
7. **Identity hint present:** find the group whose `identityKey === normalizeEmail(identityHint)`. Hit → `{ resolved, rep.connectionId }`. Miss → `{ identity-absent, want: identityHint, candidates: distinct }` (recalled mailbox no longer connected → must ASK, never fall through).
8. **No hint:** `distinct.length === 1 → { resolved }` (**this fixes the 3-re-auth bug**). `distinct.length > 1 → { ambiguous, candidates: distinct }`.

Back-compat wrapper: `pickToolkitConnection(toolSlug, conns)` = `selectToolkitConnection(...)` mapped `resolved→connectionId`, everything else `→ undefined`. Kill-switch env `CLEMMY_COMPOSIO_IDENTITY_RESOLVE=off` restores the old count-active branch.

**B2 — Thread `identityHint` + expose the rich outcome.**
`resolveToolkitConnectionId(toolSlug, identityHint?)` (client.ts:1559-1565) keeps its `string | undefined` return for existing callers, and gains a companion `resolveToolkitConnectionOutcome(toolSlug, identityHint?): ToolkitConnectionOutcome` that returns the full outcome. `executeComposioTool` (client.ts:1468) gains a 4th arg `preferredIdentity?: string` and forwards it. On an `ambiguous` / `identity-absent` outcome for a send, **do not** set `body.connectedAccountId` and dispatch under `userId` — return the ASK (see D). For reads, `ambiguous` may auto-pick the freshest representative but the output must state which mailbox was used.

### C. Recall persists the email identity (depends on A3; independent of B, wired in D)

**C1 — Add `accountIdentity?: string` to the choice shape.**
`src/memory/tool-choice-store.ts` — `ToolChoiceRecordChoice` (35-56) and `RememberToolChoiceInput.choice` (77-85). Meaningful only for `kind:'composio'`; the normalized email, never a `ca_` id. Serializes only when present (`stripUndefined` at 214/219 already drops absent keys → all ~50 legacy files round-trip byte-identical).

**C2 — Parse-time guard.**
`parseChoice` (144-173): read `accountIdentity` only if it looks like an email — reject anything matching `/^ca_/i` or lacking `'@'`; normalize the rest via `normalizeEmail`; junk → `undefined`. Mirrors the `placeholderChoiceString` discipline. This blocks a confused/hostile caller from re-smuggling a volatile `ca_`.

**C3 — Carry-forward on re-remember + validate.**
`rememberToolChoice` (395-449): validate `input.choice.accountIdentity` the same way, and add `accountIdentity` to the `samePath` carry-forward spread (431-438) so re-validating the same slug keeps the learned mailbox (a new valid email still overrides). The failed/blocked write-back path (398-418) already preserves the existing choice, so identity survives there too.

**C4 — Capture on successful execute, from the resolved connection (zero new round-trip).**
`maybeAutoRememberComposioChoice` (composio-tools.ts:505-585), called at 915 where `effectiveConnectionId` is in scope. Pass `effectiveConnectionId` into it. When it is **known** (explicit pin, sender-verify route, calendar route, or a single-distinct-identity resolve) AND the toolkit currently has `>1` connection, look up its `accountEmail` from the already-cached `listUsableConnectedToolkits()` and set `choice.accountIdentity`. **Do NOT capture** when the connection is genuinely ambiguous (that case must ASK, not silently learn a guess) or when the toolkit has a single connection (byte-identical, never pinned). Zero network calls (SWR cache in hand).

**C5 — Carry identity through the discovery short-circuit.**
`RememberedComposioMatch` (969-979) + `recallComposioForSearch` (1002-1061): add `accountIdentity?: string`, populate from `c.accountIdentity`. In the `bySlug` aggregation, keep an identity **only when all non-empty fragments agree**; on disagreement drop it (leave `undefined`) so the consumer treats it as ambiguous → ASK. Consumer at composio-tools.ts:1335-1356 passes the identity into execute alongside the slug.

**C6 — Surface the mailbox in injected context (SHOULD).**
`renderToolChoicesForContext` (~1350-1362): when `choice.accountIdentity` is present, append a compact `@<email>` marker to the line (e.g. `- send weekly update: composio:OUTLOOK_SEND_MAIL @pg-test@… ✓3`), respecting `TOOL_CHOICE_LINE_MAX=160`. Absent → line unchanged. Gives the model a visible signal to reason about identity / know when to ASK.

### D. Wire recall → resolver, with send-safety (depends on B, C) — MUST land with B

**D1 — Pass the recalled identity into execute.**
`runComposioExecute` (composio-tools.ts:830-907): when the caller didn't pin a connection, peek the recalled choice for the intent and thread its `accountIdentity` as `preferredIdentity` into the execute path.

**D2 — Design-guard: identity-resolved connection MUST arrive as `explicitConnectionId` BEFORE the gate.**
The identity resolver's chosen `connectionId` must be injected as `connected_account_id` (via `normalizeInlineConnectedAccountId`, composio-tools.ts:836) **before** `enforceStandingConstraints` (840), so `resolveCompliantSenderConnection` does a real `OUTLOOK_GET_PROFILE` on it and blocks on mismatch. **Explicitly forbid** the post-gate `effectiveConnectionId`-assignment pattern (the calendar-read template at 844-850) for send slugs — that bypasses sender-verify.

**D3 — Close the FORWARD/REPLY hole in the constraint gate.**
`findEmailSendConstraint` (constraint-guard.ts:83-101): replace `if (!slug.includes('send') && !slug.includes('draft')) return null;` with `if (!isIrreversibleSendSlug(toolSlug)) return null;` (import from `execution-gate.ts`). `IRREVERSIBLE_SEND_VERBS` already covers `FORWARD`/`REPLY` and correctly keeps `CREATE_*_DRAFT` reversible while catching `SEND_DRAFT`. Unifies send detection on the single chokepoint predicate.

**D4 — Generic multi-account send backstop (no standing constraint).**
Today `resolveCompliantSenderConnection` only runs when `findEmailSendConstraint` returns a rule; a user with no "send only from X" rule falls to the buggy generic path. For a send-classified `toolSlug` (`isIrreversibleSendSlug`) with `≥2` distinct mailboxes and no verified `preferredIdentity`, return `ambiguous → ASK` (list the distinct `accountEmail`s), never dispatch under `user_id`. Where `preferredIdentity` is set, verify it: probe the chosen connection's real mailbox and confirm it equals the recalled email; dispatch only on match, block on mismatch/unverifiable. Keep it SWR/cached (one profile call per connection per 10 min, `CACHE_TTL_MS`) — no per-call round-trip. **Do not** add a profile round-trip on the generic *read* path.

**D5 — Generalize the profile probe beyond Outlook (SHOULD).**
`resolveCompliantSenderConnection` / `verifyOutlookSender` (sender-verify.ts:245-254, 96-168) hard-block non-`OUTLOOK`. Map `toolkit → (profileSlug, mailboxExtractor)` — `GMAIL_GET_PROFILE`, etc. Where no profile slug exists and `≥2` accounts connect, ASK rather than pick. Keep the provider-agnostic `extractMailboxEmails` JSON-scan fallback. Fixes both the Gmail-has-no-check gap and the Gmail-constraint-over-blocks-everything bug.

**D6 — Route Space action sends through the gate (SHOULD).**
`runSpaceAction` (spaces/runner.ts:100-114) calls `executeComposioTool` directly, bypassing `enforceStandingConstraints` and `normalizeInlineConnectedAccountId`. Route its composio dispatch through `runComposioExecute` (or a shared `constraint+identity gate` extracted from it) so Space sends get the same sender gate and can pin a connection correctly.

**D7 — Override cannot launder a recall pick (NICE).**
`enforceStandingConstraints` (626-655): when `sender_override_confirmed` is set AND the connection was supplied by the identity resolver (not the caller/model), still run one profile lookup and log the resolved mailbox, so an override can never dispatch from a silently recall-injected account the user never named.

### E. Snappiness + self-heal (ship E-1 and E-2 together)

**E1 — Serve the connection snapshot SWR-instant on the execute path.**
`src/integrations/composio/client.ts`: change `resolveToolkitConnectionId`'s `listUsableConnectedToolkits({ requireFresh:true })` (1561) to the default SWR (`requireFresh:false`) so it serves the cached snapshot instantly and revalidates in background. (The `getPreferredUserId({requireFresh:true})` at 1478 is removed entirely by §F.) Update the stale banner comment at 825-826 to reflect the new SWR+self-heal contract. Kill-switch `CLEMMY_COMPOSIO_CONN_SWR=off`.

**E2 — Connection-error self-heal (the backstop that makes E1 safe).**
`executeComposioTool` catch block (client.ts:1528-1547): before throwing `ComposioReconnectRequiredError`, add a single guarded self-heal, gated on: `pinnedAccountId === undefined` (we picked the connection, possibly from a stale snapshot), the error matches the connection-not-found class (`RECONNECT_REQUIRED_RE` / `isComposioReconnectRequiredError` + `no connected account found`), and `!retriedSelfHeal`. Then: call `invalidateConnectedAccountSnapshot()`, re-run `resolveToolkitConnectionId(toolSlug, identityHint)` (now fetches fresh), and if it yields a **different** `connectionId`, re-issue `tools.execute` once with it. If the retry fails or resolves to the same/no id, throw as today. At most one extra round-trip; never fires on a user-pinned account. This is strictly more correct than `requireFresh` for sub-60s connection changes.

**E3 — Cache `getComposioCliStatus` (SHOULD).**
`executeComposioTool` CLI branch (1493-1512) calls `getComposioCliStatus` unconditionally in `auto` mode; when the CLI binary exists but isn't authenticated it spawns **two subprocesses per execute** (`--version` + `whoami`, cli.ts:204-205). Wrap it in a short-TTL (~30-60s) memo keyed by resolved `cliOptions` (busted on `saveComposioExecutionBackend`/`resetComposioClient`), or short-circuit to the SDK path once observed not-authenticated. No behavior change for authenticated CLI users.

### F. Self-heal breaker + suppression (depends on B)

**F1 — Classify 1810 as a hard-auth failure.**
`src/agents/composio-connection-suppression.ts`: add `'not-connected'` to `ComposioConnectionSuppressionReason` (line 7) with a backoff schedule (reuse `EXPIRED_BACKOFF_MS`); add a third branch to `classifyHardAuthFailure` (100-110) matching `/ConnectedAccountNotFound|no connected account|ToolRouterV2[_-]?NoActiveConnection|NoActiveConnection|code['"]?\s*:?\s*1810/i`. **Only** let `suppressConnectionAfterHardAuthFailure` fire when a concrete `connectionId` is blamed (pinned/single-active) — an ambiguous multi-active 1810 must NOT quarantine an account.

**F2 — Cross-call session+toolkit reconnect breaker.**
`src/tools/composio-tools.ts`: module-level `Map<sessionId, Map<toolkit, {count, firstAt}>>`, keyed by **toolkit** (not connectionId, so it fires even when no connection resolved — the incident's `effectiveConnectionId` was `undefined`, so `suppressComposioConnectionAfterHardFailure` short-returned `''`). Increment in the `isComposioReconnectRequiredError` catch (1072). At the **top** of `runComposioExecute` (before the network call at 907): if the breaker for `(sid, toolkitOfSlug(toolSlug))` already recorded `≥1` confirmed reconnect-required this session, short-circuit deterministically with one clear corrective and skip the round-trip — so attempts #2..#15 cost nothing. Skip the short-circuit when the caller pins a **different** usable connection. Clear the breaker on `invalidateConnectedAccountSnapshot()`/`clearConnectedToolkitsCache()` (called on authorize/disconnect/reset) plus a short TTL and kill-switch `CLEMMY_COMPOSIO_RECONNECT_BREAKER=off`.

**F3 — Corrective ASKs on the multi-active case (SHOULD).**
`composioFailureCorrective` notConnected branch (composio-tools.ts:271-277) and `ComposioReconnectRequiredError` message (client.ts:362-372) always say "reconnect X" — misleading and send-unsafe when the real cause is `>1` ACTIVE connection. On breaker trip, branch on live shape via `listUsableConnectedToolkits()` filtered to the toolkit: `0 usable` → keep "reconnect X once"; `>1 ACTIVE, none pinned/identity-resolved` → emit an ASK listing candidate `accountEmail`/`accountLabel` values ("you have N accounts connected — which mailbox?"). Deterministic, no send.

### G. `user_id` cleanup (independent; do after F to avoid churn overlap)

**G1 — Delete dead auto-detect.**
`preferredUserIdFromConnectedAccounts` (client.ts:688-697) can never return a value — the `@composio/core` 0.10 SDK transform strips `user_id` (`ConnectedAccountRetrieveResponseSchema` is a plain `z.object` with no `user_id`; index.d.mts:575 documents the omission). Delete it, the `preferredUserId` field on `connectionsCache` (250), its assignment in `refreshConnectedToolkits` (808), the `legacyDetected` branch in `getPreferredUserId` (703-704), and the `__test__` export (1706). Fix the now-stale comments at 607-609, 665-668, 1474-1477.

**G2 — Collapse `getPreferredUserId` to a pure local resolve.**
`getPreferredUserId` (699-705) becomes: `const explicit = configuredUserId(); if (explicit) return explicit; return persistResolvedComposioUserId(derivedComposioUserId());` — no `await`, no network, drop the `{ requireFresh }` param. Simplify the four call sites (1095, 1267, 1478, 1583) to `getPreferredUserId()`. Account resolution still happens once per execute via `resolveToolkitConnectionId`'s own fetch.

**G3 — Codify `user_id`'s role in docstring/comments.**
Document at `getPreferredUserId` and client.ts:1474-1477: `user_id` = `configuredUserId()` (advanced per-org override via `COMPOSIO_USER_ID`) + `derivedComposioUserId()` (`clementine-<machine>`, the entity Clem creates connections under and the `tools.execute` fallback). It is **never** the mailbox selector — the identity-resolved `connectedAccountId` decides the mailbox. Do **not** read the deprecated raw v3 `user_id`.

**G4 — Stale-override advisory (SHOULD).**
Do not auto-delete a user-set `COMPOSIO_USER_ID`. In the Connect/status surface (`buildComposioDashboardSnapshot`): if `configuredUserId() !== derived` AND connections exist, note that `user_id` no longer selects accounts (identity does) so the override is advisory only. `setup.ts` already guards `'default'` (114-116, 369) — no change there.

---

## 3. Send-safety invariants (MUST-NOT-REGRESS)

1. A constrained Outlook send whose identity-injected connection **disagrees** with the standing rule is still **blocked** by sender-verify (identity pick arrives as `explicitConnectionId` **before** the gate — D2). Never post-gate assignment for sends.
2. `OUTLOOK_FORWARD_MAIL` / reply-send slugs are treated as sends by the constraint gate (D3).
3. An unconstrained multi-account send (`≥2` connections) with **no verified** recalled identity **ASKs** — never a silent pick, never falls to the `user_id` default (D4).
4. A recalled identity whose mailbox is **no longer connected** ASKs (`identity-absent` outcome) — never falls to default (B1 step 7).
5. Space action sends go through the same constraint/identity gate as agent sends (D6).
6. Recall stores the **email only** — never a `ca_` id (C1/C2). `stripBakedConnectionId` behavior unchanged.
7. **Reads** may auto-pick the freshest representative but must surface which mailbox was used; **sends** must ASK when ambiguous.
8. `sender_override_confirmed` cannot dispatch from a silently recall-injected account without logging the resolved mailbox (D7).

---

## 4. Test plan

**Resolution (`client.test.ts` — update the existing 98-123 case; it currently enshrines the bug):**
- 3 conns, same `accountEmail`, differing `createdAt` → `resolved` = the **freshest ACTIVE** connectionId (the reported bug).
- 3 conns same email where the freshest is `INITIATED` and an older one is `ACTIVE` → resolves to the ACTIVE one (active-tier beats createdAt).
- 2 conns, distinct emails, no hint → `ambiguous` listing both.
- Same, with `identityHint` matching one email → `resolved` = that connection.
- `identityHint` matching **none** of the live emails → `identity-absent` (ASK), not a wrong pick.
- 2 conns with `accountEmail` undefined → each its own identity → `ambiguous`, never merged.
- All matched conns `INITIATED`-only/inactive → `defer`.
- Canonical matcher: `ONE_DRIVE_UPLOAD_FILE` matches conn slug `one_drive`; a `google` conn does **not** match a `GOOGLEDRIVE_*` tool.

**Recall (`tool-choice-store.test.ts` — new; grep shows no `accountIdentity` coverage):**
- `rememberToolChoice` persists a valid email; rejects a `ca_…`/non-email value → `undefined`.
- Legacy file with no `accountIdentity` round-trips byte-identical.
- `samePath` re-remember carries identity forward; a new valid email overrides.
- `parseChoice` normalizes and guards.
- `recallComposioForSearch` drops identity when fragments disagree, keeps it when they agree.

**Capture gate (`composio-tools.test.ts`):**
- Successful execute on a `>1`-connection toolkit with a resolved connection → `accountIdentity` captured.
- Single-connection toolkit → **not** captured (byte-identical).
- Genuinely ambiguous (`>1` ACTIVE, none pinned) → **not** captured.

**Send-safety (`sender-verify.test.ts`, `constraint-guard.test.ts`, new `runComposioExecute` integration test with stubbed `fetchProfile`):**
- `findEmailSendConstraint` returns non-null for `OUTLOOK_FORWARD_MAIL`/reply slugs.
- Identity-injected connection that mismatches a standing constraint → sender-verify block.
- Multi-account, no constraint, no verified identity → ASK / undefined-route (not a silent pick).
- `runSpaceAction` send routes through the gate.

**Snappiness / self-heal:**
- Hot-path resolve serves a cached snapshot without a fresh fetch (spy on `connectedAccounts.list`, assert not called when cache warm).
- Self-heal: stubbed `executeComposioTool` throws 1810 once for a non-pinned call, re-resolve yields a different connectionId → retried once and succeeds; spy shows exactly one invalidate + one retry.
- `classifyHardAuthFailure` returns `'not-connected'` for code 1810 / `ToolRouterV2_NoActiveConnection`.
- Breaker: two same-toolkit executes that both throw 1810 → the 2nd short-circuits **without** invoking the executor (spy call count == 1); breaker clears after `invalidateConnectedAccountSnapshot()`.
- With 3 ACTIVE connections, the corrective **asks which mailbox** (lists `accountEmail`) instead of "reconnect".

**Cleanup:**
- Remove the false-green `client-user-routing.test.ts:65-91` "legacy API user ids still win" test + the two direct `preferredUserIdFromConnectedAccounts` assertions (they mock **below** the SDK transform that strips `user_id`). Keep the "one stable non-default machine user" test; optionally add a positive test that an SDK-shaped list (no `user_id`) yields `clementine-<machine>` and persists it.

---

## 5. Migration / back-compat / cleanup

- **Byte-identical legacy files.** `accountIdentity` is optional and dropped by `stripUndefined`, so all ~50 existing tool-choice files parse and re-serialize unchanged (same guarantee the outcome counters rely on).
- **No-identity legacy choices** behave exactly as today (unambiguous-only resolve; no regression).
- **`ca_` never re-smuggled** — parse-time + write-time email guard.
- **Kill-switches (default ON):** `CLEMMY_COMPOSIO_IDENTITY_RESOLVE`, `CLEMMY_COMPOSIO_CONN_SWR`, `CLEMMY_COMPOSIO_RECONNECT_BREAKER`. No rollout flags — validated behavior is the default.
- **Fold-in cleanups:** delete dead `preferredUserIdFromConnectedAccounts` + `connectionsCache.preferredUserId` (G1); centralize `isJunkConnectionId` (A2); fix the wrong `computer-tools.ts` comment; delete the false-green routing test (§4); update stale comments at client.ts:607-609, 665-668, 825-826, 1474-1477.
- **Do NOT touch:** connection creation `user_id` (already consistent), `allowMultiple:true`, `connectionsInflight` dedup, `swrFetch`, `stripBakedConnectionId`, `setup.ts` 'default' guard.

---

## 6. Cut line

**MUST (core reliability — ship as one unit):**
- A1, A3 (identity fields + normalizer)
- B1, B2 (identity-layered resolver + threading) — *the root fix*
- C1–C5 (recall persists + carries the email)
- D1–D4 (wire recall→resolver; FORWARD/REPLY gate; generic multi-account backstop; before-gate injection)
- E1 + E2 (SWR **and** self-heal — never one without the other)
- F1, F2 (1810 classified + cross-call breaker) — *stops the 15-call thrash*
- G1, G2, G3 (delete dead auto-detect; collapse `getPreferredUserId`; codify role)
- Tests: the resolution cases, recall round-trip, capture gate, self-heal-on-1810, and the send-safety invariants.

**SHOULD (hardening / breadth):**
- A2 (junk-id centralize), C6 (context `@email` marker)
- D5 (per-toolkit profile probe — Gmail), D6 (Space action gate)
- E3 (cache `getComposioCliStatus`)
- F3 (ASK corrective on multi-active)
- G4 (stale-override advisory)
- The FORWARD-under-constraint and Space-send regression tests.

**NICE (defense-in-depth):**
- A1 `wordId` as a secondary identity key
- D7 (override cannot launder a recall pick)

Ship MUST as a coherent slice (resolution + recall + send-safety + SWR/self-heal + breaker + user_id cleanup are interlocking — B without D is send-unsafe, E1 without E2 is correctness-unsafe). SHOULD/NICE can follow incrementally without reopening the core.