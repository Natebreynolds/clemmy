/**
 * Run: npx tsx --test src/tools/composio-carrier.test.ts
 *
 * The 2026-08-02 calendar incident spent four pre-dispatch failures on
 * representation, not meaning: `arguments` as an object, `slug` instead of
 * `tool_slug`, an `arguments_json` nesting, then an object again. Every one of
 * those was the same call. These tests pin that one adapter now settles all of
 * it deterministically — and that the things which SHOULD fail still do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composioCarrierDigest,
  describeCarrierRefusal,
  normalizeComposioCarrierInput,
  parseLegacyInvocationTemplate,
  serializeComposioCarrier,
  stripVolatileConnectionArgs,
  COMPOSIO_CARRIER_CONTRACT,
  COMPOSIO_CARRIER_SCHEMA_HASH,
} from './composio-carrier.js';

const SLUG = 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW';
const ARGS = { start_iso: '{{start_iso}}', end_iso: '{{end_iso}}', timezone: 'America/Denver' };

function ok(raw: unknown) {
  const result = normalizeComposioCarrierInput(raw);
  assert.equal(result.ok, true, `expected acceptance, got: ${JSON.stringify(result)}`);
  return result as Extract<typeof result, { ok: true }>;
}
function refused(raw: unknown) {
  const result = normalizeComposioCarrierInput(raw);
  assert.equal(result.ok, false, `expected refusal, got: ${JSON.stringify(result)}`);
  return result as Extract<typeof result, { ok: false }>;
}

// ── every representation of one call is one call ─────────────────────────────

test('object, JSON-string, and alias representations normalize identically', () => {
  const authoritative = ok({ tool_slug: SLUG, arguments: JSON.stringify(ARGS) });
  assert.deepEqual(authoritative.adapted, [], 'the authoritative shape needed no repair');

  const asObject = ok({ tool_slug: SLUG, arguments: ARGS });
  assert.ok(asObject.adapted.includes('arguments_object_serialized'));

  const asAlias = ok({ tool_slug: SLUG, arguments_json: JSON.stringify(ARGS) });
  assert.ok(asAlias.adapted.includes('arguments_json_alias'));

  const doubleEncoded = ok({ tool_slug: SLUG, arguments: JSON.stringify(JSON.stringify(ARGS)) });
  assert.ok(doubleEncoded.adapted.includes('arguments_double_encoded'));

  // All four mean the same call, so all four must be byte-equivalent — and
  // must produce one digest, because effect classification and approval
  // fingerprinting key off it. Two spellings asking for approval twice would
  // be the same defect wearing different clothes.
  const forms = [authoritative, asObject, asAlias, doubleEncoded];
  const wire = forms.map((form) => JSON.stringify(serializeComposioCarrier(form.canonical)));
  assert.equal(new Set(wire).size, 1, `representations diverged on the wire: ${wire.join(' | ')}`);
  const digests = forms.map((form) => composioCarrierDigest(form.canonical));
  assert.equal(new Set(digests).size, 1, 'representations produced different digests');
});

test('argument key ORDER never changes the digest', () => {
  const forward = ok({ tool_slug: SLUG, arguments: JSON.stringify({ a: 1, b: { y: 2, x: 3 } }) });
  const reversed = ok({ tool_slug: SLUG, arguments: JSON.stringify({ b: { x: 3, y: 2 }, a: 1 }) });
  assert.equal(
    composioCarrierDigest(forward.canonical),
    composioCarrierDigest(reversed.canonical),
    'key order changed the approval fingerprint',
  );
});

test('the wire form is a JSON string, and absent arguments are null not "{}"', () => {
  const wire = serializeComposioCarrier(ok({ tool_slug: SLUG, arguments: ARGS }).canonical);
  assert.equal(typeof wire.arguments, 'string');
  assert.deepEqual(JSON.parse(wire.arguments as string), ARGS);
  assert.equal(wire.tool_slug, SLUG);

  for (const empty of [undefined, null, '', {}]) {
    const none = serializeComposioCarrier(ok({ tool_slug: SLUG, arguments: empty }).canonical);
    assert.equal(none.arguments, null, `empty arguments ${JSON.stringify(empty)} became ${none.arguments}`);
  }
});

// ── volatile identity never travels ──────────────────────────────────────────

test('a baked connection id is stripped wherever it appears', () => {
  for (const key of ['connected_account_id', 'connectedAccountId', 'connection_id', 'connectionId']) {
    const result = ok({ tool_slug: SLUG, arguments: { ...ARGS, [key]: 'ca_rotates_on_reauth' } });
    assert.equal(key in result.canonical.args, false, `${key} survived normalization`);
    assert.ok(result.adapted.includes('connection_id_stripped'));
    assert.equal(
      JSON.stringify(serializeComposioCarrier(result.canonical)).includes('ca_rotates'), false,
      `${key} reached the wire`,
    );
  }
  // And a call that never had one is not marked as adapted.
  assert.equal(ok({ tool_slug: SLUG, arguments: ARGS }).adapted.includes('connection_id_stripped'), false);

  const direct = stripVolatileConnectionArgs({ a: 1, connected_account_id: 'ca_x' });
  assert.deepEqual(direct.args, { a: 1 });
  assert.equal(direct.stripped, true);
});

// ── what must still fail ─────────────────────────────────────────────────────

test('a misspelled slug key is REFUSED, but the refusal names the right one', () => {
  // Deliberately not repaired into `tool_slug`: silently accepting `slug` would
  // teach a contract that does not exist, and the next failure would be harder
  // to place. One refusal that names the correct field ends the guessing.
  for (const drifted of ['slug', 'toolSlug', 'tool', 'action', 'tool_name', 'name']) {
    const result = refused({ [drifted]: SLUG, arguments: JSON.stringify(ARGS) });
    assert.deepEqual(result.violations, [drifted]);
    assert.match(result.error, /tool_slug/);
    assert.equal(result.schemaHash, COMPOSIO_CARRIER_SCHEMA_HASH);
    assert.equal(result.contract, COMPOSIO_CARRIER_CONTRACT);
    // It carries a shape the caller can send verbatim, so one round trip fixes it.
    assert.ok(result.repair, `no repair offered for "${drifted}"`);
    assert.equal(result.repair!.tool_slug, SLUG);
    assert.deepEqual(JSON.parse(result.repair!.arguments as string), ARGS);
    // And the repair is itself valid — a suggestion that would fail again is worse than none.
    assert.equal(normalizeComposioCarrierInput(result.repair).ok, true);
  }
});

test('semantic failures still fail closed', () => {
  const badJson = refused({ tool_slug: SLUG, arguments: '{ not json' });
  assert.match(badJson.error, /not valid JSON/);
  assert.equal(badJson.repair, null, 'unparseable input must not produce an invented repair');

  const scalar = refused({ tool_slug: SLUG, arguments: '42' });
  assert.match(scalar.error, /JSON object/);

  for (const missing of [{}, { arguments: JSON.stringify(ARGS) }, { tool_slug: '   ' }, { tool_slug: 7 }]) {
    const result = refused(missing);
    assert.match(result.error, /tool_slug/);
  }
  for (const notObject of [null, 'string', 42, []]) {
    assert.match(refused(notObject).error, /must be an object/);
  }
});

test('a refusal reads as one actionable instruction', () => {
  const rendered = describeCarrierRefusal(refused({ slug: SLUG, arguments: ARGS }));
  assert.match(rendered, /tool_slug/);
  assert.match(rendered, /JSON \*string\*/);
  assert.match(rendered, /Send exactly this instead/);
  assert.match(rendered, new RegExp(COMPOSIO_CARRIER_SCHEMA_HASH));
});

