/**
 * Intelligent workflow builder: converts user intent into workflow definitions.
 *
 * This module takes a high-level description of what the user wants to automate
 * and breaks it down into executable workflow steps with:
 * - Intelligent step identification
 * - Tool selection based on step intent
 * - Parallelization detection
 * - Output contract generation
 * - Data flow mapping
 */

export interface WorkflowBuilderIntent {
  description: string;
  domain?: string; // e.g., "SEO", "Salesforce", "Email"
  frequency?: string; // e.g., "daily at 6am", "on-demand"
  inputs?: string[]; // e.g., ["domain", "client_name"]
  expectedOutput?: string; // e.g., "HTML report", "Slack message"
}

export interface SuggestedStep {
  id: string;
  title: string;
  description: string;
  intent: string; // Natural language description of what this step does
  suggestedTools: string[];
  dependsOn?: string[]; // Step IDs this depends on
  canParallelize?: boolean; // Can this run in parallel with siblings?
  expectedOutputType?: 'object' | 'string' | 'array' | 'file';
  inputFields?: string[]; // Fields this step needs from previous steps
}

export interface WorkflowBuilderAnalysis {
  name: string;
  description: string;
  suggestedSteps: SuggestedStep[];
  parallelizationOpportunities: string[][]; // Groups of step IDs that can run in parallel
  suggestedInputs: Record<string, { type: 'string' | 'number'; description: string }>;
  suggestedFrequency?: string; // Cron expression if applicable
  concerns: string[]; // Issues or questions for the user
  confidence: number; // 0-1, how confident are we about this breakdown
}

/** Map from common intent keywords to likely tool families. */
const INTENT_TO_TOOLS: Record<string, string[]> = {
  'research': ['composio_search_tools', 'composio_execute_tool', 'run_shell_command'],
  'scrape': ['composio_execute_tool', 'run_shell_command'],
  'fetch': ['composio_execute_tool', 'read_file'],
  'search': ['composio_search_tools', 'composio_execute_tool'],
  'query': ['composio_execute_tool', 'run_shell_command'],
  'write': ['write_file', 'composio_execute_tool'],
  'create': ['write_file', 'composio_execute_tool'],
  'build': ['write_file', 'run_shell_command'],
  'generate': ['write_file', 'composio_execute_tool'],
  'format': ['run_shell_command', 'write_file'],
  'transform': ['run_shell_command', 'composio_execute_tool'],
  'send': ['composio_execute_tool'],
  'email': ['composio_execute_tool'],
  'slack': ['composio_execute_tool'],
  'publish': ['composio_execute_tool'],
  'upload': ['composio_execute_tool', 'write_file'],
  'analyze': ['composio_execute_tool', 'run_shell_command'],
  'report': ['write_file', 'run_shell_command'],
  'summarize': ['composio_execute_tool', 'run_shell_command'],
  'extract': ['composio_execute_tool', 'run_shell_command'],
  'validate': ['composio_execute_tool', 'run_shell_command'],
  'audit': ['composio_execute_tool', 'run_shell_command', 'read_file'],
  'monitor': ['composio_execute_tool', 'run_shell_command'],
  'track': ['composio_execute_tool'],
};

/** Common workflow patterns and their typical step sequences. */
const WORKFLOW_PATTERNS: Record<string, { steps: string[], parallel: string[][] }> = {
  'audit': {
    steps: ['research', 'analyze', 'build_report', 'deliver'],
    parallel: [],
  },
  'batch_process': {
    steps: ['fetch_items', 'process_each', 'aggregate', 'deliver'],
    parallel: [['process_each']],
  },
  'multi_source_research': {
    steps: ['fetch_source_a', 'fetch_source_b', 'fetch_source_c', 'synthesize', 'deliver'],
    parallel: [['fetch_source_a', 'fetch_source_b', 'fetch_source_c']],
  },
  'notify': {
    steps: ['gather_data', 'format', 'send'],
    parallel: [],
  },
  'create_and_send': {
    steps: ['research', 'create', 'send'],
    parallel: [],
  },
};

/**
 * Extract keywords from description to identify the domain and intent.
 */
