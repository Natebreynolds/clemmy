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
    title: "Clementine — your always-on local AI",
    description:
      "Persistent memory. Every tool you use. Runs in the background on your Mac.",
    images: ["/og.png"],
  },
  icons: { icon: [{ url: "/logo.png", type: "image/png" }] },
};

export const viewport: Viewport = {
  themeColor: "#fbf6ef",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased font-sans grain">{children}</body>
    </html>
  );
}
