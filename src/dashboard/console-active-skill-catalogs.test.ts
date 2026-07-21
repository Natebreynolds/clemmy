/**
 * Executable skill pickers must hide non-destructive supersession aliases,
 * while the Skills management surface keeps and labels them for audit/revert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-active-skill-catalogs-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.NODE_ENV = 'test';
process.env.CLEMMY_HARNESS_DASHBOARD = 'off';
process.env.CLEMMY_LEGACY_RESPOND_FALLBACK = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { registerConsoleRoutes } = await import('./console-routes.js');
const {
  SKILLS_DIR,
  reconcileDistilledSkillDuplicates,
  writeDistilledSkill,
} = await import('../memory/skill-store.js');

test.after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

async function boot(onArchitectPrompt: (prompt: string) => void) {
  const app = express();
  app.use(express.json());
  const assistant = {
    respond: async (request: { message: string }) => {
      onArchitectPrompt(request.message);
      return { text: 'No draft changes.' };
    },
  };
  registerConsoleRoutes(app, () => true, assistant as never, { serveLegacyAtRoot: false });
  const server: Server = await new Promise((resolve) => {
    const instance = createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function seedRetiredAlias(): void {
  rmSync(SKILLS_DIR, { recursive: true, force: true });
  const task = 'Publish a landing page to Netlify.';
  writeDistilledSkill({
    name: 'netlify-publish', description: 'Publish a landing page.', body: 'Canonical body.',
    origin: { kind: 'workflow', sourceId: 'canonical-run' }, capabilityTask: task,
  });
  writeDistilledSkill({
    name: 'deploy-netlify-page', description: 'Deploy a landing page.', body: 'Retired alias body.',
    origin: { kind: 'workflow', sourceId: 'alias-run' }, capabilityTask: task,
  });
  const result = reconcileDistilledSkillDuplicates({
    canonicalName: 'netlify-publish',
    duplicateNames: ['deploy-netlify-page'],
    capabilityTask: task,
  });
  assert.deepEqual(result.superseded, ['deploy-netlify-page']);
}

test('executable catalogs hide retired aliases and management labels them', async () => {
  seedRetiredAlias();
  let architectPrompt = '';
  const harness = await boot((prompt) => { architectPrompt = prompt; });
  try {
    const toolsResponse = await fetch(`${harness.url}/api/console/tools`);
    assert.equal(toolsResponse.status, 200);
    const tools = await toolsResponse.json() as { skills: Array<{ name: string }> };
    assert.deepEqual(tools.skills.map((skill) => skill.name), ['netlify-publish']);

    const agentsResponse = await fetch(`${harness.url}/api/console/agents/catalog`);
    assert.equal(agentsResponse.status, 200);
    const agents = await agentsResponse.json() as { skills: Array<{ name: string }> };
    assert.deepEqual(agents.skills.map((skill) => skill.name), ['netlify-publish']);

    const architectResponse = await fetch(`${harness.url}/api/console/workflows/architect/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Add the deployment step.' }),
    });
    assert.equal(architectResponse.status, 200);
    assert.match(architectPrompt, /netlify-publish/);
    assert.doesNotMatch(architectPrompt, /deploy-netlify-page/);

    const managementResponse = await fetch(`${harness.url}/api/console/skills`);
    assert.equal(managementResponse.status, 200);
    const management = await managementResponse.json() as {
      skills: Array<{ name: string; disabled: boolean; supersededBy: string | null }>;
    };
    assert.equal(management.skills.length, 2, 'audit catalog preserves both files');
    const alias = management.skills.find((skill) => skill.name === 'deploy-netlify-page');
    assert.ok(alias);
    assert.equal(alias.disabled, true);
    assert.equal(alias.supersededBy, 'netlify-publish');

    const aliasDetailResponse = await fetch(`${harness.url}/api/console/skills/deploy-netlify-page`);
    assert.equal(aliasDetailResponse.status, 200);
    const aliasDetail = await aliasDetailResponse.json() as { name: string; body: string; supersededBy: string | null };
    assert.equal(aliasDetail.name, 'deploy-netlify-page');
    assert.match(aliasDetail.body, /Retired alias body/);
    assert.equal(aliasDetail.supersededBy, 'netlify-publish');
  } finally {
    await harness.close();
  }
});
// The 'legacy Skills management UI' renderConsoleHtml test was removed
// 2026-07-21 with console.ts (that surface is the React SPA now).
