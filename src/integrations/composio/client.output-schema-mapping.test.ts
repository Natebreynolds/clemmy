import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-output-schema-mapping-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const {
  __test__,
  getExactComposioToolBySlug,
  listComposioToolkitTools,
  resetComposioClient,
  searchConnectedComposioTools,
} = await import('./client.js');

test.after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const schema = (row: string, side: 'input' | 'output') => ({
  type: 'object',
  properties: {
    [`${row}_${side}`]: { type: 'string' },
  },
});

function assertSameRowSchemas(
  tool: { inputParameters?: unknown; outputParameters?: unknown } | null | undefined,
  row: string,
): void {
  assert.ok(tool, `missing ${row} tool`);
  assert.deepEqual(tool.inputParameters, schema(row, 'input'));
  assert.deepEqual(tool.outputParameters, schema(row, 'output'));
}

test('exact SDK mapping retains camel and snake output schema from each exact provider row', async () => {
  const rows: Record<string, Record<string, unknown>> = {
    MAILBOX_EXACT_CAMEL: {
      slug: 'MAILBOX_EXACT_CAMEL',
      name: 'camel exact',
      inputParameters: schema('exact_camel', 'input'),
      outputParameters: schema('exact_camel', 'output'),
    },
    MAILBOX_EXACT_SNAKE: {
      slug: 'MAILBOX_EXACT_SNAKE',
      name: 'snake exact',
      input_parameters: schema('exact_snake', 'input'),
      output_parameters: schema('exact_snake', 'output'),
    },
    MAILBOX_EXACT_ABSENT: {
      slug: 'MAILBOX_EXACT_ABSENT',
      name: 'absent exact',
      inputParameters: schema('exact_absent', 'input'),
    },
  };
  __test__.setComposioClient({
    tools: {
      getRawComposioTools: async (options: { tools?: string[] }) => {
        const wanted = options.tools?.[0] ?? '';
        return rows[wanted] ? [rows[wanted]] : [];
      },
    },
  });
  try {
    assertSameRowSchemas(await getExactComposioToolBySlug('MAILBOX_EXACT_CAMEL'), 'exact_camel');
    assertSameRowSchemas(await getExactComposioToolBySlug('MAILBOX_EXACT_SNAKE'), 'exact_snake');
    const absent = await getExactComposioToolBySlug('MAILBOX_EXACT_ABSENT');
    assert.deepEqual(absent?.inputParameters, schema('exact_absent', 'input'));
    assert.equal(absent?.outputParameters, undefined, 'an absent provider output schema is never invented');
  } finally {
    resetComposioClient();
  }
});

test('toolkit list mapping retains output aliases from the same curated/raw rows', async () => {
  const previousFetch = globalThis.fetch;
  __test__.setComposioApiKeyOverride('test-output-schema-key');
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      items: [
        {
          slug: 'MAILBOX_LIST_SNAKE',
          name: 'snake curated',
          input_parameters: schema('list_snake', 'input'),
          output_parameters: schema('list_snake', 'output'),
        },
        {
          slug: 'MAILBOX_LIST_ABSENT',
          name: 'absent curated',
          input_parameters: schema('list_absent', 'input'),
        },
      ],
    }),
  } as Response)) as typeof fetch;
  const client = {
    client: { baseURL: 'https://provider.example.test' },
    tools: {
      getRawComposioTools: async () => ([{
        slug: 'MAILBOX_LIST_CAMEL',
        name: 'camel raw',
        inputParameters: schema('list_camel', 'input'),
        outputParameters: schema('list_camel', 'output'),
      }]),
    },
  };
  try {
    const tools = await listComposioToolkitTools('mailbox', 20, client);
    assertSameRowSchemas(tools.find((tool) => tool.slug === 'MAILBOX_LIST_CAMEL'), 'list_camel');
    assertSameRowSchemas(tools.find((tool) => tool.slug === 'MAILBOX_LIST_SNAKE'), 'list_snake');
    const absent = tools.find((tool) => tool.slug === 'MAILBOX_LIST_ABSENT');
    assert.deepEqual(absent?.inputParameters, schema('list_absent', 'input'));
    assert.equal(absent?.outputParameters, undefined, 'a schema-less output remains absent in list mapping');
  } finally {
    globalThis.fetch = previousFetch;
    __test__.setComposioApiKeyOverride(null);
    resetComposioClient();
  }
});

