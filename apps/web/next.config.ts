import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  // Pin the trace root so the standalone output layout is the same whether
  // Next detects a parent monorepo (local dev) or not (Railway with Root Directory = apps/web).
  outputFileTracingRoot: path.resolve(__dirname),
  reactStrictMode: true,
  // Standalone Railway build has no sharp; screenshots are pre-sized retina
  // assets emitted by scripts/capture-screenshots.ts.
  images: { unoptimized: true },
  experimental: {
    optimizePackageImports: ["lucide-react", "framer-motion"],
  },
};

export default nextConfig;
