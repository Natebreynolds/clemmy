"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminRequest } from "@/lib/admin/client";
import { dateInputToIso, dateInputValue } from "@/lib/admin/format";
import type { LicenseDetail } from "@/lib/admin/types";
import { btnPrimary, Card, Field, inputClass, Notice } from "@/components/admin/ui";

export function LicenseEditor({ license }: { license: LicenseDetail }) {
  const router = useRouter();
  const [plan, setPlan] = useState(license.plan);
  const [seatLimit, setSeatLimit] = useState(String(license.seat_limit));
  const [customerEmail, setCustomerEmail] = useState(license.customer_email ?? "");
  const [note, setNote] = useState(license.note ?? "");
  const [expiresAt, setExpiresAt] = useState(dateInputValue(license.expires_at));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty =
    plan !== license.plan ||
    seatLimit !== String(license.seat_limit) ||
    customerEmail !== (license.customer_email ?? "") ||
    note !== (license.note ?? "") ||
    expiresAt !== dateInputValue(license.expires_at);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    setSaved(false);

    try {
      await adminRequest(`licenses/${license.id}`, {
        method: "PATCH",
        body: {
          plan: plan.trim() || license.plan,
          seatLimit: Math.max(1, Number.parseInt(seatLimit, 10) || 1),
          // Empty string means "cleared", which the column allows; sending ""
          // would store a blank string that reads as a value.
          customerEmail: customerEmail.trim() || null,
          note: note.trim() || null,
          expiresAt: dateInputToIso(expiresAt),
        },
      });
      setSaved(true);
      // The server component holds the authoritative copy — re-render it rather
      // than trusting local state to still match the row.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="mb-4 admin-mono text-[11px] uppercase tracking-[0.18em] text-clem-700">Details</h2>
      <form onSubmit={save} className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Plan" htmlFor="edit-plan">
            <input id="edit-plan" className={inputClass} value={plan} onChange={(e) => setPlan(e.target.value)} />
          </Field>
          <Field label="Seat limit" htmlFor="edit-seats">
            <input
              id="edit-seats"
              type="number"
              min={1}
              max={9999}
              className={inputClass}
              value={seatLimit}
              onChange={(e) => setSeatLimit(e.target.value)}
            />
          </Field>
          <Field label="Customer email" htmlFor="edit-email">
            <input
              id="edit-email"
              type="email"
              className={inputClass}
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field label="Expires" htmlFor="edit-expires" hint="Empty = perpetual.">
            <input
              id="edit-expires"
              type="date"
              className={inputClass}
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Note" htmlFor="edit-note">
          <input id="edit-note" className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        {error && <Notice tone="error">{error}</Notice>}
        {saved && !dirty && <Notice tone="success">Saved.</Notice>}

        <button type="submit" className={btnPrimary} disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </form>
    </Card>
  );
}
