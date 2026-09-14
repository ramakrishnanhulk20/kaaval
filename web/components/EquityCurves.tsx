"use client";

import { useCallback, useEffect, useRef } from "react";
import { spanWords } from "@/lib/format";

export interface CurveInput {
  brain: string;
  points: Array<{ ts: number; equity: number }>;
}

interface Props {
  curves: CurveInput[];
  startEquity: number | null;
  /** A tick is due every this many minutes; twice that with no mark is a gap worth drawing. */
  cadenceMinutes: number;
  /** The bottom of the band the curves live in, as a fraction of the height. */
  bandBottom?: number;
  className?: string;
}

const INK = "237, 234, 227";
const GREY = "110, 106, 99";
const DRAW_MS = 1600;

/**
 * The rules brain is the honest baseline, so it is drawn cooler and thinner than the model
 * brains. A second model brain is the same off-white, dashed, so two of them read apart
 * without spending a second accent colour.
 */
function strokeFor(brain: string, modelIndex: number): { rgb: string; width: number; dash: number[] } {
  if (brain === "rules") return { rgb: GREY, width: 1, dash: [5, 5] };
  return { rgb: INK, width: 1.6, dash: modelIndex === 0 ? [] : [7, 5] };
}

export function EquityCurves({ curves, startEquity, cadenceMinutes, bandBottom = 0.58, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const progressRef = useRef(0);

  const drawn = curves.filter((curve) => curve.points.length >= 2);
  const thin = curves.filter((curve) => curve.points.length < 2);

  const draw = useCallback(
    (progress: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (drawn.length === 0) return;

      const narrow = width < 680;
      const left = narrow ? 18 : width * 0.05;
      const right = width - (narrow ? 18 : width * 0.07);
      const top = height * (narrow ? 0.2 : 0.23);
      const bottom = height * (narrow ? 0.46 : bandBottom);

      let tMin = Infinity;
      let tMax = -Infinity;
      let eMin = Infinity;
      let eMax = -Infinity;
      for (const curve of drawn) {
        for (const point of curve.points) {
          if (point.ts < tMin) tMin = point.ts;
          if (point.ts > tMax) tMax = point.ts;
          if (point.equity < eMin) eMin = point.equity;
          if (point.equity > eMax) eMax = point.equity;
        }
      }
      if (startEquity !== null) {
        eMin = Math.min(eMin, startEquity);
        eMax = Math.max(eMax, startEquity);
      }
      const range = eMax - eMin;
      const pad = range > 0 ? range * 0.22 : Math.max(Math.abs(eMax) * 0.002, 1);
      eMin -= pad;
      eMax += pad;
      const times = [...new Set(drawn.flatMap((curve) => curve.points.map((point) => point.ts)))].sort(
        (a, b) => a - b,
      );
      const gapMs = cadenceMinutes * 2 * 60_000;

      /**
       * The axis is real time, except that a stretch with no ticks is given a fixed narrow
       * band instead of its full duration. An 18 hour gap at true scale squeezes every tick
       * of the night into a few pixels; the band is drawn and labelled with the real length,
       * so the gap is still on the screen rather than smoothed away.
       */
      const segments: Array<{ from: number; to: number; dt: number; eff: number; start: number }> = [];
      let total = 0;
      for (let index = 1; index < times.length; index += 1) {
        const from = times[index - 1] ?? tMin;
        const to = times[index] ?? tMax;
        const dt = Math.max(to - from, 1);
        const eff = dt <= gapMs ? dt : gapMs * 1.6;
        segments.push({ from, to, dt, eff, start: total });
        total += eff;
      }
      if (total <= 0) total = 1;

      const offsetOf = (ts: number): number => {
        if (ts <= tMin) return 0;
        if (ts >= tMax) return total;
        for (const segment of segments) {
          if (ts <= segment.to) {
            return segment.start + ((ts - segment.from) / segment.dt) * segment.eff;
          }
        }
        return total;
      };
      const timeAt = (offset: number): number => {
        for (const segment of segments) {
          if (offset <= segment.start + segment.eff) {
            return segment.from + ((offset - segment.start) / segment.eff) * segment.dt;
          }
        }
        return tMax;
      };

      const x = (ts: number): number => left + (offsetOf(ts) / total) * (right - left);
      const y = (equity: number): number => bottom - ((equity - eMin) / (eMax - eMin)) * (bottom - top);

      const family = getComputedStyle(canvas).fontFamily;
      const cut = timeAt(total * progress);

      if (startEquity !== null) {
        const yStart = y(startEquity);
        ctx.save();
        // Solid, because the rules brain draws a dashed line that can sit exactly on it.
        ctx.strokeStyle = "rgba(" + INK + ", 0.09)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(left, yStart);
        ctx.lineTo(right, yStart);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(" + GREY + ", 0.9)";
        ctx.font = "10px " + family;
        ctx.textBaseline = "bottom";
        ctx.fillText(startEquity.toLocaleString("en-US") + " USDT START", left, yStart - 8);
        ctx.restore();
      }

      ctx.save();
      ctx.font = "10px " + family;
      ctx.textBaseline = "bottom";
      for (const segment of segments) {
        const { from, to } = segment;
        if (to - from <= gapMs) continue;
        const xFrom = x(from);
        const xTo = x(Math.min(to, cut));
        if (xTo <= xFrom) continue;
        ctx.fillStyle = "rgba(" + INK + ", 0.035)";
        ctx.fillRect(xFrom, top, xTo - xFrom, bottom - top);
        ctx.strokeStyle = "rgba(" + INK + ", 0.1)";
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xFrom, top);
        ctx.lineTo(xFrom, bottom);
        ctx.moveTo(xTo, top);
        ctx.lineTo(xTo, bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        const label = "NO TICKS " + spanWords(to - from);
        const labelWidth = ctx.measureText(label).width;
        if (xTo - xFrom > labelWidth + 16) {
          ctx.fillStyle = "rgba(" + GREY + ", 0.95)";
          ctx.fillText(label, (xFrom + xTo) / 2 - labelWidth / 2, top - 8);
        }
      }
      ctx.restore();

      let modelIndex = 0;
      for (const curve of drawn) {
        const stroke = strokeFor(curve.brain, curve.brain === "rules" ? -1 : modelIndex);
        if (curve.brain !== "rules") modelIndex += 1;

        const path: Array<[number, number]> = [];
        for (let index = 0; index < curve.points.length; index += 1) {
          const point = curve.points[index];
          if (!point) continue;
          if (point.ts <= cut) {
            path.push([x(point.ts), y(point.equity)]);
            continue;
          }
          const previous = curve.points[index - 1];
          if (previous) {
            const share = (cut - previous.ts) / (point.ts - previous.ts);
            path.push([x(cut), y(previous.equity + (point.equity - previous.equity) * share)]);
          }
          break;
        }
        if (path.length < 2) continue;

        ctx.save();
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.setLineDash(stroke.dash);
        ctx.strokeStyle = "rgba(" + stroke.rgb + ", 0.16)";
        ctx.lineWidth = stroke.width * 5;
        ctx.shadowBlur = 26;
        ctx.shadowColor = "rgba(" + stroke.rgb + ", 0.35)";
        trace(ctx, path);
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "rgba(" + stroke.rgb + ", " + (curve.brain === "rules" ? "0.55" : "0.95") + ")";
        ctx.lineWidth = stroke.width;
        trace(ctx, path);
        ctx.setLineDash([]);

        const head = path[path.length - 1];
        if (head) {
          ctx.fillStyle = "rgba(" + stroke.rgb + ", 1)";
          ctx.shadowBlur = 14;
          ctx.shadowColor = "rgba(" + stroke.rgb + ", 0.8)";
          ctx.beginPath();
          ctx.arc(head[0], head[1], curve.brain === "rules" ? 1.8 : 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    },
    [bandBottom, cadenceMinutes, drawn, startEquity],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const setProgress = (value: number): void => {
      progressRef.current = value;
      document.documentElement.style.setProperty("--kaaval-draw", value.toFixed(3));
      draw(value);
    };

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    if (reduced) {
      setProgress(1);
    } else {
      const started = performance.now();
      const step = (now: number): void => {
        const linear = Math.min((now - started) / DRAW_MS, 1);
        setProgress(1 - Math.pow(1 - linear, 3));
        if (linear < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    }

    const observer = new ResizeObserver(() => draw(progressRef.current));
    observer.observe(canvas);
    void document.fonts.ready.then(() => draw(progressRef.current));

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [draw]);

  return (
    <div className={className}>
      <canvas ref={canvasRef} aria-hidden className="font-mono h-full w-full" />
      {thin.length > 0 ? (
        <p className="absolute right-4 bottom-[44%] font-mono text-[10px] uppercase tracking-[0.16em] text-dim sm:right-8">
          {thin.map((curve) => curve.brain).join(", ")}: fewer than two marks, no curve drawn
        </p>
      ) : null}
    </div>
  );
}

function trace(ctx: CanvasRenderingContext2D, path: Array<[number, number]>): void {
  ctx.beginPath();
  const [first, ...rest] = path;
  if (!first) return;
  ctx.moveTo(first[0], first[1]);
  for (const [px, py] of rest) ctx.lineTo(px, py);
  ctx.stroke();
}
