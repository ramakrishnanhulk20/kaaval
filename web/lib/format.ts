const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const priceFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Everything on the page is formatted from the ISO string, so the server and the browser
 * never disagree about the reader's timezone. */
function parts(ts: number): { iso: string; day: string; month: string; year: string } {
  const iso = new Date(ts).toISOString();
  return {
    iso,
    day: String(Number(iso.slice(8, 10))),
    month: MONTHS[Number(iso.slice(5, 7)) - 1] ?? "",
    year: iso.slice(0, 4),
  };
}

export function utcTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

export function utcHourMinute(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16);
}

export function posterDate(ts: number): string {
  const { day, month, year } = parts(ts);
  return `${day} ${month} ${year}`;
}

export function dayMonth(ts: number): string {
  const { day, month } = parts(ts);
  return `${day} ${month}`;
}

export function price(value: number): string {
  return priceFormat.format(value);
}

export function signedPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function spanWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)}m`;
  return `${String(hours)}h ${String(rest).padStart(2, "0")}m`;
}

const usdtFormat = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function usdt(value: number): string {
  return usdtFormat.format(value);
}

export function signedUsdt(value: number): string {
  return `${value >= 0 ? "+" : ""}${usdtFormat.format(value)}`;
}

export function utcDayTime(ts: number): string {
  const iso = new Date(ts).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/** 4.5 seconds, 812 milliseconds: whichever reads as the honest length of the wait. */
export function duration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** RNVDAUSDT is the rToken for NVDA, so it reads rNVDA; NVDAUSDT is the perpetual, NVDA. */
export function readableSymbol(symbol: string): string {
  const base = symbol.replace(/USDT$/, "");
  if (/^R[A-Z]{1,6}$/.test(base)) return `r${base.slice(1)}`;
  return base === "" ? symbol : base;
}