// ── legacy templates become executable ───────────────────────────────────────

test('legacy stored templates parse into canonical arguments, placeholders intact', () => {
  const forms = [
    `${SLUG}(arguments={"start_iso": "{{start_iso}}", "end_iso": "{{end_iso}}", "timezone": "America/Denver"})`,
    `arguments={"start_iso": "{{start_iso}}", "end_iso": "{{end_iso}}", "timezone": "America/Denver"}`,
    `{"start_iso": "{{start_iso}}", "end_iso": "{{end_iso}}", "timezone": "America/Denver"}`,
    `{"tool_slug": "${SLUG}", "arguments": "{\\"start_iso\\":\\"{{start_iso}}\\",\\"end_iso\\":\\"{{end_iso}}\\",\\"timezone\\":\\"America/Denver\\"}"}`,
  ];
  for (const template of forms) {
    const parsed = parseLegacyInvocationTemplate(template, SLUG);
    assert.ok(parsed, `template did not parse: ${template.slice(0, 60)}`);
    assert.equal(parsed!.canonical.toolSlug, SLUG);
    // Placeholders are the reusable part. Losing them turns a procedure into a
    // recording of one past call.
    assert.equal(parsed!.canonical.args.start_iso, '{{start_iso}}');
    assert.equal(parsed!.canonical.args.end_iso, '{{end_iso}}');
    assert.equal(parsed!.canonical.args.timezone, 'America/Denver');
    assert.ok(parsed!.adapted.includes('legacy_template_parsed'));
  }
});

test('a legacy template carrying a rotating connection id is cleaned', () => {
  const parsed = parseLegacyInvocationTemplate(
    `${SLUG}(arguments={"start_iso": "{{start_iso}}", "connected_account_id": "ca_dead_beef"})`,
    SLUG,
  );
  assert.ok(parsed);
  assert.equal('connected_account_id' in parsed!.canonical.args, false);
  assert.ok(parsed!.adapted.includes('connection_id_stripped'));
});

test('an ununderstandable template returns null rather than a guess', () => {
  for (const template of [
    undefined, '', '   ',
    'call the calendar thing with tomorrow',
    `${SLUG}(arguments={not json at all})`,
  ]) {
    assert.equal(
      parseLegacyInvocationTemplate(template, SLUG), null,
      `template ${JSON.stringify(template)} was interpreted anyway`,
    );
  }
  // No slug anywhere, and none supplied → nothing to execute.
  assert.equal(parseLegacyInvocationTemplate('{"a": 1}'), null);
});

test('trailing commas in a model-written template are repaired structurally', () => {
  const parsed = parseLegacyInvocationTemplate(`${SLUG}(arguments={"a": 1, "b": 2,})`, SLUG);
  assert.ok(parsed);
  assert.deepEqual(parsed!.canonical.args, { a: 1, b: 2 });
});

// ── the module stays a pure transport adapter ────────────────────────────────

test('the adapter reads nothing and reaches nowhere', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, 'composio-carrier.ts'), 'utf-8');
  const imports = [...source.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map((m) => m[1]!);
  assert.deepEqual(imports, ['node:crypto'], 'the transport adapter grew a dependency');
  for (const forbidden of ['process.env', 'readFileSync', 'fetch(', 'BASE_DIR']) {
    assert.equal(source.includes(forbidden), false, `adapter references ${forbidden}`);
  }
});
