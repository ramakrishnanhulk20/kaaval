"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { Fragment, useRef, useSyncExternalStore } from "react";
import { EquityCurves, type CurveInput } from "@/components/EquityCurves";
import { PosterButton } from "@/components/PosterButton";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export interface LegendEntry {
  brain: string;
  marks: number;
  equity: number | null;
  changePct: number | null;
}

export interface HeroAction {
  label: string;
  href: string;
  tone?: "solid" | "quiet";
}

/** What the two buttons say when a page does not ask for its own pair. */
const DEFAULT_ACTIONS: HeroAction[] = [
  { label: "Read the record", href: "#record" },
  { label: "Verify it", href: "#proof", tone: "quiet" },
];

interface Props {
  curves: CurveInput[];
  legend: LegendEntry[];
  startEquity: number | null;
  cadenceMinutes: number;
  metadata: string[];
  body: string;
  /** The line under the title, when the page wants one. */
  tagline?: string;
  actions?: HeroAction[];
  lastTickLabel: string | null;
  paused: boolean;
}

const RISE = {
  hidden: { opacity: 0, y: 24 },
  shown: { opacity: 1, y: 0 },
};

export function Hero({
  curves,
  legend,
  startEquity,
  cadenceMinutes,
  metadata,
  body,
  tagline,
  actions = DEFAULT_ACTIONS,
  lastTickLabel,
  paused,
}: Props) {
  const ref = useRef<HTMLElement | null>(null);
  // The server cannot know the visitor's motion preference, so the server snapshot says
  // motion on and hydration matches; React then re-renders with the real preference, which
  // is what an effect setting state would have done without the cascading render.
  const reduced = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const curveY = useTransform(scrollYProgress, [0, 1], ["0%", "-14%"]);
  const curveScale = useTransform(scrollYProgress, [0, 1], [1, 1.1]);
  const textY = useTransform(scrollYProgress, [0, 1], ["0%", "-4%"]);
  const textFade = useTransform(scrollYProgress, [0, 0.75], [1, 0]);

  const ease = [0.16, 1, 0.3, 1] as const;
  const enter = (delay: number) => ({
    initial: reduced ? "shown" : "hidden",
    animate: "shown",
    variants: RISE,
    transition: { duration: 0.9, delay: reduced ? 0 : delay, ease },
  });

  return (
    <section
      ref={ref}
      data-hero
      className="relative flex min-h-[100svh] w-full flex-col justify-end overflow-hidden pt-24"
    >
      <motion.div
        aria-hidden
        style={reduced ? undefined : { y: curveY, scale: curveScale }}
        className="absolute inset-0"
      >
        <EquityCurves
          className="absolute inset-0"
          curves={curves}
          startEquity={startEquity}
          cadenceMinutes={cadenceMinutes}
        />
      </motion.div>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[76%] bg-gradient-to-t from-ground via-ground/88 to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_80%_at_18%_78%,rgba(255,176,32,0.07),transparent_60%)]"
      />

      <motion.ul
        {...enter(0.5)}
        className="absolute top-24 right-4 z-10 hidden w-44 flex-col gap-px text-right sm:flex lg:right-10"
      >
        {legend.map((entry) => (
          <li key={entry.brain} className="border-t border-hair pt-2 pb-3">
            <div className="flex items-center justify-end gap-2">
              <span
                className={`h-px w-6 ${entry.brain === "rules" ? "bg-dim" : "bg-ink"}`}
                style={entry.brain === "rules" ? { opacity: 0.7 } : undefined}
              />
              <span
                className={`font-mono text-[11px] uppercase tracking-[0.22em] ${
                  entry.brain === "rules" ? "text-dim" : "text-ink"
                }`}
              >
                {entry.brain}
              </span>
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-dim">
              {entry.marks} marks
            </div>
            <div className="font-mono text-[11px] tracking-[0.06em]">
              <span className="text-ink/80">
                {entry.equity === null ? "no mark" : entry.equity.toFixed(2)}
              </span>
              {entry.changePct === null ? null : (
                <span className={entry.changePct >= 0 ? " text-gain" : " text-loss"}>
                  {" "}
                  {entry.changePct >= 0 ? "+" : ""}
                  {entry.changePct.toFixed(2)}%
                </span>
              )}
            </div>
          </li>
        ))}
      </motion.ul>

      <motion.div
        style={reduced ? undefined : { y: textY, opacity: textFade }}
        className="relative z-10 px-4 pb-24 sm:px-8 lg:px-12"
      >
        <motion.h1
          {...enter(0.15)}
          className="font-display font-extrabold text-ink"
          style={{ fontSize: "clamp(4rem, 14vw, 12rem)", letterSpacing: "-0.04em", lineHeight: 0.9 }}
        >
          KAAVAL
        </motion.h1>

        <div className="draw-rule mt-5 h-px w-full max-w-[52rem] bg-amber" />

        {tagline === undefined ? null : (
          <motion.p
            {...enter(0.25)}
            className="mt-5 max-w-[34ch] font-display font-extrabold text-ink"
            style={{
              fontSize: "clamp(1.4rem, 3.2vw, 2.4rem)",
              letterSpacing: "-0.03em",
              lineHeight: 1.05,
            }}
          >
            {tagline}
          </motion.p>
        )}

        <motion.ul
          {...enter(0.3)}
          className="mt-5 flex flex-wrap items-center gap-2 font-mono text-[10px] tracking-[0.14em] text-dim sm:gap-3 sm:text-[11px] sm:tracking-[0.26em]"
        >
          {metadata.map((item, index) => (
            <Fragment key={item}>
              {index === 0 ? null : (
                <li aria-hidden className="text-ink/25">
                  &middot;
                </li>
              )}
              <li>{item}</li>
            </Fragment>
          ))}
        </motion.ul>

        <motion.p {...enter(0.4)} className="mt-7 max-w-[38rem] text-base leading-relaxed text-ink/70">
          {body}
        </motion.p>

        <motion.div {...enter(0.5)} className="mt-9 flex flex-wrap gap-3">
          {actions.map((action) => (
            <PosterButton key={action.label} href={action.href} tone={action.tone}>
              {action.label}
            </PosterButton>
          ))}
        </motion.div>

        {/* The same legend the wide screen hangs beside the curves. There is no room for it
            there on a phone, and without it the curves are two unnamed lines, so it moves
            under them. Each swatch is drawn the way its curve is: the rules baseline cool
            and dashed, a model brain solid and off-white. */}
        <motion.ul
          {...enter(0.55)}
          className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 sm:hidden"
        >
          {legend.map((entry) => (
            <li key={entry.brain} className="flex items-center gap-2">
              <span
                aria-hidden
                className={
                  entry.brain === "rules"
                    ? "w-5 border-t border-dashed border-dim"
                    : "h-px w-5 bg-ink"
                }
              />
              <span
                className={`font-mono text-[10px] uppercase tracking-[0.2em] ${
                  entry.brain === "rules" ? "text-dim" : "text-ink"
                }`}
              >
                {entry.brain}
              </span>
              <span className="font-mono text-[10px] tracking-[0.06em] text-ink/70">
                {entry.equity === null ? "no mark" : entry.equity.toFixed(2)}
              </span>
              {entry.changePct === null ? null : (
                <span
                  className={`font-mono text-[10px] tracking-[0.06em] ${
                    entry.changePct >= 0 ? "text-gain" : "text-loss"
                  }`}
                >
                  {entry.changePct >= 0 ? "+" : ""}
                  {entry.changePct.toFixed(2)}%
                </span>
              )}
            </li>
          ))}
        </motion.ul>
      </motion.div>

      <motion.div
        {...enter(0.65)}
        className="relative z-10 flex items-end justify-between gap-4 px-4 pb-6 sm:px-8 lg:px-12"
      >
        <p className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-dim sm:text-[11px]">
          <span
            aria-hidden
            className={`${paused ? "" : "live-dot "}inline-block h-1.5 w-1.5 rounded-full bg-amber`}
          />
          {lastTickLabel === null ? "no tick recorded yet" : `last tick ${lastTickLabel}`}
          {paused ? <span className="text-amber">record paused</span> : null}
        </p>
        <p
          aria-hidden
          className="hidden items-center gap-2 font-mono text-[10px] uppercase tracking-[0.24em] text-dim sm:flex"
        >
          scroll
          <span className="scroll-caret inline-block">&darr;</span>
        </p>
      </motion.div>
    </section>
  );
}
