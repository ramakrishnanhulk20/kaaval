"use client";

import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Link from "next/link";
import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readableSymbol, spanWords, utcTime } from "@/lib/format";
import type { NightDay, NightEvent, NightLane } from "@/lib/record";

interface Props {
  night: NightDay;
  startTs: number;
  endTs: number;
  cadenceMinutes: number;
}

interface Segment {
  from: number;
  to: number;
  dt: number;
  eff: number;
  start: number;
  gap: boolean;
}

interface PlacedEvent extends NightEvent {
  x: number;
  y: number;
  lane: number;
}

const HOUR_MS = 60 * 60_000;

export function NightTimeline({ night, startTs, endTs, cadenceMinutes }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const clockRef = useRef<HTMLSpanElement | null>(null);
  const progressRef = useRef(0);
  const currentRef = useRef(0);
  const activeRef = useRef(-1);
  const manualRef = useRef(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);
  const [trackWidth, setTrackWidth] = useState(1000);

  const axis = useMemo(() => buildAxis(night, startTs, endTs, cadenceMinutes), [
    night,
    startTs,
    endTs,
    cadenceMinutes,
  ]);

  const placed = useMemo(() => place(night, axis.xOf), [night, axis.xOf]);

  const selectNearest = useCallback(
    (progress: number) => {
      if (placed.length === 0) return;
      let best = 0;
      let bestGap = Infinity;
      for (let index = 0; index < placed.length; index += 1) {
        const event = placed[index];
        if (!event) continue;
        const gap = Math.abs(event.x - progress);
        if (gap < bestGap) {
          bestGap = gap;
          best = index;
        }
      }
      if (best === activeRef.current) return;
      activeRef.current = best;
      manualRef.current = false;
      setActive(best);
    },
    [placed],
  );

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined && width > 0) setTrackWidth(width);
    });
    observer.observe(track);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    const wrap = wrapRef.current;
    if (!stage || !wrap) return;

    const write = (value: number): void => {
      stage.style.setProperty("--night", value.toFixed(4));
      const clock = clockRef.current;
      if (clock) clock.textContent = `${utcTime(axis.timeAt(value))} UTC`;
    };

    // Read at run time rather than at render time: the server has no media query, and a
    // component that renders differently in the browser tears its own markup apart.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      write(1);
      currentRef.current = 1;
      selectNearest(1);
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
        progressRef.current = self.progress;
      },
    });

    let frame = 0;
    const step = (): void => {
      const target = progressRef.current;
      const next = currentRef.current + (target - currentRef.current) * 0.14;
      if (Math.abs(next - currentRef.current) > 0.00005) {
        currentRef.current = next;
        write(next);
        if (!manualRef.current) selectNearest(next);
      }
      frame = requestAnimationFrame(step);
    };
    write(0);
    frame = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(frame);
      trigger.kill();
    };
  }, [axis, selectNearest]);

  const event = placed[active] ?? null;

  const onSlider = (value: number): void => {
    const stage = stageRef.current;
    if (stage) stage.style.setProperty("--night", value.toFixed(4));
    const clock = clockRef.current;
    if (clock) clock.textContent = `${utcTime(axis.timeAt(value))} UTC`;
    manualRef.current = false;
    selectNearest(value);
  };

  return (
    <div ref={wrapRef} className="night-scroll relative">
      <div
        ref={stageRef}
        data-stage
        className="night-stage flex w-full flex-col overflow-hidden border-t border-hair bg-ground"
        style={{ ["--night" as string]: "0" }}
      >
        <div className="flex items-center justify-between gap-4 border-b border-hair px-4 py-3 sm:px-8 lg:px-12">
          <p className="font-mono text-[10px] tracking-[0.22em] text-dim uppercase">
            {night.day} UTC
            <span className="text-ink/25"> / </span>
            {night.entries} entries
          </p>
          <p className="flex shrink-0 items-center gap-2 font-mono text-[11px] tracking-[0.18em] whitespace-nowrap text-amber">
            <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-amber" />
            <span ref={clockRef} data-clock>{utcTime(startTs)} UTC</span>
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="relative flex flex-1 flex-col px-4 pt-4 pb-6 sm:px-8 lg:min-w-0 lg:px-12">
            <Ruler axis={axis} startTs={startTs} endTs={endTs} width={trackWidth} />

            <div ref={trackRef} className="relative mt-3 flex min-h-0 flex-1 flex-col gap-2 lg:gap-3">
              {axis.segments
                .filter((segment) => segment.gap)
                .map((segment) => (
                  <span
                    key={segment.from}
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 border-x border-dashed border-ink/10 bg-ink/[0.025]"
                    style={{
                      left: `${(axis.xOf(segment.from) * 100).toFixed(3)}%`,
                      width: `${((axis.xOf(segment.to) - axis.xOf(segment.from)) * 100).toFixed(3)}%`,
                    }}
                  >
                    {(axis.xOf(segment.to) - axis.xOf(segment.from)) * trackWidth < 108 ? null : (
                      <span className="absolute bottom-1 left-1/2 -translate-x-1/2 font-mono text-[9px] tracking-[0.14em] whitespace-nowrap text-dim uppercase">
                        no ticks {spanWords(segment.dt)}
                      </span>
                    )}
                  </span>
                ))}

              {night.lanes.map((lane, index) => (
                <Lane
                  key={lane.brain}
                  lane={lane}
                  axis={axis}
                  events={placed.filter((item) => item.lane === index && !item.full)}
                  activeId={event?.id ?? null}
                  onPick={(id) => {
                    const at = placed.findIndex((item) => item.id === id);
                    if (at < 0) return;
                    manualRef.current = true;
                    activeRef.current = at;
                    setActive(at);
                  }}
                />
              ))}

              {placed
                .filter((item) => item.full)
                .map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      const at = placed.findIndex((other) => other.id === item.id);
                      if (at < 0) return;
                      manualRef.current = true;
                      activeRef.current = at;
                      setActive(at);
                    }}
                    aria-label={`${item.title} at ${utcTime(item.ts)} UTC`}
                    className="absolute inset-y-0 z-20 w-4 -translate-x-1/2 cursor-pointer"
                    style={{
                      left: `${(item.x * 100).toFixed(3)}%`,
                      opacity: `max(0.3, calc((var(--night) - ${item.x.toFixed(4)}) * 40))`,
                    }}
                  >
                    <span
                      className={`absolute inset-y-0 left-1/2 w-px ${
                        event?.id === item.id ? "bg-amber" : "bg-loss/70"
                      }`}
                    />
                    <span className="absolute -top-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rotate-45 bg-loss" />
                  </button>
                ))}

              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-0 z-30 w-px bg-amber"
                style={{
                  left: "calc(var(--night) * 100%)",
                  boxShadow: "0 0 18px 2px rgba(255, 176, 32, 0.35)",
                }}
              />
            </div>

            <label className="reduced-only mt-4 font-mono text-[10px] tracking-[0.2em] text-dim uppercase">
              Move through the night
              <input
                type="range"
                min={0}
                max={1000}
                defaultValue={1000}
                onChange={(change) => {
                  onSlider(Number(change.target.value) / 1000);
                }}
                className="mt-2 w-full accent-amber"
              />
            </label>
            <p className="motion-only mt-4 hidden font-mono text-[10px] tracking-[0.2em] text-dim uppercase lg:block">
              Scroll to move the playhead
            </p>

            <Legend counts={night.counts} />
          </div>

          <aside className="flex min-h-[18rem] flex-col border-t border-hair lg:min-h-0 lg:w-[26rem] lg:shrink-0 lg:border-t-0 lg:border-l xl:w-[30rem]">
            <Panel event={event} />
          </aside>
        </div>
      </div>
    </div>
  );
}

