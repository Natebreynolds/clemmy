"use client";

import { ReactNode, useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  Plug,
  Mic,
  Brain,
  ShieldCheck,
  MessageSquare,
  Terminal,
  Video,
  Clock,
  Webhook,
  CheckCircle2,
  Sparkles,
  Puzzle,
  Workflow,
  LayoutDashboard,
  Megaphone,
  Wrench,
  FileText,
  Smartphone,
} from "lucide-react";
import { Section } from "./ui/Section";
import { fadeUp, stagger } from "@/lib/motion";

export function Featured() {
  return (
    <Section
      id="capabilities"
      eyebrow="Capabilities"
      title={
        <>
          Everything you already use.
          <br />
          <span className="text-[var(--ink-dim)]">Now she does it for you.</span>
        </>
      }
      intro="The headline capabilities — and the long tail underneath. Every one runs through the same memory, the same tools, and the same approval policy."
    >
      <div className="space-y-6">
        <FeatureRow
          eyebrow="Meeting capture · zero meeting bots"
          title="She sits in. Nobody else has to know."
          body="Grant Screen Recording once. Clementine detects Zoom, Meet, Teams, and native calls — captures and transcribes them from your machine. No 'Otter has joined' moment, no extra bot in the participant list. Every meeting becomes structured notes, action items, and follow-up drafts you can ship."
          icon={Video}
          preview={<MeetingRecording />}
        />
        <FeatureRow
          eyebrow="200+ apps · 40+ MCP servers"
          title="Reaches every tool you already pay for."
          body="Connect Composio once and she uses Gmail, Slack, Notion, Sheets, Calendar, Linear, Stripe, Airtable, and 200+ more. Drop an MCP server into the dashboard and she picks it up live — DataForSEO, Supabase, Hostinger, ElevenLabs, Apify, Bright Data, Playwright. No daemon restart, no rebuild."
          icon={Plug}
          preview={<ToolOrbit />}
        />
        <div className="grid gap-6 md:grid-cols-2">
          <FeatureRow
            eyebrow="Voice · OpenAI Realtime"
            title="Talk to her like a coworker."
            body="Push-to-talk in the dashboard. Spoken commands route into the same local agent — same memory, same tools, same approvals. Great for hands-free starts on a long task."
            icon={Mic}
            compact
            preview={<VoiceWave />}
          />
          <FeatureRow
            eyebrow="Memory spine"
            title="Learns what works. Remembers it."
            body="Markdown vault + SQLite FTS + semantic embeddings. Decisions, wins, tool choices, and project context flow in automatically — then get consolidated: near-duplicate memories merge (with guards so facts about different clients never blur together), and what you use most stays sharpest. Explore all of it as a 3D constellation in the console."
            icon={Brain}
            compact
            preview={<ConstellationPreview />}
          />
        </div>
        <FeatureRow
          eyebrow="Workflows · runs on schedule"
          title="Automate what you do twice."
          body="Define a workflow once — morning briefing, weekly review, post-meeting follow-up, on-call summary — and she runs it on cron. Or trigger it from voice, webhook, or Discord. Workflows pull from memory, call tools, and report back without fail. Silent failure is a bug."
          icon={Workflow}
          preview={<WorkflowsPreview />}
        />
        <FeatureRow
          eyebrow="Workspaces · self-running surfaces"
          title="She doesn't just answer. She builds you software."
          body="Ask for a tracker, a live report, a planning board — and Clementine writes you a real interactive page that keeps itself up to date on a schedule, with no model in the loop while it runs. A CRM fed by your pipeline workflow. A campaign dashboard that refreshes every morning. Open it, click around, edit rows — it's yours."
          icon={LayoutDashboard}
          preview={<SpacesPreview />}
        />
        <div className="grid gap-6 md:grid-cols-2">
          <FeatureRow
            eyebrow="Outcomes · goal contracts"
            title="Every run reports back."
            body="Each run carries a goal contract — she validates the result actually met it before calling it done. The Outcome lands back in the channel you asked from: done, partial, or failed, with artifacts and the next step. In chat, she says it out loud."
            icon={Megaphone}
            compact
            preview={<OutcomePreview />}
          />
          <FeatureRow
            eyebrow="Reliability · self-healing"
            title="Fails loudly. Fixes quietly."
            body="A failing step gets diagnosed, not buried: transient errors retry with backoff, broken workflows propose their own fixes, and a circuit breaker stops runaway loops. You see one clear outcome instead of a silent stall."
            icon={Wrench}
            compact
            preview={<SelfHealPreview />}
          />
        </div>
        <FeatureRow
          eyebrow="Skills · drop-in extensibility"
          title="Teach her in plain markdown."
          body="A skill is a single SKILL.md file in ~/.clementine-next/skills/ that tells her how to do something domain-specific — onboard a new client, run a quarterly close, plan a launch. Drop one in, she finds it and uses it. No code required."
          icon={Puzzle}
          compact
          preview={<SkillsPreview />}
        />
        <FeatureRow
          eyebrow="Trust gradient"
          title="Asks when it counts. Doesn't when it doesn't."
          body="Five categories — read · write · execute · send · admin. One classifier routes every tool call. Hard denylist always enforced. Admin tools always ask. You change the scope policy from the dashboard."
          icon={ShieldCheck}
          compact
          preview={<ApprovalFlow />}
        />
      </div>

      {/* And also */}
      <div className="mt-16">
        <div className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--ink-dim)] mb-6">
          and also
        </div>
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
          className="grid gap-px overflow-hidden rounded-2xl bg-black/[0.08] sm:grid-cols-2 lg:grid-cols-4"
        >
          {[
            { icon: MessageSquare, title: "Discord bot", body: "DM her or post in a bot channel. Inline approval buttons run her from your phone." },
            { icon: Terminal, title: "Computer-use", body: "Write files, run shell commands, edit code. Gated by your scope policy, hard denylist absolute." },
            { icon: Clock, title: "Scheduled tasks", body: "Pre-configured morning briefing, end-of-day, weekly review. Add your own cron from the dashboard." },
            { icon: Webhook, title: "Webhook & API", body: "POST a task and walk away. NDJSON streaming on /chat/stream. Wire her into Raycast or Shortcuts." },
            { icon: FileText, title: "File ingestion", body: "Drop in a PDF, DOCX, XLSX — or paste a YouTube link. She reads it straight into memory." },
            { icon: Smartphone, title: "Mobile web", body: "Open the console from your phone — secure tunnel, rotating PIN. Approvals on the go." },
            { icon: ShieldCheck, title: "Audit log", body: "Append-only NDJSON record of every tool call. The substrate for the always-learning loop." },
            { icon: Brain, title: "Bring your model", body: "Sign in with ChatGPT or Claude, or bring your own API key. Switch backends from Settings." },
          ].map(({ icon: Icon, title, body }) => (
            <motion.div
              key={title}
              variants={fadeUp}
              className="group relative bg-[var(--bg-elev)] p-6 transition-colors hover:bg-clem-50/40"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-clem-500/12 ring-1 ring-clem-500/25">
                <Icon className="h-4 w-4 text-clem-700" />
              </div>
              <h3 className="mt-4 text-[15px] font-semibold tracking-tight text-[var(--ink-strong)]">{title}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--ink-dim)]">{body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </Section>
  );
}

