/**
 * Tool Composition Detector — Identifies when multi-step compositions solve gaps.
 *
 * When no single tool exists for a task, this module:
 * - Detects the gap ("no direct email tool")
 * - Suggests compositions ("export as CSV, then format, then email")
 * - Guides the agent through multi-step execution
 *
 * Example:
 * Input: "Query external database and email results"
 * Direct: No "query external DB" tool exists
 * Composition: CLI query → save file → attach to email
 */

import { getCapabilitiesForIntent } from './capability-registry.js';

export interface CompositionStep {
  step: number;
  description: string;
  toolsAvailable: string[];
  expectedOutput: string;
}

export interface ToolComposition {
  intent: string;
  achievable: boolean;
  approach: 'direct' | 'composition' | 'manual_guidance';
  steps: CompositionStep[];
  estimatedDifficulty: 'easy' | 'moderate' | 'hard' | 'impossible';
  rationale: string;
}

/**
 * Common multi-step compositions for unsupported intents.
 */
const COMPOSITION_PATTERNS: Record<string, ToolComposition> = {
  'query_external_database': {
    intent: 'query external database',
    achievable: true,
    approach: 'composition',
    estimatedDifficulty: 'moderate',
    rationale: 'No direct API, but CLI + file I/O can achieve this',
    steps: [
      {
        step: 1,
        description: 'Connect to database via CLI',
        toolsAvailable: ['run_shell_command', 'cli_database_tools'],
        expectedOutput: 'Query result (CSV or JSON)',
      },
      {
        step: 2,
        description: 'Save result to file',
        toolsAvailable: ['write_file'],
        expectedOutput: 'File saved in workspace',
      },
      {
        step: 3,
        description: 'Parse or transform result if needed',
        toolsAvailable: ['read_file', 'run_shell_command'],
        expectedOutput: 'Formatted data',
      },
    ],
  },

  'send_email_with_large_attachment': {
    intent: 'send email with large attachment',
    achievable: true,
    approach: 'composition',
    estimatedDifficulty: 'moderate',
    rationale: 'Email APIs have attachment size limits; use cloud storage instead',
    steps: [
      {
        step: 1,
        description: 'Upload file to cloud storage',
        toolsAvailable: ['composio_google_drive_upload', 'composio_dropbox_upload'],
        expectedOutput: 'Shareable link',
      },
      {
        step: 2,
        description: 'Draft email with link',
        toolsAvailable: ['composio_gmail_send', 'composio_outlook_send'],
        expectedOutput: 'Email sent with link',
      },
    ],
  },

  'export_salesforce_to_excel': {
    intent: 'export salesforce to excel',
    achievable: true,
    approach: 'composition',
    estimatedDifficulty: 'moderate',
    rationale: 'Salesforce API returns JSON, Excel conversion via CLI/library',
    steps: [
      {
        step: 1,
        description: 'Query Salesforce records',
        toolsAvailable: ['composio_salesforce_query'],
        expectedOutput: 'JSON records',
      },
      {
        step: 2,
        description: 'Convert JSON to CSV',
        toolsAvailable: ['run_shell_command'],
        expectedOutput: 'CSV file',
      },
      {
        step: 3,
        description: 'Save as Excel format',
        toolsAvailable: ['run_shell_command', 'write_file'],
        expectedOutput: 'Excel file (.xlsx)',
      },
    ],
  },

  'batch_update_spreadsheet': {
    intent: 'batch update spreadsheet',
    achievable: true,
    approach: 'composition',
    estimatedDifficulty: 'easy',
    rationale: 'Prepare CSV, then use batch API or import',
    steps: [
      {
        step: 1,
        description: 'Prepare update CSV',
        toolsAvailable: ['write_file', 'read_file'],
        expectedOutput: 'CSV file with updates',
      },
      {
        step: 2,
        description: 'Batch import/update via API',
        toolsAvailable: ['composio_google_sheets_append'],
        expectedOutput: 'Spreadsheet updated',
      },
    ],
  },

  'scrape_and_analyze': {
    intent: 'scrape website and analyze content',
    achievable: true,
    approach: 'composition',
    estimatedDifficulty: 'moderate',
    rationale: 'Scrape first, then analyze with LLM',
    steps: [
      {
        step: 1,
        description: 'Scrape website content',
        toolsAvailable: ['firecrawl_scrape', 'web_fetch_simple', 'browser_automation'],
        expectedOutput: 'HTML or markdown',
      },
      {
        step: 2,
        description: 'Analyze with AI',
        toolsAvailable: ['composio_search_tools', 'native_analysis'],
        expectedOutput: 'Analysis results',
      },
      {
        step: 3,
        description: 'Format and deliver',
        toolsAvailable: ['write_file', 'composio_email_send'],
        expectedOutput: 'Report sent or saved',
      },
    ],
  },
};

