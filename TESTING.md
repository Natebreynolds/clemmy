# Testing

clementine-next uses Node's built-in `node:test` runner via `tsx` — no
new dependencies, no config files. Tests live as `*.test.ts` files
alongside the source they cover.

## Run everything

```bash
npx tsx --test src/**/*.test.ts
```

(Or scope to a single module while iterating:
`npx tsx --test src/memory/recall.test.ts`)

## What's covered

| Module | Tests | Focus |
|---|---|---|
| `src/memory/embeddings.test.ts` | 7 | `vectorToBuffer` / `bufferToVector` roundtrip, `cosine` math edge cases (identical, orthogonal, antiparallel, zero, mismatched lengths) |
| `src/memory/recall.test.ts` | 7 | `buildFtsQuery` escaping — quoted tokens, prefix variants, dedup, FTS5-reserved char stripping, case normalization, underscore-safe |
| `src/memory/facts.test.ts` | 8 | `rememberFact` dedup (whitespace + case), distinct kinds, soft + hard delete, render ordering, score-bumping list order |
| `src/agents/autonomy-guardrails.test.ts` | 11 | every guardrail's pass and trip cases |
| `src/agents/run-tracking.test.ts` | 9 | start / record / finish lifecycle, list filtering, slug extraction |
| `src/agents/autonomy-v2.test.ts` | 44 | `AgentDecisionSchema` validation, `buildPolicyText` per mode + allowed/blocked categories + check-in cadence, `categorizeToolForPolicy` + `filterToolsByPolicy`, `buildPolicyEvent` shape + data fields + JSON-serializability, `parseToolArguments` (JSON object / array / quoted string / non-JSON / empty / fallback), `looksLikeToolError` (vocabulary, HTTP codes, false positives), `chooseFollowUpMinutes` (agent pick wins, floor at 5, hands_on=base, balanced=2x, watch=3x with 15-min floor, 60-min cap) |
| `src/agents/check-ins.test.ts` | 17 | `createCheckIn` write + persistence + validation, `getCheckIn` / `listCheckIns` filters + sort, `answerCheckIn` lifecycle + inbox enqueue + idempotency, `closeCheckIn` lifecycle, `renderOpenCheckInsForAgent` for the agent input, deletion + status='all' filtering |
| `src/runtime/user-profile.test.ts` | 15 | `loadUserProfile` defaults, `saveUserProfile` persistence + partial-patch behavior + updatedAt advance, `normalizeUserProfile` validation (tone / formality / urgency / working hours format / workingDays type-filter / notes clamp), `renderProfileForInstructions` per-tone / per-formality / per-urgency guidance + working hours + preferred name |

Total: **118 tests, ~1.4s runtime**.

## Adding tests

- Mirror the file path: `foo/bar.ts` → `foo/bar.test.ts`
- Use `node:test` API: `import { test, before, beforeEach } from 'node:test'`
- Assertions: `import assert from 'node:assert/strict'`
- For tests that touch the SQLite memory DB, set `CLEMENTINE_HOME` to
  `/tmp/<unique-name>` BEFORE importing the modules under test (see
  `src/memory/facts.test.ts` for the pattern). The `before` hook then
  cleans + recreates the dir; `beforeEach` resets the DB.

## Why not vitest?

We could. Node's built-in runner gets us 95% of the way with zero
dependencies. If the project later adopts vitest, every test file
ports verbatim — the assertion API is identical.
