# PR-08 — BYO keys go to the vault, not `.env`

Size S · risk low (readers are already vault-first) · depends on nothing

## Why

`POST /api/console/settings/model-providers` (`src/dashboard/console-routes.ts`,
the handler around `:9901-9935`) saves a provider the owner adds from Settings.
It writes the base URL, model ids and label with `updateEnvKey`, which is fine, and
it writes **the API key** the same way:

```ts
if (apiKey) updateEnvKey('BYO_MODEL_API_KEY', apiKey);          // default slot
if (apiKey) updateEnvKey(byoProviderKeyEnvKey(id), apiKey);     // extra providers
```

`updateEnvKey` (`src/tools/shared.ts:641`) rewrites `<home>/.env` line by line.
The README's privacy table says credentials live in the file vault with owner-only
`0600` permissions on POSIX; `.env` is an ordinary file. The readers already prefer
the vault (`src/config.ts:536-572`: `readSecretFromFileVaultSync('byo_model_api_key')`,
then env; `byo_provider_<slug>_api_key`, then env), so the write side is the only
place out of step. The 10-07 handoff also notes "BYO key/account replacement …
still require controlled live evidence".

## Change

1. **Write keys to the vault.** In the add-provider handler (and its phone twin if
   one exists; today the phone cannot add providers), store the key with the
   vault writer the Claude/Codex grants use (`src/runtime/auth-store.ts` family;
   the exact secret-vault write helper next to `readSecretFromFileVaultSync`) under
   `byo_model_api_key` or `byo_provider_<slug>_api_key`. Keep every other
   `updateEnvKey` call as is. Set `process.env` for the running daemon as the
   handler does today so the key is live without a restart.
2. **Remove the key from `.env` when it moves.** If `.env` already carries
   `BYO_MODEL_API_KEY` or `BYO_PROVIDER_<SLUG>_API_KEY`, the handler that writes
   the vault also removes that line (a new `removeEnvKey` beside `updateEnvKey`,
   same line discipline). A receipt line in the daemon log names the key that
   moved, never its value.
3. **One-time boot migration, receipted.** At daemon start, after the vault is
   available: for each BYO key present in `.env` and absent from the vault, copy
   it to the vault, remove the `.env` line, and write
   `state/receipts/byo-keys-migrated.json` with the key names and the time.
   Idempotent; a vault write failure leaves `.env` untouched and logs once.
4. **Delete-provider removes the key** from both places
   (`DELETE settings/model-providers`, `:9946`).
5. **The diagnostics bundle** (v3.18.34 "Save diagnostics") already redacts secrets;
   add the vault key names to its redaction test to be sure.

## Files

- `src/dashboard/console-routes.ts` (three handlers)
- `src/tools/shared.ts` (`removeEnvKey`)
- `src/daemon/runner.ts` (migration step beside `warmByoProviderCatalogs`, `:2308`)
- `src/config.ts` (no change expected; confirm precedence stays vault → env)
- tests beside each

## Tests

- Add a provider in a disposable home: the key is in the vault with `0600`, not in
  `.env`; the catalog browse (`settings/model-providers/models`) still works with
  the saved key.
- Migration: a home with keys in `.env` and none in the vault ends with the keys in
  the vault, the lines gone and the receipt written; a second boot does nothing; a
  vault write failure leaves `.env` intact.
- Delete removes both.
- `check-public-hygiene` and the diagnostics redaction tests stay green.
- Windows: the credential-policy bundle allows exactly four inputs
  (`apps/desktop/scripts/build-credential-policy.mjs`); any new import into
  `credential-private-filesystem.ts` must be added there or the Windows boot fails
  silently (10-07 traps).

## Done when

A freshly added BYO provider on the installed app has its key in the vault only,
the daemon uses it for a worker call, and an existing `.env` key is migrated with
a receipt on the next launch.

## Do not

- Do not encrypt the vault in this PR or change its format; same file, same rules.
- Do not touch Claude or Codex grants.
- Do not migrate any other `.env` value.
