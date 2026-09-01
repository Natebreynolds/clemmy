import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { BASE_DIR, PKG_DIR } from '../config.js';
import { withFileLockSyncStrict } from '../runtime/atomic-json.js';

export const TECHNICAL_CONTENT_MARKETING_SKILL = 'technical-content-marketing' as const;
export const TECHNICAL_CONTENT_MARKETING_RULE_MARKER =
  'SOURCE-DATED-CALENDAR-ONE-IDEA-PER-POST' as const;

const BUILTIN_SKILLS = Object.freeze([
  TECHNICAL_CONTENT_MARKETING_SKILL,
]);

/** Built-ins are instruction assets, not an unbounded packaging channel. */
export const BUILTIN_SKILL_MAX_BYTES = 256 * 1024;

export interface BuiltinSkillProvisionResult {
  name: string;
  status: 'installed' | 'preserved';
  target: string;
}

function validatedBuiltinSkillBytes(source: string, expectedName: string): Buffer {
  const bytes = readFileSync(source);
  if (bytes.length === 0 || bytes.length > BUILTIN_SKILL_MAX_BYTES) {
    throw new Error(
      `Built-in skill ${expectedName} must be 1-${BUILTIN_SKILL_MAX_BYTES} bytes; got ${bytes.length}`,
    );
  }
  const text = bytes.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') !== bytes.length || text.includes('\uFFFD')) {
    throw new Error(`Built-in skill ${expectedName} is not valid UTF-8`);
  }
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = matter(text).data as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Built-in skill ${expectedName} has invalid frontmatter: ${(error as Error).message}`);
  }
  if (frontmatter.name !== expectedName) {
    throw new Error(
      `Built-in skill ${expectedName} frontmatter name must be exactly ${expectedName}`,
    );
  }
  if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
    throw new Error(`Built-in skill ${expectedName} requires a non-empty description`);
  }
  return bytes;
}

/**
 * Existing skill bytes (or any non-empty/non-directory same-name path) are an
 * ownership boundary. An empty real directory is intentionally considered an
 * incomplete install: setup may add the absent SKILL.md, but never replaces
 * the directory itself. That makes a crash after mkdir recoverable without
 * overwriting user-authored bytes.
 */
function hasExistingOwnershipBoundary(targetDir: string, target: string): boolean {
  if (existsSync(target)) return true;
  if (!existsSync(targetDir)) return false;

  const targetStat = lstatSync(targetDir);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return true;
  return readdirSync(targetDir).length > 0;
}

/**
 * Preservation must not be mistaken for readiness. A user-owned same-name
 * skill is a valid override only when the production skill store can actually
 * discover a real directory with parseable, selectable instruction bytes.
 * Conflicts are never overwritten; they fail setup/daemon readiness with the
 * exact path so the user can repair them deliberately.
 */
function assertPreservedSkillIsUsable(targetDir: string, target: string, expectedName: string): void {
  let targetStat;
  try {
    targetStat = lstatSync(targetDir);
  } catch (error) {
    throw new Error(`User-owned built-in skill override is unreadable at ${targetDir}: ${(error as Error).message}`);
  }
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink() || !existsSync(target)) {
    throw new Error(
      `User-owned path blocks required built-in skill ${expectedName} but has no discoverable SKILL.md: ${targetDir}`,
    );
  }
  let parsed;
  try {
    parsed = matter(readFileSync(target, 'utf8'));
  } catch (error) {
    throw new Error(`User-owned skill ${expectedName} has unreadable frontmatter at ${target}: ${(error as Error).message}`);
  }
  const frontmatter = parsed.data as Record<string, unknown>;
  const declaredName = typeof frontmatter.name === 'string' && frontmatter.name.trim()
    ? frontmatter.name.trim()
    : expectedName;
  if (declaredName !== expectedName) {
    throw new Error(`User-owned skill at ${target} declares ${declaredName}; expected ${expectedName}`);
  }
  if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
    throw new Error(`User-owned skill ${expectedName} requires a non-empty description at ${target}`);
  }
  if (!parsed.content.trim()) {
    throw new Error(`User-owned skill ${expectedName} requires a non-empty instruction body at ${target}`);
  }
}

/**
 * Seed small first-party instruction skills into a Clementine home.
 *
 * A same-named SKILL.md is always user-owned, regardless of its contents or
 * provenance, so setup never rewrites it. The packaged asset is read before
 * creating destination bytes; a broken tarball therefore fails without
 * leaving a partial skill that later boots might mistake for a user install.
 */
export function provisionBuiltinSkills(options: {
  baseDir?: string;
  packageRoot?: string;
  /** Test-only fault seam after private staging and before publication. */
  beforeInstallPublish?: (input: { name: string; stagingDir: string; targetDir: string }) => void;
  /** Test-only race seam immediately before the atomic no-replace file publish. */
  beforeSkillFilePublish?: (input: { name: string; targetDir: string; target: string }) => void;
} = {}): BuiltinSkillProvisionResult[] {
  const baseDir = path.resolve(options.baseDir ?? BASE_DIR);
  const packageRoot = path.resolve(options.packageRoot ?? PKG_DIR);
  const skillsDir = path.join(baseDir, 'skills');
  const results: BuiltinSkillProvisionResult[] = [];

  mkdirSync(skillsDir, { recursive: true });
  for (const name of BUILTIN_SKILLS) {
    const targetDir = path.join(skillsDir, name);
    const target = path.join(targetDir, 'SKILL.md');
    const preserveExistingIfUsable = (): boolean => {
      if (!hasExistingOwnershipBoundary(targetDir, target)) return false;
      assertPreservedSkillIsUsable(targetDir, target, name);
      results.push({ name, status: 'preserved', target });
      return true;
    };
    if (preserveExistingIfUsable()) continue;

    const installLockPath = path.join(skillsDir, `.${name}-builtin-install`);
    withFileLockSyncStrict(installLockPath, () => {
      // The first check is only a fast path. This check under the per-name
      // exclusive lock is the cooperative cross-process ownership boundary.
      if (preserveExistingIfUsable()) return;

      const source = path.join(packageRoot, 'builtin-skills', name, 'SKILL.md');
      // Validate the complete packaged asset before creating any destination
      // bytes. A corrupt candidate can neither publish nor poison the retry path.
      const bytes = validatedBuiltinSkillBytes(source, name);
      const stagingPrefix = `.${name}-install-`;
      // The lock guarantees these are remnants of a dead earlier installer,
      // never staging owned by a cooperating live process.
      for (const entry of readdirSync(skillsDir)) {
        if (entry.startsWith(stagingPrefix)) {
          rmSync(path.join(skillsDir, entry), { recursive: true, force: true });
        }
      }
      const stagingDir = mkdtempSync(path.join(skillsDir, stagingPrefix));
      const stagedSkill = path.join(stagingDir, 'SKILL.md');
      try {
        writeFileSync(stagedSkill, bytes, { flag: 'wx' });
        options.beforeInstallPublish?.({ name, stagingDir, targetDir });

        // Recheck after staging/the test seam. A non-empty contender wins. An
        // empty directory is reused in place, never replaced (important on
        // macOS, where rename can replace an existing empty directory).
        if (preserveExistingIfUsable()) return;

        if (!existsSync(targetDir)) {
          try {
            mkdirSync(targetDir);
          } catch (error) {
            // A non-cooperating contender may have created the path after the
            // recheck. Preserve any ownership boundary; an empty real directory
            // remains eligible for the no-overwrite file publish below.
            if (!existsSync(targetDir)) throw error;
          }
        }
        if (preserveExistingIfUsable()) return;
        options.beforeSkillFilePublish?.({ name, targetDir, target });

        try {
          // A same-filesystem hard link is an atomic, no-replace publication of
          // already-complete bytes. EEXIST can never overwrite a raced user file.
          linkSync(stagedSkill, target);
        } catch (error) {
          if (existsSync(target)) {
            // A non-cooperating process can win after the final recheck but
            // before link(2). Preserve its bytes, then prove that what won is
            // a usable override before this daemon is allowed to look ready.
            assertPreservedSkillIsUsable(targetDir, target, name);
            results.push({ name, status: 'preserved', target });
            return;
          }
          throw error;
        }
        results.push({ name, status: 'installed', target });
      } finally {
        // After a successful hard link this removes only the private name; the
        // complete target inode remains. Faults expose no partial SKILL.md.
        if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
      }
    });
  }
  return results;
}