test('connected search mapping retains output aliases from each filtered provider row', async () => {
  let observedOptions: unknown;
  __test__.setComposioClient({
    tools: {
      getRawComposioTools: async (options: unknown) => {
        observedOptions = options;
        return {
          items: [
            {
              slug: 'MAILBOX_SEARCH_CAMEL',
              name: 'camel search',
              toolkit: { slug: 'mailbox' },
              inputParameters: schema('search_camel', 'input'),
              outputParameters: schema('search_camel', 'output'),
            },
            {
              slug: 'MAILBOX_SEARCH_SNAKE',
              name: 'snake search',
              toolkit_slug: 'mailbox',
              input_parameters: schema('search_snake', 'input'),
              output_parameters: schema('search_snake', 'output'),
            },
            {
              slug: 'MAILBOX_SEARCH_ABSENT',
              name: 'absent search',
              toolkit: { slug: 'mailbox' },
              inputParameters: schema('search_absent', 'input'),
            },
          ],
        };
      },
    },
  });
  try {
    const tools = await searchConnectedComposioTools(['mailbox'], 'find messages', 8);
    assert.deepEqual(observedOptions, {
      toolkits: ['mailbox'],
      search: 'find messages',
      limit: 16,
    });
    assertSameRowSchemas(tools.find((tool) => tool.slug === 'MAILBOX_SEARCH_CAMEL'), 'search_camel');
    assertSameRowSchemas(tools.find((tool) => tool.slug === 'MAILBOX_SEARCH_SNAKE'), 'search_snake');
    const absent = tools.find((tool) => tool.slug === 'MAILBOX_SEARCH_ABSENT');
    assert.deepEqual(absent?.inputParameters, schema('search_absent', 'input'));
    assert.equal(absent?.outputParameters, undefined, 'a schema-less output remains absent in search mapping');
  } finally {
    resetComposioClient();
  }
});

test('CLI exact lookup never treats CLI output fields as provider output-schema authority', async (t) => {
  const previousCliPath = process.env.COMPOSIO_CLI_PATH;
  const taskDir = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cli-output-schema-'));
  t.after(() => rmSync(taskDir, { recursive: true, force: true }));
  const cli = path.join(taskDir, 'composio');
  const cliInput = schema('cli_exact', 'input');
  writeFileSync(cli, [
    '#!/bin/sh',
    `printf '%s\\n' '${JSON.stringify({
      matches: [{
        tool_slug: 'MAILBOX_CLI_EXACT',
        inputParameters: cliInput,
        outputParameters: schema('cli_untrusted_camel', 'output'),
        output_parameters: schema('cli_untrusted_snake', 'output'),
      }],
    })}'`,
    'exit 0',
    '',
  ].join('\n'), 'utf8');
  chmodSync(cli, 0o755);
  process.env.COMPOSIO_CLI_PATH = cli;
  __test__.setComposioClient(null);
  __test__.setComposioApiKeyOverride('');
  try {
    const tool = await getExactComposioToolBySlug('MAILBOX_CLI_EXACT');
    assert.deepEqual(tool?.inputParameters, cliInput);
    assert.equal(tool?.outputParameters, undefined);
    assert.equal(
      Object.prototype.hasOwnProperty.call(tool, 'outputParameters'),
      false,
      'CLI rows cannot mint even an empty output-schema field',
    );
  } finally {
    __test__.setComposioApiKeyOverride(null);
    resetComposioClient();
    if (previousCliPath === undefined) delete process.env.COMPOSIO_CLI_PATH;
    else process.env.COMPOSIO_CLI_PATH = previousCliPath;
  }
});
