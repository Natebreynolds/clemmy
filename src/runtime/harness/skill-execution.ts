/**
 * Skill-execution enforcement helpers (global "run the skill as designed" fix).
 *
 * Layer 1 (the execution-contract framing) lives in skill-tools.ts. This module
 * is the shared Layer-2 plumbing: figure out which installed skills were loaded
 * in a session and surface them as a rubric so the completion gate can verify
 * the skill was actually EXECUTED, not just read. It reads each skill's own
 * content — no per-skill code — so it works for whatever skills a given user
 * has installed (north star: global, not curated).
 *
 * Two consumers, by the nature of their gate:
 *   - Chat: the LLM objective judge gets the skill bodies + tool-call evidence
 *     and verifies execution (catches PARTIAL skips, e.g. "redesign skill says
 *     generate imagery; no image tool fired").
 *   - Workflow step: the deterministic step verifier uses the cheap binary
 *     `sessionReadAnySkill` (declared usesSkill ⇒ skill_read actually ran).
 *
 * Everything here is FAIL-OPEN: any error returns the permissive value ([] /
 * false / '') so a bug in skill verification can never wedge a real completion.
 */
import { listEvents, getToolOutput } from './eventlog.js';

export interface SessionSkill {
  name: string;
  body: string;
}

function skillReadCalls(sessionId: string): { name: string; callId: string }[] {
  const out: { name: string; callId: string }[] = [];
  const events = listEvents(sessionId, { types: ['tool_called'] });
  for (const e of events) {
    if (e.data?.tool !== 'skill_read') continue;
    const callId = typeof e.data?.callId === 'string' ? e.data.callId : null;
    let name = '';
    try {
      name = String((JSON.parse(String(e.data?.arguments ?? '{}')) as { name?: unknown }).name ?? '');
    } catch {
      name = '';
    }
    if (callId && name) out.push({ name, callId });
  }
  return out;
}

/** True iff ≥1 `skill_read` happened in the session. Cheap gate for the
 *  deterministic workflow step verifier. Fail-open → false. */
export function sessionReadAnySkill(sessionId: string): boolean {
  try {
    return skillReadCalls(sessionId).length > 0;
  } catch {
    return false;
  }
}

/** The (deduped) skill bodies loaded in a session, un-clipped from the
 *  tool_outputs side-store, with the skill_read envelope stripped so only the
 *  real SKILL.md body remains. Fail-open → []. */
