const lastCallAt = new Map<string, number>();

/**
 * The gap GDELT gets. Its own refusal says "one every 5 seconds", and six seconds was
 * still refused often enough on 2026-09-11 that the live engine saw almost no news, so
 * the gap is eight. The feed now asks one batched question a tick instead of one per
 * symbol, so a slower gap costs nothing.
 */
export const GDELT_MIN_SPACING_MS = 8_000;

/**
 * Hold the caller until this source's minimum gap since its own last call has passed.
 *
 * Every free news source here refuses a burst: GDELT answers 429 below roughly one call
 * every eight seconds, Finnhub caps the free key per minute, and SEC asks for fair
 * access. The gap is tracked per source, so a slow GDELT call never delays an EDGAR one.
 */
export async function pace(source: string, minSpacingMs: number): Promise<void> {
  if (minSpacingMs <= 0) return;
  const wait = minSpacingMs - (Date.now() - (lastCallAt.get(source) ?? 0));
  if (wait > 0) await sleep(wait);
  lastCallAt.set(source, Date.now());
}

/** Tests share one process, so they need a way back to a clean slate. */
export function resetPacing(): void {
  lastCallAt.clear();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
