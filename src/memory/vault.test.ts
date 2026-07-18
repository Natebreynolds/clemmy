/**
 * Run: npx tsx --test src/memory/vault.test.ts
 *
 * Locks in the two-part-file (MEMORY.md / IDENTITY.md) marker handling that the
 * console read/save path relies on: splitCuratedMemory returns only the curated
 * prefix, composeCuratedMemory preserves the AUTO-GENERATED projection on save
 * (so it stays searchable / doesn't thrash the vault index), and a marker pasted
 * into curated text can't silently truncate the file on the next regeneration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCuratedMemory,
  composeCuratedMemory,
  sanitizeCuratedMemory,
  MEMORY_AUTO_SECTION_MARKER as MARKER,
} from './vault.js';

const FULL = `# Memory\n\nNate is a coach.\nPrefers terse replies.\n\n${MARKER}\n\n## User\n- learned fact one\n- learned fact two\n`;

test('splitCuratedMemory returns only the curated prefix, marker stripped', () => {
  const s = splitCuratedMemory(FULL);
  assert.equal(s.curated, '# Memory\n\nNate is a coach.\nPrefers terse replies.');
  assert.equal(s.hadMarker, true);
  assert.ok(s.autoSection.startsWith(MARKER));
  assert.ok(!s.curated.includes('learned fact one'), 'auto content never leaks into curated');
});

test('composeCuratedMemory preserves the auto section on save and round-trips', () => {
  const edited = '# Memory\n\nNate is a coach.\nPrefers terse replies.\nNEW: likes espresso.';
  const composed = composeCuratedMemory(edited, FULL);
  assert.ok(composed.includes('likes espresso'), 'keeps the edited curated text');
  assert.ok(composed.includes('learned fact two'), 'preserves the generated projection (stays searchable)');
  assert.equal(composed.split(MARKER).length, 2, 'exactly one marker');
  assert.equal(splitCuratedMemory(composed).curated, edited.replace(/\s+$/, ''), 'curated round-trips byte-exact');
});

test('composeCuratedMemory with no existing marker just writes the curated content', () => {
  assert.equal(composeCuratedMemory('# Memory\n\nhi', '# Memory\n\nJust notes.'), '# Memory\n\nhi\n');
});

test('empty curated save preserves the existing auto section (no searchable loss)', () => {
  const composed = composeCuratedMemory('', FULL);
  assert.ok(composed.includes('learned fact two'), 'auto projection survives an empty curated save');
  assert.equal(composed.split(MARKER).length, 2, 'still exactly one marker');
});

test('a marker pasted into curated text is neutralized (no silent truncation)', () => {
  const malicious = `# Memory\n\nreal note\n${MARKER}\nsomething the user wrote below their pasted marker`;
  const composed = composeCuratedMemory(malicious, FULL);
  // Exactly one marker (the canonical separator), and the user text that
  // followed their pasted marker is retained above the real separator.
  assert.equal(composed.split(MARKER).length, 2, 'user-pasted marker removed; one canonical marker remains');
  assert.ok(composed.includes('something the user wrote below their pasted marker'), 'no user text dropped');
  assert.equal(sanitizeCuratedMemory(malicious).includes(MARKER), false, 'sanitize strips the embedded marker');
});

test('inline and multiline marker comments are removed without dropping surrounding user text', () => {
  const pasted = [
    '# Memory',
    '',
    `before ${MARKER} after`,
    '<!-- AUTO-GENERATED',
    'legacy multiline marker',
    '-->',
    'still user-authored',
  ].join('\n');
  const sanitized = sanitizeCuratedMemory(pasted);
  assert.match(sanitized, /before\s+after/);
  assert.match(sanitized, /still user-authored/);
  assert.doesNotMatch(sanitized, /AUTO-GENERATED|legacy multiline marker/);
});

test('compatible older-style marker also splits and is preserved', () => {
  const older = `# Memory\n\nCurated.\n\n<!-- AUTO-GENERATED — old style -->\n## User\n- x\n`;
  const s = splitCuratedMemory(older);
  assert.equal(s.curated, '# Memory\n\nCurated.');
  assert.equal(s.hadMarker, true);
  assert.ok(composeCuratedMemory('# Memory\n\nCurated2.', older).includes('- x'), 'older auto section preserved');
});
