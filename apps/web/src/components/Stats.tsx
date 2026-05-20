"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView } from "framer-motion";

const STATS: Array<{
  value: number;
  suffix: string;
  label: string;
  sub: string;
}> = [
  { value: 0,   suffix: "",  label: "Bots in your meetings", sub: "Native Zoom · Meet · Teams capture · no participant-list noise" },
  { value: 200, suffix: "+", label: "Connected apps",        sub: "via Composio · Gmail · Slack · Notion · Sheets · …" },
  { value: 40,  suffix: "+", label: "MCP servers",           sub: "DataForSEO · Supabase · Apify · Bright Data · …" },
  { value: 100, suffix: "%", label: "Local-first",           sub: "Data lives in ~/.clementine-next/ · nothing else" },
];

export function Stats() {
  return (
    <section className="relative py-20 sm:py-24 px-6">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-black/10 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-black/10 to-transparent" />

      <div className="max-w-6xl mx-auto">
        <div className="grid gap-px overflow-hidden rounded-2xl bg-black/[0.08] sm:grid-cols-2 lg:grid-cols-4">
          {STATS.map((s, i) => (
            <StatCell key={s.label} {...s} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}

function StatCell({
  value,
  suffix,
  label,
  sub,
  index,
}: {
  value: number;
  suffix: string;
  label: string;
  sub: string;
  index: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!inView) return;
    const duration = 1100;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const elapsed = t - start;
      const p = Math.min(1, elapsed / duration);
      const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      setCount(Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value]);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 16 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, delay: index * 0.08, ease: [0.16, 1, 0.3, 1] }}
      className="group relative bg-[var(--bg-elev)] p-6 sm:p-7 transition-colors hover:bg-clem-50/50"
    >
      <div className="flex items-baseline gap-1 font-semibold tracking-tight">
        <span className="text-5xl sm:text-6xl text-[var(--ink-strong)]">
          {count}
        </span>
        <span className="text-3xl sm:text-4xl text-clem-600">{suffix}</span>
      </div>
      <div className="mt-2 text-sm font-medium text-[var(--ink-strong)]">{label}</div>
      <div className="mt-1.5 text-[12px] leading-relaxed text-[var(--ink-dim)]">{sub}</div>
      <div className="absolute inset-x-5 bottom-2 h-px bg-gradient-to-r from-transparent via-clem-500/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
    </motion.div>
  );
}
