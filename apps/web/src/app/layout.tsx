import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clementine — your always-on local AI",
  description:
    "Persistent memory. Every tool you use. Runs in the background on your Mac. Clementine is a single-user AI assistant with one memory spine, one tool surface, and one trust policy.",
  metadataBase: new URL("https://clementine.app"),
  openGraph: {
    title: "Clementine — your always-on local AI",
    description:
      "Persistent memory. Every tool you use. Runs in the background on your Mac.",
    images: ["/og.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Clementine — your always-on local AI",
    description:
      "Persistent memory. Every tool you use. Runs in the background on your Mac.",
    images: ["/og.png"],
  },
  icons: { icon: [{ url: "/logo.png", type: "image/png" }] },
};

export const viewport: Viewport = {
  themeColor: "#0a0806",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased font-sans grain">{children}</body>
    </html>
  );
}
