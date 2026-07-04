/**
 * Workflow structural validator.
 *
 * Catches workflow definitions that compile but will fail in execution
 * because of patterns the agent will misinterpret. The bug class this
 * module exists for: an auto-authored `daily-prospect-outreach`
 * workflow shipped to production with the step prompt:
 *
 *   "Do NOT call OUTLOOK_SEND_EMAIL yet — that's gated behind explicit
 *    approval. After approval (a future turn handles the resume): for
 *    each draft, call cx_outlook_send_email..."
 *
 * The agent dutifully called `request_approval`, the human granted it,
 * and then the agent stopped — interpreting "future turn handles the
 * resume" as "not my job to continue". Result: 9 drafted emails sat in
 * the workflow output, never sent.
 *
 * The validator below catches that class of bug at authoring time
 * (when `workflow_create` or the dashboard editor commits a draft) so
 * it never reaches production. Each check is structural and runs in
 * milliseconds; no LLM calls, no network. Errors block save; warnings
 * surface as soft signals the user can override.
 */
import { COMMON_WORKFLOW_INPUT_KEYS } from './workflow-inputs.js';
import { matchToolChoicesForStep, type ToolChoiceRecord } from '../memory/tool-choice-store.js';
import { validateCronExpression } from '../shared/cron.js';
import {
  outputContractSuggestionFromPrompt,
  promptLooksDeliverable,
  textMentionsDeliverable,
} from './workflow-deliverable-hints.js';

/**
 * Shape of a workflow's parsed frontmatter — kept loose because the
 * validator runs on raw markdown frontmatter, not the strict
 * WorkflowDefinition typed via zod.
 */
export interface WorkflowStepShape {
  id: string;
  prompt: string;
  dependsOn?: string[];
  orderingOnlyDeps?: string[];
  model?: string;
  tier?: number;
  maxTurns?: number;
  forEach?: string;
  forEachNewOnly?: boolean;
  for_each_new_only?: boolean;
  deterministic?: { runner?: string };
  usesSkill?: string;
  uses_skill?: string;
  allowedTools?: string[];
  requiresApproval?: boolean;
  requires_approval?: boolean;
  sideEffect?: 'read' | 'write' | 'send';
  side_effect?: 'read' | 'write' | 'send';
  /** Typed step contract (P0). Keys = declared input names. */
  inputs?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export interface WorkflowFrontmatter {
  name?: string;
  description?: string;
  enabled?: boolean;
  trigger?: {
    schedule?: string;
    manual?: boolean;
    timezone?: string;
    webhookPath?: string;
    events?: Array<{ type?: string; filter?: Record<string, unknown>; dedupeKey?: string }>;
  };
  steps?: WorkflowStepShape[];
  inputs?: Record<string, { type?: string; default?: string; description?: string }>;
  synthesis?: { prompt?: string };
  goal?: {
    objective?: string;
    successCriteria?: string[];
    success_criteria?: string[];
    maxAttempts?: number;
    max_attempts?: number;
  };
}

export interface WorkflowValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stepCount: number;
  hasCycles: boolean;
}

// ─── Cron validation (mirrors workflow-scheduler.ts:cronMatches semantics) ──

// An invalid IANA timezone does NOT throw at run time — `wallClockInZone`
// silently falls back to HOST-local time (workflow-scheduler.ts), so a typo
// like "America/Los_Angles" makes a scheduled workflow fire at the wrong
// hour with no error. Catch it at author time. Intl is the authoritative
// IANA registry, so this never false-positives on a real zone.
function isValidTimezone(tz: string): boolean {
  if (!tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ─── Hand-off language detection ─────────────────────────────────────
//
// These phrases tell the agent "this isn't your job to continue" and
// it will obey by ending the turn early. The list is conservative —
// every entry has bitten us at least once in an actually-shipped
// workflow.

const HANDOFF_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(?:a\s+)?future\s+turn\s+(?:will\s+)?(?:handle|process|do|continue|resume|pick(?:s)?\s+up)/i,
    reason: 'phrase "future turn handles/resumes" tells the agent to stop',
  },
  {
    pattern: /\b(?:another|the\s+next)\s+(?:agent|turn|step|run|invocation)\s+(?:will|handles?|takes?\s+over|picks?\s+up)/i,
    reason: 'phrase "another agent/turn handles" tells the agent to stop',
  },
  {
    pattern: /\b(?:we'?ll|i'?ll|clementine\s+will)\s+(?:come\s+back|return|revisit|continue)\s+(?:to\s+(?:this|that)\s+)?later/i,
    reason: 'phrase "we\'ll come back to this later" tells the agent to defer',
  },
  {
    pattern: /\bfor\s+a\s+later\s+(?:turn|step|run|invocation)/i,
    reason: 'phrase "for a later turn/step" tells the agent to defer',
  },
  {
    pattern: /\bdeferred?\s+to\s+(?:a\s+)?(?:future|next|later)\s+(?:turn|run)/i,
    reason: 'phrase "deferred to a future/next turn" tells the agent to stop',
  },
];

