# PR-18 — The shared kernel names no provider

Size S · risk low · depends on PR-00 · one baseline failure, and an owner rule

## Why

`src/runtime/harness/provider-neutral-kernel.test.ts` scans the kernel files for
customer-shaped or provider-branded words (`restaurant`, `attorney`, `salesforce`,
`outlook`, `slack`, `gmail`, `composio`, `google sheets`, …) and fails on
`./host-turn-runner.ts`. The owner's rule (2026-09-28, "there should never be any
hard coded operations in the code like that"; `PRODUCT.md`: "no hardcoded
tool/provider lists or names in product code") is what the test enforces. On
`b0612dd` the host turn runner matches three times:

| Line | Text | Since |
|---|---|---|
| `host-turn-runner.ts:3` | `import { composioFileInputRefusal, composioOperationInputSchema } from '../../integrations/composio/file-inputs.js'` | `46ac252d` (2026-10-09, connected-app file uploads) |
| `host-turn-runner.ts:6340` | `const checksFileInputs = manifest.providerKind === 'composio'` | `08c81c8a` (2026-08-31, the host_v1 hubs) |
| `host-turn-runner.ts:7446` | comment "live 2026-10-07: Slack `not_found` on a delete" | `248b83dc` (2026-10-07) |

The test fails identically at v3.18.34, so it is one of CI's 22, not a fresh
regression; the 10-09 import made it three matches instead of two.

## Change

1. **File inputs are a contract, not a provider.** The integration that owns
   file-bearing parameters declares them on the manifest it already publishes
   (`manifest.fileInputs` or the existing capability contract shape), and the
   kernel asks the manifest, never `providerKind === 'composio'`. The two
   functions imported from `integrations/composio/file-inputs.ts` move behind the
   provider-neutral seam the kernel already uses for other adapters
   (`production-capability-adapters.ts` is the pattern), so the kernel imports
   the seam, not the integration.
2. **The comment names no product.** "live 2026-10-07: a provider answered a
   delete with its own not-found" says the same thing.
3. **Nothing else moves.** Behaviour is byte-identical; the file-upload path
   (v3.18.35 "Files go where they are asked to") keeps its tests.

## Files

- `src/runtime/harness/host-turn-runner.ts` (three lines)
- `src/integrations/composio/file-inputs.ts` (unchanged or re-exported through the seam)
- `src/runtime/harness/production-capability-adapters.ts` or the manifest type
  (`currentManifestOperationContract` already carries per-operation contracts)
- `src/runtime/harness/provider-neutral-kernel.test.ts` (unchanged; it goes green)

## Tests

- `provider-neutral-kernel.test.ts` green.
- The file-upload tests from `46ac252d` unchanged and green.
- `no-hardcoded-provider-pins.test.ts` baseline for `host-turn-runner.ts` may be
  lowered in the same commit if its count fell.

## Done when

The kernel scan passes, a connected-app upload still sends the named local file
on the installed app, and the ratchet's per-file ceiling for the runner is equal
or lower.

## Do not

- Do not widen the regex or add an allowlist to the test.
- Do not move the provider-specific code into another kernel file.
