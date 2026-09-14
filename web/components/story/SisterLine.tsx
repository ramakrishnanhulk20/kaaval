import { Reveal } from "@/components/Reveal";

/** Beat seven: the other half of the day, one line and one link. */
export function SisterLine({ href }: { href: string }) {
  return (
    <section className="relative overflow-hidden border-t border-hair px-4 py-24 sm:px-8 lg:px-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_70%_at_82%_20%,rgba(255,176,32,0.08),transparent_62%)]"
      />
      <div className="relative grid gap-10 lg:grid-cols-[minmax(0,8fr)_minmax(0,4fr)] lg:items-end">
        <Reveal>
          <p className="font-mono text-[11px] tracking-[0.3em] text-amber uppercase">07 the sister</p>
          <h2
            className="mt-4 font-display font-extrabold text-ink"
            style={{
              fontSize: "clamp(2.4rem, 7vw, 5.4rem)",
              letterSpacing: "-0.04em",
              lineHeight: 0.94,
            }}
          >
            Vidiyal reads the night
            <br />
            back at dawn.
          </h2>
        </Reveal>

        <Reveal delay={0.1} className="lg:pb-3">
          <a
            href={href}
            className="group inline-flex items-baseline gap-3 border-b border-hair pb-2 font-mono text-[12px] tracking-[0.24em] text-ink uppercase transition-colors duration-300 hover:border-amber"
          >
            Open Vidiyal
            <span className="inline-block transition-transform duration-300 group-hover:translate-x-1">
              &gt;
            </span>
          </a>
          <p className="mt-3 max-w-[34ch] text-base leading-relaxed text-ink/60">
            Kaaval trades the night. Vidiyal grades every trade the morning after, on process,
            not luck.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
