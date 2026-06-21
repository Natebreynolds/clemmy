/**
 * READ-ONLY projection: of the frozen CLI/MCP memos, how many would the store
 * fallback actually credit on a normal use of THEIR OWN proven invocation —
 * i.e. become a unique, operation-confirmed winner — vs. stay ambiguous (two
 * same-binary memos a command can't tell apart, which need the dedup/merge work
 * rather than the crediting fix). Mutates NOTHING.
 *
 * Run: npx tsx scripts/project-store-fallback-coverage.ts
 */
import { listToolChoices, type ToolChoiceRecord } from '../src/memory/tool-choice-store.js';

function tokenPresent(token: string, hay: string): boolean {
  if (!token || token.length < 2) return false;
  for (let from = 0; ; ) {
    const idx = hay.indexOf(token, from);
    if (idx < 0) return false;
    const before = idx === 0 ? '' : hay[idx - 1];
    const after = idx + token.length >= hay.length ? '' : hay[idx + token.length];
    if ((before === '' || /[^a-z0-9]/.test(before)) && (after === '' || /[^a-z0-9]/.test(after))) return true;
    from = idx + 1;
  }
}
function identifierMatches(id: string, hay: string): boolean {
  return tokenPresent(id, hay) || tokenPresent(id.split(/\s+/)[0], hay);
}
function opTokens(intent: string, id: string, tmpl?: string): Set<string> {
  const idToks = new Set(id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const out = new Set(intent.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !idToks.has(t)));
  if (tmpl) for (const t of tmpl.toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3 && !idToks.has(t)) out.add(t);
  return out;
}
function score(rec: ToolChoiceRecord, hay: string): number {
  const c = rec.choice; if (!c) return 0;
  const id = c.identifier.toLowerCase();
  if (c.kind === 'mcp') return tokenPresent(id, hay) ? (id === hay.trim() ? 2 : 1) : 0;
  if (c.kind === 'cli') {
    if (!identifierMatches(id, hay)) return 0;
    let n = 0; for (const t of opTokens(rec.intent, id, c.invocationTemplate)) if (tokenPresent(t, hay)) n++;
    return n;
  }
  return 0;
}
function syntheticUse(rec: ToolChoiceRecord): string {
  const c = rec.choice!;
  if (c.kind === 'mcp') return c.identifier.toLowerCase();
  // CLI: prefer the proven invocation; else identifier + the intent's op tokens
  if (c.invocationTemplate) return c.invocationTemplate.toLowerCase();
  return `${c.identifier} ${[...opTokens(rec.intent, c.identifier)].join(' ')}`.toLowerCase();
}

const all = listToolChoices().filter((r) => r.choice);
for (const kind of ['cli', 'mcp'] as const) {
  const memos = all.filter((r) => r.choice!.kind === kind);
  let unique = 0, ambiguous = 0, noOp = 0;
  const ambiguousExamples: string[] = [];
  for (const m of memos) {
    const hay = syntheticUse(m);
    const scored = all.map((r) => ({ intent: r.intent, s: score(r, hay) })).filter((x) => x.s > 0);
    const max = Math.max(0, ...scored.map((x) => x.s));
    const top = scored.filter((x) => x.s === max);
    if (max <= 0) { noOp++; }
    else if (top.length === 1 && top[0].intent === m.intent) { unique++; }
    else { ambiguous++; if (ambiguousExamples.length < 5) ambiguousExamples.push(`${m.intent} (${top.length}-way tie on "${m.choice!.identifier}")`); }
  }
  console.log(`\n${kind.toUpperCase()}: ${memos.length} memos`);
  console.log(`  ✅ would self-credit (unique, operation-confirmed): ${unique}  (${memos.length ? Math.round(100 * unique / memos.length) : 0}%)`);
  console.log(`  ⚠️  ambiguous (same-binary tie → needs dedup, not crediting): ${ambiguous}`);
  console.log(`  ∅  no operation token to confirm (vague slug + no template): ${noOp}`);
  if (ambiguousExamples.length) console.log(`     e.g. ${ambiguousExamples.join(' | ')}`);
}
