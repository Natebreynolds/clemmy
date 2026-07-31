"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminRequest } from "@/lib/admin/client";
import type { LicenseDetail } from "@/lib/admin/types";
import { btnDanger, btnGhost, btnPrimary, Card, Field, inputClass, Notice } from "@/components/admin/ui";

export function LicenseStatusActions({ license }: { license: LicenseDetail }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");

  const revoked = license.status === "revoked";
  const suspended = license.status === "suspended";

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      setConfirming(false);
      setReason("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-4 admin-mono text-[11px] uppercase tracking-[0.18em] text-clem-700">Status</h2>

      <div className="space-y-3">
        {revoked ? (
          <>
            <p className="text-[13px] leading-relaxed text-[var(--ink-dim)]">
              Revoked. Installs on this key stop renewing their lease and lock out once the current lease expires.
            </p>
            <button
              type="button"
              className={`${btnPrimary} w-full`}
              disabled={busy}
              onClick={() => run(() => adminRequest(`licenses/${license.id}/restore`, { method: "POST" }))}
            >
              {busy ? "Working…" : "Restore license"}
            </button>
          </>
        ) : confirming ? (
          <>
            <Notice tone="warn" title="Revoke this license?">
              Every activation on it loses access when its lease expires. This is reversible — Restore puts it back.
            </Notice>
            <Field label="Reason" htmlFor="revoke-reason" hint="Recorded in the audit log.">
              <input
                id="revoke-reason"
                className={inputClass}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="refund, chargeback, key leaked…"
                autoFocus
              />
            </Field>
            <div className="flex gap-2">
              <button
                type="button"
                className={`${btnDanger} flex-1`}
                disabled={busy}
                onClick={() =>
                  run(() =>
                    adminRequest(`licenses/${license.id}/revoke`, {
                      method: "POST",
                      body: { reason: reason.trim() || null },
                    }),
                  )
                }
              >
                {busy ? "Revoking…" : "Yes, revoke"}
              </button>
              <button type="button" className={btnGhost} disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              className={`${btnGhost} w-full`}
              disabled={busy}
              onClick={() =>
                run(() =>
                  adminRequest(`licenses/${license.id}`, {
                    method: "PATCH",
                    body: { status: suspended ? "active" : "suspended" },
                  }),
                )
              }
            >
              {suspended ? "Un-suspend" : "Suspend"}
            </button>
            {/* Two steps to revoke, one to suspend: suspension is a pause,
                revocation is what you do about a leaked key. */}
            <button type="button" className={`${btnDanger} w-full`} disabled={busy} onClick={() => setConfirming(true)}>
              Revoke…
            </button>
          </>
        )}

        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Card>
  );
}
