# Clementine active configuration — 2026-09-19

This is a dated observation, not permanent configuration truth. Read the running daemon again before subsequent tests or changes. Secrets and credential hashes are deliberately excluded. The local structured evidence is `output/weekend-harness-2026-09-19/active-settings-audit.json`.

## User instructions and corrections

- Start from the other active agent's actual branch and checkout; do not duplicate its work. On this date this is `~/clementine-next`, branch `main`, HEAD `e5a75f5a`, with shared uncommitted changes. Preserve the user's existing usage-sidecar work.
- Acceptance means hotpatching and testing the installed app against the live `~/.clementine-next` home. Isolated-home success is not live acceptance. Never run destructive fixture resets against the live home.
- Goals: reliable completion, speed, token efficiency, durable useful memory, long-running agent work, and understandable desktop/mobile UI. Compare matched models/tasks/tools and distinguish cold, warm, and memory-assisted runs.
- Inspect actual active configuration before diagnosing. Claude uses Clementine-owned authentication. A standalone CLI login failure does NOT prove Clem Claude authentication is unavailable.
- Claude is authorized for validation. Verify the actual served provider/model; a requested Claude model that executes on Codex is not Claude validation.
- User explicitly requested saving this context to memory on 2026-09-19.

## Verified runtime and configuration

| Setting | Observed value |
|---|---|
| Installed app | `~/Applications/Clementine.app` |
| Live home | `~/.clementine-next` |
| Version | `3.18.17` |
| Running source fingerprint | `6e15d3ac247a394e247f990399a7de7e854d22b20ba166c54f2146ca47e4dcab` |
| Schema | `81/81` |
| Active authentication | `codex_oauth` |
| Brain | `gpt-5.6-terra` |
| Worker role | `gpt-5.6-luna` |
| Completion judge | `gpt-5.6-sol` |
| Completion review | `True` |
| Claude provider selection | `claude-opus-5` |
| Claude SDK mode | `full` |
| Claude transport preference | `headless` |
| Router mode | `off` |
| Debate mode | `off` |
| Proactive work allowed | `False` |

## Authentication and routing findings

Claude credential ownership and execution transport are different things. `getStoredClaudeTokens()` prefers Clem's `state/claude-auth.json` vault. `buildClaudeHeadlessEnv()` obtains that credential through `loadFreshClaudeAccessToken()` and injects it as `CLAUDE_CODE_OAUTH_TOKEN`; the Agent SDK uses that builder too. The fact a CLI binary is used internally does not mean the standalone CLI login is the authentication authority. Tool-bearing requests can use the raw Messages adapter with the same subscription credential.

The actual running `/api/console/settings` reports `claudeAuth.configured=false`, source `vault`, and a dead grant marker. Secret-free file inspection confirms the current stored access token expires July 3, 2026 and its refresh token matches the dead marker dated July 9. Meanwhile the same endpoint reports `fusion.brainsAvailable.claude=true` and the UI says connected. `judge-family.ts::claudeAvailable()` returns true for any present refresh token without checking the dead marker. These are contradictory status semantics. No new provider validation of this grant was performed in this audit; do not invent a fresh provider rejection or ask for CLI login as a substitute. No credentials or markers were modified.

The previous Claude-requested smoke response explicitly reported effective model Terra. It did not validate Claude. Its routing cause is not yet established; do not label it an authentication fallback without tracing the accepted route.

Stored role bindings include an inactive Grok 4.6 brain binding. The runtime says brain selection is controlled through active-brain settings, so Terra is effective. Worker role resolves to Luna despite `OPENAI_MODEL_WORKER=Terra`. Completion judge is explicitly Sol despite cross-family preference being on. Saved settings alone are insufficient evidence of execution.

Codex is authenticated through native credentials, independently of CLI auth. Its actual account report and fresh Clem response both showed 1% used. Fixed `rate-limit-store.ts` multiplying 1 percent into 100, which falsely denied judge availability. The installed quota fix is fingerprinted above. Two live local arithmetic turns returned 323 with `failedOpen=false`, `selfJudge=true`; these are Codex smoke tests only. Broader scenario qualification remains open.

## Runtime budget

```json
{
  "preset": "unlimited",
  "maxConversationSteps": 1000000,
  "maxConversationWallMinutes": 0,
  "maxConversationWallMs": 0,
  "maxTurns": 500,
  "toolCallsPerTurn": 64,
  "maxParallelWorkers": 12,
  "checkInMinutes": 3,
  "autoContinueOnLimit": true,
  "maxRunTokens": 0,
  "unlimited": true
}
```

## Proactivity policy

