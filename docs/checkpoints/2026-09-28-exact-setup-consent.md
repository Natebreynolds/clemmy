# Exact setup consent — 2026-09-28

Owner request: eliminate meaningless setup approvals at the framework level without weakening real-send approval.

## Root cause

The structural classifier's action vocabulary interprets the communication noun `DM` as a send verb in an otherwise unrecognized action such as `OPEN_DM`. The existing definition learner considers every input the operation accepts. It cannot prove a conditional existing-conversation lookup safe when other inputs may create a conversation. The observed whole-operation Jev screen was 0.22 delivery probability (above the unchanged 0.10 bound).

## Change

Ambiguous communication nouns now have a bounded exact-call semantic path. After the normal fresh manifest/account/schema checks, Jev and the owner's configured judge inspect the full provider input schema intersected with the complete effective arguments (`allOf` + `const`). The schema's own description is required; no provider-name permission list or guessed documentation is introduced. Agreement uses the existing confidence thresholds and independent-model requirement.

The proof is scoped to the exact manifest, provider definition, account, schema, invoke port and arguments. It never becomes an operation-wide waiver. The first result, including uncertainty/unavailability, is journaled for the logical call. Restart or later learning cannot rewrite a raised approval. Old approval cards keep their original terms. Fresh authority is checked again after the model calls, and the ordinary consent reducer still decides permission. Destructive/admin/delete and positive outbound/recipient evidence cannot be lowered. Explicit send verbs do not incur the new semantic calls.

Known limitation: a first ambiguous call with missing provider documentation, model disagreement or unavailability retains the conservative approval. This is not a promise that every setup operation can be proven harmless. Cached exact proof works without re-calling the models; an account/recipient/argument/schema change requires new proof.

## Verification before install

- TypeScript compilation clean.
- 90 targeted checks pass across the real host consent adapter, delivery learner, risk loader/projector, consent reducer and direct-call integration.
- New integration coverage: first-call conditional lookup; complete schema retained; repeated use without model availability; account/argument/recipient/definition isolation; destructive/outbound floors; frozen negative evidence; explicit sends still carded without extra model calls.
- Baseline falsification: run new pins with the previous host adapter, then restore the adapter; see `output/exact-setup-consent-0928/baseline-red.log` for actual failures.
- Installed/live acceptance is still required after the fresh build. Controlled fixture only; business approvals `apr-n080` and `apr-qjjo` remain pending.

## Qualification traps

Do not hand-edit learned verdicts or backdate learning. Do not approve a business send as part of this test. A passed fixture suite does not establish installed/live-home behavior. Preserve native desktop files in the previously authorized runtime-only hotpatch; this is not a newly signed native release. Record served SHA/fingerprint, exact model results and both on/off trials before claiming completion.
