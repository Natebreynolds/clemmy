import type { WorkflowDetailInfo } from './api';

/** Keep each saved requirement verbatim; Clem can explain it in the conversation. */
export function workflowSetupRequest(info: WorkflowDetailInfo, missingInputs: string[], resourceGaps: string[]): string {
  const inputs = info.inputs.filter(input => missingInputs.includes(input.key));
  return [
    `Help me finish setting up the saved automation ${JSON.stringify(info.name)} (workflow ${JSON.stringify(info.slug)}).`,
    info.description ? `Its purpose: ${info.description}` : '',
    inputs.length ? `Required information still missing:\n${inputs.map(input => `- ${input.key}${input.description ? `: ${input.description}` : ''}`).join('\n')}` : '',
    resourceGaps.length ? `Required connections or resources still missing:\n${resourceGaps.map(gap => `- ${gap}`).join('\n')}` : '',
    !info.enabled ? 'The saved automation is disabled.' : '',
    'Explain what is needed in plain language and ask me for the missing choices. Keep this exact automation and its existing requirements. Do not guess account bindings or secrets, enable it, run it, or change its schedule without my confirmation.',
  ].filter(Boolean).join('\n\n');
}

/** An explicit setup tap can add context without replacing an unfinished draft. */
export function appendWorkflowSetupRequest(existing: string, request: string): string {
  if (existing === request || existing.endsWith(`\n\n${request}`)) return existing;
  return existing.trim() ? `${existing}\n\n${request}` : request;
}
