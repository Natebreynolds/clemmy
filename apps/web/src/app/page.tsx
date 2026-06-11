import dynamic from "next/dynamic";
import { Hero } from "@/components/Hero";
import { Stats } from "@/components/Stats";
import { Flywheel } from "@/components/Flywheel";

// Below-the-fold sections are code-split; Hero/Stats/Flywheel stay eager so
// first paint and the first scroll are instant.
const LiveAgent = dynamic(() => import("@/components/LiveAgent").then((m) => m.LiveAgent));
const Primitives = dynamic(() => import("@/components/Primitives").then((m) => m.Primitives));
const Featured = dynamic(() => import("@/components/Featured").then((m) => m.Featured));
const ConsoleTour = dynamic(() => import("@/components/ConsoleTour").then((m) => m.ConsoleTour));
const ConnectedMarquee = dynamic(() => import("@/components/ConnectedMarquee").then((m) => m.ConnectedMarquee));
const Channels = dynamic(() => import("@/components/Channels").then((m) => m.Channels));
const TrustGradient = dynamic(() => import("@/components/TrustGradient").then((m) => m.TrustGradient));
const Architecture = dynamic(() => import("@/components/Architecture").then((m) => m.Architecture));
const DownloadCTA = dynamic(() => import("@/components/DownloadCTA").then((m) => m.DownloadCTA));
const Footer = dynamic(() => import("@/components/Footer").then((m) => m.Footer));

export default function Home() {
  return (
    <main className="min-h-screen">
      <Hero />
      <Stats />
      <Flywheel />
      <LiveAgent />
      <Primitives />
      <Featured />
      <ConsoleTour />
      <ConnectedMarquee />
      <Channels />
      <TrustGradient />
      <Architecture />
      <DownloadCTA />
      <Footer />
    </main>
  );
}
