"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { inputClass } from "@/components/admin/ui";
import clsx from "@/lib/cx";

const STATUSES = [
  { value: "", label: "All" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
  { value: "revoked", label: "Revoked" },
];

/**
 * Filters live in the URL, not in component state: the list itself is server
 * rendered, so a shared or reloaded link reproduces exactly what was on screen.
 */
export function LicenseSearch({ q, status }: { q: string; status: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [text, setText] = useState(q);
  const first = useRef(true);

  // Keep the field in step when navigation changes the query from elsewhere
  // (back button, "clear filters").
  useEffect(() => {
    setText(q);
  }, [q]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (text === q) return;
    const timer = setTimeout(() => {
      const params = new URLSearchParams();
      if (text.trim()) params.set("q", text.trim());
      if (status) params.set("status", status);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname);
    }, 300);
    return () => clearTimeout(timer);
  }, [text, q, status, pathname, router]);

  function setStatus(next: string) {
    const params = new URLSearchParams();
    if (text.trim()) params.set("q", text.trim());
    if (next) params.set("status", next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search email, note, or last 4 of key…"
        className={clsx(inputClass, "sm:max-w-sm")}
        aria-label="Search licenses"
      />
      <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1">
        {STATUSES.map((option) => (
          <button
            key={option.value || "all"}
            type="button"
            onClick={() => setStatus(option.value)}
            className={clsx(
              "shrink-0 rounded-full px-3.5 py-1.5 text-[13px] tracking-tight transition-colors",
              status === option.value
                ? "bg-clem-500/12 text-clem-800 ring-1 ring-clem-600/25"
                : "text-[var(--ink-dim)] ring-1 ring-black/[0.08] hover:bg-white hover:text-[var(--ink-strong)]",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
