import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import matter from 'gray-matter';
import { BASE_DIR, getRuntimeEnv } from '../config.js';

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

export interface SkillOrigin {
  kind: 'chat' | 'workflow' | 'manual';
  sourceId?: string;
  distilledAt?: string;
}

/** Audit trail retained on the canonical draft when equivalent drafts are
 * superseded. The source files remain on disk too; this compact copy makes the
 * merged provenance visible without having to know the old aliases. */
export interface SkillLineageEntry {
  skillName: string;
  description: string;
  origin?: SkillOrigin;
  useCount: number;
  failureCount: number;
  capabilityFingerprint?: string;
  mergedAt: string;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  /**
   * Capability compounding (C1): a self-distilled skill starts in the `draft`
   * tier (usable, but unproven) and is promoted to `approved` by user blessing
   * or repeated validated success. Absent ⇒ `approved` (every installed skill
   * is untouched).
   */
  tier?: 'draft' | 'approved';
  /** Where a distilled draft came from + when. */
  origin?: SkillOrigin;
  /** Stable, task-semantic identity for a self-distilled capability. Names,
   * descriptions, and providers may change without changing this identity. */
  capabilityFingerprint?: string;
  /** Every chat goal / workflow run / manual session observed for this same
   * capability. This is lineage evidence, not a validated-use counter. */
  capabilityOrigins?: SkillOrigin[];
  /** Non-destructive duplicate reconciliation. Superseded aliases remain on
   * disk, but are omitted from active skill discovery. */
  supersededBy?: string;
  supersededAt?: string;
  disabled?: boolean;
  /** Provenance copied from drafts folded into this canonical skill. */
  lineage?: SkillLineageEntry[];
  /** Times this draft was read into a session that then validated success. */
  useCount?: number;
  /** Times this draft was implicated in a judged failure. */
  failureCount?: number;
  /** A draft that failed too often — hidden from the index, kept on disk. */
  quarantined?: boolean;
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
  // ── Update-check state (written by recordSkillUpdateCheck) ──────
  // These are refreshed by the daily poll / manual "check for updates"
  // and read by the dashboard to render an "update available" badge.
  // They are intentionally NOT part of the install payload — a fresh
  // install/update writes only {repo, pathInRepo, sha, installedAt},
  // which clears any stale update flag.
  /** Remote default-branch HEAD SHA observed at the last check. */
  latestRemoteSha?: string;
  /** True when latestRemoteSha differs from the installed sha. */
  updateAvailable?: boolean;
  /** ISO-8601 timestamp of the last successful remote check. */
  lastCheckedAt?: string;
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
  /** True when src/ exists. Many skills package executable helpers under src/. */
  hasSrc: boolean;
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
    hasSrc: existsSync(path.join(dir, 'src')),
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
    const skill = loadSkill(dirName, { raw: true });
    if (skill) skills.push(skill);
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Active catalog used by agent discovery/retrieval. `listSkills()` deliberately
 * remains the complete management/audit view for backwards compatibility. */
export function listActiveSkills(): Skill[] {
  return listSkills().filter((skill) => !skill.frontmatter.supersededBy && !skill.frontmatter.disabled);
}

/** Load a skill for execution. A stale superseded name resolves to its canonical
 * replacement, so an old workflow cannot execute the retired alias body. Pass
 * `{raw:true}` only for maintenance/audit code that needs the alias itself. */
export function loadSkill(name: string, options: { raw?: boolean } = {}): Skill | null {
  if (!isSafeSkillName(name)) return null;
  let currentName = name;
  const seen = new Set<string>();
  while (true) {
    if (!isSafeSkillName(currentName) || seen.has(currentName)) return null;
    seen.add(currentName);
    const skillPath = path.join(SKILLS_DIR, currentName, 'SKILL.md');
    const skill = parseSkillFile(skillPath, currentName);
    if (!skill || options.raw || !skill.frontmatter.supersededBy) return skill;
    currentName = skill.frontmatter.supersededBy;
  }
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
 * Persist the result of a remote update check into the skill's
 * `.clementine-source.json`. Merges into the existing metadata so the
 * install provenance (repo/pathInRepo/sha/installedAt) is preserved.
 *
 * No-op when the skill has no source file (a manually dropped-in skill
 * with no upstream to check) or the name is unsafe — there's nothing to
 * update against in those cases.
 */
export function recordSkillUpdateCheck(
  name: string,
  patch: { latestRemoteSha?: string; updateAvailable?: boolean; lastCheckedAt: string },
): void {
  if (!isSafeSkillName(name)) return;
  const dir = path.join(SKILLS_DIR, name);
  const existing = readSourceMeta(dir);
  if (!existing) return;
  // Always stamp lastCheckedAt. But only overwrite the update verdict
  // when we actually resolved a remote SHA — an unreachable remote
  // (offline, rate-limited, private w/o gh auth) is "unknown", NOT "up
  // to date". Clobbering a previously-detected update to false on a
  // transient failure would silently drop the user's UPDATE badge.
  const next: SkillSourceMeta = { ...existing, lastCheckedAt: patch.lastCheckedAt };
  if (patch.latestRemoteSha !== undefined) {
    next.latestRemoteSha = patch.latestRemoteSha;
    next.updateAvailable = patch.updateAvailable ?? false;
  }
  writeSourceMeta(dir, next);
}

/**
 * Render the agent-facing index of installed skills. One line per
 * skill: `- name: description`. Used by the orchestrator's context so
 * the agent can decide when to pull a skill body in via `skill_read`.
 *
 * Returns '' when no skills are installed so the prompt isn't bloated
 * with an empty section.
 */
/** Format one skill's index line, appending its applicability (Lane D P2/P3) when
 *  present — "best for <families>; over <slots>" — so the model can judge a
 *  procedure's relevance to the live task WITHOUT a speculative deterministic
 *  filter (NL objective → toolkit family is too fuzzy to gate on). Pure. */
export function formatSkillLine(
  name: string,
  description: string,
  applicability?: { toolFamilies?: string[]; entitySlots?: string[] } | null,
): string {
  const base = `- \`${name}\`: ${description || '(no description)'}`;
  const fams = applicability?.toolFamilies ?? [];
  const slots = applicability?.entitySlots ?? [];
  if (fams.length === 0 && slots.length === 0) return base;
  const bits: string[] = [];
  if (fams.length > 0) bits.push(`best for ${fams.join(', ')}`);
  if (slots.length > 0) bits.push(`over ${slots.map((s) => `{{${s}}}`).join('/')}`);
  return `${base} — ${bits.join('; ')}`;
}

// Persistent-context skills index cap (roadmap #9, bound the context block). The
// index is injected EVERY turn; an install with dozens of skills makes it an
// unbounded token sink. Cap the listed lines and append a discovery pointer —
// every omitted skill stays reachable via the always-available skill_list() tool,
// so nothing is hidden, only deferred. CLEMMY_SKILLS_INDEX_MAX tunes it; 0 ⇒
// uncapped. A normal install (< the cap) is byte-identical to the prior output.
const SKILLS_INDEX_DEFAULT_MAX = 40;
function skillsIndexMax(): number {
  const raw = (getRuntimeEnv('CLEMMY_SKILLS_INDEX_MAX', String(SKILLS_INDEX_DEFAULT_MAX)) ?? '').trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return SKILLS_INDEX_DEFAULT_MAX;
  return n; // 0 ⇒ uncapped
}

/** Cap a list of rendered skill lines to `max`, appending a pointer to the
 *  remainder when truncated so the omitted skills stay reachable via skill_list().
 *  max <= 0 (or list within the cap) ⇒ the list is returned unchanged. */
export function capSkillLines(lines: string[], max: number, kind: string): string[] {
  if (max <= 0 || lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept.push(`  - …and ${lines.length - max} more ${kind} — call skill_list() to see the full set.`);
  return kept;
}

export function renderSkillsIndex(): string {
  const skills = listActiveSkills();
  if (skills.length === 0) return '';
  // Quarantined drafts vanish from the index (kept on disk for the dashboard).
  const visible = skills.filter((s) => !s.frontmatter.quarantined);
  const approved = visible.filter((s) => (s.frontmatter.tier ?? 'approved') !== 'draft');
  const drafts = visible.filter((s) => s.frontmatter.tier === 'draft');
  const line = (s: Skill) => formatSkillLine(
    s.name,
    s.frontmatter.description || '(no description)',
    s.frontmatter.applicability as { toolFamilies?: string[]; entitySlots?: string[] } | undefined,
  );
  const max = skillsIndexMax();
  const out: string[] = [];
  if (approved.length > 0) {
    out.push('Installed skills (call `skill_read("<name>")` to load the full instructions when relevant):');
    out.push(...capSkillLines(approved.map(line), max, 'installed skills'));
  }
  if (drafts.length > 0) {
    out.push('');
    out.push('Draft skills (self-distilled from past successful runs — usable, but verify outputs; their tool slugs/args were PROVEN, the procedure text is unreviewed):');
    out.push(...capSkillLines(drafts.map(line), max, 'draft skills'));
  }
  out.push(`Skills live on disk under ${SKILLS_DIR}/<name>/. Skills that bundle scripts/, src/, or references/ can be executed via run_shell_command with cwd set to the skill directory.`);
  return out.join('\n');
}

/** Stable prompt contract. This deliberately contains no installed names,
 * descriptions, counts, or paths: changing the skill library must not bust the
 * cacheable system prefix, and a large library must not tax every turn. */
export function renderSkillDiscoveryPrompt(): string {
  return 'Specialized skills are available on demand. When the request names a skill or needs a specialized procedure, style, audit, document, sheet, slide, PDF, or site workflow, use `skill_list()` to search installed names/descriptions, then `skill_read("<name>")` for the best match before creating the deliverable. If no match fits, continue normally.';
}

export interface RelevantSkillMatch {
  skill: Skill;
  score: number;
  matchedTerms: string[];
}

export interface RelevantSkillOptions {
  maxSkills?: number;
  maxChars?: number;
}

export const RELEVANT_SKILLS_DEFAULT_MAX = 3;
export const RELEVANT_SKILLS_DEFAULT_MAX_CHARS = 900;

const SKILL_QUERY_STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'analyze', 'and', 'are', 'before', 'build', 'can',
  'create', 'do', 'draft', 'for', 'from', 'generate', 'help', 'how', 'into', 'make',
  'need', 'our', 'please', 'prepare', 'pull', 'read', 'report', 'review', 'run',
  'search', 'send', 'summarize', 'the', 'this', 'to', 'update', 'use', 'want',
  'with', 'would', 'write', 'you',
]);

const SKILL_ARTIFACT_TERMS = new Set([
  'document', 'spreadsheet', 'presentation', 'website', 'pdf', 'image', 'email',
]);

const SKILL_TOKEN_ALIASES: Record<string, string> = {
  doc: 'document', docs: 'document', document: 'document', documents: 'document',
  docx: 'document', gdoc: 'document', googledoc: 'document', googledocs: 'document',
  sheet: 'spreadsheet', sheets: 'spreadsheet', spreadsheet: 'spreadsheet', spreadsheets: 'spreadsheet', excel: 'spreadsheet',
  slide: 'presentation', slides: 'presentation', deck: 'presentation', decks: 'presentation', presentation: 'presentation', presentations: 'presentation', powerpoint: 'presentation',
  site: 'website', sites: 'website', webpage: 'website', webpages: 'website', website: 'website', websites: 'website',
  pdfs: 'pdf', pics: 'image', picture: 'image', pictures: 'image', photo: 'image', photos: 'image', images: 'image',
  email: 'email', emails: 'email', mail: 'email',
};

function skillSearchTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => !SKILL_QUERY_STOPWORDS.has(token))
    .map((token) => SKILL_TOKEN_ALIASES[token]
      ?? (token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token))
    .filter((token) => token.length >= 3 || token === 'ui')
    .filter((token) => !SKILL_QUERY_STOPWORDS.has(token));
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function relevantSkillLimits(options?: RelevantSkillOptions): Required<RelevantSkillOptions> {
  return {
    maxSkills: boundedInt(
      options?.maxSkills === undefined
        ? getRuntimeEnv('CLEMMY_RELEVANT_SKILLS_MAX', String(RELEVANT_SKILLS_DEFAULT_MAX))
        : String(options.maxSkills),
      RELEVANT_SKILLS_DEFAULT_MAX,
      1,
      8,
    ),
    maxChars: boundedInt(
      options?.maxChars === undefined
        ? getRuntimeEnv('CLEMMY_RELEVANT_SKILLS_MAX_CHARS', String(RELEVANT_SKILLS_DEFAULT_MAX_CHARS))
        : String(options.maxChars),
      RELEVANT_SKILLS_DEFAULT_MAX_CHARS,
      320,
      4_000,
    ),
  };
}

