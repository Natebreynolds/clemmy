# Workflow account refresh — September 24

## Defect and repair

Installed candidate 78d22cb81 repeatedly failed the daily stand-up before dispatch.
The workflow source explicitly names an ACTIVE Outlook connection, but exact
re-provisioning selected a different ACTIVE remembered default. It refreshed the
other account's definition to 20260922_00, then preparation selected the original
account's 20260903_00 manifest again. Readiness refused observation_unavailable.
This is not a disconnected account or proof that the workflow is merely too old.

The framework now carries each selected manifest's operation/account pair through
both version-drift and observation-mismatch repair. When the accepted source names
that exact account token, provisioning nominates it through the existing account
router. Writes retain account review. A route that selects a different connection
is refused before proof publication. Per-operation routing cache keys include the
selected account, so same-toolkit operations cannot inherit one another's route.
No workflow definitions, model settings, account defaults, or business data changed.

## Verification

- The new regression failed on the original production code: expected the selected
  account, got the remembered default. It uses actual proof provisioning and manifest
  succession, with two ACTIVE accounts and a provider-version change.
- 27 focused discovery/workflow checks passed, including the new account-preserving
  successor and missing-account, unquoted-selection, and unavailable-write-reviewer
  negatives. No provider business dispatch occurs in these fixtures.
- 68 account-routing, selected-definition revalidation, account-partitioned lineage,
  and observation-drift checks passed. These include existing schema and identity
  invariants; no required test was weakened.
- Logs: /private/tmp/clem-account-pin-{red,suite,invariants}.log.
- Typecheck passed. Build and installed acceptance are pending at the time of this entry.

The real Platform 49 run trigger-dce26a05b92fb827dac85f67a8fd4512 completed on
78d22cb81 with its recorded goal satisfied and no partial failures/blocked steps.
This is separate from validating this account-refresh fix.

## Remaining limits

Generic capability-block UI wording still calls observation failures “not connected.”
This patch fixes the evidenced account discontinuity; it does not claim that generic
message or every provider failure class is corrected. Old stand-up runs are not
manually resumed as acceptance. Use a named read-only workflow fixture in the
installed app. Full release gates, exact packaged candidate checks and tag remain
separate and outstanding.
