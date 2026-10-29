import assert from 'node:assert/strict';
import test from 'node:test';
import { PROJECT_PANELS, projectPanelFromSearch, projectPanelSearch } from './project-panel';

test('project panels round-trip exact identity and reject another project’s view', () => {
  for (const { id } of PROJECT_PANELS) {
    const url = projectPanelSearch('project:one & two', id);
    assert.equal(projectPanelFromSearch(url, 'project:one & two'), id);
    assert.equal(projectPanelFromSearch(url, 'project:different'), 'overview');
    assert.equal(new URLSearchParams(url).has('item'), false);
  }
  assert.equal(projectPanelFromSearch('?tab=agents&project=p&view=context', 'p'), 'overview');
  assert.equal(projectPanelFromSearch('?tab=projects&project=p&view=unknown', 'p'), 'overview');
});
