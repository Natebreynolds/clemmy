import { spawn } from 'node:child_process';
import path from 'node:path';
import pino from 'pino';
import { findSafeCliCommand } from '../runtime/cli-discovery.js';

/**
 * Capability pre-flight — does this machine actually have the CLI /
 * binary the agent's plan depends on?
 *
 * Today the agent will happily draft a plan that says "run sf data
 * query …" without checking whether `sf` is installed. If it isn't,
 * the first command fails and the user gets a confusing error. The
 * intelligent move is: before drafting steps that depend on an
 * external CLI, verify it exists; if not, surface that to the user
 * BEFORE they approve a doomed plan.
 *
 * Shape:
 *   - A registry of well-known capabilities (the CLIs people usually
 *     care about — Salesforce, GitHub, Google Cloud, AWS, etc.)
 *   - `checkCapability(name)` runs a tiny probe and returns
 *     {available, version?, source?, error?}.
 *   - Probes are cached for 5 minutes so calling the same check twice
 *     in one plan doesn't fork the process twice.
 *   - `listKnownCapabilities()` returns the full registry so the
 *     agent can introspect what's potentially supported.
 *
 * The Planner sub-agent gets `check_capability` and `list_capabilities`
 * tools and is taught to call them before writing CLI-dependent steps.
 */

const logger = pino({ name: 'clementine-next.capabilities' });

export interface CapabilityDescriptor {
  /** Canonical name — also the command name (sf, gh, gcloud, ...). */
  name: string;
  /** Human-friendly name for messages and dashboard. */
  friendlyName: string;
  /** Short description of what this CLI does. */
  description: string;
  /** Arguments to the binary that print version info (cheap, side-effect-free). */
  probeArgs: string[];
  /** Hint for how to install it, if missing. Surfaced to the user in needsUserInput. */
  installHint: string;
  /** Optional documentation URL. */
  docsUrl?: string;
  /** Category for grouping in the dashboard. */
  category: 'crm' | 'cloud' | 'vcs' | 'messaging' | 'payments' | 'devtools' | 'other';
}

