"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Monitor, Mic, MessageSquare, Webhook } from "lucide-react";
import { Section } from "./ui/Section";

type ChannelId = "dashboard" | "voice" | "discord" | "api";

const TABS: Array<{
  id: ChannelId;
  label: string;
  icon: typeof Monitor;
  title: string;
  body: string;
}> = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: Monitor,
    title: "The Electron dashboard is the home page.",
    body:
      "Chat with Clementine, watch tool calls stream in real time, approve actions, manage MCP servers, set your scope policy. Closing the window leaves the daemon running — find her in the menu bar to quit.",
  },
  {
    id: "voice",
    label: "Voice",
    icon: Mic,
    title: "Talk to her like you'd talk to a coworker.",
    body:
      "OpenAI Realtime, push-to-talk in the dashboard. Spoken commands route into the same local agent — same memory, same tools, same approvals. Great for hands-free starts on a long task.",
  },
  {
    id: "discord",
    label: "Discord",
    icon: MessageSquare,
    title: "Run her from your phone.",
    body:
      "Paste a Discord bot token in the dashboard. DM Clementine or post in a bot channel. Approvals arrive as inline buttons so you can authorize an action without unlocking your laptop.",
  },
  {
    id: "api",
    label: "Webhook / API",
    icon: Webhook,
    title: "POST a task and walk away.",
    body:
      "POST /api/console/home/chat on localhost:8520 with a webhook secret. NDJSON streaming on /chat/stream. Wire her into Raycast, Shortcuts, an Alfred workflow — anything that can hit HTTP.",
  },
];

export function Channels() {
  const [active, setActive] = useState<ChannelId>("dashboard");
  const tab = TABS.find((t) => t.id === active) ?? TABS[0];

  return (
    <Section
      eyebrow="Channels"
      title="Talk to her any way you want."
      intro="Same agent, same memory, four ways in. Pick whichever fits the moment."
    >
      <div className="flex flex-wrap gap-2 mb-8">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={
                "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm transition-all " +
                (isActive
                  ? "bg-clem-500/15 text-clem-800 ring-1 ring-clem-500/50"
                  : "bg-white text-[var(--ink-dim)] ring-1 ring-black/10 hover:ring-black/20 hover:text-[var(--ink-strong)]")
              }
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="grid gap-10 lg:grid-cols-[1.25fr_1fr] items-center">
        <div className="relative aspect-[16/10] overflow-hidden rounded-2xl bg-[var(--bg-elev)] ring-1 ring-black/10 shadow-[0_30px_80px_-30px_rgba(80,40,10,0.30)]">
          <AnimatePresence mode="wait">
            <motion.div
              key={active}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.35 }}
              className="absolute inset-0"
            >
              {active === "dashboard" && <DashboardMockup />}
              {active === "voice" && <VoiceMockup />}
              {active === "discord" && <DiscordMockup />}
              {active === "api" && <WebhookMockup />}
            </motion.div>
          </AnimatePresence>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={tab.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.3 }}
          >
            <h3 className="text-2xl font-semibold tracking-tight text-[var(--ink-strong)]">{tab.title}</h3>
            <p className="mt-4 text-[var(--ink-dim)] leading-relaxed">{tab.body}</p>
          </motion.div>
        </AnimatePresence>
      </div>
    </Section>
  );
}

function DashboardMockup() {
  return (
    <div
      className="absolute inset-0 bg-cover bg-top"
      style={{ backgroundImage: 'url("/screenshots/dashboard.png")' }}
    />
  );
}

