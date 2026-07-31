"use client";

import { useState } from "react";
import { btnPrimary } from "@/components/admin/ui";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      // Clipboard API needs a secure context; over plain http (or with the
      // permission denied) fall back to telling the user to select manually
      // rather than silently doing nothing.
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2500);
  }

  return (
    <button type="button" onClick={copy} className={btnPrimary}>
      {state === "copied" ? "Copied" : state === "failed" ? "Select it manually" : label}
    </button>
  );
}
