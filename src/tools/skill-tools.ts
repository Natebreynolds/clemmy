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
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { issueManualSkillDraftRequestReceipt } from '../memory/learning-receipt.js';
import { captureManualSkillDistillAuthority, userDeclinedSkillDistillation } from './manual-skill-distill-authority.js';

/** Runtime check for the model-facing manual distillation authority. A tool
 * choice alone is not proof that the user asked Clementine to remember a
 * procedure; the exact accepted human source must carry that intent. */
export function userRequestedSkillDistillation(text: string): boolean {
  if (userDeclinedSkillDistillation(text)) return false;
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

/** Large enough for the largest built-in skill with its tool signatures. */
const SKILL_READ_MAX_CHARS = 60_000;

/** The tools a skill declares in its frontmatter (`tools:`), with their exact
 *  argument schemas, so the model can call them without searching. */
async function renderSkillToolContracts(declared: unknown): Promise<string> {
  const names = Array.isArray(declared)
    ? declared.filter((name): name is string => typeof name === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(name)).slice(0, 12)
    : [];
  if (names.length === 0) return '';
  let result: Awaited<ReturnType<typeof import('./tool-search-tool.js')['skillToolContracts']>>;
  try {
    const { skillToolContracts } = await import('./tool-search-tool.js');
    result = await skillToolContracts(names);
  } catch {
    return '';
  }
  if (result.contracts.length === 0) return '';
  return [
    '=== TOOLS THIS SKILL USES ===',
    'Call each by its exact name with these arguments (? marks optional); these need no tool_search. An argument shown as object takes a JSON object, never JSON text, including inside args_json. A rejected call returns the exact problem to fix.',
    ...result.contracts.map((tool) => `- ${tool.signature}${tool.summary ? `\n  ${tool.summary}` : ''}`),
    ...(result.overflow.length ? [`Also used, schema not shown (use tool_search for it): ${result.overflow.join(', ')}`] : []),
  ].join('\n');
}

export function registerSkillTools(server: McpServer): void {
  server.tool(
    'skill_list',
    [
      'List installed SKILL.md skills (Anthropic Skills format) with name + one-line description.',
      'Skills are reusable procedures or prompt modules — installed by the user or learned from prior work. Evidence labels distinguish trusted automatic recall from legacy drafts.',
      'Use when a specialized procedure is needed and its installed name is unknown or supplied candidates do not fit. An exact supplied skill name can go directly to `skill_read(name)` without listing. Unrelated candidates require no skill call.',
    ].join('\n'),
    {},
    async () => {
      const skills = listActiveSkills();
      if (skills.length === 0) {
        return textResult('No skills installed. The user can install skills from GitHub via the Skills panel in the dashboard.');
      }
      const lines = skills.map((s) => {
        const evidence = skillLearningEvidenceStatus(s);
        const manualDraft = s.frontmatter.tier === 'draft' && latestSkillLearningReceipt(s)?.authority === 'manual_user_request';
        const label = evidence === 'legacy_unverified'
          ? ' [legacy draft — not eligible for automatic recall]'
          : manualDraft
            ? ' [user-requested draft — unreviewed]'
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
      'Read directly by an exact installed name, including one supplied by the user or current candidate list; `skill_list()` is not a prerequisite. Reuse a complete host-supplied body or this task\'s exact retained procedure/version when already available; a description is not the full instructions. After compaction, recover the exact retained requirements rather than silently selecting different disk bytes. Read the current version when the task requires it. Apply the body within the accepted task and selected framework; reading does not authorize extra work.',
    ].join('\n'),
    {
      name: z.string().min(1).max(80).describe('Exact installed skill directory name, supplied by the user or current candidates; use skill_list only when unknown.'),
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
        : skill.frontmatter.tier === 'draft' && learningReceipt?.authority === 'manual_user_request'
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
      const toolContracts = await renderSkillToolContracts((skill.frontmatter as Record<string, unknown>).tools);

      // Loading a reference is not a separate execution contract. The owner
      // may be planning, inspecting, comparing, or applying only a scoped part.
      const executionContract = [
        '=== APPLYING THIS SKILL REFERENCE ===',
        'Use the full body below within the effective accepted task and the user’s instructions.',
        'Reading this skill does not itself commit you to every step or authorize its deliverables.',
        'For planning, inspection or comparison, investigate the relevant procedure without executing business changes.',
        'When the accepted task adopts this framework, carry out its applicable requirements and verify the requested deliverables. Do not silently skip a required step.',
        'Prior or unrelated references do not add work; explain a material conflict or ambiguity through the ordinary conversation.',
      ].join('\n');

      // A skill is read whole, with its tools after the body. Its later
      // sections (verify, edit safely) matter most at the end of the work, and
      // skill_read has no offset to page the rest: live 2026-10-17 the
      // workspace-builder read was clipped at the 20,000-character default and
      // its verify and phone sections never reached the model.
      return textResult(
        `${head}\n\n${manifestLines}\n\n${crib}\n\n${executionContract}\n\n---\n${skill.body}${toolContracts ? `\n\n${toolContracts}` : ''}`,
        { maxChars: SKILL_READ_MAX_CHARS },
      );
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
      'Captures the observed tool sequence and argument shapes as an unreviewed draft the user can review from the Skills panel.',
    ].join('\n'),
    {
      objective: z.string().min(4).max(300).describe('One line: what capability this skill captures (e.g. "audit a law firm site and write the SEO brief").'),
    },
    async ({ objective }) => {
      const authority = captureManualSkillDistillAuthority(harnessRunContextStorage.getStore(), userRequestedSkillDistillation);
      if (!authority) {
        return textResult(
          'I did not distill a skill because I could not verify an explicit preservation request for this active run. No draft was changed; verified automatic learning remains separate.',
        );
      }
      const { sessionId } = authority;
      const learningReceipt = issueManualSkillDraftRequestReceipt({
        sessionId,
        sourceId: authority.consentEventId,
        explicitUserRequest: true,
      });
      if (!learningReceipt) {
        return textResult('I could not establish explicit user authority to distill this procedure.');
      }
      const { distillSkillFromSession } = await import('../memory/skill-distiller.js');
      const result = await distillSkillFromSession(sessionId, {
        objective,
        origin: { kind: 'manual', sourceId: authority.consentEventId },
        learningReceipt,
        force: true,
        throughSeq: authority.throughSeq,
        traceSnapshot: authority.traceSnapshot,
        currentAuthority: authority.currentAuthority,
        abortSignal: authority.abortSignal,
      });
      switch (result.status) {
        case 'written':
          return textResult(`Saved the requested draft skill: \`${result.name}\`. Its procedure is unreviewed; review or discard it from the Skills panel.`);
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
