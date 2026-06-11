"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { X, Maximize2 } from "lucide-react";
import { Section } from "./ui/Section";
import { fadeUp, stagger } from "@/lib/motion";

type Shot = {
  src: string;
  eyebrow: string;
  caption: string;
  alt: string;
};

const SHOTS: Shot[] = [
  {
    src: "/screenshots/dashboard.png",
    eyebrow: "Chat",
    caption: "The command center — ask, watch her work, approve what counts.",
    alt: "Clementine console chat screen with a conversation about what she can take off your plate this week",
  },
  {
    src: "/screenshots/memory.jpg",
    eyebrow: "Memory",
    caption: "Everything she knows, as a living constellation. Tap a node to explore.",
    alt: "Clementine memory screen showing fact counts and a colorful 3D knowledge constellation",
  },
  {
    src: "/screenshots/automate.png",
    eyebrow: "Automate",
    caption: "Workflows, schedules, and skills — built in chat, running on cron.",
    alt: "Clementine automate screen with workflow cards like morning-briefing and weekly-pipeline-report",
  },
  {
    src: "/screenshots/inbox.png",
    eyebrow: "Inbox",
    caption: "Approvals and outcomes in one place. Empty means she's handled it.",
    alt: "Clementine inbox screen showing the 'You're all caught up' empty state",
  },
  {
    src: "/screenshots/connect.png",
    eyebrow: "Connect",
    caption: "Your apps, keys, and MCP servers — connected once, used everywhere.",
    alt: "Clementine connect screen showing connected apps like Airtable, Gmail, Slack, and Salesforce",
  },
];

export function ConsoleTour() {
  const [open, setOpen] = useState<Shot | null>(null);

  return (
    <Section
      id="console"
      eyebrow="The console"
      title={
        <>
          This is what living with her looks like.
          <br />
          <span className="text-[var(--ink-dim)]">Real screenshots, current build.</span>
        </>
      }
      intro="One window on your Mac — chat, memory, automations, approvals, integrations. Scroll through the rooms."
    >
      <motion.div
        variants={stagger}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-60px" }}
        className="-mx-6 flex snap-x snap-mandatory gap-5 overflow-x-auto px-6 pb-4 [scrollbar-width:thin]"
      >
        {SHOTS.map((shot) => (
          <motion.figure
            key={shot.src}
            variants={fadeUp}
            className="group relative w-[82%] sm:w-[58%] lg:w-[46%] shrink-0 snap-center"
          >
            <button
              type="button"
              onClick={() => setOpen(shot)}
              aria-label={`Enlarge screenshot: ${shot.eyebrow}`}
              className="block w-full text-left cursor-zoom-in"
            >
              <div className="relative aspect-[16/10] overflow-hidden rounded-xl ring-1 ring-black/10 shadow-[0_24px_60px_-24px_rgba(80,40,10,0.35)] transition-transform duration-500 group-hover:scale-[1.015]">
                <Image
                  src={shot.src}
                  alt={shot.alt}
                  fill
                  sizes="(max-width: 640px) 82vw, (max-width: 1024px) 58vw, 46vw"
                  className="object-cover object-top"
                />
                <div className="absolute inset-0 ring-1 ring-inset ring-black/5 rounded-xl" />
                <div className="absolute right-3 top-3 rounded-md bg-black/40 p-1.5 text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
                  <Maximize2 className="h-3.5 w-3.5" />
                </div>
              </div>
            </button>
            <figcaption className="mt-3 px-1">
              <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-clem-700">
                {shot.eyebrow}
              </span>
              <span className="ml-2 text-[13px] text-[var(--ink-dim)]">{shot.caption}</span>
            </figcaption>
          </motion.figure>
        ))}
      </motion.div>

      <Lightbox shot={open} onClose={() => setOpen(null)} />
    </Section>
  );
}

function Lightbox({ shot, onClose }: { shot: Shot | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // single focusable element — keep Tab from leaving the dialog
      if (e.key === "Tab") {
        e.preventDefault();
        closeRef.current?.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!shot) return;
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [shot, onKeyDown]);

  return (
    <AnimatePresence>
      {shot && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          role="dialog"
          aria-modal="true"
          aria-label={`${shot.eyebrow} screenshot, enlarged`}
          onClick={onClose}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[#0d0907]/85 p-4 sm:p-10 backdrop-blur-sm"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-5xl"
          >
            <div className="relative aspect-[16/10] overflow-hidden rounded-xl ring-1 ring-white/15 shadow-[0_60px_160px_-40px_rgba(0,0,0,0.9)]">
              <Image
                src={shot.src}
                alt={shot.alt}
                fill
                sizes="(max-width: 1280px) 100vw, 1024px"
                className="object-contain bg-[var(--bg)]"
              />
            </div>
            <div className="mt-3 flex items-center justify-between gap-4">
              <p className="text-sm text-white/75">
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-clem-300 mr-2">
                  {shot.eyebrow}
                </span>
                {shot.caption}
              </p>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close enlarged screenshot"
                className="shrink-0 rounded-full bg-white/10 p-2 text-white ring-1 ring-white/20 transition-colors hover:bg-white/20"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
