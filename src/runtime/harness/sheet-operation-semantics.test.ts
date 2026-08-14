import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyComposioActionConsequence,
  composioSlugEffectEvidence,
} from '../../integrations/composio/slug-effect.js';
import { documentedComposioOperationSemantic } from '../../integrations/composio/operation-semantics.js';
import { canonicalizePendingActionCall } from '../../tools/pending-action-admission.js';
import { artifactIntentForTool } from './artifact-ledger.js';
import { classifyExternalWrite } from './confirm-first-gate.js';
import { classifyCanonicalExternalEffect } from './execution-gate.js';
import { pendingActionRequiresHumanApproval } from './pending-action-policy.js';

const rows = [
  { name: 'Lure Fish House', rating: 4.6, address: '60 S California St, Ventura, CA' },
  { name: 'Cafe Fiore', rating: 4.5, address: '66 S California St, Ventura, CA' },
  { name: 'Rumfish y Vino', rating: 4.5, address: '34 N Palm St, Ventura, CA' },
  { name: 'The Cave', rating: 4.5, address: '4435 McGrath St, Ventura, CA' },
  { name: 'Paradise Pantry', rating: 4.4, address: '222 E Main St, Ventura, CA' },
];

const sheetArgs = {
  title: 'Top 5 Ventura Restaurants',
  sheet_name: 'Restaurants',
  sheet_json: rows,
};

const sheetPayload = {
  tool_slug: 'GOOGLESHEETS_SHEET_FROM_JSON',
  arguments: JSON.stringify(sheetArgs),
  connected_account_id: 'ca_google_sheets_owner',
};

test('one documented operation descriptor owns every Sheets constructor alias', () => {
  for (const action of [
    'GOOGLESHEETS_SHEET_FROM_JSON',
    'GOOGLE_SHEETS_SHEET_FROM_JSON',
    'cx_googlesheets_sheet_from_json',
    'googlesheets__sheet_from_json',
  ]) {
    assert.deepEqual(documentedComposioOperationSemantic(action), {
      effect: 'write',
      reversibility: 'reversible',
      consequence: 'create',
      rootArtifact: { kind: 'resource', provider: 'googlesheets' },
    }, action);
    assert.equal(classifyComposioActionConsequence(action), 'create', action);
  }
  assert.equal(
    composioSlugEffectEvidence('GOOGLESHEETS_SHEET_FROM_JSON'),
    'write',
    'the noun-shaped constructor has affirmative mutation evidence',
  );
});

test('Ventura Sheet creation is a known reversible mutation on every trusted carrier', () => {
  const carriers: Array<[string, unknown]> = [
    ['composio_execute_tool', sheetPayload],
    ['mcp__clementine-local__composio_execute_tool', sheetPayload],
    ['cx_googlesheets_sheet_from_json', sheetArgs],
    ['mcp__clementine-local__cx_googlesheets_sheet_from_json', sheetArgs],
    ['mcp__googlesheets__sheet_from_json', sheetArgs],
  ];
  for (const [toolName, payload] of carriers) {
    const effect = classifyCanonicalExternalEffect(toolName, payload);
    assert.equal(effect.external, true, toolName);
    assert.equal(effect.mutating, true, toolName);
    assert.equal(effect.irreversible, false, toolName);
    assert.equal(effect.reversibility, 'reversible', toolName);
    assert.equal(effect.classificationKnown, true, toolName);
  }

  assert.deepEqual(
    classifyCanonicalExternalEffect('GOOGLESHEETS_SHEET_FROM_JSON', sheetArgs),
    {
      external: false,
      mutating: false,
      irreversible: false,
      reversibility: 'read_only',
      classificationKnown: true,
    },
    'a bare provider slug alone is not allowed to fabricate external-carrier provenance',
  );
  const foreignLookalike = classifyCanonicalExternalEffect(
    'mcp__foreign__cx_googlesheets_sheet_from_json',
    sheetArgs,
  );
  assert.equal(foreignLookalike.external, true);
  assert.equal(foreignLookalike.mutating, true);
  assert.equal(foreignLookalike.classificationKnown, false, 'a foreign cx lookalike cannot borrow trusted action identity');
  assert.equal(foreignLookalike.reversibility, 'unknown');
});

