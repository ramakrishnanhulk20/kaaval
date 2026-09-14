"use client";

import { scrollToId } from "@/components/SmoothScroll";

export function AnchorLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        scrollToId(href);
      }}
      className="group relative inline-block py-1 transition-colors duration-200 hover:text-ink"
    >
      {children}
      <span className="absolute inset-x-0 -bottom-px block h-px origin-left scale-x-0 bg-amber transition-transform duration-300 ease-out group-hover:scale-x-100" />
    </a>
  );
}
