import assert from 'node:assert/strict';
import test from 'node:test';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { resolveConfiguredLocalPlanningTool } from './local-planning-capability.js';
import { reviewWorkflowMutation } from './workflow-mutation-review.js';

for (const carrier of ['work_call', 'call_tool'] as const) {
  test(`native refresh ${carrier} schema reaches the constraint reviewer as JSON`, async () => {
    const tool = await resolveConfiguredLocalPlanningTool('space_refresh', carrier);
    assert.ok(tool);
    const schema = JSON.parse(closedCanonicalJson(tool.parameters));
    assert.equal(schema.type, 'object');
    assert.equal(schema.properties.slug.type, 'string');
    assert.equal(schema.properties.slug.minLength, 2);
    assert.ok(schema.required.includes('slug'));
    assert.ok(!schema.required.includes('source_id'));
    let reviewed = false;
    const result = await reviewWorkflowMutation({ sessionId: 'schema-review-fixture',
      instructions: 'Refresh the named workspace after its inputs are updated.', tool: tool.name,
      schema: tool.parameters, args: { slug: 'fixture-workspace', source_id: null },
      observations: { complete: false, summary: 'The named workspace exists.' },
    }, { judge: async (_system, prompt, parse) => {
      reviewed = true;
      const packet = JSON.parse(prompt);
      assert.deepEqual(packet.schema, schema);
      return { value: parse({ verdict: 'compatible', reason: 'The exact named workspace is authorized.',
        proposalDigest: packet.proposalDigest }), failure: null };
    } });
    assert.equal(reviewed, true);
    assert.equal(result.verdict, 'compatible');
  });
}
