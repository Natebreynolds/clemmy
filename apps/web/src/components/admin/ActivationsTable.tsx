"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminRequest } from "@/lib/admin/client";
import { formatWhen } from "@/lib/admin/format";
import type { Activation } from "@/lib/admin/types";
import { Badge, Card, EmptyState, Notice, statusTone } from "@/components/admin/ui";
import clsx from "@/lib/cx";

const rowButton = clsx(
  "rounded-full px-3 py-1 text-[12px] tracking-tight transition-colors",
  "ring-1 ring-black/10 text-[var(--ink-dim)] hover:bg-white hover:text-[var(--ink-strong)]",
  "disabled:pointer-events-none disabled:opacity-50",
);

export function ActivationsTable({ activations }: { activations: Activation[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(id: number, action: "release" | "block" | "unblock") {
    if (pending !== null) return;
    setPending(id);
    setError(null);
    try {
      await adminRequest(`activations/${id}/${action}`, { method: "POST" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between px-5 pt-5">
        <h2 className="admin-mono text-[11px] uppercase tracking-[0.18em] text-clem-700">Activations</h2>
        <span className="text-[12px] text-[var(--ink-faint)]">
          {activations.filter((a) => a.status === "active").length} active
        </span>
      </div>

      {error && (
        <div className="px-5 pt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {activations.length === 0 ? (
        <EmptyState title="No machine has activated this key yet." />
      ) : (
        <ul className="mt-4">
          {activations.map((activation) => {
            const busy = pending === activation.id;
            return (
              <li
                key={activation.id}
                className="flex flex-col gap-3 border-t border-[var(--rule)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={statusTone(activation.status)}>{activation.status}</Badge>
                    <span className="admin-mono text-[13px] text-[var(--ink-strong)]">
                      {activation.app_version ?? "unknown build"}
                    </span>
                    <span className="text-[12px] text-[var(--ink-faint)]">
                      {[activation.os, activation.arch].filter(Boolean).join(" · ") || "unknown platform"}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 text-[12px] text-[var(--ink-faint)]">
                    <span>first seen {formatWhen(activation.first_seen_at)}</span>
                    <span>last seen {formatWhen(activation.last_seen_at)}</span>
                    {activation.pair_id && <span className="admin-mono">pair {activation.pair_id}</span>}
                  </div>
                  {activation.blocked_reason && (
                    <div className="mt-1 text-[12px] text-rose-800">{activation.blocked_reason}</div>
                  )}
                </div>

                <div className="flex shrink-0 gap-2">
                  {activation.status === "blocked" ? (
                    <button type="button" className={rowButton} disabled={busy} onClick={() => act(activation.id, "unblock")}>
                      {busy ? "…" : "Unblock"}
                    </button>
                  ) : (
                    <button type="button" className={rowButton} disabled={busy} onClick={() => act(activation.id, "block")}>
                      {busy ? "…" : "Block"}
                    </button>
                  )}
                  {activation.status !== "released" && (
                    // Releasing frees the seat — the answer to "I got a new
                    // laptop", without touching the license itself.
                    <button type="button" className={rowButton} disabled={busy} onClick={() => act(activation.id, "release")}>
                      {busy ? "…" : "Release seat"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