/**
 * Detect if a composition can solve a capability gap.
 */
export function detectComposition(intent: string): ToolComposition | null {
  const normalized = intent.toLowerCase().trim();

  // Exact match in patterns
  if (COMPOSITION_PATTERNS[normalized]) {
    return COMPOSITION_PATTERNS[normalized];
  }

  // Check if capability exists directly
  const caps = getCapabilitiesForIntent(intent);
  if (caps.length > 0 && caps[0].score > 0.7) {
    return null; // Direct tool exists, no composition needed
  }

  // Fuzzy match against patterns
  for (const [patternIntent, composition] of Object.entries(COMPOSITION_PATTERNS)) {
    const patternTerms = patternIntent.split('_');
    const intentTerms = normalized.split(/\s+/);

    const matches = intentTerms.filter((term) => patternTerms.some((pTerm) => pTerm.includes(term) || term.includes(pTerm)));

    if (matches.length >= 2) {
      return composition;
    }
  }

  return null;
}

/**
 * Format composition guidance for agent context.
 */
export function formatCompositionGuidance(composition: ToolComposition): string {
  const lines = [
    `To "${composition.intent}", I'll use a multi-step composition:`,
    `Approach: ${composition.approach} (${composition.estimatedDifficulty} difficulty)`,
    ``,
    `Steps:`,
  ];

  for (const step of composition.steps) {
    lines.push(`  ${step.step}. ${step.description}`);
    lines.push(`     Tools available: ${step.toolsAvailable.join(', ')}`);
    lines.push(`     Expected output: ${step.expectedOutput}`);
  }

  lines.push('');
  lines.push(`Rationale: ${composition.rationale}`);

  return lines.join('\n');
}

/**
 * Check if a task is achievable with available tools.
 */
export function checkAchievability(intent: string): {
  achievable: boolean;
  approach: 'direct' | 'composition' | 'manual' | 'impossible';
  reason: string;
} {
  // Check for direct tool
  const caps = getCapabilitiesForIntent(intent);
  if (caps.length > 0 && caps[0].score >= 0.9) {
    return {
      achievable: true,
      approach: 'direct',
      reason: `Direct tool available: ${caps[0].toolName}`,
    };
  }

  // Check for composition
  const composition = detectComposition(intent);
  if (composition && composition.achievable) {
    return {
      achievable: true,
      approach: 'composition',
      reason: `Achievable via composition: ${composition.steps.map((s) => s.description).join(' → ')}`,
    };
  }

  // Check for partial solutions
  if (caps.length > 0 && caps[0].score >= 0.4) {
    return {
      achievable: true,
      approach: 'manual',
      reason: `Partial support available (workaround): ${caps[0].toolName}`,
    };
  }

  return {
    achievable: false,
    approach: 'impossible',
    reason: 'No tools available for this intent',
  };
}

/**
 * Suggest the best approach for an intent.
 */
export function suggestApproach(intent: string): string {
  const check = checkAchievability(intent);

  if (check.approach === 'direct') {
    const caps = getCapabilitiesForIntent(intent);
    return `I can do this directly with ${caps[0].toolName}. ${check.reason}`;
  }

  if (check.approach === 'composition') {
    const composition = detectComposition(intent);
    if (composition) {
      return formatCompositionGuidance(composition);
    }
  }

  if (check.approach === 'manual') {
    return `I can partially help: ${check.reason}. Here's what I can do, but some steps may require manual work.`;
  }

  return `I cannot directly accomplish this. Reason: ${check.reason}`;
}