export function extractDomainAndIntent(description: string): { domain: string; keywords: string[] } {
  const lower = description.toLowerCase();
  const keywords = description
    .split(/[\s,;.!?]+/)
    .filter(w => w.length > 3)
    .map(w => w.toLowerCase());

  // Detect domain
  let domain = 'general';
  if (lower.includes('salesforce') || lower.includes('crm')) domain = 'salesforce';
  else if (lower.includes('slack') || lower.includes('discord')) domain = 'messaging';
  else if (lower.includes('email') || lower.includes('outlook')) domain = 'email';
  else if (lower.includes('seo') || lower.includes('website') || lower.includes('audit')) domain = 'seo';
  else if (lower.includes('airtable') || lower.includes('sheet') || lower.includes('database')) domain = 'data';

  return { domain, keywords };
}

/**
 * Identify workflow pattern from description.
 * Returns the pattern name and confidence score.
 */
export function identifyPattern(description: string): { pattern: string; confidence: number } {
  const lower = description.toLowerCase();

  // Score each pattern
  const scores: Record<string, number> = {};
  for (const [patternName, keywords] of Object.entries({
    audit: ['audit', 'analyze', 'report', 'health'],
    batch_process: ['batch', 'each', 'list', 'multiple', 'foreach'],
    multi_source_research: ['multiple sources', 'research', 'gather', 'combine'],
    notify: ['send', 'notify', 'alert', 'message'],
    create_and_send: ['create', 'build', 'send', 'publish'],
  })) {
    scores[patternName] = keywords.filter(k => lower.includes(k)).length;
  }

  const topPattern = Object.entries(scores).sort(([, a], [, b]) => b - a)[0];
  if (!topPattern || topPattern[1] === 0) return { pattern: 'custom', confidence: 0 };

  return { pattern: topPattern[0], confidence: Math.min(topPattern[1] / 3, 1) };
}

/**
 * Break a description into suggested steps.
 * This is a heuristic approach based on keywords and patterns.
 */
export function suggestStepsFromDescription(
  description: string,
  pattern: string,
): SuggestedStep[] {
  const { keywords } = extractDomainAndIntent(description);
  const lower = description.toLowerCase();

  // Start with pattern-based steps
  let baseSteps: SuggestedStep[] = [];
  if (pattern && WORKFLOW_PATTERNS[pattern]) {
    const patternDef = WORKFLOW_PATTERNS[pattern];
    baseSteps = patternDef.steps.map((stepName, idx) => ({
      id: stepName,
      title: stepName.replace(/_/g, ' '),
      description: `Step ${idx + 1}: ${stepName}`,
      intent: stepName,
      suggestedTools: INTENT_TO_TOOLS[stepName] || ['composio_execute_tool'],
      expectedOutputType: 'object' as const,
    }));
  } else {
    // Custom pattern: identify verbs and create steps
    const actionVerbs = ['research', 'fetch', 'search', 'analyze', 'build', 'create', 'send', 'publish', 'deliver'];
    const identifiedActions: string[] = [];

    for (const verb of actionVerbs) {
      if (lower.includes(verb)) {
        identifiedActions.push(verb);
      }
    }

    if (identifiedActions.length === 0) {
      // Default to generic steps
      identifiedActions.push('gather_data', 'process', 'deliver');
    }

    baseSteps = identifiedActions.map((action, idx) => ({
      id: action,
      title: action.replace(/_/g, ' '),
      description: `Step ${idx + 1}: ${action}`,
      intent: action,
      suggestedTools: INTENT_TO_TOOLS[action] || ['composio_execute_tool'],
      expectedOutputType: 'object' as const,
    }));
  }

  // Add dependencies: each step depends on the previous one (unless parallelizable)
  for (let i = 1; i < baseSteps.length; i++) {
    baseSteps[i].dependsOn = [baseSteps[i - 1].id];
  }

  return baseSteps;
}

/**
 * Detect which steps can run in parallel.
 */
export function detectParallelSteps(steps: SuggestedStep[]): string[][] {
  const groups: string[][] = [];

  // Simple heuristic: steps that fetch from independent sources can parallelize
  const fetchSteps = steps.filter(s => s.intent.includes('fetch') || s.intent.includes('research'));
  if (fetchSteps.length > 1) {
    // Check if they have no dependencies
    const independent = fetchSteps.filter(s => !s.dependsOn || s.dependsOn.length === 0);
    if (independent.length > 1) {
      groups.push(independent.map(s => s.id));
    }
  }

  return groups;
}

