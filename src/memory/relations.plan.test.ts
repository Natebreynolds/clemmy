/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/relations.plan.test.ts
 *
 * Every per-fact statement on fact_entities / fact_resources that filters by
 * link type must seek the primary key by fact. Planned on the truth index
 * `(link_type, entity_id, fact_id)` with only link_type bound, one call walks
 * the whole inferred tier. The pin records the SQL the real code prepares
 * (a spy on the connection's prepare), then checks each plan.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-link-plans-'));

const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const { rememberFact } = await import('./facts.js');
const { recordMemoryEpisode, linkFactEvidence } = await import('./temporal-memory.js');
const { upsertEntity } = await import('./entity-identity.js');
const { upsertResourcePointer } = await import('./source-map.js');
const relations = await import('./relations.js');
const maintenance = await import('./maintenance.js');

const prepared = new Set<string>();

before(() => {
  resetMemoryDb();
  const db = openMemoryDb();
  const original = db.prepare.bind(db);
  (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    prepared.add(sql);
    return original(sql);
  }) as typeof db.prepare;

  const dana = upsertEntity({ type: 'person', name: 'Dana Smith' });
  const acme = upsertEntity({ type: 'company', name: 'Acmecorp' });
  const resource = upsertResourcePointer({ app: 'drive', kind: 'file', name: 'Q3 Pipeline Review.xlsx', ref: 'drive://q3' });
  const content = 'Dana Smith reviewed Q3 Pipeline Review.xlsx with Acmecorp.';
  const episode = recordMemoryEpisode({ kind: 'tool_result', sessionId: 'plan-s', callId: 'plan-c', content });
  const fact = rememberFact({ kind: 'project', content });
  linkFactEvidence({ factId: fact.id, episodeId: episode.id, excerpt: content });
  relations.setFactEntityLinks(fact.id, [dana, acme], { linkType: 'inferred_text', confidence: 0.55 });
  relations.setFactEntityLinks(fact.id, [dana], { linkType: 'stored' });
  relations.setFactResourceLinks(fact.id, [resource.id], { linkType: 'inferred_text', confidence: 0.55 });
  relations.setFactResourceLinks(fact.id, [resource.id], { linkType: 'stored' });
  relations.syncFactEntityLinks();
  relations.syncFactResourceLinks();
  relations.backfillGroundedFactEntityLinks();
  relations.backfillGroundedFactResourceLinks();
  relations.backfillGroundedEntityRelationships();
  maintenance.finalizeGroundedEntityLinksOnBoot();
  maintenance.finalizeGroundedResourceLinksOnBoot();
  (db as { prepare: typeof db.prepare }).prepare = original;
});

const PER_FACT = /\bfact_id\s*=\s*(\?|cf\.id)/;
const LINK_TABLE = /\bfact_(entities|resources)\b/;

function perFactLinkStatements(): string[] {
  return [...prepared].filter((sql) => LINK_TABLE.test(sql) && /link_type/.test(sql) && PER_FACT.test(sql)
    && !/^\s*INSERT/i.test(sql));
}

function planOf(sql: string): string[] {
  const params = (sql.match(/\?/g) ?? []).map(() => 1);
  const db = openMemoryDb();
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail);
}

test('the §5.1 statements are all exercised by the pin', () => {
  const sqls = perFactLinkStatements().map((sql) => sql.replace(/\s+/g, ' '));
  const has = (pattern: RegExp) => assert.ok(sqls.some((sql) => pattern.test(sql)), `no captured statement matches ${pattern}`);
  has(/DELETE FROM fact_entities WHERE fact_id = \? AND entity_id = \? AND \+link_type = 'inferred_text'/);
  has(/DELETE FROM fact_entities WHERE fact_id = \? AND \+?link_type IN \('stored','extracted'\)/);
  has(/DELETE FROM fact_resources WHERE fact_id = \? AND resource_id = \? AND \+link_type = 'inferred_text'/);
  has(/DELETE FROM fact_resources WHERE fact_id = \? AND \+?link_type IN \('stored','extracted'\)/);
  has(/FROM fact_entities fe WHERE fe\.fact_id = cf\.id AND \+?fe\.link_type = 'inferred_text'/);
  has(/FROM fact_resources fr WHERE fr\.fact_id = cf\.id AND \+?fr\.link_type = 'inferred_text'/);
  has(/WHERE fe\.fact_id = \? AND \+?fe\.link_type = 'inferred_text'/);
  has(/WHERE fr\.fact_id = \? AND \+?fr\.link_type = 'inferred_text'/);
  // The one-time boot counts (maintenance.ts finalizers).
  has(/SELECT COUNT\((DISTINCT cf\.id|\*)\) AS count FROM consolidated_facts cf .*fact_entities fe/);
  has(/SELECT COUNT\((DISTINCT cf\.id|\*)\) AS count FROM consolidated_facts cf .*fact_resources fr/);
});

test('no per-fact link statement is planned on the truth index without the fact id', () => {
  const offenders: string[] = [];
  for (const sql of perFactLinkStatements()) {
    for (const detail of planOf(sql)) {
      // A search bound only by link_type, or a scan with no bound at all,
      // walks the tier instead of one fact's rows.
      const truth = /idx_fact_(entities|resources)_truth(?: \(([^)]*)\))?/.exec(detail);
      if (truth && !/fact_id/.test(truth[2] ?? '')) offenders.push(`${detail}\n    for ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the per-fact lookups seek the primary key by fact', () => {
  for (const sql of perFactLinkStatements()) {
    const plan = planOf(sql).join(' | ');
    const scansLinks = /\b(SCAN|SEARCH) (fe|fr|fact_entities|fact_resources)\b/.test(plan);
    if (!scansLinks) continue;
    assert.match(plan, /sqlite_autoindex_fact_(entities|resources)_1 \(fact_id=\?/, `plan for ${sql.replace(/\s+/g, ' ').slice(0, 120)}: ${plan}`);
  }
});

test('every paged selection reads one primary-key range of facts per page', () => {
  const paged = [...prepared].filter((sql) => /\bcf\.id > \? AND cf\.id <= \?/.test(sql));
  assert.ok(paged.length >= 3, `paged selections captured: ${paged.length}`);
  for (const sql of paged) {
    const plan = planOf(sql);
    assert.equal(plan[0], 'SEARCH cf USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)', `${sql.replace(/\s+/g, ' ').slice(0, 120)}: ${plan.join(' | ')}`);
  }
});
