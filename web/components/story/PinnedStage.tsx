"use client";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

interface Props {
  /** How many screens the stage holds. One idea per screen. */
  screens: number;
  /** Called on every frame with the stage progress and each screen's own progress. */
  onFrame?: (progress: number, local: number[]) => void;
  className?: string;
  children: ReactNode;
}

/** Where a screen fades in and out, as a share of the whole pinned beat. */
export function screenVars(index: number, screens: number): CSSProperties {
  const span = 1 / screens;
  const from = index === 0 ? -0.06 : index * span - 0.015;
  const to = index === screens - 1 ? 1.06 : (index + 1) * span + 0.015;
  return {
    ["--from" as string]: from.toFixed(4),
    ["--to" as string]: to.toFixed(4),
    ["--g" as string]: `var(--g${String(index)})`,
  };
}

/**
 * A beat that holds still while the reader scrolls through it.
 *
 * The scroll position is published as CSS custom properties on the stage, --p for the whole
 * beat and --g0, --g1 and so on for each screen, and every screen animates itself off those
 * in CSS. React renders this once; nothing here sets state, so no frame costs a render.
 * When the reader asks for less motion the pin is never created and the CSS in globals.css
 * lays the same screens out stacked and finished.
 */
export function PinnedStage({ screens, onFrame, className, children }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef(0);
  const currentRef = useRef(0);

  useEffect(() => {
    const wrap = wrapRef.current;
    const stage = stageRef.current;
    if (!wrap || !stage) return;

    const write = (value: number): void => {
      stage.style.setProperty("--p", value.toFixed(4));
      const local: number[] = [];
      for (let index = 0; index < screens; index += 1) {
        const span = 1 / screens;
        // Each screen finishes its own arrival in the first half of its window, so a
        // gauge or a chain is fully drawn while the reader is still reading it.
        const raw = (value - index * span) / (span * 0.5);
        const clamped = raw < 0 ? 0 : raw > 1 ? 1 : raw;
        stage.style.setProperty(`--g${String(index)}`, clamped.toFixed(4));
        local.push(clamped);
      }
      onFrame?.(value, local);
    };

    // Read at run time, not at render time: the server has no media query, and a component
    // that renders differently in the browser tears its own markup apart.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      write(1);
      return;
    }

    gsap.registerPlugin(ScrollTrigger);
    const trigger = ScrollTrigger.create({
      trigger: wrap,
      // The nav and the ticker strip are fixed and 80 pixels tall together, so the stage
      // pins under them rather than behind them.
      start: "top 80px",
      end: "bottom bottom",
      pin: stage,
      pinSpacing: false,
      anticipatePin: 1,
      onUpdate: (self) => {
        targetRef.current = self.progress;
      },
    });

    let frame = 0;
    const step = (): void => {
      const next = currentRef.current + (targetRef.current - currentRef.current) * 0.14;
      if (Math.abs(next - currentRef.current) > 0.00005) {
        currentRef.current = next;
        write(next);
      }
      frame = requestAnimationFrame(step);
    };
    write(0);
    frame = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(frame);
      trigger.kill();
    };
  }, [screens, onFrame]);

  return (
    <div ref={wrapRef} className="story-scroll relative">
      <div
        ref={stageRef}
        className={`story-stage relative w-full overflow-hidden bg-ground ${className ?? ""}`}
        style={{ ["--p" as string]: "0" }}
      >
        {children}
      </div>
    </div>
  );
}
