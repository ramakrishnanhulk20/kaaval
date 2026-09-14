import { signedPct, signedUsdt } from "@/lib/format";

interface Props {
  value: number | null;
  kind?: "pct" | "usdt";
  /** A drawdown is a loss even when it is written as a positive number. */
  alwaysLoss?: boolean;
  className?: string;
}

/** Colour follows the sign, in the status family, never the amber accent. */
export function Signed({ value, kind = "pct", alwaysLoss = false, className }: Props) {
  if (value === null) {
    return <span className={`text-dim ${className ?? ""}`}>n/a</span>;
  }

  // Below half a basis point the sign is noise, so it is written as a flat zero rather
  // than coloured as a gain or a loss.
  const flat = kind === "pct" && Math.abs(value) < 0.005;

  const tone = flat
    ? "text-dim"
    : alwaysLoss
    ? value > 0
      ? "text-loss"
      : "text-dim"
    : value > 0
      ? "text-gain"
      : value < 0
        ? "text-loss"
        : "text-dim";

  const text = flat
    ? "0.00%"
    : kind === "pct"
      ? alwaysLoss
        ? `${value.toFixed(2)}%`
        : signedPct(value)
      : signedUsdt(value);

  return <span className={`${tone} ${className ?? ""}`}>{text}</span>;
}
