/**
 * Run: npx tsx --test src/runtime/harness/constraint-gate-e2e.test.ts
 *
 * END-TO-END proof of the constraint gate — born from the 2026-06-11
 * wrong-mailbox incident, where the gate shipped wired but VACUOUS: the
 * live schema's kind CHECK rejected 'constraint' rows, so listConstraints()
 * was always empty and 17 emails left from the wrong account.
 *
 * This file tests the REAL chain the prior unit tests skipped:
 *   old schema → migration 12 → store a constraint through the real DDL →
 *   listConstraints() returns it → the dispatch gate blocks the exact
 *   send shape from the incident (user_id:'me', no from field).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';

const TEST_HOME = '/tmp/clemmy-test-constraint-gate';
process.env.CLEMENTINE_HOME = TEST_HOME;

// eslint-disable-next-line import/first
const { openMemoryDb, closeMemoryDb, resetMemoryDb, MEMORY_DB_PATH, STATE_DIR } = await import('../../memory/db.js');
// eslint-disable-next-line import/first
const { rememberFact, listConstraints } = await import('../../memory/facts.js');
// eslint-disable-next-line import/first
const { findEmailSendConstraint, findOutlookCalendarReadConstraint, checkConstraintViolation, constraintsForToolkit, renderToolkitConstraintBanner } = await import('./constraint-guard.js');
// eslint-disable-next-line import/first
const { verifyOutlookSender, extractMailboxEmails, clearSenderVerificationCache, resolveCompliantSenderConnection } = await import('./sender-verify.js');

const SENDER_RULE =
  'Email sending constraint: always send email via nathan.reynolds@scorpion.com (Scorpion Outlook mailbox) unless Nate explicitly directs otherwise.';

before(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

/** Recreate the PRE-v12 production schema by hand: the narrow kind CHECK
 *  that rejected 'constraint' rows, plus fact_embeddings with its
 *  ON DELETE CASCADE FK (the landmine a naive rebuild would trip). */
