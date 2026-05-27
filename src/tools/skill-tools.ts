import { readdirSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listSkills, loadSkill, type Skill } from '../memory/skill-store.js';
import { textResult } from './shared.js';

/**
 * List up to 20 top-level entries in the skill directory. Helps the
 * agent see whether a skill bundles executables, references, or input
 * samples without having to run a separate list_files call.
 */
function listSkillEntries(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .sort()
      .slice(0, 20);
  } catch {
    return [];
  }
}

/**
 * SKILL.md files authored against the Claude Code / Anthropic spec
 * declare allowed-tools using names like "Bash, Read, Write, Edit,
 * WebFetch". Clementine's tools are named differently. The skill body
 * is documentation, not enforcement, so the agent is free to pick
 * Clementine's equivalents — but only if it knows the mapping. We
 * append a short crib sheet to every skill_read so the agent never
 * has to guess.
 */
function renderToolNameCrib(skill: Skill): string {
  return [
    'Tool name mapping (this skill is documented in Claude Code conventions; use Clementine\'s tools instead):',
    `- Bash → run_shell_command (set cwd to "${skill.dir}" when invoking bundled helpers)`,
    '- Read → read_file',
    '- Write → write_file',
    '- Edit → write_file (read existing content first, then write the new content)',
    '- WebFetch → web_fetch',
    'The skill\'s allowed-tools frontmatter is documentation only; pick whichever Clementine tool fits the step.',
  ].join('\n');
}

/**
 * Skill discovery tools — agent-facing surface for installed SKILL.md
 * skills (Anthropic Skills format).
 *
 * The pattern mirrors `composio_search_tools` / `composio_execute_tool`:
 *
 *   1. `skill_list()` — what skills are installed, with descriptions
 *   2. `skill_read(name)` — pull the full SKILL.md body into context
 *
 * The harness injects only the compact skill index (name +
 * description) into persistent context. Full skill bodies stay
 * on-demand: the agent picks the relevant skill(s) by description and
 * pulls them in with skill_read.
 */

export function registerSkillTools(server: McpServer): void {
  server.tool(
    'skill_list',
    [
      'List installed SKILL.md skills (Anthropic Skills format) with name + one-line description.',
      'Skills are reusable prompt modules — personas, design systems, domain knowledge, style guides — that the user installed from GitHub.',
      'Call this at the start of a task when you need specialized knowledge (design taste, copywriting voice, domain rules, etc.). If a listed skill looks relevant, follow up with `skill_read(name)` to load the full instructions.',
    ].join('\n'),
    {},
    async () => {
      const skills = listSkills();
      if (skills.length === 0) {
        return textResult('No skills installed. The user can install skills from GitHub via the Skills panel in the dashboard.');
      }
      const lines = skills.map((s) => `- ${s.name}: ${s.frontmatter.description || '(no description)'}`);
      return textResult(`${skills.length} installed skill${skills.length === 1 ? '' : 's'}:\n${lines.join('\n')}\n\nUse skill_read("<name>") to load the full instructions.`);
    },
  );

  server.tool(
    'skill_read',
    [
      'Load the full body of an installed SKILL.md skill into context.',
      'Use after `skill_list()` once you have picked the skill that fits the task. The returned body is the skill\'s actual instructions/persona/rules — treat it as authoritative for the current task.',
    ].join('\n'),
    {
      name: z.string().min(1).max(80).describe('Skill directory name as shown by skill_list (e.g. "taste-skill", "brutalist-skill").'),
    },
    async ({ name }) => {
      const skill = loadSkill(name);
      if (!skill) {
        return textResult(`Skill "${name}" is not installed. Call skill_list() to see what is available.`);
      }
      const head = [
        `# ${skill.frontmatter.name || skill.name}`,
        skill.frontmatter.description ? `\n${skill.frontmatter.description}\n` : '',
      ].filter(Boolean).join('\n');

      // Tell the agent where the skill actually lives so it can run
      // bundled scripts via run_shell_command(cwd=…) instead of
      // hallucinating that "this environment" can't execute the
      // skill's body. Without this, skill bodies that reference
      // "src/aggregate.js" or "scripts/install.sh" stay non-actionable.
      const assets = [
        skill.hasScripts ? 'scripts/' : null,
        skill.hasSrc ? 'src/' : null,
        skill.hasReferences ? 'references/' : null,
      ].filter(Boolean) as string[];
      const entries = listSkillEntries(skill.dir);
      const manifestLines = [
        `Skill location on disk: ${skill.dir}`,
        assets.length > 0
          ? `Bundled assets: ${assets.join(', ')} — invoke with run_shell_command and cwd="${skill.dir}".`
          : 'Bundled assets: none — this skill is pure instructions, no executable helpers.',
        entries.length > 0 ? `Top-level entries: ${entries.join(', ')}` : '',
      ].filter(Boolean).join('\n');

      const crib = renderToolNameCrib(skill);

      return textResult(`${head}\n\n${manifestLines}\n\n${crib}\n\n---\n${skill.body}`);
    },
  );
}
