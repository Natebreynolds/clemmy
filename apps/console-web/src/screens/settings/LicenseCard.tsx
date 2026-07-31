import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, ChevronRight, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { getLicenseStatus, refreshLicense, type LicenseGap, type LicenseStatus } from '@/lib/settings';

/**
 * License status.
 *
 * The rule this card exists to honor: a license-server outage must never read
 * as "you are not licensed." `stale` means we couldn't reach the server and
 * everything still works, so it is amber at most and its copy leads with the
 * reassurance. Only `expired` and `revoked` — the two states that actually
 * gate anything — are allowed to be red.
 *
 * Likewise `unlicensed` is a fresh install, not a lapsed customer, so it gets
 * a calm prompt rather than an alarm.
 */

function formatWhen(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatDay(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function blockingMessage(status: LicenseStatus): string | null {
  return status.gaps.find((gap) => gap.blocking)?.message ?? null;
}

interface Presentation {
  tone: Tone;
  pill: string;
  headline: string;
  body?: string;
  /** Show the "add or replace your key" route out. */
  offerKeyEntry?: boolean;
}

function present(status: LicenseStatus): Presentation {
  switch (status.state) {
    case 'active':
      return {
        tone: 'success',
        pill: 'Active',
        headline: status.plan ? `${status.plan} plan` : 'Licensed',
      };

    case 'stale':
      // Amber, never red, and the reassurance comes first. Our problem, not
      // the user's — and nothing about their access has changed.
      return {
        tone: 'warning',
        pill: 'Using saved license',
        headline: "Couldn't reach the license server.",
        body: 'Everything keeps working on your saved license, and Clementine keeps retrying on its own. Nothing is interrupted.',
      };

    // Severity follows CONSEQUENCE, not the state's name. While enforcement is
    // off, an expired or revoked license changes nothing about what this Mac
    // can do — so alarming red beside "nothing is gated" would be crying wolf,
    // and a card that cries wolf is one the user stops reading before the day
    // it matters.
    case 'expired':
      return {
        tone: status.enforcing ? 'danger' : 'warning',
        pill: 'Expired',
        headline: blockingMessage(status) ?? "Couldn't confirm this license for over two weeks.",
        // The gap message already says to get back online; repeating it here
        // just makes the card read like it is nagging.
        body: status.enforcing
          ? 'Run a check, or enter a current key.'
          : 'Nothing is gated on this Mac yet. Run a check, or enter a current key.',
        offerKeyEntry: true,
      };

    case 'revoked':
      return {
        tone: status.enforcing ? 'danger' : 'warning',
        pill: 'Revoked',
        // The server's own words, verbatim — it knows why, and paraphrasing a
        // billing or support reason into something generic helps nobody.
        headline: blockingMessage(status) ?? 'This license is no longer active.',
        body: status.enforcing ? undefined : 'Nothing is gated on this Mac yet.',
        offerKeyEntry: true,
      };

    case 'unlicensed':
    default:
      if (status.hasKey) {
        return {
          tone: 'info',
          pill: 'Activating',
          headline: 'Your license key is saved.',
          body: 'This Mac activates on the next check. You can run one now.',
        };
      }
      // A brand-new install. Calm and neutral: nothing has gone wrong.
      return {
        tone: 'neutral',
        pill: 'Not activated',
        headline: "This Mac isn't activated yet.",
        body: 'Add your license key to activate it.',
        offerKeyEntry: true,
      };
  }
}

/** Only ever claims a successful check when the check actually succeeded. */
function lastCheckLabel(status: LicenseStatus): string {
  const when = formatWhen(status.lastCheckAt);
  if (!when) return 'Not checked yet';
  if (status.lastCheckOutcome === 'ok') return when;
  if (status.lastCheckOutcome === 'unreachable') return `${when} · couldn't connect`;
  if (status.lastCheckOutcome === 'rejected') return `${when} · server declined`;
  return when;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-sm bg-subtle px-3 py-2">
      <div className="text-caption text-faint">{label}</div>
      <div className="truncate text-small font-semibold text-fg">{value}</div>
    </div>
  );
}

// Gaps whose text the main copy already carries — rendering them again would
// just say the same thing twice.
const GAPS_SHOWN_ELSEWHERE = new Set<LicenseGap['code']>(['NO_KEY', 'LEASE_STALE', 'LEASE_EXPIRED', 'LICENSE_REVOKED']);

function LicenseBody({ status }: { status: LicenseStatus }) {
  const view = present(status);
  const advisories = status.gaps.filter((gap) => !GAPS_SHOWN_ELSEWHERE.has(gap.code));

  return (
    <div className="space-y-4">
      <div>
        <div className="text-small font-semibold text-fg">{view.headline}</div>
        {view.body && <p className="mt-1 text-small text-muted">{view.body}</p>}
      </div>

      {view.offerKeyEntry && (
        <Link to="/connect">
          <Button variant="secondary" size="sm">
            <KeyRound className="h-4 w-4" aria-hidden />
            {status.hasKey ? 'Replace license key' : 'Add license key'}
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
        </Link>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Fact label="Plan" value={status.plan ?? 'None yet'} />
        <Fact
          label="Seats"
          value={status.seat ? `${status.seat.used} of ${status.seat.limit} in use` : 'Not assigned yet'}
        />
        <Fact label="Renews or expires" value={formatDay(status.expiresAt) ?? 'No expiry'} />
        <Fact label="Last check" value={lastCheckLabel(status)} />
      </div>

      {status.features.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {status.features.map((feature) => (
            <span key={feature} className="rounded-full bg-subtle px-2.5 py-0.5 text-caption text-muted">
              {feature}
            </span>
          ))}
        </div>
      )}

      {advisories.map((gap) => (
        <div key={gap.code} className="rounded-md border border-border px-3 py-2.5 text-small text-muted">
          {gap.message}
        </div>
      ))}

      {/* Enforcement, stated honestly in both directions: while it is off,
          nothing here is gated, and implying otherwise would be a scare. */}
      <div className="flex items-start gap-2 text-caption text-muted">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          {status.enforcing
            ? 'Licensing is enforced for this product.'
            : 'Enforcement is not active yet — nothing on this Mac is gated by licensing.'}
        </span>
      </div>

      {/* Costs nothing to say, and saying it is the whole point. Kept in step
          with installFacts() + activateLicense() in src/licensing/license-client.ts. */}
      <p className="text-caption text-faint">
        Each check sends your license key, a random ID generated on this Mac (not a hardware serial), the app
        version, your OS version, and your CPU type. First activation also includes this computer&rsquo;s name, and
        your relay pair ID when mobile access is set up. Nothing else.
      </p>
    </div>
  );
}

export function LicenseCard() {
  const license = usePoll(['license-status'], getLicenseStatus, 60000);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const data = license.data;

  async function checkNow() {
    setChecking(true);
    setCheckNote(null);
    try {
      const result = await refreshLicense();
      // A failed check is reported as a failed CHECK, never as a failed
      // license — the status below is still whatever it legitimately was.
      if (result.tick?.outcome === 'unreachable') {
        setCheckNote("Couldn't reach the license server just now. Your license is unaffected.");
      } else if (result.tick?.ran === false && result.tick.reason === 'no_key') {
        setCheckNote('No license key is stored yet.');
      }
      await license.refetch();
    } catch {
      setCheckNote("Couldn't run the check. Your license is unaffected.");
    } finally {
      setChecking(false);
    }
  }

  const view = data ? present(data) : null;

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="mb-1 flex items-center gap-2 text-h3 text-fg">
            <BadgeCheck className="h-5 w-5 text-muted" aria-hidden /> License
          </h3>
          <p className="text-small text-muted">How this Mac is licensed, and when it last checked in.</p>
        </div>
        <div className="flex items-center gap-2">
          {view && <StatusPill tone={view.tone}>{view.pill}</StatusPill>}
          <Button variant="secondary" size="sm" onClick={() => void checkNow()} disabled={checking}>
            <RefreshCw className={checking ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden /> Check now
          </Button>
        </div>
      </div>

      {checkNote && <p className="mb-3 text-small text-muted">{checkNote}</p>}

      {license.isLoading && !data ? (
        <Skeleton className="h-40 w-full" />
      ) : data ? (
        <LicenseBody status={data} />
      ) : (
        <p className="text-small text-muted">
          Couldn&rsquo;t load license status from the daemon. Nothing about your license has changed.
        </p>
      )}
    </Card>
  );
}
