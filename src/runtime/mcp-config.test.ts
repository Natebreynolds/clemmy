import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverMcpServers, invalidateMcpServerDiscoveryCache } from './mcp-config.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mcp-config-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_AUTO_IMPORT = process.env.MCP_AUTO_IMPORT_ENABLED;
const IMPORTED_NAME = 'codex-auto-import-test-server';

function writeClaudeMcpConfig(): void {
  const claudeDir = path.join(TMP_HOME, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      mcpServers: {
        [IMPORTED_NAME]: {
          command: 'node',
          args: ['server.js'],
        },
      },
    }),
    'utf-8',
  );
}

function restoreEnv(): void {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_AUTO_IMPORT === undefined) {
    delete process.env.MCP_AUTO_IMPORT_ENABLED;
  } else {
    process.env.MCP_AUTO_IMPORT_ENABLED = ORIGINAL_AUTO_IMPORT;
  }
  invalidateMcpServerDiscoveryCache();
}

test('auto-imported Claude MCP configs are opt-in', () => {
  writeClaudeMcpConfig();
  process.env.HOME = TMP_HOME;

  try {
    process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
    invalidateMcpServerDiscoveryCache();
    assert.equal(
      discoverMcpServers().some((server) => server.name === IMPORTED_NAME),
      false,
    );

    process.env.MCP_AUTO_IMPORT_ENABLED = 'true';
    invalidateMcpServerDiscoveryCache();
    const imported = discoverMcpServers().find((server) => server.name === IMPORTED_NAME);
    assert.equal(imported?.source, 'auto-detected');
    assert.equal(imported?.enabled, true);
  } finally {
    restoreEnv();
    rmSync(TMP_HOME, { recursive: true, force: true });
  }
});
