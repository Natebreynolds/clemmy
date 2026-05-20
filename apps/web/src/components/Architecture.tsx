"use client";

import { motion } from "framer-motion";
import { Section } from "./ui/Section";

export function Architecture() {
  return (
    <Section
      id="architecture"
      eyebrow="Architecture"
      title={
        <>
          One daemon. One process.
          <br />
          <span className="text-[var(--ink-dim)]">Your whole agent.</span>
        </>
      }
      intro="No microservices. No cloud control plane. A single signed macOS bundle wraps a Node daemon and a renderer, both pointing at one folder on your disk."
    >
      <div className="overflow-hidden rounded-2xl bg-[var(--bg-elev)] ring-1 ring-black/10 p-6 sm:p-10 relative shadow-[0_30px_60px_-30px_rgba(80,40,10,0.15)]">
        <div className="absolute inset-0 dot-grid opacity-50" />
        <svg viewBox="0 0 760 460" className="relative w-full h-auto" aria-hidden>
          <motion.rect
            x={50} y={20} width={660} height={420} rx={14}
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.6 }}
            className="fill-clem-50/40 stroke-black/10"
            strokeWidth={1}
          />
          <motion.text
            x={70} y={48}
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ delay: 0.2 }}
            className="fill-[#6b5d50] font-mono"
            fontSize={11}
          >
            Clementine.app · signed macOS bundle
          </motion.text>

          <Node x={80}  y={80}  w={300} h={140} title="Runtime"          sub="Codex / OpenAI"        delay={0.1} />
          <Node x={420} y={80}  w={260} h={140} title="Tool taxonomy"    sub="+ scope policy"        delay={0.18} accent />
          <Node x={80}  y={260} w={600} h={70}  title="Unified tool surface" sub="SDK · MCP · Composio · computer-use" delay={0.32} accent wide />
          <Node x={80}  y={360} w={600} h={60}  title="Memory spine"     sub="vault · facts · working · embeddings · briefs" delay={0.46} wide />

          <Connector path="M 380 150 L 420 150" delay={0.55} />
          <Connector path="M 230 220 L 230 260" delay={0.65} />
          <Connector path="M 550 220 L 550 260" delay={0.65} />
          <Connector path="M 380 330 L 380 360" delay={0.78} />

          <DataFlow path="M 230 80 L 230 260" delay={1.0} />
          <DataFlow path="M 550 80 L 550 260" delay={1.3} />
          <DataFlow path="M 380 260 L 380 360" delay={1.6} />
        </svg>
      </div>

      <div className="mt-10 grid gap-6 sm:grid-cols-3 text-sm text-[var(--ink-dim)]">
        <Tile
          eyebrow="Local-first"
          body={
            <>
              Everything lives in{" "}
              <code className="font-mono text-clem-700 bg-clem-50 px-1 py-0.5 rounded">~/.clementine-next/</code>.
              Markdown vault, SQLite index, NDJSON tool log.
            </>
          }
        />
        <Tile
          eyebrow="Always learning"
          body="Append-only tool-event log feeds a background re-summarizer. What worked today becomes the default tomorrow."
        />
        <Tile
          eyebrow="Reports back"
          body="Every scheduled run completes with success or a clear failure. Silent halts are bugs."
        />
      </div>
    </Section>
  );
}

function Node({
  x, y, w, h, title, sub, delay, accent, wide,
}: {
  x: number; y: number; w: number; h: number;
  title: string; sub?: string;
  delay: number; accent?: boolean; wide?: boolean;
}) {
  return (
    <motion.g
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      <rect
        x={x} y={y} width={w} height={h} rx={10}
        className={accent ? "fill-clem-100 stroke-clem-500/50" : "fill-white stroke-black/15"}
        strokeWidth={1}
      />
      {accent && (
        <motion.rect
          x={x} y={y} width={w} height={h} rx={10}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0.3, 0.55, 0.3] }}
          transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
          className="fill-none stroke-clem-500/40"
          strokeWidth={1}
        />
      )}
      <text
        x={wide ? x + 24 : x + w / 2}
        y={y + (sub ? h / 2 - 4 : h / 2 + 5)}
        textAnchor={wide ? "start" : "middle"}
        className="fill-[#0f0a06] font-medium"
        fontSize={14}
      >
        {title}
      </text>
      {sub && (
        <text
          x={wide ? x + 24 : x + w / 2}
          y={y + h / 2 + 14}
          textAnchor={wide ? "start" : "middle"}
          className="fill-[#6b5d50] font-mono"
          fontSize={11}
        >
          {sub}
        </text>
      )}
    </motion.g>
  );
}

function Connector({ path, delay = 0 }: { path: string; delay?: number }) {
  return (
    <motion.path
      d={path}
      initial={{ pathLength: 0, opacity: 0 }}
      whileInView={{ pathLength: 1, opacity: 0.5 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.9, delay, ease: "easeInOut" }}
      stroke="#ea580c"
      strokeWidth={1.5}
      fill="none"
      strokeDasharray="4 4"
    />
  );
}

function DataFlow({ path, delay = 0 }: { path: string; delay?: number }) {
  return (
    <g>
      <motion.circle
        r={4}
        fill="#ea580c"
        initial={{ offsetDistance: "0%", opacity: 0 }}
        whileInView={{
          offsetDistance: ["0%", "100%"],
          opacity: [0, 1, 1, 0],
        }}
        viewport={{ once: false }}
        transition={{
          delay,
          duration: 2.6,
          repeat: Infinity,
          repeatDelay: 0.8,
          ease: "easeInOut",
        }}
        style={{ offsetPath: `path("${path}")` }}
      />
    </g>
  );
}

function Tile({ eyebrow, body }: { eyebrow: string; body: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-xl card-surface p-5"
    >
      <div className="font-mono text-xs uppercase tracking-wider text-clem-700 mb-2">
        {eyebrow}
      </div>
      <div className="text-[var(--ink)]">{body}</div>
    </motion.div>
  );
}
