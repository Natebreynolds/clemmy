import { describeApiError, listTenants } from "@/lib/admin/license-api";
import type { Tenant } from "@/lib/admin/types";
import { EnforcementPanel } from "@/components/admin/EnforcementPanel";
import { NewTenantForm } from "@/components/admin/NewTenantForm";
import { ApiErrorCard, PageHeader } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default async function EnforcementPage() {
  let tenants: Tenant[] = [];
  let error: string | null = null;
  try {
    const data = await listTenants();
    tenants = data.tenants ?? [];
  } catch (err) {
    error = describeApiError(err);
  }

  return (
    <>
      <PageHeader
        eyebrow="Products"
        title="Enforcement"
        intro="Enforcement is the kill switch. While it is off, every install runs unlicensed. Turning it on takes effect at each install's next lease check — no client release required."
      />

      {error ? (
        <ApiErrorCard message={error} />
      ) : (
        <div className="space-y-6">
          <EnforcementPanel tenants={tenants} />
          <NewTenantForm />
        </div>
      )}
    </>
  );
}
