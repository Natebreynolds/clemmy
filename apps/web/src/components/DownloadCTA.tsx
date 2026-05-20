"use client";

import { motion } from "framer-motion";
import { Apple, Github, Terminal, ShieldCheck, Cpu, HardDrive } from "lucide-react";
import { PrimaryButton, GhostButton } from "./ui/Button";

export function DownloadCTA() {
  return (
    <section className="relative overflow-hidden px-6 py-32 sm:py-44">
      {/* Big radial glow */}
      <div className="radial-glow absolute inset-0" />
      <div className="absolute inset-0 dot-grid opacity-40" />
      <motion.div
        animate={{ opacity: [0.5, 0.9, 0.5] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[60vh] w-[80vw] rounded-[50%] bg-clem-500/20 blur-[140px]"
      />

      <div className="relative max-w-4xl mx-auto text-center">
        {/* Logo orb */}
        <motion.div
          initial={{ opacity: 0, scale: 0.85 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto mb-8"
        >
          <div className="relative inline-block">
            <div className="absolute inset-0 rounded-full bg-clem-500/40 blur-2xl animate-pulse" />
            <img
              src="/logo.png"
              alt=""
              width={88}
              height={88}
              className="relative"
              style={{ imageRendering: "pixelated" }}
            />
          </div>
        </motion.div>

        <motion.h2
          initial={{ opacity: 0, y: 18 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="text-5xl sm:text-7xl font-semibold leading-[1] tracking-tight"
        >
          Bring her home.
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.7, delay: 0.1 }}
          className="mt-6 text-lg sm:text-xl text-[var(--ink-dim)]"
        >
          Signed, notarized, free. Drag to Applications. Tell her what to do.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.7, delay: 0.2 }}
          className="mt-12 flex flex-wrap items-center justify-center gap-3"
        >
          <PrimaryButton href="/api/download?arch=arm64" className="text-base px-8 py-5">
            <Apple className="h-5 w-5" />
            Download for Mac · Apple Silicon
          </PrimaryButton>
          <GhostButton href="/api/download?arch=intel">Intel Mac</GhostButton>
        </motion.div>

        {/* Spec strip */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.7, delay: 0.3 }}
          className="mt-10 mx-auto inline-flex flex-wrap items-center justify-center gap-x-6 gap-y-3 rounded-2xl bg-white/[0.02] px-6 py-4 ring-1 ring-white/10 backdrop-blur"
        >
          <SpecChip icon={Cpu}        label="macOS 13+" />
          <Divider />
          <SpecChip icon={HardDrive}  label="~120 MB" />
          <Divider />
          <SpecChip icon={ShieldCheck} label="Signed · Notarized" />
          <Divider />
          <SpecChip icon={Terminal}   label="MIT" />
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.7, delay: 0.4 }}
          className="mt-12 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-[var(--ink-dim)]"
        >
          <a
            href="https://github.com/Natebreynolds/clemmy"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 hover:text-white transition-colors"
          >
            <Github className="h-4 w-4" />
            View on GitHub
          </a>
          <a
            href="https://github.com/Natebreynolds/clemmy#run-from-source-development"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 hover:text-white transition-colors"
          >
            <Terminal className="h-4 w-4" />
            Build from source
          </a>
          <a
            href="https://github.com/Natebreynolds/clemmy/releases"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 hover:text-white transition-colors"
          >
            All releases
          </a>
        </motion.div>
      </div>
    </section>
  );
}

function SpecChip({ icon: Icon, label }: { icon: typeof Cpu; label: string }) {
  return (
    <div className="inline-flex items-center gap-2 text-sm text-white/85">
      <Icon className="h-4 w-4 text-clem-300" />
      <span className="font-mono text-[12px] tracking-tight">{label}</span>
    </div>
  );
}

function Divider() {
  return <span className="hidden sm:inline h-3 w-px bg-white/15" />;
}
