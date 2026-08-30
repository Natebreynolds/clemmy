import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';

const TEST_HOME = '/tmp/clemmy-standing-policy-registry-fail-closed';
process.env.CLEMENTINE_HOME = TEST_HOME;

const { closeMemoryDb, openMemoryDb, resetMemoryDb } = await import('../../memory/db.js');
const { rememberFact } = await import('../../memory/facts.js');
const { sealStandingPolicyDescriptor } = await import('../../memory/policy-enforcement.js');
const { checkComposioConstraintViolation } = await import('../../integrations/composio/standing-policy-adapter.js');

beforeEach(() => {
  closeMemoryDb();
  resetMemoryDb();
  rmSync(TEST_HOME, { recursive: true, force: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

function seed(): { id: number; content: string; descriptorJson: string } {
  const content = 'Always call Salesforce via the local sf CLI, never via the Composio Salesforce toolkit because it is expired.';
  const fact = rememberFact({ kind: 'constraint', content });
  const descriptorJson = (openMemoryDb().prepare(
    'SELECT applies_to_json FROM memory_policies WHERE fact_id = ?',
  ).get(fact.id) as { applies_to_json: string }).applies_to_json;
  return { id: fact.id, content, descriptorJson };
}

function evaluate() {
  return checkComposioConstraintViolation(
    'composio_execute_tool',
    'SALESFORCE_EXECUTE_SOQL_QUERY',
    { query: 'SELECT Id FROM Account' },
    { senderIdentityHandledExternally: true },
  );
}

test('byte-tampered compiled JSON fails closed instead of disappearing from dispatch', () => {
  const seeded = seed();
  const tampered = JSON.parse(seeded.descriptorJson) as Record<string, unknown>;
  (tampered.directives as Array<Record<string, unknown>>)[0]!.reason = 'tampered';
  openMemoryDb().prepare('UPDATE memory_policies SET applies_to_json = ? WHERE fact_id = ?')
    .run(JSON.stringify(tampered), seeded.id);
  const violation = evaluate();
  assert.equal(violation?.constraint.id, -1);
  assert.equal(violation?.violatingField, 'policy registry');
});

test('descriptor whose source digest is stale fails closed', () => {
  const seeded = seed();
  const db = openMemoryDb();
  db.prepare('UPDATE consolidated_facts SET content = ?, updated_at = ? WHERE id = ?')
    .run(`${seeded.content} changed`, new Date().toISOString(), seeded.id);
  // The conservative content-update trigger correctly demoted the row. Model a
  // torn/manual registry write that restores the old dispatch projection so
  // the read side must detect the source/descriptor mismatch.
  db.prepare(`
    UPDATE memory_policies
    SET policy_type = 'hard_constraint', enforcement = 'dispatch', applies_to_json = ?
    WHERE fact_id = ?
  `).run(seeded.descriptorJson, seeded.id);
  assert.equal(evaluate()?.constraint.id, -1);
});

test('freshly sealed descriptor for an unregistered adapter fails closed', () => {
  const seeded = seed();
  const parsed = JSON.parse(seeded.descriptorJson) as Record<string, unknown>;
  const { seal: _seal, ...body } = parsed;
  body.compiler = { ...(body.compiler as Record<string, unknown>), adapterId: 'unknown-adapter' };
  const unknown = sealStandingPolicyDescriptor(body as never);
  openMemoryDb().prepare('UPDATE memory_policies SET applies_to_json = ? WHERE fact_id = ?')
    .run(JSON.stringify(unknown), seeded.id);
  assert.equal(evaluate()?.constraint.id, -1);
});