function checkHandoffLanguage(stepId: string, prompt: string): string[] {
  const issues: string[] = [];
  for (const { pattern, reason } of HANDOFF_PATTERNS) {
    const match = prompt.match(pattern);
    if (match) {
      issues.push(
        `Step "${stepId}" contains hand-off language ("${match[0]}") — ${reason}. `
        + 'Rewrite to be explicit: the agent should complete the work in THIS turn.',
      );
    }
  }
  return issues;
}

// ─── Approval coherence ──────────────────────────────────────────────
//
// If a step's prompt mentions `request_approval`, it MUST also have
// explicit "after approval, do X" instructions naming specific tool
// calls. Otherwise the agent stops at the approval and the workflow
// effectively dies between steps.

function checkApprovalCoherence(
  stepId: string,
  prompt: string,
  requiresApproval = false,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mentionsApproval = /\brequest_approval\b/i.test(prompt);
  if (!mentionsApproval) return { errors, warnings };

  // Declarative gate already in place: the runner owns the approval, so
  // the prompt mentioning request_approval (e.g. "do NOT call
  // request_approval — the runner handles it") is fine. No error/warning.
  if (requiresApproval) return { errors, warnings };

  // Autonomous-by-default model: a step should NOT drive its own
  // approval via the prompt. Prefer the declarative gate, which the
  // runner owns (and which the constrained step agent supports).
  warnings.push(
    `Step "${stepId}" calls request_approval in its prompt. Prefer the declarative gate: set `
    + '`requiresApproval: true` (+ a short `approvalPreview`) on this step instead. The runner then '
    + 'surfaces ONE batch approval and holds the run — the step agent never calls request_approval, '
    + 'and the workflow stays autonomous everywhere else.',
  );

  // Must have explicit post-approval instructions. Accept the common honest
  // phrasings: action verbs beyond "call" (write/send/create/...) and the
  // "request_approval returns Approved" form the error message itself
  // suggests — the old verb list rejected coherent prompts (audit 2026-06-12).
  const hasPostApprovalAction = /\b(?:after\s+approval|once\s+approved|when\s+approved|if\s+approved|on\s+approval|request_approval\s+returns\s+approved)\b[\s\S]*?(?:call|invoke|run|execute|use|fire|write|send|create|update|save|append|post|upload)\s+[`a-z_/]/i
    .test(prompt);
  if (!hasPostApprovalAction) {
    errors.push(
      `Step "${stepId}" calls request_approval but has no explicit "after approval, call X" instruction. `
      + 'Agents stop at request_approval unless told what to do next IN THE SAME TURN. '
      + 'Add: "After request_approval returns Approved, immediately call <tool> with <args> for each <item>."',
    );
  }

  // Should not have hand-off language in the same prompt (the
  // double-pattern was the original daily-prospect-outreach bug).
  if (mentionsApproval && /\b(?:future|later|another|next)\s+(?:turn|agent|run|step)\b/i.test(prompt)) {
    errors.push(
      `Step "${stepId}" mixes request_approval with hand-off language. `
      + 'These are mutually exclusive — either the agent completes the work in this turn '
      + '(post-approval instructions, no hand-off) OR it splits across steps (no request_approval here, '
      + 'a separate downstream step does the work).',
    );
  }

  return { errors, warnings };
}

const SIDE_EFFECT_SEND_RE =
  /\b(?:send|sends|sending|deliver|delivers|delivering|dispatch|dispatches|dispatching)\b[\s\S]{0,80}\b(?:e-?mails?|messages?|sms|texts?|invites?|dms?|notifications?|newsletters?|nate|user|client|customer|prospect|recipient|inbox|mailbox)\b|\bnotify(?:ing|ies)?\b[\s\S]{0,80}\b(?:nate|user|client|customer|prospect|recipient|inbox|mailbox|about|with|that)\b|\b(?:email|e-mail|message|dm)\s+(?:nate|the\s+user|a\s+user|users?|clients?|customers?|prospects?|recipients?)\b/i;
const SIDE_EFFECT_PUBLISH_RE =
  /\b(?:publish|publishes|publishing)\b[\s\S]{0,60}\b(?:tweet|tweets|linkedin|slack|twitter|\bx\b|facebook|instagram|blog\s*post|social\s+post|post)\b|\b(?:post|posts|posting)\b[\s\S]{0,30}\b(?:to|on|onto)\s+(?:linkedin|slack|twitter|\bx\b|facebook|instagram|the\s+blog|a\s+blog)\b/i;
const SIDE_EFFECT_WRITE_RE =
  /\b(?:create|creates|creating|add|adds|adding|insert|inserts|upsert|upserts|update|updates|updating|write|writes|writing|save|saves|saving|delete|deletes|remove|removes|append|appends|draft|drafts|upload|uploads)\b[\s\S]{0,60}\b(?:record|records|row|rows|sheet|spreadsheet|table|crm|airtable|salesforce|hubspot|database|file|files|document|docs?|event|calendar|invite|message|ticket|issue|page|notion|post|url)\b/i;

function sideEffectSignalText(prompt: string): string {
  return prompt
    // "do NOT send/post/email" is a safety boundary, not an instruction to act.
    .replace(/\b(?:do\s+not|don't|never)\s+(?:send|post|publish|email|e-mail|notify|message|dm|call|execute|create|update|write|save|delete|upload)\b[^\n.!?]*/gi, ' ')
    // "nothing to send" / "no email was sent" / "downstream send steps" are
    // status or planning language, not an instruction for this step to send.
    .replace(/\b(?:nothing|no\s+(?:email|message|notification|dm|post|content))\s+(?:is\s+|was\s+|to\s+)?(?:send|sent|post|posted|publish|published|email|e-mail|notify|message|dm)\b[^\n.!?]*/gi, ' ')
    .replace(/\bdownstream\s+[a-z0-9_/ -]{0,50}\bsteps?\b/gi, ' ')
    // Planning prompts often describe risk classes named read/write/send; those
    // labels are not themselves side effects for the current step.
    .replace(/\brisk[_ -]?class\s*["']?(?:read|write|send)["']?\s+for\b[^\n]*/gi, ' ')
    .replace(/\brisk[_ -]?class\s*[:=]\s*["']?(?:read|write|send)["']?/gi, ' ')
    .replace(/\bread\|write\|send\b/gi, ' ');
}

function declaredSideEffect(step: WorkflowStepShape): 'read' | 'write' | 'send' | null {
  const raw = step.sideEffect ?? step.side_effect;
  return raw === 'read' || raw === 'write' || raw === 'send' ? raw : null;
}

function promptSideEffectClass(prompt: string): 'read' | 'write' | 'send' {
  const signal = sideEffectSignalText(prompt);
  if (SIDE_EFFECT_SEND_RE.test(signal) || SIDE_EFFECT_PUBLISH_RE.test(signal)) return 'send';
  if (SIDE_EFFECT_WRITE_RE.test(signal)) return 'write';
  return 'read';
}

function sideEffectRank(cls: 'read' | 'write' | 'send'): number {
  return cls === 'read' ? 0 : cls === 'write' ? 1 : 2;
}

function checkSideEffectCoherence(step: WorkflowStepShape): string | null {
  const declared = declaredSideEffect(step);
  if (!declared) return null;
  const inferred = promptSideEffectClass(step.prompt ?? '');
  if (sideEffectRank(declared) >= sideEffectRank(inferred)) return null;
  return (
    `Step "${step.id}" declares sideEffect: ${declared}, but its prompt looks like a ${inferred.toUpperCase()} step. `
    + 'Set the stronger sideEffect or rewrite the prompt; otherwise crash-resume, retry, and phantom-completion guards can treat the step as safer than it is.'
  );
}

function forEachSourceStepId(expr: string | undefined): string | null {
  const raw = (expr ?? '').trim();
  if (!raw) return null;
  const templated = /^\{\{\s*steps\.([a-zA-Z0-9_-]+)\.output(?:\.[a-zA-Z0-9_.-]+)?\s*\}\}$/.exec(raw);
  if (templated) return templated[1];
  const directPath = /^steps\.([a-zA-Z0-9_-]+)\.output(?:\.[a-zA-Z0-9_.-]+)?$/.exec(raw);
  if (directPath) return directPath[1];
  return /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : null;
}

// ─── Step output reference resolution ────────────────────────────────
//
// Step prompts can reference upstream step outputs via
// `{{steps.X.output}}`. If X isn't a real step ID, the reference
// resolves to an empty string at render time and the agent silently
// gets nothing for the placeholder.

function checkStepOutputReferences(
  stepId: string,
  prompt: string,
  dependencyIds: Set<string>,
  allIds: Set<string>,
): string[] {
  const errors: string[] = [];
  const stepRefPattern = /\{\{\s*steps\.([a-zA-Z0-9_-]+)\.output\s*\}\}/g;
  let match;
  while ((match = stepRefPattern.exec(prompt)) !== null) {
    const referenced = match[1];
    if (dependencyIds.has(referenced)) continue;
    if (allIds.has(referenced)) {
      // The step exists but isn't an upstream DEPENDENCY of this one. Data only
      // flows from declared dependencies, so unless the runner happens to finish
      // it first, the token renders empty — a silent, ordering-dependent bug.
      errors.push(
        `Step "${stepId}" references {{steps.${referenced}.output}} but "${referenced}" is not one of its dependencies. `
        + `Add "${referenced}" to this step's dependsOn so its output is available; otherwise the reference renders empty whenever "${referenced}" hasn't finished first.`,
      );
    } else {
      errors.push(
        `Step "${stepId}" references {{steps.${referenced}.output}} but no step has that id. `
        + 'The reference will render as an empty string and the agent will silently get nothing.',
      );
    }
  }
  return errors;
}

// ─── Template-token sanity (typed-workflow-contract P1, report-only) ──
//
// The engine only substitutes a fixed set of token shapes. A token that
// matches NONE of them (e.g. `{{url}}` instead of `{{input.url}}`, or a
// typo `{{ourput}}`) renders as literal text and silently swallows the
// value — the exact class that blocked the revill audit. These checks
// surface that at author/validate time. (P1 = report-only; P2 wires
// validation into create/enable so a broken workflow can't be enabled.)

const KNOWN_TOKEN = /^(?:date|input\.[a-zA-Z0-9_-]+|steps\.[a-zA-Z0-9_-]+\.output(?:\.[a-zA-Z0-9_.-]+)?|item(?:\.[a-zA-Z0-9_.-]+)?)$/;
const INPUT_TOKEN_RE = /\{\{\s*input\.([a-zA-Z0-9_-]+)\s*\}\}/g;

function checkMalformedTokens(subject: string, prompt: string): string[] {
  const errors: string[] = [];
  const tokenPattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match;
  while ((match = tokenPattern.exec(prompt)) !== null) {
    const token = match[1].trim();
    // Only flag things that LOOK like an intended placeholder: an
    // identifier (optionally dotted) starting with a word char. This
    // skips prose/punctuation like the literal `{{...}}` ellipsis that
    // prompts use as documentation ("no placeholder tokens like {{...}}").
    const looksLikeToken = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(token);
    if (looksLikeToken && !KNOWN_TOKEN.test(token)) {
      const hint = /^[a-zA-Z0-9_-]+$/.test(token) ? ` Did you mean {{input.${token}}}?` : '';
      errors.push(
        `${subject} uses an unrecognized template token {{${token}}} — it renders as literal text and silently drops the value.${hint}`,
      );
    }
  }
  return errors;
}

function checkInputTokenBinding(
  subject: string,
  prompt: string,
  declaredInputKeys: Set<string>,
): string[] {
  const errors: string[] = [];
  let match;
  INPUT_TOKEN_RE.lastIndex = 0;
  while ((match = INPUT_TOKEN_RE.exec(prompt)) !== null) {
    const key = match[1];
    if (!declaredInputKeys.has(key) && !COMMON_WORKFLOW_INPUT_KEYS.has(key)) {
      errors.push(
        `${subject} references {{input.${key}}} but no workflow/step input declares "${key}". `
        + 'Declare it under the workflow `inputs:` (or the step `inputs:`) so the engine binds it — otherwise it renders empty.',
      );
    }
  }
  return errors;
}

function checkImplicitCommonInputDeclarations(
  subject: string,
  prompt: string,
  declaredInputKeys: Set<string>,
): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  INPUT_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INPUT_TOKEN_RE.exec(prompt)) !== null) {
    const key = match[1];
    if (seen.has(key) || declaredInputKeys.has(key) || !COMMON_WORKFLOW_INPUT_KEYS.has(key)) continue;
    seen.add(key);
    warnings.push(
      `${subject} references common input {{input.${key}}} without declaring "${key}" under workflow inputs. `
      + 'Declare it so workflow_run, the dashboard, and the agent can ask for or supply the value before the run starts.',
    );
  }
  return warnings;
}

// ─── Tool slug catalog check ─────────────────────────────────────────
//
// Detects tool/slug references in step prompts that don't exist in the
// catalog. Reduces hallucinated tool names ("call cx_send_email" where
// the real slug is GMAIL_SEND_EMAIL) that show up as runtime errors.
//
// Heuristic: extract uppercased-snake-case tokens and `cx_*` tokens
// from the prompt. Check them against a provided catalog set. Unknown
// slugs become warnings (not errors) — we don't have a complete catalog
// of every possible composio slug at validation time.

function checkToolSlugs(
  stepId: string,
  prompt: string,
  knownToolNames: Set<string> | undefined,
): string[] {
  if (!knownToolNames || knownToolNames.size === 0) return [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  // Pattern 1: cx_<lower> — first-class composio tool aliases
  const cxPattern = /\bcx_([a-z][a-z0-9_]*)\b/g;
  let m;
  while ((m = cxPattern.exec(prompt)) !== null) {
    const slug = `cx_${m[1]}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    if (!knownToolNames.has(slug)) {
      warnings.push(
        `Step "${stepId}" references "${slug}" which isn't in the current tool catalog — it may be a hallucinated slug. `
        + 'Verify via composio_search_tools or use the canonical Composio slug instead (e.g. GMAIL_SEND_EMAIL).',
      );
    }
  }

  // Pattern 2: SCREAMING_SNAKE — Composio canonical slugs
  // (require ≥2 underscored segments to avoid false-positives on "JSON" "SOQL" etc.)
  const upperPattern = /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+){2,})\b/g;
  while ((m = upperPattern.exec(prompt)) !== null) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    // Soft check — if it LOOKS like a composio slug but isn't in the
    // catalog, flag it. We can't know every possible slug at validation
    // time, so this is intentionally a warning not an error.
    if (!knownToolNames.has(slug) && /^[A-Z]+_[A-Z]+_[A-Z]+/.test(slug)) {
      warnings.push(
        `Step "${stepId}" references "${slug}" — looks like a Composio slug but isn't in the cached catalog. `
        + 'Verify it exists via composio_search_tools before relying on it.',
      );
    }
  }

  return warnings;
}

