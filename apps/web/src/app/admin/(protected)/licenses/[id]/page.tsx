import Link from "next/link";
import { notFound } from "next/navigation";
import { describeApiError, licenseFetch, LicenseApiError } from "@/lib/admin/license-api";
import type { Activation, LicenseDetail } from "@/lib/admin/types";
import { formatWhen, isExpired, keyLabel } from "@/lib/admin/format";
import { LicenseEditor } from "@/components/admin/LicenseEditor";
import { LicenseStatusActions } from "@/components/admin/LicenseStatusActions";
import { ActivationsTable } from "@/components/admin/ActivationsTable";
import { ApiErrorCard, Badge, btnGhost, Card, PageHeader, statusTone } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

type Payload = { license: LicenseDetail; activations: Activation[] };

export default async function LicenseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let payload: Payload | null = null;
  let error: string | null = null;
  try {
    payload = await licenseFetch<Payload>(`licenses/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof LicenseApiError && err.status === 404) notFound();
    error = describeApiError(err);
  }

  if (error || !payload) {
    return (
      <>
        <PageHeader
          eyebrow="License"
          title="Could not load"
          actions={
            <Link href="/admin" className={btnGhost}>
              Back to licenses
            </Link>
          }
        />
        <ApiErrorCard message={error ?? "Unknown error."} />
      </>
    );
  }

  const { license, activations } = payload;
  const activeSeats = activations.filter((a) => a.status === "active").length;
  const expired = isExpired(license.expires_at);
  const features = Array.isArray(license.features) ? (license.features as unknown[]) : [];

  return (
    <>
      <PageHeader
        eyebrow={`${license.tenant} / ${license.product}`}
        title={
          <span className="admin-mono text-xl sm:text-2xl">{keyLabel(license.key_prefix, license.key_last4)}</span>
        }
        intro={license.note ?? undefined}
        actions={
          <Link href="/admin" className={btnGhost}>
            Back to licenses
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(license.status)}>{license.status}</Badge>
        {expired && <Badge tone="warn">expired {formatWhen(license.expires_at)}</Badge>}
        <Badge tone={activeSeats > license.seat_limit ? "warn" : "neutral"}>
          {activeSeats}/{license.seat_limit} seats
        </Badge>
        <Badge tone="neutral">{license.plan}</Badge>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <LicenseEditor license={license} />
          <ActivationsTable activations={activations} />
        </div>

        <div className="space-y-6">
          <LicenseStatusActions license={license} />

          <Card className="p-5">
            <h2 className="mb-4 admin-mono text-[11px] uppercase tracking-[0.18em] text-clem-700">Record</h2>
            <dl className="space-y-3 text-[13px]">
              <Row label="License ID" value={String(license.id)} mono />
              <Row label="Key prefix" value={license.key_prefix} mono />
              <Row label="Created" value={formatWhen(license.created_at)} />
              <Row label="Created by" value={license.created_by ?? "—"} />
              <Row label="Expires" value={license.expires_at ? formatWhen(license.expires_at) : "Never"} />
              {license.revoked_at && <Row label="Revoked" value={formatWhen(license.revoked_at)} />}
              {license.revoked_reason && <Row label="Reason" value={license.revoked_reason} />}
              <Row
                label="Features"
                value={features.length ? features.map((f) => String(f)).join(", ") : "—"}
              />
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-[var(--ink-dim)]">{label}</dt>
      <dd className={`text-right ${mono ? "admin-mono text-[12px]" : ""} break-words text-[var(--ink-strong)]`}>
        {value}
      </dd>
    </div>
  );
}
