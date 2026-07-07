/**
 * Plain-English / printable workflow renderer.
 *
 * Workflows are only useful as repeatable building blocks if a NON-ENGINEER
 * can read one and understand exactly what it does, when it runs, what it
 * needs, and where it will pause — without parsing YAML, cron, or
 * `{{steps.x.output}}` tokens. This module turns a WorkflowDefinition into a
 * clear, printable summary used at authoring time (so the user sees what they
 * just built), in chat ("what does X do?"), and on the dashboard.
 *
 * Pure + dependency-free: no LLM, no I/O. Safe to call anywhere.
 */
import type {
  WorkflowDefinition,
  WorkflowStepInput,
} from '../memory/workflow-store.js';

// ─── cron → human recurrence ─────────────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const isInt = (s: string): boolean => /^\d+$/.test(s);
const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
};
function to12h(hour: number, minute: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${period}`;
}

/** Human phrase for the TIME-of-day portion of a cron, or null if not a
 *  simple clock time (caller falls back to the raw expression). */
function describeTime(min: string, hour: string): string | null {
  const everyNMin = min.match(/^\*\/(\d+)$/);
  if (everyNMin && hour === '*') return `every ${everyNMin[1]} minutes`;
  if (isInt(min) && isInt(hour)) return `at ${to12h(Number(hour), Number(min))}`;
  if (isInt(min) && hour === '*') return `at :${min.padStart(2, '0')} past every hour`;
  const everyNHour = hour.match(/^\*\/(\d+)$/);
  if (isInt(min) && everyNHour) return `every ${everyNHour[1]} hours (at :${min.padStart(2, '0')})`;
  return null;
}

/** Human phrase for the DAY portion of a cron, or null if too complex. */
function describeDay(dom: string, mon: string, dow: string): string | null {
  const star = (s: string): boolean => s === '*';
  let day: string | null = null;
  if (star(dom) && star(dow)) day = 'every day';
  else if (star(dom) && dow === '1-5') day = 'every weekday';
  else if (star(dom) && dow === '6,0') day = 'every weekend';
  else if (star(dom) && isInt(dow)) day = `every ${WEEKDAYS[Number(dow) % 7]}`;
  else if (star(dom) && /^\d+(,\d+)+$/.test(dow)) {
    day = `every ${dow.split(',').map((d) => WEEKDAYS[Number(d) % 7]).join(', ')}`;
  } else if (isInt(dom) && star(dow)) day = `on the ${ordinal(Number(dom))} of the month`;
  if (!day) return null;
  if (isInt(mon)) day += ` in ${MONTHS[Number(mon)] ?? mon}`;
  else if (!star(mon)) return null; // a month list/range → fall back
  return day;
}

/**
 * Cron expression → human recurrence ("every weekday at 8:00 AM"). Falls
 * back to the raw expression for anything it can't cleanly phrase, so it is
 * never wrong — only sometimes terse.
 */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return `on the schedule \`${cron}\``;
  const [min, hour, dom, mon, dow] = parts;
  const time = describeTime(min, hour);
  const day = describeDay(dom, mon, dow);
  // A day field we couldn't phrase (and that isn't plain "every day") means a
  // real constraint we'd be dropping — fall back to the raw expression rather
  // than mislead (e.g. "0 8 1-7 3 2" must NOT render as a bare "at 8:00 AM").
  if (!day) return `on the schedule \`${cron}\``;
  if (!time) return day;
  // An interval time ("every N minutes/hours") already implies all-day, so
  // don't prepend a redundant "every day"; keep a more specific day qualifier.
  if (time.startsWith('every ')) return day === 'every day' ? time : `${day} ${time}`;
  return `${day} ${time}`;
}

/** One-line "when does this run" phrase. */
export function describeSchedule(def: WorkflowDefinition): string {
  const schedule = def.trigger?.schedule;
  if (!schedule) return 'On demand — it runs when you ask.';
  const tz = def.trigger?.timezone ? ` (${def.trigger.timezone})` : '';
  const paused = def.enabled === false ? ' — currently paused (disabled)' : '';
  return `${capitalize(describeCron(schedule))}${tz}${paused}`;
}

// ─── inputs ──────────────────────────────────────────────────────────

/** One-line "what it needs from you" phrase. */
export function describeInputs(def: WorkflowDefinition): string {
  const entries = Object.entries(def.inputs ?? {});
  if (entries.length === 0) return 'Nothing — it runs on its own.';
  return entries
    .map(([key, meta]) => {
      const dflt = meta?.default?.trim();
      if (dflt) return `${key} (defaults to "${dflt}")`;
      return `${key} (required)`;
    })
    .join(', ');
}

// ─── steps ───────────────────────────────────────────────────────────

/** Replace engine template tokens with readable phrases so a step reads as
 *  plain English instead of `{{steps.fetch.output}}`. */
