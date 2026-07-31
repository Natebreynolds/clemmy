import Link from "next/link";
import { describeApiError, licenseFetch } from "@/lib/admin/license-api";
import type { LicenseRow } from "@/lib/admin/types";
import { formatWhen, isExpired, keyLabel } from "@/lib/admin/format";
import { LicenseSearch } from "@/components/admin/LicenseSearch";
import {
  ApiErrorCard,
  Badge,
  btnPrimary,
  Card,
  EmptyState,
  PageHeader,
  statusTone,
} from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default async function LicensesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const params = await searchParams;
  const q = params.q ?? "";
  const status = params.status ?? "";

  const search = new URLSearchParams();
  if (q) search.set("q", q);
  if (status) search.set("status", status);

  let licenses: LicenseRow[] = [];
  let error: string | null = null;
  try {
    const data = await licenseFetch<{ licenses: LicenseRow[] }>("licenses", { search });
    licenses = data.licenses ?? [];
  } catch (err) {
    error = describeApiError(err);
  }

  const active = licenses.filter((l) => l.status === "active").length;
  const seats = licenses.reduce((sum, l) => sum + (l.seats_used ?? 0), 0);

  return (
    <>
      <PageHeader
        eyebrow="Licenses"
        title="Issued keys"
        intro="Every key the license server has minted. A key itself is shown once, at creation, and never again."
        actions={
          <Link href="/admin/licenses/new" className={btnPrimary}>
            Generate key
          </Link>
        }
      />

      {error ? (
        <ApiErrorCard message={error} />
      ) : (
        <>
          <LicenseSearch q={q} status={status} />

          <div className="mb-5 flex flex-wrap gap-x-6 gap-y-1 admin-mono text-[12px] uppercase tracking-[0.08em] text-[var(--ink-faint)]">
            <span>
              {licenses.length} shown{licenses.length === 200 ? " (limit)" : ""}
            </span>
            <span>{active} active</span>
            <span>{seats} seats in use</span>
          </div>

          <Card className="overflow-hidden">
            {licenses.length === 0 ? (
              <EmptyState title={q || status ? "Nothing matches that filter." : "No licenses yet."}>
                {q || status ? (
                  <Link href="/admin" className="text-clem-700 underline underline-offset-4">
                    Clear filters
                  </Link>
                ) : (
                  "Generate the first key to get started."
                )}
              </EmptyState>
            ) : (
              <>
                {/* Table on desktop, cards on a phone — the same data, laid out
                    for the surface it is actually being read on. */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full border-collapse text-left text-[14px]">
                    <thead>
                      <tr className="border-b border-[var(--rule)] text-[11px] uppercase tracking-[0.1em] text-[var(--ink-faint)]">
                        <th className="px-5 py-3 font-medium">Key</th>
                        <th className="px-5 py-3 font-medium">Customer</th>
                        <th className="px-5 py-3 font-medium">Plan</th>
                        <th className="px-5 py-3 font-medium">Seats</th>
                        <th className="px-5 py-3 font-medium">Status</th>
                        <th className="px-5 py-3 font-medium">Last seen</th>
                        <th className="px-5 py-3 font-medium">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {licenses.map((license) => (
                        <tr
                          key={license.id}
                          className="group border-b border-[var(--rule)] last:border-0 transition-colors hover:bg-clem-50/60"
                        >
                          <td className="px-5 py-3.5">
                            <Link
                              href={`/admin/licenses/${license.id}`}
                              className="admin-mono text-[13px] text-[var(--ink-strong)] underline-offset-4 group-hover:underline"
                            >
                              {keyLabel(license.key_prefix, license.key_last4)}
                            </Link>
                            <div className="mt-0.5 text-[12px] text-[var(--ink-faint)]">
                              {license.tenant} / {license.product}
                            </div>
                          </td>
                          <td className="max-w-[22ch] px-5 py-3.5">
                            <div className="truncate text-[var(--ink)]">{license.customer_email ?? "—"}</div>
                            {license.note && (
                              <div className="mt-0.5 truncate text-[12px] text-[var(--ink-faint)]">{license.note}</div>
                            )}
                          </td>
                          <td className="px-5 py-3.5 text-[var(--ink-dim)]">{license.plan}</td>
                          <td className="px-5 py-3.5 admin-mono text-[13px] text-[var(--ink-dim)]">
                            {license.seats_used}/{license.seat_limit}
                          </td>
                          <td className="px-5 py-3.5">
                            <StatusCell license={license} />
                          </td>
                          <td className="px-5 py-3.5 text-[13px] text-[var(--ink-dim)]">
                            {formatWhen(license.last_seen_at)}
                          </td>
                          <td className="px-5 py-3.5 text-[13px] text-[var(--ink-dim)]">
                            {formatWhen(license.created_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <ul className="md:hidden">
                  {licenses.map((license) => (
                    <li key={license.id} className="border-b border-[var(--rule)] last:border-0">
                      <Link href={`/admin/licenses/${license.id}`} className="block px-4 py-4 active:bg-clem-50">
                        <div className="flex items-start justify-between gap-3">
                          <span className="admin-mono text-[13px] text-[var(--ink-strong)]">
                            {keyLabel(license.key_prefix, license.key_last4)}
                          </span>
                          <StatusCell license={license} />
                        </div>
                        <div className="mt-1.5 truncate text-[14px] text-[var(--ink)]">
                          {license.customer_email ?? license.note ?? "—"}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-[var(--ink-faint)]">
                          <span>{license.plan}</span>
                          <span>
                            {license.seats_used}/{license.seat_limit} seats
                          </span>
                          <span>seen {formatWhen(license.last_seen_at)}</span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function StatusCell({ license }: { license: LicenseRow }) {
  // An expired-but-active key still fails a lease check, so surfacing only
  // "active" here would mislead during support.
  const expired = license.status === "active" && isExpired(license.expires_at);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone={statusTone(license.status)}>{license.status}</Badge>
      {expired && <Badge tone="warn">expired</Badge>}
    </span>
  );
}
