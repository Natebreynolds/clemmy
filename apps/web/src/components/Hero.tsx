"use client";

import { useEffect, useRef } from "react";
import {
  motion,
  useSpring,
  useTransform,
  useMotionValue,
} from "framer-motion";
import { Apple } from "lucide-react";
import { PrimaryButton, GhostButton } from "./ui/Button";

export function Hero() {
  const deviceRef = useRef<HTMLDivElement>(null);

  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const springConfig = { stiffness: 90, damping: 18, mass: 0.6 };
  const tiltX = useSpring(useTransform(mouseY, [-1, 1], [3, -3]), springConfig);
  const tiltY = useSpring(useTransform(mouseX, [-1, 1], [-3, 3]), springConfig);
  const auraX = useSpring(useTransform(mouseX, [-1, 1], [-14, 14]), springConfig);
  const auraY = useSpring(useTransform(mouseY, [-1, 1], [-8, 8]), springConfig);

  useEffect(() => {
    const el = deviceRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
      const y = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
      mouseX.set(Math.max(-1.2, Math.min(1.2, x)));
      mouseY.set(Math.max(-1.2, Math.min(1.2, y)));
    };
    const onLeave = () => { mouseX.set(0); mouseY.set(0); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
    };
  }, [mouseX, mouseY]);

  return (
    <section className="relative min-h-screen overflow-hidden bg-[var(--bg)]">
      <div className="absolute inset-0 radial-glow" />
      <div className="absolute inset-0 dot-grid opacity-70" />
      <motion.div
        style={{ x: auraX, y: auraY }}
        className="pointer-events-none absolute inset-0"
      >
        <div className="absolute left-1/2 top-[58%] -translate-x-1/2 -translate-y-1/2 h-[55vh] w-[70vw] rounded-[50%] bg-clem-400/25 blur-[160px]" />
      </motion.div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <header className="flex items-center justify-between px-6 py-5 sm:px-10 z-30">
          <a href="/" className="flex items-center gap-2.5 group">
            <Logo className="h-9 w-9 drop-shadow-[0_2px_8px_rgba(249,115,22,0.25)] transition-transform group-hover:scale-105" />
            <span className="font-semibold text-[15px] tracking-tight text-[var(--ink-strong)]">Clementine</span>
          </a>
          <nav className="hidden sm:flex items-center gap-8 text-sm text-[var(--ink-dim)]">
            <a href="#flywheel" className="hover:text-[var(--ink-strong)] transition-colors">How it works</a>
            <a href="#capabilities" className="hover:text-[var(--ink-strong)] transition-colors">Capabilities</a>
            <a href="#trust" className="hover:text-[var(--ink-strong)] transition-colors">Trust</a>
            <a
              href="https://github.com/Natebreynolds/clemmy"
              target="_blank"
              rel="noreferrer"
              className="hover:text-[var(--ink-strong)] transition-colors"
            >
              GitHub
            </a>
          </nav>
        </header>

        <div className="px-6 pt-4 sm:pt-6 text-center">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="mb-5 inline-flex items-center gap-2 rounded-full bg-white/80 px-3.5 py-1.5 text-xs font-mono tracking-wide ring-1 ring-black/10 text-[var(--ink-dim)] backdrop-blur"
          >
            <span className="size-1.5 rounded-full bg-clem-500 animate-pulse" />
            Local. Persistent. Always on.
          </motion.div>
          <h1 className="mx-auto max-w-4xl text-[40px] sm:text-5xl lg:text-6xl font-semibold leading-[1.02] tracking-tight text-[var(--ink-strong)]">
            <RevealText delay={0.0}>Your always-on</RevealText>{" "}
            <RevealText delay={0.18} gradient>
              local AI.
            </RevealText>
          </h1>
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.45 }}
            className="mt-5 mx-auto max-w-2xl text-base sm:text-lg leading-relaxed text-[var(--ink-dim)]"
          >
            Persistent memory. Every tool you use.{" "}
            <span className="text-clem-700 font-medium">Sits in your meetings —</span>{" "}
            <span className="text-[var(--ink-strong)] font-medium">no bot joins the call.</span>{" "}
            Runs in the background on your Mac.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.55 }}
            className="mt-9 flex flex-wrap items-center justify-center gap-3"
          >
            <PrimaryButton href="/api/download?arch=arm64">
              <Apple className="h-4 w-4" />
              Download for Mac
            </PrimaryButton>
            <GhostButton href="#flywheel">See how it works</GhostButton>
          </motion.div>
          <div className="mt-5 font-mono text-[11px] text-[var(--ink-faint)]">
            macOS 13+ · Apple Silicon &amp; Intel · signed &amp; notarized
          </div>
        </div>

        <div className="flex-1 flex items-end justify-center px-4 sm:px-8 pb-10 sm:pb-16 [perspective:1800px] min-h-0 pt-8">
          <motion.div
            ref={deviceRef}
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 1.0, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
            style={{
              rotateX: tiltX,
              rotateY: tiltY,
              transformStyle: "preserve-3d",
            }}
            className="relative w-full max-w-[1180px] aspect-[16/10] max-h-[62vh]"
          >
            <div className="pointer-events-none absolute -inset-px rounded-xl ring-1 ring-black/15 shadow-[0_50px_120px_-30px_rgba(80,40,10,0.35)] z-30" />
            <div className="pointer-events-none absolute left-0 right-0 top-0 h-8 rounded-t-xl bg-gradient-to-b from-black/[0.05] to-transparent z-20">
              <div className="flex items-center gap-1.5 px-4 py-2.5">
                <span className="size-2.5 rounded-full bg-red-400" />
                <span className="size-2.5 rounded-full bg-yellow-400" />
                <span className="size-2.5 rounded-full bg-green-400" />
              </div>
            </div>
            <div className="pointer-events-none absolute inset-0 rounded-xl overflow-hidden z-10">
              <div className="absolute -inset-y-2 -left-1/3 w-1/3 rotate-12 bg-gradient-to-r from-transparent via-white/40 to-transparent animate-sheen" />
            </div>
            <div
              className="absolute inset-0 rounded-xl overflow-hidden"
              style={{
                backgroundImage: 'url("/screenshots/dashboard.png")',
                backgroundSize: "cover",
                backgroundPosition: "top center",
              }}
            />
          </motion.div>
        </div>
      </div>
    </section>
  );
}

function RevealText({
  children,
  delay = 0,
  gradient = false,
}: {
  children: string;
  delay?: number;
  gradient?: boolean;
}) {
  return (
    <span className="inline-block overflow-hidden align-bottom">
      <motion.span
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        transition={{ duration: 0.9, delay, ease: [0.16, 1, 0.3, 1] }}
        className={
          "inline-block " +
          (gradient
            ? "bg-gradient-to-r from-clem-500 via-clem-600 to-clem-700 bg-clip-text text-transparent"
            : "")
        }
      >
        {children}
      </motion.span>
    </span>
  );
}

function Logo({ className }: { className?: string }) {
  return (
    <img
      src="/logo.png"
      alt="Clementine"
      width={36}
      height={36}
      className={className}
      style={{ imageRendering: "pixelated" }}
    />
  );
}