function detokenize(prompt: string): string {
  return prompt
    .replace(/\{\{\s*steps\.([a-zA-Z0-9_-]+)\.output(?:\.[a-zA-Z0-9_.-]+)?\s*\}\}/g, 'the result of "$1"')
    .replace(/\{\{\s*input\.([a-zA-Z0-9_-]+)\s*\}\}/g, 'the $1')
    .replace(/\{\{\s*project\.([a-zA-Z0-9_-]+)\s*\}\}/g, 'the project $1')
    .replace(/\{\{\s*item\.([a-zA-Z0-9_.-]+)\s*\}\}/g, "each item's $1")
    .replace(/\{\{\s*item\s*\}\}/g, 'each item')
    .replace(/\{\{\s*date\s*\}\}/g, "today's date")
    .replace(/\{\{\s*[^}]+\s*\}\}/g, '…');
}

/** A short, human one-liner for a step: first sentence of its (detokenized)
 *  prompt, clipped. */
export function shortStepLabel(prompt: string): string {
  const clean = detokenize((prompt ?? '').replace(/\s+/g, ' ').trim());
  if (!clean) return '(no description)';
  // First sentence (up to a period/newline) or the whole thing if short.
  const firstSentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  const text = firstSentence.length > 0 ? firstSentence : clean;
  return text.length > 140 ? `${text.slice(0, 137).trimEnd()}…` : text;
}

function stepAnnotations(step: WorkflowStepInput): string[] {
  const notes: string[] = [];
  if (step.forEach) notes.push(`once for each item from "${step.forEach}"`);
  if (step.project) notes.push(`uses project "${step.project}"`);
  const skill = step.usesSkill ?? (step as { uses_skill?: string }).uses_skill;
  if (skill) notes.push(`uses the "${skill}" skill`);
  if (step.deterministic?.runner) notes.push('runs a script (no AI)');
  const gated = step.requiresApproval === true || (step as { requires_approval?: boolean }).requires_approval === true;
  if (gated) {
    const preview = step.approvalPreview ?? (step as { approval_preview?: string }).approval_preview;
    notes.push(preview ? `pauses for your approval: ${preview}` : 'pauses for your approval');
  }
  return notes;
}

/** Render one step as a numbered plain-English line. */
export function describeStep(step: WorkflowStepInput, index: number): string {
  const label = shortStepLabel(step.prompt);
  const notes = stepAnnotations(step);
  const suffix = notes.length > 0 ? ` _(${notes.join('; ')})_` : '';
  return `${index + 1}. ${label}${suffix}`;
}

// ─── data-source provenance ──────────────────────────────────────────

/** Engine/template tokens that look like connector slugs but aren't — excluded
 *  from the "refs in prompt" derivation so STEP_CONTEXT etc. don't read as data
 *  sources. NOT a vendor list (that would violate global/no-curated-lists) —
 *  it's the harness's own grammar tokens. */
const NON_CONNECTOR_TOKENS = new Set([
  'STEP_CONTEXT', 'STEP', 'CONTEXT', 'JSON', 'HTTP', 'HTTPS', 'URL', 'URI', 'API',
  'ID', 'IDS', 'CSV', 'HTML', 'PDF', 'UTC', 'TODO', 'NOTE', 'AND', 'OR', 'NOT',
]);

/**
 * Vendor-agnostic derivation of WHERE a step's data comes from and what it can
 * touch — surfaced at READ time so an editor sees a step's REAL bindings
 * (e.g. that it queries Salesforce, not Composio) instead of guessing from a
 * clipped prompt. Pure: reads the step's declared capability surface +
 * data-flow bindings, plus a light regex over the prompt for concrete tool /
 * connector references. No curated vendor list — it surfaces whatever the step
 * literally names.
 */
