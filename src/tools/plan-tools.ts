import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { plans, textResult } from './shared.js';

export function registerPlanTools(server: McpServer): void {
  server.tool(
    'create_plan',
    'Create a lightweight execution plan with concrete steps.',
    {
      title: z.string().min(1),
      steps: z.array(z.string().min(1)).min(1).max(12),
    },
    async ({ title, steps }) => {
      const plan = plans.create(title, steps);
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
