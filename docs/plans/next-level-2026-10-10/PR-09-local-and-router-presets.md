# PR-09 — Local models (Ollama, LM Studio) and OpenRouter as first-class presets

Size S · risk additive · depends on PR-03 (for the suggestion), standalone otherwise

## Why

Clementine is local-first and already runs embeddings locally
(`CLEMMY_LOCAL_EMBEDDINGS`) and transcription locally (whisper). Yet the provider
presets (`apps/console-web/src/lib/model-provider-presets.ts`) list DeepSeek,
MiniMax, Together, GLM ×2, Moonshot ×2, xAI and Custom: no local server and no
aggregator. A BYO provider is any OpenAI-compatible endpoint (`byo-providers.ts:33`),
so Ollama (`/v1` at 11434), LM Studio (`/v1` at 1234) and OpenRouter already work
through "Custom", if the owner knows the URL, knows that Ollama needs no key, and
gets past the "configured means base URL and key both present" rule
(`src/config.ts:548`).

A local model is the cheapest second family there is. Memory jobs (12 jobs,
`src/memory/memory-jobs.ts:52`, about 47% of priced cost in one 72 h window) and
the quick role are the obvious tenants; the memory route already waits for a
chosen model instead of substituting (`memory-model-route.ts:107-146`), which is
exactly right for a laptop model that is sometimes off.

## Change

1. **Three presets.** Add to `PROVIDER_PRESETS`: `ollama` (`http://127.0.0.1:11434/v1`,
   no key), `lmstudio` (`http://127.0.0.1:1234/v1`, no key), `openrouter`
   (`https://openrouter.ai/api/v1`, key, `keyUrl`). Each with a `modelHint` in the
   existing style and a `local: true` flag on the first two.
2. **Key-less providers.** `ByoProvider` gains `auth: 'key' | 'none'`; the
   configured check (`config.ts:548`) accepts `auth: 'none'` with a base URL only;
   the fetcher sends no Authorization header for them. The console form hides the
   key field for a `local` preset. Keys for OpenRouter follow PR-08 (vault).
3. **Find a local server.** At daemon start, beside `warmByoProviderCatalogs`
   (`runner.ts:2308`), probe the two local URLs with a 500 ms timeout. A server
   that answers `/v1/models` with at least one chat model is recorded in
   `state/byo-discovered-models.json` under a `local` provider row that is **not**
   connected until the owner says so. No probe outside loopback. Re-probe hourly
   and when Settings → Models opens.
4. **The suggestion.** PR-03's R8 fires when a local server was found and memory
   or quick runs on a metered account: "I found Ollama running on this computer
   with llama-3.3. Learning and quick reads could run here for free. Use it?" The
   yes connects the provider row (same handler as the form) and sets memory and
   quick to it (settings batch, PR-04). Standing "never" is honoured.
5. **Honest status.** A local provider that stops answering shows as
   `unreachable` in the PR-01 health rows; roles bound to it keep today's waiting
   behaviour for memory and the existing helper fallover for quick (back to the
   brain's family), both already in place. A local model never becomes the brain
   from a suggestion.
6. **Capability floor.** Local models default to `contextWindow` from the server's
   catalog when reported, else the 128K default; PR-11 observations refine it.

## Files

- `apps/console-web/src/lib/model-provider-presets.ts`, `screens/settings/ModelProviderForms.tsx`
- `src/runtime/harness/byo-providers.ts` (auth mode, local rows), `src/config.ts:548`
- `src/daemon/runner.ts` (probe), new `src/runtime/harness/local-model-discovery.ts` + test
- `src/runtime/harness/model-recommendations.ts` (R8)
- phone `BrainSheet.tsx` (shows a found local server; cannot add providers today, so it only accepts the suggestion)

## Tests

- A key-less provider is configured with a base URL only and sends no
  Authorization header; a key provider still requires a key.
- Probe: a fixture server on loopback is found; nothing off-loopback is probed
  (assert on the fetch targets); a 500 ms timeout is honoured.
- R8 fires only when memory or quick is metered; `never` suppresses.
- A found server is not connected without a yes; after the yes the memory role
  resolves to it and the memory job pin test (`memory-jobs` registry) still holds.
- `no-hardcoded-provider-pins.test.ts` unchanged (presets live in the console lib
  and name no operation slugs).

## Done when

With Ollama running on the owner's Mac, the installed app finds it, suggests it
once, one tap moves memory and quick to it, the scorecard shows memory calls on
the local model with zero metered tokens, and stopping Ollama shows `unreachable`
without any failure words on Home.

## Do not

- Do not auto-connect a local server; it is a suggestion.
- Do not probe anything but 127.0.0.1.
- Do not make a local model the brain or the checker from a suggestion; the owner
  can still choose it by hand, with the same-family warning that exists today.