function createOldSchemaDb(): void {
  closeMemoryDb();
  resetMemoryDb();
  mkdirSync(STATE_DIR, { recursive: true });
  const raw = new Database(MEMORY_DB_PATH);
  raw.exec(`
    CREATE TABLE consolidated_facts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      kind              TEXT NOT NULL CHECK (kind IN ('user','project','feedback','reference')),
      content           TEXT NOT NULL,
      content_hash      TEXT NOT NULL UNIQUE,
      source_session_id TEXT,
      source_path       TEXT,
      score             REAL NOT NULL DEFAULT 1.0,
      active            INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      derived_from_session_id TEXT,
      derived_from_call_id    TEXT,
      derived_from_tool       TEXT,
      trust_level             REAL,
      extracted_at            TEXT,
      importance              REAL,
      last_accessed_at        TEXT,
      derivation_depth        INTEGER NOT NULL DEFAULT 0,
      derived_from_fact_ids   TEXT,
      pinned                  INTEGER NOT NULL DEFAULT 0,
      source_app              TEXT,
      access_count            INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_facts_active ON consolidated_facts(active, kind, score DESC);
    CREATE INDEX idx_facts_pinned ON consolidated_facts(pinned, active);

    CREATE TABLE fact_embeddings (
      fact_id      INTEGER PRIMARY KEY REFERENCES consolidated_facts(id) ON DELETE CASCADE,
      model        TEXT NOT NULL,
      dim          INTEGER NOT NULL,
      vector       BLOB NOT NULL,
      content_hash TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  const stamp = raw.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
  for (let v = 1; v <= 11; v++) stamp.run(v, '2026-06-01T00:00:00.000Z');

  raw.prepare(`
    INSERT INTO consolidated_facts (id, kind, content, content_hash, score, active, created_at, updated_at, pinned)
    VALUES (42, 'user', 'pre-migration fact', 'hash-42', 1.0, 1, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', 1)
  `).run();
  raw.prepare(`
    INSERT INTO fact_embeddings (fact_id, model, dim, vector, content_hash, created_at)
    VALUES (42, 'test-model', 4, ?, 'hash-42', '2026-06-01T00:00:00Z')
  `).run(Buffer.from([1, 2, 3, 4]));

  // Prove the original bug: the old CHECK rejects constraint rows outright.
  assert.throws(() => {
    raw.prepare(`
      INSERT INTO consolidated_facts (kind, content, content_hash, created_at, updated_at)
      VALUES ('constraint', 'x', 'hash-x', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')
    `).run();
  }, /CHECK/i, 'old schema must reject constraint rows (the incident precondition)');
  raw.close();
}

test('migration 12 widens the kind CHECK on an existing DB without losing facts or embeddings', () => {
  createOldSchemaDb();

  const db = openMemoryDb(); // runs migration 12 against the old schema

  const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='consolidated_facts'`).get() as { sql: string }).sql;
  assert.ok(ddl.includes("'constraint'"), 'rebuilt table must admit the constraint kind');

  const fact = db.prepare('SELECT id, kind, content, pinned FROM consolidated_facts WHERE id = 42').get() as Record<string, unknown>;
  assert.equal(fact?.content, 'pre-migration fact', 'existing facts must survive the rebuild');
  assert.equal(fact?.pinned, 1, 'column values must survive the rebuild');

  const embedding = db.prepare('SELECT fact_id, dim FROM fact_embeddings WHERE fact_id = 42').get() as Record<string, unknown>;
  assert.equal(embedding?.dim, 4, 'fact_embeddings must NOT be cascade-wiped by the rebuild');

  // The point of it all: a constraint row can now be stored.
  db.prepare(`
    INSERT INTO consolidated_facts (kind, content, content_hash, created_at, updated_at)
    VALUES ('constraint', 'migration smoke constraint', 'hash-smoke', '2026-06-11T00:00:00Z', '2026-06-11T00:00:00Z')
  `).run();

  const version = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
  assert.ok(version >= 12, 'migration 12 must be recorded');
});

