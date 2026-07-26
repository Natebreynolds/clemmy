import { readdirSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  latestSkillLearningReceipt,
  listActiveSkills,
  loadSkill,
  skillLearningEvidenceStatus,
  type Skill,
} from '../memory/skill-store.js';
import { checkSkillPreconditions } from '../runtime/capability-preconditions.js';
import { textResult } from './shared.js';

/** Runtime check for the model-facing manual distillation authority. A tool
 * choice alone is not proof that the user asked Clementine to remember a
 * procedure; the latest real user turn must carry that intent. */
export function userRequestedSkillDistillation(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return /\b(?:remember|save|distill|capture|learn)\b[^.!?\n]{0,120}\b(?:this|that|how|procedure|process|workflow|skill|playbook|approach)\b/i.test(normalized)
    || /\b(?:turn|make)\b[^.!?\n]{0,80}\b(?:this|that|it)\b[^.!?\n]{0,80}\b(?:reusable|skill|playbook|procedure|workflow)\b/i.test(normalized)
    || /\b(?:skill|playbook|procedure|workflow)\b[^.!?\n]{0,100}\b(?:remember|save|distill|capture)\b/i.test(normalized);
}

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
      'Skills are reusable procedures or prompt modules — installed by the user or learned from prior work. Evidence labels distinguish trusted automatic recall from legacy drafts.',
      'Call this at the start of a task when you need specialized knowledge (design taste, copywriting voice, domain rules, etc.). If a listed skill looks relevant, follow up with `skill_read(name)` to load the full instructions.',
    ].join('\n'),
    {},
    async () => {
      const skills = listActiveSkills();
      if (skills.length === 0) {
        return textResult('No skills installed. The user can install skills from GitHub via the Skills panel in the dashboard.');
      }
      const lines = skills.map((s) => {
        const evidence = skillLearningEvidenceStatus(s);
        const label = evidence === 'legacy_unverified'
          ? ' [legacy draft — not eligible for automatic recall]'
          : evidence === 'verified'
            ? ' [evidence-backed draft]'
            : '';
        return `- ${s.name}${label}: ${s.frontmatter.description || '(no description)'}`;
      });
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
      // Capability preconditions: if the skill declares `requires:` (mcp:/cli:/
      // secret:) and something is missing, surface a NON-BLOCKING heads-up so the
      // agent diagnoses the gap up front instead of dead-ending mid-task. Skills
      // without `requires` are unaffected; the check is fail-open.
      const pre = checkSkillPreconditions((skill.frontmatter as Record<string, unknown>).requires);
      const notReadyBanner = pre.ready
        ? ''
        : [
            '⚠️ NOT READY — this skill declares prerequisites that are not detected:',
            ...pre.unmet.map((u) => `  • ${u}`),
            'Set these up first (connect the app/MCP in the dashboard, install the CLI, or add the secret), then run the skill. This is a heads-up, not a hard block — if you know they are configured, proceed.',
            '',
          ].join('\n');

      // A self-distilled DRAFT carries a trust banner: its proven tool slugs +
      // arg shapes are reliable (they ran successfully once), but the procedure
      // prose is unreviewed — so use it, but verify outputs.
      const learningEvidence = skillLearningEvidenceStatus(skill);
      const learningReceipt = latestSkillLearningReceipt(skill);
      const draftBanner = learningEvidence === 'legacy_unverified'
        ? [
            '⚠️ UNVERIFIED LEGACY DRAFT — this procedure predates execution learning receipts, so its claimed success cannot be proven.',
            'Do not treat its tool slugs, arguments, or completion claims as established. Use it only when the user explicitly selected it or for inspection, and independently verify every result.',
            '',
          ].join('\n')
        : learningReceipt?.authority === 'manual_user_request'
          ? [
              '📝 USER-REQUESTED DRAFT — the user explicitly asked Clementine to preserve this procedure, but that request is not independent execution proof.',
              'Treat the sequence and prose as unreviewed and verify every output.',
              '',
            ].join('\n')
          : skill.frontmatter.tier === 'draft'
            ? [
                '🧪 DRAFT SKILL — self-distilled from a prior successful run'
                  + (skill.frontmatter.origin?.distilledAt ? ` on ${String(skill.frontmatter.origin.distilledAt).slice(0, 10)}` : '')
                  + '. The tool slugs and argument shapes below were PROVEN in that run; the procedure text is UNREVIEWED. Follow it, but verify the outputs.',
                '',
              ].join('\n')
            : '';

      const head = [
        notReadyBanner,
        draftBanner,
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

      // Execution contract (global, generic — reads no skill-specific code).
      // An installed skill is an authoritative PROCEDURE to run, not reference
      // material to skim and cherry-pick. Without this framing the model treats
      // skill_read as "study material" and skips prescribed steps (observed:
      // read a redesign skill, then shipped without generating the imagery the
      // skill calls for). The body below stays authoritative; this only frames
      // intent. Applies in chat, workers, AND workflow steps because they all
      // call this one tool.
      const executionContract = [
        '=== HOW TO RUN THIS SKILL ===',
        'This skill is a PROCEDURE to EXECUTE, not reference material to summarize or cherry-pick.',
        'Carry out every step in the body below, in order, using your tools:',
        '- Do all steps and phases; do not condense or skip any. If the skill names a step (generate images, run a script, fetch a reference), actually do it.',
        '- Produce every deliverable the body specifies (the file, image, URL, message, or record) — not a description of it.',
        '- You are done with this skill only when each deliverable it prescribes actually exists.',
        '- If you deliberately skip a prescribed step, say so explicitly and why — do not silently drop it.',
      ].join('\n');

      return textResult(`${head}\n\n${manifestLines}\n\n${crib}\n\n${executionContract}\n\n---\n${skill.body}`);
    },
  );

  // Manual distillation front door ("remember how to do this"). Skips the
  // novelty gate — the user explicitly asked — and distills the CURRENT
  // session's tool trace into a reusable draft skill.
  server.tool(
    'skill_distill',
    [
      'Distill the work you just did in THIS conversation into a reusable DRAFT skill, so the capability compounds and you do not have to re-figure it out next time.',
      'Use only when the user explicitly says "remember how to do this", "save this as a skill/playbook", or otherwise directly asks you to preserve the procedure.',
      'Do not call this autonomously after ordinary work; verified automatic learning is handled by the runtime.',
      'Captures the proven tool sequence + argument shapes; writes a draft skill the user can approve from the Skills panel.',
    ].join('\n'),
    {
      objective: z.string().min(4).max(300).describe('One line: what capability this skill captures (e.g. "audit a law firm site and write the SEO brief").'),
    },
    async ({ objective }) => {
      const { harnessRunContextStorage } = await import('../runtime/harness/brackets.js');
      const sessionId = harnessRunContextStorage.getStore()?.sessionId;
      if (!sessionId) {
        return textResult('I can only distill a skill from inside an active conversation with a recorded tool trace.');
      }
      const { listEvents } = await import('../runtime/harness/eventlog.js');
      const latestUserText = listEvents(sessionId, {
        types: ['user_input_received'],
        desc: true,
        limit: 20,
      }).find((event) => event.role === 'user' && typeof event.data.text === 'string')
        ?.data.text as string | undefined;
      if (!latestUserText || !userRequestedSkillDistillation(latestUserText)) {
        return textResult(
          'I did not distill a skill because the latest user message did not explicitly ask me to preserve this procedure. Verified automatic learning is handled by the runtime after a clean execution.',
        );
      }
      const { evaluateLearningCandidate } = await import('../memory/learning-receipt.js');
      const learningReceipt = evaluateLearningCandidate({
        target: 'skill',
        authority: 'manual_user_request',
        sessionId,
        sourceId: sessionId,
        terminalSuccess: true,
        explicitUserRequest: true,
      }).receipt;
      if (!learningReceipt) {
        return textResult('I could not establish explicit user authority to distill this procedure.');
      }
      const { distillSkillFromSession } = await import('../memory/skill-distiller.js');
      const result = await distillSkillFromSession(sessionId, {
        objective,
        origin: { kind: 'manual', sourceId: sessionId },
        learningReceipt,
        force: true,
      });
      switch (result.status) {
        case 'written':
          return textResult(`Distilled a draft skill: \`${result.name}\`. It's usable now (marked draft) — the user can approve or discard it from the Skills panel.`);
        case 'skipped_duplicate':
          return textResult(`This already matches an existing skill (\`${result.name}\`), so I didn't create a duplicate.`);
        case 'skipped_disabled':
          return textResult('Skill distillation is turned off (CLEMMY_GOAL_CONTRACT=off).');
        default:
          return textResult(`I couldn't distill a skill from this session (${result.detail ?? result.status}).`);
      }
    },
  );
}
