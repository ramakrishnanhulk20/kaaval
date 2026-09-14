"use client";

import { motion } from "framer-motion";

const EASE = [0.16, 1, 0.3, 1] as const;

interface Props {
  children: React.ReactNode;
  /** Position in a staggered group. Each step adds 60 milliseconds. */
  index?: number;
  delay?: number;
  className?: string;
  as?: "div" | "li" | "tr" | "section";
}

/** Fade and rise, once, when it comes into view. Nothing on the page just appears. */
export function Reveal({ children, index = 0, delay = 0, className, as = "div" }: Props) {
  const Tag = motion[as];

  return (
    <Tag
      data-reveal
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.7, delay: delay + index * 0.06, ease: EASE }}
      className={className}
    >
      {children}
    </Tag>
  );
}
