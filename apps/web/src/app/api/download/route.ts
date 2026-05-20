import { NextRequest, NextResponse } from "next/server";
import { getLatestRelease, pickMacAsset } from "@/lib/github-release";

const RELEASES_FALLBACK = "https://github.com/Natebreynolds/clemmy/releases/latest";

export async function GET(req: NextRequest) {
  const archParam = req.nextUrl.searchParams.get("arch");
  const arch: "arm64" | "intel" = archParam === "intel" ? "intel" : "arm64";

  const release = await getLatestRelease();
  if (!release) {
    return NextResponse.redirect(RELEASES_FALLBACK, 302);
  }

  const asset = pickMacAsset(release, arch);
  if (!asset) {
    return NextResponse.redirect(release.html_url, 302);
  }

  return NextResponse.redirect(asset.browser_download_url, 302);
}