// ─── Cycle detection (unchanged from prior inline version) ───────────

function detectCycles(steps: WorkflowStepShape[]): boolean {
  const adj = new Map<string, string[]>();
  for (const step of steps) adj.set(step.id, step.dependsOn ?? []);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  function dfs(node: string): boolean {
    color.set(node, GRAY);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && dfs(next)) return true;
    }
    color.set(node, BLACK);
    return false;
  }
  for (const step of steps) {
    if ((color.get(step.id) ?? WHITE) === WHITE && dfs(step.id)) return true;
  }
  return false;
}

// ─── Main entrypoint ─────────────────────────────────────────────────

export interface ValidateOptions {
  /** Optional set of known tool names — used by the slug catalog check.
   *  Caller fetches this from the runtime tool registry. When omitted,
   *  the slug check is skipped (no false positives). */
  knownToolNames?: Set<string>;
  /** Optional set of installed skill directory names. Missing refs warn. */
  installedSkillNames?: Set<string>;
  /** The user's active remembered tool-choices. When provided, a step that
   *  should bind a proven cli/mcp choice but doesn't (and stays exposed to the
   *  composio drift gateway) gets a WARNING. Caller passes listToolChoices(). */
  rememberedToolChoices?: ToolChoiceRecord[];
}

const MULTI_ITEM_NOUN = '(?:accounts?|sites?|firms?|leads?|contacts?|emails?|drafts?|rows?|prospects?|messages?|posts?)';
const MULTI_ITEM_PROMPT_RE = new RegExp(
  String.raw`\b(?:for each(?:\s+of\s+the)?(?:\s+\d+)?\s+(?:[\w\`'"-]+\s+){0,3}${MULTI_ITEM_NOUN}|each\s+${MULTI_ITEM_NOUN}|for every\s+${MULTI_ITEM_NOUN}|all\s+\d+\s+${MULTI_ITEM_NOUN}|top\s+\d+\s+${MULTI_ITEM_NOUN}|\d+\s+${MULTI_ITEM_NOUN})\b`,
  'i',
);
const ROW_BOOKKEEPING_RE = /\b(?:for each returned data row|compute and preserve (?:its )?actual .*row number|read only the header row|data rows in small batches|build existingrows)\b/i;
const EXPLICIT_PER_ITEM_RE = /\b(?:for each|each|for every|per)\b/i;
const SOCIAL_POST_BATCH_RE = /\b(?:scrape|analy[sz]e|summari[sz]e|review)\b[\s\S]{0,160}\b(?:public\s+|social\s+|recent\s+)?posts?\b|\bposts_reviewed_count\b|\bpost themes?\b/i;
const AGGREGATE_BATCH_RE = /\b(?:batch|bulk|tracker|sheet|spreadsheet|preview|summary|artifact|file|path|url|exact row updates|existing tracker row|existing .* row|update these fields|return (?:a |an )?(?:preview|list|summary|artifact|file|url|path))\b/i;
const SERIAL_WORK_RE = /\b(?:scrape|crawl|research|enrich|audit|draft|create|write|send|update)\b/i;

