"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { adminRequest } from "@/lib/admin/client";
import { dateInputToIso } from "@/lib/admin/format";
import type { LicenseDetail, Tenant } from "@/lib/admin/types";
import { CopyButton } from "@/components/admin/CopyButton";
import { btnGhost, btnPrimary, Card, Field, inputClass, Notice } from "@/components/admin/ui";

type Created = { license: LicenseDetail; key: string };

export function NewLicenseForm({ tenants }: { tenants: Tenant[] }) {
  const usable = useMemo(() => tenants.filter((t) => (t.products ?? []).length > 0), [tenants]);

  const [tenantSlug, setTenantSlug] = useState(usable[0]?.slug ?? "");
  const products = useMemo(
    () => usable.find((t) => t.slug === tenantSlug)?.products ?? [],
    [usable, tenantSlug],
  );
  const [productSlug, setProductSlug] = useState(products[0]?.slug ?? "");

  const [plan, setPlan] = useState("pro");
  const [seatLimit, setSeatLimit] = useState("1");
  const [customerEmail, setCustomerEmail] = useState("");
  const [note, setNote] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [features, setFeatures] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  // Switching tenant must not leave a product slug from the previous tenant
  // selected — the server would reject it as unknown_product.
  function pickTenant(slug: string) {
    setTenantSlug(slug);
    const next = usable.find((t) => t.slug === slug)?.products ?? [];
    setProductSlug(next[0]?.slug ?? "");
  }

  const effectiveProduct = products.some((p) => p.slug === productSlug) ? productSlug : (products[0]?.slug ?? "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const result = await adminRequest<Created>("licenses", {
        method: "POST",
        body: {
          tenant: tenantSlug,
          product: effectiveProduct,
          plan: plan.trim() || "pro",
          seatLimit: Math.max(1, Number.parseInt(seatLimit, 10) || 1),
          customerEmail: customerEmail.trim() || null,
          note: note.trim() || null,
          expiresAt: dateInputToIso(expiresAt),
          features: features
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean),
        },
      });
      setCreated(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the license.");
    } finally {
      setBusy(false);
    }
  }

  if (created) return <KeyReveal created={created} />;

  return (
    <Card className="p-6">
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Tenant" htmlFor="tenant">
            <select
              id="tenant"
              className={inputClass}
              value={tenantSlug}
              onChange={(e) => pickTenant(e.target.value)}
              required
            >
              {usable.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name} ({t.slug})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Product" htmlFor="product">
            <select
              id="product"
              className={inputClass}
              value={effectiveProduct}
              onChange={(e) => setProductSlug(e.target.value)}
              required
            >
              {products.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.displayName ?? p.slug}
                  {p.enforce ? "" : " — enforcement off"}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Plan" htmlFor="plan" hint="Free-form. Whatever the client reads back as its tier.">
            <input
              id="plan"
              className={inputClass}
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              list="plan-suggestions"
              required
            />
            <datalist id="plan-suggestions">
              <option value="pro" />
              <option value="team" />
              <option value="founder" />
              <option value="trial" />
            </datalist>
          </Field>

          <Field label="Seat limit" htmlFor="seats" hint="Concurrent activated machines allowed on this key.">
            <input
              id="seats"
              type="number"
              min={1}
              max={9999}
              className={inputClass}
              value={seatLimit}
              onChange={(e) => setSeatLimit(e.target.value)}
              required
            />
          </Field>

          <Field label="Customer email" htmlFor="email" hint="Optional. Searchable from the license list.">
            <input
              id="email"
              type="email"
              className={inputClass}
              value={customerEmail}
              onChange={(e) => setCustomerEmail(e.target.value)}
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>

          <Field label="Expires" htmlFor="expires" hint="Leave empty for a perpetual key (founders, testers).">
            <input
              id="expires"
              type="date"
              className={inputClass}
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Note" htmlFor="note" hint="Optional. Why this key exists — also searchable.">
          <input id="note" className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <Field label="Features" htmlFor="features" hint="Optional, comma separated. Sent to the client with the lease.">
          <input
            id="features"
            className={inputClass}
            value={features}
            onChange={(e) => setFeatures(e.target.value)}
            placeholder="relay, mobile, workflows"
          />
        </Field>

        {error && <Notice tone="error">{error}</Notice>}

        <div className="flex items-center gap-3 pt-1">
          <button type="submit" className={btnPrimary} disabled={busy || !tenantSlug || !effectiveProduct}>
            {busy ? "Generating…" : "Generate key"}
          </button>
          <Link href="/admin" className={btnGhost}>
            Cancel
          </Link>
        </div>
      </form>
    </Card>
  );
}

function KeyReveal({ created }: { created: Created }) {
  return (
    <div className="space-y-5">
      <Card className="p-6">
        <Notice tone="warn" title="Copy this key now">
          The license server stores only a hash of it. Closing or reloading this page loses the key for good — the
          only remedy is to revoke this license and issue a new one.
        </Notice>

        <div className="mt-5 rounded-2xl bg-[var(--bg-dim)] p-5 ring-1 ring-clem-600/20">
          {/* break-all, not truncate: a partially rendered key that looks whole
              is the one mistake this screen cannot afford. */}
          <div className="select-all break-all admin-mono text-lg leading-relaxed text-[var(--ink-strong)] sm:text-2xl">
            {created.key}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <CopyButton value={created.key} label="Copy key" />
          <Link href={`/admin/licenses/${created.license.id}`} className={btnGhost}>
            Open license
          </Link>
          <Link href="/admin" className={btnGhost}>
            Done
          </Link>
        </div>
      </Card>

      <Card className="p-6">
        <dl className="grid gap-x-8 gap-y-3 text-[14px] sm:grid-cols-2">
          <Detail label="Tenant / product" value={`${created.license.tenant} / ${created.license.product}`} />
          <Detail label="Plan" value={created.license.plan} />
          <Detail label="Seat limit" value={String(created.license.seat_limit)} />
          <Detail label="Customer" value={created.license.customer_email ?? "—"} />
        </dl>
      </Card>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-[var(--rule)] pb-2 last:border-0 sm:border-0 sm:pb-0">
      <dt className="text-[var(--ink-dim)]">{label}</dt>
      <dd className="text-right font-medium text-[var(--ink-strong)]">{value}</dd>
    </div>
  );
}
