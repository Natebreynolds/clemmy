import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export type StartupDoctorStatus = 'ok' | 'warning' | 'error';

export interface StartupDoctorIssue {
  id: string;
  severity: Exclude<StartupDoctorStatus, 'ok'>;
  title: string;
  detail: string;
  fix?: string;
  command?: string;
}

export interface StartupRuntimeSnapshot {
  node: string;
  nodeModuleVersion: string;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  electron?: string | null;
  pid: number;
  cwd: string;
  execPath: string;
}

export interface StartupPackageSnapshot {
  name: string;
  version: string;
  engineNode?: string;
  packagePath?: string;
  electronVersion?: string;
}

export interface NativeDependencyCheck {
  name: string;
  declared: boolean;
  installed: boolean;
  loaded: boolean;
  status: StartupDoctorStatus;
  version?: string;
  resolvedPath?: string;
  message: string;
  issue?: StartupDoctorIssue;
}

export interface StartupDoctor {
  generatedAt: string;
  status: StartupDoctorStatus;
  runtime: StartupRuntimeSnapshot;
  package: StartupPackageSnapshot;
  nativeDependencies: NativeDependencyCheck[];
  issues: StartupDoctorIssue[];
  recommendations: string[];
}

interface PackageJson {
  name?: string;
  version?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface NativeDependencyLoadResult {
  ok: boolean;
  resolvedPath?: string;
  version?: string;
  error?: unknown;
}

export interface StartupDoctorOptions {
  now?: string;
  cwd?: string;
  runtime?: Partial<StartupRuntimeSnapshot>;
  packageJson?: PackageJson;
  packagePath?: string;
  desktopPackageJson?: PackageJson | null;
  nativeDependencies?: string[];
  loadNativeDependency?: (name: string) => NativeDependencyLoadResult;
}

const requireFromRuntime = createRequire(import.meta.url);
const DEFAULT_NATIVE_DEPENDENCIES = ['better-sqlite3'];

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function findPackageJson(startDir: string, expectedName?: string): { path: string; pkg: PackageJson } | null {
  let walk = startDir;
  for (let i = 0; i < 10; i += 1) {
    const candidate = path.join(walk, 'package.json');
    if (existsSync(candidate)) {
      const pkg = readJsonFile<PackageJson>(candidate);
      if (pkg && (!expectedName || pkg.name === expectedName)) return { path: candidate, pkg };
    }
    const parent = path.dirname(walk);
    if (parent === walk) break;
    walk = parent;
  }
  return null;
}

function resolveMainPackage(cwd: string): { path?: string; pkg: PackageJson } {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const direct = findPackageJson(cwd, 'clemmy') ?? findPackageJson(moduleDir, 'clemmy') ?? findPackageJson(cwd);
  return {
    path: direct?.path,
    pkg: direct?.pkg ?? {},
  };
}

function packageDependencyRange(pkg: PackageJson | null | undefined, name: string): string | undefined {
  return pkg?.dependencies?.[name] ?? pkg?.optionalDependencies?.[name] ?? pkg?.devDependencies?.[name];
}

function isDeclared(pkg: PackageJson | null | undefined, name: string): boolean {
  return Boolean(packageDependencyRange(pkg, name));
}

function pickNativeDependencies(pkg: PackageJson, desktopPkg: PackageJson | null | undefined, explicit?: string[]): string[] {
  if (explicit?.length) return [...new Set(explicit)];
  const fromPackages = DEFAULT_NATIVE_DEPENDENCIES.filter((name) => isDeclared(pkg, name) || isDeclared(desktopPkg, name));
  return fromPackages.length > 0 ? fromPackages : DEFAULT_NATIVE_DEPENDENCIES;
}

function findPackageVersionFromResolved(name: string, resolvedPath: string | undefined): string | undefined {
  if (!resolvedPath) return undefined;
  let walk = path.dirname(resolvedPath);
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(walk, 'package.json');
    if (existsSync(candidate)) {
      const pkg = readJsonFile<PackageJson>(candidate);
      if (pkg?.name === name) return pkg.version;
    }
    const parent = path.dirname(walk);
    if (parent === walk) break;
    walk = parent;
  }
  return undefined;
}