function Ruler({
  axis,
  startTs,
  endTs,
  width,
}: {
  axis: Axis;
  startTs: number;
  endTs: number;
  /** The drawn width in pixels, so two hour labels never sit on top of each other. */
  width: number;
}) {
  const hours: Array<{ ts: number; x: number }> = [];
  const apart = 52 / Math.max(width, 1);
  let last = -1;
  for (let ts = Math.ceil(startTs / HOUR_MS) * HOUR_MS; ts <= endTs; ts += HOUR_MS) {
    const x = axis.xOf(ts);
    if (x - last < apart) continue;
    last = x;
    hours.push({ ts, x });
  }

  return (
    <div className="relative h-7 border-b border-hair">
      {hours.map((hour) => (
        <span
          key={hour.ts}
          className="absolute top-0 flex h-full -translate-x-1/2 items-start"
          style={{ left: `${(hour.x * 100).toFixed(3)}%` }}
        >
          <span className="font-mono text-[9px] tracking-[0.14em] text-dim">
            {new Date(hour.ts).toISOString().slice(11, 16)}
          </span>
        </span>
      ))}
    </div>
  );
}

function Lane({
  lane,
  axis,
  events,
  activeId,
  onPick,
}: {
  lane: NightLane;
  axis: Axis;
  events: PlacedEvent[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  const path = linePath(lane, axis);

  return (
    <div className="relative min-h-[74px] flex-1 border-t border-hair/60 first:border-t-0">
      <span className="absolute top-1 left-0 z-10 font-mono text-[10px] tracking-[0.22em] text-dim uppercase">
        {lane.brain}
        {lane.baseline ? <span className="text-ink/25"> / baseline</span> : null}
      </span>

      {path === null ? (
        <span className="absolute top-1/2 left-0 font-mono text-[10px] tracking-[0.16em] text-dim uppercase">
          no marks this day
        </span>
      ) : (
        <>
          <svg
            aria-hidden
            viewBox="0 0 1000 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
          >
            <path
              d={path}
              fill="none"
              stroke={lane.baseline ? "var(--color-dim)" : "var(--color-ink)"}
              strokeOpacity={0.22}
              strokeWidth={lane.baseline ? 1 : 1.4}
              strokeDasharray={lane.baseline ? "5 5" : undefined}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <svg
            aria-hidden
            viewBox="0 0 1000 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
            style={{ clipPath: "inset(0 calc(100% - var(--night) * 100%) 0 0)" }}
          >
            <path
              d={path}
              fill="none"
              stroke={lane.baseline ? "var(--color-dim)" : "var(--color-ink)"}
              strokeWidth={lane.baseline ? 1 : 1.6}
              strokeDasharray={lane.baseline ? "5 5" : undefined}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </>
      )}

      {events.map((event) => (
        <Mark key={event.id} event={event} active={event.id === activeId} onPick={onPick} />
      ))}
    </div>
  );
}

function Mark({
  event,
  active,
  onPick,
}: {
  event: PlacedEvent;
  active: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        onPick(event.id);
      }}
      aria-label={`${event.title} at ${utcTime(event.ts)} UTC`}
      className="group absolute z-20 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
      style={{
        left: `${(event.x * 100).toFixed(3)}%`,
        top: `${event.y.toFixed(2)}%`,
        // The playhead lights each mark as it passes. Opacity clamps at 1 on its own, and
        // max() holds the unlit mark at a readable ghost rather than hiding it.
        opacity: `max(0.22, calc((var(--night) - ${event.x.toFixed(4)}) * 40))`,
      }}
    >
      {event.kind === "decision" ? (
        <span
          className={`block h-[9px] w-[9px] rounded-full border transition-transform duration-200 group-hover:scale-150 ${
            active ? "scale-150 border-amber" : "border-ink"
          }`}
        />
      ) : null}

      {event.kind === "fill" ? (
        <span
          className={`block h-[7px] w-[7px] rounded-full transition-transform duration-200 group-hover:scale-150 ${
            active ? "scale-150 bg-amber" : "bg-ink"
          }`}
          style={{
            boxShadow: active
              ? "0 0 12px 3px rgba(255, 176, 32, 0.5)"
              : "0 0 10px 2px rgba(237, 234, 227, 0.35)",
          }}
        />
      ) : null}

      {event.kind === "refusal" ? (
        <svg
          viewBox="0 0 10 10"
          aria-hidden
          className={`h-[9px] w-[9px] transition-transform duration-200 group-hover:scale-150 ${
            active ? "scale-150" : ""
          }`}
        >
          <path
            d="M1 1 L9 9 M9 1 L1 9"
            stroke={active ? "var(--color-amber)" : "var(--color-loss)"}
            strokeWidth={1.6}
          />
        </svg>
      ) : null}
    </button>
  );
}

