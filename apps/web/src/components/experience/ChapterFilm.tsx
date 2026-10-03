"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./ChapterFilm.module.css";

export type CinematicScene =
  | "world"
  | "loop"
  | "memory"
  | "tools"
  | "team"
  | "outro";
export type CinematicFilmScene = CinematicScene | "intro";
export type FilmState =
  | "still"
  | "loading"
  | "playing"
  | "paused"
  | "ended"
  | "error";

type FilmSlot = {
  frame: HTMLDivElement;
  video: HTMLVideoElement;
  enabled: boolean;
  attached: boolean;
  ready: boolean;
  ended: boolean;
  failed: boolean;
  pending: boolean;
  generation: number;
  report: (state: FilmState) => void;
};

// One arbiter for every mounted chapter. No timer or continuous geometry polling:
// scroll, visibility, intersection and media events nominate the next frame.
const films = new Set<FilmSlot>();
let activeFilm: FilmSlot | null = null;
let scheduledFrame = 0;

function pauseFilm(film: FilmSlot) {
  if (film.pending) {
    film.generation += 1;
    film.pending = false;
  }
  if (!film.video.paused) film.video.pause();
  if (film.failed) film.report("error");
  else if (film.ended) film.report("ended");
  else if (film.attached) film.report(film.ready ? "paused" : "loading");
  else film.report("still");
}

function reconcileFilms() {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight;
  const candidates: Array<{ film: FilmSlot; visible: number; center: number }> =
    [];
  if (!document.hidden) {
    for (const film of films) {
      if (film.video.ended) {
        film.ended = true;
        film.report("ended");
      }
      if (!film.enabled || !film.attached || film.failed || film.ended)
        continue;
      const bounds = film.video.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) continue;
      const visibleWidth = Math.max(
        0,
        Math.min(viewportWidth, bounds.right) - Math.max(0, bounds.left),
      );
      const visibleHeight = Math.max(
        0,
        Math.min(viewportHeight, bounds.bottom) - Math.max(0, bounds.top),
      );
      if (!visibleWidth || !visibleHeight) continue;
      candidates.push({
        film,
        visible:
          (visibleWidth * visibleHeight) / (bounds.width * bounds.height),
        center: Math.abs((bounds.top + bounds.bottom) / 2 - viewportHeight / 2),
      });
    }
  }
  // A larger visible fraction wins. At equal visibility, prefer the chapter
  // nearest the center, keeping the existing winner on an exact tie.
  candidates.sort(
    (a, b) =>
      b.visible - a.visible ||
      a.center - b.center ||
      Number(b.film === activeFilm) - Number(a.film === activeFilm),
  );
  const next = candidates[0]?.film ?? null;
  activeFilm = next;
  // Pause every other player before calling play on the selected element.
  for (const film of films) if (film !== next) pauseFilm(film);
  if (!next || next.pending || !next.video.paused) return;
  next.pending = true;
  const generation = ++next.generation;
  next.report(next.ready ? "paused" : "loading");
  void next.video
    .play()
    .then(() => {
      if (generation !== next.generation) return;
      next.pending = false;
      if (activeFilm !== next || !next.enabled || document.hidden) {
        pauseFilm(next);
        return;
      }
      next.report("playing");
    })
    .catch(() => {
      // pause(), a removed source, or another winning chapter can cancel a
      // pending play. Only a failure of the current request is a media error.
      if (
        generation !== next.generation ||
        activeFilm !== next ||
        !next.enabled
      )
        return;
      next.pending = false;
      next.failed = true;
      next.video.pause();
      next.report("error");
      activeFilm = null;
      scheduleReconcile();
    });
}

function scheduleReconcile() {
  if (scheduledFrame) return;
  scheduledFrame = window.requestAnimationFrame(() => {
    scheduledFrame = 0;
    reconcileFilms();
  });
}

function visibilityChanged() {
  // Hidden documents may not receive an animation frame. Pause synchronously.
  if (scheduledFrame) window.cancelAnimationFrame(scheduledFrame);
  scheduledFrame = 0;
  reconcileFilms();
}

function registerFilm(film: FilmSlot) {
  const first = films.size === 0;
  films.add(film);
  if (first) {
    window.addEventListener("scroll", scheduleReconcile, { passive: true });
    window.addEventListener("resize", scheduleReconcile, { passive: true });
    document.addEventListener("visibilitychange", visibilityChanged);
  }
  scheduleReconcile();
  return () => {
    // Cleanup can also run during an unmount, so stop reporting React state.
    film.report = () => {};
    pauseFilm(film);
    films.delete(film);
    if (activeFilm === film) activeFilm = null;
    if (!films.size) {
      if (scheduledFrame) window.cancelAnimationFrame(scheduledFrame);
      scheduledFrame = 0;
      window.removeEventListener("scroll", scheduleReconcile);
      window.removeEventListener("resize", scheduleReconcile);
      document.removeEventListener("visibilitychange", visibilityChanged);
    } else scheduleReconcile();
  };
}

export type ChapterFilmProps = {
  scene: CinematicScene;
  paused: boolean;
  hasFilm: boolean;
  className?: string;
};

/** Registers intro or chapter footage in one shared playback pool. Attach the
 * refs to the positioned media frame and its video; use src without autoplay. */
