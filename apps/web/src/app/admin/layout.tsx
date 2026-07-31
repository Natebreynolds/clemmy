import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Clementine — licensing admin",
  // The panel is reachable from anywhere Nathan is, which means it is also
  // reachable by crawlers. Keep every /admin URL out of indexes and referrers.
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function AdminRootLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen">{children}</div>;
}
