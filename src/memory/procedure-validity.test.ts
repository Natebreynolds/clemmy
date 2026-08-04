/**
 * Run: npx tsx --test src/memory/procedure-validity.test.ts
 *
 * The 2026-08-03 incident stored `PLACEHOLDER` as a proven tool identifier and
 * later sent it to the provider verbatim. The historical guard checked an
 * exact-match list of seven filler words that did not include it. These tests
 * pin the closed class, and — just as importantly — pin the identifiers that
 * must STILL be accepted, because a guard that over-rejects destroys working
 * memory in exactly the way this one exists to prevent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blockingRefusal,
  describeProcedureValidity,
  isPlaceholderToken,
  validateStoredProcedure,
  type StoredProcedureShape,
} from './procedure-validity.js';

const SLUG = 'GOOGLESHEETS_BATCH_UPDATE';

function check(input: Partial<StoredProcedureShape> & Pick<StoredProcedureShape, 'kind' | 'identifier'>) {
  return validateStoredProcedure({ ...input });
}

// ── the identifier class that caused the incident ────────────────────────────

test('the exact incident token is refused', () => {
  const validity = check({ kind: 'composio', identifier: 'PLACEHOLDER' });
  assert.equal(validity.ok, false, 'PLACEHOLDER was accepted as a tool identifier');
  assert.equal(blockingRefusal(validity)?.code, 'identifier_placeholder');
  assert.match(describeProcedureValidity(validity), /filler token/);
});

test('the whole filler class is refused, not just one spelling', () => {
  for (const filler of [
    'PLACEHOLDER', 'placeholder', '  Placeholder  ', 'TODO', 'tbd', 'FIXME', 'XXX',
    'changeme', 'example', 'sample', 'unset', 'nil', '-', '?', '...',
    '{{tool_slug}}', '<slug>', '[slug]', '${slug}',
    'YOUR_SLUG', 'your-tool', 'TOOL_PLACEHOLDER', 'placeholder-slug', 'sheets.todo',
  ]) {
    assert.equal(isPlaceholderToken(filler), true, `"${filler}" was not recognized as filler`);
    assert.equal(
      check({ kind: 'cli', identifier: filler }).ok, false,
      `"${filler}" was accepted as a tool identifier`,
    );
  }
});

test('the historical seven still refuse, so nothing regressed', () => {
  // The pre-existing guard's exact list. Behavior for these is unchanged.
  for (const legacy of ['', 'null', 'undefined', 'none', 'n/a', 'na', 'unknown']) {
    assert.equal(isPlaceholderToken(legacy), true, `"${legacy}" stopped being filler`);
  }
});

test('real identifiers are ACCEPTED — over-rejection is its own defect', () => {
  const real: Array<[StoredProcedureShape['kind'], string]> = [
    ['cli', 'sf'],
    ['cli', 'netlify'],
    ['cli', 'gh'],
    // A real POSIX command. Deliberately not on the filler list: dropping a
    // working memo is the same damage as keeping a poisoned one.
    ['cli', 'test'],
    // Metasyntactic names stay legal for the same reason. An earlier draft
    // listed these and immediately refused a legitimate store update, which is
    // the over-rejection failure mode caught in the act.
    ['cli', 'foo'],
    ['cli', 'bar'],
    ['cli', 'baz'],
    ['cli', 'npm run build'],
    ['composio', SLUG],
    ['composio', 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW'],
    ['mcp', 'airtable__list_records'],
    // Contains the letters but is not the word.
    ['cli', 'placeholders-cli'],
  ];
  for (const [kind, identifier] of real) {
    assert.equal(
      check({ kind, identifier }).ok, true,
      `${kind}:${identifier} was refused: ${describeProcedureValidity(check({ kind, identifier }))}`,
    );
  }
});

// ── dispatchability defers to the transport adapter ──────────────────────────

test('a composio identifier that cannot dispatch is refused', () => {
  // Shapes that cannot name an action: no operation segment, illegal separator,
  // or free prose.
  for (const bad of ['GOOGLESHEETS', 'Google Sheets Update', 'GOOGLESHEETS-BATCH', 'update the sheet']) {
    const validity = check({ kind: 'composio', identifier: bad });
    assert.equal(validity.ok, false, `"${bad}" was accepted as a composio slug`);
    assert.equal(blockingRefusal(validity)?.code, 'identifier_undispatchable');
  }
  // Case is NOT a dispatchability signal — the adapter folds case before
  // matching, and refusing a real action for its spelling would be
  // over-rejection. Pinned so the memory layer never invents a stricter rule
  // than the dispatcher enforces.
  assert.equal(check({ kind: 'composio', identifier: 'googlesheets_batch_update' }).ok, true);

  // The composio shape is not applied to other kinds; doing so would refuse
  // real CLI and MCP names.
  assert.equal(check({ kind: 'cli', identifier: 'GOOGLESHEETS' }).ok, true);
  assert.equal(check({ kind: 'mcp', identifier: 'GOOGLESHEETS' }).ok, true);
});

// ── argument placeholders are the reusable part and must survive ─────────────

test('a parameterized template is KEPT, holes intact', () => {
  const template = `${SLUG}(arguments={"spreadsheet_id": "{{sheet_id}}", "range": "{{range}}"})`;
  const validity = check({ kind: 'composio', identifier: SLUG, invocationTemplate: template });
  assert.equal(validity.ok, true);
  assert.deepEqual(validity.findings, [], 'a valid parameterized template was flagged');
  assert.equal(validity.invocationTemplate, template, 'the reusable template was dropped');
});

test('a stale template REPAIRS instead of destroying the procedure', () => {
  // The identifier still names a real tool; the executor can re-derive a call.
  // Refusing the whole record here would lose working memory to a cosmetic defect.
  for (const bad of ['call the sheets thing', `${SLUG}(arguments={not json})`, 'TODO', '']) {
    const validity = check({ kind: 'composio', identifier: SLUG, invocationTemplate: bad });
    assert.equal(validity.ok, true, `template "${bad}" wrongly refused the whole procedure`);
    assert.equal(validity.invocationTemplate, undefined, `template "${bad}" survived`);
    assert.equal(validity.findings.length, 1);
    assert.equal(validity.findings[0]!.severity, 'repair');
    assert.match(validity.findings[0]!.code, /^template_/);
  }
});

test('a clean template on a REFUSED identifier does not rescue it', () => {
  const validity = check({
    kind: 'composio',
    identifier: 'PLACEHOLDER',
    invocationTemplate: '{"spreadsheet_id": "{{sheet_id}}"}',
  });
  assert.equal(validity.ok, false);
});

// ── schema drift ─────────────────────────────────────────────────────────────

test('drift refuses only when both fingerprints are known', () => {
  const base = { kind: 'composio' as const, identifier: SLUG };

  const drifted = check({ ...base, schemaFingerprint: 'sha-a', liveSchemaFingerprint: 'sha-b' });
  assert.equal(drifted.ok, false, 'a drifted contract was served');
  assert.equal(blockingRefusal(drifted)?.code, 'schema_drifted');

  assert.equal(check({ ...base, schemaFingerprint: 'sha-a', liveSchemaFingerprint: 'sha-a' }).ok, true);
  // Legacy records have no fingerprint. "Never recorded" is not "drifted" —
  // treating it as drift would quarantine every procedure written before this.
  assert.equal(check({ ...base, schemaFingerprint: 'sha-a' }).ok, true);
  assert.equal(check({ ...base, liveSchemaFingerprint: 'sha-b' }).ok, true);
  assert.equal(check(base).ok, true);
});

// ── the validator stays pure, so both call sites agree ───────────────────────

test('the validator reaches nothing and defers dispatchability to one owner', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, 'procedure-validity.ts'), 'utf-8');
  const imports = [...source.matchAll(/from '([^']+)';/g)].map((m) => m[1]!);
  assert.deepEqual(imports, ['../tools/composio-carrier.js'], 'the validator grew a dependency');
  for (const forbidden of ['process.env', 'readFileSync', 'Date.now', 'new Date', 'BASE_DIR']) {
    assert.equal(source.includes(forbidden), false, `validator references ${forbidden}`);
  }
});

test('the same input always yields the same verdict', () => {
  // Write and read must not be able to disagree about one record.
  const input: StoredProcedureShape = {
    kind: 'composio',
    identifier: SLUG,
    invocationTemplate: `${SLUG}(arguments={"a": "{{b}}"})`,
    schemaFingerprint: 'sha-a',
  };
  const first = JSON.stringify(validateStoredProcedure(input));
  for (let i = 0; i < 5; i += 1) {
    assert.equal(JSON.stringify(validateStoredProcedure(input)), first);
  }
});
