interface Props {
  points: Array<{ ts: number; equity: number }>;
  /** The line the account started from, drawn flat behind the curve. */
  start?: number | null;
  width?: number;
  height?: number;
  className?: string;
}

/**
 * The brain equity marks at row height. Plain SVG so the server renders it: a sparkline
 * that needs JavaScript to appear is a blank cell on the first paint.
 */
export function Sparkline({ points, start = null, width = 104, height = 26, className }: Props) {
  if (points.length < 2) {
    return (
      <span className={`font-mono text-[10px] tracking-[0.14em] text-dim ${className ?? ""}`}>
        one mark
      </span>
    );
  }

  const values = points.map((point) => point.equity);
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (start !== null) {
    low = Math.min(low, start);
    high = Math.max(high, start);
  }
  const span = high - low || Math.max(Math.abs(high) * 0.0001, 1);
  const pad = 2;

  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  const timeSpan = last.ts - first.ts || 1;

  const x = (ts: number): number => ((ts - first.ts) / timeSpan) * (width - pad * 2) + pad;
  const y = (equity: number): number =>
    height - pad - ((equity - low) / span) * (height - pad * 2);

  const path = points.map((point) => `${x(point.ts).toFixed(2)},${y(point.equity).toFixed(2)}`);
  const up = last.equity >= (start ?? first.equity);
  const stroke = up ? "var(--color-gain)" : "var(--color-loss)";

  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      width={width}
      height={height}
      aria-hidden
      className={className}
      preserveAspectRatio="none"
    >
      {start === null ? null : (
        <line
          x1={0}
          x2={width}
          y1={y(start)}
          y2={y(start)}
          stroke="var(--color-hair)"
          strokeWidth={1}
        />
      )}
      <polyline
        points={path.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth={1.2}
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.9}
      />
      <circle cx={x(last.ts)} cy={y(last.equity)} r={1.8} fill={stroke} />
    </svg>
  );
}