function FeatureRow({
  eyebrow,
  title,
  body,
  icon: Icon,
  preview,
  compact,
}: {
  eyebrow: string;
  title: string;
  body: string;
  icon: typeof Plug;
  preview: ReactNode;
  compact?: boolean;
}) {
  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "-80px" }}
      className={
        "group relative overflow-hidden card-surface transition-all hover:ring-clem-400/30 " +
        (compact ? "p-6" : "p-8 md:p-10")
      }
    >
      <div className="absolute -top-32 -right-32 h-64 w-64 rounded-full bg-clem-500/[0.10] blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
      <div
        className={
          "relative grid gap-8 " +
          (compact ? "" : "md:grid-cols-[1fr_1.1fr] md:items-center")
        }
      >
        <div>
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-clem-700">
            <Icon className="h-3.5 w-3.5" />
            {eyebrow}
          </div>
          <h3
            className={
              "mt-3 font-semibold tracking-tight text-[var(--ink-strong)] " +
              (compact ? "text-xl" : "text-3xl md:text-4xl")
            }
          >
            {title}
          </h3>
          <p
            className={
              "mt-3 leading-relaxed text-[var(--ink-dim)] " +
              (compact ? "text-[14px]" : "text-base")
            }
          >
            {body}
          </p>
        </div>
        <div aria-hidden className={"relative " + (compact ? "h-[180px]" : "h-[280px] md:h-[320px]")}>
          {preview}
        </div>
      </div>
    </motion.div>
  );
}