function outputLooksAggregate(output: WorkflowStepShape['output'] | undefined): boolean {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false;
  const required = Array.isArray(output.required_keys) ? output.required_keys.map((key) => key.toLowerCase()) : [];
  const hasArtifactHandle = required.some((key) => key === 'url' || key === 'path');
  const hasCollectionHandle = required.some((key) => /\b(?:accounts|rows|drafts|items|posts|prospects|leads|contacts)\b/i.test(key));
  const verify = output.verify as { path_exists?: unknown; url_present?: unknown } | undefined;
  const verifiesHandle = Boolean(
    verify
    && (
      (Array.isArray(verify.path_exists) && verify.path_exists.length > 0)
      || (Array.isArray(verify.url_present) && verify.url_present.length > 0)
    ),
  );
  return output.type === 'object' && (hasArtifactHandle || hasCollectionHandle || verifiesHandle);
}

function stepLooksIntentionalAggregateBatch(step: WorkflowStepShape): boolean {
  if (!outputLooksAggregate(step.output)) return false;
  if (!AGGREGATE_BATCH_RE.test(step.prompt ?? '')) return false;
  return true;
}

function checkParallelismHint(step: WorkflowStepShape): string | null {
  if (!stepLooksMultiItemWithoutForEach(step)) return null;
  return `Step "${step.id}" looks like multi-item work but has no forEach — it will run serially in one context. To parallelize safely, have the upstream step emit an ARRAY and add \`forEach: <upstreamStepId>\` to this step; the runner then fans out per item with bounded concurrency and keeps each item's context lean. (run_worker is not the path — it's unavailable inside a workflow step; forEach is the fan-out primitive.)`;
}

