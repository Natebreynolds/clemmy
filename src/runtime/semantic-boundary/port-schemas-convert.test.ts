/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/semantic-boundary/port-schemas-convert.test.ts
 *
 * Every structured answer the configured port asks a model for must convert
 * to the wire's JSON schema with the SDK's own converter. Live 2026-10-01 a
 * recipe schema written with `.optional()` refused to convert and the
 * calendar watch could not learn a single read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tool } from '@openai/agents-core';
import {
  CalendarReadRecipeAnswerV1Schema,
  NoticingDecisionV1Schema,
  OperationDeliveryJudgeV1Schema,
  RequestEffectJudgeV1Schema,
  SourceAccountJudgeV1Schema,
} from './configured-brain-semantic-port.js';
import { NoticingAnswerWireV1Schema } from '../../agents/noticing.js';

test('every structured port answer converts to a wire JSON schema', () => {
  for (const [name, schema] of Object.entries({
    CalendarReadRecipeAnswerV1Schema, NoticingAnswerWireV1Schema, NoticingDecisionV1Schema,
    OperationDeliveryJudgeV1Schema, RequestEffectJudgeV1Schema, SourceAccountJudgeV1Schema,
  })) {
    // The public tool() builder runs the SDK's strict zod→JSON-schema
    // conversion on construction and throws the same error the port saw live.
    const built = tool({ name: name.toLowerCase(), description: name, parameters: schema as never, strict: true, execute: async () => 'ok' });
    assert.ok(built.parameters, `${name} converts`);
  }
});
