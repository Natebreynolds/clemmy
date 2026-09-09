# Release scorecard — maintained by the implementation owner

Status key: **implemented** · **unit-proven** · **live-proven** · **failed** · **blocked** · **not run**

## 1. Accepted mutation scope (final handoff priority 1)
| Requirement | Status |
| --- | --- |
| Scope not derived from the proposed call | implemented · unit-proven · live-proven |
| CREATE-existing → duplicate → unrequested patch REFUSED | live-proven (143075, artifact byte-identical) |
| Explicit Normal edit makes exactly one correct write | live-proven (143239, full assertion set) |
| Same-source create→edit lineage allowed | implemented · **not run** (needs a live same-source journey) |
| Owner amendment re-opens scope | unit-proven |
| Mixed create/update jobs preserved | unit-proven |

## 2. Continuation ownership
| Requirement | Status |
| --- | --- |
| Ownership claimed before adoption | implemented · unit-proven |
| Failed claim stops adoption, checkpoint intact | implemented · unit-proven |
| Responsibility released on typed terminal | implemented · unit-proven · live-proven |
| Post-restart resume completes the work | live-proven (C34 785ee2ea) |
| Held-window ownership | **not run** live |
| `continuationsUsed:0` counters across adoption | **failed** (open) |
| One owner between timer and immediate continuation | **not run** |
| Approval-resume held result | **not run** |
| child_lease_activation_failed class retired | **failed** — still reproduces under an activated Plan |

## 3. Native contracts and exact Plan revision/Execute
| Requirement | Status |
| --- | --- |
| Duplicate non-write through the real adapter | live-proven |
| Unsafe-retry regression removed | unit-proven (13 reviewer controls) |
| Five schema carriers audited | **not run** |
| Exact-slug authoritative reads | **not run** |
| Native reads in compound work | **not run** |
| `workspace_list` discovery | **not run** |
| Plan → one-field revision → exact Execute | **not run** |

## 4. Learning / review continuity and integration
| Requirement | Status |
| --- | --- |
| Cold recall frontier + assistant answer | unit-proven (4/4) |
| Effective objective carries adopted steering to the judge | live-proven |
| producer→persistence→reopen→learning | **not run** |
| Owner-selected judge provenance in production callers | **not run** |
| Usage/request linkage | **not run** |
| UI integration checklist | **not run** |
| Combined-candidate build + render qualification | **not run** |
| Repository release checks (npm test, journeys, packaging…) | **not run** |
| Sheets → Salesforce → SCO journey | **blocked** — needs owner input on sheet/accounts/SCO source |

## 5. Cross-family qualification — Grok 4.6 brain / Grok workers / Opus 5 judge
| Requirement | Status |
| --- | --- |
| BYO brain actually routes to grok-4.6 | live-proven (`turn_model_routed` model=grok-4.6 provider=byo mode=all_in) |
| Workers pinned to grok-4.6 | implemented (role resolves byo; no fan-out run yet — **not run**) |
| Judge actually runs on claude-opus-5 | live-proven (verdict `judgeModelId: claude-opus-5`, `ownerSelectedJudge: true`, no substitution/fail-open flags) |
| Accepted mutation scope holds under a different brain family | live-proven (143398 — artifact unchanged, no update settlement) |
| Typed non-write carries under a different brain family | live-proven (143398 — `host_reported:duplicate`) |
| Explicit edit makes exactly one write under Grok | live-proven (143459 — full assertion set, content preserved) |
| `continuationsUsed: 0` | **failed** — still 0 in the Grok verdict |

Config for this qualification (preimage preserved at
`output/candidate35-live/grok/roles.preimage.env`): `AUTH_MODE=api_key`,
`MODEL_ROUTING_MODE=all_in`, `BYO_BRAIN_MODEL_ID=grok-4.6`, roles
worker=grok-4.6 / judge=claude-opus-5.

**Billing (corrected):** the xAI provider carries NO typed API key
(`getByoProviderApiKey('xai')` = empty), so `providerCredential` falls through to
the stored xAI OAuth access token — the owner's **subscription**. The backend is
`oauthBacked` and carries a `refreshBearer` that resolves a fresh bearer per
request, which is why the grant silently renewed (expiry moved 09-05 -> 09-07
11:32) mid-campaign. An earlier note in this scorecard called this an API-key
charge; that was wrong.

**Release: NOT QUALIFIED.**