/* ───── Preview: tool orbit ───── */

const TOOLS = [
  { name: "Gmail", c: "#ea4335" },
  { name: "Slack", c: "#611f69" },
  { name: "Notion", c: "#1a1410" },
  { name: "Sheets", c: "#0f9d58" },
  { name: "Drive", c: "#1a73e8" },
  { name: "Calendar", c: "#3a87f0" },
  { name: "Linear", c: "#5e6ad2" },
  { name: "GitHub", c: "#24292e" },
  { name: "Supabase", c: "#3ecf8e" },
  { name: "Stripe", c: "#635bff" },
  { name: "Airtable", c: "#fcb400" },
  { name: "Hostinger", c: "#673de6" },
];

function ToolOrbit() {
  const reducedMotion = useReducedMotion();
  const rings = [
    { count: 4, r: 92, dur: 32, dir: 1 },
    { count: 5, r: 152, dur: 48, dir: -1 },
    { count: 3, r: 210, dur: 64, dir: 1 },
  ];
  const layout: Array<{ tool: typeof TOOLS[number]; ring: number; angle: number; r: number; dur: number; dir: number }> = [];
  let idx = 0;
  rings.forEach((ring, ri) => {
    for (let k = 0; k < ring.count && idx < TOOLS.length; k++, idx++) {
      layout.push({
        tool: TOOLS[idx],
        ring: ri,
        angle: (k / ring.count) * 360 + ri * 17,
        r: ring.r,
        dur: ring.dur,
        dir: ring.dir,
      });
    }
  });

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative aspect-square h-full">
        {rings.map((r, i) => (
          <div
            key={i}
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-clem-700/15"
            style={{ width: r.r * 2, height: r.r * 2 }}
          />
        ))}

        <motion.div
          animate={reducedMotion ? undefined : { scale: [1, 1.06, 1] }}
          transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 size-16 rounded-full bg-gradient-to-br from-clem-300 to-clem-600 shadow-[0_0_70px_rgba(249,115,22,0.6)] ring-2 ring-clem-200"
        >
          <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-transparent to-white/30" />
        </motion.div>

        {rings.map((ring, ri) => (
          <motion.div
            key={ri}
            className="absolute inset-0"
            animate={reducedMotion ? undefined : { rotate: ring.dir * 360 }}
            transition={{ duration: ring.dur, repeat: Infinity, ease: "linear" }}
          >
            {layout
              .filter((c) => c.ring === ri)
              .map(({ tool, angle, r, dur, dir }) => {
                const rad = (angle * Math.PI) / 180;
                // Round so SSR markup and client hydration serialize identically.
                const x = Math.round(Math.cos(rad) * r * 100) / 100;
                const y = Math.round(Math.sin(rad) * r * 100) / 100;
                return (
                  <motion.div
                    key={tool.name}
                    className="absolute left-1/2 top-1/2"
                    style={{ x, y }}
                  >
                    <motion.div
                      animate={reducedMotion ? undefined : { rotate: -dir * 360 }}
                      transition={{ duration: dur, repeat: Infinity, ease: "linear" }}
                      className="-translate-x-1/2 -translate-y-1/2 rounded-full bg-white ring-1 ring-black/10 px-2.5 py-1 flex items-center gap-1.5 shadow-[0_4px_14px_-4px_rgba(80,40,10,0.18)]"
                    >
                      <span
                        className="size-1.5 rounded-full"
                        style={{ background: tool.c, boxShadow: `0 0 6px ${tool.c}` }}
                      />
                      <span className="font-mono text-[10px] tracking-tight text-[var(--ink)] whitespace-nowrap">
                        {tool.name}
                      </span>
                    </motion.div>
                  </motion.div>
                );
              })}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

/* ───── Preview: voice waveform ───── */

function VoiceWave() {
  const reducedMotion = useReducedMotion();
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex items-center gap-1.5 h-24">
        {Array.from({ length: 36 }).map((_, i) => {
          const seed = (i * 37 + 13) % 100;
          const baseH = 8 + (seed % 60);
          return (
            <motion.span
              key={i}
              className="w-1 rounded-full bg-gradient-to-t from-clem-700 to-clem-400"
              style={reducedMotion ? { height: `${baseH}px` } : undefined}
              animate={reducedMotion ? undefined : {
                height: [
                  `${baseH * 0.4}px`,
                  `${baseH * 1.2 + 10}px`,
                  `${baseH * 0.6}px`,
                  `${baseH}px`,
                ],
              }}
              transition={{
                duration: 1.4 + (seed % 10) / 10,
                repeat: Infinity,
                delay: (seed % 20) / 20,
                ease: "easeInOut",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/* ───── Preview: memory constellation ───── */

// Fixed node layout — a small slice of the console's 3D memory constellation,
// drawn as SVG so the marketing site never imports three.js.
const C_NODES: Array<{ x: number; y: number; r: number; c: string; pulse?: boolean }> = [
  { x: 95,  y: 70,  r: 7,   c: "#fb923c", pulse: true },
  { x: 170, y: 45,  r: 4.5, c: "#38bdf8" },
  { x: 230, y: 95,  r: 5.5, c: "#a78bfa" },
  { x: 150, y: 120, r: 4,   c: "#fbbf24" },
  { x: 60,  y: 130, r: 5,   c: "#34d399" },
  { x: 280, y: 55,  r: 4,   c: "#f472b6" },
  { x: 305, y: 130, r: 6,   c: "#fb923c" },
  { x: 215, y: 160, r: 4.5, c: "#38bdf8" },
  { x: 110, y: 175, r: 4,   c: "#a78bfa" },
  { x: 30,  y: 60,  r: 3.5, c: "#fbbf24" },
  { x: 340, y: 90,  r: 3.5, c: "#34d399" },
  { x: 265, y: 185, r: 5,   c: "#f472b6" },
];

const C_EDGES: Array<[number, number]> = [
  [0, 1], [0, 3], [0, 4], [0, 9], [1, 2], [1, 5], [2, 3], [2, 6],
  [2, 7], [3, 8], [5, 10], [6, 10], [6, 11], [7, 11], [4, 8],
];

function ConstellationPreview() {
  const reducedMotion = useReducedMotion();
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative w-full max-w-sm overflow-hidden rounded-xl bg-[#0d0907] ring-1 ring-black/20 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.5)]">
        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2 font-mono text-[9px] uppercase tracking-wider text-white/45">
          <Brain className="h-3 w-3 text-clem-300" />
          memory · 1,046 facts · 120k links
          <span className="ml-auto inline-flex items-center gap-1 text-emerald-300/80 normal-case">
            <span className="size-1 rounded-full bg-emerald-400 animate-pulse" />
            recall
          </span>
        </div>
        <motion.svg
          viewBox="0 0 370 215"
          className="block w-full"
          animate={reducedMotion ? undefined : { scale: [1, 1.04, 1] }}
          transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }}
        >
          {C_EDGES.map(([a, b], i) => (
            <motion.line
              key={i}
              x1={C_NODES[a].x}
              y1={C_NODES[a].y}
              x2={C_NODES[b].x}
              y2={C_NODES[b].y}
              stroke="rgba(251,146,60,0.25)"
              strokeWidth={0.75}
              initial={{ pathLength: 0, opacity: 0 }}
              whileInView={{ pathLength: 1, opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.9, delay: 0.3 + i * 0.05 }}
            />
          ))}
          {C_NODES.map((n, i) => (
            <motion.circle
              key={i}
              cx={n.x}
              cy={n.y}
              r={n.r}
              fill={n.c}
              initial={{ opacity: 0, scale: 0 }}
              whileInView={{ opacity: 0.9, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.06 }}
              style={{ filter: `drop-shadow(0 0 ${n.r}px ${n.c})` }}
            />
          ))}
          {/* recall pulse on the hot node */}
          {!reducedMotion && (
            <motion.circle
              cx={C_NODES[0].x}
              cy={C_NODES[0].y}
              r={8}
              fill="none"
              stroke="#fb923c"
              strokeWidth={1}
              initial={{ r: 8, opacity: 0.8 }}
              animate={{ r: [8, 22], opacity: [0.8, 0] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: "easeOut" }}
            />
          )}
        </motion.svg>
      </div>
    </div>
  );
}

/* ───── Preview: workspaces / spaces ───── */

const SPACE_ROWS = [
  { name: "Spring Pt Push", stage: "Proposal", value: "$18k", tone: "text-amber-700 bg-amber-50 ring-amber-400/40" },
  { name: "Harbor & Co", stage: "Won", value: "$32k", tone: "text-emerald-700 bg-emerald-50 ring-emerald-400/40" },
  { name: "Northside reno", stage: "Call set", value: "$9k", tone: "text-sky-700 bg-sky-50 ring-sky-400/40" },
  { name: "Q3 retainer", stage: "Drafting", value: "$24k", tone: "text-violet-700 bg-violet-50 ring-violet-400/40" },
];

function SpacesPreview() {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-2">
      <div className="w-full max-w-md overflow-hidden rounded-xl bg-white ring-1 ring-black/10 shadow-[0_20px_50px_-20px_rgba(80,40,10,0.3)]">
        {/* browser chrome */}
        <div className="flex items-center gap-1.5 border-b border-black/5 bg-[var(--bg-dim)] px-3 py-2">
          <span className="size-2 rounded-full bg-red-400" />
          <span className="size-2 rounded-full bg-yellow-400" />
          <span className="size-2 rounded-full bg-green-400" />
          <span className="ml-2 flex-1 truncate rounded bg-white/70 px-2 py-0.5 font-mono text-[9px] text-[var(--ink-dim)]">
            workspaces / pipeline-tracker
          </span>
          <span className="font-mono text-[8px] uppercase tracking-wider text-emerald-700 bg-emerald-50 ring-1 ring-emerald-400/40 rounded px-1.5 py-0.5 whitespace-nowrap">
            auto · 7:00 AM · no LLM
          </span>
        </div>
        <div className="px-3 py-2.5">
          <div className="grid grid-cols-[1.4fr_1fr_0.6fr] gap-2 pb-1.5 font-mono text-[9px] uppercase tracking-wider text-[var(--ink-faint)]">
            <span>Deal</span><span>Stage</span><span className="text-right">Value</span>
          </div>
          {SPACE_ROWS.map((r, i) => (
            <motion.div
              key={r.name}
              initial={{ opacity: 0, x: -10 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.45, delay: 0.2 + i * 0.12 }}
              className="grid grid-cols-[1.4fr_1fr_0.6fr] items-center gap-2 border-t border-black/[0.05] py-2"
            >
              <span className="truncate text-[12px] font-medium text-[var(--ink-strong)]">{r.name}</span>
              <span className={"inline-flex w-fit rounded-full px-2 py-0.5 text-[10px] ring-1 " + r.tone}>{r.stage}</span>
              <span className="text-right font-mono text-[11px] text-[var(--ink-dim)]">{r.value}</span>
            </motion.div>
          ))}
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.9 }}
            className="mt-2 flex items-center gap-1.5 font-mono text-[9px] text-[var(--ink-faint)]"
          >
            <span className="size-1 rounded-full bg-emerald-500" />
            built by Clementine · refreshed 4 min ago
          </motion.div>
        </div>
      </div>
    </div>
  );
}

/* ───── Preview: outcome report-back ───── */

function OutcomePreview() {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-2">
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        whileInView={{ opacity: 1, y: 0, scale: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-sm rounded-xl bg-white ring-1 ring-black/10 p-4 shadow-[0_16px_40px_-16px_rgba(80,40,10,0.25)]"
      >
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 ring-1 ring-emerald-400/40 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" />
            done
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--ink-faint)]">
            outcome · weekly-pipeline-report
          </span>
        </div>
        <div className="mt-3 space-y-1.5">
          {[
            "Report generated — 4 deals moved stage",
            "Delivered to chat + Discord",
            "Goal contract validated",
          ].map((t, i) => (
            <motion.div
              key={t}
              initial={{ opacity: 0, x: -8 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.35 + i * 0.18, duration: 0.4 }}
              className="flex items-center gap-2 text-[12.5px] text-[var(--ink)]"
            >
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
              {t}
            </motion.div>
          ))}
        </div>
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 1 }}
          className="mt-3 flex items-center gap-2 rounded-lg bg-clem-50/80 ring-1 ring-clem-400/30 px-2.5 py-1.5 text-[11.5px] text-clem-800"
        >
          <Megaphone className="h-3.5 w-3.5 shrink-0" />
          &ldquo;Pipeline report's done — four deals moved. One needs you.&rdquo;
        </motion.div>
      </motion.div>
    </div>
  );
}

/* ───── Preview: self-healing steps ───── */

function SelfHealPreview() {
  const reducedMotion = useReducedMotion();
  return (
    <div className="absolute inset-0 flex items-center justify-center p-2">
      <div className="w-full max-w-sm space-y-1.5 font-mono text-[11.5px]">
        <motion.div
          initial={{ opacity: 0, x: -8 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.1 }}
          className="flex items-center gap-2 rounded-lg bg-white ring-1 ring-black/10 px-3 py-2 text-[var(--ink)]"
        >
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          step 1 · pull pipeline
          <span className="ml-auto text-[10px] text-[var(--ink-faint)]">1.2s</span>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, x: -8 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.3 }}
          className="rounded-lg bg-white ring-1 ring-amber-400/40 px-3 py-2 text-[var(--ink)]"
        >
          <div className="flex items-center gap-2">
            <span className="inline-grid size-3.5 place-items-center rounded-full bg-red-100 text-[9px] text-red-600 ring-1 ring-red-400/50">✗</span>
            step 2 · update sheet
            <span className="ml-auto text-[10px] text-red-500">429</span>
          </div>
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.7 }}
            className="mt-1.5 flex items-center gap-1.5 pl-5 text-[10px] text-amber-700"
          >
            <motion.span
              animate={reducedMotion ? undefined : { opacity: [1, 0.4, 1] }}
              transition={{ duration: 1.4, repeat: Infinity }}
              className="size-1.5 rounded-full bg-amber-500"
            />
            diagnosed: rate limit → backoff 2s → retry
          </motion.div>
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 1.3 }}
            className="mt-1 flex items-center gap-1.5 pl-5 text-[10px] text-emerald-700"
          >
            <CheckCircle2 className="h-3 w-3" />
            retry succeeded
          </motion.div>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, x: -8 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 1.6 }}
          className="flex items-center gap-2 rounded-lg bg-white ring-1 ring-black/10 px-3 py-2 text-[var(--ink)]"
        >
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          step 3 · deliver outcome
          <span className="ml-auto text-[10px] text-[var(--ink-faint)]">0.8s</span>
        </motion.div>
      </div>
    </div>
  );
}

