export function Footer() {
  return (
    <footer className="border-t border-white/5 px-6 py-12">
      <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-6 text-sm text-[var(--ink-dim)]">
        <div className="font-mono text-xs tracking-wide">
          clementine · single-user · local-first · MIT
        </div>
        <div className="flex items-center gap-6">
          <a
            href="https://github.com/Natebreynolds/clemmy"
            target="_blank"
            rel="noreferrer"
            className="hover:text-white transition-colors"
          >
            GitHub
          </a>
          <a
            href="https://github.com/Natebreynolds/clemmy/releases"
            target="_blank"
            rel="noreferrer"
            className="hover:text-white transition-colors"
          >
            Releases
          </a>
          <a
            href="https://github.com/Natebreynolds/clemmy/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer"
            className="hover:text-white transition-colors"
          >
            License
          </a>
        </div>
      </div>
    </footer>
  );
}
