import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindHostLocalCallPreparation, prepareDirectHostLocalCall } from './host-local-call-preparation.js';
import { catalogEntries, resolveHotSet } from '../../agents/tool-catalog.js';
import { TOOL_REGISTRY } from '../../tools/tool-registry.js';
import { NATIVE_PRODUCT_AUTHORING_TOOLS } from '../../tools/native-product-surface.js';

// These checks do not open/reset a database or write a fixture home. Invalid
// authority and excluded tools return before registry observation/publication.
const call = { sessionId: 'unbound-native-probe', sourceUserSeq: 1,
  operationId: 'workflow_create', args: { name: 'unbound', steps: [] } };
const unavailablePlanning = { authority: {} } as Parameters<typeof bindHostLocalCallPreparation>[1]['planning'];

test('native schemas are stable product entries, independent of prompt wording', () => {
  for (const name of NATIVE_PRODUCT_AUTHORING_TOOLS) {
    assert(catalogEntries().some(entry => entry.name === name), 'native entry remains discoverable');
    assert(resolveHotSet(undefined, name).has(name), 'explicit selection exposes the native schema');
    assert(!catalogEntries({ allowedNames: new Set() }).some(entry => entry.name === name),
      'discovery must respect the captured tool policy');
    const declaration = TOOL_REGISTRY.find(tool => tool.name === name);
    assert(declaration?.localPlanning);
    assert.equal(declaration.localPlanning.reversibility, 'reversible');
    assert.equal(declaration.localPlanning.destructive, false);
  }
  for (const name of ['workflow_run', 'workflow_run_status', 'workflow_get', 'space_get']) {
    assert(catalogEntries().some(entry => entry.name === name), 'native entry remains discoverable');
    assert(resolveHotSet(undefined, name).has(name), 'explicit selection exposes the native schema');
    assert(!catalogEntries({ allowedNames: new Set() }).some(entry => entry.name === name),
      'discovery must respect the captured tool policy');
  }
});

test('direct preparation cannot manufacture current-source authority', async () => {
  assert.equal(await prepareDirectHostLocalCall({}, call), null);
  const agent = {};
  bindHostLocalCallPreparation(agent, { planning: unavailablePlanning, configuredNames: new Set(['workflow_create']) });
  assert.equal(await prepareDirectHostLocalCall(agent, call), null);
});

test('direct preparation respects the captured configured and denied names', async () => {
  for (const config of [
    { configuredNames: new Set<string>() },
    { configuredNames: new Set(['workflow_create']), deniedNames: new Set(['workflow_create']) },
  ]) {
    const agent = {};
    bindHostLocalCallPreparation(agent, { planning: unavailablePlanning, ...config });
    assert.equal(await prepareDirectHostLocalCall(agent, call), null);
  }
});
