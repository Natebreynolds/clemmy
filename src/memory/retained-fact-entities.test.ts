import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { retainFactEntityLinks } from './retained-fact-entities.js';
test('supersession retains unchanged grounded identity, not values, inferred links or renamed scope', () => {
 const db=new Database(':memory:');
 try {
 db.exec(`CREATE TABLE consolidated_facts(id INTEGER PRIMARY KEY, content TEXT, active INTEGER, superseded_by_fact_id INTEGER);
 CREATE TABLE entities(id INTEGER PRIMARY KEY, canonical_name TEXT);
 CREATE TABLE fact_entities(fact_id INTEGER, entity_id INTEGER, created_at TEXT, link_type TEXT, confidence REAL, evidence_episode_id TEXT, evidence_excerpt TEXT, PRIMARY KEY(fact_id,entity_id));`);
 db.prepare('INSERT INTO consolidated_facts VALUES(?,?,?,?)').run(1,'Project Alder Archive 2041: hours.',0,2);
 db.prepare('INSERT INTO consolidated_facts VALUES(?,?,?,?)').run(2,'Project Alder Archive 2041: minutes.',1,null);
 db.prepare('INSERT INTO entities VALUES(?,?)').run(1,'Alder Archive 2041');
 db.prepare('INSERT INTO fact_entities VALUES(?,?,?,?,?,?,?)').run(1,1,'old','extracted',1,'original','Project Alder Archive 2041: hours.');
 assert.equal(retainFactEntityLinks(db,1,2),1);
 assert.deepEqual(db.prepare('SELECT evidence_episode_id,evidence_excerpt FROM fact_entities WHERE fact_id=2').get(),{evidence_episode_id:'original',evidence_excerpt:'Project Alder Archive 2041: hours.'});
 assert.equal(retainFactEntityLinks(db,1,2),0,'idempotent');
 db.exec('DELETE FROM fact_entities WHERE fact_id=2');
 db.prepare('UPDATE consolidated_facts SET content=? WHERE id=2').run('Project Alder Archive 2042: minutes.');
 assert.equal(retainFactEntityLinks(db,1,2),0,'renamed project must not inherit');
 db.prepare('UPDATE consolidated_facts SET content=? WHERE id=2').run('Project Alder Archive 2041 Extended: minutes.');
 assert.equal(retainFactEntityLinks(db,1,2),0,'longer new name must not inherit old prefix');
 db.prepare('UPDATE consolidated_facts SET content=? WHERE id=2').run('Project Alder Archive 2041: minutes.');
 db.exec("UPDATE fact_entities SET link_type='inferred_text'");
 assert.equal(retainFactEntityLinks(db,1,2),0,'inferred edge not promoted');
 db.exec("UPDATE fact_entities SET link_type='extracted', evidence_excerpt='unrelated excerpt'");
 assert.equal(retainFactEntityLinks(db,1,2),0,'evidence must name identity');
 db.exec("UPDATE fact_entities SET evidence_excerpt='Project Alder Archive 2041'; UPDATE consolidated_facts SET superseded_by_fact_id=NULL WHERE id=1");
 assert.equal(retainFactEntityLinks(db,1,2),0,'must have direct supersession');
 } finally { db.close(); }
});
