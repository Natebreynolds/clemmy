/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/skill-declared-tools.test.ts
 *
 * A skill that declares its tools hands the model their exact call shapes, so
 * it calls them without a tool_search round, and the skill reaches the model
 * whole. Live 2026-10-17: a Space build spent eight tool_search rounds on
 * tools its skill already named, and the workspace-builder read was clipped
 * at 20,000 characters so its verify and phone sections never arrived.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-skill-declared-tools-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { provisionBuiltinSkills } = await import('../setup/builtin-skills.js');
provisionBuiltinSkills({ baseDir: TMP_HOME, packageRoot: PACKAGE_ROOT });
const { registerSkillTools } = await import('./skill-tools.js');

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
const handlers = new Map<string, Handler>();
registerSkillTools({ tool(name: string, _d: string, _s: unknown, handler: Handler) { handlers.set(name, handler); } } as never);

async function readSkill(name: string): Promise<string> {
  return (await handlers.get('skill_read')!({ name })).content[0]!.text;
}

test('the Space skill reaches the model whole, its last section included', async () => {
  const text = await readSkill('workspace-builder');
  assert.ok(text.length > 20_000, 'the fixture is the skill that outgrew the default cap');
  assert.doesNotMatch(text, /\[truncated/);
  assert.match(text, /## 8\. Verify before saying it is done/);
  assert.match(text, /## 9\. Phone and re-engagement/);
});

test("a skill's declared tools come after its body with their argument shapes", async () => {
  const text = await readSkill('workspace-builder');
  const body = text.indexOf('## 9. Phone and re-engagement');
  const tools = text.indexOf('=== TOOLS THIS SKILL USES ===');
  assert.ok(tools > body, 'the guidance comes first; the call shapes follow it');
  const section = text.slice(tools);
  assert.match(section, /- space_save\(slug: string, title: string, /);
  assert.match(section, /objective\?: string/, 'a nullable field of a strict schema reads as optional');
  assert.match(section, /- space_set_data\(slug: string, source_id: string, data_json: string\)/,
    'a text-only contract stays text');
  assert.match(section, /initial_data_json\?: object, replacement_data_json\?: object/,
    'a JSON-document argument reads as an object, so it is never nested as escaped text');

  const watch = await readSkill('watch-setup');
  assert.match(watch, /- workflow_run\(name: string, inputs\?: string\)/);
});