/* ───── Preview: workflows ───── */

const WORKFLOWS = [
  { name: "Morning brief", schedule: "Daily · 07:30", calls: 4 },
  { name: "Post-meeting follow-up", schedule: "Trigger · meeting.end", calls: 7 },
  { name: "Weekly review", schedule: "Fri · 16:00", calls: 11 },
  { name: "On-call summary", schedule: "Daily · 18:00", calls: 5 },
];

function WorkflowsPreview() {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-2">
      <div className="grid grid-cols-2 gap-2 w-full max-w-md">
        {WORKFLOWS.map((w, i) => (
          <motion.div
            key={w.name}
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.1, duration: 0.5 }}
            className="rounded-lg bg-white ring-1 ring-black/10 p-3 shadow-[0_4px_14px_-6px_rgba(80,40,10,0.15)]"
          >
            <div className="flex items-center gap-2">
              <Workflow className="h-3.5 w-3.5 text-clem-600" />
              <span className="text-[12px] font-semibold tracking-tight text-[var(--ink-strong)]">
                {w.name}
              </span>
            </div>
            <div className="mt-1.5 font-mono text-[10px] text-[var(--ink-dim)]">
              {w.schedule}
            </div>
            <div className="mt-2 flex items-center gap-1 text-[10px] text-[var(--ink-dim)]">
              <span className="size-1 rounded-full bg-emerald-500" />
              {w.calls} tool calls / run
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

/* ───── Preview: skills list ───── */

const SKILLS = [
  { name: "onboard-client.md", size: "1.2k" },
  { name: "q-close.md", size: "2.8k" },
  { name: "launch-plan.md", size: "4.1k" },
  { name: "weekly-1on1.md", size: "0.9k" },
];

function SkillsPreview() {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-2">
      <div className="rounded-lg bg-[#0d0907] ring-1 ring-black/20 p-3 w-full max-w-sm font-mono text-[11px] shadow-[0_8px_24px_-8px_rgba(0,0,0,0.4)]">
        <div className="flex items-center gap-1.5 text-emerald-300/80 text-[10px] mb-2">
          <span className="text-clem-300">~/.clementine-next/skills/</span>
        </div>
        {SKILLS.map((s, i) => (
          <motion.div
            key={s.name}
            initial={{ opacity: 0, x: -4 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.08 }}
            className="flex items-center justify-between py-0.5 text-white/85"
          >
            <span className="text-clem-300">→ {s.name}</span>
            <span className="text-white/40">{s.size}</span>
          </motion.div>
        ))}
        <div className="mt-2 pt-2 border-t border-white/10 text-emerald-300/80 text-[10px]">
          $ clementine skill install zoom-recap
        </div>
      </div>
    </div>
  );
}

/* ───── Preview: approval flow ───── */

function ApprovalFlow() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-2">
      <Pill kind="read" label="vault.search" />
      <Arrow auto />
      <Pill kind="write" label="drive.create_doc" />
      <Arrow auto />
      <Pill kind="send" label="gmail.send · 7 recipients" approval />
      <Arrow done />
      <Pill kind="done" label="logged · 12 wins" />
    </div>
  );
}

