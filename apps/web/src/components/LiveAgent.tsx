"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  Search,
  Mail,
  FileSpreadsheet,
  Database,
  CheckCircle2,
  Sparkles,
  Cpu,
  Video,
} from "lucide-react";
import { Section } from "./ui/Section";

type Beat =
  | { kind: "user"; text: string }
  | { kind: "think"; text: string }
  | { kind: "tool"; icon: typeof Mail; label: string; args: string; result?: string }
  | { kind: "memory"; text: string }
  | { kind: "goal"; text: string }
  | { kind: "heal"; text: string }
  | { kind: "approval"; label: string }
  | { kind: "outcome"; text: string }
  | { kind: "reply"; text: string };

const SCRIPT: Beat[] = [
  { kind: "memory", text: "Q4 Planning meeting · 47 min · auto-captured · 14 action items extracted" },
  { kind: "user", text: "Summarize today's planning meeting and email action items to the team." },
  { kind: "goal", text: "goal contract · summary doc exists + mail delivered to every owner" },
  { kind: "think", text: "Pulling transcript and structured notes…" },
  { kind: "tool", icon: Video, label: "meeting.get", args: "today · Q4 Planning", result: "47 min · 3 speakers · 14 actions" },
  { kind: "tool", icon: Search, label: "vault.search", args: '"Q4 plan, Acme partnership"', result: "8 matches" },
  { kind: "tool", icon: FileSpreadsheet, label: "google_drive.create", args: "Q4 Planning · /Team Docs", result: "doc_e9f1a8" },
  { kind: "approval", label: "Send email to 7 recipients?" },
  { kind: "heal", text: "gmail.send · 429 rate-limited → diagnosed → backoff 2s → retry" },
  { kind: "tool", icon: Mail, label: "gmail.send", args: "team@clementine.example · Q4 Planning · 14 actions", result: "sent · msg_3c1d" },
  { kind: "memory", text: "Wrote: 'Q4 planning shipped 2026-05-20 · 14 actions' → vault/notes" },
  { kind: "outcome", text: "done · goal validated — doc created, 7/7 delivered · spoken into chat" },
  { kind: "reply", text: "Done. Doc in Team Docs, mail sent to all 7. 14 actions assigned and logged." },
];

const TYPE_SPEED = 14; // ms per char for typed strings

function useTypewriter(text: string, active: boolean) {
  const [out, setOut] = useState("");
  useEffect(() => {
    if (!active) {
      setOut(text);
      return;
    }
    setOut("");
    let i = 0;
    const id = window.setInterval(() => {
      i++;
      setOut(text.slice(0, i));
      if (i >= text.length) window.clearInterval(id);
    }, TYPE_SPEED);
    return () => window.clearInterval(id);
  }, [text, active]);
  return out;
}

