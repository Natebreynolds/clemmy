/**
 * Admin design kit.
 *
 * Same tokens as the marketing site (warm cream surfaces, clementine accent,
 * hairline rules) so the panel reads as part of the product rather than a
 * bolted-on tool. Pure presentation — no hooks — so both server and client
 * components can import it.
 */
import type { ReactNode } from "react";
import clsx from "@/lib/cx";

export const inputClass = clsx(
  "w-full rounded-xl bg-[var(--bg-elev)] px-3.5 py-2.5 text-[15px] text-[var(--ink-strong)]",
  "ring-1 ring-black/[0.09] placeholder:text-[var(--ink-faint)]",
  "outline-none transition focus:ring-2 focus:ring-clem-500/60",
  "disabled:opacity-60",
);

export const btnPrimary = clsx(
  "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium tracking-tight",
  "bg-gradient-to-b from-clem-400 to-clem-600 text-white ring-1 ring-clem-600/40",
  "shadow-[0_10px_28px_-12px_rgba(249,115,22,0.6)] transition-all",
  "hover:from-clem-300 hover:to-clem-500 hover:-translate-y-px",
  "disabled:pointer-events-none disabled:opacity-55",
);

export const btnGhost = clsx(
  "inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm tracking-tight",
  "bg-white/70 text-[var(--ink)] ring-1 ring-black/10 backdrop-blur transition-all",
  "hover:bg-white hover:text-[var(--ink-strong)] hover:ring-black/20",
  "disabled:pointer-events-none disabled:opacity-55",
);

export const btnDanger = clsx(
  "inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium tracking-tight",
  "bg-rose-600 text-white ring-1 ring-rose-700/40 transition-all hover:bg-rose-500",
  "disabled:pointer-events-none disabled:opacity-55",
);

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={clsx(
        "rounded-2xl bg-[var(--bg-elev)] ring-1 ring-black/[0.07]",
        "shadow-[0_6px_28px_-16px_rgba(80,40,10,0.35)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  intro,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  intro?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-2 admin-mono text-[11px] uppercase tracking-[0.18em] text-clem-700">{eyebrow}</div>
        )}
        <h1 className="text-2xl font-semibold leading-tight tracking-tight text-[var(--ink-strong)] sm:text-3xl">
          {title}
        </h1>
        {intro && <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-[var(--ink-dim)]">{intro}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

type Tone = "active" | "suspended" | "revoked" | "released" | "blocked" | "neutral" | "warn";

const TONE_CLASS: Record<Tone, string> = {
  active: "bg-emerald-500/12 text-emerald-800 ring-emerald-600/25",
  suspended: "bg-amber-500/15 text-amber-800 ring-amber-600/25",
  revoked: "bg-rose-500/12 text-rose-800 ring-rose-600/25",
  released: "bg-black/[0.05] text-[var(--ink-dim)] ring-black/10",
  blocked: "bg-rose-500/12 text-rose-800 ring-rose-600/25",
  warn: "bg-amber-500/15 text-amber-800 ring-amber-600/25",
  neutral: "bg-black/[0.05] text-[var(--ink-dim)] ring-black/10",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5",
        "admin-mono text-[11px] uppercase tracking-[0.08em] ring-1",
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}

export function statusTone(status: string): Tone {
  if (status === "active") return "active";
  if (status === "suspended") return "suspended";
  if (status === "revoked") return "revoked";
  if (status === "released") return "released";
  if (status === "blocked") return "blocked";
  return "neutral";
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1.5 block text-[13px] font-medium text-[var(--ink-strong)]">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[12px] leading-relaxed text-[var(--ink-dim)]">{hint}</span>}
    </label>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "error" | "success";
  title?: string;
  children?: ReactNode;
}) {
  const toneClass = {
    info: "bg-black/[0.03] ring-black/[0.08] text-[var(--ink-dim)]",
    warn: "bg-amber-500/10 ring-amber-600/25 text-amber-900",
    error: "bg-rose-500/10 ring-rose-600/25 text-rose-900",
    success: "bg-emerald-500/10 ring-emerald-600/25 text-emerald-900",
  }[tone];

  return (
    <div className={clsx("rounded-xl px-4 py-3 text-[14px] leading-relaxed ring-1", toneClass)} role="status">
      {title && <div className="mb-0.5 font-medium">{title}</div>}
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-16 text-center">
      <div className="text-[15px] font-medium text-[var(--ink-strong)]">{title}</div>
      {children && <div className="mx-auto mt-2 max-w-md text-[14px] text-[var(--ink-dim)]">{children}</div>}
    </div>
  );
}

/** Kept in one place so every read path renders an API failure the same way. */
export function ApiErrorCard({ message }: { message: string }) {
  return (
    <Card className="p-6">
      <Notice tone="error" title="The license server did not answer">
        <p className="admin-mono text-[13px]">{message}</p>
        <p className="mt-2">
          Check <code>LICENSE_API_URL</code> and <code>LICENSE_ADMIN_TOKEN</code> on this deployment, then reload.
        </p>
      </Notice>
    </Card>
  );
}