/** Lexical, local, deterministic skill retrieval. Names are strongest,
 * applicability metadata is next, and description terms provide recall. Write
 * verbs and generic task words are ignored so "create a thing" does not surface
 * every installed skill. */
export function findRelevantSkills(query: string, options?: RelevantSkillOptions): RelevantSkillMatch[] {
  const q = query.replace(/\s+/g, ' ').trim().toLowerCase();
  const queryTerms = [...new Set(skillSearchTokens(q))];
  const queryArtifactTerms = queryTerms.filter((term) => SKILL_ARTIFACT_TERMS.has(term));
  if (!q || queryTerms.length === 0) return [];

  const matches: RelevantSkillMatch[] = [];
  for (const skill of listActiveSkills()) {
    if (skill.frontmatter.quarantined) continue;
    const nameTerms = new Set(skillSearchTokens(`${skill.name} ${skill.frontmatter.name ?? ''}`));
    const descriptionTerms = new Set(skillSearchTokens(skill.frontmatter.description ?? ''));
    const applicability = skill.frontmatter.applicability as { toolFamilies?: unknown; entitySlots?: unknown } | undefined;
    const applicabilityText = [
      ...(Array.isArray(applicability?.toolFamilies) ? applicability.toolFamilies : []),
      ...(Array.isArray(applicability?.entitySlots) ? applicability.entitySlots : []),
    ].filter((value): value is string => typeof value === 'string').join(' ');
    const applicabilityTerms = new Set(skillSearchTokens(applicabilityText));
    const normalizedName = skillSearchTokens(skill.name).join(' ');
    const exactNameMatch = Boolean(normalizedName && q.includes(normalizedName));
    const skillTerms = new Set([...nameTerms, ...descriptionTerms, ...applicabilityTerms]);
    const skillArtifactTerms = [...skillTerms].filter((term) => SKILL_ARTIFACT_TERMS.has(term));
    // An explicit artifact request must not surface a procedure for a different
    // artifact merely because both descriptions say "Google" or "firm". Skills
    // with no declared artifact remain eligible as domain-specific helpers.
    if (!exactNameMatch
      && queryArtifactTerms.length > 0
      && skillArtifactTerms.length > 0
      && !queryArtifactTerms.some((term) => skillArtifactTerms.includes(term))) continue;

    let score = exactNameMatch ? 100 : 0;
    const matchedTerms: string[] = [];
    for (const term of queryTerms) {
      let matched = false;
      if (nameTerms.has(term)) { score += 12; matched = true; }
      if (applicabilityTerms.has(term)) { score += 7; matched = true; }
      if (descriptionTerms.has(term)) { score += 4; matched = true; }
      if (matched) matchedTerms.push(term);
    }
    const uniqueMatches = [...new Set(matchedTerms)];
    // One generic overlap is too weak for prompt injection (for example, every
    // mail workflow matching "send an email"). Explicit skill names bypass this
    // precision floor; otherwise require two independent lexical signals.
    if (exactNameMatch || (score >= 8 && uniqueMatches.length >= 2)) {
      matches.push({ skill, score, matchedTerms: uniqueMatches });
    }
  }

  const { maxSkills } = relevantSkillLimits(options);
  const ranked = matches.sort((a, b) => b.score - a.score
    || Number(a.skill.frontmatter.tier === 'draft') - Number(b.skill.frontmatter.tier === 'draft')
    || a.skill.name.localeCompare(b.skill.name));
  const relativeFloor = Math.max(8, (ranked[0]?.score ?? 0) * 0.5);
  return ranked
    // Do not fill the bounded menu with weak same-artifact neighbors merely
    // because capacity remains. A result must be competitive with the best hit.
    .filter((match) => match.score >= relativeFloor)
    .slice(0, maxSkills);
}