test('a fresh DB admits constraint rows and migration 12 is a no-op on it', () => {
  closeMemoryDb();
  resetMemoryDb();
  const db = openMemoryDb();
  const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='consolidated_facts'`).get() as { sql: string }).sql;
  assert.ok(ddl.includes("'constraint'"));
});

test('rememberFact(kind=constraint) → listConstraints → gate applies to the incident send shape', () => {
  const saved = rememberFact({ kind: 'constraint', content: SENDER_RULE });
  assert.equal(saved.kind, 'constraint');

  const constraints = listConstraints();
  assert.equal(constraints.length >= 1, true, 'listConstraints must return the stored constraint (was 0 forever before)');

  // The EXACT shape of the 2026-06-11 incident sends.
  const rule = findEmailSendConstraint('OUTLOOK_OUTLOOK_SEND_EMAIL', {
    user_id: 'me',
    to_email: 'jeff@gnlaw.nyc',
    subject: 'Albany PI search visibility',
    body: '…',
    is_html: false,
    save_to_sent_items: true,
  });
  assert.ok(rule, 'sender rule must apply to an Outlook send');
  assert.equal(rule?.allowedAccount, 'nathan.reynolds@scorpion.com');

  // Reads and profile lookups are NOT gated (no recursion, no read friction).
  assert.equal(findEmailSendConstraint('OUTLOOK_GET_PROFILE', { user_id: 'me' }), null);
  assert.equal(findEmailSendConstraint('OUTLOOK_OUTLOOK_LIST_MESSAGES', {}), null);
});

test('verifyOutlookSender blocks the wrong mailbox and passes the right one', async () => {
  const rule = findEmailSendConstraint('OUTLOOK_OUTLOOK_SEND_EMAIL', { user_id: 'me' });
  assert.ok(rule);

  // Wrong mailbox — the incident: user_id 'me' resolved to breakthroughcoaching.
  clearSenderVerificationCache();
  const wrong = await verifyOutlookSender({
    rule: rule!,
    toolSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    userId: 'me',
    fetchProfile: async () => ({
      successful: true,
      data: { mail: 'nathan@breakthroughcoaching.ai', userPrincipalName: 'nathan@breakthroughcoaching.ai' },
    }),
  });
  assert.equal(wrong.ok, false, 'wrong connected mailbox MUST block the send');
  assert.match(wrong.message ?? '', /nathan@breakthroughcoaching\.ai/);
  assert.match(wrong.message ?? '', /nathan\.reynolds@scorpion\.com/);

  // Right mailbox — verified Scorpion account proceeds.
  clearSenderVerificationCache();
  const right = await verifyOutlookSender({
    rule: rule!,
    toolSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    userId: 'me',
    fetchProfile: async () => ({
      successful: true,
      data: { mail: 'Nathan.Reynolds@scorpion.com', proxyAddresses: ['SMTP:nathan.reynolds@scorpion.com'] },
    }),
  });
  assert.equal(right.ok, true, 'verified correct mailbox must pass');
});

test('verifyOutlookSender fails CLOSED and caches the profile lookup', async () => {
  const rule = findEmailSendConstraint('OUTLOOK_OUTLOOK_SEND_EMAIL', { user_id: 'me' });
  assert.ok(rule);

  // Profile lookup throws → block (a delayed email beats a misdirected one).
  clearSenderVerificationCache();
  const failed = await verifyOutlookSender({
    rule: rule!,
    toolSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    userId: 'me',
    fetchProfile: async () => { throw new Error('composio 503'); },
  });
  assert.equal(failed.ok, false, 'unverifiable sender must fail closed');

  // Unsuccessful profile result → block.
  const unsuccessful = await verifyOutlookSender({
    rule: rule!,
    toolSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    userId: 'me',
    fetchProfile: async () => ({ successful: false, error: 'auth expired' }),
  });
  assert.equal(unsuccessful.ok, false);

  // Non-Outlook send under an Outlook-mailbox constraint → block (cannot verify).
  const gmail = await verifyOutlookSender({
    rule: rule!,
    toolSlug: 'GMAIL_SEND_EMAIL',
    userId: 'me',
    fetchProfile: async () => ({ successful: true, data: { mail: 'whoever@gmail.com' } }),
  });
  assert.equal(gmail.ok, false);

  // Cache: a 17-email batch costs ONE profile call, not 17.
  clearSenderVerificationCache();
  let calls = 0;
  const fetchOnce = async () => {
    calls++;
    return { successful: true, data: { mail: 'nathan.reynolds@scorpion.com' } };
  };
  for (let i = 0; i < 17; i++) {
    const v = await verifyOutlookSender({
      rule: rule!,
      toolSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
      userId: 'me',
      fetchProfile: fetchOnce,
    });
    assert.equal(v.ok, true);
  }
  assert.equal(calls, 1, 'profile lookup must be cached across a batch');
});

test('extractMailboxEmails tolerates wrapper drift', () => {
  assert.deepEqual(
    extractMailboxEmails({ data: { response_data: { mail: 'A@B.com', proxyAddresses: ['SMTP:a@b.com', 'smtp:alias@b.com'] } } }),
    ['a@b.com', 'alias@b.com'],
  );
  assert.deepEqual(extractMailboxEmails({ data: { text: 'profile: someone@x.co' } }), ['someone@x.co']);
  assert.deepEqual(extractMailboxEmails(null), []);
});

test('tool-bound rules: constraints ride with the toolkit they name, globally', () => {
  // The seeded rule names "Outlook" → bound to the outlook toolkit.
  const bound = constraintsForToolkit('outlook');
  assert.equal(bound.length >= 1, true, 'rule naming a toolkit must bind to it');

  const banner = renderToolkitConstraintBanner('outlook');
  assert.ok(banner?.includes('STANDING RULES'), 'banner must render for a bound toolkit');
  assert.ok(banner?.includes('nathan.reynolds@scorpion.com'));

  // Unrelated toolkits carry NO banner — zero noise where no rule binds.
  assert.equal(renderToolkitConstraintBanner('airtable'), null);
  assert.equal(renderToolkitConstraintBanner('salesforce'), null);
  assert.equal(constraintsForToolkit('unknown').length, 0);
  assert.equal(constraintsForToolkit('*').length, 0);
});

test('pinned Outlook calendar reads route to the pinned connection only when the intent names the rule label', () => {
  const saved = rememberFact({
    kind: 'constraint',
    content: 'For Scorpion calendar lookups, use Outlook connection ca_T9pDCuTalAI3 as the Scorpion calendar connection; the other active Outlook connection returned no Scorpion calendar events.',
  });
  assert.equal(saved.kind, 'constraint');

  const routed = findOutlookCalendarReadConstraint(
    'OUTLOOK_GET_CALENDAR_VIEW',
    { start_date_time: '2026-07-02T00:00:00-07:00', end_date_time: '2026-07-03T00:00:00-07:00' },
    'Can you check my Scorpion calendar for tomorrow?',
  );
  assert.equal(routed?.routeConnectionId, 'ca_T9pDCuTalAI3');

  assert.equal(
    findOutlookCalendarReadConstraint('OUTLOOK_GET_CALENDAR_VIEW', {}, 'Can you check my calendar for tomorrow?'),
    null,
    'generic calendar reads must not collapse to one pinned account',
  );
  assert.equal(
    findOutlookCalendarReadConstraint('OUTLOOK_CREATE_EVENT', {}, 'Add this to my Scorpion calendar'),
    null,
    'calendar writes must stay outside the read-route helper',
  );

  // The label is data-driven, not hardcoded: a second pinned calendar with a
  // different org name routes independently, and each intent picks ITS rule.
  const acme = rememberFact({
    kind: 'constraint',
    content: 'For Acme calendar lookups, use Outlook connection ca_AcmeRoute0001.',
  });
  assert.equal(acme.kind, 'constraint');
  assert.equal(
    findOutlookCalendarReadConstraint('OUTLOOK_GET_CALENDAR_VIEW', {}, 'anything on the Acme calendar this week?')?.routeConnectionId,
    'ca_AcmeRoute0001',
  );
  assert.equal(
    findOutlookCalendarReadConstraint('OUTLOOK_GET_CALENDAR_VIEW', {}, 'Can you check my Scorpion calendar for tomorrow?')?.routeConnectionId,
    'ca_T9pDCuTalAI3',
    'with several pinned calendars the intent must route to the rule it names',
  );
});

test('multi-account resolution: routes the send to the constraint-compliant connection', async () => {
  const rule = findEmailSendConstraint('OUTLOOK_OUTLOOK_SEND_EMAIL', { user_id: 'me' });
  assert.ok(rule);

  // Two mailboxes connected ON PURPOSE (scrape both, send from one) — the
  // user's real topology. No explicit connection id on the send.
  const profileByConnection: Record<string, unknown> = {
    ca_breakthrough: { successful: true, data: { mail: 'nathan@breakthroughcoaching.ai' } },
    ca_scorpion: { successful: true, data: { mail: 'nathan.reynolds@scorpion.com' } },
    ca_stale: { successful: false, error: 'token expired' },
  };
  const fetchProfile = async (_slug: string, _args: Record<string, unknown>, connectionId?: string) => {
    const profile = profileByConnection[connectionId ?? ''];
    if (!profile) throw new Error(`no such connection: ${connectionId}`);
    return profile;
  };

  clearSenderVerificationCache();
  const routed = await resolveCompliantSenderConnection({
    rule: rule!,
    toolSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    userId: 'me',
    connections: [
      { connectionId: 'ca_breakthrough', status: 'ACTIVE' },
      { connectionId: 'ca_stale', status: 'EXPIRED' },
      { connectionId: 'ca_scorpion', status: 'ACTIVE' },
    ],
    fetchProfile,
  });
  assert.equal(routed.ok, true, 'a compliant connection must let the send proceed');
  assert.equal(routed.routeConnectionId, 'ca_scorpion', 'send must ROUTE to the verified compliant connection');

  // Metadata hint (accountEmail) probes the likely match first — but the
  // route is still confirmed by a real profile lookup.
  clearSenderVerificationCache();
  let probes: string[] = [];
  const counted = async (slug: string, args: Record<string, unknown>, connectionId?: string) => {
    probes.push(connectionId ?? '');
    return fetchProfile(slug, args, connectionId);
  };
  const metaRouted = await resolveCompliantSenderConnection({
    rule: rule!,
    toolSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    userId: 'me',
    connections: [
      { connectionId: 'ca_breakthrough', status: 'ACTIVE', accountEmail: 'nathan@breakthroughcoaching.ai' },
      { connectionId: 'ca_scorpion', status: 'ACTIVE', accountEmail: 'Nathan.Reynolds@scorpion.com' },
    ],
    fetchProfile: counted,
  });
  assert.equal(metaRouted.routeConnectionId, 'ca_scorpion');
  assert.equal(probes[0], 'ca_scorpion', 'metadata-suggested match must be probed first');
});

test('multi-account resolution: explicit wrong connection blocks and names the compliant one', async () => {
  const rule = findEmailSendConstraint('OUTLOOK_OUTLOOK_SEND_EMAIL', { user_id: 'me' });
  assert.ok(rule);
  const fetchProfile = async (_slug: string, _args: Record<string, unknown>, connectionId?: string) =>
    connectionId === 'ca_scorpion'
      ? { successful: true, data: { mail: 'nathan.reynolds@scorpion.com' } }
      : { successful: true, data: { mail: 'nathan@breakthroughcoaching.ai' } };

  clearSenderVerificationCache();
  const blocked = await resolveCompliantSenderConnection({
    rule: rule!,
    toolSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    userId: 'me',
    explicitConnectionId: 'ca_breakthrough',
    connections: [
      { connectionId: 'ca_breakthrough', status: 'ACTIVE' },
      { connectionId: 'ca_scorpion', status: 'ACTIVE' },
    ],
    fetchProfile,
  });
  assert.equal(blocked.ok, false, 'an explicit non-compliant choice is never silently rerouted');
  assert.match(blocked.message ?? '', /ca_scorpion/, 'block message must name the compliant connection for one-shot recovery');

  // No compliant connection anywhere → block listing the inventory.
  clearSenderVerificationCache();
  const none = await resolveCompliantSenderConnection({
    rule: rule!,
    toolSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    userId: 'me',
    connections: [{ connectionId: 'ca_breakthrough', status: 'ACTIVE' }],
    fetchProfile,
  });
  assert.equal(none.ok, false);
  assert.match(none.message ?? '', /nathan@breakthroughcoaching\.ai/);

  // Zero connections → fail closed.
  const empty = await resolveCompliantSenderConnection({
    rule: rule!,
    toolSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL',
    userId: 'me',
    connections: [],
    fetchProfile,
  });
  assert.equal(empty.ok, false);
});

test('checkConstraintViolation email branch defers to the external verifier', () => {
  // With emailHandledExternally the pattern-only email check must NOT fire —
  // otherwise a profile-verified send would still be blocked for lacking a
  // `from` arg (Outlook sends never carry one).
  const deferred = checkConstraintViolation(
    'composio_execute_tool',
    { action: 'OUTLOOK_OUTLOOK_SEND_EMAIL', user_id: 'me' },
    { emailHandledExternally: true },
  );
  assert.equal(deferred, null);

  // Without the flag (any future non-composio call site) it still guards.
  const direct = checkConstraintViolation(
    'composio_execute_tool',
    { action: 'OUTLOOK_OUTLOOK_SEND_EMAIL', user_id: 'me' },
  );
  assert.ok(direct, 'pattern-only fallback must still catch an unspecified sender');
});
