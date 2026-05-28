import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { WORKFLOWS_DIR } from './vault.js';
import { emitWorkflowChange } from './workflow-change-bus.js';

/**
 * Single source of truth for reading and writing Clementine workflows.
 *
 * Layout follows the Linux Foundation Agent Skills specification
 * (agentskills.io) — workflows live as directories so they can ship
 * deterministic helper scripts and reference files alongside the
 * markdown prompt body:
 *
 *   ~/.clementine-next/workflows/<name>/
 *     SKILL.md          — required; YAML frontmatter + prompt body
 *     scripts/          — optional; bash/Python the daemon can invoke
 *                         for deterministic steps (no LLM call)
 *     references/       — optional; docs loaded on demand
 *     runs/<run-id>/    — append-only event log per run (durability)
 *       events.jsonl
 *
 * The legacy layout was a flat .md file per workflow. This module
 * accepts both during reads, migrates flat files to directories on
 * first scan (.md → <name>/SKILL.md, original kept as <name>.md.bak),
 * and always writes the new layout.
 *
 * Why a shared module:
 *   - Both src/tools/orchestration-tools.ts (MCP tools) and
 *     src/dashboard/console-routes.ts (REST API) used to duplicate
 *     loader logic and drifted on field defaults. Consolidating here
 *     guarantees one parser, one writer, one schema.
 */

export interface WorkflowStepInput {
  id: string;
  prompt: string;
  dependsOn?: string[];
  model?: string;
  tier?: number;
  maxTurns?: number;
  /**
   * Route this step through the harness loop (full orchestrator +
   * sub-agents + addressable approvals via apr-xxxx codes) instead of
   * the legacy `assistant.respond()` shorthand. The runner now defaults
   * to the harness for workflow steps; set this to false only for a
   * deliberately legacy/simple text-only step, or set
   * WORKFLOW_USE_HARNESS=off globally for debugging.
   */
  useHarness?: boolean;
  /**
   * "for each item in <input>, run this step once per item." When set,
   * the daemon's workflow runner iterates the named upstream output
   * with bounded concurrency (research_bot/manager.py pattern). The
   * step prompt receives one item per invocation as {{item}}.
   */
  forEach?: string;
  /**
   * Skip the LLM entirely — call a named helper from scripts/ instead.
   * Use for repeatable transforms (database writes, formatted exports)
   * that don't need reasoning. Matches the Anthropic Skills scripts/
   * convention; OpenAI Skills + Agents SDK blog post calls this "tiny
   * CLIs that print deterministic stdout."
   */
  deterministic?: { runner: string };
  /**
   * Per-step tool allowlist. Empty / unset = inherit the workflow's
   * top-level allowed-tools. Used by the runner to filter the tool
   * surface handed to each Agent.run().
   */
  allowedTools?: string[];
  /**
   * Reference to an installed skill — directory name under
   * ~/.clementine-next/skills/<usesSkill>/. When set, the runner loads
   * the skill's SKILL.md body and injects it ahead of this step's
   * prompt so the model executes with the skill's instructions in
   * scope. Lets a workflow compose installed expertise as a Lego block
   * instead of re-prompting it inline.
   *
   * Serialized to YAML as `uses_skill`.
   */
  usesSkill?: string;
}

export interface WorkflowTrigger {
  schedule?: string;
  manual?: boolean;
}

export interface WorkflowInputDef {
  type?: 'string' | 'number';
  default?: string;
  description?: string;
}

export interface WorkflowSynthesis {
  prompt?: string;
}

/**
 * Tool reference in `allowed-tools`. Can be a bare tool name (auto
 * approval) or an object with explicit approval policy:
 *
 *   allowed-tools:
 *     - composio_gmail_search
 *     - composio_outlook_send: { approval: required }
 */
export type WorkflowAllowedTool =
  | string
  | { name: string; approval?: 'auto' | 'required' };