function VoiceMockup() {
  const [transcript, setTranscript] = useState("");
  const FULL = "Pull yesterday's meeting notes and draft a follow-up to Maya about the Q4 plan.";

  useEffect(() => {
    let i = 0;
    setTranscript("");
    const id = window.setInterval(() => {
      i++;
      setTranscript(FULL.slice(0, i));
      if (i >= FULL.length) window.clearInterval(id);
    }, 28);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0d0907] px-8 text-center">
      <div className="absolute inset-0 opacity-30">
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[60%] w-[60%] rounded-full bg-clem-500/30 blur-[60px]" />
      </div>

      <div className="relative font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-300/80 mb-4 flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
        </span>
        Listening · OpenAI Realtime
      </div>

      <motion.div
        animate={{ scale: [1, 1.06, 1] }}
        transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        className="relative z-10 mb-6"
      >
        <div className="absolute inset-0 rounded-full bg-clem-500/40 blur-2xl scale-150" />
        <div className="relative h-20 w-20 rounded-full bg-gradient-to-br from-clem-300 to-clem-600 ring-2 ring-clem-200/60 shadow-[0_0_60px_rgba(249,115,22,0.6)] flex items-center justify-center">
          <Mic className="h-7 w-7 text-clem-950" strokeWidth={2.5} />
        </div>
      </motion.div>

      <div className="relative flex items-center gap-1 h-12 mb-6">
        {Array.from({ length: 36 }).map((_, i) => {
          const seed = (i * 37 + 13) % 100;
          const baseH = 8 + (seed % 28);
          return (
            <motion.span
              key={i}
              className="w-[3px] rounded-full bg-gradient-to-t from-clem-600 to-clem-300"
              animate={{
                height: [
                  `${baseH * 0.4}px`,
                  `${baseH * 1.4}px`,
                  `${baseH * 0.6}px`,
                  `${baseH}px`,
                ],
              }}
              transition={{
                duration: 1.2 + (seed % 10) / 10,
                repeat: Infinity,
                delay: (seed % 20) / 20,
                ease: "easeInOut",
              }}
            />
          );
        })}
      </div>

      <div className="relative max-w-md text-white/90 text-base leading-relaxed font-medium">
        &ldquo;{transcript}
        <span className="ml-0.5 inline-block h-[1em] w-[2px] -mb-[3px] bg-clem-300 align-middle animate-pulse" />
        &rdquo;
      </div>
      <div className="relative mt-2 font-mono text-[11px] text-white/40">
        spacebar to stop · esc to cancel
      </div>
    </div>
  );
}

const DISCORD_BG = "#1e1f22";
const DISCORD_SIDEBAR = "#2b2d31";
const DISCORD_CHAT_BG = "#313338";
const DISCORD_TEXT = "#dcdee1";
const DISCORD_MUTED = "#949ba4";

