/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/mcp-file-inputs.test.ts
 *
 * An MCP tool that takes file content gets the bytes of the local file the
 * call names, by its own schema, never by its server's name.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-mcp-file-inputs-'));
process.env.CLEMENTINE_HOME = path.join(HOME, '.clementine-next');
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.HOME = HOME;
mkdirSync(path.join(HOME, '.clementine-next'), { recursive: true });
const { mcpArgumentsWithFileContent } = await import('./mcp-file-inputs.js');
after(() => rmSync(HOME, { recursive: true, force: true }));

const doc = path.join(HOME, 'Documents', 'contract.pdf');
mkdirSync(path.dirname(doc), { recursive: true });
writeFileSync(doc, 'PDF bytes');
const base64 = Buffer.from('PDF bytes').toString('base64');

test('declared file content carries the named file\'s bytes; everything else is sent as given', () => {
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string', contentEncoding: 'base64', contentMediaType: 'application/pdf' },
      pages: { type: 'array', items: { type: 'object', properties: { data: { type: 'string', format: 'byte' }, note: { type: 'string' } } } },
      maybe: { anyOf: [{ type: 'string', format: 'binary' }, { type: 'null' }] },
      link: { type: 'string', format: 'uri' },
    },
  };
  const args = { title: doc, content: doc, pages: [{ data: doc, note: doc }], maybe: doc, link: doc };
  const out = mcpArgumentsWithFileContent(schema, args);
  assert.equal(out.title, doc, 'a plain string that happens to be a path is not file content');
  assert.equal(out.content, base64);
  assert.deepEqual(out.pages, [{ data: base64, note: doc }]);
  assert.equal(out.maybe, base64);
  assert.equal(out.link, doc, 'a URI is not file content');
  assert.deepEqual(args.content, doc, 'the call\'s own arguments are not changed');
  const already = { content: 'UERGIGJ5dGVz' };
  assert.equal(mcpArgumentsWithFileContent(schema, already), already, 'content already given is sent as is, same object');
});

test('a file that cannot be sent refuses before the request, with the pre-dispatch marker', () => {
  const schema = { type: 'object', properties: { content: { type: 'string', contentEncoding: 'base64' } } };
  assert.throws(() => mcpArgumentsWithFileContent(schema, { content: path.join(HOME, 'missing.pdf') }), (error: unknown) =>
    error instanceof Error && error.name === 'ProviderPreDispatchRefusalError' && /There is no file at/.test(error.message) && /Nothing was sent/.test(error.message));
  writeFileSync(path.join(HOME, '.env'), 'SECRET=1');
  assert.throws(() => mcpArgumentsWithFileContent(schema, { content: path.join(HOME, '.env') }), /never sent anywhere/);
});
