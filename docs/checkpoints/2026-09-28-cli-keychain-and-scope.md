# CLI Keychain diagnosis and scoped inspection — 2026-09-28

Parent installed candidate: cfffb822ae26974e151106fa6aa1bfe1728bcc62. This checkpoint does not claim credentials repaired or a release accepted.

## Proven live failure, without exposing secrets

- User login Keychain is the default and sole user search-list entry. SecKeychainGetStatus reports unlocked/readable/writable.
- Salesforce service `sfdx`, account `local`, exists. Creation and modification metadata both date to 2026-03-04T23:26:15Z. No evidence of recent replacement was found; metadata alone cannot establish all historical changes.
- Direct `sf org list auth --json` from the tool parent and independently from Terminal returns exit/status zero, zero entries, and two SecKeychainItemCreateFromContent passphrase warnings. Empty output is not evidence of signed-out accounts.
- A direct secret read via Apple's security tool fails with exit 51, returning no secret. SecKeychainItemCopyAccess independently returns -25293 (errSecAuthFailed). No secret bytes were printed or persisted.
- Salesforce's installed core maps keychain read errors other than cancellation to PasswordNotFoundError. Crypto.init then attempts to create a key. The displayed creation failure therefore hides the preceding read failure.
- No configured CLI credential-store/home override was present. Native Keychain Access shows the existing Salesforce entry; its Access Control view displays unrestricted access, but the API failure means this UI must not be taken as proof the entry can be decrypted or its ACL successfully loaded.
- No passwords, keychain entries, Salesforce auth files, defaults, or global security settings were changed. Do not delete/reset the keychain, rotate its encryption key, switch to a generic plaintext-backed store, or blindly repeat login as a workaround.
- The earlier assumption that unlocking the Mac alone resolves the issue is unsupported: the keychain was already unlocked during these failures. Local user authentication/access recovery remains owed. Root historical cause is not proven, and this does not prove Clem never contributed historically.

Owner question pending: whether they are at the Mac to complete system authentication directly. Never ask them to send a password in chat.

Evidence: output/cli-keychain-efficiency-2026-09-27/{direct-parent,terminal-parent,key-read-status}.json and acl-metadata.txt in the integration checkout. Diagnostic C program reads only this entry's metadata/access list; it performs no ACL mutations.

Apple guidance: https://support.apple.com/guide/keychain-access/if-a-trusted-app-asks-for-keychain-access-kyca1331/mac and https://support.apple.com/guide/keychain-access/if-you-need-to-update-your-keychain-password-kyca2429/mac . App changes can affect trust, but that explanation is not sufficient here because the direct Terminal reproduction fails too. A default-keychain reset deletes saved passwords and is not an approved repair for this task.

## Framework efficiency fix

Both cli_inspect status and legacy cli_setup status discarded catalogId and swept the entire roster. Scope now reaches getCliHealth before probing. Omitting catalogId preserves roster status; an explicitly blank scope does not silently expand into a roster sweep. No credential behavior or execution authority changed.

Two regression pins failed on the parent: Salesforce-only inspection also invoked Railway, and invalid scope caused six irrelevant probes. Both now pass. The focused CLI tool + health suites pass 32/32, with all process execution injected into disposable test homes; no fixture reset touched the live home. Typecheck passed. These pins are not installed-app acceptance.

Remaining: build/install this follow-up and prove scoped output in the installed app. The parent live turn returned 10 CLI rows; the intended scoped result is one. Do not claim an end-to-end token or speed percentage without matched model/turn measurements.

Separate next efficiency work: workflow child output was reviewed before the parent request's terminal verification, costing a failed review plus another review. Preserve parent/child lineage and selected completion review when resolving it; do not simply bypass the checker or claim a child result satisfies an unfinished parent.
