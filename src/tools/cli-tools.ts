import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { filterClis, getOrRefreshScan, probe, readCachedScan } from '../runtime/cli-discovery.js';
import { textResult } from './shared.js';

/**
 * Local-CLI discovery tools. Mirrors the composio_search_tools /
 * composio_execute_tool pattern: discovery first, then execute (via
 * run_shell_command in this case — the agent already has shell access).
 *
 * Why these exist: the agent has run_shell_command but no way to KNOW
 * which CLIs are installed without blind probing. Surfacing the
 * discovered list gives the agent a fast "do I have this?" check
 * before reaching for shell heuristics.
 *
 * Both tools are read-only and global — no curated allowlist, no
 * per-CLI auth-check table. The agent reads whatever is actually on
 * the user's $PATH.
 */

export function registerCliTools(server: McpServer): void {
  server.tool(
    'local_cli_list',
    [
      'List CLIs installed on the local machine and detected on $PATH.',
      'Use this BEFORE reaching for run_shell_command when you need to know whether a particular CLI (sf, gh, aws, kubectl, git, vercel, …) is available. Pass `filter` to narrow by substring.',
      'Returns the command name, install path, version (if probed), and the head of `--help` so you can confirm the surface without spawning a separate probe.',
    ].join('\n'),
    {
      filter: z
        .string()
        .max(60)
        .optional()
        .describe('Substring to filter command names (e.g. "sf", "aws", "git"). Omit to return everything detected.'),
      refresh: z
        .boolean()
        .optional()
        .describe('Pass true to re-scan $PATH instead of using the cached result. Slower but reflects very recent installs.'),
    },
    async ({ filter, refresh }) => {
      const scan = refresh
        ? await getOrRefreshScan({ force: true })
        : (readCachedScan() ?? await getOrRefreshScan());
      const entries = filterClis(scan, filter);
      if (entries.length === 0) {
        const hint = filter
          ? `No installed CLI matches "${filter}". Scanned ${scan.clis.length} CLIs at ${scan.scannedAt}.`
          : `No CLIs detected on $PATH at ${scan.scannedAt}.`;
        return textResult(hint);
      }
      const lines = entries.slice(0, 60).map((c) => {
        const v = c.version ? ` — ${c.version}` : '';
        return `${c.command} (${c.path})${v}`;
      });
      const trailer = entries.length > 60 ? `\n…and ${entries.length - 60} more. Pass a filter to narrow.` : '';
      return textResult(
        `${entries.length} CLI${entries.length === 1 ? '' : 's'} on $PATH (scanned ${scan.scannedAt}):\n${lines.join('\n')}${trailer}`,
      );
    },
  );

  server.tool(
    'local_cli_probe',
    [
      'Probe a specific local CLI by running `<command> --version` and `<command> --help`.',
      'Use when you need to confirm a CLI is installed AND learn its top-level surface (subcommands, flags) before issuing a real command via run_shell_command.',
      'Returns "not installed" if the binary isn\'t on $PATH. Times out at 2s per probe so it never blocks for long.',
    ].join('\n'),
    {
      command: z.string().min(1).max(60).describe('The CLI command name, e.g. "sf", "gh", "aws", "kubectl".'),
    },
    async ({ command }) => {
      const entry = await probe(command);
      if (!entry) {
        return textResult(`"${command}" is not installed on $PATH.`);
      }
      const parts = [
        `${entry.command} at ${entry.path}`,
        entry.version ? `version: ${entry.version}` : '',
        entry.helpHead ? `help: ${entry.helpHead}` : '',
        entry.isLikelyCli ? '' : '(no --version or --help output — may not be an interactive CLI)',
      ].filter(Boolean);
      return textResult(parts.join('\n'));
    },
  );
}
