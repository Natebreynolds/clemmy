/**
 * A disclosed capability ref must name what the host catalog actually holds.
 *
 * Live 2026-08-28: when a Composio operation's live definition drifted from
 * its installed manifest, the catalog re-registered it as
 * `<base>:definition:<24 hex>` and FORGOT the base id — while the disclosure
 * path went on minting the base name lexically from the slug. Plan admission
 * compares ids by exact string, so it refused "selected capability … is absent
 * from the current host catalog"; the model retried, discovery re-minted the
 * same absent name, and it refused again. 22 refusals in three minutes across
 * both Outlook calendar reads, escapable only by killing the turn. Four slugs
 * were in this state (two calendar, two Sheets).
 *
 * The boundary this protects is unchanged: a descriptor id must be exactly
 * what its identifier resolves to. These pin that "resolves to" consults the
 * catalog, and — just as importantly — that it never GUESSES when the answer
 * is ambiguous.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set before ANY import that reaches config: ESM hoists every static import,
// so this file keeps its imports dynamic below.
process.env.CLEMENTINE_HOME = '/tmp/clemmy-test-canonical-capability-id';

const {
  accountPartitionedResolvedCapabilityId,
  canonicalResolvedCapabilityId,
  installHostCapabilityCatalogFactory,
} = await import('./host-capability-catalog-factory.js');

type Entry = { capabilityId: string; account?: string };

function factoryWith(entries: Entry[]) {
  const rows = entries.map((e) => ({ ...e, toolName: e.capabilityId, schemaVersion: '1', schemaDigest: 'd', effect: 'read' })) as never[];
  return {
    register() {}, forget() {}, clear() {},
    catalog: () => ({}) as never,
    snapshot: () => rows,
    get: (id: string) => rows.find((r) => (r as { capabilityId: string }).capabilityId === id),
  } as never;
}

test('with no catalog installed the base spelling is the answer', () => {
  installHostCapabilityCatalogFactory(null);
  assert.equal(canonicalResolvedCapabilityId('outlook_get_calendar_view'), 'cap:resolved:outlook_get_calendar_view');
});

test('a base id the catalog still holds is returned unchanged', () => {
  installHostCapabilityCatalogFactory(factoryWith([{ capabilityId: 'cap:resolved:outlook_get_calendar_view', account: 'ca_x' }]));
  assert.equal(canonicalResolvedCapabilityId('outlook_get_calendar_view', 'ca_x'), 'cap:resolved:outlook_get_calendar_view');
  installHostCapabilityCatalogFactory(null);
});

test('a superseded base resolves to the successor the catalog actually holds', () => {
  // The exact live shape: base forgotten, successor registered under a new account.
  installHostCapabilityCatalogFactory(factoryWith([
    { capabilityId: 'cap:resolved:outlook_get_calendar_view:definition:388d036f1c4193a64837b8ab', account: 'ca_x' },
  ]));
  assert.equal(
    canonicalResolvedCapabilityId('outlook_get_calendar_view', 'ca_x'),
    'cap:resolved:outlook_get_calendar_view:definition:388d036f1c4193a64837b8ab',
    'the disclosed ref must be the id admission will compare against',
  );
  installHostCapabilityCatalogFactory(null);
});

test('another operation’s successor can never answer for this one', () => {
  // Guards against resolving by a loose global prefix scan.
  installHostCapabilityCatalogFactory(factoryWith([
    { capabilityId: 'cap:resolved:googlesheets_add_sheet:definition:82a3c39143b3ac6728594d65', account: 'ca_x' },
  ]));
  assert.equal(
    canonicalResolvedCapabilityId('outlook_get_calendar_view', 'ca_x'),
    'cap:resolved:outlook_get_calendar_view',
  );
  installHostCapabilityCatalogFactory(null);
});

test('an ambiguous match refuses loudly instead of picking an account', () => {
  // Two accounts hold a successor and the caller named neither. Returning
  // either one would silently cite a mailbox the user did not ask for; the
  // base id refuses visibly, which is the safe failure.
  installHostCapabilityCatalogFactory(factoryWith([
    { capabilityId: 'cap:resolved:outlook_get_calendar_view:definition:aaaa', account: 'ca_one' },
    { capabilityId: 'cap:resolved:outlook_get_calendar_view:definition:bbbb', account: 'ca_two' },
  ]));
  assert.equal(canonicalResolvedCapabilityId('outlook_get_calendar_view'), 'cap:resolved:outlook_get_calendar_view');
  // Naming the account disambiguates it.
  assert.equal(
    canonicalResolvedCapabilityId('outlook_get_calendar_view', 'ca_two'),
    'cap:resolved:outlook_get_calendar_view:definition:bbbb',
  );
  installHostCapabilityCatalogFactory(null);
});

test('a legacy base owned by another account cannot answer the requested account', () => {
  installHostCapabilityCatalogFactory(factoryWith([
    { capabilityId: 'cap:resolved:fixture_create_resource', account: 'ca_one' },
  ]));
  const resolved = canonicalResolvedCapabilityId('fixture_create_resource', 'ca_two');
  assert.equal(
    resolved,
    accountPartitionedResolvedCapabilityId('fixture_create_resource', 'ca_two', 'runtime'),
  );
  assert.notEqual(resolved, 'cap:resolved:fixture_create_resource');
  installHostCapabilityCatalogFactory(null);
});

test('duplicate current rows for one account never resolve by insertion order', () => {
  const rows = [
    { capabilityId: 'cap:resolved:fixture_create_resource:definition:first', account: 'ca_one' },
    { capabilityId: 'cap:resolved:fixture_create_resource:definition:second', account: 'ca_one' },
  ];
  const factory = factoryWith(rows);
  installHostCapabilityCatalogFactory(factory);
  const resolved = canonicalResolvedCapabilityId('fixture_create_resource', 'ca_one');
  assert.ok(resolved.includes(':definition:ambiguous-'));
  assert.equal(factory.get(resolved), undefined, 'ambiguity token is deliberately non-callable');
  assert.ok(rows.every((row) => row.capabilityId !== resolved));
  installHostCapabilityCatalogFactory(null);
});