function Pill({
  kind,
  label,
  approval,
}: {
  kind: "read" | "write" | "send" | "done";
  label: string;
  approval?: boolean;
}) {
  const colors: Record<typeof kind, string> = {
    read: "bg-sky-50 ring-sky-400/40 text-sky-800",
    write: "bg-emerald-50 ring-emerald-400/40 text-emerald-800",
    send: "bg-amber-50 ring-amber-400/40 text-amber-900",
    done: "bg-clem-50 ring-clem-400/50 text-clem-800",
  };
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true }}
      className={
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] ring-1 " +
        colors[kind]
      }
    >
      <span className="font-mono text-[10px] uppercase opacity-80">{kind}</span>
      {label}
      {approval && (
        <span className="font-mono text-[10px] uppercase text-amber-900 ring-1 ring-amber-400/60 rounded-md px-1.5 py-0.5">
          ask
        </span>
      )}
    </motion.div>
  );
}

function Arrow({ auto, done }: { auto?: boolean; done?: boolean }) {
  return (
    <div className="font-mono text-[10px] text-[var(--ink-dim)] flex items-center gap-1">
      <span className="size-px h-3 w-px bg-black/20" />
      {auto && <span className="text-emerald-700">auto</span>}
      {done && <span className="text-clem-700">approved ✓</span>}
      <span className="size-px h-3 w-px bg-black/20" />
    </div>
  );
}

