import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  __test__,
  composioToolSchemaObservedAt,
  exactComposioCliSchemaFromSearch,
  getComposioToolBySlug,
} from './client.js';

test('exact CLI schema projection accepts only the requested primary slug and mapped safe file', () => {
  const taskHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-exact-cli-schema-'));
  const schemaRoot = path.join(taskHome, '.composio', 'tool_definitions');
  mkdirSync(schemaRoot, { recursive: true });
  const schemaFile = path.join(schemaRoot, 'CHATCO_SEND_MESSAGE.json');
  writeFileSync(schemaFile, JSON.stringify({
    inputSchema: {
      type: 'object',
      required: ['destination', 'body'],
      properties: {
        destination: { type: 'string' },
        body: { type: 'string' },
      },
    },
  }), 'utf8');

  const search = {
    results: [{ primary_tool_slugs: ['CHATCO_SEND_MESSAGE'] }],
    tool_schemas: { primary: { CHATCO_SEND_MESSAGE: schemaFile } },
  };
  assert.deepEqual(
    exactComposioCliSchemaFromSearch(search, 'chatco_send_message', taskHome),
    {
      type: 'object',
      required: ['destination', 'body'],
      properties: {
        destination: { type: 'string' },
        body: { type: 'string' },
      },
    },
  );

  assert.equal(
    exactComposioCliSchemaFromSearch({
      results: [{ related_tool_slugs: ['CHATCO_SEND_MESSAGE'] }],
      tool_schemas: { primary: { CHATCO_SEND_MESSAGE: schemaFile } },
    }, 'CHATCO_SEND_MESSAGE', taskHome),
    null,
    'a related candidate is not executable schema authority',
  );
  assert.equal(
    exactComposioCliSchemaFromSearch({
      results: [{ primary_tool_slugs: ['CHATCO_SEND_CHANNEL_MESSAGE'] }],
      tool_schemas: { primary: { CHATCO_SEND_MESSAGE: schemaFile } },
    }, 'CHATCO_SEND_MESSAGE', taskHome),
    null,
    'a schema mapping cannot authorize a different primary result',
  );
});

test('exact CLI schema projection rejects escaped and wrong-name schema paths', () => {
  const taskHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-exact-cli-schema-escape-'));
  const schemaRoot = path.join(taskHome, '.composio', 'tool_definitions');
  mkdirSync(schemaRoot, { recursive: true });
  const outside = path.join(taskHome, 'CHATCO_SEND_MESSAGE.json');
  const wrongName = path.join(schemaRoot, 'OTHER_SEND_MESSAGE.json');
  const body = JSON.stringify({ inputSchema: { type: 'object', properties: {} } });
  writeFileSync(outside, body, 'utf8');
  writeFileSync(wrongName, body, 'utf8');
  const resultFor = (schemaPath: string) => ({
    results: [{ primary_tool_slugs: ['CHATCO_SEND_MESSAGE'] }],
    tool_schemas: { primary: { CHATCO_SEND_MESSAGE: schemaPath } },
  });

  assert.equal(
    exactComposioCliSchemaFromSearch(resultFor(outside), 'CHATCO_SEND_MESSAGE', taskHome),
    null,
  );
  assert.equal(
    exactComposioCliSchemaFromSearch(resultFor(wrongName), 'CHATCO_SEND_MESSAGE', taskHome),
    null,
  );
});

test('exact CLI schema projection accepts inline schema only on an exact slug row', () => {
  const schema = { type: 'object', required: ['body'], properties: { body: { type: 'string' } } };
  assert.deepEqual(
    exactComposioCliSchemaFromSearch({
      matches: [{ tool_slug: 'CHATCO_SEND_MESSAGE', inputParameters: schema }],
    }, 'CHATCO_SEND_MESSAGE'),
    schema,
  );
  assert.equal(
    exactComposioCliSchemaFromSearch({
      matches: [{ tool_slug: 'CHATCO_SEND_CHANNEL_MESSAGE', inputParameters: schema }],
    }, 'CHATCO_SEND_MESSAGE'),
    null,
  );
  assert.equal(
    exactComposioCliSchemaFromSearch({
      related_tools: [{ tool_slug: 'CHATCO_SEND_MESSAGE', inputParameters: schema }],
    }, 'CHATCO_SEND_MESSAGE'),
    null,
    'an exact slug nested under a related-only section is not a primary match',
  );
});

test('SDK-absent exact slug lookup uses one constrained CLI search and stamps request-start authority', async () => {
  const oldCliPath = process.env.COMPOSIO_CLI_PATH;
  const taskDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-exact-cli-lookup-'));
  const cli = path.join(taskDir, 'composio');
  const argvLog = path.join(taskDir, 'argv.log');
  writeFileSync(cli, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${argvLog}"`,
    `printf '%s\\n' '{"matches":[{"tool_slug":"CHATCO_SEND_MESSAGE","inputParameters":{"type":"object","required":["body"],"properties":{"body":{"type":"string"}}}}]}'`,
    'exit 0',
    '',
  ].join('\n'), 'utf8');
  chmodSync(cli, 0o755);
  process.env.COMPOSIO_CLI_PATH = cli;
  __test__.setComposioClient(null);
  __test__.setComposioApiKeyOverride('');
  const startedAt = Date.now();
  try {
    const tool = await getComposioToolBySlug('CHATCO_SEND_MESSAGE');
    const finishedAt = Date.now();
    assert.equal(tool?.slug, 'CHATCO_SEND_MESSAGE');
    assert.deepEqual(tool?.inputParameters, {
      type: 'object',
      required: ['body'],
      properties: { body: { type: 'string' } },
    });
    const observedAt = composioToolSchemaObservedAt(tool!);
    assert.ok(observedAt !== undefined && observedAt >= startedAt && observedAt <= finishedAt);
    assert.deepEqual(readFileSync(argvLog, 'utf8').trim().split('\n'), [
      'search',
      'CHATCO_SEND_MESSAGE',
      '--toolkits',
      'chatco',
      '--limit',
      '1',
    ]);
  } finally {
    __test__.setComposioApiKeyOverride(null);
    __test__.setComposioClient(null);
    if (oldCliPath === undefined) delete process.env.COMPOSIO_CLI_PATH;
    else process.env.COMPOSIO_CLI_PATH = oldCliPath;
  }
});
