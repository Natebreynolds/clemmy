import type Database from 'better-sqlite3';
import { extractGroundedUserProjects } from './grounded-user-projects.js';
import { groundedEntityMentionIds } from './grounded-entity-mentions.js';

/** Carry identity evidence, never the old fact's value or applicability. The
 * canonical name must still occur in both facts and in the original evidence.
 * Only an already committed direct supersession can use this handoff. */
export function retainFactEntityLinks(db: Database.Database, fromId: number, toId: number): number {
  if (fromId === toId) return 0;
  const pair = db.prepare(`SELECT old.content AS old_content, newer.content AS new_content
    FROM consolidated_facts old JOIN consolidated_facts newer ON newer.id = old.superseded_by_fact_id
    WHERE old.id = ? AND newer.id = ? AND old.active = 0 AND newer.active = 1`).get(fromId, toId) as
    { old_content: string; new_content: string } | undefined;
  if (!pair) return 0;
  const edges = db.prepare(`SELECT fe.*, e.canonical_name FROM fact_entities fe
    JOIN entities e ON e.id = fe.entity_id
    WHERE fe.fact_id = ? AND fe.link_type IN ('stored','extracted')
      AND fe.evidence_episode_id IS NOT NULL AND fe.evidence_excerpt IS NOT NULL`).all(fromId) as Array<{
        entity_id: number; canonical_name: string; link_type: string; confidence: number;
        evidence_episode_id: string; evidence_excerpt: string;
      }>;
  const entities = edges.map(e => ({ id: e.entity_id, canonicalName: e.canonical_name, names: [e.canonical_name] }));
  // A newly named longer project must suppress a contained old name even
  // before the new project has a registry node (e.g. Alpha 2041 Extended).
  const knownNames = new Set(entities.map(e => e.canonicalName.toLowerCase()));
  for (const name of extractGroundedUserProjects(pair.new_content)) {
    if (!knownNames.has(name.toLowerCase())) entities.push({ id: -(entities.length + 1), canonicalName: name, names: [name] });
  }
  const oldMentions = new Set(groundedEntityMentionIds(pair.old_content, entities, true));
  const newMentions = new Set(groundedEntityMentionIds(pair.new_content, entities, true));
  let count = 0;
  const insert = db.prepare(`INSERT OR IGNORE INTO fact_entities
    (fact_id, entity_id, created_at, link_type, confidence, evidence_episode_id, evidence_excerpt)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const edge of edges) {
    if (!oldMentions.has(edge.entity_id) || !newMentions.has(edge.entity_id)
      || !groundedEntityMentionIds(edge.evidence_excerpt, entities, true).includes(edge.entity_id)) continue;
    count += insert.run(toId, edge.entity_id, new Date().toISOString(), edge.link_type,
      edge.confidence, edge.evidence_episode_id, edge.evidence_excerpt).changes;
  }
  return count;
}
