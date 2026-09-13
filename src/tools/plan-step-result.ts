import { tool } from '@openai/agents';
import { z } from 'zod';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { recordReviewedPlanStepResult } from '../runtime/harness/reviewed-plan-results.js';
import { acceptedPlanExecution } from '../runtime/harness/accepted-plan-execution.js';

const resultInput = z.object({
  step_id: z.string().min(1),
  data: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown()), z.number(), z.boolean(), z.null()]).optional().describe('The actual result value. Do not JSON-encode this value again. Follow the reviewed output shape below.'),
  data_json: z.string().min(1).optional().describe('Legacy alternative for an explicitly JSON-encoded result. Omit when supplying data.'),
}).strict();

export function buildPlanStepResultTool(identity?: { sessionId: string; sourceUserSeq: number }) {
  const steps = identity ? acceptedPlanExecution(identity.sessionId, identity.sourceUserSeq)?.artifact.structuredPlan?.steps : undefined;
  const outputs = Array.isArray(steps) ? steps.flatMap((step: any) => !step.capabilityRef && step.effect === 'compute'
    ? [{ step_id: step.id, consumedValues: steps.flatMap((consumer: any) => (consumer.dynamicBindings ?? [])
      .filter((binding: any) => binding.producerStepId === step.id)
      .map((binding: any) => ({ path: binding.outputPath, type: binding.expectedType ?? 'json' }))) }]
    : []) : [];
  // If every consumed output is a whole string, expose that actual contract
  // instead of encouraging an arbitrary object wrapper. Runtime validation
  // stays backward-compatible; this only improves the model-facing surface.
  const plainTextOutput = outputs.length > 0 && outputs.every(output => output.consumedValues.length > 0
    && output.consumedValues.every((value: any) => value.path === '' && value.type === 'string'));
  const parameters = z.toJSONSchema(resultInput, { unrepresentable: 'any', io: 'input' }) as any;
  if (plainTextOutput) parameters.properties.data = { type: 'string',
    description: 'The complete plain text result itself, with real line breaks. Do not wrap it in an object and do not serialize it to a JSON string literal. The host passes these exact text bytes to the consuming tool.' };
  return tool({
    name: 'plan_step_result',
    description: 'During Execute, record the actual output of a reviewed compute step after its research dependencies finish. Use step_id from the approved plan and data matching the reviewed output shapes below. '
      + (plainTextOutput ? 'This plan consumes plain text: put the complete text directly in data. ' : 'Use the actual JSON value required by each output path and type. ')
      + 'Legacy data_json is also accepted; supply only one representation. This stores model-authored work for later calls and recovery; it does not independently verify it or write to an external app. The host supplies this recorded value to the consuming tool; omit its bound argument fields rather than retyping the content. If a saved local file needs correction, record the corrected synthesis here, then call its same reviewed write step with the original destination. The host can revise its own receipt-verified file and retain prior bytes; it cannot overwrite an intervening edit or replay an external create or send. Do not record placeholders or results for tool steps.'
      + (outputs.length ? `\nReviewed output shapes (empty path means data itself): ${JSON.stringify(outputs)}` : ''),
    parameters,
    strict: false,
    execute: async input => {
      try {
        const { step_id, data, data_json } = resultInput.parse(input);
        if ((data === undefined) === (data_json === undefined)) throw new Error('Supply one JSON result in data or legacy data_json.');
        const context = harnessRunContextStorage.getStore();
        if (!context?.sessionId || !context.sourceUserSeq || context.workerScope) throw new Error('Only the parent Execute turn can record its reviewed synthesis.');
        return JSON.stringify(recordReviewedPlanStepResult({ sessionId: context.sessionId, sourceUserSeq: context.sourceUserSeq }, step_id, data === undefined ? JSON.parse(data_json!) : data));
      } catch (error) {
        return JSON.stringify({ ok: false, code: 'invalid_arguments', message: error instanceof Error ? error.message : 'Could not record the reviewed result.' });
      }
    },
  });
}
