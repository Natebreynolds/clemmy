import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the trace root so the standalone output layout is the same whether
  // Next detects a parent monorepo (local dev) or not (Railway with Root Directory = apps/web).
  outputFileTracingRoot: path.resolve(__dirname),
  reactStrictMode: true,
  // Screenshots are pre-sized retina assets emitted by
  // scripts/capture-screenshots.ts, so there is nothing to optimize.
  // This also keeps /_next/image a 404: sharp IS traced into the standalone
  // output, and turning the optimizer on exposes its image decoders to
  // untrusted input. Keep sharp patched before ever re-enabling it.
  images: { unoptimized: true },
  experimental: {
    optimizePackageImports: ["lucide-react", "framer-motion"],
  },
};

export default nextConfig;
