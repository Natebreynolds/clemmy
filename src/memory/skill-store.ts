import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { BASE_DIR } from '../config.js';

/**
 * SKILL.md skill store.
 *
 * Layout:
 *   ~/.clementine-next/skills/<name>/
 *     SKILL.md              — required; YAML frontmatter + markdown body
 *     scripts/              — optional; deterministic helpers
 *     references/           — optional; supporting docs
 *     .clementine-source.json — install metadata (repo, sha, when)
 *
 * Why a separate directory from `workflows/`:
 *   - Skills are pure knowledge/persona prompts (Anthropic Skills spec).
 *   - Workflows are scheduled multi-step executable definitions.
 *   - Same file format (SKILL.md + frontmatter), different lifecycle:
 *     skills get pulled into the agent's context when relevant;
 *     workflows fire on a cron / manual trigger.
 *   - Keeping them in separate dirs lets the UI present them as
 *     distinct concepts without overloading either panel.
 *
 * Compatible install sources:
 *   - Single-skill repo: SKILL.md at root → installed as <repo-name>
 *   - Bundled repo (taste-skill pattern): skills/<name>/SKILL.md →
 *     each subdir installed as its own skill
 *   - Claude convention: .claude/skills/<name>/SKILL.md → same as bundled
 */

export const SKILLS_DIR = path.join(BASE_DIR, 'skills');
const SOURCE_FILE = '.clementine-source.json';

export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Optional — free-form metadata. */
  [key: string]: unknown;
}

export interface SkillSourceMeta {
  /** Where the skill came from (e.g. "https://github.com/owner/repo"). */
  repo?: string;
  /** Subpath within the repo when the repo bundles multiple skills. */
  pathInRepo?: string;
  /** Git SHA captured at install time. */
  sha?: string;
  /** ISO-8601 timestamp. */
  installedAt?: string;
}

export interface Skill {
  /** Directory name on disk. Matches the URL/install-time identifier. */
  name: string;
  /** Absolute path to the skill's directory. */
  dir: string;
  /** Absolute path to SKILL.md. */
  skillPath: string;
  /** Parsed frontmatter. */
  frontmatter: SkillFrontmatter;
  /** Markdown body (after frontmatter). */
  body: string;
  /** First N chars of body for previews. */
  bodyPreview: string;
  /** Install provenance. Undefined for skills dropped in manually. */
  source?: SkillSourceMeta;
  /** True when scripts/ exists. */
  hasScripts: boolean;
  /** True when references/ exists. */
  hasReferences: boolean;
}

export function ensureSkillsDir(): void {
  if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true });
}

function readSourceMeta(skillDir: string): SkillSourceMeta | undefined {
  const sourcePath = path.join(skillDir, SOURCE_FILE);
  if (!existsSync(sourcePath)) return undefined;
  try {
    return JSON.parse(readFileSync(sourcePath, 'utf-8')) as SkillSourceMeta;
  } catch {
    return undefined;
  }
}

function writeSourceMeta(skillDir: string, meta: SkillSourceMeta): void {
  writeFileSync(path.join(skillDir, SOURCE_FILE), JSON.stringify(meta, null, 2), 'utf-8');
}

function parseSkillFile(skillPath: string, dirName: string): Skill | null {
  if (!existsSync(skillPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(skillPath, 'utf-8');
  } catch {
    return null;
  }
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const fmName = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : dirName;
  const fmDescription = typeof data.description === 'string' ? data.description.trim() : '';

  const dir = path.dirname(skillPath);
  return {
    name: dirName,
    dir,
    skillPath,
    frontmatter: { ...data, name: fmName, description: fmDescription } as SkillFrontmatter,
    body: parsed.content,
    bodyPreview: parsed.content.replace(/\s+/g, ' ').trim().slice(0, 240),
    source: readSourceMeta(dir),
    hasScripts: existsSync(path.join(dir, 'scripts')),
    hasReferences: existsSync(path.join(dir, 'references')),
  };
}

/**
 * List all installed skills. Returns empty array when the dir doesn't
 * exist yet (first install creates it).
 */
export function listSkills(): Skill[] {
  if (!existsSync(SKILLS_DIR)) return [];
  let entries: string[];
  try {
    entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const dirName of entries) {
    const skill = loadSkill(dirName);
    if (skill) skills.push(skill);
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkill(name: string): Skill | null {
  if (!isSafeSkillName(name)) return null;
  const skillPath = path.join(SKILLS_DIR, name, 'SKILL.md');
  return parseSkillFile(skillPath, name);
}

export function isSafeSkillName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 80) return false;
  // No path separators, no leading dots, no whitespace.
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(name)) return false;
  if (name === '.' || name === '..') return false;
  return true;
}