```json
{
  "policy": {
    "enabled": false,
    "mode": "balanced",
    "autoApproveScope": "yolo",
    "checkInMinutes": 3,
    "briefCadenceMinutes": 60,
    "defaultLongTaskMinutes": 90,
    "maxConcurrentBackgroundTasks": 1,
    "batchConfirmThreshold": 5,
    "inboxWatchEnabled": true,
    "inboxWatchMinutes": 15,
    "inboxWatchMax": 5,
    "calendarWatchEnabled": true,
    "calendarWatchMinutes": 30,
    "calendarWatchMax": 5,
    "quietHoursEnabled": false,
    "quietHoursStart": "22:00",
    "quietHoursEnd": "08:00",
    "allowDiscordCheckIns": true,
    "allowComposioActions": true,
    "allowComputerActions": true,
    "requireWorkflowApprovalForExecution": true,
    "updatedAt": "2026-08-15T15:11:28.622Z"
  },
  "quietHoursActive": false,
  "proactiveWorkAllowed": false
}
```

## Memory status

```json
{
  "dbPath": "/Users/nathan.reynolds/.clementine-next/state/memory.db",
  "dbPresent": true,
  "dbBytes": 128557056,
  "indexedFiles": 555,
  "chunks": 2440,
  "activeFacts": 982,
  "totalFacts": 3629,
  "embeddingsEnabled": true,
  "embeddingsCount": 2440,
  "embeddingsModel": "text-embedding-3-small",
  "embeddingsDim": 1536,
  "embeddingsCoverage": 1,
  "lastIndexedSourceMtime": 1789832988781
}
```

## Additional configured providers

- GLM (Z.ai): configured=True, 11 listed models.
- Together AI: configured=True, 186 listed models.
- Moonshot (Kimi) — Platform API: configured=True, 4 listed models.
- xAI (Grok): configured=True, 12 listed models.

## Explicit environment configuration

Values below are non-secret configuration, read from the live home file. Process overrides and effective endpoint settings take precedence.

```json
{
  "AUTH_MODE": "codex_oauth",
  "CLAUDE_MODEL": "claude-opus-5",
  "CLEMMY_CHAT_CONVERSE": "on",
  "CLEMMY_CLAUDE_AGENT_SDK_BRAIN": "full",
  "CLEMMY_CLAUDE_SDK_STREAMING": "on",
  "CLEMMY_CLAUDE_TRANSPORT": "headless",
  "CLEMMY_CONFIRM_FIRST": "on",
  "CLEMMY_DEBATE_JUDGE": "codex",
  "CLEMMY_DEBATE_MODE": "off",
  "CLEMMY_DEV_MODE": "off",
  "CLEMMY_FUSION_STRATEGY": "verify",
  "CLEMMY_JUDGE_CROSS_FAMILY": "on",
  "CLEMMY_MCP_PREWARM": "off",
  "CLEMMY_MODEL_ROLES": "[{\"role\":\"brain\",\"modelId\":\"grok-4.6\",\"scope\":\"durable\",\"source\":\"settings\"},{\"role\":\"worker\",\"modelId\":\"gpt-5.6-luna\",\"scope\":\"durable\",\"source\":\"settings\"},{\"role\":\"judge\",\"modelId\":\"gpt-5.6-sol\",\"scope\":\"durable\",\"source\":\"settings\"}]",
  "CLEMMY_PLAN_CONTINUITY": "on",
  "CLEMMY_SAVED_CLIS": "ffmpeg,higgsfield,sf",
  "CLEMMY_SOURCE_MAP": "on",
  "CLEMMY_TOOL_GUARDRAIL": "warn",
  "CLEMMY_TOOL_JIT": "on",
  "CLEMMY_WATCHER_INTERVAL_TOOLS": "4",
  "CLEMMY_WATCHER_JUDGE": "on",
  "CLEMMY_WATCHER_WORKFLOW_INTERVAL_STEPS": "2",
  "CLEMMY_WORKER_MAX_CONCURRENCY": "12",
  "CLEMMY_WORKFLOW_WATCHER_JUDGE": "on",
  "HARNESS_AUTO_CONTINUE_ON_LIMIT": "true",
  "HARNESS_BUDGET_PRESET": "unlimited",
  "HARNESS_CHECK_IN_MINUTES": "3",
  "HARNESS_MAX_CONVERSATION_STEPS": "1000000",
  "HARNESS_MAX_CONVERSATION_WALL_MINUTES": "0",
  "HARNESS_MAX_RUN_TOKENS": "0",
  "HARNESS_ORCHESTRATOR_MAX_TURNS": "500",
  "HARNESS_TOOL_BRACKETS": "on",
  "MODEL_ROUTING_MODE": "off",
  "OPENAI_MODEL_DEEP": "gpt-5.6-sol",
  "OPENAI_MODEL_FAST": "gpt-5.6-luna",
  "OPENAI_MODEL_PRIMARY": "gpt-5.6-terra",
  "OPENAI_MODEL_RESCUE": "gpt-5.6-terra",
  "OPENAI_MODEL_WORKER": "gpt-5.6-terra"
}
```