export const CAPABILITY_REGISTRY: Readonly<CapabilityDescriptor[]> = Object.freeze([
  // ── CRM ────────────────────────────────────────────────────────
  {
    name: 'sf',
    friendlyName: 'Salesforce CLI (v2)',
    description: 'Modern Salesforce CLI for queries, data ops, deployments.',
    probeArgs: ['--version'],
    installHint: 'Install with: npm install --global @salesforce/cli   (or via the official installer at https://developer.salesforce.com/tools/salesforcecli)',
    docsUrl: 'https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/cli_reference.htm',
    category: 'crm',
  },
  {
    name: 'sfdx',
    friendlyName: 'Salesforce DX (legacy)',
    description: 'Legacy Salesforce CLI. The `sf` CLI is the modern replacement.',
    probeArgs: ['--version'],
    installHint: 'Prefer the modern `sf` CLI. Legacy install: npm install --global sfdx-cli',
    category: 'crm',
  },

  // ── Cloud ──────────────────────────────────────────────────────
  {
    name: 'gcloud',
    friendlyName: 'Google Cloud SDK',
    description: 'Google Cloud Platform command-line interface.',
    probeArgs: ['--version'],
    installHint: 'Install via Homebrew: brew install --cask google-cloud-sdk   (or https://cloud.google.com/sdk/docs/install)',
    docsUrl: 'https://cloud.google.com/sdk/gcloud',
    category: 'cloud',
  },
  {
    name: 'aws',
    friendlyName: 'AWS CLI',
    description: 'Amazon Web Services command-line interface.',
    probeArgs: ['--version'],
    installHint: 'Install via Homebrew: brew install awscli   (or https://aws.amazon.com/cli/)',
    docsUrl: 'https://docs.aws.amazon.com/cli/',
    category: 'cloud',
  },
  {
    name: 'kubectl',
    friendlyName: 'Kubernetes CLI',
    description: 'Kubernetes cluster management.',
    probeArgs: ['version', '--client', '--output=yaml'],
    installHint: 'Install via Homebrew: brew install kubectl',
    category: 'cloud',
  },
  {
    name: 'doctl',
    friendlyName: 'DigitalOcean CLI',
    description: 'DigitalOcean command-line interface.',
    probeArgs: ['version'],
    installHint: 'Install via Homebrew: brew install doctl',
    category: 'cloud',
  },
  {
    name: 'heroku',
    friendlyName: 'Heroku CLI',
    description: 'Heroku application management.',
    probeArgs: ['--version'],
    installHint: 'Install via Homebrew: brew tap heroku/brew && brew install heroku',
    category: 'cloud',
  },
  {
    name: 'vercel',
    friendlyName: 'Vercel CLI',
    description: 'Vercel deployments and project management.',
    probeArgs: ['--version'],
    installHint: 'Install via npm: npm install --global vercel',
    category: 'cloud',
  },
  {
    name: 'fly',
    friendlyName: 'Fly.io CLI (flyctl)',
    description: 'Fly.io application deployment.',
    probeArgs: ['version'],
    installHint: 'Install: curl -L https://fly.io/install.sh | sh',
    category: 'cloud',
  },
  {
    name: 'supabase',
    friendlyName: 'Supabase CLI',
    description: 'Supabase project management.',
    probeArgs: ['--version'],
    installHint: 'Install via Homebrew: brew install supabase/tap/supabase',
    category: 'cloud',
  },

  // ── VCS ────────────────────────────────────────────────────────
  {
    name: 'gh',
    friendlyName: 'GitHub CLI',
    description: 'GitHub repository, PR, and issue management.',
    probeArgs: ['--version'],
    installHint: 'Install via Homebrew: brew install gh',
    docsUrl: 'https://cli.github.com/manual/',
    category: 'vcs',
  },
  {
    name: 'git',
    friendlyName: 'Git',
    description: 'Distributed version control.',
    probeArgs: ['--version'],
    installHint: 'Install via Homebrew: brew install git',
    category: 'vcs',
  },

  // ── Messaging ──────────────────────────────────────────────────
  {
    name: 'slack',
    friendlyName: 'Slack CLI',
    description: 'Slack workspace + app management.',
    probeArgs: ['--version'],
    installHint: 'Install via Homebrew: brew tap slackapi/slack-cli && brew install slack-cli',
    category: 'messaging',
  },

  // ── Payments ───────────────────────────────────────────────────
  {
    name: 'stripe',
    friendlyName: 'Stripe CLI',
    description: 'Stripe API + webhook testing CLI.',
    probeArgs: ['--version'],
    installHint: 'Install via Homebrew: brew install stripe/stripe-cli/stripe',
    category: 'payments',
  },

  // ── Devtools ───────────────────────────────────────────────────
  {
    name: 'docker',
    friendlyName: 'Docker',
    description: 'Container runtime and CLI.',
    probeArgs: ['--version'],
    installHint: 'Install Docker Desktop from https://docker.com',
    category: 'devtools',
  },
  {
    name: 'node',
    friendlyName: 'Node.js',
    description: 'Node.js runtime.',
    probeArgs: ['--version'],
    installHint: 'Install via nvm: https://github.com/nvm-sh/nvm',
    category: 'devtools',
  },
  {
    name: 'npm',
    friendlyName: 'npm',
    description: 'Node package manager.',
    probeArgs: ['--version'],
    installHint: 'Ships with Node.js — install Node via nvm.',
    category: 'devtools',
  },
  {
    name: 'curl',
    friendlyName: 'curl',
    description: 'HTTP request tool.',
    probeArgs: ['--version'],
    installHint: 'Ships with macOS. Install via Homebrew if missing: brew install curl',
    category: 'devtools',
  },
  {
    name: 'jq',
    friendlyName: 'jq',
    description: 'JSON processor.',
    probeArgs: ['--version'],
    installHint: 'Install via Homebrew: brew install jq',
    category: 'devtools',
  },
  {
    name: 'uv',
    friendlyName: 'uv',
    description: 'Python package/tool manager used to install Browser Harness cleanly.',
    probeArgs: ['--version'],
    installHint: 'Install from https://docs.astral.sh/uv/getting-started/installation/ or via Homebrew: brew install uv',
    docsUrl: 'https://docs.astral.sh/uv/',
    category: 'devtools',
  },
  {
    name: 'browser-harness',
    friendlyName: 'Browser Harness',
    description: 'Direct CDP browser control for real Chrome or Browser Use cloud browsers.',
    probeArgs: ['--version'],
    installHint: 'Install from the Integrations tab, or manually: git clone https://github.com/browser-use/browser-harness ~/Developer/browser-harness && cd ~/Developer/browser-harness && uv tool install -e .',
    docsUrl: 'https://github.com/browser-use/browser-harness',
    category: 'devtools',
  },
]);

export interface CapabilityCheckResult {
  name: string;
  available: boolean;
  version?: string;
  source?: string;
  error?: string;
  checkedAt: string;
}

