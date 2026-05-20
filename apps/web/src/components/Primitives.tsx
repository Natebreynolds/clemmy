"use client";

import { motion } from "framer-motion";
import { Brain, Wrench, ShieldCheck } from "lucide-react";
import { Section } from "./ui/Section";
import { fadeUp, stagger } from "@/lib/motion";

const items = [
  {
    icon: Brain,
    title: "One memory spine",
    bullets: [
      "Markdown vault as the floor",
      "SQLite FTS + embeddings",
      "Working memory + session briefs",
    ],
    body:
      "Persistent across sessions, cleaned and re-summarized in the background. She remembers your projects, preferences, and the rhythm of your work — because the runtime knows where to find them.",
  },
  {
    icon: Wrench,
    title: "One tool surface",
    bullets: [
      "Local SDK + computer-use",
      "MCP-discovered (40+ servers)",
      "Composio broker (200+ apps)",
    ],
    body:
      "All on a single, namespaced surface. The model sees a compact list, not a dump of every schema, and discovers what it needs on demand.",
  },
  {
    icon: ShieldCheck,
    title: "One trust gradient",
    bullets: [
      "read · write · execute · send · admin",
      "Hard denylist always enforced",
      "Admin actions always ask",
    ],
    body:
      "Every tool flows through a single classifier, gated by the scope policy you set: strict, workspace, or yolo.",
  },
];

export function Primitives() {
  return (
    <Section
      eyebrow="The pitch in three primitives"
      title={
        <>
          One memory. One tool surface.
          <br />
          <span className="text-[var(--ink-dim)]">One trust policy.</span>
        </>
      }
      intro="Clementine isn't a chatbot you call. She's an assistant that already knows your context, has access to the things you already use, and asks before she does something irreversible."
    >
      <motion.div
        variants={stagger}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-80px" }}
        className="grid gap-6 md:grid-cols-3"
      >
        {items.map(({ icon: Icon, title, bullets, body }, i) => (
          <motion.div
            variants={fadeUp}
            key={title}
            whileHover={{ y: -3 }}
            transition={{ type: "spring", stiffness: 200, damping: 22 }}
            className="group relative overflow-hidden rounded-2xl bg-white/[0.02] p-7 ring-1 ring-white/10 hover:ring-clem-400/30 transition-all"
          >
            <div className="absolute -top-24 -right-24 h-48 w-48 rounded-full bg-clem-500/[0.12] blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-clem-300/60 mb-3">
              {String(i + 1).padStart(2, "0")}
            </div>
            <Icon className="h-7 w-7 text-clem-400" />
            <h3 className="mt-5 text-xl font-semibold tracking-tight">{title}</h3>
            <ul className="mt-4 space-y-2">
              {bullets.map((b) => (
                <li
                  key={b}
                  className="flex items-start gap-2 text-[13px] text-white/85"
                >
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-clem-400/80" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-[13px] leading-relaxed text-[var(--ink-dim)]">{body}</p>
          </motion.div>
        ))}
      </motion.div>
    </Section>
  );
}