export interface WorkflowDefinition {
  /** kebab-case identifier. Must match the directory name. */
  name: string;
  /** One-line summary used by the agent's tool-discovery surface. */
  description: string;
  /** False = workflow exists but won't fire on its own. */
  enabled: boolean;
  /** When the agent should pick this workflow off the shelf. Free-form. */
  whenToUse?: string;
  trigger: WorkflowTrigger;
  /** Tool surface this workflow may reach for. Filtered into Agent.run() per step. */
  allowedTools?: WorkflowAllowedTool[];
  steps: WorkflowStepInput[];
  inputs?: Record<string, WorkflowInputDef>;
  synthesis?: WorkflowSynthesis;
  /** Free-form prose body — everything not under a ## step: anchor. */
  description_body?: string;
}

/** What the on-disk loader returns. */
export interface WorkflowEntry {
  /** Always the directory name (basename), even for legacy flat files. */
  name: string;
  /** Absolute path to the workflow directory. */
  dir: string;
  /** Path to SKILL.md (or legacy <name>.md). */
  filePath: string;
  /** Layout: 'directory' for new, 'flat' for legacy not-yet-migrated. */
  layout: 'directory' | 'flat';
  data: WorkflowDefinition;
}

/** Parsed body — step prompts pulled out of `## step: <id>` anchors. */
interface ParsedBody {
  /** Everything before the first ## step: header. The human-readable description. */
  description_body: string;
  /** Map of step id → prompt extracted from the body. */
  stepPrompts: Record<string, string>;
}

const STEP_HEADING_RE = /^##\s+step:\s+([a-z0-9_-]+)\s*$/im;
const STEP_HEADING_GLOBAL_RE = /^##\s+step:\s+([a-z0-9_-]+)\s*$/gim;

function ensureWorkflowsDir(): void {
  if (!existsSync(WORKFLOWS_DIR)) mkdirSync(WORKFLOWS_DIR, { recursive: true });
}

