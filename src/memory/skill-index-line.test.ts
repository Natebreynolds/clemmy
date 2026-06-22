/**
 * Run: npx tsx --test src/memory/skill-index-line.test.ts
 *
 * Lane D Phase 3 (safe realization) — surface a distilled procedure's
 * applicability in the skills index so the model can judge relevance itself. No
 * speculative deterministic NL→toolkit filter (too fuzzy to gate on); pure
 * additive annotation, fail-open when absent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSkillLine } from './skill-store.js';

test('no applicability → plain line (byte-identical to before, fail-open)', () => {
  assert.equal(formatSkillLine('foo', 'does a thing'), '- `foo`: does a thing');
  assert.equal(formatSkillLine('foo', 'does a thing', null), '- `foo`: does a thing');
  assert.equal(formatSkillLine('foo', 'does a thing', { toolFamilies: [], entitySlots: [] }), '- `foo`: does a thing');
});

test('applicability → annotated with families + slots', () => {
  const line = formatSkillLine('seo-brief', 'build an SEO brief', { toolFamilies: ['dataforseo', 'gmail'], entitySlots: ['domain', 'email'] });
  assert.match(line, /^- `seo-brief`: build an SEO brief — /);
  assert.match(line, /best for dataforseo, gmail/);
  assert.match(line, /over \{\{domain\}\}\/\{\{email\}\}/);
});

test('families only / slots only render cleanly', () => {
  assert.equal(formatSkillLine('x', 'd', { toolFamilies: ['airtable'] }), '- `x`: d — best for airtable');
  assert.equal(formatSkillLine('x', 'd', { entitySlots: ['table_id'] }), '- `x`: d — over {{table_id}}');
});

test('empty description falls back', () => {
  assert.equal(formatSkillLine('x', ''), '- `x`: (no description)');
});