export function gatherSessionSkills(sessionId: string): SessionSkill[] {
  try {
    const out: SessionSkill[] = [];
    const seen = new Set<string>();
    for (const { name, callId } of skillReadCalls(sessionId)) {
      if (seen.has(name)) continue;
      const row = getToolOutput(sessionId, callId);
      if (!row?.output) continue;
      // skill_read returns: head\n\nmanifest\n\ncrib\n\nexecutionContract\n\n---\n<body>.
      // The envelope (head/manifest/crib/contract) contains no '\n---\n', so the
      // FIRST divider is the envelope→body boundary. Use indexOf (not lastIndexOf)
      // so a skill body that itself contains '---' dividers is kept in FULL.
      const idx = row.output.indexOf('\n---\n');
      const body = (idx >= 0 ? row.output.slice(idx + 5) : row.output).trim();
      if (body) {
        out.push({ name, body });
        seen.add(name);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** The basenames of scripts/commands a shell command actually INVOKES
 *  (`node x.js`, `python y.py`, `./z.sh`, `npm run build`). Surfacing these lets
 *  the skill-execution judge tell `generate-html.js` from `ls` — so a skill that
 *  prescribes running a bundled script can be checked against whether it ran.
 *  Heuristic, bounded, fail-open. General to any script-backed skill. */
export function extractInvokedScripts(command: string): string[] {
  if (!command || typeof command !== 'string') return [];
  const out = new Set<string>();
  // A script file passed to an interpreter, or executed directly (`./x.sh`).
  for (const m of command.matchAll(/(?:(?:^|[\s|&;(])(?:node|nodejs|python3?|py|bash|sh|zsh|ruby|deno|bun|tsx|ts-node|php|perl)\s+(?:[\w.-]+\/)*|\.\/(?:[\w.-]+\/)*)([\w.-]+\.(?:m?[jt]s|cjs|py|sh|rb|php|pl))\b/gi)) {
    const base = m[1].split('/').pop();
    if (base) out.add(base.toLowerCase());
  }
  // `npm|pnpm|yarn run <script>` — the script name is the meaningful token.
  for (const m of command.matchAll(/\b(?:npm|pnpm|yarn)\s+run\s+([\w:.-]+)\b/gi)) {
    out.add(`npm:${m[1].toLowerCase()}`);
  }
  return [...out].slice(0, 8);
}

/** Scripts a SKILL.md PRESCRIBES as runnable bundled files — PATH-qualified
 *  basenames (`src/generate-html.js`, `scripts/build.py`). Path-qualified on
 *  purpose so an incidental ".js" mention in prose is never mistaken for a
 *  prescribed pipeline script. Reads the skill's own text — no per-skill code,
 *  general to any script-backed skill. Fail-open → []. */
function extractPrescribedScripts(skillBody: string): string[] {
  if (!skillBody || typeof skillBody !== 'string') return [];
  const out = new Set<string>();
  for (const m of skillBody.matchAll(/\b(?:src|scripts|bin|tools|lib)\/(?:[\w.-]+\/)*([\w.-]+\.(?:m?[jt]s|cjs|py|sh|rb|php|pl))\b/gi)) {
    out.add(m[1].toLowerCase());
  }
  return [...out].slice(0, 24);
}

/** RENDERER/producer scripts among the prescribed set — the ones that EMIT the
 *  deliverable (name contains generate/render/compose/emit). Running a cheap
 *  helper (a validator, an aggregator) must NOT satisfy the gate; the renderer
 *  must — that's the validate-but-don't-generate gaming the lunar audit used.
 *  Empty → the skill has no obvious producer (the caller falls back to "any
 *  prescribed script"). */
function rendererScripts(prescribed: string[]): string[] {
  return prescribed.filter((s) => /(?:generate|render|compose|emit)/i.test(s));
}

/** Script basenames a command REQUIREs / IMPORTs — library-style skills are USED
 *  via `require('./src/generate-html')`, not `node generate-html.js`. Normalized
 *  to a `.js` basename to match extractPrescribedScripts. */
function extractRequiredScripts(command: string): string[] {
  if (!command || typeof command !== 'string') return [];
  const out = new Set<string>();
  for (const m of command.matchAll(/(?:require\(\s*|from\s+|import\s+)['"`](?:[\w.@/-]+\/)?([\w.-]+?)(?:\.(?:m?[jt]s|cjs))?['"`]/gi)) {
    const base = m[1].toLowerCase();
    if (base) out.add(base.endsWith('.js') ? base : `${base}.js`);
  }
  return [...out].slice(0, 24);
}

/** Script basenames actually INVOKED this session — run as `node x.js` OR pulled
 *  in via `require('…x')`/`import`. */
function sessionInvokedScripts(sessionId: string): Set<string> {
  const invoked = new Set<string>();
  for (const e of listEvents(sessionId, { types: ['tool_called'] })) {
    if (e.data?.tool !== 'run_shell_command') continue;
    try {
      const cmd = String((JSON.parse(String(e.data?.arguments ?? '{}')) as { command?: unknown }).command ?? '');
      for (const s of extractInvokedScripts(cmd)) invoked.add(s);
      for (const s of extractRequiredScripts(cmd)) invoked.add(s);
    } catch { /* skip a malformed command */ }
  }
  return invoked;
}

export interface SkillExecutionShortfall {
  skill: string;
  prescribed: string[];
}

/**
 * The shared deterministic core. A skill's deliverable must come from its own
 * RENDERER (the generate/render script), not be hand-rolled. `required` = the
 * renderer(s) when the skill ships one, else any prescribed script (skills with
 * no obvious producer keep the looser any-script floor). Returns the offending
 * skill if NONE of `required` ran, else null. Catches the validate-but-don't-
 * generate gaming: running the cheap validator no longer satisfies the gate.
 */
function bodyShortfall(skill: string, body: string, invoked: Set<string>): SkillExecutionShortfall | null {
  const prescribed = extractPrescribedScripts(body);
  if (prescribed.length === 0) return null; // pure-reference skill — nothing to enforce
  const producers = rendererScripts(prescribed);
  const required = producers.length > 0 ? producers : prescribed;
  if (required.some((s) => invoked.has(s))) return null; // the renderer (or fallback) ran
  return { skill, prescribed: required };
}

/**
 * DETERMINISTIC skill-execution floor for the CHAT completion gate (skills loaded
 * via skill_read). A loaded skill whose RENDERER never ran was not executed — the
 * deliverable was hand-rolled (the 2026-06-15 lunar-audit passed the LLM judge
 * while running 0 of the skill's scripts, then on re-run only ran the VALIDATOR
 * on a hand-rolled file). The LLM judge can't be trusted for this binary fact, so
 * the gate enforces it in code. Fail-open → null. General to any script-backed skill.
 */
export function skillExecutionShortfall(sessionId: string): SkillExecutionShortfall | null {
  try {
    const invoked = sessionInvokedScripts(sessionId);
    for (const skill of gatherSessionSkills(sessionId)) {
      const gap = bodyShortfall(skill.name, skill.body, invoked);
      if (gap) return gap;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * DETERMINISTIC skill-execution floor for the WORKFLOW-STEP path. A workflow step
 * injects its skill via `usesSkill` (prompt-prepend), NOT skill_read — so the
 * caller passes the skill body directly (loadSkill(step.usesSkill)). Same
 * renderer-must-run rule as the chat gate. Fail-open → null. This is what closes
 * the escape hatch: a chat-gate bounce pushed the model to dispatch a background
 * workflow, which had no skill enforcement.
 */
export function skillBodyExecutionShortfall(skillName: string, skillBody: string, sessionId: string): SkillExecutionShortfall | null {
  try {
    return bodyShortfall(skillName, skillBody, sessionInvokedScripts(sessionId));
  } catch {
    return null;
  }
}

/** Compact tool-call evidence (tool/slug/script → count) so the judge can see what
 *  was actually done — e.g. that no image-generation tool fired against a skill
 *  that prescribes generating imagery, or that a skill's mandatory bundled script
 *  (e.g. `generate-html.js`) never ran. Fail-open → ''. */
export function summarizeToolCallsForJudge(sessionId: string): string {
  try {
    const counts = new Map<string, number>();
    for (const e of listEvents(sessionId, { types: ['tool_called'] })) {
      const tool = typeof e.data?.tool === 'string' ? e.data.tool : 'unknown';
      let key = tool;
      if (tool === 'composio_execute_tool') {
        try {
          const slug = (JSON.parse(String(e.data?.arguments ?? '{}')) as { tool_slug?: unknown }).tool_slug;
          if (typeof slug === 'string' && slug) key = `composio:${slug}`;
        } catch {
          /* keep generic key */
        }
      } else if (tool === 'run_shell_command') {
        // Surface the script(s) the shell call actually invoked, so the judge can
        // verify a skill's prescribed scripts RAN (not just "a shell command ran
        // N times"). 2026-06-15: the lunar-audit's mandatory generate-html.js
        // never ran in ANY session and the judge was blind to it.
        try {
          const cmd = String((JSON.parse(String(e.data?.arguments ?? '{}')) as { command?: unknown }).command ?? '');
          const scripts = extractInvokedScripts(cmd);
          if (scripts.length) key = `run_shell_command(${scripts.join(',')})`;
        } catch {
          /* keep generic key */
        }
      }
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (counts.size === 0) return '(no tool calls made)';
    return [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(', ');
  } catch {
    return '';
  }
}
