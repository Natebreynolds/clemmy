import Link from "next/link";
import { describeApiError, listAudit } from "@/lib/admin/license-api";
import type { AuditEntry } from "@/lib/admin/types";
import { formatWhen } from "@/lib/admin/format";
import { ApiErrorCard, Card, EmptyState, PageHeader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  let entries: AuditEntry[] = [];
  let error: string | null = null;
  try {
    const data = await listAudit();
    entries = data.entries ?? [];
  } catch (err) {
    error = describeApiError(err);
  }

  return (
    <>
      <PageHeader
        eyebrow="Trail"
        title="Audit log"
        intro="The 200 most recent administrative actions, newest first."
      />

      {error ? (
        <ApiErrorCard message={error} />
      ) : (
        <Card className="overflow-hidden">
          {entries.length === 0 ? (
            <EmptyState title="Nothing recorded yet." />
          ) : (
            <ul>
              {entries.map((entry) => (
                <li key={entry.id} className="border-b border-[var(--rule)] px-5 py-3.5 last:border-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="admin-mono text-[13px] text-[var(--ink-strong)]">{entry.action}</span>
                    <span className="text-[12px] text-[var(--ink-faint)]">{formatWhen(entry.at)}</span>
                    <span className="text-[12px] text-[var(--ink-dim)]">by {entry.actor}</span>
                    {entry.subject_type === "license" && entry.subject_id ? (
                      <Link
                        href={`/admin/licenses/${entry.subject_id}`}
                        className="text-[12px] text-clem-700 underline underline-offset-4"
                      >
                        license #{entry.subject_id}
                      </Link>
                    ) : (
                      entry.subject_id && (
                        <span className="text-[12px] text-[var(--ink-faint)]">
                          {entry.subject_type} #{entry.subject_id}
                        </span>
                      )
                    )}
                  </div>
                  {entry.meta && Object.keys(entry.meta).length > 0 && (
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-words admin-mono text-[12px] leading-relaxed text-[var(--ink-dim)]">
                      {JSON.stringify(entry.meta)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
