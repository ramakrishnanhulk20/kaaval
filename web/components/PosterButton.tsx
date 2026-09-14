"use client";

import Link from "next/link";
import { scrollToId } from "@/components/SmoothScroll";

interface Props {
  href: string;
  children: React.ReactNode;
  tone?: "solid" | "quiet";
  /** The glyph after the label. A download says so with an arrow. */
  glyph?: string;
  download?: boolean;
}

/** Eight pixel corners, never a pill: this is a record, not a consumer app. */
export function PosterButton({ href, children, tone = "solid", glyph = ">", download = false }: Props) {
  const base =
    "group inline-flex items-center gap-3 rounded-[8px] border px-5 py-3 font-mono text-[11px] uppercase tracking-[0.22em] transition-colors duration-300";
  const skin =
    tone === "solid"
      ? "border-ink/70 text-ink hover:bg-ink hover:text-ground"
      : "border-hair text-dim hover:border-ink/60 hover:text-ink";

  const inner = (
    <>
      {children}
      <span
        className={`inline-block transition-transform duration-300 ease-out ${
          download ? "group-hover:translate-y-0.5" : "group-hover:translate-x-1"
        }`}
      >
        {glyph}
      </span>
    </>
  );

  if (href.startsWith("#")) {
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          scrollToId(href);
        }}
        className={`${base} ${skin}`}
      >
        {inner}
      </a>
    );
  }

  // A file route is fetched, never client routed, or Next would try to render the CSV.
  if (download) {
    return (
      <a href={href} download className={`${base} ${skin}`}>
        {inner}
      </a>
    );
  }

  return (
    <Link href={href} className={`${base} ${skin}`}>
      {inner}
    </Link>
  );
}
