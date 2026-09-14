import { getTickerBoard } from "@/lib/bitget";
import { TickerMarquee } from "@/components/TickerMarquee";

/** Server side: the SDK call never reaches the browser, so no key and no third party
 * request can leak into the page. */
export async function TickerStrip() {
  const board = await getTickerBoard();
  return <TickerMarquee initial={board} />;
}
