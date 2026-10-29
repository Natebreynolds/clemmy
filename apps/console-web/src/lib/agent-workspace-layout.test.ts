import assert from 'node:assert/strict';
import test from 'node:test';
import { agentWorkspaceLayout } from './agent-workspace-layout';

test('agent panes always leave at least 520px for the composer whenever that width exists', () => {
  for (let available = 0; available <= 1800; available++) {
    for (const threads of [true, false]) for (const about of [true, false]) {
      const layout = agentWorkspaceLayout(available, threads, about);
      const remaining = available - (layout.inlineThreads ? 260 : 0) - (layout.inlineAbout ? 320 : 0);
      assert.ok(remaining >= Math.min(available, 520), `${available}px with ${threads}/${about}`);
    }
  }
});

test('800px desktop leaves the conversation intact, wide desktops admit both panes, file panels reclaim space', () => {
  assert.deepEqual(agentWorkspaceLayout(800 - 232), { inlineThreads: false, inlineAbout: false });
  assert.deepEqual(agentWorkspaceLayout(1440 - 232), { inlineThreads: true, inlineAbout: true });
  assert.deepEqual(agentWorkspaceLayout((1440 - 232) * .52), { inlineThreads: false, inlineAbout: false });
  assert.deepEqual(agentWorkspaceLayout(900, false), { inlineThreads: false, inlineAbout: true });
});
