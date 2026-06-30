import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { capSkillLines } from './skill-store.js';

describe('capSkillLines (roadmap #9: bound the persistent skills index)', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `  - \`skill-${i}\`: desc ${i}`);

  it('returns the list unchanged when it is within the cap (byte-identical common case)', () => {
    assert.deepEqual(capSkillLines(lines, 10, 'installed skills'), lines);
    assert.deepEqual(capSkillLines(lines.slice(0, 3), 40, 'installed skills'), lines.slice(0, 3));
  });

  it('truncates and appends a skill_list() discovery pointer when over the cap', () => {
    const out = capSkillLines(lines, 4, 'installed skills');
    assert.equal(out.length, 5); // 4 kept + 1 pointer
    assert.deepEqual(out.slice(0, 4), lines.slice(0, 4));
    assert.match(out[4], /…and 6 more installed skills — call skill_list\(\) to see the full set\./);
  });

  it('treats max <= 0 as uncapped (the kill-switch)', () => {
    assert.deepEqual(capSkillLines(lines, 0, 'installed skills'), lines);
    assert.deepEqual(capSkillLines(lines, -1, 'installed skills'), lines);
  });

  it('uses the supplied kind in the pointer (drafts vs installed)', () => {
    const out = capSkillLines(lines, 2, 'draft skills');
    assert.match(out[out.length - 1], /8 more draft skills/);
  });
});
