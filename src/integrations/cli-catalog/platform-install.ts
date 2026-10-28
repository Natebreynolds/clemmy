import type { CliCatalogEntry } from './catalog.js';
import { resolveToolDownload, type ToolDownloadRecipe } from '../../runtime/clem-tools.js';

export const WINDOWS_GITHUB_INSTALL = 'winget install --id GitHub.cli --exact --source winget --disable-interactivity';

export type CatalogInstallRecipe =
  | { supported: true; command: string; download?: undefined }
  | { supported: true; command: string; download: ToolDownloadRecipe }
  | { supported: false; reason: string; docsUrl: string };

/** The vendor's own download wins wherever one is published for this
 *  machine; the package-manager form remains for machines without one. */
export function catalogInstallForPlatform(
  entry: Pick<CliCatalogEntry, 'id' | 'name' | 'installCommand' | 'authDocsUrl' | 'homepage'> & { download?: ToolDownloadRecipe },
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CatalogInstallRecipe {
  if (entry.download && resolveToolDownload(entry.download, { platform, arch, tag: 'latest' })) {
    return { supported: true, command: `download ${entry.name} from ${entry.download.githubRepo ? `github.com/${entry.download.githubRepo}` : 'the vendor'}`, download: entry.download };
  }
  if (platform !== 'win32' || !/^brew\s/.test(entry.installCommand)) return { supported: true, command: entry.installCommand };
  if (entry.id === 'github') return { supported: true, command: WINDOWS_GITHUB_INSTALL };
  return { supported: false, docsUrl: entry.homepage || entry.authDocsUrl,
    reason: `${entry.name}'s automatic install recipe uses Homebrew and is unavailable on Windows. Install its Windows version from the official instructions, then rescan command-line tools in Connect.` };
}

/** Start the install the recipe names, on whichever door asked. */
export async function startCatalogInstall(entry: Pick<CliCatalogEntry, 'id' | 'name' | 'installCommand' | 'authDocsUrl' | 'homepage'> & { download?: ToolDownloadRecipe }): Promise<{ ok: true; job: import('../browser-harness.js').InstallJob; command: string } | { ok: false; reason: string; docsUrl: string }> {
  const recipe = catalogInstallForPlatform(entry);
  if (!recipe.supported) return { ok: false, reason: recipe.reason, docsUrl: recipe.docsUrl };
  const { startApprovedInstallCommand, startToolDownloadJob } = await import('../browser-harness.js');
  const metadata = { cliCatalogId: entry.id };
  const job = recipe.download
    ? startToolDownloadJob({ id: entry.id, title: `Install ${entry.name}`, recipe: recipe.download, metadata })
    : startApprovedInstallCommand(recipe.command, `Install ${entry.name}`, metadata);
  return { ok: true, job, command: recipe.command };
}
