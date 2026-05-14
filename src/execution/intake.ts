import { extractSteps } from '../planning/deep-task.js';
import type { ExecutionRecord } from '../types.js';

export interface ExecutionIntent {
  shouldTrack: boolean;
  continueExisting: boolean;
  score: number;
  confidence: number;
  reasons: string[];
  title: string;
}

export interface ParsedExecutionResponse {
  title?: string;
  objective?: string;
  reason?: string;
  nextStep?: string;
  successCriteria?: string;
  summary?: string;
  steps: string[];
}

function normalize(text: string): string {
  return text.toLowerCase();
}

function clean(text: string, maxChars = 200): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function cleanBlock(text: string, maxChars = 1200): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
    .slice(0, maxChars);
}

function deriveTitle(message: string): string {
  const normalized = clean(message, 120)
    .replace(/^(please|can you|could you|let'?s|i need you to|help me)\s+/i, '')
    .replace(/[?.!]+$/, '');
  return normalized.length > 0 ? normalized : 'Tracked execution';
}

export function analyzeExecutionIntent(message: string, activeExecution?: ExecutionRecord): ExecutionIntent {
  const lower = normalize(message);
  const reasons: string[] = [];
  let score = 0;

  const explicitExecutionCues = [
    'keep going',
    'continue',
    'finish this',
    'finish it',
    'get it done',
    'from start to finish',
    'end to end',
    'longer running',
    'long-running',
    'ship this',
    'dial it up',
    'lets do it',
    "let's do it",
    "don't stop until it's done",
  ];

  const buildCues = [
    'build',
    'implement',
    'migrate',
    'refactor',
    'design',
    'create',
    'set up',
    'setup',
    'wire up',
    'connect',
    'deploy',
    'install',
    'launch',
    'improve',
    'finish up',
  ];

  const multiPartCues = [
    ' and ',
    'everything',
    'remaining',
    'all the',
    'whole thing',
    'entire',
    'multiple',
    'dashboard',
    'memory',
    'workflow',
    'tooling',
    'auth',
    'discord',
  ];

  const continuation = activeExecution && [
    'continue',
    'keep going',
    'what next',
    'next',
    'where were we',
    'pick this up',
    'resume',
    'finish it',
  ].some((cue) => lower.includes(cue));

  if (continuation) {
    score += 4;
    reasons.push('message looks like a continuation of already tracked work');
  }

  if (explicitExecutionCues.some((cue) => lower.includes(cue))) {
    score += 3;
    reasons.push('message explicitly asks for sustained execution');
  }

  const buildMatches = buildCues.filter((cue) => lower.includes(cue)).length;
  if (buildMatches > 0) {
    score += Math.min(3, buildMatches);
    reasons.push('message contains build/implementation language');
  }

  const multiPartMatches = multiPartCues.filter((cue) => lower.includes(cue)).length;
  if (multiPartMatches >= 2) {
    score += 2;
    reasons.push('message spans multiple moving parts');
  }

  if (message.length > 140) {
    score += 1;
    reasons.push('message is large enough to suggest a broader objective');
  }

  if ((message.match(/\b(and|then|after|while)\b/gi) ?? []).length >= 2) {
    score += 1;
    reasons.push('message implies a sequence of dependent steps');
  }

  const shouldTrack = score >= 4 || Boolean(continuation);
  const confidence = Math.max(0.45, Math.min(0.95, 0.35 + score * 0.1));

  return {
    shouldTrack,
    continueExisting: Boolean(continuation),
    score,
    confidence,
    reasons: reasons.slice(0, 5),
    title: activeExecution?.title ?? deriveTitle(message),
  };
}

export function buildExecutionPromptBlock(intent: ExecutionIntent, activeExecution?: ExecutionRecord): string {
  if (!intent.shouldTrack && !intent.continueExisting) return '';

  const mode = intent.continueExisting || activeExecution ? 'continue' : 'launch';
  const reasons = intent.reasons.map((reason) => `- ${reason}`).join('\n');

  return [
    'Execution handling:',
    mode === 'continue'
      ? 'Treat this as an update to an existing tracked execution lane. Continue it unless the user clearly changed topics.'
      : 'Treat this as a longer-running execution lane, not a one-shot answer. Assume it should be launched unless the request is obviously trivial.',
    activeExecution
      ? `Current execution:\n- Title: ${activeExecution.title}\n- Objective: ${activeExecution.objective}\n- Next step: ${activeExecution.nextStep ?? 'decide the next step'}\n- Status: ${activeExecution.status}`
      : '',
    reasons ? `Why this likely deserves execution:\n${reasons}` : '',
    'Use these exact sections in your response:',
    '## Execution Decision',
    'Launch tracked execution | Continue tracked execution | No tracked execution',
    '## Objective',
    'One concise paragraph.',
    '## Why',
    'Why this should or should not become longer-running work.',
    '## Plan',
    'A numbered list with 3 to 7 concrete steps if launching or continuing.',
    '## Immediate Next Move',
    'Exactly what should happen now.',
    '## Done Criteria',
    'How we know this lane is complete.',
    '## User Update',
    'A concise status/update in natural language.',
    'If you choose "No tracked execution", keep the answer direct and practical.',
  ].filter(Boolean).join('\n\n');
}

function sectionValue(text: string, heading: string, maxChars = 500): string | undefined {
  const pattern = new RegExp(`(?:^|\\n)##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|\\s*$)`, 'i');
  const match = text.match(pattern);
  if (!match) return undefined;
  return clean(match[1], maxChars);
}

function sectionBlock(text: string, heading: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\n)##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|\\s*$)`, 'i');
  const match = text.match(pattern);
  if (!match) return undefined;
  return cleanBlock(match[1]);
}

export function parseExecutionResponse(text: string): ParsedExecutionResponse {
  const planText = sectionBlock(text, 'Plan') ?? '';
  return {
    title: sectionValue(text, 'Execution Decision'),
    objective: sectionValue(text, 'Objective', 700),
    reason: sectionValue(text, 'Why', 600),
    nextStep: sectionValue(text, 'Immediate Next Move'),
    successCriteria: sectionValue(text, 'Done Criteria'),
    summary: sectionValue(text, 'User Update', 700),
    steps: extractSteps(planText || text),
  };
}