/* ───── Preview: meeting recording ───── */

type Utterance = { speaker: "R" | "M" | "J"; name: string; text: string };
type Action = { kind: "todo" | "send" | "note"; text: string };

const UTTERANCES: Utterance[] = [
  { speaker: "M", name: "Maya",   text: "Next quarter we should push the partnership deck to Acme before Friday." },
  { speaker: "R", name: "Riley", text: "Agreed. I'll get them a v1 by Thursday EOD." },
  { speaker: "J", name: "Jess",   text: "Should we loop in design earlier this time?" },
  { speaker: "R", name: "Riley", text: "Yeah — let's brief Sam on Monday so they can sketch alongside us." },
];

const ACTIONS: Action[] = [
  { kind: "send", text: "Send Acme draft by Thu EOD" },
  { kind: "todo", text: "Brief Sam (design) Monday" },
  { kind: "note", text: "Q4 partnership push agreed" },
];

function useElapsed(active: boolean) {
  const [secs, setSecs] = useState(1334);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function MeetingRecording() {
  const reducedMotion = useReducedMotion();
  const [step, setStep] = useState(0);
  const [actionStep, setActionStep] = useState(0);
  const [tick, setTick] = useState(0);
  const timer = useElapsed(!reducedMotion);

  useEffect(() => {
    if (reducedMotion) { setStep(UTTERANCES.length); setActionStep(ACTIONS.length); return; }
    if (step >= UTTERANCES.length) {
      const t = window.setTimeout(() => {
        setStep(0);
        setActionStep(0);
        setTick((x) => x + 1);
      }, 2400);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setStep((s) => s + 1), 1900);
    return () => window.clearTimeout(t);
  }, [step, reducedMotion]);

  useEffect(() => {
    if (reducedMotion) return;
    if (actionStep >= ACTIONS.length) return;
    if (step < actionStep + 2) return;
    const t = window.setTimeout(() => setActionStep((s) => s + 1), 400);
    return () => window.clearTimeout(t);
  }, [step, actionStep, reducedMotion]);

  const visible = UTTERANCES.slice(0, step);
  const visibleActions = ACTIONS.slice(0, actionStep);

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden rounded-xl bg-[#0d0907] ring-1 ring-black/20 shadow-[0_30px_60px_-20px_rgba(0,0,0,0.4)]">
      <div className="flex items-center gap-2.5 border-b border-white/5 px-4 py-2.5 text-[11px]">
        <span className="relative inline-flex h-2.5 w-2.5">
          <span className="absolute inset-0 rounded-full bg-red-500/60 animate-ping" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
        </span>
        <span className="font-mono uppercase tracking-wider text-red-300">Meeting live</span>
        <span className="font-mono text-white/40">·</span>
        <span className="font-mono text-white/85">{timer}</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] text-emerald-300/80 font-mono">
          <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Zoom · transcribing
        </span>
      </div>

      <div key={tick} className="flex flex-1 min-h-0">
        <div className="flex-[1.4] overflow-hidden px-4 py-3 space-y-2.5 border-r border-white/5">
          <AnimatePresence initial={false}>
            {visible.map((u, i) => (
              <motion.div
                key={`${tick}-${i}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className="flex gap-2.5"
              >
                <SpeakerBadge speaker={u.speaker} />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] text-white/45 mb-0.5">{u.name}</div>
                  <div className="text-[12.5px] leading-snug text-white/85">{u.text}</div>
                </div>
              </motion.div>
            ))}
            {step < UTTERANCES.length && step > 0 && (
              <motion.div
                key="thinking"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center gap-1.5 pl-9 pt-1"
              >
                <Dot delay={0} />
                <Dot delay={0.15} />
                <Dot delay={0.3} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex-1 min-w-0 px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-clem-300/80 mb-3 flex items-center gap-1.5">
            <Sparkles className="h-3 w-3" />
            captured
          </div>
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {visibleActions.map((a, i) => (
                <motion.div
                  key={`${tick}-act-${i}`}
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.35 }}
                  className="flex items-start gap-2 rounded-md bg-white/[0.03] ring-1 ring-white/10 px-2.5 py-2"
                >
                  <ActionIcon kind={a.kind} />
                  <span className="text-[11.5px] text-white/85 leading-snug">{a.text}</span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

function SpeakerBadge({ speaker }: { speaker: Utterance["speaker"] }) {
  const palette: Record<Utterance["speaker"], string> = {
    R: "bg-clem-500/20 text-clem-200 ring-clem-400/40",
    M: "bg-violet-500/20 text-violet-200 ring-violet-400/40",
    J: "bg-emerald-500/20 text-emerald-200 ring-emerald-400/40",
  };
  return (
    <div className={"shrink-0 h-7 w-7 rounded-full ring-1 grid place-items-center text-[11px] font-semibold " + palette[speaker]}>
      {speaker}
    </div>
  );
}

function ActionIcon({ kind }: { kind: Action["kind"] }) {
  if (kind === "send")
    return (
      <span className="mt-0.5 inline-grid place-items-center size-4 rounded text-[10px] text-amber-300 bg-amber-400/15 ring-1 ring-amber-400/30">
        →
      </span>
    );
  if (kind === "todo")
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />;
  return (
    <span className="mt-0.5 inline-grid place-items-center size-4 rounded text-[10px] text-clem-300 bg-clem-400/15 ring-1 ring-clem-400/30">
      ✎
    </span>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <motion.span
      className="size-1.5 rounded-full bg-white/40"
      animate={{ opacity: [0.3, 1, 0.3] }}
      transition={{ duration: 1.2, repeat: Infinity, delay }}
    />
  );
}