/**
 * Scan a cloned repo and return every skill directory found inside.
 * Returns the directory containing SKILL.md, plus a suggested install
 * name. The caller decides what to do with conflicts.
 *
 * Supported layouts (matches taste-skill, Anthropic Skills spec,
 * Claude convention):
 *   - <repoRoot>/SKILL.md                  → install as <repoBasename>
 *   - <repoRoot>/skills/<name>/SKILL.md    → install each as <name>
 *   - <repoRoot>/.claude/skills/<name>/SKILL.md → same
 */
export function discoverSkillsInRepo(repoRoot: string, fallbackName: string): Array<{
  sourceDir: string;
  installName: string;
  pathInRepo: string;
}> {
  const found: Array<{ sourceDir: string; installName: string; pathInRepo: string }> = [];

  // Layout 1: SKILL.md at the repo root.
  const rootSkill = path.join(repoRoot, 'SKILL.md');
  if (existsSync(rootSkill)) {
    found.push({ sourceDir: repoRoot, installName: fallbackName, pathInRepo: '' });
  }

  // Layout 2 & 3: bundled under skills/ or .claude/skills/.
  for (const subdir of ['skills', '.claude/skills']) {
    const bundleRoot = path.join(repoRoot, subdir);
    if (!existsSync(bundleRoot)) continue;
    let kids: string[] = [];
    try {
      kids = readdirSync(bundleRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const child of kids) {
      const childPath = path.join(bundleRoot, child);
      if (existsSync(path.join(childPath, 'SKILL.md'))) {
        found.push({
          sourceDir: childPath,
          installName: child,
          pathInRepo: path.posix.join(subdir, child),
        });
      }
    }
  }

  return found;
}

function copyDirRecursive(src: string, dst: string): void {
  if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    // Skip noise: VCS metadata, OS junk.
    if (entry.name === '.git' || entry.name === '.DS_Store') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      writeFileSync(d, readFileSync(s));
    } else if (entry.isSymbolicLink()) {
      // Resolve and copy contents; we don't want unresolvable symlinks.
      try {
        const real = statSync(s);
        if (real.isFile()) writeFileSync(d, readFileSync(s));
      } catch {
        // skip broken symlinks
      }
    }
  }
}

/**
 * Install a single discovered skill from `sourceDir` into the skills
 * directory under `installName`. Overwrites an existing same-named
 * skill (uninstall + reinstall is the upgrade path). Records source
 * metadata so the dashboard can show "from <repo>".
 */
export function installSkillFromDir(
  sourceDir: string,
  installName: string,
  source: SkillSourceMeta,
): Skill {
  if (!isSafeSkillName(installName)) {
    throw new Error(`Invalid skill name: ${installName}`);
  }
  if (!existsSync(path.join(sourceDir, 'SKILL.md'))) {
    throw new Error(`Source directory has no SKILL.md: ${sourceDir}`);
  }
  ensureSkillsDir();
  const target = path.join(SKILLS_DIR, installName);
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  copyDirRecursive(sourceDir, target);
  writeSourceMeta(target, {
    ...source,
    installedAt: new Date().toISOString(),
  });
  const skill = loadSkill(installName);
  if (!skill) throw new Error(`Skill installed but failed to load: ${installName}`);
  return skill;
}

export function uninstallSkill(name: string): boolean {
  if (!isSafeSkillName(name)) return false;
  const dir = path.join(SKILLS_DIR, name);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Render the agent-facing index of installed skills. One line per
 * skill: `- name: description`. Used by the orchestrator's context so
 * the agent can decide when to pull a skill body in via `skill_read`.
 *
 * Returns '' when no skills are installed so the prompt isn't bloated
 * with an empty section.
 */
export function renderSkillsIndex(): string {
  const skills = listSkills();
  if (skills.length === 0) return '';
  const lines = skills.map((s) => {
    const desc = s.frontmatter.description || '(no description)';
    return `- \`${s.name}\`: ${desc}`;
  });
  return [
    'Installed skills (call `skill_read("<name>")` to load the full instructions when relevant):',
    ...lines,
  ].join('\n');
}