export function LiveAgent() {
  const reducedMotion = useReducedMotion();
  const [step, setStep] = useState(0);
  const [tick, setTick] = useState(0); // forces re-run on loop
  const [hasVideo, setHasVideo] = useState<boolean | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // If a real demo recording exists, prefer it over the scripted console.
  useEffect(() => {
    let cancelled = false;
    fetch("/clementine-demo.mp4", { method: "HEAD" })
      .then((r) => {
        if (cancelled) return;
        setHasVideo(r.ok && (r.headers.get("content-type") ?? "").startsWith("video"));
      })
      .catch(() => !cancelled && setHasVideo(false));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (reducedMotion) { setStep(SCRIPT.length - 1); return; }
    const delays = SCRIPT.map((b) => {
      switch (b.kind) {
        case "user": return 1800;
        case "think": return 900;
        case "memory": return 900;
        case "goal": return 1100;
        case "heal": return 1500;
        case "tool": return 1500;
        case "approval": return 1800;
        case "outcome": return 2000;
        case "reply": return 2200;
      }
    });
    let canceled = false;
    let i = 0;
    const advance = () => {
      if (canceled) return;
      setStep(i);
      const d = delays[i] ?? 1200;
      i = (i + 1) % SCRIPT.length;
      if (i === 0) {
        window.setTimeout(() => { if (!canceled) setTick((t) => t + 1); }, d);
      } else {
        window.setTimeout(advance, d);
      }
    };
    advance();
    return () => { canceled = true; };
  }, [tick, reducedMotion]);

  // Show all beats up to current step, but typewriter the latest one
  const visible = useMemo(() => SCRIPT.slice(0, step + 1), [step]);

  return (
    <Section
      id="live"
      eyebrow="Live"
      title={
        <>
          One ask. One agent.
          <br />
          <span className="text-[var(--ink-dim)]">A dozen tool calls.</span>
        </>
      }
      intro="Real example. She plans, recalls from memory, calls the right tools, asks before anything irreversible, and remembers what she did."
    >
      <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr] items-stretch">
        {/* Console or real demo */}
        {hasVideo ? (
          <div className="relative overflow-hidden rounded-2xl bg-[#0d0907] ring-1 ring-white/10 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)]">
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <span className="size-2.5 rounded-full bg-red-400/70" />
              <span className="size-2.5 rounded-full bg-yellow-400/70" />
              <span className="size-2.5 rounded-full bg-green-400/70" />
              <div className="ml-3 font-mono text-[11px] tracking-wide text-[var(--ink-dim)]">
                clementine · live recording
              </div>
              <div className="ml-auto flex items-center gap-1.5 text-[11px] text-emerald-300/80 font-mono">
                <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                playback
              </div>
            </div>
            <video
              ref={videoRef}
              src="/clementine-demo.mp4"
              autoPlay
              muted
              loop
              playsInline
              className="block w-full aspect-video object-cover"
            />
          </div>
        ) : (
          <div
            key={tick}
            className="relative overflow-hidden rounded-2xl bg-[#0d0907] ring-1 ring-white/10 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)]"
          >
            <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <span className="size-2.5 rounded-full bg-red-400/70" />
              <span className="size-2.5 rounded-full bg-yellow-400/70" />
              <span className="size-2.5 rounded-full bg-green-400/70" />
              <div className="ml-3 font-mono text-[11px] tracking-wide text-[var(--ink-dim)]">
                clementine · session.live
              </div>
              <div className="ml-auto flex items-center gap-1.5 text-[11px] text-emerald-300/80 font-mono">
                <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                running
              </div>
            </div>
            <div className="px-5 py-5 space-y-3 min-h-[420px] font-mono text-[13px]">
              <AnimatePresence initial={false}>
                {visible.map((b, idx) => (
                  <BeatRow
                    key={`${tick}-${idx}`}
                    beat={b}
                    active={idx === visible.length - 1}
                  />
                ))}
              </AnimatePresence>
            </div>
          </div>
        )}

        {/* Side card — context */}
        <div className="flex flex-col gap-4">
          <Pillar
            icon={Cpu}
            title="One runtime"
            body="Codex or OpenAI. One tool surface. One memory spine. One scope policy. She picks the model; you pick the rules."
          />
          <Pillar
            icon={Database}
            title="Remembers without being told"
            body="Wins, decisions, and tool choices flow into the vault. Tomorrow's session starts knowing what worked yesterday."
          />
          <Pillar
            icon={CheckCircle2}
            title="Asks before it counts"
            body="Send an email, push code, charge a card — she waits for you. Read a file, query Sheets — she just goes."
          />
          <Pillar
            icon={Sparkles}
            title="No silent failures"
            body="Failed steps get diagnosed and retried with backoff. Every run ends in an Outcome — done, partial, or failed — delivered back to where you asked. Nothing dies quietly."
          />
        </div>
      </div>
    </Section>
  );
}

function Pillar({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Cpu;
  title: string;
  body: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 16 }}
      whileInView={{ opacity: 1, x: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="relative overflow-hidden rounded-xl bg-white/[0.02] p-5 ring-1 ring-white/10 hover:ring-clem-400/30 transition-colors"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-clem-500/10 ring-1 ring-clem-500/20">
          <Icon className="h-4 w-4 text-clem-300" />
        </div>
        <div>
          <div className="text-sm font-semibold tracking-tight">{title}</div>
          <div className="mt-1 text-[13px] leading-relaxed text-[var(--ink-dim)]">{body}</div>
        </div>
      </div>
    </motion.div>
  );
}

