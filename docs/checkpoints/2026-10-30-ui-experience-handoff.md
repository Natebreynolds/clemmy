# UI experience handoff — October 30, 2026

The user requested a local commit so Claude can take over integration and
release work. This handoff does not authorize a push, release, or hotpatch.

## Source and ownership

- Branch: `codex/clem-ui-release-2026-10-30`.
- Base: `4da0618ead6797b1f1a1ee3e7f6f38dcd0da1bb8`.
- Scope: 32 verified UI source/test files plus this checkpoint. No backend,
  shared package, token-meter, personal Space, credential, or integration edits.
- The previous 25-file release-experience candidate remains byte-identical;
  the Connect refinement adds seven files to that candidate.
- The older desktop candidate `85956afca954` was already integrated upstream
  through `5ee454f4c`; do not reapply that older patch.
- At handoff preparation, the integration owner was clean on
  `claude/r60-integrate` at `9311b6501c4319d7d429afc7ce7b64f67d7cacce`.
  Read-only checks of both cumulative and Connect-only patches passed there.
  Recheck newer owner changes before integrating; no patch was applied there.

## Completed

- Desktop offers editable business-task starts and an exact destination for
  saved computer tasks. Computer-task read/save/remove/repeat failures remain
  visible and recoverable; uncertain repeat requests are not automatically
  retried. Agent conversations receive the main chat's computer-work visibility.
- Phone first use offers a quiet editable business request only when all its
  sources are freshly confirmed empty. Real waiting work, stale data, errors,
  existing drafts, attachments, projects, and agents keep their existing paths.
- Blocked phone automations open an editable setup request containing the exact
  workflow and missing requirements, without sending or running automatically.
- Native phone pairing copy points Mac and Windows users to
  **Apps & devices → Pair your phone**. Authentication/security behavior is unchanged.
- Connect has **Apps**, **Devices & chat**, and **Advanced**. It uses one app
  search and draft-only Clem guidance. Connected rows keep account identity,
  status and reconnect warnings visible; management controls expand on demand.
- Computer setup shows one truthful status with technical details disclosed
  separately. Visited setup forms and install jobs survive area switches.
  Pairing codes load on explicit intent, pause when hidden, and refresh on return.
  Legacy hashes and `/connect?guide=phone#phone` reveal the correct controls.
- Existing identity/tokens and the phone's always-light direction are preserved.

## Verification and artifact provenance

- Final app-source candidate fingerprint before this checkpoint/commit:
  `05a8085d847a2062ba35b8a813ccc9fff62fc697dddbbdddc17cbb5d08731d8f`.
- All **1,953 tests passed across 288 frontend test files**; no failures,
  skips, or cancellations. The final source remained stable during verification.
- Desktop TypeScript/production Vite build passed. Existing chunk-size warnings
  remain. Mobile's 18 built assets are byte-identical to the prior qualified
  candidate; that mobile build and unsigned generic iOS Simulator compile passed.
  Swift did not change in the Connect refinement.
- Independent browser/source finish review: **ship**, eight valid captures at
  1280/960/393 widths including dark mode, no material fixes. Narrow console
  captures are responsive desktop web, not native iPhone screenshots.
- System documentation review required no PRODUCT/DESIGN/token changes.
- Raw receipts, logs, screenshots, patches, and reviewed assets remain in
  `output/connect-streamline-2026-10-30/` (ignored local output).
  Archive: `clem-release-experience-05a8085d847a.zip`, SHA-256
  `149e786f65d874eab1b97cea9bce8d517869d035eddfc57377ecdc28e1fffaf0`.
  Its 375 files passed CRC and individual hash verification.
- The archive has a cumulative 32-file patch and a seven-file Connect-only
  patch for an owner who already integrated the preceding 25 files. Choose one
  appropriate integration path; do not apply the same changes twice.
- The qualified source fingerprint includes Git identity. This checkpoint and
  the commit change that identity; the recorded fingerprint is evidence for the
  tested candidate, not the later combined release. Rebuild after integration.

## Remaining work explicitly discussed with the user

1. **Connector consolidation is incomplete.** This pass reorganized existing
   connection interfaces. Some duplicate-looking entries are separate methods
   or capabilities; preserve their authorities when unifying their presentation.
2. **Sharing still needs a better home.** `Share what Clem built` is currently
   under **Advanced → Tool servers & command-line tools**. Plugin import/catalog
   is under **Advanced → Plugins**. Consider a coherent import/export home;
   sharing has not yet been moved alongside plugin importing.
3. **Computer onboarding is not yet fully seamless.** The visible controls are
   simpler, but the existing install/connect/OS-permission paths remain. Windows
   is still marked preview in the driver framework. Finish a guided
   turn-on → permission → verification → ready flow and qualify fresh Mac and
   Windows installations before claiming seamless cross-platform setup.
4. **Release acceptance remains open.** Native Mac interaction, iOS Simulator
   and physical-phone interaction, exact combined-source Windows qualification,
   and named controlled installed-app/live-home acceptance are still required.
   The test runner's live-home sentinel was **NOT PERFORMED** because the live
   daemon owns that home; no daemon stop or destructive reset was attempted.

The installed app remained v3.18.60 at daemon SHA
`d963ebcafafdc1b64007da1da3e72de7ccd2dc7e`, fingerprint
`7e58fcd5cc99e03b61c37ace13a385c2af39494e756a0ab2a7f84e2724bfc355`,
at the final read-only check. This UI candidate was not installed or hotpatched.
No provider/model execution or external-agent message was performed.
