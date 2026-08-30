# Legacy harness cutover inventory

This inventory is a deletion gate for the next tag. It is not a request to
remove every provider name from Clementine. Provider names are legitimate at
adapter, connection, schema, and presentation edges. They are not legitimate
as authority, routing, planning, completion, or recovery logic in the shared
chat/workflow kernel.

## Classification rule

| Location | Provider/task nouns allowed? | Required shape |
| --- | --- | --- |
| Live adapter or connection UI | Yes | Translates one provider contract into the canonical capability/receipt contract. |
| User-facing presentation | Yes | Labels already-authoritative state; grants no reachability or execution authority. |
| Test acceptance story | Yes | Story is not imported by production and kernel assertions are also rerun with generated names. |
| Chat/workflow kernel | No | Decides from typed capability, effect, schema, evidence, consent, and lifecycle contracts only. |
| Memory/ranking | Provider aliases may be hints | Never grants authority and never makes blank-state execution impossible. |

## Reachable legacy families to eliminate or isolate

These are examples found by the August 22 production scan. The release gate is
based on importer/behavior closure, not only these filenames.

### Task-shape and provider routing

- `src/runtime/tool-composition-detector.ts`
- ~~`src/execution/workflow-builder-analysis.ts`~~ — eliminated; the primary
  model now authors the explicit semantic graph passed to `workflow_create`.
- `src/execution/controller.ts`
- `src/execution/workflow-resource-binding.ts`
- `src/runtime/capability-registry.ts`
- legacy semantic-boundary deterministic compilation and host binding

Replace their kernel decisions with live capability contracts and canonical
model steps. A saved alias or remembered recipe may rank candidates but cannot
select an executable operation.

### Provider-shaped completion and proof

- `src/execution/deliverable-probe.ts`
- provider-shaped workbook/create/readback proof provisioning
- provider-specific result and pagination inference in shared reducers

Move these into manifest-declared evidence/readback adapters. The terminal
reducer consumes provider-neutral evidence and completeness contracts.

### User-instance policy branches

- `src/memory/policy-enforcement.ts`
- provider/account-specific standing-rule gates embedded in carrier code

Standing rules must compile into typed, scoped policy constraints. The shared
gate evaluates scope/effect/account/resource identities without knowing the
user's provider or business story.

### Production-packaged fixtures and examples

- `src/runtime/semantic-boundary/production-bootstrap-fixtures.ts`
- `src/runtime/semantic-boundary/production-bootstrap-child.mts`
- story-specific fixture helpers located under production source paths

Move these behind explicit test-only entrypoints or replace them with generated
capability/field names. No packaged runtime module may import them.

### SDK and graph-first predecessors

- OpenAI SDK-owned interactive `Runner.run` paths
- standalone Claude interactive execution paths
- `recordAcceptedSourceGraph -> dispatchAdmittedSource -> driveChatTurnSpine`
  for ordinary foreground chat

Retain only bounded rolling-upgrade readers for already-persisted legacy pause
state until those states are drained. New accepted foreground work must have
one host-owned loop. Durable workflows retain explicit graphs and call the same
ToolKernel.

## Cutover evidence required

1. A machine-readable production importer report for every predecessor family.
2. Zero new foreground sources entering graph-first or SDK-owned execution.
3. Generated-name tests pass under permuted catalog order and carrier kind.
4. Empty-memory MCP, CLI, and gateway reads bind from current live truth.
5. A renamed operation rediscovering successfully never references its old
   physical name as authority.
6. Provider-specific readback lives behind the selected capability manifest,
   not in the terminal reducer.
7. Removing all acceptance-story nouns leaves kernel behavior unchanged.
8. Packaged artifact scan contains no production import of test/bootstrap
   fixtures.

Hard stop: a provider/task noun may remain in a real adapter or presentation
module, but any reachable branch that uses it to choose a route, authorize a
call, infer completion, or recover work blocks the tag.