export function deriveStepDataSources(step: WorkflowStepInput): string[] {
  const out: string[] = [];
  const prompt = step.prompt ?? '';

  // 1) Explicit, declared capability surface (the most reliable signals).
  if (step.deterministic?.runner) out.push(`script: ${step.deterministic.runner} (no AI)`);
  if (step.allowedTools && step.allowedTools.length > 0) {
    out.push(`allowed tools: ${step.allowedTools.join(', ')}`);
  }
  if (step.project) out.push(`project: ${step.project}`);

  // 2) Concrete tool/connector references INSIDE the prompt (general patterns,
  //    no vendor list): MCP tool names, Composio-style ALL_CAPS slugs
  //    (SALESFORCE_QUERY, OUTLOOK_FETCH_MESSAGES), and named harness tools.
  const refs = new Set<string>();
  for (const m of prompt.matchAll(/\bmcp__[a-zA-Z0-9_]+__[a-zA-Z0-9_]+\b/g)) refs.add(m[0]);
  for (const m of prompt.matchAll(/\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/g)) {
    if (!NON_CONNECTOR_TOKENS.has(m[0])) refs.add(m[0]);
  }
  for (const m of prompt.matchAll(/\b(?:composio_execute_tool|run_tool_program|write_file|run_shell_command|web_fetch|web_search)\b/g)) {
    refs.add(m[0]);
  }
  if (refs.size > 0) out.push(`refs in prompt: ${[...refs].slice(0, 12).join(', ')}`);

  // 3) Data flow — what it reads in / iterates over.
  const flow = new Set<string>();
  for (const m of prompt.matchAll(/\{\{\s*steps\.([a-zA-Z0-9_-]+)\.output[^}]*\}\}/g)) flow.add(`steps.${m[1]}`);
  for (const m of prompt.matchAll(/\{\{\s*input\.([a-zA-Z0-9_-]+)\s*\}\}/g)) flow.add(`input.${m[1]}`);
  for (const m of prompt.matchAll(/\{\{\s*project\.([a-zA-Z0-9_-]+)\s*\}\}/g)) flow.add(`project.${m[1]}`);
  if (step.forEach) flow.add(`forEach ${step.forEach}`);
  if (/\{\{\s*item[.\s}]/.test(prompt)) flow.add('item');
  if (flow.size > 0) out.push(`data flow: ${[...flow].join(', ')}`);

  // 4) Side-effect class (read / write / send) — visible so an editor knows
  //    whether a step touches external state.
  if (step.sideEffect) out.push(`side-effect: ${step.sideEffect}`);

  return out;
}

/**
 * A compact per-step "data sources" review block for author-time confirmation —
 * so a WRONG binding (e.g. a step built on Composio when it should read
 * Salesforce) is VISIBLE the moment a workflow is created or edited, not
 * discovered at run time. Returns '' when no step has a derivable source.
 */
export function renderWorkflowDataSources(def: WorkflowDefinition): string {
  const lines: string[] = [];
  for (const step of def.steps ?? []) {
    const sources = deriveStepDataSources(step);
    if (sources.length > 0) lines.push(`- ${step.id}: ${sources.join(' · ')}`);
  }
  if (lines.length === 0) return '';
  return `**Data sources per step** (confirm these are right — e.g. the correct connector):\n${lines.join('\n')}`;
}

// ─── produces ────────────────────────────────────────────────────────

/** One-line "what you get at the end" phrase, best-effort + honest. */
export function describeProduces(def: WorkflowDefinition): string {
  if (def.synthesis?.prompt) return 'a final summary that combines every step.';
  const last = def.steps[def.steps.length - 1];
  if (!last) return 'nothing yet — it has no steps.';
  const keys = last.output?.required_keys;
  if (keys && keys.length > 0) return `from the final step "${last.id}": ${keys.join(', ')}.`;
  const urls = last.output?.verify?.url_present;
  if (urls && urls.length > 0) return `a published link from the final step "${last.id}".`;
  const files = last.output?.verify?.path_exists;
  if (files && files.length > 0) return `a saved file from the final step "${last.id}".`;
  return `the result of the final step ("${last.id}").`;
}

// ─── top-level ───────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Render a workflow as a clear, printable plain-English summary. Markdown,
 * but reads cleanly as plain text too (printable). This is the canonical
 * "what this workflow does" view shown to users.
 */
export function describeWorkflowPlainEnglish(def: WorkflowDefinition): string {
  const lines: string[] = [];
  lines.push(`📋 **${def.name}**`);
  if (def.description?.trim()) lines.push(`_${def.description.trim()}_`);
  lines.push('');
  lines.push(`⏰ **When:** ${describeSchedule(def)}`);
  lines.push(`📥 **Needs:** ${describeInputs(def)}`);
  if (def.project) lines.push(`🗂 **Project:** ${def.project}`);
  lines.push(`📤 **Produces:** ${describeProduces(def)}`);
  lines.push('');
  const steps = def.steps ?? [];
  if (steps.length === 0) {
    lines.push('**Steps:** none yet.');
  } else {
    lines.push(`**Steps** (${steps.length}):`);
    steps.forEach((s, i) => lines.push(describeStep(s, i)));
  }
  return lines.join('\n');
}

/** Compact single-line summary for lists/notifications:
 *  "Morning Prospect Prep — every weekday at 8:00 AM · 3 steps · pauses once for approval". */
export function describeWorkflowOneLine(def: WorkflowDefinition): string {
  const stepCount = def.steps?.length ?? 0;
  const gated = (def.steps ?? []).some(
    (s) => s.requiresApproval === true || (s as { requires_approval?: boolean }).requires_approval === true,
  );
  const when = def.trigger?.schedule ? describeCron(def.trigger.schedule) : 'on demand';
  const bits = [`${when}`, `${stepCount} step${stepCount === 1 ? '' : 's'}`];
  if (def.project) bits.push(`project ${def.project}`);
  if (gated) bits.push('pauses for approval');
  if (def.enabled === false) bits.push('paused');
  return `${def.name} — ${bits.join(' · ')}`;
}