function clipSkillDescription(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim() || '(no description)';
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/** Bounded per-turn menu containing only query-relevant summaries. Full bodies
 * remain behind skill_read; the complete catalog remains behind skill_list. */
export function renderRelevantSkillsForPrompt(query: string, options?: RelevantSkillOptions): string {
  const limits = relevantSkillLimits(options);
  const matches = findRelevantSkills(query, limits);
  if (matches.length === 0) return '';

  const header = 'Likely installed skill matches for this request:';
  const footer = 'Load the best match with `skill_read("<name>")` before creating the deliverable. If these do not fit, call `skill_list()` to search the complete catalog.';
  // Reserve both complete discovery instructions first. Skill summaries consume
  // only the remaining space, so hard clipping can never sever skill_list/read.
  const fixedChars = header.length + footer.length + 2;
  const lines: string[] = [];
  let used = 0;
  for (const match of matches) {
    const applicability = match.skill.frontmatter.applicability as { toolFamilies?: string[]; entitySlots?: string[] } | undefined;
    const line = formatSkillLine(
      match.skill.name,
      clipSkillDescription(match.skill.frontmatter.description ?? ''),
      applicability ? {
        toolFamilies: (applicability.toolFamilies ?? []).slice(0, 3),
        entitySlots: (applicability.entitySlots ?? []).slice(0, 3),
      } : undefined,
    ) + (match.skill.frontmatter.tier === 'draft' ? ' [draft — verify output]' : '');
    const remaining = limits.maxChars - fixedChars - used - lines.length;
    if (remaining <= 8) break;
    lines.push(line.length <= remaining ? line : `${line.slice(0, remaining - 1)}…`);
    used += Math.min(line.length, remaining);
  }
  return [header, ...lines, footer].join('\n');
}

// ─── Capability compounding: distilled draft skills (C1) ─────────────────────

const CAPABILITY_FINGERPRINT_PREFIX = 'cap-v1:';

/** Phrase aliases are intentionally provider-agnostic. They normalize common
 * ways of stating a task, while leaving provider/product nouns in the token set
 * so two unrelated capabilities that use similar verbs do not collapse. */
const CAPABILITY_PHRASE_ALIASES: Array<[RegExp, string]> = [
  [/\bsearch engine optimi[sz]ation\b/g, ' seo '],
  [/\bcustomer relationship management\b/g, ' crm '],
  [/\b(?:law|legal) (?:firms?|practices?)\b/g, ' lawfirm '],
  [/\bgoogle sheets?\b/g, ' googlesheet '],
  [/\bweb[ -]?sites?\b/g, ' website '],
  [/\be[ -]?mails?\b/g, ' email '],
];

const CAPABILITY_STOPWORDS = new Set([
  'a', 'an', 'and', 'after', 'at', 'automatically', 'before', 'by', 'capability',
  'daily', 'do', 'every', 'for', 'from', 'how', 'in', 'into', 'morning', 'of',
  'on', 'please', 'procedure', 'reusable', 'scheduled', 'skill', 'task', 'the',
  'then', 'this', 'to', 'use', 'using', 'via', 'weekday', 'weekly', 'with',
  'workflow', 'would',
]);

const CAPABILITY_TOKEN_ALIASES: Record<string, string> = {
  analyse: 'audit', analyze: 'audit', analyzed: 'audit', analyzing: 'audit',
  audit: 'audit', audited: 'audit', auditing: 'audit', assess: 'audit', assessed: 'audit',
  evaluate: 'audit', evaluated: 'audit', inspect: 'audit', inspected: 'audit',
  review: 'audit', reviewed: 'audit', reviewing: 'audit',
  build: 'create', built: 'create', create: 'create', created: 'create', creating: 'create',
  draft: 'create', drafted: 'create', generate: 'create', generated: 'create', make: 'create',
  made: 'create', prepare: 'create', prepared: 'create', produce: 'create', produced: 'create',
  write: 'create', wrote: 'create', written: 'create',
  brief: 'report', briefs: 'report', digest: 'report', digests: 'report', report: 'report',
  reports: 'report', summarize: 'report', summarized: 'report', summarise: 'report',
  summary: 'report', summaries: 'report', synthesize: 'report', synthesise: 'report',
  collect: 'fetch', collected: 'fetch', crawl: 'fetch', crawled: 'fetch', fetch: 'fetch',
  fetched: 'fetch', gather: 'fetch', gathered: 'fetch', pull: 'fetch', pulled: 'fetch',
  retrieve: 'fetch', retrieved: 'fetch', scrape: 'fetch', scraped: 'fetch',
  deploy: 'publish', deployed: 'publish', host: 'publish', hosted: 'publish',
  publish: 'publish', published: 'publish', release: 'publish', released: 'publish',
  delete: 'delete', deleted: 'delete', destroy: 'delete', destroyed: 'delete',
  remove: 'delete', removed: 'delete',
  edit: 'update', edited: 'update', modify: 'update', modified: 'update', refresh: 'update',
  refreshed: 'update', sync: 'update', synced: 'update', update: 'update', updated: 'update',
  mails: 'email', site: 'website', sites: 'website', webpage: 'website', webpages: 'website', websites: 'website',
};

const CAPABILITY_ACTION_TOKENS = new Set([
  'audit', 'copy', 'create', 'delete', 'fetch', 'move', 'publish', 'report', 'send',
  'transfer', 'update',
]);

function explicitCapabilityAction(word: string): string | null {
  const token = canonicalCapabilityToken(word);
  if (!CAPABILITY_ACTION_TOKENS.has(token)) return null;
  // report/brief/summary are commonly artifact nouns. Only their unambiguous
  // verb forms establish execution order; they remain ordinary semantic tokens.
  if (token === 'report' && !/^(?:summari[sz]e[sd]?|synthesi[sz]e[sd]?)$/.test(word)) return null;
  return token;
}

function singularCapabilityToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('s') && !/(?:ss|us|is|ous)$/.test(token)) return token.slice(0, -1);
  return token;
}

