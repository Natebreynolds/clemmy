/**
 * dump-memory-graph.ts — READ-ONLY snapshot dumper for the Memory knowledge graph.
 *
 * Produces scripts/memory-graph-snapshot.json — the live data that the
 * standalone 3D prototype (clementine-memory-constellation.html) bakes in.
 *
 * Two modes:
 *   (default) in-process — calls buildMemoryGraph() against the local
 *             ~/.clementine-next/state/memory.db (WAL → safe concurrent read).
 *             No daemon, no token, no network. Reads stored embeddings only.
 *   --remote  HTTP GET the running daemon (127.0.0.1:8420) with
 *             Authorization: Bearer <WEBHOOK_SECRET> (resolved from the
 *             secrets-vault / env / .env via src/config.ts).
 *
 * We dump with a GENEROUS K / low threshold / high cap so the prototype can
 * tune the similarity threshold DOWN client-side (filtering edges by weight)
 * without re-dumping. The prototype then renders at its own default threshold.
 *
 * Usage:
 *   npx tsx scripts/dump-memory-graph.ts
 *   npx tsx scripts/dump-memory-graph.ts --remote
 *   npx tsx scripts/dump-memory-graph.ts --facts 300 --sim 5 --threshold 0.58 --out scripts/snap.json
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db.js';
import { buildMemoryGraph, type BuildMemoryGraphOpts, type MemoryGraphResult } from '../src/dashboard/memory-graph.js';

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const val = (flag: string, def: string): string => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const outPath = path.resolve(val('--out', path.join('scripts', 'memory-graph-snapshot.json')));
const opts: BuildMemoryGraphOpts = {
  factsLimit: Number(val('--facts', '300')),
  filesLimit: Number(val('--files', '80')),
  entitiesLimit: Number(val('--entities', '100')),
  semanticLayout: true,
  simEdges: Number(val('--sim', '5')),       // generous K — prototype filters down
  simThreshold: Number(val('--threshold', '0.58')),
  simCap: Number(val('--cap', '800')),
  clusterMode: 'kind',
};

async function viaHttp(): Promise<MemoryGraphResult> {
  const { WEBHOOK_SECRET } = await import('../src/config.js');
  if (!WEBHOOK_SECRET) throw new Error('No WEBHOOK_SECRET (vault/env/.env) — cannot use --remote');
  const host = process.env.WEBHOOK_HOST || '127.0.0.1';
  const port = process.env.WEBHOOK_PORT || '8420';
  const qs = new URLSearchParams({
    facts: String(opts.factsLimit), files: String(opts.filesLimit), entities: String(opts.entitiesLimit),
    layout: 'semantic', simEdges: String(opts.simEdges), simThreshold: String(opts.simThreshold), simCap: String(opts.simCap),
  });
  const url = `http://${host}:${port}/api/console/memory/graph?${qs.toString()}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${WEBHOOK_SECRET}` } });
  if (!res.ok) throw new Error(`graph endpoint ${res.status}: ${await res.text()}`);
  return res.json() as Promise<MemoryGraphResult>;
}

function viaInProcess(): MemoryGraphResult {
  const db = openMemoryDb();
  return buildMemoryGraph(db, opts);
}

async function main(): Promise<void> {
  const remote = has('--remote');
  const data = remote ? await viaHttp() : viaInProcess();
  const payload = { ...data, generatedAt: new Date().toISOString(), source: remote ? 'remote' : 'in-process' };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));

  const meta = (data.meta || {}) as Record<string, any>;
  const sim = meta.semanticEdges as { count?: number; enabled?: boolean; embeddedFacts?: number } | undefined;
  console.log(`✓ wrote ${outPath}`);
  console.log(
    `  ${data.nodes.length} nodes · ${data.edges.length} edges` +
    (sim ? ` · ${sim.count ?? 0} similar (embeddings ${sim.enabled ? 'on' : 'OFF'}, ${sim.embeddedFacts ?? 0} embedded facts)` : ''),
  );
  if (sim && !sim.enabled) {
    console.log('  ⚠ embeddings disabled (no OPENAI_API_KEY?) — semantic edges omitted; graph still renders via force layout.');
  }
}

main().catch((e) => { console.error('✗', e?.message || e); process.exit(1); });
