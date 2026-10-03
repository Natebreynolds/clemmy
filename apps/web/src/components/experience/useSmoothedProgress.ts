"use client";

import { useEffect } from "react";
import { useMotionValue, type MotionValue } from "framer-motion";

type SmoothedProgressOptions = {
  /** Freeze the current rendered value until resumed. */
  paused?: boolean;
  /** Follow intentional input immediately without interpolation. */
  reduced?: boolean;
  /** Exponential response per second. 22 settles quickly without overshoot. */
  damping?: number;
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** A bounded, non-oscillating visual follower; native scrolling stays untouched. */
export function useSmoothedProgress(
  source: MotionValue<number>,
  { paused = false, reduced = false, damping = 22 }: SmoothedProgressOptions = {},
): MotionValue<number> {
  const rendered = useMotionValue(clamp(source.get()));

  useEffect(() => {
    let frame = 0;
    let lastTime = 0;
    let target = clamp(source.get());
    const response = Math.max(1, damping);

    const cancel = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      lastTime = 0;
    };

    const tick = (time: number) => {
      frame = 0;
      if (paused || document.hidden) return;
      const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 1 / 60;
      lastTime = time;
      const current = rendered.get();
      const next = current + (target - current) * (1 - Math.exp(-response * dt));
      if (Math.abs(target - next) < 0.00008) {
        rendered.set(target);
        lastTime = 0;
        return;
      }
      rendered.set(next);
      frame = window.requestAnimationFrame(tick);
    };

    const follow = (value: number) => {
      target = clamp(value);
      if (paused || document.hidden) return;
      // Endpoints are exact so adjacent sticky sections share one paper pose.
      if (reduced || target === 0 || target === 1) {
        cancel();
        rendered.set(target);
        return;
      }
      if (!frame && Math.abs(target - rendered.get()) >= 0.00008) {
        lastTime = 0;
        frame = window.requestAnimationFrame(tick);
      }
    };

    const onVisibility = () => {
      cancel();
      if (!document.hidden && !paused) {
        target = clamp(source.get());
        rendered.set(target);
      }
    };

    const unsubscribe = source.on("change", follow);
    document.addEventListener("visibilitychange", onVisibility);
    follow(source.get());
    return () => {
      cancel();
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [source, rendered, paused, reduced, damping]);

  return rendered;
}
