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
| `src/agents/autonomy-v2.test.ts` | 37 | `AgentDecisionSchema` validation, `buildPolicyText` per mode + allowed/blocked categories + check-in cadence, `categorizeToolForPolicy` + `filterToolsByPolicy` (composio gate, computer gate, both gates), `buildPolicyEvent` shape + data fields + JSON-serializability, `parseToolArguments` (JSON object / array / quoted string / non-JSON / empty / fallback), `looksLikeToolError` (Error/Failed prefix, common error vocabulary, HTTP codes, false positives ruled out) |

Total: **79 tests, ~1s runtime**.

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
