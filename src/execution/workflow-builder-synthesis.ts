/**
 * Convert workflow analysis into executable workflow definitions.
 * This bridges the intelligent breakdown with workflow_create.
 */

import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';
import type { WorkflowBuilderAnalysis, SuggestedStep } from './workflow-builder-analysis.js';

/**
 * Generate a detailed prompt for a workflow step based on its intent and context.
 */
function generateStepPrompt(
  step: SuggestedStep,
  analysis: WorkflowBuilderAnalysis,
  upstreamSteps: SuggestedStep[],
): string {
  const inputFromUpstream = upstreamSteps.length > 0
    ? `\n\nData from previous steps:\n${upstreamSteps.map(s => `- {{steps.${s.id}.output}}`).join('\n')}`
    : '';

  const dataFlow = step.inputFields && step.inputFields.length > 0
    ? `\n\nRequired inputs: ${step.inputFields.join(', ')}`
    : '';

  // Build a contextual prompt based on the step's intent
  let prompt = '';
  if (step.intent.includes('research') || step.intent.includes('fetch') || step.intent.includes('search')) {
    prompt = `${step.title.toUpperCase()}\n\nGather information about the target. Use available tools to research and collect relevant data.${inputFromUpstream}${dataFlow}\n\nReturn structured JSON with the gathered information.`;
  } else if (step.intent.includes('analyze') || step.intent.includes('process')) {
    prompt = `${step.title.toUpperCase()}\n\nAnalyze the gathered data and extract insights.${inputFromUpstream}${dataFlow}\n\nReturn structured JSON with analysis results.`;
  } else if (step.intent.includes('build') || step.intent.includes('create') || step.intent.includes('generate')) {
    prompt = `${step.title.toUpperCase()}\n\nCreate or build the output deliverable based on previous steps.${inputFromUpstream}${dataFlow}\n\nReturn JSON with file path or content.`;
  } else if (step.intent.includes('send') || step.intent.includes('deliver') || step.intent.includes('publish')) {
    prompt = `${step.title.toUpperCase()}\n\nDeliver or send the completed work to the destination.${inputFromUpstream}${dataFlow}\n\nReturn confirmation JSON.`;
  } else {
    prompt = `${step.title.toUpperCase()}\n\nPerform this step: ${step.intent}${inputFromUpstream}${dataFlow}\n\nReturn structured JSON with results.`;
  }

  return prompt;
}

/**
 * Convert a suggested step into a workflow step definition.
 */
function suggestedToWorkflowStep(
  step: SuggestedStep,
  analysis: WorkflowBuilderAnalysis,
  allSteps: SuggestedStep[],
): WorkflowStepInput {
  const upstreamSteps = allSteps.filter(s => step.dependsOn?.includes(s.id));
  const prompt = generateStepPrompt(step, analysis, upstreamSteps);

  const output = step.expectedOutputType
    ? {
      type: step.expectedOutputType as 'string' | 'object' | 'array',
      ...(step.expectedOutputType === 'object' ? { required_keys: ['status', 'data'] } : {}),
    }
    : undefined;

  return {
    id: step.id,
    prompt,
    dependsOn: step.dependsOn,
    allowedTools: step.suggestedTools.length > 0 ? step.suggestedTools : ['composio_execute_tool'],
    output,
  };
}

/**
 * Convert workflow analysis into a complete WorkflowDefinition ready for workflow_create.
 */
export function synthesizeWorkflowDefinition(analysis: WorkflowBuilderAnalysis): WorkflowDefinition {
  const steps: WorkflowStepInput[] = analysis.suggestedSteps.map(
    step => suggestedToWorkflowStep(step, analysis, analysis.suggestedSteps),
  );

  return {
    name: analysis.name,
    description: analysis.description,
    enabled: false, // Always start disabled for testing
    trigger: { manual: true },
    steps,
    inputs: Object.keys(analysis.suggestedInputs).length > 0 ? analysis.suggestedInputs : undefined,
  };
}

/**
 * Render the analysis as a user-friendly decision guide.
 */
export function renderAnalysisForApproval(analysis: WorkflowBuilderAnalysis): string {
  const stepsSummary = analysis.suggestedSteps
    .map((step, idx) => {
      const tools = step.suggestedTools.slice(0, 2).join(', ') + (step.suggestedTools.length > 2 ? '...' : '');
      const deps = step.dependsOn && step.dependsOn.length > 0 ? ` → depends on: ${step.dependsOn.join(', ')}` : '';
      return `${idx + 1}. **${step.title}** (${tools})${deps}`;
    })
    .join('\n');

  const parallelGroups = analysis.parallelizationOpportunities.length > 0
    ? `\n\n✨ **Can run in parallel:** ${analysis.parallelizationOpportunities.map(g => `(${g.join(', ')})`).join(', ')}`
    : '';

  const questionsMarkdown = analysis.concerns.length > 0
    ? `\n\n⚠️ **Questions for you:**\n${analysis.concerns.map(c => `- ${c}`).join('\n')}`
    : '';

  return `## Workflow Plan: ${analysis.name}\n\n${stepsSummary}${parallelGroups}${questionsMarkdown}`;
}

/**
 * Generate a summary of what inputs the workflow will need from the user.
 */
export function summarizeRequiredInputs(analysis: WorkflowBuilderAnalysis): string {
  const inputs = Object.entries(analysis.suggestedInputs);
  if (inputs.length === 0) return 'This workflow has no required inputs.';

  return `When you run this workflow, you'll need to provide:\n${inputs.map(([k, v]) => `- **${k}** (${v.type}): ${v.description}`).join('\n')}`;
}
