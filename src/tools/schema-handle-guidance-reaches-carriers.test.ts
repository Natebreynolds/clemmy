import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-schema-guidance-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { registerToolSearchTool } = await import('./tool-search-tool.js');
after(() => rmSync(fixtureHome, { recursive: true, force: true }));

// Exercise actual discovery output: a clipped schema must name the local
// recovery door on every carrier; a complete inline schema needs no extra read.
for (const mode of ['exact', 'fixed', 'mixed', 'fallback'] as const) {
  for (const large of [false, true]) {
    test(`${mode}: ${large ? 'omitted schema uses local handles' : 'complete inline schema requires no reread'}`, async () => {
      const name = 'GUIDANCE_FIXTURE_OPERATION';
      const schema = { type: 'object', properties: { value: { type: 'string',
        ...(large ? { enum: Array.from({ length: 1500 }, (_, i) => `${i}-${'x'.repeat(70)}`) } : {}) } }, required: ['value'] };
      let sourceCalls = 0;
      let handler!: (args: { query: string; cursor?: string }) => Promise<{ content: Array<{ text: string }> }>;
      const server = { tool(_name: string, _description: string, _schema: unknown, invoke: typeof handler) { handler = invoke; } };
      registerToolSearchTool(server as never, {
        allowedNames: new Set(['tool_search']),
        ...(mode === 'fixed' ? { dispatchCarrier: 'work_call' as const } : {}),
        ...(mode === 'mixed' || mode === 'exact' ? { dispatchCarrierForName: () => 'work_call' as const } : {}),
        candidateSources: [{ kind: 'authorized_composio', async search() {
          sourceCalls++;
          return [{ name, summary: 'Guidance fixture operation', schema }];
        } }],
      });
      const query = mode === 'exact' ? name : 'guidance fixture';
      const body = JSON.parse((await handler({ query })).content[0]!.text);
      assert.ok(body.results.some((row: { name: string }) => row.name === name));
      if (!large) {
        assert.deepEqual(body.schemas[name], schema);
        assert.ok(!body.schema_read_required?.includes(name));
        assert.match(body.hint, /Schemas shown inline are complete; use them directly/);
      } else {
        assert.ok(body.schema_read_required.includes(name));
        assert.match(body.hint, /ordered local chunks/);
        assert.match(body.hint, /schema_handles/);
        let cursor = body.schema_handles[name].cursor;
        let serialized = '';
        let pages = 0;
        while (cursor) {
          assert.ok(++pages <= 64, 'schema recovery must finish in bounded local pages');
          const page = JSON.parse((await handler({ query, cursor })).content[0]!.text);
          if (page.schema) { serialized = JSON.stringify(page.schema); break; }
          serialized += page.chunk;
          cursor = page.next_cursor;
        }
        assert.deepEqual(JSON.parse(serialized), schema, 'all omitted schema bytes remain recoverable');
        assert.equal(sourceCalls, 1, 'schema recovery must not repeat provider discovery');
      }
    });
  }
}