function BeatRow({ beat, active }: { beat: Beat; active: boolean }) {
  const typedText =
    beat.kind === "user" || beat.kind === "reply" || beat.kind === "think"
      ? beat.text
      : "";
  const typed = useTypewriter(typedText, active);

  if (beat.kind === "user") {
    return (
      <Row label=">" labelClass="text-clem-300">
        <span className="text-white/90">{active ? typed : beat.text}</span>
        {active && <Caret />}
      </Row>
    );
  }
  if (beat.kind === "think") {
    return (
      <Row label="·" labelClass="text-white/30">
        <span className="text-[var(--ink-dim)] italic">
          {active ? typed : beat.text}
        </span>
      </Row>
    );
  }
  if (beat.kind === "memory") {
    return (
      <Row label="mem" labelClass="text-violet-300">
        <span className="text-violet-200/90">{beat.text}</span>
      </Row>
    );
  }
  if (beat.kind === "goal") {
    return (
      <Row label="goal" labelClass="text-sky-300">
        <span className="text-sky-200/90">{beat.text}</span>
      </Row>
    );
  }
  if (beat.kind === "heal") {
    return (
      <Row label="!" labelClass="text-amber-300">
        <span className="text-amber-200/90">{beat.text}</span>
      </Row>
    );
  }
  if (beat.kind === "outcome") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="my-1 rounded-lg border border-emerald-300/30 bg-emerald-300/[0.06] px-3 py-2"
      >
        <div className="text-[11px] font-mono uppercase tracking-wider text-emerald-300">
          Outcome
        </div>
        <div className="mt-1 text-white/90">{beat.text}</div>
      </motion.div>
    );
  }
  if (beat.kind === "approval") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="my-1 rounded-lg border border-amber-300/30 bg-amber-300/[0.06] px-3 py-2"
      >
        <div className="text-[11px] font-mono uppercase tracking-wider text-amber-300">
          Approval requested
        </div>
        <div className="mt-1 text-white/90">{beat.label}</div>
        <div className="mt-2 flex gap-2">
          <span className="rounded-md bg-emerald-400/15 text-emerald-200 px-2 py-0.5 text-[11px] ring-1 ring-emerald-400/30">
            approve ✓
          </span>
          <span className="rounded-md bg-white/[0.04] text-white/50 px-2 py-0.5 text-[11px] ring-1 ring-white/10">
            deny
          </span>
        </div>
      </motion.div>
    );
  }
  if (beat.kind === "tool") {
    const Icon = beat.icon;
    return (
      <Row label="→" labelClass="text-emerald-300">
        <span className="inline-flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1 ring-1 ring-white/10">
          <Icon className="h-3.5 w-3.5 text-emerald-300" />
          <span className="text-white/90">{beat.label}</span>
          <span className="text-white/40">·</span>
          <span className="text-[var(--ink-dim)]">{beat.args}</span>
        </span>
        {beat.result && (
          <span className="ml-2 text-emerald-300/80">↳ {beat.result}</span>
        )}
      </Row>
    );
  }
  // reply
  return (
    <Row label="✓" labelClass="text-clem-300">
      <span className="text-white">{active ? typed : beat.text}</span>
    </Row>
  );
}

function Row({
  label,
  labelClass,
  children,
}: {
  label: string;
  labelClass?: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex items-start gap-3"
    >
      <span className={"shrink-0 w-8 select-none text-right " + (labelClass ?? "")}>
        {label}
      </span>
      <div className="flex-1 min-w-0 break-words">{children}</div>
    </motion.div>
  );
}

function Caret() {
  return (
    <motion.span
      animate={{ opacity: [1, 0, 1] }}
      transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
      className="ml-0.5 inline-block h-[1em] w-[2px] -mb-[2px] bg-clem-300 align-middle"
    />
  );
}