function canonicalCapabilityToken(token: string): string {
  const lowered = token.toLowerCase();
  return CAPABILITY_TOKEN_ALIASES[lowered]
    ?? CAPABILITY_TOKEN_ALIASES[singularCapabilityToken(lowered)]
    ?? singularCapabilityToken(lowered);
}

function normalizedCapabilityWords(task: string): string[] {
  let normalized = task
    .normalize('NFKD')
    .replace(/[’]/g, "'")
    .replace(/'s\b/g, '')
    .toLowerCase();
  for (const [pattern, replacement] of CAPABILITY_PHRASE_ALIASES) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized.match(/[a-z0-9]+/g) ?? [];
}

function nextCapabilityTerm(words: string[], start: number): string | null {
  for (let i = start; i < words.length; i += 1) {
    const word = words[i];
    if (word === 'to' || word === 'into' || word === 'from') return null;
    const token = canonicalCapabilityToken(word);
    if (!CAPABILITY_STOPWORDS.has(word) && !CAPABILITY_STOPWORDS.has(token)) return token;
  }
  return null;
}

function previousCapabilityTerm(words: string[], start: number): string | null {
  for (let i = start; i >= 0; i -= 1) {
    const word = words[i];
    if (word === 'to' || word === 'into' || word === 'from') return null;
    const token = canonicalCapabilityToken(word);
    if (!CAPABILITY_STOPWORDS.has(word)
      && !CAPABILITY_STOPWORDS.has(token)
      && !CAPABILITY_ACTION_TOKENS.has(token)) return token;
  }
  return null;
}

/** Deterministic semantic normal form used by capabilityTaskFingerprint. It is
 * deliberately based on task actions + subjects, never on the provider/tool
 * list. Thus rewording is stable, while "publish a Netlify site" and "delete a
 * Netlify site" remain different capabilities despite using the same CLI. */
export function canonicalizeCapabilityTask(task: string): string {
  const words = normalizedCapabilityWords(task ?? '');
  const tokens = new Set<string>();
  const routes = new Set<string>();

  for (const word of words) {
    const token = canonicalCapabilityToken(word);
    if (!token || CAPABILITY_STOPWORDS.has(word) || CAPABILITY_STOPWORDS.has(token)) continue;
    tokens.add(token);
  }

  // Preserve source/destination and result/source roles. Sorting the ordinary
  // token bag makes word order irrelevant; these edges keep reverse operations
  // distinct even when only `from` is present ("event from email" vs reverse).
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] !== 'from') continue;
    const source = nextCapabilityTerm(words, i + 1);
    const destinationMarker = words.findIndex((word, idx) => idx > i && (word === 'to' || word === 'into'));
    const destination = destinationMarker >= 0 ? nextCapabilityTerm(words, destinationMarker + 1) : null;
    if (source && destination) routes.add(`${source}>${destination}`);
    else {
      const result = previousCapabilityTerm(words, i - 1);
      if (result && source) routes.add(`${result}<${source}`);
    }
  }
  const actionPositions = words
    .map((word, index) => ({ action: explicitCapabilityAction(word), index }))
    .filter((entry): entry is { action: string; index: number } => Boolean(entry.action));
  const orderMarkers = words
    .map((word, index) => ({ word, index }))
    .filter((entry) => entry.word === 'before' || entry.word === 'after');
  if (orderMarkers.length > 0) {
    for (const marker of orderMarkers) {
      const left = [...actionPositions].reverse().find((entry) => entry.index < marker.index)?.action;
      const right = actionPositions.find((entry) => entry.index > marker.index)?.action;
      if (left && right) routes.add(marker.word === 'before' ? `action:${left}>${right}` : `action:${right}>${left}`);
    }
  } else {
    for (let i = 1; i < actionPositions.length; i += 1) {
      const previous = actionPositions[i - 1].action;
      const current = actionPositions[i].action;
      if (previous !== current) routes.add(`action:${previous}>${current}`);
    }
  }

  const stableTokens = [...tokens].sort();
  const stableRoutes = [...routes].sort();
  // Keep even very short objectives deterministic rather than falling back to
  // a random/name-derived identity.
  return `tokens:${stableTokens.join(',') || 'unspecified'}|routes:${stableRoutes.join(',')}`;
}

