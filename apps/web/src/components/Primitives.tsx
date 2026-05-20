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
      "Markdown vault — your notes, your format",
      "SQLite FTS + embeddings, indexed in the background",
      "Working memory carries context between sessions",
      "Every meeting, decision, and tool result writes here",
    ],
    body:
      "Tomorrow morning she opens already knowing what you shipped, what slipped, what's due, and what tools worked for what task. Nothing to re-explain.",
  },
  {
    icon: Wrench,
    title: "One tool surface",
    bullets: [
      "200+ Composio apps — Gmail, Slack, Sheets, Notion, Linear",
      "40+ MCP servers, hot-reloaded from the dashboard",
      "Computer-use — write files, run shells, edit code",
      "Custom skills — drop SKILL.md and she finds it",
    ],
    body:
      "She uses the things you already pay for. No new dashboard to learn. No new keys for half the integrations — Composio handles auth once.",
  },
  {
    icon: ShieldCheck,
    title: "One trust gradient",
    bullets: [
      "read · write · execute · send · admin — five lanes",
      "Hard denylist for rm -rf, sudo, disk wipes — always",
      "Plan-scoped auto-approval: approve a plan, the steps go",
      "Append-only audit log of every tool call",
    ],
    body:
      "She moves fast on safe work and stops at irreversible ones. You set the scope; the policy does the rest.",
  },
];

export function Primitives() {
  return (
    <Section
      eyebrow="Three primitives, end to end"
      title={
        <>
          One memory. One tool surface.
          <br />
          <span className="text-[var(--ink-dim)]">One trust policy.</span>
        </>
      }
      intro="Most agents bolt features together. Clementine is built on three primitives the runtime never violates — that's how she stays predictable as you teach her more."
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
            className="group relative overflow-hidden card-surface p-7 transition-all"
          >
            <div className="absolute -top-24 -right-24 h-48 w-48 rounded-full bg-clem-500/[0.10] blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-clem-700/70 mb-3">
              {String(i + 1).padStart(2, "0")}
            </div>
            <Icon className="h-7 w-7 text-clem-600" />
            <h3 className="mt-5 text-xl font-semibold tracking-tight text-[var(--ink-strong)]">{title}</h3>
            <ul className="mt-4 space-y-2">
              {bullets.map((b) => (
                <li
                  key={b}
                  className="flex items-start gap-2 text-[13px] text-[var(--ink)]"
                >
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-clem-500" />
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
