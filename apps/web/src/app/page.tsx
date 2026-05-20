import { Hero } from "@/components/Hero";
import { Stats } from "@/components/Stats";
import { Flywheel } from "@/components/Flywheel";
import { LiveAgent } from "@/components/LiveAgent";
import { Primitives } from "@/components/Primitives";
import { Featured } from "@/components/Featured";
import { ConnectedMarquee } from "@/components/ConnectedMarquee";
import { Channels } from "@/components/Channels";
import { TrustGradient } from "@/components/TrustGradient";
import { Architecture } from "@/components/Architecture";
import { DownloadCTA } from "@/components/DownloadCTA";
import { Footer } from "@/components/Footer";

export default function Home() {
  return (
    <main className="min-h-screen">
      <Hero />
      <Stats />
      <Flywheel />
      <LiveAgent />
      <Primitives />
      <Featured />
      <ConnectedMarquee />
      <Channels />
      <TrustGradient />
      <Architecture />
      <DownloadCTA />
      <Footer />
    </main>
  );
}