/** Stable task identity persisted in every newly distilled SKILL.md. */
export function capabilityTaskFingerprint(task: string): string {
  return `${CAPABILITY_FINGERPRINT_PREFIX}${createHash('sha256').update(canonicalizeCapabilityTask(task)).digest('hex')}`;
}

function validCapabilityFingerprint(value: string): boolean {
  return new RegExp(`^${CAPABILITY_FINGERPRINT_PREFIX}[a-f0-9]{64}$`).test(value);
}

export interface CapabilitySkillMatch {
  skill: Skill;
  fingerprint: string;
  /** True when an older self-distilled skill matched by its stored description
   * and still needs the new field backfilled. */
  legacy: boolean;
}

/** Find the canonical active skill for a task. New skills match by exact stable
 * fingerprint. Legacy matching is intentionally limited to self-distilled
 * skills (origin/draft metadata) so Clementine never rewrites a user-installed
 * third-party skill merely because its prose happens to look similar. */
export function findDistilledSkillByCapabilityTask(task: string): CapabilitySkillMatch | null {
  const fingerprint = capabilityTaskFingerprint(task);
  const skills = listActiveSkills();
  const exact = skills
    .filter((skill) => skill.frontmatter.capabilityFingerprint === fingerprint)
    .sort((a, b) => Number((b.frontmatter.tier ?? 'approved') === 'approved')
      - Number((a.frontmatter.tier ?? 'approved') === 'approved')
      || (b.frontmatter.useCount ?? 0) - (a.frontmatter.useCount ?? 0)
      || a.name.localeCompare(b.name))[0];
  if (exact) return { skill: exact, fingerprint, legacy: false };

  for (const skill of skills) {
    if (skill.frontmatter.capabilityFingerprint) continue;
    if (!skill.frontmatter.origin && skill.frontmatter.tier !== 'draft') continue;
    const candidates = [skill.frontmatter.description, skill.frontmatter.name, skill.name.replace(/[-_]+/g, ' ')];
    if (candidates.some((candidate) => candidate && capabilityTaskFingerprint(candidate) === fingerprint)) {
      return { skill, fingerprint, legacy: true };
    }
  }
  return null;
}

