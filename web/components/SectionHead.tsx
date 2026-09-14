"use client";

import { motion } from "framer-motion";

const EASE = [0.16, 1, 0.3, 1] as const;

interface Props {
  /** The index in the reading order, printed like a reel number. */
  index: string;
  title: string;
  kicker?: string;
  /** Numbers or controls that sit against the right edge, under the title. */
  aside?: React.ReactNode;
}

/**
 * The repeated motif: a reel number in amber, a title set large and off to the left, and a
 * hairline that draws itself across the full width as the section arrives.
 */
export function SectionHead({ index, title, kicker, aside }: Props) {
  return (
    <div>
      <motion.div
        data-reveal
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.7, ease: EASE }}
        className="flex items-baseline gap-4"
      >
        <span className="font-mono text-[11px] tracking-[0.3em] text-amber">{index}</span>
        {kicker === undefined ? null : (
          <span className="font-mono text-[11px] uppercase tracking-[0.3em] text-dim">{kicker}</span>
        )}
      </motion.div>

      <motion.h2
        data-reveal
        initial={{ opacity: 0, y: 28 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.8, delay: 0.05, ease: EASE }}
        className="mt-4 font-display font-extrabold text-ink"
        style={{ fontSize: "clamp(2.4rem, 7.5vw, 5.5rem)", letterSpacing: "-0.035em", lineHeight: 0.92 }}
      >
        {title}
      </motion.h2>

      <motion.div
        data-reveal
        initial={{ scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 1.1, delay: 0.1, ease: EASE }}
        className="mt-5 h-px w-full origin-left bg-amber"
      />

      {aside === undefined ? null : (
        <motion.div
          data-reveal
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.7, delay: 0.15, ease: EASE }}
          className="mt-5"
        >
          {aside}
        </motion.div>
      )}
    </div>
  );
}
