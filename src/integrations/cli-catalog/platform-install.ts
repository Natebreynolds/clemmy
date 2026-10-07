import type { CliCatalogEntry } from './catalog.js';

export const WINDOWS_GITHUB_INSTALL = 'winget install --id GitHub.cli --exact --source winget --disable-interactivity';

export function catalogInstallForPlatform(
  entry: Pick<CliCatalogEntry, 'id' | 'name' | 'installCommand' | 'authDocsUrl' | 'homepage'>,
  platform: NodeJS.Platform = process.platform,
): { supported: true; command: string } | { supported: false; reason: string; docsUrl: string } {
  if (platform !== 'win32' || !/^brew\s/.test(entry.installCommand)) return {supported:true,command:entry.installCommand};
  if (entry.id === 'github') return {supported:true,command:WINDOWS_GITHUB_INSTALL};
  return {supported:false, docsUrl:entry.homepage || entry.authDocsUrl,
    reason:`${entry.name}'s automatic install recipe uses Homebrew and is unavailable on Windows. Install its Windows version from the official instructions, then rescan command-line tools in Connect.`};
}