/** Backfill/claim a legacy skill's capability identity. A conflicting existing
 * identity is never overwritten. */
export function claimSkillCapabilityFingerprint(name: string, fingerprint: string): Skill | null {
  if (!validCapabilityFingerprint(fingerprint)) return null;
  const skill = loadSkill(name);
  if (!skill) return null;
  if (!skill.frontmatter.origin && skill.frontmatter.tier !== 'draft') return null;
  if (skill.frontmatter.capabilityFingerprint
    && skill.frontmatter.capabilityFingerprint !== fingerprint) return null;
  if (skill.frontmatter.capabilityFingerprint === fingerprint) return skill;
  return updateSkillFrontmatter(skill.name, { capabilityFingerprint: fingerprint });
}

export interface DistilledSkillInput {
  name: string;
  description: string;
  body: string;
  origin: Omit<SkillOrigin, 'distilledAt'>;
  /** The accomplished task/objective. Falls back to description for backwards
   * compatibility with older direct callers; agent distillation paths always
   * pass the original objective. */
  capabilityTask?: string;
  /** Lane D Phase 2: machine-checkable applicability — which tool families the
   *  procedure touches + which entity-class slots it is parameterized over. The
   *  retrieval filter surfaces a procedure only when these match the live task. */
  applicability?: { toolFamilies: string[]; entitySlots: string[] };
}