/** T2.4: the parallelism-hint predicate, exported so auto-repair
 *  (workflow-enforce.ts) can mechanically FIX the class it detects —
 *  multi-item prose without a forEach — instead of only warning. */
export function stepLooksMultiItemWithoutForEach(step: WorkflowStepShape): boolean {
  if (step.forEach) return false;
  if (ROW_BOOKKEEPING_RE.test(step.prompt)) return false;
  if (!EXPLICIT_PER_ITEM_RE.test(step.prompt) && SOCIAL_POST_BATCH_RE.test(step.prompt)) return false;
  if (stepLooksIntentionalAggregateBatch(step)) return false;
  if (!MULTI_ITEM_PROMPT_RE.test(step.prompt) || !SERIAL_WORK_RE.test(step.prompt)) return false;
  return true;
}

function checkDeterministicRunner(step: WorkflowStepShape): string | null {
  if (!step.deterministic) return null;
  const runner = typeof step.deterministic.runner === 'string' ? step.deterministic.runner.trim() : '';
  if (!runner) return `Step "${step.id}" has deterministic config but no runner. Add deterministic.runner pointing at a scripts/ helper or remove deterministic.`;
  if (runner.includes('..') || runner.startsWith('/') || /\s/.test(runner)) {
    return `Step "${step.id}" deterministic runner must be a relative scripts/ path with no inline arguments.`;
  }
  return null;
}

