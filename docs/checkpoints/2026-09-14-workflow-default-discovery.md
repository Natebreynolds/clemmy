# Platform 49: default workflow discovery after 3.18.7

The Space-launched run `1789423729975-4271aa`, session
`workflow:1789423729975-4271aa:main`, source 205953, ran on installed 3.18.7
(`7c757e29`). This is a new failure, not the noon run replayed in the UI.
Raw events are retained locally in
`output/platform49-3187-space-failure/events.json`.

## Evidence and root cause

The run completed 16 business reads and recorded no external write. At 206076,
INSERT_DIMENSION arguments lacked its required `insert_dimension` object.
GET_SHEET_NAMES acquisition then expired, and metadata discovery at 206091
returned `brokerCoverage:builtins_only`. Subsequent local-tool exploration
led to a nonexistent Google Sheets MCP server. The host eventually stopped at
206146 with `authority_acquisition:no_new_evidence`.

The 3.18.7 search wiring required a truthy explicit external scope. Production
unlocked workflow steps normally carry `undefined`, meaning the default scope,
not an external prohibition. The previous builder fixture passed an explicit
catalog scope and therefore missed the ordinary execution path.

## Focused correction

`src/agents/workflow-step-agent.ts` supplies the connected catalog to discovery
when the unlocked step's scope is undefined. Explicit null/none, local locks,
exact and compiled tool restrictions retain their existing behavior. Dispatch
scope, provider argument validation, and authored write authority are unchanged.
There are no task-specific tool names or additional approval gates in this fix.

The discovery test now covers explicit catalog, omitted scope, wildcard access,
and null scope, including restricted local variants and both workflow builders.
Successful discovery must publish the exact schema, capability ref and selected
account, perform no business I/O, and support a read through its advertised
`call_tool` carrier. Provider metadata and transport are substituted in these
repository tests; they are not a live provider or LLM qualification.

Before correction: 10/11 tests passed; the omitted-scope workflow case failed
with the same `builtins_only` response as production. After correction: all 47
selected-account disclosure, workflow-step, and external-scope lock tests passed.
TypeScript checks passed. Logs:

- `/tmp/clem-3187-workflow-discovery-before.log`
- `/tmp/clem-3187-workflow-discovery-final.log`
- `/tmp/clem-3187-discovery-typecheck.log`

## Remaining qualification and separate findings

This correction is not installed or published yet. The signed user-installed
3.18.7 app is untouched. Do not treat this as a successful rerun of Platform 49.
Qualify discovery and metadata read on the corrected runtime, then the workflow
through its Space launch, checking actual sheet/Space outcomes and avoiding
duplicate mutations on any resumed run.

The JIT metadata acquisition reported `proof_publication_expired`; restoring the
ordinary discovery route addresses the missing recovery door, not proof of the
timeout's own cause. The automatic WorkflowDoctor also failed separately:
`MODELS.fast` selected `gpt-5.4`, rejected by the current Codex subscription route.
That happened after the workflow stop and did not cause it. Model selection for
diagnosis remains open. The runner reported 18 frames and 706,404 input tokens
(684,900 uncached); this trace still warrants an efficiency follow-up once
discovery works. No retries, context ceilings, or judge policy were widened.