test('Ventura request authority does not card the reversible Sheet; unknown mutations and email sends still do', () => {
  const sheet = classifyExternalWrite('composio_execute_tool', sheetPayload);
  assert.deepEqual(sheet, {
    external: true,
    mutating: true,
    irreversible: false,
    reversibility: 'reversible',
    shapeKey: 'GOOGLESHEETS_SHEET_FROM_JSON',
    classificationKnown: true,
  });
  assert.equal(pendingActionRequiresHumanApproval({
    kind: 'external_write',
    toolName: 'composio_execute_tool',
    payload: sheetPayload,
  }), false, 'the user-requested reversible Sheet may execute without a human approval card');

  const unknownPayload = {
    tool_slug: 'ACME_TRANSFORM_BLOB',
    arguments: JSON.stringify({ source: 'restaurants', destination: 'unknown' }),
    connected_account_id: 'ca_acme_owner',
  };
  const unknown = classifyExternalWrite('composio_execute_tool', unknownPayload);
  assert.equal(unknown.external, true);
  assert.equal(unknown.mutating, true);
  assert.equal(unknown.irreversible, false);
  assert.equal(unknown.reversibility, 'unknown', 'not-irreversible is not positive evidence of reversibility');
  assert.equal(unknown.classificationKnown, false);
  assert.equal(pendingActionRequiresHumanApproval({
    kind: 'external_write',
    toolName: 'composio_execute_tool',
    payload: unknownPayload,
  }), true, 'an unfamiliar external mutation still fails closed');

  const emailPayload = {
    tool_slug: 'OUTLOOK_SEND_EMAIL',
    arguments: JSON.stringify({
      to_recipients: [{ emailAddress: { address: 'nathan@example.ai' } }],
      subject: 'Ventura restaurants',
      body: 'Here is the Sheet link.',
    }),
    connected_account_id: 'ca_outlook_owner',
  };
  const email = classifyExternalWrite('composio_execute_tool', emailPayload);
  assert.equal(email.classificationKnown, true);
  assert.equal(email.irreversible, true);
  assert.equal(email.reversibility, 'irreversible');
  assert.equal(pendingActionRequiresHumanApproval({
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payload: emailPayload,
  }), true, 'the irreversible email remains approval-gated');
});

test('bare pending-action spelling canonicalizes before policy and artifact intent stays the same', () => {
  const canonical = canonicalizePendingActionCall(
    'GOOGLESHEETS_SHEET_FROM_JSON',
    sheetArgs,
  );
  assert.deepEqual(canonical, {
    toolName: 'composio_execute_tool',
    payload: {
      tool_slug: 'GOOGLESHEETS_SHEET_FROM_JSON',
      arguments: JSON.stringify(sheetArgs),
      connected_account_id: null,
    },
  });
  assert.equal(pendingActionRequiresHumanApproval({
    kind: 'external_write',
    toolName: canonical.toolName,
    payload: canonical.payload,
  }), false);

  for (const [toolName, payload] of [
    ['composio_execute_tool', sheetPayload],
    ['cx_googlesheets_sheet_from_json', sheetArgs],
    ['GOOGLESHEETS_SHEET_FROM_JSON', sheetArgs],
  ] as const) {
    const intent = artifactIntentForTool(toolName, payload);
    assert.equal(intent?.kind, 'resource', toolName);
    assert.equal(intent?.provider, 'googlesheets', toolName);
    assert.equal(intent?.slotKey, 'resource:primary', toolName);
    assert.equal(intent?.title, 'Top 5 Ventura Restaurants', toolName);
  }
});

test('nearby noun-shaped operations cannot borrow the documented Sheet semantic', () => {
  assert.equal(documentedComposioOperationSemantic('ACME_SHEET_FROM_JSON'), null);
  const effect = classifyCanonicalExternalEffect('mcp__acme__sheet_from_json', sheetArgs);
  assert.equal(effect.external, true);
  assert.equal(effect.mutating, true);
  assert.equal(effect.irreversible, false);
  assert.equal(effect.reversibility, 'unknown');
  assert.equal(effect.classificationKnown, false);
});