// A step that produces a concrete artifact (file / URL / report / record)
// should declare an `output` contract — that's what engages BOTH the
// deterministic per-step verifier (verifyStepOutput) AND the end-of-run target
// judge. Without it, runtime can only infer a soft needs-attention advisory
// when concrete deliverable evidence is missing. Advisory only (regex can't be
// certain), and skipped when the step already declares output / is a forEach
// fan-out wrapper (its items carry the shape) / is purely deterministic config.
function stepLooksDeliverable(step: WorkflowStepShape): boolean {
  return promptLooksDeliverable(step.prompt ?? '');
}

function workflowHasGoal(data: WorkflowFrontmatter): boolean {
  const objective = data.goal?.objective;
  return typeof objective === 'string' && objective.trim().length >= 4;
}

function checkOutputContractHint(step: WorkflowStepShape): string | null {
  if (step.output && Object.keys(step.output).length > 0) return null;
  if (step.forEach) return null; // the fan-out wrapper aggregates; per-item shape is what matters
  if (step.deterministic) return null; // deterministic steps are handled by checkDeterministicRunner
  const prompt = step.prompt ?? '';
  if (!stepLooksDeliverable(step)) return null;
  return `Step "${step.id}" looks like it produces a deliverable but declares no output contract. Add an "output" block so the engine can hard-verify the deliverable and the end-of-run target check can use concrete evidence; without it, the runner can only infer a best-effort needs-attention advisory when artifact evidence is missing. ${outputContractSuggestionFromPrompt(prompt)}`;
}

function checkWorkflowGoalHint(data: WorkflowFrontmatter, steps: WorkflowStepShape[]): string | null {
  if (workflowHasGoal(data)) return null;
  const hasDeliverableStep = steps.some((step) => !step.forEach && !step.deterministic && stepLooksDeliverable(step));
  const synthesisPrompt = data.synthesis?.prompt ?? '';
  const hasDeliverableSynthesis = textMentionsDeliverable(synthesisPrompt);
  if (!hasDeliverableStep && !hasDeliverableSynthesis) return null;
  return 'Workflow appears to produce a deliverable but has no pinned `goal`. Add a goal objective and success criteria so completion is judged against external evidence, not just the model saying it is done.';
}