/**
 * Auto-select tools based on step intent and keywords.
 */
export function selectToolsForStep(step: SuggestedStep, keywords: string[]): string[] {
  const baseTools = INTENT_TO_TOOLS[step.intent] || ['composio_execute_tool'];

  // Refine based on additional keywords
  const toolSet = new Set(baseTools);

  // Domain-specific tool selection
  if (keywords.some(k => k.includes('seo') || k.includes('domain') || k.includes('rank'))) {
    toolSet.add('mcp'); // DataForSEO tools
  }
  if (keywords.some(k => k.includes('salesforce') || k.includes('crm'))) {
    toolSet.add('composio_execute_tool');
  }
  if (keywords.some(k => k.includes('file') || k.includes('markdown') || k.includes('html'))) {
    toolSet.add('write_file');
    toolSet.add('read_file');
  }
  if (keywords.some(k => k.includes('shell') || k.includes('command'))) {
    toolSet.add('run_shell_command');
  }

  return Array.from(toolSet);
}

/**
 * Generate suggested inputs based on the description and identified keywords.
 */
export function suggestInputs(description: string): Record<string, { type: 'string' | 'number'; description: string }> {
  const lower = description.toLowerCase();
  const inputs: Record<string, { type: 'string' | 'number'; description: string }> = {};

  // Common input patterns
  if (lower.includes('domain') || lower.includes('website') || lower.includes('url')) {
    inputs.domain = { type: 'string', description: 'Target domain or URL' };
  }
  if (lower.includes('client')) {
    inputs.client_name = { type: 'string', description: 'Client name' };
  }
  if (lower.includes('user') || lower.includes('email')) {
    inputs.user_email = { type: 'string', description: 'User email or ID' };
  }
  if (lower.includes('list') || lower.includes('batch')) {
    inputs.items = { type: 'string', description: 'List of items to process (JSON array)' };
  }
  if (lower.includes('query') || lower.includes('search')) {
    inputs.query = { type: 'string', description: 'Search query or keyword' };
  }

  return inputs;
}

/**
 * Main analysis function: convert user intent into a workflow structure.
 */
export function analyzeWorkflowIntent(intent: WorkflowBuilderIntent): WorkflowBuilderAnalysis {
  const { domain, keywords } = extractDomainAndIntent(intent.description);
  const { pattern, confidence } = identifyPattern(intent.description);

  // Suggest steps based on pattern
  const suggestedSteps = suggestStepsFromDescription(intent.description, pattern);

  // Auto-select tools for each step
  for (const step of suggestedSteps) {
    step.suggestedTools = selectToolsForStep(step, keywords);
  }

  // Detect parallelization opportunities
  const parallelizationOpportunities = detectParallelSteps(suggestedSteps);
  if (parallelizationOpportunities.length > 0) {
    for (const group of parallelizationOpportunities) {
      for (const stepId of group) {
        const step = suggestedSteps.find(s => s.id === stepId);
        if (step) {
          step.canParallelize = true;
          step.dependsOn = undefined; // Remove dependency if parallel
        }
      }
    }
  }

  // Generate workflow name from description
  const nameWords = intent.description.split(/[\s,;.!?]+/).filter(w => w.length > 2).slice(0, 3);
  const name = nameWords.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');

  // Collect concerns/questions
  const concerns: string[] = [];
  if (confidence < 0.5) {
    concerns.push('Low confidence in pattern detection — you may want to refine the step breakdown manually');
  }
  if (suggestedSteps.some(s => !s.dependsOn && suggestedSteps.indexOf(s) > 0)) {
    concerns.push('Some steps have no dependencies — verify data flow is correct');
  }
  if (suggestedSteps.some(s => s.suggestedTools.includes('composio_execute_tool'))) {
    concerns.push('Some steps use composio — verify the required tools are available');
  }

  return {
    name,
    description: intent.description,
    suggestedSteps,
    parallelizationOpportunities,
    suggestedInputs: intent.inputs ? Object.fromEntries(
      intent.inputs.map(inp => [inp, { type: 'string' as const, description: `Input: ${inp}` }]),
    ) : suggestInputs(intent.description),
    suggestedFrequency: intent.frequency,
    concerns,
    confidence,
  };
}
