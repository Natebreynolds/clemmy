import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogInstallForPlatform, WINDOWS_GITHUB_INSTALL } from './platform-install.js';
import { CLI_CATALOG } from './catalog.js';

test('Windows catalog never dispatches a Homebrew recipe; native and npm recipes retain their exact package', () => {
  for (const entry of CLI_CATALOG) {
    const recipe = catalogInstallForPlatform(entry, 'win32');
    if (entry.id === 'github') {
      assert.equal(recipe.supported, true);
      if (recipe.supported) assert.equal(recipe.command, WINDOWS_GITHUB_INSTALL);
    } else if (/^brew\s/.test(entry.installCommand)) {
      assert.equal(recipe.supported, false, entry.id);
      if (!recipe.supported) {
        assert.match(recipe.reason, /Windows.*official instructions/);
        assert.equal(recipe.docsUrl, entry.homepage || entry.authDocsUrl);
      }
    } else {
      assert.deepEqual(recipe, { supported: true, command: entry.installCommand }, entry.id);
    }
    assert.deepEqual(catalogInstallForPlatform(entry, 'darwin'), { supported: true, command: entry.installCommand });
  }
});
