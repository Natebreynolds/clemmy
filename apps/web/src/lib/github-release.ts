interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  content_type: string;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  assets: GitHubAsset[];
  html_url: string;
  prerelease: boolean;
  draft: boolean;
}

const REPO = "Natebreynolds/clemmy";

export async function getLatestRelease(): Promise<GitHubRelease | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "clementine-landing",
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
        next: { revalidate: 300 },
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as GitHubRelease;
  } catch {
    return null;
  }
}

/**
 * Pick the Mac installer asset for the requested architecture.
 *
 * Each release ships:
 *   Clementine-X.Y.Z-arm64-mac.zip   ← Apple Silicon zip (preferred)
 *   Clementine-X.Y.Z-arm64.dmg       ← Apple Silicon dmg (fallback)
 *   Clementine-X.Y.Z-mac.zip         ← Intel zip (preferred)
 *   Clementine-X.Y.Z.dmg             ← Intel dmg (fallback)
 *   *.blockmap                       ← always ignored
 */
export function pickMacAsset(
  release: GitHubRelease,
  arch: "arm64" | "intel",
): GitHubAsset | null {
  const isBlockmap = (n: string) => /\.blockmap$/i.test(n);

  if (arch === "arm64") {
    const armZip = release.assets.find(
      (a) => /-arm64-mac\.zip$/i.test(a.name) && !isBlockmap(a.name),
    );
    if (armZip) return armZip;
    return (
      release.assets.find(
        (a) => /-arm64\.dmg$/i.test(a.name) && !isBlockmap(a.name),
      ) ?? null
    );
  }

  // intel: zip-without-arm64, then dmg-without-arm64
  const intelZip = release.assets.find(
    (a) =>
      /-mac\.zip$/i.test(a.name) &&
      !/-arm64-/i.test(a.name) &&
      !isBlockmap(a.name),
  );
  if (intelZip) return intelZip;
  return (
    release.assets.find(
      (a) =>
        /\.dmg$/i.test(a.name) &&
        !/-arm64/i.test(a.name) &&
        !isBlockmap(a.name),
    ) ?? null
  );
}