function Legend({ counts }: { counts: NightDay["counts"] }) {
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[9px] tracking-[0.16em] text-dim uppercase">
      <li className="flex items-center gap-2">
        <span aria-hidden className="inline-block h-[9px] w-[9px] rounded-full border border-ink" />
        {counts.decision} decisions
      </li>
      <li className="flex items-center gap-2">
        <span aria-hidden className="inline-block h-[7px] w-[7px] rounded-full bg-ink" />
        {counts.fill} fills
      </li>
      <li className="flex items-center gap-2">
        <svg viewBox="0 0 10 10" aria-hidden className="h-[9px] w-[9px]">
          <path d="M1 1 L9 9 M9 1 L1 9" stroke="var(--color-loss)" strokeWidth={1.6} />
        </svg>
        {counts.refusal} refusals
      </li>
      <li className="flex items-center gap-2">
        <span aria-hidden className="inline-block h-3 w-px bg-loss" />
        {counts.stop + counts.halt} stops and halts
      </li>
    </ul>
  );
}

function Panel({ event }: { event: PlacedEvent | null }) {
  if (!event) {
    return (
      <div className="px-4 py-6 sm:px-8 lg:px-8">
        <p className="font-mono text-[11px] tracking-[0.2em] text-dim uppercase">
          Nothing was written this day.
        </p>
      </div>
    );
  }

  return (
    <motion.div
      key={event.id}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-6 sm:px-8 lg:px-8"
    >
      <div className="flex items-baseline justify-between gap-3 font-mono text-[10px] tracking-[0.2em] text-dim uppercase">
        <span className="text-amber">{event.brain}</span>
        <span>
          {utcTime(event.ts)} UTC
          <span className="text-ink/25"> / </span>
          entry {event.seq}
        </span>
      </div>

      <h3
        className="mt-3 font-display font-extrabold text-ink"
        style={{ fontSize: "clamp(1.6rem, 3vw, 2.2rem)", letterSpacing: "-0.03em", lineHeight: 1 }}
      >
        {event.kind === "fill" || event.kind === "stop"
          ? event.title.replace(/([A-Z]+USDT)/, (symbol) => readableSymbol(symbol))
          : event.title}
      </h3>
      <p className="mt-2 font-mono text-[11px] tracking-[0.14em] text-dim">{event.line}</p>

      {event.fields.length > 0 ? (
        <dl className="mt-5 border-t border-hair font-mono text-[11px]">
          {event.fields.map(([label, value]) => (
            <div key={label} className="flex gap-4 border-b border-hair py-2">
              <dt className="w-28 shrink-0 tracking-[0.16em] text-dim uppercase">{label}</dt>
              <dd className="min-w-0 break-all text-ink/80">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {event.body === null || event.body === "" ? null : (
        <p className="mt-5 text-[14px] leading-relaxed text-ink/75">{event.body}</p>
      )}

      {event.notes.length > 0 ? (
        <ul className="mt-5 flex flex-col gap-4 border-t border-hair pt-5">
          {event.notes.map(([label, text]) => (
            <li key={label}>
              <p className="font-mono text-[10px] tracking-[0.16em] text-amber uppercase">{label}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink/70">{text}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {event.decisionSeq === null ? null : (
        <Link
          href={`/decisions/${String(event.decisionSeq)}`}
          className="group mt-6 inline-flex items-center gap-2 self-start font-mono text-[10px] tracking-[0.2em] text-dim uppercase transition-colors duration-200 hover:text-ink"
        >
          Open decision {event.decisionSeq}
          <span className="inline-block transition-transform duration-200 group-hover:translate-x-1">
            &gt;
          </span>
        </Link>
      )}
    </motion.div>
  );
}

interface Axis {
  segments: Segment[];
  xOf: (ts: number) => number;
  timeAt: (progress: number) => number;
}

/**
 * Time runs left to right, except that a stretch with no ticks is given a fixed narrow
 * band instead of its true width. An 18 hour hole at true scale squeezes a whole night of
 * work into a few pixels; the band is still drawn and labelled with its real length, so
 * the hole is on the screen rather than smoothed away. Same rule as the hero curves.
 */
function buildAxis(night: NightDay, startTs: number, endTs: number, cadenceMinutes: number): Axis {
  const gapMs = cadenceMinutes * 2 * 60_000;
  const stamps = new Set<number>([startTs, endTs]);
  for (const lane of night.lanes) for (const point of lane.points) stamps.add(point.ts);
  for (const event of night.events) stamps.add(event.ts);
  const times = [...stamps].filter((ts) => ts >= startTs && ts <= endTs).sort((a, b) => a - b);

  const segments: Segment[] = [];
  let total = 0;
  for (let index = 1; index < times.length; index += 1) {
    const from = times[index - 1];
    const to = times[index];
    if (from === undefined || to === undefined) continue;
    const dt = Math.max(to - from, 1);
    const gap = dt > gapMs;
    const eff = gap ? gapMs * 1.4 : dt;
    segments.push({ from, to, dt, eff, start: total, gap });
    total += eff;
  }
  if (total <= 0) total = 1;

  const xOf = (ts: number): number => {
    if (ts <= startTs) return 0;
    if (ts >= endTs) return 1;
    for (const segment of segments) {
      if (ts <= segment.to) {
        return (segment.start + ((ts - segment.from) / segment.dt) * segment.eff) / total;
      }
    }
    return 1;
  };

  const timeAt = (progress: number): number => {
    const offset = Math.min(Math.max(progress, 0), 1) * total;
    for (const segment of segments) {
      if (offset <= segment.start + segment.eff) {
        return segment.from + ((offset - segment.start) / segment.eff) * segment.dt;
      }
    }
    return endTs;
  };

  return { segments, xOf, timeAt };
}

/** Where a lane sits vertically, as a percentage of its own band. */
function laneY(lane: NightLane, equity: number): number {
  // A brain that never moved has no range to scale against, so its line runs down the middle
  // of the lane rather than along the floor, which would read as a loss.
  const span = lane.high - lane.low;
  if (span <= 0) return 50;
  return 82 - ((equity - lane.low) / span) * 64;
}

function linePath(lane: NightLane, axis: Axis): string | null {
  if (lane.points.length < 2) return null;
  return lane.points
    .map((point, index) => {
      const x = axis.xOf(point.ts) * 1000;
      const y = laneY(lane, point.equity);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

/**
 * Every event given a lane, an x across the night and a y on its own equity line. A tick
 * writes a decision, its refusals and its fills inside the same second, so marks that land
 * on the same spot are fanned out vertically instead of hiding each other.
 */
function place(night: NightDay, xOf: (ts: number) => number): PlacedEvent[] {
  const placed = night.events.map((event) => {
    const lane = night.lanes.findIndex((item) => item.brain === event.brain);
    const found = night.lanes[lane];
    return {
      ...event,
      lane,
      x: xOf(event.ts),
      y: found ? laneY(found, equityAt(found, event.ts)) : 50,
    };
  });

  const clusters = new Map<string, PlacedEvent[]>();
  for (const event of placed) {
    if (event.full) continue;
    const key = `${String(event.lane)}:${Math.round(event.x * 260).toFixed(0)}`;
    const group = clusters.get(key) ?? [];
    group.push(event);
    clusters.set(key, group);
  }
  for (const group of clusters.values()) {
    if (group.length < 2) continue;
    group.forEach((event, index) => {
      const offset = (index - (group.length - 1) / 2) * 7;
      event.y = Math.min(92, Math.max(8, event.y + offset));
    });
  }

  return placed;
}

function equityAt(lane: NightLane, ts: number): number {
  const points = lane.points;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return 0;
  if (ts <= first.ts) return first.equity;
  if (ts >= last.ts) return last.equity;
  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1];
    const after = points[index];
    if (!before || !after) continue;
    if (ts <= after.ts) {
      const share = (ts - before.ts) / Math.max(after.ts - before.ts, 1);
      return before.equity + (after.equity - before.equity) * share;
    }
  }
  return last.equity;
}
