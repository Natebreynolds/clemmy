import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import { augmentPath } from '../runtime/spawn-env.js';
import { electronNodeEnv, interpreterFor, scrubbedChildEnv } from '../runtime/sandboxed-script.js';

export type WorkflowCodeArtifactStatus = 'ready' | 'missing' | 'invalid' | 'unverified';

export interface WorkflowCodeArtifactCertification {
  runner: string;
  stepIds: string[];
  uses: Array<'step' | 'loop_probe'>;
  status: WorkflowCodeArtifactStatus;
  language: 'javascript' | 'typescript' | 'python' | 'shell' | 'executable' | 'unknown';
  sha256?: string;
  bytes?: number;
  diagnostic?: string;
}

export interface WorkflowCodeCertification {
  ok: boolean;
  artifactCount: number;
  readyCount: number;
  issueCount: number;
  /** Stable digest of runner path + source digest for every present artifact. */
  bundleHash: string | null;
  artifacts: WorkflowCodeArtifactCertification[];
  blockingReasons: string[];
  advisories: string[];
}

interface RunnerReference {
  runner: string;
  stepId: string;
  use: 'step' | 'loop_probe';
  source?: string;
}

interface RunnerSource {
  source: string;
  filePath?: string;
  error?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function runnerReferences(steps: WorkflowStepInput[]): RunnerReference[] {
  const refs: RunnerReference[] = [];
  for (const step of steps) {
    if (step.deterministic?.runner) {
      refs.push({
        runner: step.deterministic.runner,
        stepId: step.id,
        use: 'step',
        ...(typeof step.deterministic.source === 'string' ? { source: step.deterministic.source } : {}),
      });
    }
    if (step.loopUntil?.probe?.runner) {
      refs.push({ runner: step.loopUntil.probe.runner, stepId: step.id, use: 'loop_probe' });
    }
  }
  return refs;
}

function safeRunnerPath(workflowSlug: string, runner: string): { ok: true; filePath: string } | { ok: false; error: string } {
  const raw = runner.trim();
  if (!raw || /\s/.test(raw) || path.isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) {
    return { ok: false, error: `runner "${runner}" must be a relative path inside scripts/` };
  }
  const workflowDir = path.resolve(WORKFLOWS_DIR, workflowSlug);
  const scriptsDir = path.resolve(workflowDir, 'scripts');
  const rel = raw.startsWith('scripts/') || raw.startsWith('scripts\\')
    ? raw
    : path.join('scripts', raw);
  const filePath = path.resolve(workflowDir, rel);
  if (filePath === scriptsDir || !filePath.startsWith(`${scriptsDir}${path.sep}`)) {
    return { ok: false, error: `runner "${runner}" resolves outside scripts/` };
  }
  return { ok: true, filePath };
}

function loadRunnerSource(workflowSlug: string, refs: RunnerReference[]): RunnerSource {
  const inline = Array.from(new Set(
    refs.map((ref) => ref.source).filter((source): source is string => typeof source === 'string'),
  ));
  if (inline.length > 1) {
    return { source: '', error: `runner "${refs[0]?.runner}" declares conflicting inline source` };
  }
  if (inline.length === 1) return { source: inline[0] };

  const resolved = safeRunnerPath(workflowSlug, refs[0]?.runner ?? '');
  if (!resolved.ok) return { source: '', error: resolved.error };
  if (!existsSync(resolved.filePath)) {
    return { source: '', filePath: resolved.filePath, error: `script does not exist at ${resolved.filePath}` };
  }
  try {
    return { source: readFileSync(resolved.filePath, 'utf-8'), filePath: resolved.filePath };
  } catch (error) {
    return {
      source: '',
      filePath: resolved.filePath,
      error: `script could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function languageFor(runner: string, filePath?: string): WorkflowCodeArtifactCertification['language'] {
  const ext = path.extname(filePath ?? runner).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'typescript';
  if (ext === '.py') return 'python';
  if (ext === '.sh' || ext === '.bash') return 'shell';
  if (filePath) {
    try {
      const route = interpreterFor(filePath, augmentPath(process.env.PATH));
      if (route?.command === filePath) return 'executable';
    } catch { /* unknown below */ }
  }
  return 'unknown';
}

function clippedDiagnostic(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 600);
}

function certifyJavaScript(
  source: string,
  fileName: string,
): string | null {
  const ext = path.extname(fileName).toLowerCase();
  const route = interpreterFor(fileName, augmentPath(process.env.PATH));
  if (!route) return 'JavaScript runtime is unavailable';
  const args = ext === '.cjs'
    ? ['--check', '-']
    : ['--check', '--input-type=module', '-'];
  const result = spawnSync(route.command, args, {
    input: source,
    encoding: 'utf-8',
    env: scrubbedChildEnv(electronNodeEnv(route.command, route.isElectron)),
    timeout: 5_000,
    maxBuffer: 512 * 1024,
  });
  if (result.error) return clippedDiagnostic(result.error.message);
  if (result.status === 0) return null;
  return clippedDiagnostic(String(result.stderr || result.stdout || `JavaScript syntax check exited ${result.status}`));
}

function certifyPythonOrShell(
  source: string,
  filePath: string | undefined,
  language: 'python' | 'shell',
): string | null {
  const probeTarget = filePath ?? (language === 'python' ? 'inline.py' : 'inline.sh');
  const route = interpreterFor(probeTarget, augmentPath(process.env.PATH));
  if (!route) return `${language} interpreter is unavailable`;
  const pythonPrefix = language === 'python'
    && /^(?:py|py\.exe)$/i.test(path.basename(route.command))
    ? ['-3']
    : [];
  const args = language === 'python'
    ? [...pythonPrefix, '-c', 'import ast,sys; ast.parse(sys.stdin.read(), filename=sys.argv[1])', probeTarget]
    : ['-n'];
  const env = scrubbedChildEnv(electronNodeEnv(route.command, route.isElectron));
  const result = spawnSync(route.command, args, {
    input: source,
    encoding: 'utf-8',
    env,
    timeout: 5_000,
    maxBuffer: 512 * 1024,
  });
  if (result.error) return clippedDiagnostic(result.error.message);
  if (result.status === 0) return null;
  return clippedDiagnostic(String(result.stderr || result.stdout || `${language} syntax check exited ${result.status}`));
}

function syntaxDiagnostic(
  source: string,
  runner: string,
  filePath: string | undefined,
  language: WorkflowCodeArtifactCertification['language'],
): string | null {
  if (language === 'javascript') {
    return certifyJavaScript(source, filePath ?? runner);
  }
  if (language === 'python' || language === 'shell') {
    return certifyPythonOrShell(source, filePath, language);
  }
  return null;
}

/** Cheap source-only fingerprint for certification caches. Unlike the workflow
 * definition hash, this changes when a referenced scripts/ file changes. */
export function workflowCodeRevisionFingerprint(
  def: WorkflowDefinition,
  workflowSlug: string,
): string {
  const grouped = new Map<string, RunnerReference[]>();
  for (const ref of runnerReferences(def.steps ?? [])) {
    const runner = ref.runner.trim();
    const refs = grouped.get(runner) ?? [];
    refs.push({ ...ref, runner });
    grouped.set(runner, refs);
  }
  if (grouped.size === 0) return 'no-code';
  const revisions = Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([runner, refs]) => {
      const loaded = loadRunnerSource(workflowSlug, refs);
      return `${runner}\0${loaded.error ? `error:${loaded.error}` : sha256(loaded.source)}`;
    });
  return sha256(revisions.join('\n'));
}

/**
 * Static certification for every authored code boundary. It never executes the
 * workflow script: parsers only validate syntax. The source digest gives the
 * operator and future admission bundle an exact revision to pin.
 */
export function certifyWorkflowCode(
  def: WorkflowDefinition,
  workflowSlug: string,
): WorkflowCodeCertification {
  const grouped = new Map<string, RunnerReference[]>();
  for (const ref of runnerReferences(def.steps ?? [])) {
    const runner = ref.runner.trim();
    const refs = grouped.get(runner) ?? [];
    refs.push({ ...ref, runner });
    grouped.set(runner, refs);
  }

  const artifacts: WorkflowCodeArtifactCertification[] = [];
  for (const [runner, refs] of Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const source = loadRunnerSource(workflowSlug, refs);
    const language = languageFor(runner, source.filePath);
    const common = {
      runner,
      stepIds: Array.from(new Set(refs.map((ref) => ref.stepId))),
      uses: Array.from(new Set(refs.map((ref) => ref.use))),
      language,
    };
    if (source.error) {
      artifacts.push({
        ...common,
        status: source.error.includes('does not exist') ? 'missing' : 'invalid',
        diagnostic: source.error,
      });
      continue;
    }
    const digest = sha256(source.source);
    if (language === 'unknown' || language === 'executable' || language === 'typescript') {
      artifacts.push({
        ...common,
        status: 'unverified',
        sha256: digest,
        bytes: Buffer.byteLength(source.source, 'utf-8'),
        diagnostic: language === 'typescript'
          ? 'TypeScript runners require the runtime tsx loader; creation-test this artifact before unattended use.'
          : 'No static syntax parser is available for this runner type; creation-test it before unattended use.',
      });
      continue;
    }
    const diagnostic = syntaxDiagnostic(source.source, runner, source.filePath, language);
    artifacts.push({
      ...common,
      status: diagnostic ? 'invalid' : 'ready',
      sha256: digest,
      bytes: Buffer.byteLength(source.source, 'utf-8'),
      ...(diagnostic ? { diagnostic } : {}),
    });
  }

  const blockingReasons = artifacts
    .filter((artifact) => artifact.status === 'missing' || artifact.status === 'invalid')
    .map((artifact) =>
      `Code runner "${artifact.runner}" (${artifact.stepIds.join(', ')}): ${artifact.diagnostic ?? artifact.status}.`);
  const advisories = artifacts
    .filter((artifact) => artifact.status === 'unverified')
    .map((artifact) =>
      `Code runner "${artifact.runner}" (${artifact.stepIds.join(', ')}) is content-hashed but not syntax-verifiable: ${artifact.diagnostic}.`);
  const hashed = artifacts.filter((artifact) => artifact.sha256);
  const bundleHash = hashed.length > 0
    ? sha256(hashed.map((artifact) => `${artifact.runner}\0${artifact.sha256}`).join('\n'))
    : null;

  return {
    ok: blockingReasons.length === 0,
    artifactCount: artifacts.length,
    readyCount: artifacts.filter((artifact) => artifact.status === 'ready').length,
    issueCount: artifacts.filter((artifact) => artifact.status !== 'ready').length,
    bundleHash,
    artifacts,
    blockingReasons,
    advisories,
  };
}
