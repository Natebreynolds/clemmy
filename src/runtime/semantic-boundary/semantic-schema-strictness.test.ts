/** Run: npx tsx --test src/runtime/semantic-boundary/semantic-schema-strictness.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';
import { zodTextFormat } from 'openai/helpers/zod';
import {
  PlanGroundingJudgeV1Schema,
  SourceEffectJudgeV1Schema,
  TurnSemanticProposalV1Schema,
} from './turn-semantic-proposal.js';
import { fakeSemanticProposal } from './fake-semantic-model.js';
import { buildTurnSemanticHostViewV1 } from './build-semantic-host-view.js';

function schemaIsStrict(schema: { safeParse: (value: unknown) => { success: boolean } }): boolean {
  return schema.safeParse({}).success === false
    && schema.safeParse({ extra: true }).success === false;
}

test('production structured-output schemas are strict and parse their own results', () => {
  assert.equal(schemaIsStrict(TurnSemanticProposalV1Schema), true);
  assert.equal(schemaIsStrict(SourceEffectJudgeV1Schema), true);
  const host = buildTurnSemanticHostViewV1({
    sessionId: 'sess-schema',
    sourceUserSeq: 1,
    acceptedText: 'find five widgets and put them in a workbook',
    audienceKey: 'aud-1',
    userId: 'user-1',
    conversationKey: 'conv-1',
    policyRevision: 'd'.repeat(64),
  });
  const proposal = fakeSemanticProposal('newConstruct', host);
  const parsed = TurnSemanticProposalV1Schema.safeParse(proposal);
  assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
  const judge = {
    verdict: 'entailed',
    effect: 'external_write',
    destinationPosture: 'create_new',
    proposalDigest: 'a'.repeat(64),
    rationale: 'schema-roundtrip',
  };
  const judged = SourceEffectJudgeV1Schema.safeParse(judge);
  assert.equal(judged.success, true);
  const grounding = {
    verdict: 'entailed',
    operations: [
      { operationId: 'op-source', verdict: 'entailed', rationale: '' },
      { operationId: 'op-write', verdict: 'entailed', rationale: '' },
    ],
  };
  assert.equal(PlanGroundingJudgeV1Schema.safeParse(grounding).success, true);
  assert.equal(PlanGroundingJudgeV1Schema.safeParse({ ...grounding, extra: true }).success, false);
  assert.equal(TurnSemanticProposalV1Schema.safeParse({ ...proposal, extra: true }).success, false);
  assert.equal(SourceEffectJudgeV1Schema.safeParse({ ...judge, extra: true }).success, false);
  const proposalFormat = zodTextFormat(TurnSemanticProposalV1Schema, 'TurnSemanticProposalV1');
  const judgeFormat = zodTextFormat(SourceEffectJudgeV1Schema, 'SourceEffectJudgeV1');
  const groundingFormat = zodTextFormat(PlanGroundingJudgeV1Schema, 'PlanGroundingJudgeV1');
  assert.equal(proposalFormat.strict, true, JSON.stringify(proposalFormat));
  assert.equal(judgeFormat.strict, true, JSON.stringify(judgeFormat));
  assert.equal(groundingFormat.strict, true, JSON.stringify(groundingFormat));
  const proposalJsonSchema = proposalFormat.schema as {
    required?: string[];
    properties?: {
      work?: { anyOf?: Array<{ required?: string[] }> };
    };
  };
  assert.deepEqual(proposalJsonSchema.required, [
    'version',
    'relation',
    'targetGoal',
    'goal',
    'work',
    'slotAnswers',
    'rationale',
  ]);
  // `destinations` (plural) is the canonical sink list; `destination` remains
  // its [0] projection for existing proposal authors. Strict structured output
  // requires EVERY field in `required`, which is why the plural field must be
  // `.nullish()` and not bare `.optional()`.
  assert.deepEqual(proposalJsonSchema.properties?.work?.anyOf?.[0]?.required, [
    'construct',
    'cardinality',
    'destinations',
    'destination',
    'requestedEffect',
    'operations',
    'deliverables',
    'evidenceRequirements',
  ]);
  const operationSchema = (proposalJsonSchema.properties?.work?.anyOf?.[0] as {
    properties?: { operations?: { items?: { required?: string[]; properties?: { capabilityRef?: { anyOf?: unknown[] } } } } };
  })?.properties?.operations?.items;
  assert.ok(operationSchema?.required?.includes('capabilityRef'), JSON.stringify(operationSchema?.required));
  assert.equal(proposal.work?.operations.every((operation) => 'capabilityRef' in operation), true);
  const missingRef = structuredClone(proposal);
  if (missingRef.work?.operations[0]) {
    delete (missingRef.work.operations[0] as { capabilityRef?: unknown }).capabilityRef;
  }
  assert.equal(TurnSemanticProposalV1Schema.safeParse(missingRef).success, false);
});
