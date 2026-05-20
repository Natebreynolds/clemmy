import { ReactNode } from "react";
import clsx from "@/lib/cx";

export function Section({
  id,
  eyebrow,
  title,
  intro,
  children,
  className,
}: {
  id?: string;
  eyebrow?: string;
  title?: ReactNode;
  intro?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={clsx(
        "relative px-6 py-28 sm:py-36 max-w-6xl mx-auto",
        className,
      )}
    >
      {(eyebrow || title || intro) && (
        <header className="mb-16 max-w-3xl">
          {eyebrow && (
            <div className="font-mono text-xs uppercase tracking-[0.18em] text-clem-700 mb-4">
              {eyebrow}
            </div>
          )}
          {title && (
            <h2 className="text-3xl sm:text-5xl font-semibold leading-[1.05] tracking-tight text-[var(--ink-strong)]">
              {title}
            </h2>
          )}
          {intro && (
            <p className="mt-6 text-lg leading-relaxed text-[var(--ink-dim)]">
              {intro}
            </p>
          )}
        </header>
      )}
      {children}
    </section>
  );
}
