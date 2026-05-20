export function Footer() {
  return (
    <footer className="border-t border-black/8 px-6 py-12 bg-[var(--bg)]">
      <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-6 text-sm text-[var(--ink-dim)]">
        <div className="flex items-center gap-3">
          <img
            src="/logo.png"
            alt=""
            width={28}
            height={28}
            style={{ imageRendering: "pixelated" }}
          />
          <div className="font-mono text-xs tracking-wide">
            clementine · single-user · local-first · MIT
          </div>
        </div>
        <div className="flex items-center gap-6">
          <a
            href="https://github.com/Natebreynolds/clemmy"
            target="_blank"
            rel="noreferrer"
            className="hover:text-[var(--ink-strong)] transition-colors"
          >
            GitHub
          </a>
          <a
            href="https://github.com/Natebreynolds/clemmy/releases"
            target="_blank"
            rel="noreferrer"
            className="hover:text-[var(--ink-strong)] transition-colors"
          >
            Releases
          </a>
          <a
            href="https://github.com/Natebreynolds/clemmy/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer"
            className="hover:text-[var(--ink-strong)] transition-colors"
          >
            License
          </a>
        </div>
      </div>
    </footer>
  );
}
