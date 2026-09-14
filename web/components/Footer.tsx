"use client";

import Link from "next/link";
import { motion } from "framer-motion";

const EASE = [0.16, 1, 0.3, 1] as const;

const PROGRAM_URL = "https://bitget-ai.gitbook.io/bitgetai_hackathons2";
const AGENT_HUB_URL = "https://github.com/Bitget-AI/agent_hub";

interface Destination {
  label: string;
  href: string;
  external?: boolean;
}

const COLUMNS: { heading: string; items: Destination[] }[] = [
  {
    heading: "The record",
    items: [
      { label: "Scoreboard", href: "/#record" },
      { label: "Timeline", href: "/timeline" },
      { label: "Refusals", href: "/refusals" },
      { label: "Rulebook", href: "/rulebook" },
      { label: "Proof", href: "/proof" },
    ],
  },
  {
    heading: "Documentation",
    items: [
      { label: "Overview", href: "/docs" },
      { label: "Quick start", href: "/docs/getting-started/quick-start" },
      { label: "Verify the record", href: "/docs/getting-started/verify-the-record" },
      { label: "FAQ", href: "/docs/faq" },
    ],
  },
  {
    heading: "Bitget",
    items: [
      { label: "AI hackathon", href: PROGRAM_URL, external: true },
      { label: "Agent Hub", href: AGENT_HUB_URL, external: true },
    ],
  },
];

interface Props {
  /** The sister site. The line only appears on a page that hands one over. */
  sisterHref?: string;
}

export function Footer({ sisterHref }: Props = {}) {
  return (
    <footer className="relative z-10 border-t border-hair bg-ground">
      <div className="mx-auto w-full max-w-[1400px] px-4 py-16 sm:px-8 sm:py-20">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)]">
          <motion.div
            data-reveal
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.7, ease: EASE }}
          >
            <Link
              href="/"
              className="inline-block font-display text-[clamp(2.6rem,7vw,4.6rem)] leading-[0.86] font-extrabold tracking-[-0.045em] text-ink transition-opacity duration-300 hover:opacity-70"
            >
              KAAVAL
            </Link>
            <p className="mt-4 max-w-[34ch] font-mono text-[11px] leading-relaxed tracking-[0.14em] text-dim uppercase">
              Tamil for guard, the watchman on the night shift
            </p>
            {sisterHref === undefined ? null : (
              <p className="mt-6 max-w-[34ch] text-[15px] leading-relaxed text-ink/70">
                Vidiyal reads the night back at dawn.{" "}
                <a
                  href={sisterHref}
                  className="text-ink underline decoration-amber underline-offset-4 transition-colors duration-200 hover:text-amber"
                >
                  Open Vidiyal
                </a>
              </p>
            )}
          </motion.div>

          <div className="grid gap-10 sm:grid-cols-3">
            {COLUMNS.map((column, index) => (
              <motion.div
                key={column.heading}
                data-reveal
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.6, delay: 0.06 * index, ease: EASE }}
              >
                <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-amber">
                  {column.heading}
                </p>
                <ul className="mt-4 flex flex-col gap-2.5">
                  {column.items.map((item) => (
                    <li key={item.label}>
                      <FooterLink {...item} />
                    </li>
                  ))}
                </ul>
              </motion.div>
            ))}
          </div>
        </div>

        <div className="mt-16 flex flex-col gap-3 border-t border-hair pt-6 font-mono text-[10px] uppercase tracking-[0.2em] text-dim sm:flex-row sm:items-center sm:justify-between">
          <span>
            <span className="text-amber">Simulated record.</span> No real funds, no live orders.
          </span>
          <span>MIT licence</span>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ label, href, external = false }: Destination) {
  const className =
    "group inline-flex items-baseline gap-2 text-[13px] text-dim transition-colors duration-200 hover:text-ink";
  const arrow = (
    <span
      aria-hidden
      className="inline-block font-mono text-[10px] opacity-0 transition-all duration-300 group-hover:translate-x-0.5 group-hover:opacity-100"
    >
      {external ? "^" : ">"}
    </span>
  );

  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={className}>
        {label}
        {arrow}
      </a>
    );
  }

  return (
    <Link href={href} className={className}>
      {label}
      {arrow}
    </Link>
  );
}
