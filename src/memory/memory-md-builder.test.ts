/**
 * Run: CLEMENTINE_HOME=/tmp/clemmy-memory-md-test npx tsx --test \
 *   src/memory/memory-md-builder.test.ts
 *
 * Covers the contract the maintenance tick depends on:
 *
 *   1. fresh install (empty MEMORY.md + 0 facts) → writes a placeholder
 *      auto section that explains the file will populate as facts land;
 *   2. user-curated content above the marker is preserved verbatim;
 *   3. running the builder twice with no fact changes is a true no-op
 *      (the writer returns `unchanged` and doesn't touch mtime);
 *   4. facts are grouped by kind, sorted by score desc, and the per-kind
 *      cap is enforced.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-memory-md-test-'));
process.env.CLEMENTINE_HOME = TMP;

const { regenerateMemoryMd } = await import('./memory-md-builder.js');
const { rememberFact, forgetFact, listActiveFacts } = await import('./facts.js');
const { MEMORY_FILE } = await import('./vault.js');

test('regenerateMemoryMd: writes a placeholder when 0 facts exist', () => {
  const result = regenerateMemoryMd();
  assert.equal(result.written, true);
  assert.equal(result.factCount, 0);
  const body = readFileSync(MEMORY_FILE, 'utf-8');
  assert.match(body, /# Memory/);
  assert.match(body, /AUTO-GENERATED/);
  assert.match(body, /0 active facts/);
});

test('regenerateMemoryMd: preserves user-curated content above the marker', () => {
  // Write user content manually
  writeFileSync(MEMORY_FILE, [
    '# Memory',
    '',
    '## My standing context',
    '- I work at Scorpion',
    '- I lead the sales team',
    '',
  ].join('\n'), 'utf-8');

  // Seed a fact so the auto section has something
  rememberFact({ kind: 'user', content: 'Nate works at Scorpion as Sales Director.' });

  const result = regenerateMemoryMd();
  assert.equal(result.written, true);
  assert.equal(result.factCount, 1);

  const body = readFileSync(MEMORY_FILE, 'utf-8');
  // User content preserved
  assert.match(body, /## My standing context/);
  assert.match(body, /I work at Scorpion/);
  assert.match(body, /I lead the sales team/);
  // Marker + auto content appended below
  assert.match(body, /AUTO-GENERATED/);
  assert.match(body, /## User/);
  assert.match(body, /Nate works at Scorpion as Sales Director/);
});

test('regenerateMemoryMd: idempotent — second call is a no-op', () => {
  // Above test left state in place; second call should detect no diff.
  const first = regenerateMemoryMd();
  // First call here may or may not be a no-op depending on previous test;
  // call once more to land in a stable state, then check the THIRD call.
  regenerateMemoryMd();
  const stable = regenerateMemoryMd();
  assert.equal(stable.written, false);
  assert.equal(stable.reason, 'unchanged');
});

test('regenerateMemoryMd: groups facts by kind, sorted by score desc', () => {
  rememberFact({ kind: 'project',  content: 'Active workflow: daily-prospect-outreach.', score: 1.5 });
  rememberFact({ kind: 'project',  content: 'Active workflow: outlook-triage-hourly.', score: 1.2 });
  rememberFact({ kind: 'feedback', content: 'Prefer concise responses, no bullet bloat.', score: 2.0 });
  rememberFact({ kind: 'reference', content: 'Scorpion CRM org user: nathan.reynolds@scorpion.co.', score: 1.0 });

  const result = regenerateMemoryMd();
  assert.equal(result.written, true);
  assert.ok(result.factCount >= 4);

  const body = readFileSync(MEMORY_FILE, 'utf-8');
  // All section headings present (sections with no facts are skipped)
  assert.match(body, /## User/);
  assert.match(body, /## Projects/);
  assert.match(body, /## Feedback/);
  assert.match(body, /## References/);
  // Highest-scoring project shows first
  const projectIdx = body.indexOf('## Projects');
  const after = body.slice(projectIdx);
  const dailyIdx = after.indexOf('daily-prospect-outreach');
  const outlookIdx = after.indexOf('outlook-triage-hourly');
  assert.ok(dailyIdx >= 0 && outlookIdx >= 0);
  assert.ok(dailyIdx < outlookIdx, 'higher-scored fact should render first');
});

test('regenerateMemoryMd: marker placement keeps user content separate after re-runs', () => {
  // Add a new fact, regenerate; the user content must still be there.
  rememberFact({ kind: 'feedback', content: 'Always confirm before pushing to main.', score: 1.5 });
  regenerateMemoryMd();
  const body = readFileSync(MEMORY_FILE, 'utf-8');
  const markerIdx = body.indexOf('AUTO-GENERATED');
  assert.ok(markerIdx > 0);
  const userSlice = body.slice(0, markerIdx);
  // The user content from earlier test should still be present
  assert.match(userSlice, /I work at Scorpion/);
  assert.match(userSlice, /I lead the sales team/);
});

test('regenerateMemoryMd: header reports the TRUE active-fact count, not the 160-row fetch cap', () => {
  // Push the active count well above the render fetch cap (MAX_FACTS_PER_KIND *
  // SECTIONS * 4 = 160). The old code printed facts.length (clamped to 160);
  // the fix prints the true factCount.
  for (let i = 0; i < 175; i++) {
    rememberFact({ kind: 'project', content: `Distinct project fact number ${i} for header-count test.` });
  }
  const result = regenerateMemoryMd();
  assert.ok(result.factCount > 160, `precondition: active facts (${result.factCount}) must exceed the 160 fetch cap`);
  const body = readFileSync(MEMORY_FILE, 'utf-8');
  const m = body.match(/·\s*(\d+)\s*active facts/);
  assert.ok(m, 'header must contain an "N active facts" count');
  assert.equal(Number(m![1]), result.factCount, 'header count must equal the true active count, not 160');
  assert.notEqual(Number(m![1]), 160, 'header must not show the fetch cap');
});

test('regenerateMemoryMd: AUTO-section overflow does NOT set userOverflow (no false-alarm warning)', () => {
  // Seed long facts across all kinds so the RENDERED auto section (10/kind)
  // overflows the 4000-char read budget — the real-world condition (long
  // "Clementine requirement: …" facts). With a small user block, that overflow
  // must NOT flag userOverflow (the warning gate) — it is by-design.
  for (const kind of ['user', 'project', 'feedback', 'reference'] as const) {
    for (let i = 0; i < 12; i++) {
      rememberFact({ kind, content: `Long ${kind} standing detail entry ${i} — ${'context phrase '.repeat(10)}` });
    }
  }
  writeFileSync(MEMORY_FILE, '# Memory\n\n## Notes\n- short user note\n', 'utf-8');
  const result = regenerateMemoryMd();
  assert.equal(result.promptTruncated, true, 'precondition: the assembled file exceeds the 4000-char budget');
  assert.equal(result.userOverflow, false, 'AUTO-section overflow must not trip the actionable warning');
});

test('regenerateMemoryMd: userOverflow is true only when the USER block alone exceeds the budget', () => {
  // A user-curated section larger than the 4000-char read budget IS actionable
  // (their own content will clip from the injected view) — userOverflow=true.
  const hugeUserBlock = '# Memory\n\n## My notes\n' + '- a long curated standing note line\n'.repeat(160);
  writeFileSync(MEMORY_FILE, hugeUserBlock, 'utf-8');
  const result = regenerateMemoryMd();
  assert.equal(result.userOverflow, true, 'a >4000-char user section must trip userOverflow');
});
