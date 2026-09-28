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

## First installed trial and correction

Candidate 4e6302c6c was served with fingerprint 1bdf48fccc92f67941d53644dc91a320b5eb4c0c7387dd8041a97e5c3afb208b. Session sess-desktop-13740a11e5c0f4419d10bfbe stopped before dispatch: Jev returned delivery 0.27 and irreversible 0.11; no judge call or proof was issued. The call's approval was not accepted. This is a failed acceptance, not a pass.

The conditional API still framed its questions around all accepted inputs, relying on the classifier to infer exact scope from nested schema constraints. The correction supplies explicit effectiveArguments to both semantic ports and uses an exact-call question for both delivery and irreversible effects. Full schema, argument binding, conservative uncertainty and confidence thresholds remain unchanged. 39 affected host/learner/semantic-port checks pass, with assertions that both models receive identical explicit arguments; TypeScript passes.

## Exact call qualification and bounded clarification

Candidate 14614906f passed the existing-channel lookup with zero approvals in the installed live home, both with Jev/completion review on and off. The off run reused its exact durable proof. Both dispatched OPEN once, SEND zero times, and settled observedEffect=none. The completion judge actually served GLM 5.3 for requested GLM 5.2; this is not an exact-model-pin acceptance. Settings were restored and business approvals remained pending.

The original user-ID-only setup was also tested (sess-desktop-b3f0ed95d34c532ae206ba0b) and correctly recorded as a failed acceptance: Jev delivery probability 0.15 caused an approval before the stronger judge could clarify. Nothing was dispatched or approved; test approval apr-2i4w was rejected for cleanup.

The next change permits ONE judge clarification for uncertain exact-call screens (both probabilities at most 0.5), then ONE independent Jev verification against the same full schema and effective arguments. The judge's short explanation is explicitly untrusted until independently checked. Final thresholds remain screen <=0.1 for both risks, judge >=0.9, independent model identities. Affirmative risk, absent explanation, unavailable verification or persistent disagreement keeps the card; there is no retry-until-pass loop. Whole-operation learning is unchanged. The proof retains the explanation and both final readings. Explicit sends never take this path.

## Final scope: authoritative provider contract before model inference

The clarification candidate b9add5dc7 still produced confirm_not_confident for the original call (sess-desktop-e258596d4ed2d5d2b734e1c5). It did not dispatch; test card apr-ibq3 was rejected. The clarification experiment has been removed from the final candidate; it is not necessary for this documented provider behavior. The exact-call learner that passed the earlier live lookup remains, with its original two-model thresholds and no clarification loop.

Slack's official method documentation explicitly separates conversations.open (prepare/resume the conversation) from chat.postMessage (deliver the message): https://docs.slack.dev/reference/methods/conversations.open/#usage-info . The source was retrieved with Firecrawl and retained in .firecrawl/slack-conversations-open.md. This is an ordinary provider write because it may create a conversation, not a read exemption.

The existing Composio adapter contract registry now declares that behavior as provider-neutral ordinary_non_destructive create semantics. Shared kernel/reducer code gains no Slack-name permission branch. The adapter validates the complete known input-field set and primitive types; missing fields, new payload fields, changed types, composition, additional arbitrary fields or incompatible required fields retire the declaration. Actual sends and similarly named operations cannot borrow it. Current manifest identity and exact approval scope still govern execution, and provider no-op receipts still report no change.

The provider contract path is tested through the real host adapter with semantic models unavailable; it adds no classifier calls. Installed original-user-ID acceptance remains to be recorded in output/exact-setup-consent-0928/LIVE-RESULTS.md on the final revision.
