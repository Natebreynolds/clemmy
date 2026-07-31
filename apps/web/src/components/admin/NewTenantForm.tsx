"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { adminRequest } from "@/lib/admin/client";
import { btnPrimary, Card, Field, inputClass, Notice } from "@/components/admin/ui";

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * POST /tenants upserts, so this doubles as "add a product to an existing
 * tenant": reuse the tenant slug and give a new product slug.
 */
export function NewTenantForm() {
  const router = useRouter();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [productSlug, setProductSlug] = useState("");
  const [productName, setProductName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    if (!SLUG.test(slug) || (productSlug && !SLUG.test(productSlug))) {
      setError("Slugs must be lowercase letters, numbers, and dashes.");
      return;
    }

    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await adminRequest("tenants", {
        method: "POST",
        body: {
          slug: slug.trim(),
          name: name.trim() || slug.trim(),
          productSlug: productSlug.trim() || undefined,
          productName: productName.trim() || undefined,
        },
      });
      setDone(`Saved ${slug.trim()}${productSlug ? ` / ${productSlug.trim()}` : ""}.`);
      setSlug("");
      setName("");
      setProductSlug("");
      setProductName("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the tenant.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5 sm:p-6">
      <h2 className="mb-1 admin-mono text-[11px] uppercase tracking-[0.18em] text-clem-700">Add tenant or product</h2>
      <p className="mb-4 text-[13px] leading-relaxed text-[var(--ink-dim)]">
        Reusing an existing tenant slug updates its name and adds the product rather than creating a duplicate.
      </p>

      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Tenant slug" htmlFor="tenant-slug" hint="Appears in the key prefix.">
            <input
              id="tenant-slug"
              className={`${inputClass} admin-mono`}
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="clementine"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </Field>
          <Field label="Tenant name" htmlFor="tenant-name">
            <input
              id="tenant-name"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Clementine"
            />
          </Field>
          <Field label="Product slug" htmlFor="product-slug" hint="Optional when the tenant already has products.">
            <input
              id="product-slug"
              className={`${inputClass} admin-mono`}
              value={productSlug}
              onChange={(e) => setProductSlug(e.target.value.toLowerCase())}
              placeholder="desktop"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field label="Product name" htmlFor="product-name">
            <input
              id="product-name"
              className={inputClass}
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              placeholder="Clementine for Mac"
            />
          </Field>
        </div>

        {error && <Notice tone="error">{error}</Notice>}
        {done && <Notice tone="success">{done}</Notice>}

        <button type="submit" className={btnPrimary} disabled={busy || !slug.trim()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
    </Card>
  );
}
