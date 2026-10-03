"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";
import {
  ArrowDown,
  ArrowUpRight,
  Apple,
  CircleCheck,
  Github,
  Layers3,
  Menu,
  Pause,
  Play,
  ShieldCheck,
  Workflow,
  X,
} from "lucide-react";
import { CinematicHero } from "./CinematicHero";
import { ImmersiveJourney } from "./ImmersiveJourney";

const repository = "https://github.com/Natebreynolds/clemmy";
function Download({
  children = "Download for Mac",
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      className={`action primary ${className}`}
      href="/api/download?arch=arm64"
    >
      <Apple size={18} />
      {children}
      <ArrowUpRight size={16} />
    </a>
  );
}

export default function ClementineExperience({
  hasHeroFilm = false,
  hasHandoffFilm = false,
}: {
  hasHeroFilm?: boolean;
  hasHandoffFilm?: boolean;
}) {
  const systemReduced = useReducedMotion();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  // Keep the first client render identical to SSR; CSS covers reduced motion before hydration.
  const reduced = hydrated && Boolean(systemReduced);
  const [paused, setPaused] = useState(false);
  const [menu, setMenu] = useState(false);
  const noMotion = Boolean(reduced) || paused;
  useEffect(() => {
    if (!menu) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(false);
        document.getElementById("menu-toggle")?.focus();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);
  return (
    <div className={`experience ${noMotion ? "motion-paused" : ""}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <a href="#" className="wordmark" aria-label="Clementine home">
          <span>Clementine</span>
        </a>
        <nav className="desktop-nav" aria-label="Main navigation">
          <a href="#loop">The loop</a>
          <a href="#memory">Memory</a>
          <a href="#tools">Tools</a>
          <a href="#recording">Recording</a>
          <a href="#agents">Agents & models</a>
          <a href="#spaces">Spaces</a>
        </nav>
        <div className="header-actions">
          <button
            className="motion-toggle"
            onClick={() => setPaused(!paused)}
            aria-label={paused ? "Resume animations" : "Pause animations"}
            aria-pressed={paused}
            disabled={Boolean(reduced)}
            title={
              reduced
                ? "Reduced motion is enabled on your device"
                : paused
                  ? "Resume animations"
                  : "Pause animations"
            }
          >
            {noMotion ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <a href="#download" className="nav-download">
            Get Clementine <ArrowDown size={14} />
          </a>
          <button
            className="menu-toggle"
            id="menu-toggle"
            aria-label={menu ? "Close menu" : "Open menu"}
            aria-expanded={menu}
            aria-controls="mobile-nav"
            onClick={() => setMenu(!menu)}
          >
            {menu ? <X /> : <Menu />}
          </button>
        </div>
      </header>
      {menu && (
        <nav
          id="mobile-nav"
          className="mobile-nav"
          aria-label="Mobile navigation"
        >
          {[
            ["#loop", "The loop"],
            ["#memory", "Memory"],
            ["#tools", "Tools"],
            ["#recording", "Recording"],
            ["#agents", "Agents & models"],
            ["#spaces", "Spaces"],
            ["#download", "Download"],
          ].map(([href, label]) => (
            <a key={href} href={href} onClick={() => setMenu(false)}>
              {label}
              <ArrowUpRight size={20} />
            </a>
          ))}
        </nav>
      )}
      <main id="main">
        <CinematicHero paused={noMotion} hasFilm={hasHeroFilm} hasHandoffFilm={hasHandoffFilm} />
        <ImmersiveJourney paused={paused} reduced={reduced} onToggle={() => setPaused((value) => !value)} />
        <Console />
        <section id="download" className="download-section">
          <div className="download-top">
            <span>Your tools. Your context. Your Clementine.</span>
            <ArrowDown size={30} />
          </div>
          <h2>
            Great work starts
            <br />
            with a little <em>Clem.</em>
          </h2>
          <div className="download-bottom">
            <p>
              A local-first AI agent for your Mac.
              <br />
              Bring your models. Give your work a home.
            </p>
            <div>
              <Download />
              <div className="download-options">
                <a href="/api/download?arch=intel">
                  Download for Intel Mac <ArrowUpRight size={13} />
                </a>
                <span>macOS 13+</span>
              </div>
            </div>
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <a href="#" className="wordmark">
          <span>Clementine</span>
        </a>
        <span>Local-first. Open source. Yours.</span>
        <div>
          <a href={repository} target="_blank" rel="noreferrer">
            GitHub <ArrowUpRight size={13} />
          </a>
          <a href={`${repository}/releases`} target="_blank" rel="noreferrer">
            Releases
          </a>
          <a
            href={`${repository}/blob/main/LICENSE`}
            target="_blank"
            rel="noreferrer"
          >
            MIT license
          </a>
        </div>
      </footer>
    </div>
  );
}

function Console() {
  const [screen, setScreen] = useState(0);
  const screens = [
    {
      name: "Chat",
      path: "dashboard.png",
      alt: "Clementine desktop chat and navigation",
    },
    { name: "Memory", path: "memory.jpg", alt: "Clementine memory interface" },
    {
      name: "Automate",
      path: "automate.png",
      alt: "Clementine workflow automation interface",
    },
    {
      name: "Connect",
      path: "connect.png",
      alt: "Clementine connected tools interface",
    },
  ];
  return (
    <section className="console-section" id="console">
      <div className="section-intro">
        <h2>
          It all comes
          <br />
          <em>home.</em>
        </h2>
        <div>
          <p>
            A conversation is the starting point.
            <br />
            Your Mac is where it comes together.
          </p>
          <div className="console-tabs" aria-label="Explore the console">
            {screens.map((s, i) => (
              <button
                key={s.name}
                aria-pressed={screen === i}
                onClick={() => setScreen(i)}
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
      </div>
      <figure className="console-frame">
        <div className="console-bar">
          <span className="window-dots">
            <i />
            <i />
            <i />
          </span>
          <span>Clementine / {screens[screen].name}</span>
          <span>Desktop app</span>
        </div>
        <img
          src={`/screenshots/${screens[screen].path}`}
          alt={screens[screen].alt}
          width={1440}
          height={900}
          loading="lazy"
        />
        <figcaption>
          From the Clementine console. Appearance varies with version and
          preferences.
        </figcaption>
      </figure>
      <div className="continuity-rows">
        <div>
          <Workflow size={24} />
          <h3>Work that keeps going.</h3>
          <p>
            Saved workflows, background tasks, and check-ins keep work moving
            beyond a single reply.
          </p>
        </div>
        <div>
          <Layers3 size={24} />
          <h3>More ways to be together.</h3>
          <p>
            Chat, voice, meetings, and mobile access connect to the same
            local-first system.
          </p>
        </div>
        <div>
          <CircleCheck size={24} />
          <h3>You stay in the loop.</h3>
          <p>
            See progress, review the evidence, steer the task, and respond when
            Clem needs you.
          </p>
        </div>
      </div>
      <div className="local-note">
        <ShieldCheck size={20} />
        <p>
          <strong>Local-first, with connected intelligence.</strong> Clementine
          runs on your Mac. Model providers and connected services receive the
          data needed for the work you ask them to do.
        </p>
        <a href={repository} target="_blank" rel="noreferrer">
          See how it’s built <Github size={17} />
        </a>
      </div>
    </section>
  );
}
