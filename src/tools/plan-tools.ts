import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { plans, textResult } from './shared.js';

export function registerPlanTools(server: McpServer): void {
  server.tool(
    'create_plan',
    'Create a lightweight execution plan with concrete steps. Optional parallel `verifications` array supplies one verification check per step ("how will we know this step worked") — same length as steps, leave individual entries empty when no meaningful check exists.',
    {
      title: z.string().min(1),
      steps: z.array(z.string().min(1)).min(1).max(12),
      verifications: z.array(z.string()).max(12).optional()
        .describe('Optional parallel array of verification checks, one per step. Same length as steps. Empty strings (or omitting the array) leave the step without a typed verify check.'),
      session_id: z.string().min(1).optional(),
    },
    async ({ title, steps, verifications, session_id }) => {
      const richSteps = steps.map((text, index) => {
        const verify = verifications?.[index]?.trim();
        return verify ? { text, verify } : text;
      });
      const plan = plans.create(title, richSteps, { sessionId: session_id, source: 'manual' });
      return textResult(`Created plan ${plan.id} with ${plan.steps.length} steps.`);
    },
  );

  server.tool(
    'list_plans',
    'List the most recent plans and their progress.',
    {},
    async () => {
      const items = plans.list(8);
      if (items.length === 0) return textResult('No plans found.');
      return textResult(
        items
          .map((plan) => {
            const done = plan.steps.filter((step) => step.status === 'done').length;
            return `- ${plan.id} | ${plan.title} | ${done}/${plan.steps.length} complete`;
          })
          .join('\n'),
      );
    },
  );

  server.tool(
    'update_plan_step',
    'Update the status of a step in a saved plan.',
    {
      planId: z.string().min(1),
      stepId: z.string().min(1),
      status: z.enum(['pending', 'in_progress', 'done']),
    },
    async ({ planId, stepId, status }) => {
      const plan = plans.updateStep(planId, stepId, status);
      if (!plan) return textResult('Plan or step not found.');
      return textResult(`Updated ${stepId} in ${plan.title} to ${status}.`);
    },
  );
}
