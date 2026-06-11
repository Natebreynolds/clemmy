"use client";

import { motion } from "framer-motion";
import { Mic2, Brain, ListChecks, Send, Workflow } from "lucide-react";
import { Section } from "./ui/Section";

const STEPS = [
  {
    icon: Mic2,
    eyebrow: "01 · Listens",
    title: "She joins your meetings.",
    body: "Native capture from your Mac — no bot in the participant list. Zoom, Meet, Teams, native calls. Granted Screen Recording once, she handles the rest.",
    accent: "bg-clem-500",
  },
  {
    icon: Brain,
    eyebrow: "02 · Remembers",
    title: "Builds your memory.",
    body: "Transcripts, decisions, action items, and project context all land in your vault. Markdown you can read, search, and own forever. Next session starts knowing yesterday.",
    accent: "bg-clem-600",
  },
  {
    icon: ListChecks,
    eyebrow: "03 · Extracts",
    title: "Turns talk into tasks.",
    body: "Action items, owners, and deadlines structured from every call. \"Send Acme the deck by Thursday\" becomes a real task with the right people pinged.",
    accent: "bg-clem-500",
  },
  {
    icon: Send,
    eyebrow: "04 · Executes",
    title: "Actually gets work done.",
    body: "Drafts the email. Updates the doc. Files the Linear ticket. Books the follow-up. Anything you've connected — she uses. She asks before anything irreversible.",
    accent: "bg-clem-700",
  },
  {
    icon: Workflow,
    eyebrow: "05 · Compounds",
    title: "Becomes a workflow. And reports back.",
    body: "Do something twice — she suggests automating it. Every run carries a goal contract: she validates the work actually met it before calling it done, retries what fails, and delivers the Outcome back to the channel you asked from. The flywheel turns.",
    accent: "bg-clem-600",
  },
];

export function Flywheel() {
  return (
    <Section
      id="flywheel"
      eyebrow="How it works"
      title={
        <>
          From a meeting to a finished task.
          <br />
          <span className="text-[var(--ink-dim)]">In one continuous loop.</span>
        </>
      }
      intro="Most AI tools answer questions. Clementine closes loops. She attends the meeting, files the notes, drafts the follow-ups, books the next step — and remembers it all so the next time the same kind of work happens, she does it faster."
    >
      <div className="relative">
        {/* Connector spine — vertical line on desktop, hidden on mobile */}
        <div className="hidden md:block absolute left-[34px] top-[28px] bottom-[28px] w-px bg-gradient-to-b from-clem-300 via-clem-500/40 to-clem-300" />

        <div className="space-y-4 md:space-y-6">
          {STEPS.map((s, i) => (
            <FlywheelStep key={s.title} step={s} index={i} />
          ))}
        </div>
      </div>
    </Section>
  );
}

function FlywheelStep({
  step,
  index,
}: {
  step: (typeof STEPS)[number];
  index: number;
}) {
  const Icon = step.icon;
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, delay: index * 0.06, ease: [0.16, 1, 0.3, 1] }}
      className="relative md:pl-24"
    >
      {/* Node — circle on the spine */}
      <div className="hidden md:flex absolute left-0 top-0 size-[68px] items-center justify-center">
        <div className="absolute inset-0 rounded-full bg-white ring-1 ring-black/10 shadow-[0_8px_24px_-8px_rgba(80,40,10,0.20)]" />
        <div
          className={
            "relative size-12 rounded-full grid place-items-center shadow-[0_4px_18px_-4px_rgba(249,115,22,0.6)] " +
            step.accent
          }
        >
          <Icon className="h-5 w-5 text-white" />
        </div>
      </div>

      {/* Card */}
      <div className="card-surface p-6 sm:p-7 ring-1 ring-black/[0.06]">
        <div className="flex items-center gap-3 md:hidden mb-3">
          <div className={"size-10 rounded-full grid place-items-center " + step.accent}>
            <Icon className="h-4 w-4 text-white" />
          </div>
          <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-clem-700/80">
            {step.eyebrow}
          </div>
        </div>
        <div className="hidden md:block font-mono text-[11px] uppercase tracking-[0.18em] text-clem-700/80 mb-1.5">
          {step.eyebrow}
        </div>
        <h3 className="text-xl sm:text-2xl font-semibold tracking-tight text-[var(--ink-strong)]">
          {step.title}
        </h3>
        <p className="mt-3 text-[15px] leading-relaxed text-[var(--ink-dim)]">
          {step.body}
        </p>
      </div>
    </motion.div>
  );
}
