"use client";

import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AnchorLink } from "@/components/AnchorLink";

interface Destination {
  label: string;
  href: string;
  /** Set when the destination is a section of the home page rather than its own route. */
  anchor?: string;
}

const DESTINATIONS: Destination[] = [
  { label: "Record", href: "/#record", anchor: "#record" },
  { label: "Timeline", href: "/timeline" },
  { label: "Refusals", href: "/refusals" },
  { label: "Rulebook", href: "/rulebook" },
  { label: "Proof", href: "/proof", anchor: "#proof" },
  { label: "Docs", href: "/docs" },
  { label: "Account", href: "/account" },
];

/** The one thing a reader can do here, kept quiet so the index stays the index. */
const CONNECT_HREF = "/connect";

interface Props {
  live: boolean;
  lastTickLabel: string | null;
}

export function Nav({ live, lastTickLabel }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onHome = pathname === "/";
  const title = live ? "the engine ticked within the last half hour" : "no tick in the last half hour";

  return (
    <>
      <nav className="fixed inset-x-0 top-0 z-40 h-11 border-b border-hair bg-ground/85 backdrop-blur-sm">
        <div className="flex h-full items-center justify-between gap-4 px-4 sm:px-6">
          <Link
            href="/"
            className="font-mono text-[11px] uppercase tracking-[0.34em] text-ink transition-opacity duration-200 hover:opacity-70"
          >
            Kaaval
          </Link>

          <div className="hidden items-center gap-5 font-mono text-[11px] uppercase tracking-[0.24em] text-dim sm:flex">
            {DESTINATIONS.map((destination) =>
              onHome && destination.anchor ? (
                <AnchorLink key={destination.label} href={destination.anchor}>
                  {destination.label}
                </AnchorLink>
              ) : (
                <NavLink
                  key={destination.label}
                  href={destination.href}
                  active={pathname === destination.href}
                >
                  {destination.label}
                </NavLink>
              ),
            )}
            <span className="flex items-center gap-2 text-dim" title={title}>
              <span
                aria-hidden
                className={`${live ? "live-dot " : ""}inline-block h-1.5 w-1.5 rounded-full ${
                  live ? "bg-amber" : "bg-dim"
                }`}
              />
              {live ? "Live" : "Paused"}
            </span>

            <Link
              href={CONNECT_HREF}
              className="group inline-flex items-center gap-2 rounded-[8px] border border-hair px-3 py-1.5 text-dim transition-colors duration-300 hover:border-ink/60 hover:text-ink"
            >
              Watch my account
              <span
                aria-hidden
                className="inline-block transition-transform duration-300 group-hover:translate-x-0.5"
              >
                &gt;
              </span>
            </Link>
          </div>

          <button
            type="button"
            onClick={() => {
              setOpen((value) => !value);
            }}
            aria-expanded={open}
            className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.24em] text-dim transition-colors duration-200 hover:text-ink sm:hidden"
          >
            <span
              aria-hidden
              className={`${live ? "live-dot " : ""}inline-block h-1.5 w-1.5 rounded-full ${
                live ? "bg-amber" : "bg-dim"
              }`}
            />
            {open ? "Close" : "Index"}
          </button>
        </div>
      </nav>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="fixed inset-0 z-[39] flex flex-col justify-end bg-ground/97 px-4 pb-16 sm:hidden"
          >
            <ul className="flex flex-col gap-1">
              {DESTINATIONS.map((destination, index) => (
                <motion.li
                  key={destination.label}
                  initial={{ opacity: 0, y: 18 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.05 * index, ease: [0.16, 1, 0.3, 1] }}
                  className="border-t border-hair pt-2"
                >
                  <Link
                    href={destination.href}
                    onClick={() => {
                      setOpen(false);
                    }}
                    className="block font-display text-[2.6rem] leading-[1.05] font-extrabold tracking-[-0.03em] text-ink"
                  >
                    {destination.label.toUpperCase()}
                  </Link>
                </motion.li>
              ))}
            </ul>
            <Link
              href={CONNECT_HREF}
              onClick={() => {
                setOpen(false);
              }}
              className="mt-6 inline-flex items-center gap-3 self-start rounded-[8px] border border-hair px-4 py-2.5 font-mono text-[11px] tracking-[0.22em] text-dim uppercase transition-colors duration-300 hover:border-ink/60 hover:text-ink"
            >
              Watch my account
              <span aria-hidden>&gt;</span>
            </Link>

            <p className="mt-8 font-mono text-[10px] tracking-[0.18em] text-dim">
              {lastTickLabel === null ? "no tick recorded yet" : `last tick ${lastTickLabel}`}
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`group relative inline-block py-1 transition-colors duration-200 hover:text-ink ${
        active ? "text-ink" : ""
      }`}
    >
      {children}
      <span
        className={`absolute inset-x-0 -bottom-px block h-px origin-left bg-amber transition-transform duration-300 ease-out group-hover:scale-x-100 ${
          active ? "scale-x-100" : "scale-x-0"
        }`}
      />
    </Link>
  );
}
