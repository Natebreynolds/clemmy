import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-project-brief-'));
process.env.CLEMENTINE_HOME = fixtureHome;
const { openMemoryDb, resetMemoryDb } = await import('./db.js');
const scopes = await import('./memory-scope.js');
const projects = await import('../projects/project-record.js');
const { readFactObservation } = await import('./fact-correction.js');
const { recordMemoryEpisode, linkFactEvidence } = await import('./temporal-memory.js');
const { captureProjectMemoryBrief, renderCapturedProjectMemoryBrief, renderProjectMemoryBrief } = await import('./project-brief.js');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
let nextProject = 0;
beforeEach(() => resetMemoryDb());
after(() => {
  resetMemoryDb();
  projects._closeProjectStoreForTests();
  rmSync(fixtureHome, { recursive: true, force: true });
});

function project() {
  const result = projects.createProject({ name: `Project brief fixture ${nextProject++}`, context: 'Owner notes.\n  Keep this exact wording.' });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('project fixture failed');
  return result.project;
}

function fact(projectId: string | null, content: string, options: { agentKey?: string; kind?: string; derived?: boolean; validFrom?: string; validTo?: string } = {}) {
  const now = '2026-01-01T00:00:00.000Z';
  const result = openMemoryDb().prepare(`INSERT INTO consolidated_facts
    (kind, content, content_hash, created_at, updated_at, valid_from, valid_to, trust_level,
      derived_from_tool, derived_from_call_id, derivation_depth)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
    .run(options.kind ?? 'project', content, hash(`${nextProject}:${content}`), now, now,
      options.validFrom ?? now, options.validTo ?? null, options.derived ? 0.6 : 1,
      options.derived ? 'fixture_read' : null, options.derived ? 'fixture-call' : null);
  const id = Number(result.lastInsertRowid);
  scopes.stampMemoryScope('fact', id, { projectId, agentKey: options.agentKey ?? null });
  return id;
}

function evidence(id: number, projectId: string, content: string) {
  const episode = recordMemoryEpisode({ kind: 'tool_result', content, sourceUri: 'fixture://project/source', occurredAt: '2026-01-01T00:00:00.000Z' });
  scopes.stampMemoryScope('episode', episode.id, { projectId, agentKey: null });
  linkFactEvidence({ factId: id, episodeId: episode.id, excerpt: content, sourceUri: episode.source_uri });
  return episode.id;
}

function inProject<T>(projectId: string, run: () => T, agentKey: string | null = null): T {
  return scopes.withMemoryReadScope({ projectId, agentKey }, run);
}

test('a project brief exposes literal current observations with complete canonical fact digests', () => {
  const p = project();
  const id = fact(p.id, 'Launch review is on Friday.');
  inProject(p.id, () => {
    const observation = readFactObservation(id)!;
    const brief = renderProjectMemoryBrief(p.id);
    assert.match(brief.text, /Project observations/);
    assert.ok(brief.text.includes(`fact:${id}@${observation.digest}`));
    assert.ok(brief.text.includes('Launch review is on Friday.'));
    assert.match(brief.text, /user-stated/);
    assert.deepEqual(brief.refs, [{ type: 'fact', id: String(id) }]);
    assert.match(brief.revision, /^[a-f0-9]{64}$/);
    assert.equal('readCall' in brief, false, 'a brief is not canonical tool-read or correction authority');
  });
});

test('unrestricted, global and mismatching scopes cannot capture a project brief', () => {
  const p = project();
  fact(p.id, 'Private project sentence.');
  assert.equal(captureProjectMemoryBrief(p.id), null);
  assert.equal(scopes.withMemoryReadScope(scopes.EVERYWHERE, () => captureProjectMemoryBrief(p.id)), null);
  assert.equal(inProject('prj_otherfixture00', () => captureProjectMemoryBrief(p.id)), null);
});

test('scope filtering precedes ranking and keeps only current project/reference facts visible to this agent', () => {
  const p = project();
  const other = project();
  fact(null, 'Global statement must not enter a project brief.');
  fact(other.id, 'Other project must stay private.');
  fact(p.id, 'Another agent must stay private.', { agentKey: 'agent-b@1' });
  fact(p.id, 'Standing instructions have their existing core lane.', { kind: 'feedback' });
  const own = fact(p.id, 'Owned launch reference.', { kind: 'reference', agentKey: 'agent-a@1' });
  for (let index = 0; index < 80; index++) fact(other.id, `Foreign launch noise ${index}.`);
  inProject(p.id, () => {
    const brief = renderProjectMemoryBrief(p.id, { objective: 'launch' });
    assert.deepEqual(brief.refs, [{ type: 'fact', id: String(own) }]);
    assert.doesNotMatch(brief.text, /Global|Other project|Another agent|Standing instructions|Foreign/);
  }, 'agent-a@1');
});

test('derived observations require retained source evidence and distinguish it from unsupported owner statements', () => {
  const p = project();
  const derived = fact(p.id, 'Signed contract is retained.', { derived: true });
  const episode = evidence(derived, p.id, 'Signed contract is retained.');
  fact(p.id, 'Unsupported derived statement.', { derived: true });
  inProject(p.id, () => {
    const brief = renderProjectMemoryBrief(p.id);
    assert.match(brief.text, /derived; retained evidence/);
    assert.doesNotMatch(brief.text, /Unsupported derived/);
    assert.ok(brief.refs.some(ref => ref.type === 'episode' && ref.id === episode));
    assert.doesNotMatch(brief.text, /verified|current live status/i);
  });
});

for (const change of ['missing', 'hidden', 'bad-hash', 'replaced-excerpt', 'changed-uri', 'deleted'] as const) {
  test(`a derived brief does not retain a claim after its evidence becomes ${change}`, () => {
    const p = project();
    const id = fact(p.id, 'Source-backed launch observation.', { derived: true });
    const episode = evidence(id, p.id, 'Source-backed launch observation.');
    inProject(p.id, () => {
      assert.ok(renderProjectMemoryBrief(p.id).text.includes('Source-backed launch observation.'));
      const db = openMemoryDb();
      if (change === 'missing') db.prepare("UPDATE memory_episodes SET status = 'missing' WHERE id = ?").run(episode);
      else if (change === 'hidden') scopes.stampMemoryScope('episode', episode, { projectId: 'prj_otherfixture00', agentKey: null });
      else if (change === 'bad-hash') db.prepare('UPDATE memory_episodes SET content_hash = ? WHERE id = ?').run('f'.repeat(64), episode);
      else if (change === 'replaced-excerpt') db.prepare('UPDATE memory_episodes SET evidence_excerpt = ?, content_hash = ? WHERE id = ?').run('Different source.', hash('Different source.'), episode);
      else if (change === 'changed-uri') db.prepare('UPDATE memory_episodes SET source_uri = ? WHERE id = ?').run('fixture://different/source', episode);
      else db.prepare('DELETE FROM memory_episodes WHERE id = ?').run(episode);
      assert.equal(renderProjectMemoryBrief(p.id).text, '');
    });
  });
}

test('a user statement with unavailable evidence is labelled rather than promoted to source-backed', () => {
  const p = project();
  const id = fact(p.id, 'Owner says launch remains Friday.');
  const episode = evidence(id, p.id, 'Owner says launch remains Friday.');
  openMemoryDb().prepare("UPDATE memory_episodes SET status = 'expired' WHERE id = ?").run(episode);
  inProject(p.id, () => {
    const brief = renderProjectMemoryBrief(p.id);
    assert.match(brief.text, /user-stated; source unavailable/);
    assert.doesNotMatch(brief.text, /retained evidence/);
    assert.deepEqual(brief.refs, [{ type: 'fact', id: String(id) }]);
  });
});

test('legacy unknown provenance is never relabelled as an owner statement', () => {
  const p = project();
  const id = fact(p.id, 'Legacy source observation.');
  openMemoryDb().prepare('UPDATE consolidated_facts SET trust_level = NULL WHERE id = ?').run(id);
  inProject(p.id, () => {
    assert.equal(renderProjectMemoryBrief(p.id).text, '');
    evidence(id, p.id, 'Legacy source observation.');
    const brief = renderProjectMemoryBrief(p.id);
    assert.match(brief.text, /derived; retained evidence/);
    assert.doesNotMatch(brief.text, /user-stated/);
  });
});

test('a captured accepted-turn brief stays frozen while the next capture receives corrected source bytes', () => {
  const p = project();
  const id = fact(p.id, 'Launch is Friday.');
  inProject(p.id, () => {
    const captured = captureProjectMemoryBrief(p.id)!;
    assert.ok(captured);
    assert.equal(Object.isFrozen(captured), true);
    const before = renderCapturedProjectMemoryBrief(captured);
    openMemoryDb().prepare('UPDATE consolidated_facts SET content = ?, content_hash = ? WHERE id = ?').run('Launch is Monday.', hash('Launch is Monday.'), id);
    assert.deepEqual(renderCapturedProjectMemoryBrief(captured), before);
    const after = renderProjectMemoryBrief(p.id);
    assert.match(after.text, /Launch is Monday/);
    assert.notEqual(after.revision, before.revision);
  });
});

test('inactive, superseded, future and expired facts do not enter a fresh brief; archive or unknown project is empty', () => {
  const p = project();
  const inactive = fact(p.id, 'Inactive statement.');
  openMemoryDb().prepare('UPDATE consolidated_facts SET active = 0 WHERE id = ?').run(inactive);
  fact(p.id, 'Future statement.', { validFrom: '2999-01-01T00:00:00.000Z' });
  fact(p.id, 'Expired statement.', { validTo: '2000-01-01T00:00:00.000Z' });
  const replacement = fact(p.id, 'Current statement.');
  const prior = fact(p.id, 'Superseded statement.');
  openMemoryDb().prepare('UPDATE consolidated_facts SET superseded_by_fact_id = ? WHERE id = ?').run(replacement, prior);
  inProject(p.id, () => {
    assert.deepEqual(renderProjectMemoryBrief(p.id).refs, [{ type: 'fact', id: String(replacement) }]);
    projects.archiveProject(p.id);
    assert.equal(captureProjectMemoryBrief(p.id), null);
  });
});

test('utility counters and another project do not change exact dependency revisions or overwrite owner context', () => {
  const p = project();
  const other = project();
  const id = fact(p.id, 'Owner-defined launch date.');
  inProject(p.id, () => {
    const before = renderProjectMemoryBrief(p.id);
    assert.ok(before.text);
    openMemoryDb().prepare('UPDATE consolidated_facts SET utility_count = utility_count + 1, impression_count = impression_count + 1, updated_at = ? WHERE id = ?').run('2026-10-29T00:00:00.000Z', id);
    fact(other.id, 'Other project changes independently.');
    assert.deepEqual(renderProjectMemoryBrief(p.id), before);
    assert.equal(projects.getProject(p.id)?.context, p.context);
  });
});

test('source changes alter the dependency revision even when the copied claim remains the same', () => {
  const p = project();
  const id = fact(p.id, 'Signed launch approval.', { derived: true });
  const episode = evidence(id, p.id, 'Signed launch approval.');
  inProject(p.id, () => {
    const before = renderProjectMemoryBrief(p.id);
    const updated = 'Signed launch approval. Supporting appendix retained.';
    openMemoryDb().prepare('UPDATE memory_episodes SET evidence_excerpt = ?, content_hash = ? WHERE id = ?').run(updated, hash(updated), episode);
    const after = renderProjectMemoryBrief(p.id);
    assert.ok(after.text.includes('Signed launch approval.'));
    assert.notEqual(after.revision, before.revision);
  });
});

test('brief rendering obeys a hard 550-character cap, retains whole source pins and excludes already-shown facts', () => {
  const p = project();
  const ids = Array.from({ length: 6 }, (_, index) => fact(p.id, `Project launch observation ${index}: ${'literal detail '.repeat(50)}`));
  inProject(p.id, () => {
    const snapshot = captureProjectMemoryBrief(p.id)!;
    assert.ok(snapshot);
    for (const maxChars of [0, 80, 240, 550, 5000]) {
      const brief = renderCapturedProjectMemoryBrief(snapshot, { maxChars });
      assert.ok(brief.text.length <= Math.min(550, maxChars));
      for (const match of brief.text.matchAll(/fact:(\d+)@([a-f0-9]+)/g)) assert.equal(match[2].length, 64);
    }
    const brief = renderCapturedProjectMemoryBrief(snapshot, { excludeRefKeys: new Set(ids.slice(3).map(id => `fact:${id}`)) });
    assert.ok(brief.text);
    assert.ok(brief.refs.every(ref => !ids.slice(3).some(id => ref.type === 'fact' && ref.id === String(id))));
    const absent = renderCapturedProjectMemoryBrief(snapshot, { excludeRefKeys: new Set(ids.map(id => `fact:${id}`)) });
    assert.equal(absent.text, '');
    assert.deepEqual(absent.refs, []);
  });
});