function DiscordMockup() {
  return (
    <div className="absolute inset-0 flex font-sans" style={{ background: DISCORD_BG }}>
      <div className="hidden sm:flex w-[60px] shrink-0 flex-col items-center py-3 gap-2" style={{ background: DISCORD_BG }}>
        <div className="h-10 w-10 rounded-2xl bg-indigo-500 grid place-items-center text-white text-sm font-bold">D</div>
        <div className="h-px w-8 bg-white/10 my-1" />
        <div className="h-10 w-10 rounded-full overflow-hidden ring-2 ring-clem-400">
          <img src="/logo.png" alt="" className="h-full w-full" style={{ imageRendering: "pixelated" }} />
        </div>
        <div className="h-10 w-10 rounded-3xl bg-white/5 grid place-items-center text-white/50 text-lg">+</div>
      </div>

      <div className="hidden md:flex w-[200px] shrink-0 flex-col" style={{ background: DISCORD_SIDEBAR }}>
        <div className="h-12 border-b border-black/30 flex items-center px-4 text-white font-semibold text-sm">
          Clementine
        </div>
        <div className="py-3 px-2 text-[11px] uppercase tracking-wider" style={{ color: DISCORD_MUTED }}>
          Channels
        </div>
        <div className="px-2 space-y-0.5">
          {[
            { name: "general", active: false },
            { name: "clementine-bot", active: true, unread: 2 },
            { name: "approvals", active: false, unread: 1 },
          ].map((c) => (
            <div
              key={c.name}
              className="flex items-center gap-2 px-2 py-1.5 rounded text-sm"
              style={{
                background: c.active ? "rgba(255,255,255,0.06)" : "transparent",
                color: c.active ? "#fff" : DISCORD_MUTED,
              }}
            >
              <span style={{ color: DISCORD_MUTED }}>#</span>
              <span>{c.name}</span>
              {c.unread && (
                <span className="ml-auto h-4 min-w-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold grid place-items-center">
                  {c.unread}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0" style={{ background: DISCORD_CHAT_BG, color: DISCORD_TEXT }}>
        <div className="h-12 border-b border-black/30 flex items-center px-4 text-sm">
          <span style={{ color: DISCORD_MUTED }}>#</span>
          <span className="ml-2 font-semibold text-white">clementine-bot</span>
        </div>
        <div className="flex-1 overflow-hidden px-4 py-3 space-y-4 text-[13.5px]">
          <DiscordMsg avatar="N" avatarColor="#5865f2" author="nathan" time="10:42 AM">
            <p>any urgent emails this morning?</p>
          </DiscordMsg>
          <DiscordMsg isClementine author="Clementine" time="10:42 AM">
            <p style={{ color: DISCORD_TEXT }}>3 worth eyes. Pulling now…</p>
            <ToolCall icon="📥" name="gmail.search" args='"unread is:important"' result="3 results" />
            <ApprovalCard />
          </DiscordMsg>
        </div>
        <div className="m-3 rounded-lg px-4 py-2.5 text-sm" style={{ background: "#383a40", color: DISCORD_MUTED }}>
          Message #clementine-bot
        </div>
      </div>
    </div>
  );
}

function DiscordMsg({
  author, time, avatar, avatarColor, isClementine, children,
}: {
  author: string; time: string; avatar?: string; avatarColor?: string;
  isClementine?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0">
        {isClementine ? (
          <div className="h-9 w-9 rounded-full overflow-hidden ring-1 ring-clem-400/40">
            <img src="/logo.png" alt="" className="h-full w-full" style={{ imageRendering: "pixelated" }} />
          </div>
        ) : (
          <div className="h-9 w-9 rounded-full grid place-items-center text-white text-sm font-bold" style={{ background: avatarColor }}>
            {avatar}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-[14px]" style={{ color: isClementine ? "#fdba74" : "#fff" }}>
            {author}
          </span>
          {isClementine && (
            <span className="text-[10px] font-bold rounded-sm px-1.5 py-0.5 bg-indigo-500 text-white">APP</span>
          )}
          <span className="text-[11px]" style={{ color: DISCORD_MUTED }}>{time}</span>
        </div>
        <div className="mt-0.5 space-y-2">{children}</div>
      </div>
    </div>
  );
}

function ToolCall({ icon, name, args, result }: { icon: string; name: string; args: string; result: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-md bg-black/30 px-2 py-1 text-[12px] font-mono">
      <span>{icon}</span>
      <span className="text-white">{name}</span>
      <span style={{ color: DISCORD_MUTED }}>·</span>
      <span style={{ color: DISCORD_MUTED }}>{args}</span>
      <span style={{ color: DISCORD_MUTED }}>↳</span>
      <span className="text-emerald-300">{result}</span>
    </div>
  );
}

function ApprovalCard() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="mt-2 rounded-md border-l-4 px-3 py-2.5"
      style={{ background: "#2b2d31", borderColor: "#fdba74" }}
    >
      <div className="text-[11px] uppercase tracking-wider font-mono" style={{ color: "#fdba74" }}>
        Approval requested
      </div>
      <div className="mt-1 text-white text-[13px]">
        Send draft reply to <span className="text-clem-300">product@stripe.com</span>?
      </div>
      <div className="mt-2 flex gap-2">
        <button className="rounded bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/40 px-3 py-1 text-[12px] font-medium">
          Approve
        </button>
        <button className="rounded bg-white/5 text-white/60 ring-1 ring-white/10 px-3 py-1 text-[12px]">
          Deny
        </button>
        <button className="rounded text-white/40 px-3 py-1 text-[12px] hover:text-white/70">
          View draft
        </button>
      </div>
    </motion.div>
  );
}

type StreamLine =
  | { kind: "tick"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "result"; text: string }
  | { kind: "text"; text: string };

const STREAM: StreamLine[] = [
  { kind: "tick",   text: '{"type":"start","session":"s_4f2a"}' },
  { kind: "text",   text: '{"type":"text","content":"Pulling today\'s meetings…"}' },
  { kind: "tool",   text: '{"type":"tool_call","name":"google_calendar.list","args":{"date":"today"}}' },
  { kind: "result", text: '{"type":"tool_result","name":"google_calendar.list","value":"5 events"}' },
  { kind: "text",   text: '{"type":"text","content":"3 had notable outcomes:"}' },
  { kind: "tool",   text: '{"type":"tool_call","name":"vault.search","args":{"q":"Q4 plan"}}' },
  { kind: "result", text: '{"type":"tool_result","name":"vault.search","value":"12 matches"}' },
  { kind: "text",   text: '{"type":"text","content":"Summary ready. Want it as a doc or email?"}' },
  { kind: "tick",   text: '{"type":"done","tokens_in":1284,"tokens_out":407,"ms":4128}' },
];

function WebhookMockup() {
  const [step, setStep] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (step >= STREAM.length) {
      const t = window.setTimeout(() => { setStep(0); setTick((x) => x + 1); }, 2200);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setStep(step + 1), 320);
    return () => window.clearTimeout(t);
  }, [step]);

  const visible = STREAM.slice(0, step);
  const color = (k: StreamLine["kind"]) =>
    k === "tool"   ? "text-clem-300"
  : k === "result" ? "text-emerald-300"
  : k === "tick"   ? "text-white/40"
  :                  "text-white/85";

  return (
    <div className="absolute inset-0 flex flex-col bg-[#0a0806] font-mono text-[11.5px] leading-[1.5]">
      <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2.5 text-white/55">
        <span className="size-2.5 rounded-full bg-red-400/70" />
        <span className="size-2.5 rounded-full bg-yellow-400/70" />
        <span className="size-2.5 rounded-full bg-green-400/70" />
        <span className="ml-3 text-[11px]">~/work · zsh</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] text-emerald-300/80">
          <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
          POST /chat/stream
        </span>
      </div>
      <div key={tick} className="flex-1 overflow-hidden px-4 py-3 space-y-[2px]">
        <Line c="text-clem-300">$ curl -N -X POST http://localhost:8520/api/console/home/chat/stream \</Line>
        <Line c="text-white/70" indent>{`-H "X-Secret: $CLEMENTINE_SECRET" \\`}</Line>
        <Line c="text-white/70" indent>{`-H "Content-Type: application/json" \\`}</Line>
        <Line c="text-white/70" indent>{`-d '{"text":"summarize today\\'s meetings"}'`}</Line>
        <div className="h-2" />
        {visible.map((l, i) => (
          <motion.div
            key={`${tick}-${i}`}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2 }}
            className={"truncate " + color(l.kind)}
          >
            <span className="text-white/30">↳ </span>
            {l.text}
          </motion.div>
        ))}
        {step < STREAM.length && (
          <motion.div
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 1, repeat: Infinity }}
            className="text-clem-300"
          >
            ▍
          </motion.div>
        )}
      </div>
      <div className="border-t border-white/5 px-4 py-2 text-[10px] text-white/55 flex items-center gap-4">
        <span>Connected from: <span className="text-clem-300">Raycast</span></span>
        <span>·</span>
        <span>Also works in: Shortcuts · Alfred · cron · webhook</span>
      </div>
    </div>
  );
}

function Line({ children, c, indent }: { children: React.ReactNode; c?: string; indent?: boolean }) {
  return <div className={(c ?? "text-white/85") + (indent ? " pl-4" : "")}>{children}</div>;
}
