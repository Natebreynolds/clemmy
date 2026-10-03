"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useMotionValue, useTransform, type MotionStyle, type MotionValue } from "framer-motion";
import { Apple, ArrowDown, ArrowUpRight, Check, FileText } from "lucide-react";
import styles from "./CinematicHero.module.css";
import { useCinematicFilm } from "./ChapterFilm";

const HANDOFF_START = 0.04;
const HANDOFF_END = 0.7;

export function CinematicHero({
  paused,
  hasFilm,
  hasHandoffFilm = false,
}: {
  paused: boolean;
  hasFilm: boolean;
  hasHandoffFilm?: boolean;
}) {
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLElement>(null);
  // This seam shares native scroll geometry with the incoming journey. Delaying
  // the outgoing paper alone makes it resize underneath an already-visible copy.
  const renderedProgress = useMotionValue(0);
  const [progress, setProgress] = useState(0);
  const [blocked, setBlocked] = useState(true);
  const [paperOrigin, setPaperOrigin] = useState({ scale: 8, x: 0, y: 0 });

  useEffect(() => {
    setProgress(renderedProgress.get());
    return renderedProgress.on("change", setProgress);
  }, [renderedProgress]);

  useEffect(() => {
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const connection = (
      navigator as Navigator & { connection?: EventTarget & { saveData?: boolean } }
    ).connection;
    const sync = () => setBlocked(motionPreference.matches || Boolean(connection?.saveData));
    sync();
    motionPreference.addEventListener("change", sync);
    connection?.addEventListener("change", sync);
    return () => {
      motionPreference.removeEventListener("change", sync);
      connection?.removeEventListener("change", sync);
    };
  }, []);

  useEffect(() => {
    if (blocked) {
      renderedProgress.set(0);
      return;
    }
    if (paused) return;
    let request = 0;
    const update = () => {
      request = 0;
      const element = section.current;
      if (!element) return;
      const distance = element.offsetHeight - (stage.current?.clientHeight ?? window.innerHeight);
      const next = distance > 0
        ? Math.max(0, Math.min(1, -element.getBoundingClientRect().top / distance))
        : 0;
      renderedProgress.set(next);
    };
    const schedule = () => {
      if (!request) request = window.requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (request) window.cancelAnimationFrame(request);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [blocked, paused, renderedProgress]);

  const idle = useCinematicFilm({
    scene: "intro",
    source: "/media/clem-hero-loop.mp4",
    paused: paused || progress > HANDOFF_START,
    hasFilm,
  });
  const handoff = useCinematicFilm({
    scene: "intro",
    source: "/media/clem-handoff.mp4",
    paused,
    hasFilm: hasHandoffFilm,
    manual: true,
  });

  useEffect(() => {
    const element = handoff.videoRef.current;
    if (!element || !hasHandoffFilm || blocked || paused) return;
    let request = 0;
    const seek = () => {
      request = 0;
      if (document.hidden || !Number.isFinite(element.duration) || element.seeking) return;
      const bounds = stage.current?.getBoundingClientRect();
      if (!bounds || bounds.bottom <= 0 || bounds.top >= window.innerHeight) return;
      const portion = Math.max(
        0,
        Math.min(1, (renderedProgress.get() - HANDOFF_START) / (HANDOFF_END - HANDOFF_START)),
      );
      const target = portion * Math.max(0, element.duration - 1 / 24);
      if (Math.abs(element.currentTime - target) > 1 / 48) element.currentTime = target;
    };
    const schedule = () => {
      if (!request) request = window.requestAnimationFrame(seek);
    };
    const unbind = renderedProgress.on("change", schedule);
    element.addEventListener("loadedmetadata", schedule);
    element.addEventListener("seeked", schedule);
    schedule();
    return () => {
      unbind();
      if (request) window.cancelAnimationFrame(request);
      element.removeEventListener("loadedmetadata", schedule);
      element.removeEventListener("seeked", schedule);
    };
  }, [blocked, paused, hasHandoffFilm, handoff.videoReady, handoff.src, handoff.videoRef, renderedProgress]);

  useEffect(() => {
    const frame = stage.current;
    const sheet = paper.current;
    if (!frame || !sheet) return;
    const measure = () => {
      setPaperOrigin({
        scale: Math.max(frame.clientWidth / sheet.offsetWidth, frame.clientHeight / sheet.offsetHeight) * 1.08,
        x: frame.clientWidth / 2 - sheet.offsetLeft - sheet.offsetWidth / 2,
        y: frame.clientHeight / 2 - sheet.offsetTop - sheet.offsetHeight / 2,
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(sheet);
    measure();
    return () => observer.disconnect();
  }, []);

  const idleOpacity = useTransform(renderedProgress, [0, 0.025, 0.085], [1, 1, 0]);
  const fallbackOpacity = useTransform(renderedProgress, [0, 0.66, 0.75], [1, 1, 0]);
  const handoffOpacity = useTransform(renderedProgress, [0.025, 0.085, 0.7, 0.76], [0, 1, 1, 0]);
  const mobileHandoffTop = useTransform(renderedProgress, [0.025, 0.18], ["42%", "0%"]);
  const mobileHandoffHeight = useTransform(renderedProgress, [0.025, 0.18], ["58%", "100%"]);
  const mobileHandoffPosition = useTransform(renderedProgress, [0.025, 0.18], ["79% 50%", "72% 50%"]);
  const copyOpacity = useTransform(renderedProgress, [0, 0.07, 0.18], [1, 1, 0]);
  const paperOpacity = useTransform(renderedProgress, [0.665, 0.73], [0, 1]);
  const paperScale = useTransform(renderedProgress, [0.74, 0.94], [paperOrigin.scale, 1]);
  const paperX = useTransform(renderedProgress, [0.74, 0.94], [paperOrigin.x, 0]);
  const paperY = useTransform(renderedProgress, [0.74, 0.94], [paperOrigin.y, 0]);
  const paperTextOpacity = useTransform(renderedProgress, [0.82, 0.92], [0, 1]);
  const introductionHidden = !blocked && progress >= 0.18;
  const phase = blocked ? "static" : progress <= HANDOFF_START ? "idle" : progress < 0.74 ? "handoff" : "paper";

  return (
    <section
      ref={section}
      className={`${styles.chapter} ${blocked ? styles.static : ""} ${paused ? styles.paused : ""}`}
      aria-labelledby="hero-title"
      data-hero-phase={phase}
      data-hero-progress={progress.toFixed(4)}
    >
      <div className={styles.stage} ref={stage}>
        <motion.div
          ref={idle.frameRef}
          className={styles.film}
          data-cinematic-scene="intro"
          data-film-state={idle.state}
          aria-hidden={introductionHidden || undefined}
          style={{ opacity: handoff.videoReady ? idleOpacity : fallbackOpacity }}
        >
          <img
            src={hasFilm ? "/media/clem-hero-loop.webp" : "/media/clem-hero-v3.webp"}
            alt="Clem, a reddish caramel French bulldog with a white forehead blaze, white muzzle and chest, on a warm orange stage"
            fetchPriority="high"
            width={1916}
            height={1080}
          />
          {hasFilm && (
            <div className={styles.videoLayer} aria-hidden="true">
              <video
                ref={idle.videoRef}
                src={idle.src}
                poster="/media/clem-hero-loop.webp"
                preload="metadata"
                muted
                playsInline
                loop
                data-hero-film="idle"
                tabIndex={-1}
                disablePictureInPicture
                style={{ opacity: idle.videoReady ? 1 : 0 }}
              />
            </div>
          )}
        </motion.div>
        <motion.div
          ref={handoff.frameRef}
          className={styles.handoffFilm}
          aria-hidden="true"
          style={{ opacity: handoff.videoReady ? handoffOpacity : 0, "--handoff-top": mobileHandoffTop, "--handoff-height": mobileHandoffHeight, "--handoff-position": mobileHandoffPosition } as MotionStyle & Record<`--${string}`, MotionValue<string>>}
        >
          {hasHandoffFilm && (
            <video
              ref={handoff.videoRef}
              src={handoff.src}
              preload="metadata"
              muted
              playsInline
              data-hero-film="handoff"
              tabIndex={-1}
              disablePictureInPicture
            />
          )}
        </motion.div>
        <motion.div className={styles.copyShade} style={{ opacity: copyOpacity }} />
        <motion.div
          className={styles.introduction}
          style={{ opacity: copyOpacity }}
          inert={introductionHidden || undefined}
          aria-hidden={introductionHidden || undefined}
        >
          <h1 id="hero-title" aria-label="Meet Clem.">Meet<br /><span>Clem.</span></h1>
          <p>Always curious. Ever learning.<br />An AI agent that grows with you.</p>
          <div className={styles.actions}>
            <a href="/api/download?arch=arm64"><Apple size={18} /> Bring Clem home <ArrowUpRight size={16} /></a>
            <a href="#loop" className={styles.explore}>Meet the mind <ArrowDown size={16} /></a>
          </div>
          <span className={styles.availability}>Local-first. Made for your Mac.</span>
        </motion.div>
        <motion.aside
          ref={paper}
          className={styles.paper}
          data-artifact-id="hero-handoff"
          aria-label="Illustrative launch brief"
          aria-hidden={blocked || progress < 0.94}
          style={{ opacity: blocked ? 0 : paperOpacity, scale: paperScale, x: paperX, y: paperY }}
        >
          <motion.div className={styles.paperBody} style={{ opacity: paperTextOpacity }}>
            <div className={styles.paperHeader}><FileText size={17} /><span>launch-brief.md</span><span>Example</span></div>
            <p className={styles.paperRequest}>“Find the launch decisions and put a brief in my project.”</p>
            <div className={styles.paperContext}><span>Context</span><p>Product launch</p></div>
            <div className={styles.paperStatus}><Check size={14} /><span>A concise brief, with links to the source.</span></div>
          </motion.div>
        </motion.aside>
        <motion.div
          className={styles.footer}
          style={{ opacity: copyOpacity }}
          inert={introductionHidden || undefined}
          aria-hidden={introductionHidden || undefined}
        >
          <span>Your context.<br /><strong>Carried forward.</strong></span>
          <a href="#journey"><span>Scroll into her mind</span><ArrowDown size={19} /></a>
          <span>One familiar face.<br /><strong>A growing set of possibilities.</strong></span>
        </motion.div>
      </div>
    </section>
  );
}
