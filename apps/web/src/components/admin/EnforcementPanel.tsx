"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminRequest } from "@/lib/admin/client";
import type { Product, Tenant } from "@/lib/admin/types";
import { Badge, btnDanger, btnGhost, btnPrimary, Card, EmptyState, Field, inputClass, Notice } from "@/components/admin/ui";

export function EnforcementPanel({ tenants }: { tenants: Tenant[] }) {
  const withProducts = tenants.filter((t) => (t.products ?? []).length > 0);

  return (
    <Card className="overflow-hidden">
      <h2 className="px-5 pt-5 admin-mono text-[11px] uppercase tracking-[0.18em] text-clem-700">
        Tenants &amp; products
      </h2>

      {withProducts.length === 0 ? (
        <EmptyState title="No products yet.">Create a tenant and its first product below.</EmptyState>
      ) : (
        <div className="mt-4">
          {withProducts.map((tenant) => (
            <section key={tenant.id} className="border-t border-[var(--rule)] px-5 py-4">
              <div className="mb-3 flex items-baseline gap-2">
                <span className="text-[15px] font-medium text-[var(--ink-strong)]">{tenant.name}</span>
                <span className="admin-mono text-[12px] text-[var(--ink-faint)]">{tenant.slug}</span>
              </div>
              <ul className="space-y-3">
                {(tenant.products ?? []).map((product) => (
                  <ProductRow key={product.id} product={product} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

function ProductRow({ product }: { product: Product }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [ttl, setTtl] = useState("");
  const [grace, setGrace] = useState("");
  const [timings, setTimings] = useState<{ ttl: number; grace: number } | null>(null);

  async function patch(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminRequest<{ product: Product }>(`products/${product.id}`, { method: "PATCH", body });
      // GET /tenants does not return TTL/grace, but the PATCH response does —
      // so the current values become visible the moment anything is saved.
      if (res?.product?.lease_ttl_seconds !== undefined && res.product.grace_seconds !== undefined) {
        setTimings({ ttl: res.product.lease_ttl_seconds, grace: res.product.grace_seconds });
      }
      setConfirming(false);
      setTtl("");
      setGrace("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the product.");
    } finally {
      setBusy(false);
    }
  }

  async function saveTimings() {
    const body: Record<string, unknown> = {};
    const ttlValue = Number.parseInt(ttl, 10);
    const graceValue = Number.parseInt(grace, 10);
    if (Number.isFinite(ttlValue) && ttlValue > 0) body.leaseTtlSeconds = ttlValue;
    if (Number.isFinite(graceValue) && graceValue >= 0) body.graceSeconds = graceValue;
    if (Object.keys(body).length === 0) {
      setError("Enter a lease TTL or grace period first.");
      return;
    }
    await patch(body);
  }

  return (
    <li className="rounded-xl bg-black/[0.02] p-4 ring-1 ring-black/[0.06]">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-medium text-[var(--ink-strong)]">
              {product.displayName ?? product.display_name ?? product.slug}
            </span>
            <span className="admin-mono text-[12px] text-[var(--ink-faint)]">{product.slug}</span>
            <Badge tone={product.enforce ? "active" : "neutral"}>
              {product.enforce ? "enforcing" : "open"}
            </Badge>
          </div>
          {timings && (
            <div className="mt-1 admin-mono text-[12px] text-[var(--ink-faint)]">
              lease {timings.ttl}s · grace {timings.grace}s
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" className={btnGhost} onClick={() => setAdvanced((v) => !v)} disabled={busy}>
            Timings
          </button>
          {product.enforce ? (
            <button type="button" className={btnGhost} disabled={busy} onClick={() => patch({ enforce: false })}>
              {busy ? "…" : "Turn enforcement off"}
            </button>
          ) : (
            <button type="button" className={btnDanger} disabled={busy} onClick={() => setConfirming(true)}>
              Turn enforcement on
            </button>
          )}
        </div>
      </div>

      {confirming && (
        <div className="mt-4 space-y-3">
          <Notice tone="warn" title="This locks out every unlicensed install">
            From their next lease check, installs of <span className="admin-mono">{product.slug}</span> without a valid
            key stop working. Make sure the keys people need are already issued.
          </Notice>
          <div className="flex gap-2">
            <button type="button" className={btnDanger} disabled={busy} onClick={() => patch({ enforce: true })}>
              {busy ? "Enabling…" : "Yes, enforce"}
            </button>
            <button type="button" className={btnGhost} disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {advanced && (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Lease TTL (seconds)"
              htmlFor={`ttl-${product.id}`}
              hint="Also the revocation window: how long a revoked install keeps working."
            >
              <input
                id={`ttl-${product.id}`}
                type="number"
                min={60}
                className={inputClass}
                value={ttl}
                onChange={(e) => setTtl(e.target.value)}
                placeholder="leave blank to keep current"
              />
            </Field>
            <Field label="Grace (seconds)" htmlFor={`grace-${product.id}`} hint="Offline tolerance past lease expiry.">
              <input
                id={`grace-${product.id}`}
                type="number"
                min={0}
                className={inputClass}
                value={grace}
                onChange={(e) => setGrace(e.target.value)}
                placeholder="leave blank to keep current"
              />
            </Field>
          </div>
          <button type="button" className={btnPrimary} disabled={busy} onClick={saveTimings}>
            {busy ? "Saving…" : "Save timings"}
          </button>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </li>
  );
}