interface CacheEntry {
  result: CapabilityCheckResult;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export function getCapabilityDescriptor(name: string): CapabilityDescriptor | undefined {
  const trimmed = name.trim();
  return CAPABILITY_REGISTRY.find((c) => c.name === trimmed);
}

export function listKnownCapabilities(): CapabilityDescriptor[] {
  return [...CAPABILITY_REGISTRY];
}

function runProbe(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null; resolvedPath?: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      env: process.env,
      // Tight timeout — a probe shouldn't take more than 4s.
      timeout: 4_000,
    });
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });
    child.on('error', (err) => {
      resolve({ stdout, stderr: stderr || err.message, code: -1 });
    });
    child.on('exit', (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}

function parseVersionLine(text: string): string | undefined {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0);
  if (!firstLine) return undefined;
  return firstLine.trim().slice(0, 200);
}

export async function checkCapability(name: string, options: { useCache?: boolean } = {}): Promise<CapabilityCheckResult> {
  const useCache = options.useCache !== false;
  const trimmed = name.trim();
  if (!trimmed) {
    return { name: trimmed, available: false, error: 'empty capability name', checkedAt: new Date().toISOString() };
  }

  if (useCache) {
    const hit = cache.get(trimmed);
    if (hit && hit.expiresAt > Date.now()) return hit.result;
  }

  const descriptor = getCapabilityDescriptor(trimmed);
  const probeArgs = descriptor?.probeArgs ?? ['--version'];

  const safe = findSafeCliCommand(trimmed);
  let result: CapabilityCheckResult;

  if (!safe) {
    result = {
      name: trimmed,
      available: false,
      error: `command '${trimmed}' not found on PATH`,
      checkedAt: new Date().toISOString(),
    };
  } else if (safe.skipped) {
    result = {
      name: trimmed,
      available: false,
      source: safe.path,
      error: `${safe.reason} Install the required tool separately, then retry.`,
      checkedAt: new Date().toISOString(),
    };
  } else {
    const probe = await runProbe(safe.command, probeArgs);
    if (probe.code === 0 || (probe.code !== -1 && (probe.stdout.length > 0 || probe.stderr.length > 0))) {
      const versionText = parseVersionLine(probe.stdout) ?? parseVersionLine(probe.stderr);
      result = {
        name: trimmed,
        available: true,
        version: versionText,
        source: safe.path,
        checkedAt: new Date().toISOString(),
      };
    } else {
      const errSnippet = (probe.stderr || probe.stdout || '').slice(0, 240).trim();
      result = {
        name: trimmed,
        available: false,
        source: safe.path,
        error: errSnippet || `command '${trimmed}' did not respond to ${probeArgs.join(' ')}`,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  if (useCache) {
    cache.set(trimmed, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  logger.debug({ name: trimmed, available: result.available, version: result.version }, 'capability checked');

  return result;
}

/**
 * Scan all registered capabilities. Useful at startup or for the
 * dashboard "what's available" view. Honors the per-entry cache so
 * repeated calls within 5 minutes don't fork N processes.
 */
export async function checkAllCapabilities(): Promise<CapabilityCheckResult[]> {
  const results = await Promise.all(CAPABILITY_REGISTRY.map((c) => checkCapability(c.name)));
  return results;
}

/** Reset the in-memory probe cache. Mostly for tests. */
export function clearCapabilityCache(): void {
  cache.clear();
}

/** Test helper — only used in unit tests, NOT wired to the runtime. */
export function _testSeed(name: string, result: CapabilityCheckResult, ttlMs: number = CACHE_TTL_MS): void {
  cache.set(name, { result, expiresAt: Date.now() + ttlMs });
}

/**
 * Format a capability result for human/agent consumption. The agent
 * gets this back from check_capability and can reason over the
 * structured fields OR the string.
 */
export function renderCapabilityResult(result: CapabilityCheckResult, descriptor?: CapabilityDescriptor): string {
  if (result.available) {
    const lines = [
      `✓ ${descriptor?.friendlyName ?? result.name} is available.`,
      result.version ? `  Version: ${result.version}` : '',
      result.source ? `  Path: ${result.source}` : '',
    ];
    return lines.filter(Boolean).join('\n');
  }
  const lines = [
    `✗ ${descriptor?.friendlyName ?? result.name} is NOT available.`,
    result.error ? `  Error: ${result.error}` : '',
    descriptor?.installHint ? `  Install: ${descriptor.installHint}` : '',
    descriptor?.docsUrl ? `  Docs: ${descriptor.docsUrl}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

// Re-export path module for downstream needs (e.g. building install commands)
export { path };