## Advertised developer flags

These are the running settings catalog values, not proof every historical gate still executes on the current host path. Trace call sites before claiming a gate is active or removed.

| Flag | Value | Explicit override |
|---|---|---|
| `CLEMMY_CONFIRM_FIRST` | `on` | True |
| `CLEMMY_GOAL_FIDELITY_GATE` | `on` | False |
| `CLEMMY_GROUNDING_GATE` | `on` | False |
| `CLEMMY_OUTPUT_GROUNDING_GATE` | `on` | False |
| `CLEMMY_DESTINATION_GATE` | `on` | False |
| `CLEMMY_PARALLEL_PREWRITE_GATES` | `on` | False |
| `CLEMMY_BRAIN_FALLOVER` | `on` | False |
| `CLEMMY_JUDGE_CROSS_FAMILY` | `on` | True |
| `CLEMMY_DEBATE_MODE` | `off` | True |
| `CLEMMY_RUBRIC_VARIANT` | `lean` | False |
| `CLEMMY_TOOL_JIT` | `on` | True |
| `CLEMMY_MCP_ERROR_CORRECTIVE` | `on` | False |
| `CLEMMY_WORKER_THRASH_GUARD` | `on` | False |
| `CLEMMY_DYNAMIC_REASONING` | `on` | False |
| `CLEMMY_CONTINUATION_CLASSIFY` | `on` | False |
| `CLEMMY_GOAL_CONTRACT` | `on` | False |
| `CLEMMY_GOAL_SELF_DRIVE` | `on` | False |
| `CLEMMY_ATTEMPT_RECORDS` | `on` | False |
| `CLEMMY_INBOX_MONITOR` | `on` | False |
| `CLEMMY_CALENDAR_MONITOR` | `on` | False |
| `CLEMMY_AUTO_FOCUS` | `on` | False |
| `CLEMMY_SEMANTIC_RECALL` | `on` | False |

## Continuation

Read `2026-09-19-weekend-refinements.md` for implemented changes and test receipts. Next reconcile Claude status against the actual vault-backed request path and trace requested-versus-effective model selection. Do not silently change global defaults, erase auth markers, or treat provider/model substitution as a passing test. Recheck installed fingerprint after any other agent patches. This audit changes only documentation and memory; it does not alter live configuration.

## Recheck at 2026-09-19 16:13 UTC

After the user said this should be resolved, the running settings endpoint still
reported the old dead vault grant with the same contradictory availability=true.
Called the installed daemon's actual `loadFreshClaudeAccessToken()` against the
live home, without printing credentials. It failed with typed `expired`; no
usable credential was returned. This is a credential-loader result, not a fresh
Anthropic model-response rejection. Evidence:
`output/weekend-harness-2026-09-19/claude-auth-recheck.json`.
Asked where Claude was reconnected to locate a possible app/home mismatch.
Do not mark Claude acceptance passed or silently switch global models.


## Claude reconnection verified — 2026-09-19 16:19 UTC

Supersedes the earlier expired-grant finding: after the user signed in again,
the running daemon reports Claude configured=true, source=vault, expiry
2026-09-20T00:18:42.243Z. A real no-tools model call through the installed
Claude adapter and live-home vault returned 323 for 17×19. The actual usage
ledger records claude-opus-5, 504 input and 3 output tokens. Global defaults
were unchanged. Receipt: output/weekend-harness-2026-09-19/claude-vault-live-validation.json.
This proves the credential/adapter path works. Full chat/SDK routing and the
broader acceptance matrix still need validation; this was not a full chat turn.


## Routing and acceptance follow-up

See `2026-09-19-live-acceptance.md` for the requirement-by-requirement ledger.
Webhook chat intentionally ignores request.model and uses the active brain
(SURFACE_CONFIG in respond-bridge.ts). The previous Claude-requested Terra
response was not evidence of authentication fallback. Selecting Claude with
the normal active-brain API produced an actual Opus 5 host_harness chat; Terra
was restored afterward. The standalone Claude SDK brain branch is retired in
production even though the historical SDK configuration flag remains set.
Plan→Execute and scoped durable memory capture/correction/recall have now passed
bounded live scenarios. Broader matrix and measured input/cache overhead remain open.

Latest observation 2026-09-20 20:55UTC: served brain Grok4.6, judge Grok4.3; configured worker GLM4.5Air, provider usage reports GLM5.3Flash. Host receipt mismatch is a framework attribution defect, not proof of exhausted quota or CLI auth trouble. All four controlled tool reads succeeded; no Claude/Codex model tests. Paid150-candidate research remains stopped.
