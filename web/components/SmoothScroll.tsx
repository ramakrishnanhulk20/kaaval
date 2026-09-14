"use client";

import Lenis from "lenis";
import { useEffect } from "react";

let instance: Lenis | null = null;

/** Lenis, off entirely when the reader asked for less motion. */
export function SmoothScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const lenis = new Lenis({ duration: 1.1, wheelMultiplier: 0.9, touchMultiplier: 1.4 });
    instance = lenis;
    let frame = 0;
    const raf = (time: number): void => {
      lenis.raf(time);
      frame = requestAnimationFrame(raf);
    };
    frame = requestAnimationFrame(raf);

    return () => {
      cancelAnimationFrame(frame);
      lenis.destroy();
      instance = null;
    };
  }, []);

  return null;
}

/**
 * Anchor jumps go through the same Lenis instance that drives the wheel, otherwise the
 * browser's own smooth scroll and the animation loop fight each other and the page stutters.
 */
export function scrollToId(id: string): void {
  const target = document.querySelector(id);
  if (!(target instanceof HTMLElement)) return;
  if (instance) {
    instance.scrollTo(target, { offset: -72, duration: 1.2 });
    return;
  }
  target.scrollIntoView({ behavior: "auto", block: "start" });
}
