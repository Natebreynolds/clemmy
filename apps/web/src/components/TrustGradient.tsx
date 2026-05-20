"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Check, HelpCircle } from "lucide-react";
import { Section } from "./ui/Section";
import { fadeUp } from "@/lib/motion";

type Scope = "strict" | "workspace" | "yolo";

const SCOPES: Array<{
  id: Scope;
  label: string;
  blurb: string;
  rows: { read: "auto" | "ask"; writeInside: "auto" | "ask"; writeOutside: "auto" | "ask"; send: "auto" | "ask"; admin: "auto" | "ask" };
}> = [
  {
    id: "strict",
    label: "Strict",
    blurb: "She reads freely. Anything that changes the world asks first. Good default while you're getting to know her.",
    rows: { read: "auto", writeInside: "ask", writeOutside: "ask", send: "ask", admin: "ask" },
  },
  {
    id: "workspace",
    label: "Workspace",
    blurb: "Auto inside your workspace dirs. Ask outside. Network sends still gated. The sweet spot for daily use.",
    rows: { read: "auto", writeInside: "auto", writeOutside: "ask", send: "ask", admin: "ask" },
  },
  {
    id: "yolo",
    label: "YOLO",
    blurb: "Auto for everything except admin. The hard denylist still bites — rm -rf, sudo, disk wipes never run.",
    rows: { read: "auto", writeInside: "auto", writeOutside: "auto", send: "auto", admin: "ask" },
  },
];

const COLS: Array<{ key: keyof (typeof SCOPES)[number]["rows"]; label: string }> = [
  { key: "read",         label: "Read" },
  { key: "writeInside",  label: "Write · inside" },
  { key: "writeOutside", label: "Write · outside" },
  { key: "send",         label: "Send · network" },
  { key: "admin",        label: "Admin" },
];

function Cell({ value }: { value: "auto" | "ask" }) {
  return value === "auto" ? (
    <span className="inline-flex items-center gap-1.5 text-emerald-700">
      <Check className="h-3.5 w-3.5" />
      auto
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-amber-700">
      <HelpCircle className="h-3.5 w-3.5" />
      ask
    </span>
  );
}

export function TrustGradient() {
  const [active, setActive] = useState<Scope>("workspace");
  const scope = SCOPES.find((s) => s.id === active) ?? SCOPES[1];

  return (
    <Section
      id="trust"
      eyebrow="Trust"
      title={
        <>
          Permissive when she should be.
          <br />
          <span className="text-[var(--ink-dim)]">Cautious when it counts.</span>
        </>
      }
      intro="One classifier. One scope policy. The hard denylist is always enforced regardless of scope. Admin tools always ask. You change the policy from the dashboard in two clicks."
    >
      <motion.div
        variants={fadeUp}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-80px" }}
        className="flex flex-wrap gap-2 mb-8"
      >
        {SCOPES.map((s) => {
          const isActive = s.id === active;
          return (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={
                "rounded-full px-4 py-2 text-sm font-mono tracking-tight transition-all " +
                (isActive
                  ? "bg-clem-500/15 text-clem-800 ring-1 ring-clem-500/50"
                  : "bg-white text-[var(--ink-dim)] ring-1 ring-black/10 hover:ring-black/20 hover:text-[var(--ink-strong)]")
              }
            >
              {s.label.toLowerCase()}
            </button>
          );
        })}
      </motion.div>

      <motion.p
        key={scope.id}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="text-[var(--ink-dim)] mb-8 max-w-2xl"
      >
        {scope.blurb}
      </motion.p>

      <motion.div
        variants={fadeUp}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-80px" }}
        className="overflow-hidden rounded-2xl ring-1 ring-black/10 bg-[var(--bg-elev)] shadow-[0_20px_50px_-30px_rgba(80,40,10,0.15)]"
      >
        <div className="grid grid-cols-5 bg-clem-50/40">
          {COLS.map((c) => (
            <div
              key={c.key}
              className="px-5 py-4 border-r border-black/5 last:border-r-0 font-mono text-[11px] uppercase tracking-wider text-[var(--ink-dim)]"
            >
              {c.label}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-5">
          {COLS.map((c) => (
            <motion.div
              key={c.key}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
              className="px-5 py-6 border-r border-black/5 last:border-r-0 text-sm"
            >
              <Cell value={scope.rows[c.key]} />
            </motion.div>
          ))}
        </div>
      </motion.div>

      <motion.p
        variants={fadeUp}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-80px" }}
        className="mt-6 text-sm text-[var(--ink-dim)] max-w-2xl"
      >
        Single-user, local-first. The daemon writes only to{" "}
        <code className="font-mono text-clem-700 bg-clem-50 px-1 py-0.5 rounded">~/.clementine-next/</code>.
        Nothing leaves your machine except the LLM provider you configure and the
        third-party APIs you connect.
      </motion.p>
    </Section>
  );
}
