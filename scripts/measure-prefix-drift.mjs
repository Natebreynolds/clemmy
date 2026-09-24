#!/usr/bin/env node
// Per-request prompt layer drift for one accepted source, from model_request_provenance:
//   node scripts/measure-prefix-drift.mjs <sessionId> <sourceUserSeq>
// Consecutive requests of one source should change ONLY the task layer; any other layer
// (catalog = tools, turnContext, memoryContext, stablePolicy) changing at frame N explains a
// zero-cache usage row at frame N. Reads the live DB with ?mode=ro (immutable=1 hides the WAL).
import { execFileSync } from 'node:child_process';
const [session, source] = process.argv.slice(2);
const db = `file:${process.env.HOME}/.clementine-next/state/harness.db?mode=ro`;
const sql = `select request_ordinal, created_at, provenance_json from model_request_provenance where session_id='${session}' ${source ? `and source_user_seq=${source}` : ''} order by source_user_seq, request_ordinal;`;
const rows = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', db, sql], { maxBuffer: 1 << 30 }).toString() || '[]');
let prev = null;
for (const r of rows) {
  const p = JSON.parse(r.provenance_json);
  const L = p.layers; const names = Object.keys(L);
  const changed = prev ? names.filter((n) => prev[n]?.sha256 !== L[n].sha256).map((n) => `${n}(${prev[n]?.bytes ?? '-'}→${L[n].bytes})`) : [];
  const elig = p.cacheEligibility;
  console.log(`#${r.request_ordinal} ${r.created_at.slice(11, 19)} ` + names.map((n) => `${n}=${L[n].bytes}`).join(' ') + ` | tools=${p.toolSchemas?.schemaDigests?.length ?? '?'} eligible=${elig?.cacheEligible} ${elig?.issues?.length ? 'issues=' + JSON.stringify(elig.issues) : ''}` + (prev ? ` | CHANGED: ${changed.length ? changed.join(', ') : 'none'}` : ''));
  if (prev && p.toolSchemas?.schemaDigests && prevTools) { const a = prevTools.map((t) => t.name + ':' + t.sha256.slice(0, 6)).join(','); const b = p.toolSchemas.schemaDigests.map((t) => t.name + ':' + t.sha256.slice(0, 6)).join(','); if (a !== b) console.log('    tool set changed: ' + JSON.stringify({ removed: prevTools.filter((t) => !p.toolSchemas.schemaDigests.some((u) => u.name === t.name && u.sha256 === t.sha256)).map((t) => t.name), added: p.toolSchemas.schemaDigests.filter((t) => !prevTools.some((u) => u.name === t.name && u.sha256 === t.sha256)).map((t) => t.name) })); }
  prev = L; var prevTools = p.toolSchemas?.schemaDigests;
}