function defaultLoadNativeDependency(name: string): NativeDependencyLoadResult {
  let resolvedPath: string | undefined;
  let version: string | undefined;
  try {
    resolvedPath = requireFromRuntime.resolve(name);
    version = findPackageVersionFromResolved(name, resolvedPath);
  } catch {
    // The require call below will preserve the real MODULE_NOT_FOUND shape.
  }
  try {
    requireFromRuntime(name);
    return { ok: true, resolvedPath, version };
  } catch (error) {
    return { ok: false, resolvedPath, version, error };
  }
}

function parseVersion(value: string | undefined): [number, number, number] | null {
  if (!value) return null;
  const match = value.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function minNodeVersionFromEngine(engine: string | undefined): [number, number, number] | null {
  if (!engine) return null;
  const match = engine.match(/>=\s*v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

export function parseNodeModuleVersionMismatch(message: string): { builtFor?: string; required?: string } | null {
  const matches = [...message.matchAll(/NODE_MODULE_VERSION\s+(\d+)/g)].map((match) => match[1]);
  if (matches.length === 0) return null;
  return {
    builtFor: matches[0],
    required: matches.length > 1 ? matches[matches.length - 1] : undefined,
  };
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown error');
}

function nativeLoadIssue(name: string, result: NativeDependencyLoadResult): StartupDoctorIssue {
  const message = errorMessage(result.error);
  const code = errorCode(result.error);
  const abi = parseNodeModuleVersionMismatch(message);
  const command = `npm rebuild ${name}`;

  if (abi) {
    const required = abi.required ? `; current runtime expects ABI ${abi.required}` : '';
    return {
      id: `native-${name}-abi`,
      severity: 'error',
      title: `${name} was built for a different Node ABI`,
      detail: `The native module reports ABI ${abi.builtFor}${required}. Clementine cannot reliably start until it is rebuilt for this Node runtime.`,
      fix: `Rebuild ${name} after every Node or Electron runtime upgrade.`,
      command,
    };
  }

  if (code === 'MODULE_NOT_FOUND' && !result.resolvedPath) {
    return {
      id: `native-${name}-missing`,
      severity: 'error',
      title: `${name} is not installed`,
      detail: `The dependency could not be resolved from this runtime: ${message}`,
      fix: 'Install dependencies for the daemon package.',
      command: 'npm install',
    };
  }

  return {
    id: `native-${name}-load`,
    severity: 'error',
    title: `${name} failed to load`,
    detail: message,
    fix: `Rebuild ${name}; if the error persists, reinstall dependencies from a clean node_modules.`,
    command,
  };
}

function checkNativeDependency(
  name: string,
  declared: boolean,
  loader: (name: string) => NativeDependencyLoadResult,
): NativeDependencyCheck {
  const result = loader(name);
  if (result.ok) {
    return {
      name,
      declared,
      installed: true,
      loaded: true,
      status: 'ok',
      version: result.version,
      resolvedPath: result.resolvedPath,
      message: `${name} loaded successfully.`,
    };
  }

  const issue = nativeLoadIssue(name, result);
  return {
    name,
    declared,
    installed: Boolean(result.resolvedPath),
    loaded: false,
    status: issue.severity,
    version: result.version,
    resolvedPath: result.resolvedPath,
    message: issue.title,
    issue,
  };
}

function buildRuntimeSnapshot(options: StartupDoctorOptions): StartupRuntimeSnapshot {
  return {
    node: options.runtime?.node ?? process.versions.node,
    nodeModuleVersion: options.runtime?.nodeModuleVersion ?? process.versions.modules,
    platform: options.runtime?.platform ?? process.platform,
    arch: options.runtime?.arch ?? process.arch,
    electron: options.runtime?.electron ?? process.versions.electron ?? null,
    pid: options.runtime?.pid ?? process.pid,
    cwd: options.runtime?.cwd ?? options.cwd ?? process.cwd(),
    execPath: options.runtime?.execPath ?? process.execPath,
  };
}

function nodeEngineIssue(runtime: StartupRuntimeSnapshot, engineNode: string | undefined): StartupDoctorIssue | null {
  const min = minNodeVersionFromEngine(engineNode);
  if (!min) return null;
  const current = parseVersion(runtime.node);
  if (!current || compareVersions(current, min) >= 0) return null;
  const floor = min.join('.');
  return {
    id: 'node-version-floor',
    severity: 'error',
    title: `Node ${runtime.node} is below Clementine's supported floor`,
    detail: `The package declares ${engineNode}; this process is running Node ${runtime.node}.`,
    fix: `Run Clementine with Node ${floor} or newer, then rebuild native modules.`,
    command: 'npm rebuild better-sqlite3',
  };
}

function rank(status: StartupDoctorStatus): number {
  if (status === 'error') return 2;
  if (status === 'warning') return 1;
  return 0;
}

function maxStatus(issues: StartupDoctorIssue[]): StartupDoctorStatus {
  return issues.reduce<StartupDoctorStatus>((status, issue) => (
    rank(issue.severity) > rank(status) ? issue.severity : status
  ), 'ok');
}

function loadDesktopPackage(rootPackagePath: string | undefined): PackageJson | null {
  const roots = [
    rootPackagePath ? path.dirname(rootPackagePath) : '',
    process.cwd(),
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, 'apps', 'desktop', 'package.json');
    if (!existsSync(candidate)) continue;
    const pkg = readJsonFile<PackageJson>(candidate);
    if (pkg) return pkg;
  }
  return null;
}

export function buildStartupDoctor(options: StartupDoctorOptions = {}): StartupDoctor {
  const cwd = options.cwd ?? process.cwd();
  const runtime = buildRuntimeSnapshot({ ...options, cwd });
  const resolvedPackage = options.packageJson
    ? { path: options.packagePath, pkg: options.packageJson }
    : resolveMainPackage(cwd);
  const desktopPackage = options.desktopPackageJson === undefined
    ? loadDesktopPackage(resolvedPackage.path)
    : options.desktopPackageJson;
  const pkg = resolvedPackage.pkg;
  const nativeNames = pickNativeDependencies(pkg, desktopPackage, options.nativeDependencies);
  const loader = options.loadNativeDependency ?? defaultLoadNativeDependency;

  const packageSnapshot: StartupPackageSnapshot = {
    name: pkg.name ?? 'unknown',
    version: pkg.version ?? 'unknown',
    engineNode: pkg.engines?.node,
    packagePath: resolvedPackage.path,
    electronVersion: packageDependencyRange(desktopPackage, 'electron'),
  };

  const issues: StartupDoctorIssue[] = [];
  const engineIssue = nodeEngineIssue(runtime, packageSnapshot.engineNode);
  if (engineIssue) issues.push(engineIssue);

  const nativeDependencies = nativeNames.map((name) => {
    const check = checkNativeDependency(name, isDeclared(pkg, name) || isDeclared(desktopPackage, name), loader);
    if (check.issue) issues.push(check.issue);
    return check;
  });

  const status = maxStatus(issues);
  return {
    generatedAt: options.now ?? new Date().toISOString(),
    status,
    runtime,
    package: packageSnapshot,
    nativeDependencies,
    issues,
    recommendations: [
      'After changing Node, run npm rebuild better-sqlite3 before starting the daemon.',
      'Before packaging Electron, run npm --prefix apps/desktop run rebuild-daemon-natives so daemon native modules match the embedded runtime.',
      'If startup fails with ERR_DLOPEN_FAILED, treat it as a native ABI mismatch until the doctor proves otherwise.',
    ],
  };
}
