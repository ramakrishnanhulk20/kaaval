"use client";

import { useEffect, useId, useRef, useState } from "react";

const NIGHT = {
  background: "#0a0a0a",
  primaryColor: "#121212",
  primaryTextColor: "#edeae3",
  primaryBorderColor: "rgba(237, 234, 227, 0.22)",
  secondaryColor: "#161616",
  tertiaryColor: "#0f0f0f",
  lineColor: "#6e6a63",
  textColor: "#edeae3",
  mainBkg: "#121212",
  nodeBorder: "rgba(237, 234, 227, 0.22)",
  clusterBkg: "rgba(237, 234, 227, 0.03)",
  clusterBorder: "rgba(237, 234, 227, 0.12)",
  edgeLabelBackground: "#0a0a0a",
  titleColor: "#edeae3",
  actorBkg: "#121212",
  actorBorder: "#ffb020",
  actorTextColor: "#edeae3",
  actorLineColor: "#6e6a63",
  signalColor: "#edeae3",
  signalTextColor: "#edeae3",
  labelBoxBkgColor: "#121212",
  labelBoxBorderColor: "#ffb020",
  labelTextColor: "#edeae3",
  loopTextColor: "#edeae3",
  noteBkgColor: "#1a1509",
  noteBorderColor: "#ffb020",
  noteTextColor: "#edeae3",
  sequenceNumberColor: "#0a0a0a",
  activationBkgColor: "#ffb020",
  activationBorderColor: "#ffb020",
};

/**
 * Mermaid needs a live DOM to measure text, so the diagrams are drawn in the browser.
 * The package is a megabyte, so it is only fetched on a page that actually has one.
 */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"drawing" | "drawn" | "failed">("drawing");
  const [scrolls, setScrolls] = useState(false);

  useEffect(() => {
    let alive = true;

    const draw = async (): Promise<void> => {
      const { default: mermaid } = await import("mermaid");
      // Mermaid measures a label in a scratch node where a CSS variable does not resolve,
      // so it is handed the family name next/font actually generated, not the variable.
      const plexMono = getComputedStyle(document.documentElement)
        .getPropertyValue("--font-plex-mono")
        .trim();
      const mono = plexMono === "" ? "ui-monospace, monospace" : `${plexMono}, ui-monospace, monospace`;

      // The web font swaps in late. Measuring a label before it lands sizes every box for
      // the fallback and the real text then overflows it.
      if (document.fonts !== undefined) await document.fonts.ready;

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: {
          ...NIGHT,
          fontFamily: mono,
          fontSize: "14px",
        },
        flowchart: { curve: "basis", padding: 18, useMaxWidth: true },
        sequence: { useMaxWidth: true, actorMargin: 42, mirrorActors: false },
      });

      const { svg } = await mermaid.render(`kaaval-${id}`, chart);
      if (!alive || host.current === null) return;
      host.current.innerHTML = svg;
      setState("drawn");
      const pane = host.current.parentElement;
      if (pane !== null) setScrolls(pane.scrollWidth > pane.clientWidth + 1);
    };

    draw().catch(() => {
      if (alive) setState("failed");
    });

    return () => {
      alive = false;
    };
  }, [chart, id]);

  return (
    <figure className="kaaval-mermaid not-prose relative my-10 rounded-lg border border-hair bg-[#0c0c0c]">
      <div className="fd-scroll-container overflow-x-auto p-4 sm:p-6">
        <div ref={host} aria-hidden={state !== "drawn"} />
        {state === "drawing" ? (
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-dim">
            drawing the diagram
          </p>
        ) : null}
        {state === "failed" ? (
          <pre className="font-mono text-[12px] leading-relaxed text-dim">{chart}</pre>
        ) : null}
      </div>
      {state === "drawn" && scrolls ? (
        <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end px-4 pb-2 font-mono text-[10px] uppercase tracking-[0.24em] text-dim sm:px-6">
          drag sideways
        </figcaption>
      ) : null}
    </figure>
  );
}
