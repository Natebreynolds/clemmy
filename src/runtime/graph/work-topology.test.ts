/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/graph/work-topology.test.ts
 *
 * Live 2026-09-02 (chat, "update the FL tab"): the model's plan was refused on
 * two things the host could settle itself — a coverage pairing derivable from
 * the cardinality it already wrote, and a 154-character capability ref that
 * tool_search had disclosed one minute earlier. The turn died "same wall
 * twice". These pin that the host derives the pairing and accepts its own ids.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { validateWorkTopology, WorkTopologyIdSchema } = await import('./work-topology.js');
const { WORK_ID_MAX_CHARS } = await import('../../shared/work-id.js');

test('the live FL-tab topology is admitted: the producer becomes complete_set once, the per-geo read becomes single each', () => {
  const live = {
    version: 1,
    operations: [
      { id: 'read_fl_tab', effect: 'read', coverage: 'single', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
      { id: 'query_sf_counts_per_geo', effect: 'read', coverage: 'complete_set', dependsOn: ['read_fl_tab'], dataFrom: ['read_fl_tab'], cardinality: { kind: 'each', universeId: 'fl_geos' } },
    ],
    universes: [{ id: 'fl_geos', seal: 'complete_source_receipt', producedBy: 'read_fl_tab', memberIdPointer: '' }],
  };
  const validated = validateWorkTopology(live);
  assert.equal(validated.ok, true, JSON.stringify(validated));
  if (!validated.ok) return;
  const byId = new Map(validated.topology.operations.map((op) => [op.id, op]));
  assert.equal(byId.get('read_fl_tab')?.coverage, 'complete_set');
  assert.equal(byId.get('read_fl_tab')?.cardinality.kind, 'once');
  assert.equal(byId.get('query_sf_counts_per_geo')?.coverage, 'single');
  assert.equal(byId.get('query_sf_counts_per_geo')?.cardinality.kind, 'each');
});

test('a read with no coverage at all is derived the same way; a genuinely ambiguous pair still refuses with the fix named', () => {
  const missing = validateWorkTopology({
    version: 1,
    operations: [
      { id: 'src', effect: 'read', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
      { id: 'per', effect: 'read', dependsOn: ['src'], dataFrom: [], cardinality: { kind: 'each', universeId: 'u' } },
    ],
    universes: [{ id: 'u', seal: 'complete_source_receipt', producedBy: 'src', memberIdPointer: '' }],
  });
  assert.equal(missing.ok, true, JSON.stringify(missing));
  const ambiguous = validateWorkTopology({
    version: 1,
    operations: [{ id: 'a', effect: 'read', coverage: 'accepted_set', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } }],
    universes: [],
  });
  assert.equal(ambiguous.ok, false);
  assert.ok(!ambiguous.ok && ambiguous.errors.some((e) => /coverage and cardinality describe different read sets/.test(e)));
});

test('every id the host mints is an id the host accepts: a 154-character reacquired live ref and a 128-character resolved ref both pass', () => {
  const live = 'cap:live:v1:2494204d08aa1018c315c54b:b96b480702e2fbe61508025c:1539af973b7b755dfe412da0205910e6b45d0e9785d635f02930dbd922fa09ca:reacquired:12ad21aefdab';
  assert.ok(live.length > 128, 'longer than the old bound');
  const resolved = 'cap:resolved:googlesheets_spreadsheets_values_batch_get_by_data_filter:GOOGLESHEETS_SPREADSHEETS_VALUES_BATCH_GET_BY_DATA_FILTER';
  assert.equal(resolved.length, 128);
  assert.equal(WorkTopologyIdSchema.safeParse(live).success, true);
  assert.equal(WorkTopologyIdSchema.safeParse(resolved).success, true);
  assert.equal(WorkTopologyIdSchema.safeParse('x'.repeat(WORK_ID_MAX_CHARS)).success, true);
  assert.equal(WorkTopologyIdSchema.safeParse('x'.repeat(WORK_ID_MAX_CHARS + 1)).success, false, 'the bound is still a bound');
  assert.equal(WorkTopologyIdSchema.safeParse('cap:bad ref').success, false, 'the alphabet is unchanged');
});

test('a universe sealed by a producer outside the topology is refused with the repair named', async () => {
  const { validateWorkTopology } = await import('./work-topology.js');
  const validated = validateWorkTopology({
    version: 1,
    operations: [{ id: 'write_each', effect: 'local_write', coverage: null, dependsOn: [], dataFrom: [],
      cardinality: { kind: 'each', universeId: 'accounts' } }],
    universes: [{ id: 'accounts', seal: 'complete_source_receipt', producedBy: 'toolu_from_an_earlier_turn', memberIdPointer: '/Id' }],
  });
  assert.equal(validated.ok, false);
  const message = validated.ok ? '' : validated.errors.join('; ');
  assert.match(message, /producedBy to a read operation in THIS topology/);
  assert.match(message, /accepted_input/);
  assert.match(message, /earlier turn is not an operation/);
});