/**
 * Write (or overwrite) a self-distilled DRAFT skill into the same skills dir as
 * installed skills (a second directory was rejected — it would fork listSkills,
 * the dashboard, and skill_read for no benefit). Returns the on-disk name, or
 * null if the name is unsafe.
 */
export function writeDistilledSkill(input: DistilledSkillInput): string | null {
  if (!isSafeSkillName(input.name)) return null;
  ensureSkillsDir();
  const dir = path.join(SKILLS_DIR, input.name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const distilledAt = new Date().toISOString();
  const origin: SkillOrigin = { ...input.origin, distilledAt };
  const frontmatter: SkillFrontmatter = {
    name: input.name,
    description: input.description,
    tier: 'draft',
    origin,
    capabilityFingerprint: capabilityTaskFingerprint(input.capabilityTask ?? input.description),
    capabilityOrigins: [origin],
    useCount: 0,
    failureCount: 0,
    ...(input.applicability ? { applicability: input.applicability } : {}),
  };
  const file = matter.stringify(`\n${input.body.trim()}\n`, frontmatter);
  writeFileSync(path.join(dir, 'SKILL.md'), file, 'utf-8');
  return input.name;
}

/** Patch a draft skill's frontmatter in place (counters, tier, quarantine).
 *  No-op on a missing skill or one with no parseable file. Returns the updated
 *  Skill or null. */
export function updateSkillFrontmatter(
  name: string,
  patch: Partial<Pick<SkillFrontmatter,
    | 'tier' | 'useCount' | 'failureCount' | 'quarantined'
    | 'capabilityFingerprint' | 'capabilityOrigins'
    | 'supersededBy' | 'supersededAt' | 'disabled' | 'lineage'>>,
): Skill | null {
  const skill = loadSkill(name, { raw: true });
  if (!skill) return null;
  const merged: SkillFrontmatter = { ...skill.frontmatter, ...patch };
  const file = matter.stringify(`\n${skill.body.trim()}\n`, merged);
  writeFileSync(skill.skillPath, file, 'utf-8');
  return loadSkill(name, { raw: true });
}

/** Record another source that accomplished the same capability without
 * incrementing useCount. The harness owns validated-use reinforcement; dedup
 * must not promote a draft merely because distillation ran after that success. */
export function recordSkillCapabilityOrigin(
  name: string,
  origin: Omit<SkillOrigin, 'distilledAt'>,
): Skill | null {
  const skill = loadSkill(name);
  if (!skill || (!skill.frontmatter.origin && skill.frontmatter.tier !== 'draft')) return null;
  const known = skill.frontmatter.capabilityOrigins ?? (skill.frontmatter.origin ? [skill.frontmatter.origin] : []);
  const duplicate = known.some((entry) => entry.kind === origin.kind
    && (entry.sourceId ?? '') === (origin.sourceId ?? ''));
  if (duplicate) return skill;
  return updateSkillFrontmatter(skill.name, {
    capabilityOrigins: [...known, { ...origin, distilledAt: new Date().toISOString() }],
  });
}

export interface ReconcileDistilledSkillsResult {
  canonical: string | null;
  superseded: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Non-destructively reconcile a known family of semantically equivalent
 * self-distilled drafts. The canonical file is retained; every alias remains
 * intact on disk and points to the canonical name. Origin/counter metadata from
 * each alias is copied into canonical.lineage so schedule/session evidence is
 * not lost.
 *
 * This is deliberately explicit rather than a fuzzy bulk mutation: callers
 * provide the reviewed task + aliases, and the function refuses approved or
 * user-installed skills. That gives maintenance code a safe migration path for
 * legacy duplicates without risking unrelated skills that share providers.
 */
export function reconcileDistilledSkillDuplicates(input: {
  canonicalName: string;
  duplicateNames: string[];
  capabilityTask: string;
}): ReconcileDistilledSkillsResult {
  const result: ReconcileDistilledSkillsResult = { canonical: null, superseded: [], skipped: [] };
  const canonical = loadSkill(input.canonicalName, { raw: true });
  if (!canonical) {
    result.skipped.push({ name: input.canonicalName, reason: 'canonical skill not found' });
    return result;
  }
  if (canonical.frontmatter.tier !== 'draft' || !canonical.frontmatter.origin) {
    result.skipped.push({ name: input.canonicalName, reason: 'canonical must be a self-distilled draft' });
    return result;
  }
  if (canonical.frontmatter.supersededBy) {
    result.skipped.push({ name: input.canonicalName, reason: 'canonical is already superseded' });
    return result;
  }

  const fingerprint = capabilityTaskFingerprint(input.capabilityTask);
  if (canonical.frontmatter.capabilityFingerprint
    && canonical.frontmatter.capabilityFingerprint !== fingerprint) {
    result.skipped.push({ name: input.canonicalName, reason: 'canonical has a conflicting capability fingerprint' });
    return result;
  }

  const at = new Date().toISOString();
  const aliases: Skill[] = [];
  for (const name of new Set(input.duplicateNames)) {
    if (name === canonical.name) {
      result.skipped.push({ name, reason: 'same as canonical' });
      continue;
    }
    const alias = loadSkill(name, { raw: true });
    if (!alias) {
      result.skipped.push({ name, reason: 'skill not found' });
      continue;
    }
    if (alias.frontmatter.tier !== 'draft' || !alias.frontmatter.origin) {
      result.skipped.push({ name, reason: 'approved or user-installed skills are never superseded' });
      continue;
    }
    if (alias.frontmatter.supersededBy) {
      result.skipped.push({ name, reason: `already superseded by ${alias.frontmatter.supersededBy}` });
      continue;
    }
    if (alias.frontmatter.capabilityFingerprint
      && alias.frontmatter.capabilityFingerprint !== fingerprint) {
      result.skipped.push({ name, reason: 'conflicting capability fingerprint' });
      continue;
    }
    aliases.push(alias);
  }

  const existingLineage = Array.isArray(canonical.frontmatter.lineage)
    ? canonical.frontmatter.lineage
    : [];
  const lineageByIdentity = new Map<string, SkillLineageEntry>();
  for (const entry of existingLineage) {
    const key = `${entry.skillName}\u0000${entry.origin?.sourceId ?? ''}`;
    lineageByIdentity.set(key, entry);
  }
  for (const alias of aliases) {
    const entry: SkillLineageEntry = {
      skillName: alias.name,
      description: alias.frontmatter.description ?? '',
      origin: alias.frontmatter.origin,
      useCount: alias.frontmatter.useCount ?? 0,
      failureCount: alias.frontmatter.failureCount ?? 0,
      ...(alias.frontmatter.capabilityFingerprint
        ? { capabilityFingerprint: alias.frontmatter.capabilityFingerprint }
        : {}),
      mergedAt: at,
    };
    lineageByIdentity.set(`${entry.skillName}\u0000${entry.origin?.sourceId ?? ''}`, entry);
    for (const inherited of alias.frontmatter.lineage ?? []) {
      const key = `${inherited.skillName}\u0000${inherited.origin?.sourceId ?? ''}`;
      if (!lineageByIdentity.has(key)) lineageByIdentity.set(key, inherited);
    }
  }

  const updatedCanonical = updateSkillFrontmatter(canonical.name, {
    capabilityFingerprint: fingerprint,
    capabilityOrigins: [
      ...(canonical.frontmatter.capabilityOrigins
        ?? (canonical.frontmatter.origin ? [canonical.frontmatter.origin] : [])),
      ...aliases.flatMap((alias) => alias.frontmatter.capabilityOrigins
        ?? (alias.frontmatter.origin ? [alias.frontmatter.origin] : [])),
    ].filter((origin, index, all) => all.findIndex((candidate) => candidate.kind === origin.kind
      && (candidate.sourceId ?? '') === (origin.sourceId ?? '')) === index),
    lineage: [...lineageByIdentity.values()],
    disabled: false,
  });
  if (!updatedCanonical) {
    result.skipped.push({ name: canonical.name, reason: 'could not update canonical skill' });
    return result;
  }
  result.canonical = updatedCanonical.name;

  for (const alias of aliases) {
    const updated = updateSkillFrontmatter(alias.name, {
      capabilityFingerprint: fingerprint,
      supersededBy: canonical.name,
      supersededAt: at,
      disabled: true,
    });
    if (updated) result.superseded.push(alias.name);
    else result.skipped.push({ name: alias.name, reason: 'could not mark alias superseded' });
  }
  return result;
}

/** Append a dated pitfall line to a draft's body (self-improvement, C4),
 *  reusing the Pitfalls section if it already exists. */
export function appendSkillPitfall(name: string, line: string): Skill | null {
  const skill = loadSkill(name);
  if (!skill) return null;
  const header = '## Pitfalls (observed)';
  const trimmed = skill.body.trim();
  const body = trimmed.includes(header)
    ? `${trimmed}\n- ${line.trim()}`
    : `${trimmed}\n\n${header}\n- ${line.trim()}`;
  const file = matter.stringify(`\n${body}\n`, skill.frontmatter);
  writeFileSync(skill.skillPath, file, 'utf-8');
  return loadSkill(name);
}
