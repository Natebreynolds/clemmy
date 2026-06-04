/**
 * Run: npx tsx --test src/integrations/composio/client.toolkit-merge.test.ts
 *
 * Regression guard for the curated-tool discovery fix (2026-06-03). The
 * Composio SDK always pins toolkit_versions="latest", which returns the RAW
 * OpenAPI set and EXCLUDES curated actions (e.g. OUTLOOK_OUTLOOK_SEND_EMAIL).
 * listComposioToolkitTools now ALSO fetches the curated set via a direct v3
 * call (no version) and merges it with the raw SDK set, so send/reply/draft
 * become discoverable without losing raw coverage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listComposioToolkitTools, resolveComposioToolVersion } from './client.js';

function withMockedFetch(impl: typeof fetch, run: () => Promise<void>): Promise<void> {
  const prevFetch = globalThis.fetch;
  const prevKey = process.env.COMPOSIO_API_KEY;
  // Ensure an API key resolves (vault wins locally; this covers CI with no vault).
  process.env.COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY || 'test-key';
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.COMPOSIO_API_KEY;
    else process.env.COMPOSIO_API_KEY = prevKey;
  });
}

test('merges curated (direct v3, no version pin) with the raw SDK set and de-dups by slug', async () => {
  let fetchedUrl = '';
  const mockFetch = (async (url: string | URL | Request) => {
    fetchedUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        items: [
          { slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', name: 'Send email', description: 'Sends an email', input_parameters: { required: ['subject', 'body', 'to_email'] } },
          { slug: 'OUTLOOK_CREATE_DRAFT', name: 'Create draft (curated)', description: 'curated variant' },
        ],
      }),
    } as Response;
  }) as typeof fetch;

  const fakeComposio = {
    client: { baseURL: 'https://backend.composio.dev' },
    tools: {
      getRawComposioTools: async () => ([
        { slug: 'OUTLOOK_CREATE_DRAFT', name: 'Create draft (raw)', description: 'raw variant' },
        { slug: 'OUTLOOK_FORWARD_MESSAGE', name: 'Forward message', description: 'raw' },
      ]),
    },
  };

  await withMockedFetch(mockFetch, async () => {
    const tools = await listComposioToolkitTools('outlook', 50, fakeComposio);
    const slugs = tools.map((t) => t.slug);

    assert.ok(slugs.includes('OUTLOOK_OUTLOOK_SEND_EMAIL'), 'curated send tool is surfaced');
    assert.ok(slugs.includes('OUTLOOK_FORWARD_MESSAGE'), 'raw single-prefix tools are preserved (no regression)');
    assert.equal(slugs.filter((s) => s === 'OUTLOOK_CREATE_DRAFT').length, 1, 'de-dups overlapping slug');
    assert.equal(
      tools.find((t) => t.slug === 'OUTLOOK_CREATE_DRAFT')?.name,
      'Create draft (curated)',
      'curated entry wins de-dup (ingested first)',
    );
    // The curated fetch must hit the v3 tools endpoint WITHOUT a version pin.
    assert.match(fetchedUrl, /\/api\/v3\/tools\?toolkit_slug=outlook/);
    assert.doesNotMatch(fetchedUrl, /toolkit_versions/);
  });
});

test('falls back to the raw set when the curated fetch fails (best-effort, no throw)', async () => {
  const mockFetch = (async () => { throw new Error('network down'); }) as typeof fetch;
  const fakeComposio = {
    client: { baseURL: 'https://x' },
    tools: { getRawComposioTools: async () => ([{ slug: 'OUTLOOK_FORWARD_MESSAGE', name: 'Forward message' }]) },
  };
  await withMockedFetch(mockFetch, async () => {
    const tools = await listComposioToolkitTools('outlook', 50, fakeComposio);
    assert.deepEqual(tools.map((t) => t.slug), ['OUTLOOK_FORWARD_MESSAGE'], 'raw set returned despite curated failure');
  });
});

test('returns the curated set even when the raw SDK call fails', async () => {
  const mockFetch = (async () => ({
    ok: true,
    json: async () => ({ items: [{ slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', name: 'Send email' }] }),
  } as Response)) as typeof fetch;
  const fakeComposio = {
    client: { baseURL: 'https://backend.composio.dev' },
    tools: { getRawComposioTools: async () => { throw new Error('sdk boom'); } },
  };
  await withMockedFetch(mockFetch, async () => {
    const tools = await listComposioToolkitTools('outlook', 50, fakeComposio);
    assert.deepEqual(tools.map((t) => t.slug), ['OUTLOOK_OUTLOOK_SEND_EMAIL'], 'curated returned despite raw failure');
  });
});

// ─── v0.5.65: execute-side version resolution for curated slugs ─────────────
test('resolveComposioToolVersion returns the curated slug pinned version (version-free v3 retrieve)', async () => {
  let fetchedUrl = '';
  const mockFetch = (async (url: string | URL | Request) => {
    fetchedUrl = String(url);
    return { ok: true, json: async () => ({ slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', version: '00000000_00' }) } as Response;
  }) as typeof fetch;
  await withMockedFetch(mockFetch, async () => {
    const v = await resolveComposioToolVersion('OUTLOOK_OUTLOOK_SEND_EMAIL');
    assert.equal(v, '00000000_00', 'returns the tool\'s own version so execute can pin it');
    assert.match(fetchedUrl, /\/api\/v3\/tools\/OUTLOOK_OUTLOOK_SEND_EMAIL/);
    assert.doesNotMatch(fetchedUrl, /toolkit_versions|[?]version=/, 'retrieves version-free (so the curated slug resolves)');
  });
});

test('resolveComposioToolVersion returns undefined on non-ok or missing version (best-effort)', async () => {
  await withMockedFetch((async () => ({ ok: false } as Response)) as typeof fetch, async () => {
    assert.equal(await resolveComposioToolVersion('X_TOOL'), undefined);
  });
  await withMockedFetch((async () => ({ ok: true, json: async () => ({ slug: 'X_TOOL' }) } as Response)) as typeof fetch, async () => {
    assert.equal(await resolveComposioToolVersion('X_TOOL'), undefined, 'no version field → undefined (caller falls through)');
  });
});
