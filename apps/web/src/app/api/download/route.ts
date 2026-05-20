import { NextRequest, NextResponse } from "next/server";
import { getLatestRelease, pickMacAsset } from "@/lib/github-release";

const RELEASES_FALLBACK = "https://github.com/Natebreynolds/clemmy/releases/latest";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function redirectNoStore(url: string) {
  const res = NextResponse.redirect(url, 302);
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.headers.set("Pragma", "no-cache");
  return res;
}

export async function GET(req: NextRequest) {
  const archParam = req.nextUrl.searchParams.get("arch");
  const arch: "arm64" | "intel" = archParam === "intel" ? "intel" : "arm64";

  const release = await getLatestRelease();
  if (!release) {
    return redirectNoStore(RELEASES_FALLBACK);
  }

  const asset = pickMacAsset(release, arch);
  if (!asset) {
    return redirectNoStore(release.html_url);
  }

  return redirectNoStore(asset.browser_download_url);
}
