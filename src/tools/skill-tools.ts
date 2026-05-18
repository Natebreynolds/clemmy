import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listSkills, loadSkill } from '../memory/skill-store.js';
import { textResult } from './shared.js';

/**
 * Skill discovery tools — agent-facing surface for installed SKILL.md
 * skills (Anthropic Skills format).
 *
 * The pattern mirrors `composio_search_tools` / `composio_execute_tool`:
 *
 *   1. `skill_list()` — what skills are installed, with descriptions
 *   2. `skill_read(name)` — pull the full SKILL.md body into context
 *
 * Skills are not auto-injected into every system prompt (that would
 * bloat context for users with many installed). The agent reads
 * skill_list once at the start of a task, picks the most relevant
 * skill(s) by description, and pulls them in with skill_read.
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
      return textResult(`${head}\n\n---\n${skill.body}`);
    },
  );
}
