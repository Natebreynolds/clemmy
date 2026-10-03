import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clementine — an agent that grows with you",
  description:
    "An ever-learning, local-first AI agent for your Mac. Explore the agent loop, persistent memory, connected tools, projects, and model-pinned specialists.",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ||
      "https://clemmy-production.up.railway.app",
  ),
  openGraph: {
    title: "Clementine — an agent that grows with you",
    description:
      "Your context, your tools, your way of working. One local-first AI agent that learns as you go.",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "The Clementine console — chat with your always-on local AI",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Clementine — an agent that grows with you",
    description:
      "Your context, your tools, your way of working. One local-first AI agent that learns as you go.",
    images: ["/og.png"],
  },
  icons: { icon: [{ url: "/logo.png", type: "image/png" }] },
};

export const viewport: Viewport = {
  themeColor: "#121310",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