export function useCinematicFilm({
  scene,
  paused,
  hasFilm,
  source,
  manual = false,
}: {
  scene: CinematicFilmScene;
  source?: string;
  manual?: boolean;
  paused: boolean;
  hasFilm: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const slot = useRef<FilmSlot | null>(null);
  const previousTime = useRef(0);
  const [preferences, setPreferences] = useState({
    ready: false,
    blocked: true,
  });
  const [nearViewport, setNearViewport] = useState(false);
  const [sourceAttached, setSourceAttached] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [state, setState] = useState<FilmState>("still");
  const allowed = preferences.ready && !preferences.blocked && hasFilm;
  const attached = allowed && sourceAttached;

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const connection = (
      navigator as Navigator & {
        connection?: EventTarget & { saveData?: boolean };
      }
    ).connection;
    const sync = () =>
      setPreferences({
        ready: true,
        blocked: motion.matches || Boolean(connection?.saveData),
      });
    sync();
    motion.addEventListener("change", sync);
    connection?.addEventListener("change", sync);
    return () => {
      motion.removeEventListener("change", sync);
      connection?.removeEventListener("change", sync);
    };
  }, []);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const near = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setNearViewport(true);
          near.disconnect();
        }
      },
      { rootMargin: "500px 0px" },
    );
    near.observe(element);
    return () => near.disconnect();
  }, []);

  useEffect(() => {
    // Never attach a video URL in the server/initial client render, for a data
    // saver, or for reduced motion. Once loaded, ordinary scrolling keeps it.
    if (allowed && nearViewport && !paused) setSourceAttached(true);
  }, [allowed, nearViewport, paused]);

  useEffect(() => {
    const element = video.current;
    const container = frame.current;
    if (!element || !container || !hasFilm) return;
    previousTime.current = 0;
    setVideoReady(false);
    setState("still");
    const current: FilmSlot = {
      frame: container,
      video: element,
      enabled: false,
      attached: false,
      ready: false,
      ended: false,
      failed: false,
      pending: false,
      generation: 0,
      report: setState,
    };
    slot.current = current;
    const cleanup = registerFilm(current);
    const intersections = new IntersectionObserver(scheduleReconcile, {
      threshold: [0, 0.01, 0.25, 0.5, 0.75, 1],
    });
    const sizes = new ResizeObserver(scheduleReconcile);
    intersections.observe(container);
    sizes.observe(container);
    const loaded = () => {
      if (!current.attached) return;
      current.ready = true;
      setVideoReady(true);
      current.report(current.ended ? "ended" : "paused");
      scheduleReconcile();
    };
    const metadata = () => {
      // Reattaching after an OS/network preference change restores the frame,
      // just as an ordinary reverse scroll retains currentTime automatically.
      if (previousTime.current > 0 && Number.isFinite(element.duration)) {
        element.currentTime = Math.min(previousTime.current, element.duration);
      }
    };
    const time = () => {
      if (element.readyState >= HTMLMediaElement.HAVE_METADATA)
        previousTime.current = element.currentTime;
    };
    const playing = () => {
      if (activeFilm !== current || !current.enabled || document.hidden) {
        element.pause();
        return;
      }
      current.report("playing");
    };
    const stopped = () => {
      if (!current.failed && !current.ended)
        current.report(
          current.attached ? (current.ready ? "paused" : "loading") : "still",
        );
    };
    const ended = () => {
      current.ended = true;
      current.pending = false;
      current.report("ended");
      scheduleReconcile();
    };
    const failed = () => {
      if (!element.error || !current.attached) return;
      current.failed = true;
      current.pending = false;
      current.generation += 1;
      element.pause();
      current.report("error");
      scheduleReconcile();
    };
    element.addEventListener("loadedmetadata", metadata);
    element.addEventListener("loadeddata", loaded);
    element.addEventListener("timeupdate", time);
    element.addEventListener("playing", playing);
    element.addEventListener("pause", stopped);
    element.addEventListener("ended", ended);
    element.addEventListener("error", failed);
    return () => {
      intersections.disconnect();
      sizes.disconnect();
      element.removeEventListener("loadedmetadata", metadata);
      element.removeEventListener("loadeddata", loaded);
      element.removeEventListener("timeupdate", time);
      element.removeEventListener("playing", playing);
      element.removeEventListener("pause", stopped);
      element.removeEventListener("ended", ended);
      element.removeEventListener("error", failed);
      cleanup();
      slot.current = null;
    };
  }, [scene, hasFilm]);

  useEffect(() => {
    const current = slot.current;
    if (!current) return;
    const wasAttached = current.attached;
    current.attached = attached;
    current.enabled = attached && !paused && !manual;
    if (!attached) {
      current.ready = false;
      setVideoReady(false);
      // Abort an existing download when the user enables reduced motion or
      // data saver. The time ref survives so opting back in can resume it.
      if (wasAttached) current.video.load();
    }
    // Explicit pause must take effect now, even when rAF is suspended.
    if (!current.enabled) pauseFilm(current);
    else scheduleReconcile();
  }, [attached, paused, scene, hasFilm, manual]);

  return {
    frameRef: frame,
    videoRef: video,
    src: attached ? (source ?? `/media/clem-${scene}.mp4`) : undefined,
    state: (allowed ? state : "still") as FilmState,
    videoReady: allowed && videoReady && state !== "error",
  };
}

/** Decorative, once-through chapter footage. The surrounding page owns copy,
 * controls and meaning; a poster is the complete static presentation. */
export function ChapterFilm({
  scene,
  paused,
  hasFilm,
  className = "",
}: ChapterFilmProps) {
  const film = useCinematicFilm({ scene, paused, hasFilm });
  return (
    <div
      ref={film.frameRef}
      className={`${styles.layer} ${className}`.trim()}
      aria-hidden="true"
      data-cinematic-scene={scene}
      data-film-state={film.state}
      data-video-ready={film.videoReady ? "true" : "false"}
    >
      <img
        className={styles.poster}
        src={`/media/clem-${scene}.webp`}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
      />
      {hasFilm && (
        <video
          key={scene}
          ref={film.videoRef}
          className={styles.video}
          src={film.src}
          poster={`/media/clem-${scene}.webp`}
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
          disablePictureInPicture
        />
      )}
    </div>
  );
}
