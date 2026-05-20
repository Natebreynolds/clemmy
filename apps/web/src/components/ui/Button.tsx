import { AnchorHTMLAttributes, ReactNode } from "react";
import clsx from "@/lib/cx";

export function PrimaryButton({
  children,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) {
  return (
    <a
      {...props}
      className={clsx(
        "group relative inline-flex items-center gap-2 rounded-full px-7 py-4",
        "bg-gradient-to-b from-clem-400 to-clem-600 text-white",
        "font-medium tracking-tight shadow-[0_12px_36px_-10px_rgba(249,115,22,0.55)]",
        "ring-1 ring-clem-600/40 hover:from-clem-300 hover:to-clem-500",
        "transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_18px_60px_-12px_rgba(249,115,22,0.7)]",
        "text-[15px]",
        className,
      )}
    >
      {children}
    </a>
  );
}

export function GhostButton({
  children,
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) {
  return (
    <a
      {...props}
      className={clsx(
        "inline-flex items-center gap-2 rounded-full px-6 py-4",
        "text-[15px] tracking-tight text-[var(--ink)] hover:text-[var(--ink-strong)]",
        "bg-white/70 ring-1 ring-black/10 hover:ring-black/20 hover:bg-white transition-all backdrop-blur",
        className,
      )}
    >
      {children}
    </a>
  );
}
