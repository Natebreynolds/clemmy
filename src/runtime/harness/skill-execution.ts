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
