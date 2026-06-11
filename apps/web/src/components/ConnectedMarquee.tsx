"use client";

const APPS = [
  "Gmail", "Google Calendar", "Google Sheets", "Google Drive", "Slack",
  "Notion", "Linear", "GitHub", "Stripe", "Airtable", "Supabase",
  "DataForSEO", "Hostinger", "Bright Data", "Apify", "ElevenLabs",
  "Discord", "Asana", "HubSpot", "Salesforce", "Zendesk", "Intercom",
  "Vercel", "Cloudflare", "Twilio", "Sendgrid", "Webflow", "Figma",
  "Jira", "ClickUp", "Trello", "Dropbox", "Box", "OneDrive",
  "Outlook", "Firecrawl", "Google Docs", "LinkedIn", "YouTube", "Vapi",
];

export function ConnectedMarquee() {
  return (
    <section className="relative py-16 overflow-hidden bg-[var(--bg-dim)]/40">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-clem-500/[0.04] to-transparent" />
      <div className="relative max-w-6xl mx-auto px-6">
        <div className="text-center mb-8">
          <div className="font-mono text-xs uppercase tracking-[0.18em] text-clem-700 mb-3">
            Reaches everything you already pay for
          </div>
          <p className="text-[var(--ink-dim)]">
            Composio brokers 200+ apps. MCP brokers another 40+. She uses what you connect.
          </p>
        </div>

        <Strip apps={APPS} className="animate-marquee" />
        <div className="mt-3">
          <Strip apps={[...APPS].reverse()} className="animate-marquee-slow" />
        </div>
      </div>
    </section>
  );
}

function Strip({ apps, className }: { apps: string[]; className: string }) {
  const doubled = [...apps, ...apps];
  return (
    <div className="relative overflow-hidden mask-fade">
      <div
        className={"flex gap-3 whitespace-nowrap w-max " + className}
        style={{ willChange: "transform" }}
      >
        {doubled.map((a, i) => (
          <span
            key={`${a}-${i}`}
            className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 ring-1 ring-black/10 text-sm text-[var(--ink-strong)] hover:ring-clem-500/40 transition-colors shadow-[0_2px_8px_-3px_rgba(80,40,10,0.10)]"
          >
            <span className="size-1.5 rounded-full bg-clem-500" />
            {a}
          </span>
        ))}
      </div>
    </div>
  );
}
