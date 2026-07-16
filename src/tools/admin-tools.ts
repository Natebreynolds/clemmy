import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BASE_DIR,
  TIMERS_FILE,
  ensureDir,
  listWorkspaceProjects,
  textResult,
} from './shared.js';

interface TimerEntry {
  id: string;
  message: string;
  fireAt: number;
  createdAt: number;
}

function readTimers(): TimerEntry[] {
  if (!existsSync(TIMERS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(TIMERS_FILE, 'utf-8')) as TimerEntry[];
  } catch {
    return [];
  }
}

function writeTimers(timers: TimerEntry[]): void {
  writeFileSync(TIMERS_FILE, JSON.stringify(timers, null, 2), 'utf-8');
}

function resolveHomePath(input: string): string {
  return path.resolve(input.startsWith('~') ? input.replace('~', os.homedir()) : input);
}

function readJsonFile<T extends object>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readPlistValue(plistPath: string, key: string): string | null {
  if (!existsSync(plistPath)) return null;
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value || null;
}

function desktopBundleCandidates(): string[] {
  return [
    '/Applications/Clementine.app',
    path.join(os.homedir(), 'Applications', 'Clementine.app'),
  ];
}

export function registerAdminTools(server: McpServer): void {
  server.tool(
    'desktop_status',
    'Read-only status for the locally installed Clementine desktop app, including installed bundle version and packaged runtime version.',
    {},
    async () => {
      const rootPackage = readJsonFile<{ version?: string; name?: string }>(
        path.resolve(process.cwd(), 'package.json'),
      );
      const desktopPackage = readJsonFile<{ version?: string; name?: string }>(
        path.resolve(process.cwd(), 'apps', 'desktop', 'package.json'),
      );

      const foundBundle = desktopBundleCandidates().find((candidate) => existsSync(candidate));
      const plistPath = foundBundle ? path.join(foundBundle, 'Contents', 'Info.plist') : null;
      const bundleVersion = plistPath ? readPlistValue(plistPath, 'CFBundleShortVersionString') : null;
      const bundleBuild = plistPath ? readPlistValue(plistPath, 'CFBundleVersion') : null;

      return textResult(
        [
          'Clementine desktop status',
          foundBundle ? `Installed app: ${foundBundle}` : 'Installed app: not found in /Applications or ~/Applications',
          bundleVersion ? `Installed version: ${bundleVersion}` : 'Installed version: unknown',
          bundleBuild && bundleBuild !== bundleVersion ? `Installed build: ${bundleBuild}` : '',
          desktopPackage?.version ? `Packaged desktop version: ${desktopPackage.version}` : '',
          rootPackage?.version ? `Workspace version: ${rootPackage.version}` : '',
        ].filter(Boolean).join('\n'),
      );
    },
  );

  server.tool(
    'set_timer',
    'Set a short-term reminder. Use this instead of cron for reminders under 24 hours.',
    {
      minutes: z.number().min(1).max(1440),
      message: z.string().min(1),
    },
    async ({ minutes, message }) => {
      const now = Date.now();
      const fireAt = now + minutes * 60 * 1000;
      const timers = readTimers();
      timers.push({
        id: `timer-${randomBytes(4).toString('hex')}`,
        message,
        fireAt,
        createdAt: now,
      });
      writeTimers(timers);

      return textResult(`Timer set for ${minutes} minute${minutes === 1 ? '' : 's'} from now: "${message}"`);
    },
  );

  server.tool(
    'workspace_list',
    'List local projects found in configured workspace directories.',
    {
      filter: z.string().optional(),
    },
    async ({ filter }) => {
      const projects = listWorkspaceProjects(filter);
      if (projects.length === 0) {
        return textResult(filter ? `No projects matching "${filter}" found.` : 'No projects found.');
      }

      return textResult(
        projects
          .map((project) => {
            const parts = [`- ${project.name} (${project.type})`, `  Path: ${project.path}`];
            if (project.description) parts.splice(1, 0, `  ${project.description}`);
            if (project.hasClaude) parts.push('  Has imported agent notes');
            return parts.join('\n');
          })
          .join('\n\n'),
      );
    },
  );

  server.tool(
    'workspace_info',
    'Get detailed info about a local project including README, CLAUDE.md, manifest, and structure.',
    {
      project_path: z.string().min(1),
      include_tree: z.boolean().optional(),
    },
    async ({ project_path, include_tree }) => {
      const resolved = resolveHomePath(project_path);
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        return textResult(`Not a directory: ${resolved}`);
      }

      const sections: string[] = [`# ${path.basename(resolved)}`, `Path: ${resolved}`];
      const claudePath = path.join(resolved, '.claude', 'CLAUDE.md');
      if (existsSync(claudePath)) {
        sections.push('', '## Imported Agent Notes', readFileSync(claudePath, 'utf-8').slice(0, 3000));
      }

      for (const readmeName of ['README.md', 'readme.md', 'README']) {
        const readmePath = path.join(resolved, readmeName);
        if (!existsSync(readmePath)) continue;
        sections.push('', `## ${readmeName}`, readFileSync(readmePath, 'utf-8').slice(0, 3000));
        break;
      }

      const packageJsonPath = path.join(resolved, 'package.json');
      if (existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
            name?: string;
            version?: string;
            description?: string;
            scripts?: Record<string, string>;
          };
          sections.push(
            '',
            '## package.json',
            [
              pkg.name ? `Name: ${pkg.name}` : '',
              pkg.version ? `Version: ${pkg.version}` : '',
              pkg.description ? `Description: ${pkg.description}` : '',
              pkg.scripts ? `Scripts: ${Object.keys(pkg.scripts).join(', ')}` : '',
            ].filter(Boolean).join('\n'),
          );
        } catch {
          // Ignore malformed package.json
        }
      }

      if (include_tree !== false) {
        const tree = readdirSync(resolved)
          .filter((entry) => !entry.startsWith('.'))
          .sort()
          .slice(0, 60)
          .map((entry) => {
            const fullPath = path.join(resolved, entry);
            try {
              return `${entry}${statSync(fullPath).isDirectory() ? '/' : ''}`;
            } catch {
              return entry;
            }
          });
        sections.push('', '## Structure', ['```', ...tree, '```'].join('\n'));
      }

      return textResult(sections.join('\n'));
    },
  );

  server.tool(
    'create_tool',
    'Create a reusable shell or python tool script in ~/.clementine-next/tools.',
    {
      name: z.string().min(1),
      description: z.string().min(1),
      language: z.enum(['bash', 'python']),
      script: z.string().min(1),
      args_description: z.string().optional(),
    },
    async ({ name, description, language, script, args_description }) => {
      const toolsDir = path.join(BASE_DIR, 'tools');
      ensureDir(toolsDir);

      const safeName = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
      const extension = language === 'python' ? '.py' : '.sh';
      const filePath = path.join(toolsDir, `${safeName}${extension}`);
      const metaPath = `${filePath}.meta.json`;

      const body = language === 'python'
        ? (script.startsWith('#!') ? script : `#!/usr/bin/env python3\n${script}`)
        : (script.startsWith('#!') ? script : `#!/usr/bin/env bash\nset -euo pipefail\n${script}`);

      writeFileSync(filePath, body.endsWith('\n') ? body : `${body}\n`, { mode: 0o755 });
      writeFileSync(metaPath, JSON.stringify({ description, args_description: args_description || 'Optional argument string' }, null, 2), 'utf-8');

      const availableTools = readdirSync(toolsDir)
        .filter((entry) => entry.endsWith('.sh') || entry.endsWith('.py'))
        .map((entry) => entry.replace(/\.(sh|py)$/, ''))
        .sort();

      return textResult(
        [
          `Tool "${safeName}" created at ${filePath}`,
          `Description: ${description}`,
          '',
          'Available after the next assistant run. Current user tools:',
          ...availableTools.map((toolName) => `- ${toolName}`),
        ].join('\n'),
      );
    },
  );
}
