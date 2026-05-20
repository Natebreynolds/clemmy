"use client";

import { ReactNode, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
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
      intro="Five headline capabilities. Seven more underneath. Every one runs through the same memory, the same tools, and the same approval policy."
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
          title="Reaches every tool you use."
          body="Gmail, Slack, Sheets, Notion, Calendar through Composio. DataForSEO, Supabase, Hostinger, ElevenLabs, Apify, Bright Data, and any MCP server you drop in — live-reloaded, no daemon restart."
          icon={Plug}
          preview={<ToolOrbit />}
        />
        <div className="grid gap-6 md:grid-cols-2">
          <FeatureRow
            eyebrow="OpenAI Realtime"
            title="Voice in the dashboard."
            body="Push-to-talk. Spoken commands route into the same local agent — same memory, same tools, same approvals."
            icon={Mic}
            compact
            preview={<VoiceWave />}
          />
          <FeatureRow
            eyebrow="Memory spine"
            title="Remembers what worked."
            body="Markdown vault + SQLite FTS + embeddings. Tool choices that worked once stop being re-discovered every session."
            icon={Brain}
            compact
            preview={<MemoryStack />}
          />
        </div>
        <FeatureRow
          eyebrow="Trust gradient"
          title="Asks when it counts. Doesn't when it doesn't."
          body="Five categories — read · write · execute · send · admin. One classifier routes every tool call. Hard denylist always enforced. Admin tools always ask."
          icon={ShieldCheck}
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
          className="grid gap-px overflow-hidden rounded-2xl bg-white/10 sm:grid-cols-2 lg:grid-cols-4"
        >
          {[
            { icon: MessageSquare, title: "Discord bot", body: "DM her or post in a bot channel. Inline approval buttons run her from your phone." },
            { icon: Terminal, title: "Computer-use", body: "Write files, run shell commands, edit code. Gated by your scope policy, hard denylist absolute." },
            { icon: Clock, title: "Scheduled tasks", body: "Pre-configured morning briefing, end-of-day, weekly review. Add your own from the dashboard." },
            { icon: Webhook, title: "Webhook & API", body: "POST a task and walk away. NDJSON streaming on /chat/stream. Wire her into Raycast or Shortcuts." },
            { icon: Sparkles, title: "Goals & autonomy", body: "Active goals get injected into every cycle. She brings them up — you don't have to remember." },
            { icon: Plug, title: "Plugin system", body: "Drop a package into ~/.clementine-next/plugins/. Adds tools, monitors, channels — no rebuild." },
            { icon: ShieldCheck, title: "Audit log", body: "Append-only NDJSON record of every tool call. The substrate for the always-learning loop." },
            { icon: Brain, title: "Skills", body: "Drop SKILL.md files into ~/.clementine-next/skills/. She'll discover and use them automatically." },
          ].map(({ icon: Icon, title, body }) => (
            <motion.div
              key={title}
              variants={fadeUp}
              className="group relative bg-[var(--bg)] p-6 transition-colors hover:bg-white/[0.02]"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-clem-500/10 ring-1 ring-clem-500/20">
                <Icon className="h-4 w-4 text-clem-300" />
              </div>
              <h3 className="mt-4 text-[15px] font-semibold tracking-tight">{title}</h3>
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
        "group relative overflow-hidden rounded-2xl bg-white/[0.02] ring-1 ring-white/10 hover:ring-clem-400/30 transition-all " +
        (compact ? "p-6" : "p-8 md:p-10")
      }
    >
      <div className="absolute -top-32 -right-32 h-64 w-64 rounded-full bg-clem-500/[0.08] blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
      <div
        className={
          "relative grid gap-8 " +
          (compact ? "" : "md:grid-cols-[1fr_1.1fr] md:items-center")
        }
      >
        <div>
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-clem-300">
            <Icon className="h-3.5 w-3.5" />
            {eyebrow}
          </div>
          <h3
            className={
              "mt-3 font-semibold tracking-tight " +
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
        <div className={"relative " + (compact ? "h-[180px]" : "h-[280px] md:h-[320px]")}>
          {preview}
        </div>
      </div>
    </motion.div>
  );
}

/* ───── Preview: orbiting tool icons ───── */

const TOOLS = [
  { name: "Gmail", c: "#ea4335" },
  { name: "Slack", c: "#611f69" },
  { name: "Notion", c: "#ffffff" },
  { name: "Sheets", c: "#0f9d58" },
  { name: "Drive", c: "#1a73e8" },
  { name: "Calendar", c: "#3a87f0" },
  { name: "Linear", c: "#5e6ad2" },
  { name: "GitHub", c: "#f6f6f6" },
  { name: "Supabase", c: "#3ecf8e" },
  { name: "Stripe", c: "#635bff" },
  { name: "Airtable", c: "#fcb400" },
  { name: "Hostinger", c: "#673de6" },
];

function ToolOrbit() {
  // Distribute 12 tools across 3 rings with explicit pixel orbits
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
        {/* Orbit rings (visual) */}
        {rings.map((r, i) => (
          <div
            key={i}
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-clem-300/12"
            style={{ width: r.r * 2, height: r.r * 2 }}
          />
        ))}

        {/* Core */}
        <motion.div
          animate={{ scale: [1, 1.06, 1] }}
          transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 size-16 rounded-full bg-gradient-to-br from-clem-300 to-clem-600 shadow-[0_0_70px_rgba(249,115,22,0.7)] ring-2 ring-clem-200/40"
        >
          <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-transparent to-white/30" />
        </motion.div>

        {/* Orbiting chips — one rotating wrapper per ring so each chip stays in formation */}
        {rings.map((ring, ri) => (
          <motion.div
            key={ri}
            className="absolute inset-0"
            animate={{ rotate: ring.dir * 360 }}
            transition={{ duration: ring.dur, repeat: Infinity, ease: "linear" }}
          >
            {layout
              .filter((c) => c.ring === ri)
              .map(({ tool, angle, r, dur, dir }) => {
                const rad = (angle * Math.PI) / 180;
                const x = Math.cos(rad) * r;
                const y = Math.sin(rad) * r;
                return (
                  <motion.div
                    key={tool.name}
                    className="absolute left-1/2 top-1/2"
                    style={{ x, y }}
                  >
                    {/* counter-rotate so chips stay upright */}
                    <motion.div
                      animate={{ rotate: -dir * 360 }}
                      transition={{ duration: dur, repeat: Infinity, ease: "linear" }}
                      className="-translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--bg-elev)] ring-1 ring-white/15 px-2.5 py-1 flex items-center gap-1.5 backdrop-blur-sm shadow-[0_6px_24px_rgba(0,0,0,0.55)]"
                    >
                      <span
                        className="size-1.5 rounded-full"
                        style={{ background: tool.c, boxShadow: `0 0 6px ${tool.c}` }}
                      />
                      <span className="font-mono text-[10px] tracking-tight text-white/85 whitespace-nowrap">
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
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex items-center gap-1.5 h-24">
        {Array.from({ length: 36 }).map((_, i) => {
          const seed = (i * 37 + 13) % 100;
          const baseH = 8 + (seed % 60);
          return (
            <motion.span
              key={i}
              className="w-1 rounded-full bg-gradient-to-t from-clem-600 to-clem-300"
              animate={{
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

/* ───── Preview: memory cards ───── */

const NOTES = [
  { tag: "decision", text: "Picked Railway over Vercel — preview env per branch" },
  { tag: "fact", text: "Nathan @ Breakthrough Coaching · macOS · Codex OAuth" },
  { tag: "win", text: "Q4 retro shipped 2026-05-20 · 7 recipients" },
  { tag: "tool", text: "vault.search + gmail.send routinely cluster — preload" },
];

function MemoryStack() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="relative w-full max-w-sm">
        {NOTES.map((n, i) => (
          <motion.div
            key={i}
            initial={{ y: 20, opacity: 0 }}
            whileInView={{ y: 0, opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: i * 0.15 }}
            className="absolute left-0 right-0 rounded-lg bg-[var(--bg-elev)] ring-1 ring-white/10 px-3 py-2.5 shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
            style={{
              top: `${i * 28}px`,
              transform: `rotate(${(i - 1.5) * 1.5}deg)`,
              zIndex: NOTES.length - i,
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-[9px] uppercase tracking-wider text-clem-300 rounded bg-clem-500/15 px-1.5 py-0.5 ring-1 ring-clem-500/30">
                {n.tag}
              </span>
            </div>
            <div className="text-[12px] text-white/85 leading-snug">{n.text}</div>
          </motion.div>
        ))}
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
    read: "bg-sky-400/10 ring-sky-400/30 text-sky-200",
    write: "bg-emerald-400/10 ring-emerald-400/30 text-emerald-200",
    send: "bg-amber-300/10 ring-amber-300/30 text-amber-200",
    done: "bg-clem-400/15 ring-clem-400/30 text-clem-200",
  };
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true }}
      className={
        "inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] ring-1 backdrop-blur " +
        colors[kind]
      }
    >
      <span className="font-mono text-[10px] uppercase opacity-80">{kind}</span>
      {label}
      {approval && (
        <span className="font-mono text-[10px] uppercase text-amber-300/90 ring-1 ring-amber-300/40 rounded-md px-1.5 py-0.5">
          ask
        </span>
      )}
    </motion.div>
  );
}

function Arrow({ auto, done }: { auto?: boolean; done?: boolean }) {
  return (
    <div className="font-mono text-[10px] text-[var(--ink-dim)] flex items-center gap-1">
      <span className="size-px h-3 w-px bg-white/20" />
      {auto && <span className="text-emerald-300/70">auto</span>}
      {done && <span className="text-clem-300/80">approved ✓</span>}
      <span className="size-px h-3 w-px bg-white/20" />
    </div>
  );
}

/* ───── Preview: meeting recording in progress ───── */

type Utterance = { speaker: "N" | "M" | "J"; name: string; text: string };
type Action = { kind: "todo" | "send" | "note"; text: string };

const UTTERANCES: Utterance[] = [
  { speaker: "M", name: "Maya",   text: "Next quarter we should push the partnership deck to Acme before Friday." },
  { speaker: "N", name: "Nathan", text: "Agreed. I'll get them a v1 by Thursday EOD." },
  { speaker: "J", name: "Jess",   text: "Should we loop in design earlier this time?" },
  { speaker: "N", name: "Nathan", text: "Yeah — let's brief Sam on Monday so they can sketch alongside us." },
];

const ACTIONS: Action[] = [
  { kind: "send", text: "Send Acme draft by Thu EOD" },
  { kind: "todo", text: "Brief Sam (design) Monday" },
  { kind: "note", text: "Q4 partnership push agreed" },
];

function useElapsed(active: boolean) {
  const [secs, setSecs] = useState(1334); // 22:14
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
  const [step, setStep] = useState(0);
  const [actionStep, setActionStep] = useState(0);
  const [tick, setTick] = useState(0);
  const timer = useElapsed(true);

  // Advance transcript
  useEffect(() => {
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
  }, [step]);

  // Action items appear slightly after relevant utterances
  useEffect(() => {
    if (actionStep >= ACTIONS.length) return;
    if (step < actionStep + 2) return;
    const t = window.setTimeout(() => setActionStep((s) => s + 1), 400);
    return () => window.clearTimeout(t);
  }, [step, actionStep]);

  const visible = UTTERANCES.slice(0, step);
  const visibleActions = ACTIONS.slice(0, actionStep);

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden rounded-xl bg-[#0d0907] ring-1 ring-white/10">
      {/* Header */}
      <div className="flex items-center gap-2.5 border-b border-white/5 px-4 py-2.5 text-[11px]">
        <span className="relative inline-flex h-2.5 w-2.5">
          <span className="absolute inset-0 rounded-full bg-red-500/60 animate-ping" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
        </span>
        <span className="font-mono uppercase tracking-wider text-red-300">
          Meeting live
        </span>
        <span className="font-mono text-white/40">·</span>
        <span className="font-mono text-white/85">{timer}</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] text-emerald-300/80 font-mono">
          <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Zoom · transcribing
        </span>
      </div>

      <div key={tick} className="flex flex-1 min-h-0">
        {/* Transcript */}
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
                  <div className="font-mono text-[10px] text-white/45 mb-0.5">
                    {u.name}
                  </div>
                  <div className="text-[12.5px] leading-snug text-white/85">
                    {u.text}
                  </div>
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

        {/* Action items panel */}
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
                  <span className="text-[11.5px] text-white/85 leading-snug">
                    {a.text}
                  </span>
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
    N: "bg-clem-500/20 text-clem-200 ring-clem-400/40",
    M: "bg-violet-500/20 text-violet-200 ring-violet-400/40",
    J: "bg-emerald-500/20 text-emerald-200 ring-emerald-400/40",
  };
  return (
    <div
      className={
        "shrink-0 h-7 w-7 rounded-full ring-1 grid place-items-center text-[11px] font-semibold " +
        palette[speaker]
      }
    >
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