// A step that should run a PROVEN cli/mcp tool-choice but leaves its prompt
// generic AND keeps the composio gateway in scope will re-decide at runtime and
// can drift onto a stale/expired path (the live SF→Airtable failure). WARNING
// only (never blocks) — and only fires when binding is both warranted and
// missing. Auto-bind (workflow_create) resolves most of these before save; this
// catches medium-confidence matches and hand-edits via the dashboard editor.
function checkRememberedToolChoiceBinding(
  step: WorkflowStepShape,
  choices: ToolChoiceRecord[] | undefined,
): string | null {
  if (!choices || choices.length === 0) return null;
  if (step.usesSkill || step.uses_skill) return null; // a skill owns its tools
  let matches: ReturnType<typeof matchToolChoicesForStep>;
  try {
    matches = matchToolChoicesForStep(step.prompt ?? '', { choices });
  } catch {
    return null;
  }
  const m = matches.find((x) =>
    (x.kind === 'cli' || x.kind === 'mcp')
    && !x.alreadyBound
    && !/^(?:null|undefined|none|n\/a|na|unknown)?$/i.test((x.command ?? '').trim()));
  if (!m) return null;
  const allowed = step.allowedTools;
  // Drift is possible when the step can still reach composio: an explicit
  // composio_* entry, OR no allowedTools at all (default = full surface).
  const canReachComposio =
    !allowed || allowed.length === 0 || allowed.some((t) => typeof t === 'string' && t.startsWith('composio'));
  const familyReachable = !!allowed && m.family.every((f) =>
    allowed.some((t) => t === f || (t.endsWith('*') && f.startsWith(t.slice(0, -1)))));
  if (familyReachable && m.kind === 'mcp') {
    const namespace = m.identifier.split('__')[0]?.toLowerCase() ?? '';
    if (namespace && new RegExp(`\\b${namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(step.prompt ?? '')) {
      return null;
    }
  }
  if (!canReachComposio) return null;
  return (
    `Step "${step.id}" looks like it should use your proven ${m.kind} \`${m.command}\`, but its prompt doesn't `
    + 'embed it and its tools still include composio — at runtime the step may re-decide and drift onto a stale '
    + `path. Bake \`${m.command}\` into the step prompt and set allowedTools to that family.`
  );
}

function checkSkillReference(step: WorkflowStepShape, installedSkillNames: Set<string> | undefined): string | null {
  const skill = (step.usesSkill ?? step.uses_skill ?? '').trim();
  if (!skill || !installedSkillNames) return null;
  if (!installedSkillNames.has(skill)) {
    return `Step "${step.id}" references missing skill "${skill}". Install it or remove usesSkill before relying on this workflow.`;
  }
  return null;
}

export function validateWorkflowDefinition(
  data: WorkflowFrontmatter,
  opts: ValidateOptions = {},
): WorkflowValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Top-level shape ────────────────────────────────────────
  if (!data.name) errors.push('Workflow has no name.');
  if (!Array.isArray(data.steps) || data.steps.length === 0) {
    errors.push('Workflow has no steps.');
  }

  const steps = data.steps ?? [];
  const ids = new Set<string>();
  let duplicates = 0;
  for (const step of steps) {
    if (!step.id) errors.push('A step is missing an id.');
    if (!step.prompt || step.prompt.trim().length < 3) {
      errors.push(`Step "${step.id ?? '?'}" has no substantive prompt.`);
    }
    if (step.id) {
      if (ids.has(step.id)) duplicates++;
      ids.add(step.id);
    }
  }
  if (duplicates > 0) errors.push(`${duplicates} duplicate step id${duplicates === 1 ? '' : 's'}.`);

  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) errors.push(`Step "${step.id}" depends on unknown step "${dep}".`);
    }
  }

  const hasCycles = detectCycles(steps);
  if (hasCycles) errors.push('Dependency graph has a cycle.');

  // Transitive dependency resolution. Data only flows into a step from its
  // declared dependencies (dependsOn), so {{steps.X.output}} and forEach: X are
  // only safe when X is an upstream dependency. Precompute each step's
  // transitive dep set (cycle-guarded) for those checks.
  const directDeps = new Map<string, string[]>();
  for (const step of steps) {
    if (step.id) directDeps.set(step.id, (step.dependsOn ?? []).filter((d) => ids.has(d)));
  }
  const transitiveDepsCache = new Map<string, Set<string>>();
  const transitiveDeps = (stepId: string): Set<string> => {
    const cached = transitiveDepsCache.get(stepId);
    if (cached) return cached;
    const out = new Set<string>();
    const stack = [...(directDeps.get(stepId) ?? [])];
    while (stack.length > 0) {
      const d = stack.pop() as string;
      if (out.has(d)) continue;
      out.add(d);
      for (const dd of directDeps.get(d) ?? []) stack.push(dd);
    }
    transitiveDepsCache.set(stepId, out);
    return out;
  };

  if (data.trigger?.schedule && !validateCronExpression(data.trigger.schedule)) {
    errors.push(`Invalid cron expression: "${data.trigger.schedule}"`);
  }
  if (data.trigger?.timezone && !isValidTimezone(data.trigger.timezone)) {
    errors.push(
      `Invalid timezone: "${data.trigger.timezone}". Use a valid IANA name (e.g. "America/Los_Angeles", "Europe/London", "UTC") — `
      + 'an unknown timezone silently falls back to the server host time, so the workflow would fire at the wrong hour.',
    );
  }
  // T2.1: event/webhook trigger shape. A malformed declaration would silently
  // never fire (the registry sync skips it) — reject it at authoring instead.
  if (data.trigger?.webhookPath !== undefined) {
    const hook = typeof data.trigger.webhookPath === 'string' ? data.trigger.webhookPath.trim() : '';
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(hook)) {
      errors.push(
        `Invalid trigger.webhookPath: "${String(data.trigger.webhookPath)}". Use a URL-safe slug (letters, digits, "-", "_") — `
        + 'it becomes POST /api/hooks/workflows/<webhookPath>.',
      );
    }
  }
  for (const [i, ev] of (data.trigger?.events ?? []).entries()) {
    const type = typeof ev?.type === 'string' ? ev.type.trim() : '';
    if (!type) {
      errors.push(`trigger.events[${i}] is missing a non-empty "type" — the event trigger would never fire.`);
      continue;
    }
    if (ev.dedupeKey !== undefined && (typeof ev.dedupeKey !== 'string' || !ev.dedupeKey.trim())) {
      errors.push(`trigger.events[${i}] ("${type}") has an empty dedupeKey — omit it (payload-hash dedupe) or use a template like "lead-{{payload.id}}".`);
    }
    for (const [key, value] of Object.entries(ev.filter ?? {})) {
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
        errors.push(`trigger.events[${i}] ("${type}") filter "${key}" must be a primitive (string/number/boolean) — payload matching is shallow equality.`);
      }
    }
  }

  if (!data.description || data.description.trim().length < 8) {
    warnings.push('Description is missing or too short — the agent will have trouble picking the right workflow.');
  }
  if (data.enabled === false) {
    warnings.push('Workflow is currently disabled — scheduled triggers will not fire.');
  }

  // Workflow-level declared input keys (typed-workflow-contract).
  const workflowInputKeys = new Set(Object.keys(data.inputs ?? {}));

  const goalIssue = checkWorkflowGoalHint(data, steps);
  if (goalIssue) warnings.push(goalIssue);

  if (data.synthesis?.prompt) {
    const subject = 'Synthesis prompt';
    for (const issue of checkMalformedTokens(subject, data.synthesis.prompt)) errors.push(issue);
    for (const issue of checkInputTokenBinding(subject, data.synthesis.prompt, workflowInputKeys)) {
      errors.push(issue);
    }
    for (const issue of checkImplicitCommonInputDeclarations(subject, data.synthesis.prompt, workflowInputKeys)) {
      warnings.push(issue);
    }
  }

  // ── Per-step semantic checks (the new 2026-05-21 additions) ──
  for (const step of steps) {
    if (!step.id || !step.prompt) continue;

    if (Array.isArray(step.orderingOnlyDeps) && step.orderingOnlyDeps.length > 0) {
      warnings.push(
        `Step "${step.id}" uses deprecated orderingOnlyDeps. dependsOn now carries upstream outputs automatically; remove orderingOnlyDeps when you next edit this workflow.`,
      );
    }

    const forEachNewOnly = step.forEachNewOnly === true || step.for_each_new_only === true;
    if (forEachNewOnly && !(typeof step.forEach === 'string' && step.forEach.trim().length > 0)) {
      errors.push(
        `Step "${step.id}" sets forEachNewOnly but has no forEach source — add forEach so the runner can apply the cross-run watermark.`,
      );
    }

    // forEach must fan out over an upstream DEPENDENCY's list. If it points at a
    // missing step, itself, or a step it doesn't depend on, the runner reads no
    // items and SILENTLY skips the step (reason: forEach-empty) — a fan-out that
    // looks authored but does zero work. Catch it at author time.
    if (typeof step.forEach === 'string' && step.forEach.trim().length > 0) {
      const raw = step.forEach.trim();
      const src = forEachSourceStepId(raw);
      if (!src) {
        errors.push(
          `Step "${step.id}" has unsupported forEach source "${raw}". Use an upstream step id or {{steps.<stepId>.output[.<path>]}}.`,
        );
      } else if (!ids.has(src)) {
        errors.push(
          `Step "${step.id}" has forEach: "${raw}" but no such step "${src}" exists — the fan-out would iterate over nothing and the step is silently skipped at run time.`,
        );
      } else if (src === step.id) {
        errors.push(`Step "${step.id}" has forEach pointing at itself.`);
      } else if (!transitiveDeps(step.id).has(src)) {
        errors.push(
          `Step "${step.id}" fans out over "${src}" but does not depend on it — add "${src}" to this step's dependsOn so its list is produced first; otherwise the runner finds no items and skips the step.`,
        );
      }
    }

    // Template-token sanity (typed-workflow-contract P1, report-only):
    // unrecognized tokens ({{url}} vs {{input.url}}, typos) and
    // {{input.X}} that no declared/common input binds → errors. Declared
    // keys = workflow-level inputs ∪ this step's declared inputs.
    const subject = `Step "${step.id}"`;
    for (const issue of checkMalformedTokens(subject, step.prompt)) errors.push(issue);
    const declaredInputKeys = new Set([
      ...workflowInputKeys,
      ...Object.keys(step.inputs ?? {}),
    ]);
    for (const issue of checkInputTokenBinding(subject, step.prompt, declaredInputKeys)) {
      errors.push(issue);
    }
    for (const issue of checkImplicitCommonInputDeclarations(subject, step.prompt, declaredInputKeys)) {
      warnings.push(issue);
    }

    // Hand-off language → errors (these break workflows in production)
    for (const issue of checkHandoffLanguage(step.id, step.prompt)) {
      errors.push(issue);
    }

    // Approval coherence → errors when broken
    const approval = checkApprovalCoherence(
      step.id,
      step.prompt,
      step.requiresApproval === true || step.requires_approval === true,
    );
    for (const issue of approval.errors) errors.push(issue);
    for (const issue of approval.warnings) warnings.push(issue);

    const sideEffectIssue = checkSideEffectCoherence(step);
    if (sideEffectIssue) warnings.push(sideEffectIssue);

    // Step output references → errors. Data flows only from declared
    // dependencies, so a {{steps.X.output}} where X isn't an upstream
    // dependency renders empty at run time (ordering-dependent). Restrict the
    // valid reference set to this step's transitive dependencies; the checker
    // distinguishes "no such step" from "exists but not a dependency".
    for (const issue of checkStepOutputReferences(step.id, step.prompt, transitiveDeps(step.id), ids)) {
      errors.push(issue);
    }

    // Tool slug catalog check → warnings only (catalog may be partial)
    for (const issue of checkToolSlugs(step.id, step.prompt, opts.knownToolNames)) {
      warnings.push(issue);
    }

    const missingSkill = checkSkillReference(step, opts.installedSkillNames);
    if (missingSkill) warnings.push(missingSkill);

    const deterministicIssue = checkDeterministicRunner(step);
    if (deterministicIssue) warnings.push(deterministicIssue);

    const parallelismIssue = checkParallelismHint(step);
    if (parallelismIssue) warnings.push(parallelismIssue);

    const outputContractIssue = checkOutputContractHint(step);
    if (outputContractIssue) warnings.push(outputContractIssue);

    const bindingIssue = checkRememberedToolChoiceBinding(step, opts.rememberedToolChoices);
    if (bindingIssue) warnings.push(bindingIssue);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stepCount: steps.length,
    hasCycles,
  };
}
