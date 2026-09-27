/**
 * Run: node scripts/run-tests-isolated.mjs src/dashboard/console-memory-reconcile.test.ts
 *
 * The Memory tab's repair routes keep their report shapes, and the work runs
 * in slices under the memory-reconcile phase: the passes hand the loop turns
 * while the request is in flight instead of holding it for the whole repair.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-console-memory-reconcile-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.NODE_ENV = 'test';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const { resetMemoryDb, openMemoryDb } = await import('../memory/db.js');
const { recordMemoryEpisode, linkFactEvidence } = await import('../memory/temporal-memory.js');
const { setSliceResumeHook } = await import('../memory/sliced-pass.js');
const { getDaemonRuntimePhase } = await import('../daemon/phase.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

async function boot() {
  const app = express();
  app.use(express.json());
  registerConsoleRoutes(app, () => true, {} as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function seed(): void {
  resetMemoryDb();
  const db = openMemoryDb();
  const insertEntity = db.prepare(`
    INSERT INTO entities (entity_type, canonical_name, canonical_name_lc, aliases_json, first_seen_at, last_seen_at, mention_count)
    VALUES (?, ?, ?, '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 1)
  `);
  const people = ['Dana Smith', 'Riley Park', 'Morgan Diaz', 'Casey Nguyen', 'Jordan Blake'];
  const companies = ['Northwind Traders', 'Globex', 'Initech', 'Hooli'];
  for (const name of people) insertEntity.run('person', name, name.toLowerCase());
  for (const name of companies) insertEntity.run('company', name, name.toLowerCase());
  for (let i = 0; i < 12; i += 1) insertEntity.run('company', 'Acmecorp', 'acmecorp');
  const insertFact = db.prepare(`
    INSERT INTO consolidated_facts (kind, content, content_hash, active, created_at, updated_at)
    VALUES ('project', ?, ?, 1, ?, ?)
  `);
  for (let i = 0; i < 240; i += 1) {
    const content = `${people[i % people.length]} works at ${companies[i % companies.length]} with Acmecorp. [${i}]`;
    const at = new Date(Date.UTC(2026, 7, 1) + i * 60_000).toISOString();
    const id = Number(insertFact.run(content, `route-${i}`, at, at).lastInsertRowid);
    const episode = recordMemoryEpisode({ kind: 'tool_result', sessionId: `route-s-${i}`, callId: `route-c-${i}`, content });
    linkFactEvidence({ factId: id, episodeId: episode.id, excerpt: content });
  }
  // Facts with no evidence yet, for the evidence route.
  for (let i = 0; i < 6; i += 1) {
    const at = new Date(Date.UTC(2026, 7, 2) + i * 60_000).toISOString();
    insertFact.run(`Unsourced note number ${i}.`, `route-unsourced-${i}`, at, at);
  }
}

test('the repair routes keep their report shapes and hand the loop turns while they run', async () => {
  seed();
  let resumes = 0;
  const phases = new Set<string>();
  setSliceResumeHook(() => {
    resumes += 1;
    phases.add(getDaemonRuntimePhase().name);
  });
  const harness = await boot();
  try {
    let loopTurns = 0;
    let counting = true;
    (function tick() { loopTurns += 1; if (counting) setImmediate(tick); })();
    const response = await fetch(`${harness.url}/api/console/memory/reconcile-relationships`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxFacts: 5000 }),
    });
    counting = false;
    assert.equal(response.status, 200);
    const report = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(report).sort(), [
      'after', 'backupPath', 'before', 'elapsedMs', 'factEntityLinks', 'factResourceLinks',
      'groundedFactEntityLinks', 'groundedFactResourceLinks', 'identities', 'relationships',
    ]);
    assert.deepEqual(Object.keys(report.factEntityLinks as object).sort(), ['entitiesConsidered', 'factsScanned', 'linksWritten']);
    assert.deepEqual(Object.keys(report.groundedFactEntityLinks as object).sort(), ['ambiguous', 'candidates', 'evidenceScanned', 'factsScanned', 'ignored', 'promoted']);
    assert.deepEqual(Object.keys(report.relationships as object).sort(), ['added', 'candidates', 'evidenceScanned', 'factsScanned', 'ignored', 'reinforced']);
    assert.equal(typeof report.backupPath, 'string');
    assert.ok((report.factEntityLinks as { linksWritten: number }).linksWritten > 240);
    assert.ok((report.relationships as { added: number }).added > 0);
    assert.ok(resumes >= 10, `the passes took ${resumes} turns during the request`);
    assert.ok(loopTurns >= resumes, `the loop ran ${loopTurns} turns`);
    assert.deepEqual([...phases], ['daemon.http.memory_reconcile']);

    const before = resumes;
    const evidence = await fetch(`${harness.url}/api/console/memory/reconcile-evidence`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxFacts: 100, batchSize: 2 }),
    });
    assert.equal(evidence.status, 200);
    const evidenceReport = await evidence.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(evidenceReport).sort(), ['available', 'backupPath', 'before', 'complete', 'elapsedMs', 'processed', 'remaining', 'unavailable']);
    assert.equal(evidenceReport.before, 6);
    assert.equal(evidenceReport.processed, 6);
    assert.ok(resumes > before, 'the evidence repair also hands the loop turns');
  } finally {
    setSliceResumeHook(null);
    await harness.close();
  }
});
