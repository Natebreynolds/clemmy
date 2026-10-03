"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useMotionValue, useScroll, useTransform } from "framer-motion";
import { ArrowDown, ArrowRight, ArrowUpRight, Check, FileText, Pause, Pin, Play } from "lucide-react";
import { JourneyWorld } from "./JourneyWorld";
import { RecordingDemo, SpaceDemo } from "./JourneyDemos";
import { useSmoothedProgress } from "./useSmoothedProgress";
import styles from "./ImmersiveJourney.module.css";

const chapters = [
  { id: "loop", label: "The loop", title: <>An idea.<br /><em>A way through.</em></>, body: "A request becomes a plan, a tool call, a result worth checking. Every step carries the work forward." },
  { id: "memory", label: "Memory", title: <>Work moves on.<br /><em>Context stays.</em></>, body: "Preferences, decisions, useful experience. The next conversation can begin with what the last one taught her." },
  { id: "tools", label: "Tools", title: <>Out of the chat.<br /><em>Into your world.</em></>, body: "Connected apps, local files, and the capabilities you add. One conversation, many ways to act." },
  { id: "recording", label: "Recording", title: <>Be in the room.<br /><em>Keep the details.</em></>, body: "Capture an in-person conversation with local transcription, or a meeting through a connected service. Return to the transcript, decisions, and next steps." },
  { id: "agents", label: "Agents & models", title: <>Different minds.<br /><em>Shared direction.</em></>, body: "Clementine coordinates the work. Specialists bring their own instructions and model pins. Results come back for review." },
  { id: "spaces", label: "Spaces", title: <>A useful answer.<br /><em>A living workspace.</em></>, body: "Make the result something you can use: an interactive Space with its own data, views, and actions. Keep a useful process as a workflow." },
];
const stages = [
  ["Understand", "Bring the request, relevant memories, and project context together.", "A concise brief, with links to the source."],
  ["Discover", "Find the capability the task needs, then inspect how to use it.", "Connected search + local project files"],
  ["Act", "Read the sources, pull out decisions, and write the brief.", "Read → synthesize → write"],
  ["Verify", "Check the saved result against the original request. Keep missing evidence visible.", "Saved artifact + source references"],
  ["Learn", "Retain useful preferences and experience for relevant future work.", "Concise, sourced briefs next time"],
  ["Jev", "Built-in System One integration helps choose capabilities, rank context, and evaluate completion evidence when connected.", "Typed decisions, grounded in the current task"],
];
const memories = [
  ["Preference", "“Keep my briefs short, with links to the source.”", "Concise briefs. Source links included."],
  ["Correction", "“Use the new launch date in this project.”", "Updated context replaces the old decision."],
  ["Experience", "“This approach worked. Let’s use it again.”", "A useful procedure, available for recall."],
];
const tools = [
  { label: "Composio", description: "Discover actions across the accounts you connect.", nodes: ["Search messages", "Read a calendar", "Update a spreadsheet"] },
  { label: "Local tools", description: "Use the local runtime to work on your machine.", nodes: ["Read project files", "Run commands", "Create artifacts"] },
  { label: "MCP & skills", description: "Extend the agent with tools and reusable instructions.", nodes: ["Discover MCP tools", "Inspect schemas", "Load relevant skills"] },
];
const projects = [
  { name: "Product launch", file: "launch-brief.md", request: "Find the launch decisions and put a brief in my project.", context: "Positioning notes · Launch decisions · Writing preferences" },
  { name: "Research desk", file: "research-notes.md", request: "Compare the sources and explain the tradeoffs.", context: "Source library · Open questions · Citation preferences" },
  { name: "Build room", file: "implementation-plan.md", request: "Inspect the code and plan the next change.", context: "Repository files · Project instructions · Technical decisions" },
];
const modelOptions = ["Claude Sonnet 5", "GPT-6 Sol", "Grok 4.6", "GLM 5.3 Flash", "Kimi K2.6"];
const roles = ["Researcher", "Builder", "Reviewer"];
const rolePurpose = ["Find the sources", "Make the artifact", "Check the evidence"];
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function ImmersiveJourney({ paused, reduced, onToggle }: { paused: boolean; reduced: boolean; onToggle: () => void }) {
  const section = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: section, offset: ["start start", "end end"] });
  const entrance = useMotionValue(0);
  const entryOpacity = useTransform(entrance, [0, .94, 1], [0, 0, 1]);
  const entryY = useTransform(entrance, [0, 1], ["-100svh", "0svh"]);
  const sourceProgress = useMotionValue(0);
  const [entered, setEntered] = useState(false);
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState(0);
  const [stage, setStage] = useState(0);
  const [memory, setMemory] = useState(0);
  const [tool, setTool] = useState(0);
  const [project, setProject] = useState(0);
  const [models, setModels] = useState(modelOptions.slice(0, 3));
  const [focusedRole, setFocusedRole] = useState(0);
  const [saveData, setSaveData] = useState(false);
  const [flow, setFlow] = useState(false);
  const [layoutReady, setLayoutReady] = useState(false);
  const staticMode = reduced || saveData;
  const reading = flow || staticMode;
  const still = staticMode || paused;
  const worldProgress = useSmoothedProgress(sourceProgress, { paused, reduced: staticMode, damping: 22 });
  const currentProject = projects[project];
  const artifactRotate = useTransform(worldProgress, [0, .28, .56, .8, 1], [0, 2, -3, 1, 0]);
  const artifactY = useTransform(worldProgress, [0, .28, .56, .8, 1], [0, -10, 6, -5, 0]);

  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: EventTarget & { saveData?: boolean } }).connection;
    const mobile = window.matchMedia("(max-width: 799px), (max-height: 759px)");
    const update = () => { setSaveData(Boolean(connection?.saveData)); setFlow(mobile.matches); setLayoutReady(true); };
    update(); connection?.addEventListener("change", update); mobile.addEventListener("change", update);
    return () => { connection?.removeEventListener("change", update); mobile.removeEventListener("change", update); };
  }, []);

  // A bookmarked chapter initially targets the server-rendered desktop anchor.
  // Restore that destination once the responsive document layout is known.
  useEffect(() => {
    if (!layoutReady) return;
    const id = window.location.hash.slice(1);
    if (!chapters.some(chapter => chapter.id === id)) return;
    const frame = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "instant", block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [layoutReady]);

  useEffect(() => {
    const update = (value: number) => setEntered(value > .94);
    update(entrance.get());
    return entrance.on("change", update);
  }, [entrance]);

  useEffect(() => {
    const element = section.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      entrance.set(clamp(1 - element.getBoundingClientRect().top / window.innerHeight));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    // Hydration changes the hero from its static fallback to a sticky chapter.
    // Re-measure that layout change even if the user has not scrolled again.
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    if (element.previousElementSibling) observer.observe(element.previousElementSibling);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [entrance]);

  useEffect(() => {
    if (reading) return;
    const update = (value: number) => {
      sourceProgress.set(value);
      setActive(Math.min(chapters.length - 1, Math.floor(value * chapters.length)));
      section.current?.setAttribute("data-journey-progress", value.toFixed(4));
    };
    update(scrollYProgress.get());
    return scrollYProgress.on("change", update);
  }, [scrollYProgress, sourceProgress, reading]);

  useEffect(() => {
    if (!reading) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const element = section.current;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      setVisible(bounds.top < 100 && bounds.bottom > window.innerHeight * .65);
      const articles = Array.from(element.querySelectorAll<HTMLElement>("[data-story-beat]"));
      let index = 0;
      articles.forEach((article, i) => { if (article.getBoundingClientRect().top <= window.innerHeight * .36) index = i; });
      const beat = articles[index]?.getBoundingClientRect();
      const portion = beat ? clamp((window.innerHeight * .36 - beat.top) / beat.height) : 0;
      const value = (index + portion) / chapters.length;
      setActive(index); sourceProgress.set(staticMode ? .08 : value);
      element.setAttribute("data-journey-progress", value.toFixed(4));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    if (section.current) observer.observe(section.current);
    window.addEventListener("scroll", schedule, { passive: true }); window.addEventListener("resize", schedule); schedule();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); };
  }, [reading, sourceProgress, staticMode]);

  const renderControls = (index: number) => {
    if (index === 0) return <>
      <div className={styles.choices} role="group" aria-label="Explore the agent loop">
        {stages.map(([name], i) => <button key={name} type="button" aria-pressed={stage === i} onClick={() => setStage(i)}>{name}</button>)}
      </div>
      <div className={styles.detail} aria-live="polite"><h3>{stages[stage][0]}</h3><p>{stages[stage][1]}</p></div>
      <p className={styles.note}><strong>Review closes the loop.</strong> Completion review compares the result with the request and its evidence. Missing work can return to the loop.</p>
    </>;
    if (index === 1) return <>
      <div className={styles.choices} role="group" aria-label="Explore how Clementine learns">
        {memories.map(([label], i) => <button type="button" key={label} aria-pressed={memory === i} onClick={() => setMemory(i)}>{label}</button>)}
      </div>
      <div className={styles.detail} aria-live="polite"><blockquote>{memories[memory][1]}</blockquote><p className={styles.retained}><Check size={14} />{memories[memory][2]}</p></div>
      <p className={styles.note}>Relevant context carries forward. Corrections keep it current.</p>
    </>;
    if (index === 2) return <>
      <div className={styles.choices} role="group" aria-label="Explore Clementine’s tools">
        {tools.map(({ label }, i) => <button key={label} type="button" aria-pressed={tool === i} onClick={() => setTool(i)}>{label}</button>)}
      </div>
      <div className={styles.detail} aria-live="polite"><p>{tools[tool].description}</p><ul className={styles.toolActions}>{tools[tool].nodes.map(node => <li key={node}><ArrowUpRight size={14} />{node}</li>)}</ul></div>
      <p className={styles.note}>Your connected accounts, configured permissions, and available tools govern each action.</p>
    </>;
    if (index === 3) return <RecordingDemo />;
    if (index === 5) return <SpaceDemo />;
    return <>
      <label className={styles.projectChoice}>Shared project<select aria-label="Example project" value={project} onChange={event => setProject(Number(event.target.value))}>{projects.map((item, i) => <option key={item.name} value={i}>{item.name}</option>)}</select></label>
      <div className={styles.coordinator}><span>Clementine</span><ArrowRight size={15} /><span>Delegate · gather · review</span></div>
      <div className={styles.modelList} aria-label="Example multi-model agent team">{roles.map((role, i) => <label key={role} data-selected={focusedRole === i}>
        <span><span><Pin size={13} />{role}</span><small>{rolePurpose[i]}</small></span>
        <select aria-label={`Model for ${role}`} value={models[i]} onFocus={() => setFocusedRole(i)} onChange={event => { setFocusedRole(i); setModels(current => current.map((m, at) => at === i ? event.target.value : m)); }}>{modelOptions.map(name => <option key={name}>{name}</option>)}</select>
      </label>)}</div>
      <p className={styles.teamResult} aria-live="polite"><Check size={15} />{roles[focusedRole]} is pinned to {models[focusedRole]}.</p>
      <p className={styles.note}>Try a different model for each role. This illustrative team shares project context; each specialist keeps its own instructions. Available models depend on connected providers.</p>
    </>;
  };

  return <section id="journey" ref={section} className={`${styles.journey} ${reading ? styles.flow : ""} ${staticMode ? styles.still : ""}`} data-journey-stage={chapters[active].id} data-motion={still ? "off" : "on"} data-layout={reading ? "flow" : "cinematic"} data-journey-visible={visible} aria-label="Inside Clementine">
    {!reading && chapters.map((chapter, i) => <span key={chapter.id} id={chapter.id} className={styles.anchor} style={{ top: `calc(${i / chapters.length} * (100% - 100svh) + ${i ? 2 : 0}px)` }} />)}
    <motion.div className={styles.viewport} style={staticMode ? undefined : { opacity: entryOpacity, ...(reading ? {} : { y: entryY }), pointerEvents: entered ? "auto" : "none" }} inert={!staticMode && !entered} aria-hidden={!staticMode && !entered}>
      <motion.div className={styles.world} style={reading && !staticMode ? { y: entryY } : undefined} aria-hidden="true"><JourneyWorld progress={worldProgress} still={still} detail={active === 0 ? stage : active === 1 ? memory : active === 2 ? tool : focusedRole} /></motion.div>
      <div className={styles.shade} aria-hidden="true" />
      <div className={styles.entryLine}><span>Follow one idea, all the way through.</span><span>Scroll to explore <ArrowDown size={13} /></span></div>
      <div className={styles.narrative}>
        {chapters.map((chapter, i) => <article key={chapter.id} id={reading ? chapter.id : undefined} className={`${styles.beat} ${active === i ? styles.active : ""}`} aria-hidden={!reading && active !== i} inert={!reading && active !== i} aria-labelledby={`${chapter.id}-title`} data-story-beat={chapter.id}>
          <h2 id={`${chapter.id}-title`}>{chapter.title}</h2><p className={styles.body}>{chapter.body}</p>{renderControls(i)}
        </article>)}
      </div>
      <motion.aside className={styles.artifact} style={staticMode ? undefined : reading ? { y: entryY } : { rotate: artifactRotate, y: artifactY }} data-artifact-id="working-brief" aria-label="Illustrative work in progress">
        <div className={styles.artifactHeader}><FileText size={17} /><span>{currentProject.file}</span><span>Example</span></div>
        <p className={styles.request}>“{currentProject.request}”</p>
        <div className={styles.artifactContext}>
          <div><span>Context</span><p>{active === 0 ? currentProject.name : currentProject.context}</p></div>
          {active >= 1 && <div><span>Remember</span><p>{memories[memory][2]}</p></div>}
          {active >= 2 && <div><span>Reach</span><p>{tools[tool].label} <ArrowRight size={12} /> {tools[tool].nodes[0]}</p></div>}
          {active >= 3 && <div><span>Capture</span><p>Transcript · decisions · action items</p></div>}
          {active >= 4 && <div><span>Team</span><p>{models.join(" · ")}</p></div>}
          {active >= 5 && <div><span>Space</span><p>A view you can explore and act on</p></div>}
        </div>
        <div className={styles.artifactStatus}><Check size={14} /><span>{[stages[stage][2], "Useful context carried into the brief", "Sources gathered through available tools", "The conversation becomes useful context", "Specialist work, brought back for review", "A workspace to return to"][active]}</span></div>
      </motion.aside>
      <nav className={styles.rail} aria-label="Journey chapters">
        <div className={styles.railLinks}>{chapters.map((chapter, i) => <a key={chapter.id} href={`#${chapter.id}`} aria-current={active === i ? "step" : undefined}>{chapter.label}</a>)}</div>
        <label className={styles.mobileChapter}><span>{String(active + 1).padStart(2, "0")} / 06</span><select aria-label="Jump to chapter" value={chapters[active].id} onChange={event => {
          const id = event.target.value;
          const destination = document.getElementById(id);
          if (!destination) return;
          if (window.location.hash !== `#${id}`) window.history.pushState(null, "", `#${id}`);
          destination.scrollIntoView({ behavior: staticMode ? "instant" : "smooth", block: "start" });
        }}>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.label}</option>)}</select></label>
        <button type="button" onClick={onToggle} disabled={reduced || saveData} aria-pressed={paused} aria-label={paused ? "Resume immersive motion" : "Pause immersive motion"}>{still ? <Play size={15} /> : <Pause size={15} />}</button>
        <a className={styles.exit} href="#console" aria-label="Continue to the Clementine app"><ArrowDown size={17} /></a>
        {!staticMode && <motion.div className={styles.progress} style={{ scaleX: sourceProgress }} />}
      </nav>
    </motion.div>
  </section>;
}
