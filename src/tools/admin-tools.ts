import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BASE_DIR,
  ensureDir,
  listWorkspaceProjects,
  textResult,
} from './shared.js';
import { appendTimer, resolveTimerFireAt, type TimerEntry } from '../runtime/timers.js';
import { timerProspectiveDefinition } from '../runtime/prospective-adapters.js';
import { upsertProspectiveIntention } from '../runtime/prospective-intentions.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { getSession as getHarnessSession } from '../runtime/harness/eventlog.js';

// Timer store moved to src/runtime/timers.ts (2026-07-20): set_timer used to be
// WRITE-ONLY — no consumer ever fired what this tool wrote, so every reminder
// was silently lost. The daemon's fireDueTimers tick is the other half now.

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

function reminderOriginMetadata(): TimerEntry['metadata'] | undefined {
  const originSessionId = getToolOutputContext()?.sessionId?.trim();
  if (!originSessionId) return undefined;

  const base: NonNullable<TimerEntry['metadata']> = { originSessionId };
  try {
    const session = getHarnessSession(originSessionId);
    if (!session) return base;
    const metadata = session.metadata ?? {};
    const channelLabel = String(session.channel ?? '').trim().toLowerCase();
    const metadataSource = String(metadata.source ?? '').trim().toLowerCase();
    const isDiscord = channelLabel === 'discord'
      || channelLabel.startsWith('discord:')
      || metadataSource === 'discord'
      || metadataSource.startsWith('discord-');
    const isSlack = channelLabel === 'slack'
      || channelLabel.startsWith('slack:')
      || metadataSource === 'slack'
      || metadataSource.startsWith('slack-');
    const channelId = typeof metadata.channelId === 'string' && metadata.channelId.trim()
      ? metadata.channelId.trim()
      : '';
    const userId = session.userId?.trim()
      || (typeof metadata.userId === 'string' ? metadata.userId.trim() : '');

    if (isDiscord) {
      const discordChannelId = typeof metadata.discordChannelId === 'string' && metadata.discordChannelId.trim()
        ? metadata.discordChannelId.trim()
        : channelId;
      if (discordChannelId) return { ...base, discordChannelId };
      const discordUserId = typeof metadata.discordUserId === 'string' && metadata.discordUserId.trim()
        ? metadata.discordUserId.trim()
        : userId;
      return discordUserId ? { ...base, discordUserId } : base;
    }

    if (isSlack) {
      const rawConversation = typeof metadata.slackChannelId === 'string' && metadata.slackChannelId.trim()
        ? metadata.slackChannelId.trim()
        : channelId;
      if (rawConversation) {
        const [slackChannelId, ...threadParts] = rawConversation.split(':');
        const slackThreadTs = typeof metadata.slackThreadTs === 'string' && metadata.slackThreadTs.trim()
          ? metadata.slackThreadTs.trim()
          : threadParts.join(':');
        return {
          ...base,
          slackChannelId,
          ...(slackThreadTs ? { slackThreadTs } : {}),
        };
      }
      const slackUserId = typeof metadata.slackUserId === 'string' && metadata.slackUserId.trim()
        ? metadata.slackUserId.trim()
        : userId;
      return slackUserId ? { ...base, slackUserId } : base;
    }
  } catch {
    // The durable timer remains valid even if origin lookup is unavailable.
  }
  return base;
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
    'Set a one-time reminder notification within the next 24 hours. Use minutes for a relative reminder, or fire_at for an exact wall-clock time such as "10 PM tonight". This tool actually fires; task_add only creates a passive TODO.',
    {
      minutes: z.number().min(1).max(1440).optional()
        .describe('Relative delay in minutes. Provide this OR fire_at, never both.'),
      fire_at: z.string().optional()
        .describe('Exact ISO 8601 timestamp with an explicit UTC offset, within 24 hours. Example: 2026-07-30T22:00:00-07:00. Provide this OR minutes.'),
      message: z.string().min(1),
    },
    async ({ minutes, fire_at, message }) => {
      const now = Date.now();
      const resolved = resolveTimerFireAt({ minutes, fireAt: fire_at }, now);
      if (!resolved.ok) {
        return textResult(`set_timer refused: ${resolved.error} No reminder was scheduled.`);
      }
      const timer = {
        id: `timer-${randomBytes(4).toString('hex')}`,
        message,
        fireAt: resolved.fireAt,
        createdAt: now,
        metadata: reminderOriginMetadata(),
      };
      appendTimer(timer);
      // Materialize the future commitment immediately. The timer file remains
      // execution-authoritative; a control-plane indexing failure must never
      // make the proven reminder path fail.
      try { upsertProspectiveIntention(timerProspectiveDefinition(timer)); }
      catch { /* daemon reconciliation repairs the index on its next tick */ }

      return textResult(
        `Reminder scheduled (${timer.id}) for ${resolved.confirmationTarget}: "${message}" — `
        + 'it will fire as a notification (late-but-never-lost if the app is closed or the Mac sleeps).',
      );
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