function parseAllowedTools(raw: unknown): WorkflowAllowedTool[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: WorkflowAllowedTool[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      out.push(entry);
    } else if (entry && typeof entry === 'object') {
      // Handle YAML's `- name: { approval: required }` syntax and a flat
      // `{ name, approval }` shape interchangeably.
      const keys = Object.keys(entry);
      if (keys.length === 1 && typeof (entry as Record<string, unknown>)[keys[0]] === 'object') {
        const name = keys[0];
        const cfg = (entry as Record<string, Record<string, unknown>>)[name];
        out.push({ name, approval: cfg.approval === 'required' ? 'required' : 'auto' });
      } else if ('name' in (entry as Record<string, unknown>)) {
        const e = entry as Record<string, unknown>;
        out.push({ name: String(e.name), approval: e.approval === 'required' ? 'required' : 'auto' });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Pull step prompts out of `## step: <id>` headers in the markdown
 * body. Everything before the first such header is the description
 * paragraph; we surface that separately so the dashboard can render it
 * verbatim without showing the per-step anchors.
 *
 * The prompt for a step is "the markdown content between this header
 * and the next ## or end of file" — leading/trailing whitespace
 * trimmed. Returns an empty stepPrompts map when there are no anchors,
 * which the loader uses as a signal to fall back to the legacy
 * `steps[].prompt` frontmatter strings.
 */
function parseBody(body: string): ParsedBody {
  const stepPrompts: Record<string, string> = {};
  const firstHeaderMatch = STEP_HEADING_RE.exec(body);
  if (!firstHeaderMatch) {
    return { description_body: body.trim(), stepPrompts };
  }
  const description_body = body.slice(0, firstHeaderMatch.index).trim();
  // Reset the global regex state — reusing it across calls without
  // resetting lastIndex was causing flaky matches on repeated loads.
  STEP_HEADING_GLOBAL_RE.lastIndex = 0;
  const matches: Array<{ id: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = STEP_HEADING_GLOBAL_RE.exec(body)) !== null) {
    matches.push({ id: m[1], start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end;
    const end = i + 1 < matches.length ? matches[i + 1].start : body.length;
    stepPrompts[matches[i].id] = body.slice(start, end).trim();
  }
  return { description_body, stepPrompts };
}

export function readWorkflowDefinitionFile(filePath: string): WorkflowDefinition | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    const body = parseBody(parsed.content || '');
    const inferredName = path.basename(path.dirname(filePath)) === 'workflows'
      ? path.basename(filePath, '.md')
      : path.basename(path.dirname(filePath));
    const frontmatterSteps = Array.isArray(data.steps) ? data.steps : [];
    const steps: WorkflowStepInput[] = frontmatterSteps.map((entry) => {
      const step = entry as Record<string, unknown>;
      const id = String(step.id ?? '');
      // Prefer the body's `## step: <id>` content when present; fall
      // back to the legacy frontmatter prompt for migration compat.
      const bodyPrompt = body.stepPrompts[id];
      const prompt = bodyPrompt && bodyPrompt.length > 0
        ? bodyPrompt
        : String(step.prompt ?? '');
      const result: WorkflowStepInput = { id, prompt };
      if (Array.isArray(step.dependsOn)) result.dependsOn = step.dependsOn.map(String);
      if (typeof step.model === 'string') result.model = step.model;
      if (typeof step.tier === 'number') result.tier = step.tier;
      if (typeof step.maxTurns === 'number') result.maxTurns = step.maxTurns;
      if (typeof step.useHarness === 'boolean') result.useHarness = step.useHarness;
      if (typeof step.forEach === 'string') result.forEach = step.forEach;
      if (step.deterministic && typeof step.deterministic === 'object') {
        const d = step.deterministic as Record<string, unknown>;
        if (typeof d.runner === 'string') result.deterministic = { runner: d.runner };
      }
      const stepAllowed = parseAllowedTools(step.allowedTools);
      if (stepAllowed) result.allowedTools = stepAllowed.map((t) => (typeof t === 'string' ? t : t.name));
      // Accept either `uses_skill` (yaml-idiomatic snake_case, what the
      // architect emits) or `usesSkill` (camelCase, what the desktop UI
      // sends). Either round-trips correctly.
      const skillRef = typeof step.uses_skill === 'string'
        ? step.uses_skill.trim()
        : typeof step.usesSkill === 'string'
          ? step.usesSkill.trim()
          : '';
      if (skillRef) result.usesSkill = skillRef;
      return result;
    });
    return {
      name: String(data.name ?? inferredName),
      description: String(data.description ?? ''),
      enabled: data.enabled !== false,
      whenToUse: typeof data.when_to_use === 'string' ? data.when_to_use : typeof data.whenToUse === 'string' ? data.whenToUse : undefined,
      trigger: typeof data.trigger === 'object' && data.trigger ? data.trigger as WorkflowTrigger : { manual: true },
      allowedTools: parseAllowedTools(data.allowed_tools ?? data.allowedTools),
      steps,
      inputs: typeof data.inputs === 'object' && data.inputs ? data.inputs as WorkflowDefinition['inputs'] : undefined,
      synthesis: typeof data.synthesis === 'object' && data.synthesis ? data.synthesis as WorkflowSynthesis : undefined,
      description_body: body.description_body || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * One-time migration: convert legacy flat `<name>.md` files into
 * `<name>/SKILL.md` directories. The original is renamed to
 * `<name>.md.bak` so the user can verify / roll back; the daemon
 * removes the .bak after one clean boot if a same-named SKILL.md
 * exists. Idempotent — calling repeatedly is safe.
 *
 * Returns the list of names migrated so the caller can log.
 */
export function migrateLegacyWorkflowsOnce(): string[] {
  ensureWorkflowsDir();
  const migrated: string[] = [];
  for (const entry of readdirSync(WORKFLOWS_DIR)) {
    if (!entry.endsWith('.md')) continue;
    const flatPath = path.join(WORKFLOWS_DIR, entry);
    const stat = statSync(flatPath);
    if (!stat.isFile()) continue;
    const name = path.basename(entry, '.md');
    const dirPath = path.join(WORKFLOWS_DIR, name);
    const skillPath = path.join(dirPath, 'SKILL.md');
    if (existsSync(skillPath)) {
      // Already migrated. Drop the .md.bak rotation if it's still
      // around — one clean boot has passed.
      const bakPath = path.join(WORKFLOWS_DIR, `${name}.md.bak`);
      if (existsSync(bakPath)) {
        try { unlinkSync(bakPath); } catch { /* best effort */ }
      }
      // Also remove the flat .md (now stale) if both exist.
      try { unlinkSync(flatPath); } catch { /* best effort */ }
      continue;
    }
    const def = readWorkflowDefinitionFile(flatPath);
    if (!def) continue;
    if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
    writeWorkflowToDir(dirPath, def);
    // Rename flat → .md.bak so the original content is recoverable if
    // the migration corrupts something. Daemon removes the .bak on the
    // next clean boot (above).
    try {
      renameSync(flatPath, path.join(WORKFLOWS_DIR, `${name}.md.bak`));
    } catch {
      // If rename fails (e.g. .bak already exists), just delete the
      // flat. The directory copy is the source of truth now.
      try { unlinkSync(flatPath); } catch { /* ignore */ }
    }
    migrated.push(name);
  }
  return migrated;
}

/**
 * Serialize a workflow definition into SKILL.md format. Step prompts
 * are written to the body under `## step: <id>` anchors so they're
 * human-editable as prose. Frontmatter holds typed config only.
 */
function writeWorkflowToDir(dirPath: string, def: WorkflowDefinition): void {
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
  const frontmatter: Record<string, unknown> = {
    name: def.name,
    description: def.description,
    enabled: def.enabled,
  };
  if (def.whenToUse) frontmatter.when_to_use = def.whenToUse;
  if (def.allowedTools && def.allowedTools.length > 0) frontmatter.allowed_tools = def.allowedTools;
  if (def.trigger) frontmatter.trigger = def.trigger;
  // Steps go in frontmatter for typed config (id, deps, model, forEach,
  // deterministic, allowedTools) but the PROMPT lives in the body so
  // the Architect agent can refine it as natural prose. Stripping
  // `prompt` here keeps the YAML lean.
  if (def.steps.length > 0) {
    frontmatter.steps = def.steps.map((s) => {
      const out: Record<string, unknown> = { id: s.id };
      if (s.dependsOn && s.dependsOn.length > 0) out.dependsOn = s.dependsOn;
      if (s.model) out.model = s.model;
      if (s.tier !== undefined) out.tier = s.tier;
      if (s.maxTurns !== undefined) out.maxTurns = s.maxTurns;
      if (s.forEach) out.forEach = s.forEach;
      if (s.deterministic) out.deterministic = s.deterministic;
      if (s.allowedTools && s.allowedTools.length > 0) out.allowedTools = s.allowedTools;
      if (s.usesSkill) out.uses_skill = s.usesSkill;
      return out;
    });
  }
  if (def.inputs && Object.keys(def.inputs).length > 0) frontmatter.inputs = def.inputs;
  if (def.synthesis?.prompt) frontmatter.synthesis = def.synthesis;

  // Body: optional description paragraph, then one ## step: <id> per
  // step with its prompt content. Always end with a trailing newline.
  const lines: string[] = [];
  const descBody = (def.description_body ?? '').trim();
  if (descBody) {
    lines.push(descBody, '');
  } else if (def.description) {
    lines.push(def.description, '');
  }
  for (const step of def.steps) {
    lines.push(`## step: ${step.id}`, '');
    lines.push((step.prompt ?? '').trim(), '');
  }
  const body = lines.join('\n').trimEnd() + '\n';
  const skillPath = path.join(dirPath, 'SKILL.md');
  writeFileSync(skillPath, matter.stringify(body, frontmatter), 'utf-8');
}

/**
 * Public reader. Always preferred entry point — caller gets a typed
 * WorkflowEntry regardless of disk layout. Returns null when the
 * workflow is unparseable; never throws.
 */
export function readWorkflow(name: string): WorkflowEntry | null {
  ensureWorkflowsDir();
  const dirPath = path.join(WORKFLOWS_DIR, name);
  const skillPath = path.join(dirPath, 'SKILL.md');
  if (existsSync(skillPath)) {
    const data = readWorkflowDefinitionFile(skillPath);
    if (!data) return null;
    return { name, dir: dirPath, filePath: skillPath, layout: 'directory', data };
  }
  const flatPath = path.join(WORKFLOWS_DIR, `${name}.md`);
  if (existsSync(flatPath)) {
    const data = readWorkflowDefinitionFile(flatPath);
    if (!data) return null;
    return { name, dir: WORKFLOWS_DIR, filePath: flatPath, layout: 'flat', data };
  }
  return null;
}

/**
 * Scan WORKFLOWS_DIR and return every workflow. Accepts both layouts:
 *   - <name>/SKILL.md (preferred)
 *   - <name>.md       (legacy; flagged via layout: 'flat')
 *
 * Note: this does NOT auto-migrate. Call migrateLegacyWorkflowsOnce()
 * explicitly on daemon boot to avoid surprising scans during reads.
 */
export function listWorkflows(): WorkflowEntry[] {
  ensureWorkflowsDir();
  const entries: WorkflowEntry[] = [];
  const seenNames = new Set<string>();
  for (const entry of readdirSync(WORKFLOWS_DIR)) {
    const fullPath = path.join(WORKFLOWS_DIR, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }
    if (stat.isDirectory()) {
      const skillPath = path.join(fullPath, 'SKILL.md');
      if (!existsSync(skillPath)) continue;
      const data = readWorkflowDefinitionFile(skillPath);
      if (!data) continue;
      seenNames.add(entry);
      entries.push({ name: entry, dir: fullPath, filePath: skillPath, layout: 'directory', data });
    } else if (entry.endsWith('.md') && !entry.endsWith('.md.bak')) {
      const name = path.basename(entry, '.md');
      // Skip the flat file if a directory of the same name already
      // exists — the directory wins.
      if (seenNames.has(name)) continue;
      const data = readWorkflowDefinitionFile(fullPath);
      if (!data) continue;
      seenNames.add(name);
      entries.push({ name, dir: WORKFLOWS_DIR, filePath: fullPath, layout: 'flat', data });
    }
  }
  return entries;
}

/**
 * Public writer. Always writes the new directory format. Creates the
 * directory on first write; subsequent writes overwrite SKILL.md in
 * place. Existing scripts/, references/, runs/ subdirectories are
 * preserved.
 */
export function writeWorkflow(name: string, def: WorkflowDefinition): WorkflowEntry {
  ensureWorkflowsDir();
  const dirPath = path.join(WORKFLOWS_DIR, name);
  // Detect created-vs-updated BEFORE the write so the event can carry
  // the right op. existsSync on the directory is the canonical signal.
  const isCreate = !existsSync(dirPath) && !existsSync(path.join(WORKFLOWS_DIR, `${name}.md`));
  // `name` is the directory slug; the human display label lives in
  // def.name (e.g. "Patch Validation Test"). Only fall back to the
  // slug when the caller didn't set one — otherwise we'd clobber the
  // user-visible label every save.
  const defWithName: WorkflowDefinition = def.name ? def : { ...def, name };
  writeWorkflowToDir(dirPath, defWithName);
  // If a stale flat .md still exists (e.g. during a manual edit
  // sequence) get rid of it so the directory layout is unambiguous.
  const flatPath = path.join(WORKFLOWS_DIR, `${name}.md`);
  if (existsSync(flatPath)) {
    try { unlinkSync(flatPath); } catch { /* ignore */ }
  }
  const entry = readWorkflow(name);
  if (!entry) throw new Error(`writeWorkflow: failed to read back ${name} after write`);
  emitWorkflowChange({ name, op: isCreate ? 'created' : 'updated' });
  return entry;
}

/**
 * Delete a workflow. Removes the directory recursively when in the
 * new layout, or the single .md file when legacy. Per-run events.jsonl
 * logs under runs/ are removed too — callers should call
 * `workflow_run_status` on any in-flight runs first.
 */
export function deleteWorkflow(name: string): boolean {
  const entry = readWorkflow(name);
  if (!entry) return false;
  if (entry.layout === 'directory') {
    rmSync(entry.dir, { recursive: true, force: true });
  } else {
    try { unlinkSync(entry.filePath); } catch { return false; }
  }
  emitWorkflowChange({ name, op: 'deleted' });
  return true;
}
